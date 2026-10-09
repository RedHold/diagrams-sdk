#!/usr/bin/env python3
"""End-to-end integration test: the REAL Python SDK transport against the local
stub API (local-test/stub_api.py). Fully offline. Proves idempotency replay, the
ambiguous-retry ladder, the honest tally, streaming, and the re-layout confirm
flow over an actual socket.

Run the stub first (PORT=8899 python local-test/stub_api.py), then:
    python local-test/it_python.py
Exits non-zero on the first failed assertion.
"""
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
from diagrams_so import DiagramsClient, DiagramsAPIError  # noqa: E402

BASE = os.environ.get("BASE", "http://127.0.0.1:8899/api/v2")
DEBUG = BASE.rsplit("/api/", 1)[0] + "/__debug"

PASS, FAIL = 0, 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}")


def charges():
    import json
    with urllib.request.urlopen(DEBUG) as r:
        return json.load(r)["charge_count"]


def client():
    # zero delays so the retry ladder doesn't sleep
    return DiagramsClient(api_key="dgz_test_local", base_url=BASE,
                          retry_delays=(0, 0, 0), retry_budget=30, timeout=10)


def main():
    c = client()
    print("1) reads")
    check("me() returns account", c.me().get("email") == "you@example.com")
    check("usage() has cost_estimates", "cost_estimates" in c.usage())

    print("2) generate happy path")
    n0 = charges()
    d = c.generate("a simple VPC")
    check("returned a diagram id", bool(d.get("id")))
    check("charged exactly once", charges() - n0 == 1)
    check("tally recorded confirmed", c.session_charges[-1]["status"] == "confirmed")

    print("3) idempotency replay (response lost to a 504, same key retried)")
    n0 = charges()
    d = c.generate("FAIL_ONCE_504 build me a mesh")
    check("recovered the diagram id after replay", bool(d.get("id")))
    check("server charged ONCE despite the retry", charges() - n0 == 1)
    check("tally is confirmed (not unknown)", c.session_charges[-1]["status"] == "confirmed")

    print("4) hard ambiguous outage -> unknown tally, no phantom charge")
    c2 = client()
    n0 = charges()
    raised = False
    try:
        c2.generate("FAIL_ALWAYS_504 nope")
    except DiagramsAPIError as e:
        raised = True
        check("surfaced a 504/timeout error", e.status == 504 or e.code in ("TIMEOUT",))
    check("did raise after exhausting retries", raised)
    check("server was NOT charged", charges() - n0 == 0)
    check("tally recorded UNKNOWN", c2.session_charges[-1]["status"] == "unknown")

    print("5) definite 422 -> no retry, no charge, no tally")
    c3 = client()
    n0 = charges()
    raised = False
    try:
        c3.generate("FAIL_422 bad input")
    except DiagramsAPIError as e:
        raised = True
        check("422 surfaced", e.status == 422)
    check("did raise", raised)
    check("not charged", charges() - n0 == 0)
    check("no tally entry", c3.session_charges == [])

    print("6) explicit shared key dedupes across calls")
    shared_key = f"order-{os.getpid()}"   # unique per run (the stub's idem store is long-lived)
    n0 = charges()
    a = c.generate("first", idempotency_key=shared_key)
    b = c.generate("second-ignored", idempotency_key=shared_key)
    check("same id replayed", a["id"] == b["id"])
    check("charged only once for the shared key", charges() - n0 == 1)

    print("7) edit + fix are billable & idempotent")
    n0 = charges()
    e = c.edit(d["id"], "make it HA")
    f = c.fix(d["id"], "close the SG")
    check("edit charged", e.get("usage", {}).get("credits_charged") == 3)
    check("fix charged", f.get("usage", {}).get("credits_charged") == 3)
    check("two charges recorded", charges() - n0 == 2)

    print("8) re-layout confirm flow (no free allowance)")
    job = c.relayout_and_wait(d["id"])
    check("first call needs confirmation", job.get("status") == "confirmation_required")
    n0 = charges()
    t0 = len(c.session_charges)
    job = c.relayout_and_wait(d["id"], confirm=True)
    check("confirmed run reaches done+applied", job.get("status") == "done" and job.get("applied") is True)
    check("re-layout charged on delivery", charges() - n0 == 1)
    check("re-layout recorded an UNKNOWN tally (recorded async in ledger)",
          any(s["action"] == "relayout" and s["status"] == "unknown" for s in c.session_charges[t0:]))

    print("9) SSE streaming generate")
    t0 = len(c.session_charges)
    events = {}
    final = None
    for event, data in c.generate_stream("stream me"):
        events[event] = events.get(event, 0) + 1
        if event == "complete":
            final = data
    check("saw a progress event", events.get("progress", 0) >= 1)
    check("saw a complete event with an id", bool(final and final.get("id")))
    check("streamed generate recorded a CONFIRMED tally",
          any(s["action"] == "generate" and s["status"] == "confirmed" for s in c.session_charges[t0:]))

    print("10) usage_history reflects the ledger")
    hist = c.usage_history(limit=100)
    check("history has items", len(hist.get("items", [])) >= 1)
    check("summary task_count present", "task_count" in hist.get("summary", {}))

    print(f"\nPython integration: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
