"""Behavioural tests for the Python SDK — mocks the transport, asserts the wire
contract (method, path, body, headers, error mapping, retry)."""
import json
from unittest import mock

import pytest

from diagrams_so import DiagramsAPIError, DiagramsClient


def _resp(status, body, headers=None):
    text = body if isinstance(body, str) else json.dumps(body)
    return (status, headers or {}, text)


def test_requires_api_key(monkeypatch, tmp_path):
    # Isolate from the login() cache and env so "no credentials anywhere" is real.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DIAGRAMS_API_KEY", raising=False)
    with pytest.raises(ValueError, match="Not connected"):
        DiagramsClient(api_key="")


def test_generate_posts_body_and_idempotency_header():
    c = DiagramsClient(api_key="dgz_test_x")
    with mock.patch.object(c, "_send", return_value=_resp(200, {"id": "d1"})) as m:
        out = c.generate("hi", cloud_provider="aws", idempotency_key="k1")
    assert out["id"] == "d1"
    method, url, headers, data = m.call_args[0]
    assert method == "POST"
    assert url.endswith("/diagrams")
    assert headers["Idempotency-Key"] == "k1"
    sent = json.loads(data)
    assert sent["prompt"] == "hi" and sent["cloud_provider"] == "aws"


def test_error_envelope_raises_typed_error():
    c = DiagramsClient(api_key="dgz_test_x")
    body = {"error": {"code": "QUOTA_EXCEEDED", "message": "no credits", "request_id": "req_1"}}
    with mock.patch.object(c, "_send", return_value=_resp(402, body)):
        with pytest.raises(DiagramsAPIError) as ei:
            c.generate("hi")
    assert ei.value.code == "QUOTA_EXCEEDED"
    assert ei.value.status == 402
    assert ei.value.request_id == "req_1"


def test_retries_on_429_then_succeeds():
    c = DiagramsClient(api_key="dgz_test_x", max_retries=2)
    seq = [
        _resp(429, {"error": {"code": "RATE_LIMITED"}}, {"retry-after": "0"}),
        _resp(200, {"id": "d2"}),
    ]
    with mock.patch.object(c, "_send", side_effect=seq) as m, mock.patch("time.sleep"):
        out = c.generate("hi")
    assert out["id"] == "d2"
    assert m.call_count == 2


def test_does_not_retry_on_4xx_other_than_429():
    c = DiagramsClient(api_key="dgz_test_x", max_retries=3)
    with mock.patch.object(c, "_send", return_value=_resp(400, {"error": {"code": "VALIDATION_ERROR"}})) as m:
        with pytest.raises(DiagramsAPIError):
            c.generate("hi")
    assert m.call_count == 1


def test_list_filters_none_query_params():
    c = DiagramsClient(api_key="dgz_test_x")
    with mock.patch.object(c, "_send", return_value=_resp(200, {"items": []})) as m:
        c.list(limit=5)
    _, url, _, _ = m.call_args[0]
    assert "limit=5" in url and "cursor" not in url


# -- diagram_type: left out unless given (server picks the type) --------------

def _sent_body(c, call):
    with mock.patch.object(c, "_send", return_value=_resp(200, {"id": "d1"})) as m:
        call()
    return json.loads(m.call_args[0][3])


def test_generate_omits_diagram_type_when_not_given():
    c = DiagramsClient(api_key="dgz_test_x")
    sent = _sent_body(c, lambda: c.generate("hi"))
    assert "diagram_type" not in sent
    assert sent["cloud_provider"] == "general" and sent["opinionated"] is False


@pytest.mark.parametrize("value", ["architecture", "auto"])
def test_generate_sends_explicit_diagram_type(value):
    c = DiagramsClient(api_key="dgz_test_x")
    sent = _sent_body(c, lambda: c.generate("hi", diagram_type=value))
    assert sent["diagram_type"] == value


def test_import_omits_diagram_type_when_not_given():
    c = DiagramsClient(api_key="dgz_test_x")
    sent = _sent_body(c, lambda: c.import_diagram("<mxfile/>"))
    assert "diagram_type" not in sent


def test_import_sends_explicit_diagram_type():
    c = DiagramsClient(api_key="dgz_test_x")
    sent = _sent_body(c, lambda: c.import_diagram("<mxfile/>", diagram_type="architecture"))
    assert sent["diagram_type"] == "architecture"


@pytest.mark.parametrize("value,expected", [(None, None), ("architecture", "architecture"),
                                            ("auto", "auto")])
def test_generate_stream_diagram_type(value, expected):
    c = DiagramsClient(api_key="dgz_test_x")
    seen = {}

    def fake_sse(url, headers, data):
        seen["body"] = json.loads(data)
        yield "complete", {"id": "d1", "usage": {"credits_charged": 1}}

    with mock.patch.object(c, "_sse", side_effect=fake_sse):
        kwargs = {} if value is None else {"diagram_type": value}
        list(c.generate_stream("hi", **kwargs))
    if expected is None:
        assert "diagram_type" not in seen["body"]
    else:
        assert seen["body"]["diagram_type"] == expected
