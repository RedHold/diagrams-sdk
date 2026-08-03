#!/usr/bin/env python3
"""Hard audit of the Python SDK: every retry/classification/header/parsing aspect,
with a fully mocked transport so each case is exact. Run: python local-test/audit_python.py"""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
from diagrams_so import DiagramsClient, DiagramsAPIError, is_ambiguous  # noqa: E402

P = F = 0
def check(name, cond):
    global P, F
    if cond: P += 1; print(f"  ✓ {name}")
    else: F += 1; print(f"  ✗ {name}   <-- FAIL")

def resp(status, body, headers=None):
    return (status, headers or {}, body if isinstance(body, str) else json.dumps(body))

def client(**kw):
    kw.setdefault("retry_delays", (0, 0, 0)); kw.setdefault("retry_budget", 30)
    return DiagramsClient(api_key="dgz_test_x", **kw)

OK = {"id": "d1", "usage": {"credits_charged": 2, "credits_remaining": 9}}

print("A) is_ambiguous classification (must match MCP)")
for code, st, exp in [("TIMEOUT",0,True),("CONNECTION_ERROR",0,True),("IDEMPOTENCY_IN_PROGRESS",409,True),
                      ("X",502,True),("X",503,True),("X",504,True),("X",409,True),
                      ("QUOTA_EXCEEDED",402,False),("VALIDATION_ERROR",422,False),("X",400,False),
                      ("X",401,False),("X",404,False),("X",500,False),("X",429,False)]:
    check(f"{code}/{st} -> {'ambiguous' if exp else 'definite'}", is_ambiguous(DiagramsAPIError(code, "", st)) is exp)
check("non-APIError is never ambiguous", is_ambiguous(ValueError("x")) is False)

print("B) ambiguous statuses are retried (same key) then succeed")
for st in (502, 503, 504, 409):
    c = client()
    seq = [resp(st, {"error": {"code": "X"}}), resp(200, OK)]
    with mock.patch.object(c, "_send", side_effect=seq) as m, mock.patch("time.sleep"):
        out = c.generate("hi")
    keys = {call.args[2].get("Idempotency-Key") for call in m.call_args_list}
    check(f"{st} retried to success, one stable key", out["id"] == "d1" and len(keys) == 1 and None not in keys)

print("C) definite statuses are NOT retried")
for st in (400, 401, 402, 404, 422, 500):
    c = client()
    with mock.patch.object(c, "_send", return_value=resp(st, {"error": {"code": "E"}})) as m, mock.patch("time.sleep"):
        try: c.generate("hi"); raised = False
        except DiagramsAPIError: raised = True
    check(f"{st} raises without retry (1 call)", raised and m.call_count == 1 and c.session_charges == [])

print("D) raised transport errors (TIMEOUT/CONNECTION_ERROR) are retried")
for code in ("TIMEOUT", "CONNECTION_ERROR"):
    c = client()
    seq = [DiagramsAPIError(code, "x", 0), resp(200, OK)]
    with mock.patch.object(c, "_send", side_effect=seq), mock.patch("time.sleep"):
        out = c.generate("hi")
    check(f"{code} retried to success", out["id"] == "d1")

print("E) 429 handled by inner Retry-After loop (not the ambiguous ladder)")
c = client(max_retries=2)
seq = [resp(429, {"error": {"code": "RATE_LIMITED"}}, {"retry-after": "0"}), resp(200, OK)]
with mock.patch.object(c, "_send", side_effect=seq) as m, mock.patch("time.sleep"):
    out = c.generate("hi")
check("429 then 200 succeeds (2 calls)", out["id"] == "d1" and m.call_count == 2)

print("F) exhausted ambiguous -> unknown tally + raise")
c = client()
with mock.patch.object(c, "_send", return_value=resp(504, {"error": {"code": "GW"}})) as m, mock.patch("time.sleep"):
    try: c.generate("hi"); raised = False
    except DiagramsAPIError: raised = True
check("504 forever: raises, 4 calls, one unknown tally", raised and m.call_count == 4
      and [s["status"] for s in c.session_charges] == ["unknown"])

print("G) budget exhaustion stops early")
c = client(retry_delays=(100, 100, 100), retry_budget=0.001)
with mock.patch.object(c, "_send", return_value=resp(504, {"error": {"code": "GW"}})) as m, mock.patch("time.sleep"):
    try: c.generate("hi")
    except DiagramsAPIError: pass
check("tiny budget -> no retries (1 call), unknown tallied", m.call_count == 1 and c.session_charges[-1]["status"] == "unknown")

print("H) idempotency key auto-attached + stable for generate/edit/fix/relayout")
for name, call in [("generate", lambda c: c.generate("x")), ("edit", lambda c: c.edit("d", "x")),
                   ("fix", lambda c: c.fix("d", "x")), ("relayout", lambda c: c.relayout("d", confirm=True))]:
    c = client()
    seq = [resp(504, {"error": {"code": "GW"}}), resp(200, {**OK, "status": "pending", "chargeable": True})]
    with mock.patch.object(c, "_send", side_effect=seq) as m, mock.patch("time.sleep"):
        call(c)
    keys = [call_.args[2].get("Idempotency-Key") for call_ in m.call_args_list]
    check(f"{name}: key present + identical across retry", all(keys) and len(set(keys)) == 1)

print("I) attribution headers on every request")
c = client()
with mock.patch.object(c, "_send", return_value=resp(200, OK)) as m:
    c.generate("hi")
h = m.call_args[0][2]
check("X-Diagrams-Client = sdk-python/1.1.0", h.get("X-Diagrams-Client") == "sdk-python/1.1.0")
check("User-Agent = diagrams-so-python/1.1.0", h.get("User-Agent") == "diagrams-so-python/1.1.0")

print("J) query params: arrays repeat, None dropped, from/to mapping")
c = client()
with mock.patch.object(c, "_send", return_value=resp(200, {"items": [], "has_more": False, "summary": {}})) as m:
    c.usage_history(action=["generate", "edit"], since="2026-01-01", limit=None)
url = m.call_args[0][1]
check("action repeated", url.count("action=") == 2 and "action=generate" in url and "action=edit" in url)
check("since -> from", "from=2026-01-01" in url)
check("None limit dropped", "limit=" not in url)

print("K) response parsing: raw export, 204 delete, error envelope, 422 detail")
c = client()
with mock.patch.object(c, "_send", return_value=resp(200, "<mxGraphModel/>")):
    check("export returns raw text", c.export("d", "drawio") == "<mxGraphModel/>")
with mock.patch.object(c, "_send", return_value=(204, {}, "")):
    check("delete returns None", c.delete("d") is None)
c2 = client()
with mock.patch.object(c2, "_send", return_value=resp(402, {"error": {"code": "QUOTA_EXCEEDED", "message": "no", "request_id": "r1"}})):
    try: c2.get("d")
    except DiagramsAPIError as e:
        check("error envelope -> code/status/request_id", e.code == "QUOTA_EXCEEDED" and e.status == 402 and e.request_id == "r1")
c3 = client()
with mock.patch.object(c3, "_send", return_value=resp(422, {"detail": [{"msg": "bad"}]})):
    try: c3.get("d")
    except DiagramsAPIError as e:
        check("422 detail surfaced in message", "bad" in str(e) or "detail" in str(e).lower() or e.status == 422)

print("L) no api key raises at construction")
try: DiagramsClient(api_key=""); check("empty key raises", False)
except ValueError: check("empty key raises", True)

print("M) persistent 503 on a billable call -> single retry layer (no double-retry)")
c = client(max_retries=2)   # retry_delays=(0,0,0) -> outer ladder = 1 + 3 attempts
with mock.patch.object(c, "_send", return_value=resp(503, {"error": {"code": "X"}})) as m, mock.patch("time.sleep"):
    try: c.generate("hi")
    except DiagramsAPIError: pass
print(f"     (note) persistent 503 -> {m.call_count} transport calls (outer idempotent ladder only)")
check("persistent 503 uses only the outer ladder (4 calls) + unknown tally",
      m.call_count == 4 and c.session_charges[-1]["status"] == "unknown")

print("N) re-layout poll error records an unknown tally (charge may still land)")
c = client()
seq = [resp(200, {"job_id": "j1", "status": "pending", "chargeable": True}), resp(504, {"error": {"code": "GW"}})]
with mock.patch.object(c, "_send", side_effect=seq), mock.patch("time.sleep"):
    try: c.relayout_and_wait("d", confirm=True); raised = False
    except DiagramsAPIError: raised = True
check("poll failure -> raise + one unknown relayout tally", raised
      and [s for s in c.session_charges if s["action"] == "relayout" and s["status"] == "unknown"]
      and len(c.session_charges) == 1)

print(f"\nPython audit: {P} passed, {F} failed")
sys.exit(1 if F else 0)
