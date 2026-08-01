"""Idempotency + bounded same-key retry for billable calls (audit remediation).

Mirrors the MCP server's test-idempotency contract: a billable call auto-attaches
an Idempotency-Key, retries AMBIGUOUS failures (timeout / 5xx / in-progress) with
the SAME key so the server replays instead of re-charging, never retries definite
rejections, and records an honest ``unknown`` tally when the outcome is lost.
"""
import json
from unittest import mock

import pytest

from diagrams_so import DiagramsAPIError, DiagramsClient, is_ambiguous


def _resp(status, body, headers=None):
    text = body if isinstance(body, str) else json.dumps(body)
    return (status, headers or {}, text)


def _client():
    # zero retry delays so the ladder doesn't actually sleep during tests
    return DiagramsClient(api_key="dgz_test_x", retry_delays=(0, 0, 0), retry_budget=60)


def test_is_ambiguous_classification():
    assert is_ambiguous(DiagramsAPIError("TIMEOUT", "", 0))
    assert is_ambiguous(DiagramsAPIError("CONNECTION_ERROR", "", 0))
    assert is_ambiguous(DiagramsAPIError("GATEWAY", "", 504))
    assert is_ambiguous(DiagramsAPIError("IDEMPOTENCY_IN_PROGRESS", "", 409))
    assert not is_ambiguous(DiagramsAPIError("QUOTA_EXCEEDED", "", 402))
    assert not is_ambiguous(DiagramsAPIError("VALIDATION_ERROR", "", 422))
    assert not is_ambiguous(ValueError("nope"))


def test_generate_autogenerates_idempotency_key():
    c = _client()
    ok = _resp(200, {"id": "d1", "usage": {"credits_charged": 3, "credits_remaining": 97}})
    with mock.patch.object(c, "_send", return_value=ok) as m:
        c.generate("hi")
    _, _, headers, _ = m.call_args[0]
    assert len(headers.get("Idempotency-Key", "")) >= 16  # a uuid4 was attached


def test_504_replays_with_same_key_then_succeeds():
    c = _client()
    seq = [
        _resp(504, {"error": {"code": "GATEWAY_TIMEOUT"}}),
        _resp(200, {"id": "d2", "usage": {"credits_charged": 3, "credits_remaining": 94}}),
    ]
    with mock.patch.object(c, "_send", side_effect=seq) as m, mock.patch("time.sleep"):
        out = c.generate("hi")
    assert out["id"] == "d2"
    assert m.call_count == 2
    keys = {call.args[2]["Idempotency-Key"] for call in m.call_args_list}
    assert len(keys) == 1  # SAME key across the retry -> server replays, one charge
    assert [s["status"] for s in c.session_charges] == ["confirmed"]


def test_timeout_is_retried_then_succeeds():
    c = _client()
    seq = [DiagramsAPIError("TIMEOUT", "x", 0),
           _resp(200, {"id": "d3", "usage": {"credits_charged": 1, "credits_remaining": 5}})]
    with mock.patch.object(c, "_send", side_effect=seq), mock.patch("time.sleep"):
        out = c.generate("hi")
    assert out["id"] == "d3"


def test_definite_422_is_not_retried_and_leaves_no_unknown():
    c = _client()
    with mock.patch.object(c, "_send", return_value=_resp(422, {"detail": "bad"})) as m, mock.patch("time.sleep"):
        with pytest.raises(DiagramsAPIError):
            c.generate("hi")
    assert m.call_count == 1
    assert c.session_charges == []  # definite reject -> nothing was charged


def test_exhausted_ambiguous_records_unknown_and_raises():
    c = _client()
    with mock.patch.object(c, "_send", return_value=_resp(504, {"error": {"code": "GATEWAY_TIMEOUT"}})) as m, \
            mock.patch("time.sleep"):
        with pytest.raises(DiagramsAPIError) as ei:
            c.generate("hi")
    assert ei.value.status == 504
    assert m.call_count == 4  # initial + 3 retries
    assert [s["status"] for s in c.session_charges] == ["unknown"]
    assert c.session_charges[0]["action"] == "generate"


def test_urllib_timeout_maps_to_typed_error():
    import socket
    c = DiagramsClient(api_key="dgz_test_x")
    with mock.patch("urllib.request.urlopen", side_effect=socket.timeout("slow")):
        with pytest.raises(DiagramsAPIError) as ei:
            c._send_urllib("GET", "http://x/y", {}, None)
    assert ei.value.code == "TIMEOUT"


def test_urllib_connection_error_maps_to_typed_error():
    import urllib.error
    c = DiagramsClient(api_key="dgz_test_x")
    with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
        with pytest.raises(DiagramsAPIError) as ei:
            c._send_urllib("GET", "http://x/y", {}, None)
    assert ei.value.code == "CONNECTION_ERROR"


def test_requests_timeout_maps_to_typed_error():
    requests = pytest.importorskip("requests")
    c = DiagramsClient(api_key="dgz_test_x")
    with mock.patch("requests.request", side_effect=requests.exceptions.Timeout("boom")):
        with pytest.raises(DiagramsAPIError) as ei:
            c.get("d1")
    assert ei.value.code == "TIMEOUT"


def test_edit_and_fix_route_through_idempotent_path():
    c = _client()
    ok = _resp(200, {"id": "d4", "usage": {"credits_charged": 2, "credits_remaining": 3}})
    for call in (lambda: c.edit("d4", "make it blue"), lambda: c.fix("d4", "add a WAF")):
        c.session_charges.clear()
        with mock.patch.object(c, "_send", return_value=ok) as m:
            call()
        _, _, headers, _ = m.call_args[0]
        assert headers.get("Idempotency-Key")  # auto-attached
        assert c.session_charges[0]["status"] == "confirmed"
