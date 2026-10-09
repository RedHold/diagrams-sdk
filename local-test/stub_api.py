#!/usr/bin/env python3
"""Offline stub of the Diagrams.so /api/v2, for local SDK testing with no account.

Runs on http://127.0.0.1:8899 by default (PORT env to change). It implements just
enough of the contract to exercise the SDKs' billing-safety behaviour end-to-end
over a real socket:

  * Idempotency-Key store: a repeated key REPLAYS the stored response (no 2nd charge).
  * Failure injection via magic tokens in the prompt / edit_prompt / message:
      FAIL_ONCE_504   -> charge + store the result, but return 504 on the FIRST attempt
                        (simulates a response lost to a gateway timeout). The client's
                        same-key retry then replays the stored 200 -> ONE charge.
      FAIL_ALWAYS_504 -> always 504, never charged (simulates a hard ambiguous outage).
      FAIL_422        -> definite validation reject, never charged, never retried.
  * A server-side charge ledger at GET /__debug so tests can assert "exactly one charge".

Not a real API: no auth is enforced, shapes are minimal. Never point a live key at it.
"""
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOCK = threading.Lock()
CHARGES = []                 # server-side ledger: [{"action","id","credits"}]
IDEM = {}                    # Idempotency-Key -> (status_code, body_dict)
_SEQ = {"n": 0}

SCORE = {"score": 88, "tier": "Good", "warning_count": 1, "recoverable_points": 6}


def _next_id(prefix="dgm"):
    _SEQ["n"] += 1
    return f"{prefix}_{_SEQ['n']:04d}"


def _inject(*parts):
    blob = " ".join(str(p) for p in parts if p)
    for tok in ("FAIL_ONCE_504", "FAIL_ALWAYS_504", "FAIL_422"):
        if tok in blob:
            return tok
    return None


def _diagram(did, action):
    remaining = 1000 - sum(c["credits"] for c in CHARGES)
    return {
        "id": did, "title": f"{action} result", "xml": "<mxGraphModel><root/></mxGraphModel>",
        "cloud_provider": "aws", "diagram_type": "architecture", "is_public": False,
        "created_at": "2026-08-02T00:00:00Z",
        "warnings": [{"type": "security", "message": "open SG"},
                     {"type": "suggestion", "message": "consider tagging resources"}],  # suggestion excluded from score
        "score": SCORE, "usage": {"credits_charged": 3, "credits_remaining": remaining, "tier": "pro"},
    }


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj, raw=False, ctype="application/json"):
        body = obj.encode() if raw else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Request-Id", f"req_{_SEQ['n']}")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # -- billable core (generate/edit/fix) --------------------------------
    def _billable(self, action, did=None, body=None):
        key = self.headers.get("Idempotency-Key")
        body = body or {}
        with LOCK:
            if key and key in IDEM:                      # replay — NO new charge
                code, resp = IDEM[key]
                return self._send(code, resp)
            inj = _inject(body.get("prompt"), body.get("edit_prompt"), body.get("message"))
            if inj == "FAIL_ALWAYS_504":
                return self._send(504, {"error": {"code": "GATEWAY_TIMEOUT", "message": "upstream timeout"}})
            if inj == "FAIL_422":
                return self._send(422, {"detail": [{"loc": ["body", "prompt"], "msg": "invalid"}]})
            did = did or _next_id()
            CHARGES.append({"action": action, "id": did, "credits": 3})   # charge-on-accept
            resp = _diagram(did, action)
            if key:
                IDEM[key] = (200, resp)                  # store the completed result
            if inj == "FAIL_ONCE_504":                   # response "lost" after the charge
                return self._send(504, {"error": {"code": "GATEWAY_TIMEOUT", "message": "lost"}})
            return self._send(200, resp)

    def do_GET(self):
        p = urlparse(self.path)
        path, q = p.path, parse_qs(p.query)
        if path == "/__debug":
            with LOCK:
                return self._send(200, {"charge_count": len(CHARGES), "charges": CHARGES,
                                        "idem_keys": list(IDEM.keys())})
        if path == "/api/v2/me":
            return self._send(200, {"id": "usr_1", "email": "you@example.com", "plan": "pro",
                                    "livemode": False, "scopes": ["diagrams:write"]})
        if path.startswith("/api/v2/meta/"):
            return self._send(200, ["aws", "azure", "gcp"])
        if path == "/api/v2/usage":
            with LOCK:
                spent = sum(c["credits"] for c in CHARGES)
            est = {a: {"min_credits": 0.5, "max_credits": 3.0} for a in ("generate", "edit", "fix", "relayout")}
            return self._send(200, {"plan": "pro", "credits_remaining": 1000 - spent, "cost_estimates": est})
        if path == "/api/v2/usage/history":
            with LOCK:
                items = [{"id": f"tx_{i}", "created_at": "2026-08-02T00:00:00Z",
                          "action_type": c["action"], "credits_charged": c["credits"],
                          "diagram_id": c["id"], "source": "sdk-python", "livemode": False}
                         for i, c in enumerate(CHARGES)]
                summary = {"total_credits_charged": sum(c["credits"] for c in CHARGES), "task_count": len(CHARGES)}
            return self._send(200, {"items": items, "next_cursor": None, "has_more": False, "summary": summary})
        m = re.match(r"^/api/v2/diagrams/([^/]+)/relayout/([^/]+)$", path)
        if m:
            did, _job = m.group(1), m.group(2)
            with LOCK:
                CHARGES.append({"action": "relayout", "id": did, "credits": 2})   # charge on delivery
            return self._send(200, {"job_id": _job, "status": "done", "applied": True, "progress": 100,
                                    "version_number": 2, "xml": "<mxGraphModel/>", "warnings": [], "score": SCORE})
        m = re.match(r"^/api/v2/diagrams/([^/]+)/versions/([^/]+)$", path)
        if m:
            return self._send(200, _diagram(m.group(1), "version"))
        m = re.match(r"^/api/v2/diagrams/([^/]+)/versions$", path)
        if m:
            return self._send(200, {"items": [{"id": "ver_1", "version_number": 1,
                                    "created_at": "2026-08-02T00:00:00Z"}], "next_cursor": None, "has_more": False})
        m = re.match(r"^/api/v2/diagrams/([^/]+)/warnings$", path)
        if m:
            return self._send(200, [{"type": "security", "component": "sg", "message": "open SG"},
                                    {"type": "suggestion", "component": None, "message": "consider tagging resources"}])
        m = re.match(r"^/api/v2/diagrams/([^/]+)/export$", path)
        if m:
            fmt = (q.get("format") or ["drawio"])[0]
            return self._send(200, "<mxGraphModel/>" if fmt == "drawio" else "<svg/>", raw=True,
                              ctype="application/xml")
        m = re.match(r"^/api/v2/diagrams/([^/]+)$", path)
        if m:
            return self._send(200, _diagram(m.group(1), "get"))
        if path == "/api/v2/diagrams":
            return self._send(200, {"items": [], "next_cursor": None, "has_more": False})
        if path == "/api/v2/gallery":
            return self._send(200, {"items": [], "next_cursor": None, "has_more": False})
        return self._send(404, {"error": {"code": "NOT_FOUND", "message": path}})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read()   # ALWAYS drain the request body first (HTTP keep-alive safety)
        if path == "/api/v2/diagrams":
            return self._billable("generate", body=body)
        if path == "/api/v2/diagrams/stream":
            return self._stream(body)
        m = re.match(r"^/api/v2/diagrams/([^/]+)/edit$", path)
        if m:
            return self._billable("edit", m.group(1), body=body)
        m = re.match(r"^/api/v2/diagrams/([^/]+)/fix$", path)
        if m:
            return self._billable("fix", m.group(1), body=body)
        m = re.match(r"^/api/v2/diagrams/([^/]+)/relayout$", path)
        if m:
            confirm = (parse_qs(urlparse(self.path).query).get("confirm") or [""])[0] == "true"
            if not confirm:
                return self._send(200, {"status": "confirmation_required", "chargeable": True,
                                        "message": "Re-layout is billed; re-call with confirm=true."})
            return self._send(200, {"job_id": _next_id("job"), "status": "pending",
                                    "progress": 0, "chargeable": True})
        m = re.match(r"^/api/v2/diagrams/([^/]+)/revert$", path)
        if m:
            return self._send(200, _diagram(m.group(1), "revert"))
        if path == "/api/v2/diagrams/import":
            return self._send(200, _diagram(_next_id(), "import"))
        m = re.match(r"^/api/v2/gallery/([^/]+)/fork$", path)
        if m:
            return self._send(200, _diagram(_next_id(), "fork"))
        if path.startswith("/api/v2/prompts/"):
            return self._send(200, {"prompt": "enhanced", "questions": ["q1"]})
        return self._send(404, {"error": {"code": "NOT_FOUND", "message": path}})

    def do_PATCH(self):
        m = re.match(r"^/api/v2/diagrams/([^/]+)$", urlparse(self.path).path)
        self._read()
        if m:
            return self._send(200, _diagram(m.group(1), "update"))
        return self._send(404, {"error": {"code": "NOT_FOUND"}})

    def do_DELETE(self):
        self._read()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _stream(self, body=None):
        did = _next_id()
        with LOCK:
            CHARGES.append({"action": "generate", "id": did, "credits": 3})
            remaining = 1000 - sum(c["credits"] for c in CHARGES)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        def ev(name, data):
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()
        ev("progress", {"stage": "layout", "progress": 50, "message": "placing nodes"})
        ev("complete", {"id": did, "title": "streamed", "xml": "<mxGraphModel/>",
                        "usage": {"credits_charged": 3, "credits_remaining": remaining}})


def main():
    port = int(os.environ.get("PORT", "8899"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"stub API on http://127.0.0.1:{port}/api/v2  (Ctrl-C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
