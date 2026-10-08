"""Device-flow login, credential cache, and client credential resolution.

Runs a real stub HTTP server (stdlib http.server) so login() is exercised over
an actual socket — request bodies, 400-signal handling, slow_down backoff, and
the atomic 0600 cache write are all asserted for real.
"""
import http.server
import json
import os
import socket
import threading
from contextlib import contextmanager
from unittest import mock

import pytest

import diagrams_so
from diagrams_so import DiagramsAPIError, DiagramsAuthError, DiagramsClient
from diagrams_so.auth import credentials_path

EMAIL = "me@corp.com"
# New contract: the response carries NO user_code and NO code-bearing URL — the
# one-time code is emailed, never in the link.
CODE_RESP = {
    "device_code": "dc_1",
    "verification_uri": "https://diagrams.so/device",
    "expires_in": 60, "interval": 0,
}
TOKEN_RESP = {
    "access_token": "dgz_live_new", "token_type": "bearer",
    "scope": "diagrams:read diagrams:write", "livemode": True, "expires_in": None,
}


@contextmanager
def stub_server(token_script, code_resp=None):
    """Serve /oauth/device/code and /oauth/device/token; token responses pop off
    ``token_script`` (a list of (status, payload)); the last entry repeats.
    Yields (base_url, requests_log)."""
    log = []
    state = {"i": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
            log.append((self.path, body))
            if self.path.endswith("/oauth/device/code"):
                status, payload = 200, (code_resp or CODE_RESP)
            elif self.path.endswith("/oauth/device/confirm"):
                status, payload = 200, {"revoked": 0}
            elif self.path.endswith("/oauth/device/token"):
                status, payload = token_script[min(state["i"], len(token_script) - 1)]
                state["i"] += 1
            else:
                status, payload = 404, {"error": "not_found"}
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):  # keep pytest output clean
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}/api/v2", log
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.fixture(autouse=True)
def isolated_home(monkeypatch, tmp_path):
    """Every test gets a fresh HOME (own cache file) and no DIAGRAMS_API_KEY."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DIAGRAMS_API_KEY", raising=False)
    monkeypatch.setenv("DIAGRAMS_LOGIN_EMAIL", EMAIL)  # login needs an email; supply it non-interactively
    return tmp_path


def _write_cache(api_key="dgz_live_cached", base_url=None, version=1, raw=None):
    path = credentials_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if raw is not None:
        with open(path, "w") as f:
            f.write(raw)
        return path
    with open(path, "w") as f:
        json.dump({"version": version, "api_key": api_key, "scope": "diagrams:read",
                   "livemode": True, "auth_method": "device",
                   "created_at": "2026-08-04T00:00:00+00:00", "expires_at": None,
                   "base_url": base_url or diagrams_so.client.DEFAULT_BASE}, f)
    return path


# -- login() ------------------------------------------------------------------

def test_login_happy_path_writes_cache_and_returns_client(capsys):
    script = [(400, {"error": "authorization_pending"}), (200, TOKEN_RESP)]
    with stub_server(script) as (base, log):
        with mock.patch("webbrowser.open") as wb:
            client = diagrams_so.login(base_url=base)
    # ready client
    assert isinstance(client, DiagramsClient)
    assert client.api_key == "dgz_live_new"
    assert client.base_url == base
    # told the user we emailed the code, opened the PLAIN verification URL (no code in it)
    out = capsys.readouterr().out
    assert EMAIL in out and "emailed" in out.lower()
    assert "ABCD-EFGH" not in out  # the code is never printed — it goes by email
    wb.assert_called_once_with(CODE_RESP["verification_uri"])
    # wire contract of the code request — the email travels with it
    path, body = log[0]
    assert path.endswith("/oauth/device/code")
    assert body == {"client_id": "sdk-python", "livemode": True,
                    "device_name": socket.gethostname(), "email": EMAIL}
    # token polls carry the RFC 8628 grant
    _, poll_body = log[1]
    assert poll_body["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code"
    assert poll_body["device_code"] == "dc_1" and poll_body["client_id"] == "sdk-python"
    # after writing the key, the client confirms so the server rotates safely
    assert any(p.endswith("/oauth/device/confirm") for p, _ in log)
    # cache: exact shape, atomic write landed, 0600 file in 0700 dir
    path = credentials_path()
    creds = json.load(open(path))
    assert creds == {"version": 1, "api_key": "dgz_live_new",
                     "scope": "diagrams:read diagrams:write", "livemode": True,
                     "auth_method": "device", "created_at": creds["created_at"],
                     "expires_at": None, "base_url": base}
    assert creds["created_at"]  # ISO timestamp present
    assert os.stat(path).st_mode & 0o777 == 0o600
    assert os.stat(os.path.dirname(path)).st_mode & 0o777 == 0o700
    # and DiagramsClient() with no args now resolves from the cache
    assert DiagramsClient(base_url=base).api_key == "dgz_live_new"


def test_login_honors_interval_and_slow_down():
    code = dict(CODE_RESP, interval=1)
    script = [(400, {"error": "slow_down"}), (400, {"error": "authorization_pending"}),
              (200, TOKEN_RESP)]
    with stub_server(script, code_resp=code) as (base, _):
        with mock.patch("time.sleep") as slept:
            diagrams_so.login(base_url=base, open_browser=False)
    delays = [c.args[0] for c in slept.call_args_list]
    # first poll at the server's interval; slow_down adds 5s to every later poll
    assert delays == [1, 6, 6]


def test_login_denied_raises():
    with stub_server([(400, {"error": "access_denied"})]) as (base, _):
        with pytest.raises(DiagramsAuthError, match="denied"):
            diagrams_so.login(base_url=base, open_browser=False)


def test_login_expired_token_raises_run_again():
    with stub_server([(400, {"error": "expired_token"})]) as (base, _):
        with pytest.raises(DiagramsAuthError, match="run login again"):
            diagrams_so.login(base_url=base, open_browser=False)


def test_login_deadline_timeout_raises_run_again():
    code = dict(CODE_RESP, expires_in=0)
    with stub_server([(400, {"error": "authorization_pending"})], code_resp=code) as (base, _):
        with pytest.raises(DiagramsAuthError, match="run login again"):
            diagrams_so.login(base_url=base, open_browser=False)


def test_login_key_limit_reached_message():
    with stub_server([(400, {"error": "key_limit_reached"})]) as (base, _):
        with pytest.raises(DiagramsAuthError,
                           match=r"25 active keys.*diagrams\.so/api-keys"):
            diagrams_so.login(base_url=base, open_browser=False)


def test_login_test_mode_warns_and_sends_livemode_false(capsys):
    token = dict(TOKEN_RESP, access_token="dgz_test_new", livemode=False)
    with stub_server([(200, token)]) as (base, log):
        diagrams_so.login(test=True, base_url=base, open_browser=False)
    out = capsys.readouterr().out
    assert "Test keys are not a sandbox" in out
    assert log[0][1]["livemode"] is False
    assert json.load(open(credentials_path()))["livemode"] is False


def test_login_expires_in_is_persisted_as_iso():
    token = dict(TOKEN_RESP, expires_in=3600)
    with stub_server([(200, token)]) as (base, _):
        diagrams_so.login(base_url=base, open_browser=False)
    creds = json.load(open(credentials_path()))
    assert creds["expires_at"] and creds["expires_at"] > creds["created_at"]


# -- credential resolution ----------------------------------------------------

def test_explicit_key_beats_env_and_cache(monkeypatch):
    monkeypatch.setenv("DIAGRAMS_API_KEY", "dgz_live_env")
    _write_cache()
    assert DiagramsClient(api_key="dgz_live_explicit").api_key == "dgz_live_explicit"


def test_env_beats_cache(monkeypatch):
    monkeypatch.setenv("DIAGRAMS_API_KEY", "dgz_live_env")
    _write_cache()
    assert DiagramsClient().api_key == "dgz_live_env"


def test_cache_used_when_nothing_else():
    _write_cache()
    assert DiagramsClient().api_key == "dgz_live_cached"


def test_cache_ignored_on_base_url_mismatch():
    _write_cache(base_url="https://api.staging.diagrams.so/api/v2")
    with pytest.raises(ValueError, match="Not connected"):
        DiagramsClient()


def test_cache_trailing_slash_still_matches():
    _write_cache(base_url=diagrams_so.client.DEFAULT_BASE + "/")
    assert DiagramsClient().api_key == "dgz_live_cached"


@pytest.mark.parametrize("raw", ["{not json", "[]", '{"version": 2, "api_key": "k"}',
                                 '{"version": 1}', ""])
def test_corrupt_or_wrong_version_cache_treated_as_absent(raw):
    _write_cache(raw=raw)
    with pytest.raises(ValueError, match="Not connected"):
        DiagramsClient()


def test_not_connected_error_message():
    with pytest.raises(ValueError) as ei:
        DiagramsClient()
    assert str(ei.value) == "Not connected — call diagrams_so.login() or set DIAGRAMS_API_KEY."


# -- logout -------------------------------------------------------------------

def test_logout_deletes_cache_and_is_idempotent():
    _write_cache()
    assert os.path.exists(credentials_path())
    diagrams_so.logout()
    assert not os.path.exists(credentials_path())
    diagrams_so.logout()  # second call: no file, no error


# -- upgrade_url --------------------------------------------------------------

def test_upgrade_url_from_402_payload():
    c = DiagramsClient(api_key="dgz_test_x")
    body = {"error": {"code": "QUOTA_EXCEEDED", "message": "no credits",
                      "upgrade_url": "https://diagrams.so/billing?upgrade=1"}}
    with mock.patch.object(c, "_send", return_value=(402, {}, json.dumps(body))):
        with pytest.raises(DiagramsAPIError) as ei:
            c.generate("hi")
    assert ei.value.upgrade_url == "https://diagrams.so/billing?upgrade=1"


def test_upgrade_url_none_when_absent():
    c = DiagramsClient(api_key="dgz_test_x")
    body = {"error": {"code": "VALIDATION_ERROR", "message": "bad"}}
    with mock.patch.object(c, "_send", return_value=(400, {}, json.dumps(body))):
        with pytest.raises(DiagramsAPIError) as ei:
            c.generate("hi")
    assert ei.value.upgrade_url is None
