"""Drift guard — the SDK's declared endpoint coverage must equal the live
OpenAPI spec. If the API adds or removes an operation, this fails and tells you
exactly what to change in the client. Skipped in a standalone build where the
spec isn't checked out alongside the SDK."""
import json
from pathlib import Path

import pytest

SPEC = Path(__file__).resolve().parents[2] / "spec" / "openapi-v2.json"

# The 29 operations the client covers, as (METHOD, path) pairs.
COVERED = {
    ("GET", "/api/v2/usage/history"),
    ("POST", "/api/v2/oauth/device/code"),   # login() — device flow start
    ("POST", "/api/v2/oauth/device/token"),  # login() — device flow poll
    ("POST", "/api/v2/diagrams"),
    ("GET", "/api/v2/diagrams"),
    ("POST", "/api/v2/diagrams/import"),
    ("POST", "/api/v2/diagrams/stream"),
    ("GET", "/api/v2/diagrams/{diagram_id}"),
    ("DELETE", "/api/v2/diagrams/{diagram_id}"),
    ("PATCH", "/api/v2/diagrams/{diagram_id}"),
    ("POST", "/api/v2/diagrams/{diagram_id}/edit"),
    ("GET", "/api/v2/diagrams/{diagram_id}/export"),
    ("POST", "/api/v2/diagrams/{diagram_id}/fix"),
    ("POST", "/api/v2/diagrams/{diagram_id}/relayout"),
    ("GET", "/api/v2/diagrams/{diagram_id}/relayout/{job_id}"),
    ("POST", "/api/v2/diagrams/{diagram_id}/revert"),
    ("GET", "/api/v2/diagrams/{diagram_id}/versions"),
    ("GET", "/api/v2/diagrams/{diagram_id}/versions/{version_id}"),
    ("GET", "/api/v2/diagrams/{diagram_id}/warnings"),
    ("GET", "/api/v2/gallery"),
    ("POST", "/api/v2/gallery/{diagram_id}/fork"),
    ("GET", "/api/v2/me"),
    ("GET", "/api/v2/meta/diagram-types"),
    ("GET", "/api/v2/meta/features"),
    ("GET", "/api/v2/meta/formats"),
    ("GET", "/api/v2/meta/providers"),
    ("POST", "/api/v2/prompts/clarify"),
    ("POST", "/api/v2/prompts/enhance"),
    ("GET", "/api/v2/usage"),
}

# Operations the API exposes but the SDK deliberately does NOT wrap. The device
# consent endpoints are session-authenticated and driven by the diagrams.so web
# consent page — an API-key SDK has no business calling them.
WEB_ONLY = {
    ("GET", "/api/v2/oauth/device/info"),
    ("POST", "/api/v2/oauth/device/approve"),
    ("POST", "/api/v2/oauth/device/deny"),
}


@pytest.mark.skipif(not SPEC.exists(), reason="spec/openapi-v2.json missing")
def test_sdk_covers_every_api_operation():
    spec = json.loads(SPEC.read_text())
    actual = {
        (m.upper(), p)
        for p, ops in spec["paths"].items()
        for m in ops
        if m in ("get", "post", "patch", "delete", "put")
    }
    missing = actual - COVERED - WEB_ONLY
    removed = (COVERED | WEB_ONLY) - actual
    assert not missing, f"API added operations the SDK must implement: {sorted(missing)}"
    assert not removed, f"SDK lists operations the API no longer exposes: {sorted(removed)}"
