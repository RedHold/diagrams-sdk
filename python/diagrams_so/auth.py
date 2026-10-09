"""Device-flow login for the Diagrams.so SDK (RFC 8628; stdlib only).

``diagrams_so.login()`` walks the OAuth device-authorization flow against the
public API, prints a one-time code + verification URL (and opens the browser),
then polls until the user approves. The minted API key is cached at
``~/.diagrams-so/credentials.json`` (shared byte-for-byte with the TS SDK) so
subsequent ``DiagramsClient()`` constructions Just Work.
"""

from __future__ import annotations

import json
import os
import sys
import socket
import tempfile
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from .client import DEFAULT_BASE, DiagramsClient

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
CLIENT_ID = "sdk-python"


class DiagramsAuthError(Exception):
    """Raised when the device-login flow cannot complete (denied, expired, …)."""


# -- credential cache (contract shared with the TypeScript SDK) --------------

def credentials_path() -> str:
    """``~/.diagrams-so/credentials.json`` — same file for every Diagrams.so SDK."""
    return os.path.join(os.path.expanduser("~"), ".diagrams-so", "credentials.json")


def load_cached_api_key(base_url: str) -> Optional[str]:
    """Return the cached API key if the cache is well-formed, ``version == 1``,
    and was minted for ``base_url``. ANY problem (missing, corrupt JSON, wrong
    version, base mismatch) returns ``None`` — the cache must never crash a
    client construction."""
    try:
        with open(credentials_path(), "r", encoding="utf-8") as f:
            creds = json.load(f)
        if not isinstance(creds, dict) or creds.get("version") != 1:
            return None
        key = creds.get("api_key")
        cached_base = creds.get("base_url")
        if not isinstance(key, str) or not key or not isinstance(cached_base, str):
            return None
        if cached_base.rstrip("/") != base_url.rstrip("/"):
            return None
        return key
    except Exception:
        return None


def _write_credentials(creds: Dict[str, Any]) -> str:
    """Write the cache ATOMICALLY (tmp file + ``os.replace``), dir 0700, file 0600."""
    path = credentials_path()
    cred_dir = os.path.dirname(path)
    os.makedirs(cred_dir, mode=0o700, exist_ok=True)
    os.chmod(cred_dir, 0o700)
    fd, tmp = tempfile.mkstemp(dir=cred_dir, prefix=".credentials-", suffix=".tmp")
    try:
        os.chmod(tmp, 0o600)  # mkstemp already creates 0600 on POSIX; be explicit
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(creds, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def logout() -> None:
    """Delete the cached credentials. Idempotent — a missing cache is fine."""
    try:
        os.unlink(credentials_path())
    except FileNotFoundError:
        pass


# -- device flow -------------------------------------------------------------

def _safe_to_open(url: str) -> bool:
    """Only auto-open https URLs, or http to a loopback host (self-hosted/dev).
    javascript:/file:/other schemes from a hostile server are refused — the
    printed URL still lets the human decide."""
    from urllib.parse import urlparse
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme == "https":
        return True
    if u.scheme == "http":
        return (u.hostname or "") in ("localhost", "127.0.0.1", "::1")
    return False


def _post(url: str, body: Dict[str, Any], timeout: float = 30.0,
          headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, Any]]:
    """POST JSON with stdlib urllib; return (status, parsed_payload). 4xx bodies
    are parsed, not raised — the device flow signals progress via 400s."""
    import urllib.error
    import urllib.request
    from . import __version__ as _v
    hdrs = {"Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": f"diagrams-so-python/{_v}"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers=hdrs,
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {}
        return e.code, payload
    except urllib.error.URLError as e:
        raise DiagramsAuthError(
            f"Could not reach the Diagrams.so API at {url}. ({getattr(e, 'reason', e)})") from e


def _prompt_email() -> str:
    """Resolve the sign-in email: DIAGRAMS_LOGIN_EMAIL wins; otherwise prompt on a
    TTY. The one-time code is emailed here and the approver's account must match
    it, so it can't be left to the browser session alone."""
    env = (os.environ.get("DIAGRAMS_LOGIN_EMAIL") or "").strip()
    if env:
        return env
    if sys.stdin.isatty():
        try:
            return input("Email to receive your sign-in code: ").strip()
        except (EOFError, KeyboardInterrupt):
            return ""
    return ""


def _confirm(base: str, api_key: str) -> None:
    """Tell the server the new key is safely stored, so it revokes this machine's
    previous key only now — never leaving the account with no valid key.
    Best-effort: a failure here does not undo a successful login."""
    try:
        _post(base + "/oauth/device/confirm", {}, headers={"Authorization": f"Bearer {api_key}"})
    except Exception:
        pass


def login(test: bool = False, base_url: Optional[str] = None,
          open_browser: bool = True, email: Optional[str] = None) -> DiagramsClient:
    """Sign in via the OAuth device flow and return a ready :class:`DiagramsClient`.

    You provide an email; the API emails you a one-time code. A browser opens the
    (plain) verification page where you sign in — new accounts sign up there — and
    enter the code, then approve. The code is emailed, never placed in the URL, so
    a stolen link can't be approved from someone else's browser. On approval the
    minted API key is cached at ``~/.diagrams-so/credentials.json`` so
    ``DiagramsClient()`` works with no arguments from then on.

    :param test: mint a test-mode key (``livemode=false``). Test keys act on
        your real account, the same as live keys (lower rate limits only).
    :param base_url: API base (defaults to the production API).
    :param open_browser: open the verification URL automatically.
    :param email: the email to receive the one-time code (defaults to
        ``DIAGRAMS_LOGIN_EMAIL`` or an interactive prompt).
    """
    base = (base_url or DEFAULT_BASE).rstrip("/")

    if test:
        print("Test keys act on your real account, the same as live keys (lower rate limits only).")

    email = (email or "").strip() or _prompt_email()
    if not email or "@" not in email:
        raise DiagramsAuthError(
            "A valid email is required to receive your sign-in code. "
            "Pass email=... or set DIAGRAMS_LOGIN_EMAIL.")

    status, code_resp = _post(base + "/oauth/device/code", {
        "client_id": CLIENT_ID,
        "livemode": not test,
        "device_name": socket.gethostname(),
        "email": email,
    })
    if status != 200 or "device_code" not in code_resp:
        raise DiagramsAuthError(
            f"Could not start device login (HTTP {status}): {json.dumps(code_resp)[:200]}")

    verification_uri = code_resp.get("verification_uri") or "https://diagrams.so/device"
    expires_in = float(code_resp.get("expires_in", 900))
    interval = float(code_resp.get("interval", 5))

    print(f"\nWe emailed a sign-in code to {email}.")
    print(f"Open {verification_uri}, sign in, and enter the code to approve.\n")
    if open_browser and _safe_to_open(verification_uri):
        try:
            webbrowser.open(verification_uri)
        except Exception:
            pass  # headless / no browser — the printed URL still works

    deadline = time.monotonic() + expires_in
    token: Optional[Dict[str, Any]] = None
    while True:
        if time.monotonic() >= deadline:
            raise DiagramsAuthError(
                "Login expired before the device was approved — run login again.")
        time.sleep(interval)
        status, poll = _post(base + "/oauth/device/token", {
            "grant_type": GRANT_TYPE,
            "device_code": code_resp["device_code"],
            "client_id": CLIENT_ID,
        })
        if status == 200 and "access_token" in poll:
            token = poll
            break
        err = poll.get("error") if isinstance(poll, dict) else None
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5.0  # RFC 8628 §3.5: back off by 5s and keep polling
            continue
        if err == "access_denied":
            raise DiagramsAuthError("Login was denied in the browser — no key was created.")
        if err == "expired_token":
            raise DiagramsAuthError(
                "Login expired before the device was approved — run login again.")
        if err == "key_limit_reached":
            raise DiagramsAuthError(
                "You have 25 active keys. Revoke one at https://diagrams.so/api-keys, "
                "then re-run login.")
        raise DiagramsAuthError(f"Device login failed (HTTP {status}): {err or poll}")

    now = datetime.now(timezone.utc)
    tok_expires = token.get("expires_in")
    expires_at = ((now + timedelta(seconds=float(tok_expires))).isoformat()
                  if tok_expires else None)
    path = _write_credentials({
        "version": 1,
        "api_key": token["access_token"],
        "scope": token.get("scope"),
        "livemode": token.get("livemode", not test),
        "auth_method": "device",
        "created_at": now.isoformat(),
        "expires_at": expires_at,
        "base_url": base,
    })
    _confirm(base, token["access_token"])
    print(f"Logged in. Credentials saved to {path}")
    return DiagramsClient(api_key=token["access_token"], base_url=base)
