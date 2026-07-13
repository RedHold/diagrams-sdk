"""Try the Python SDK against your LOCAL API. Reads the key + base from env.

    DIAGRAMS_KEY=dgz_test_… DIAGRAMS_BASE=http://localhost:8000/api/v2 \
        python3 sdk/examples/try_local.py

No install needed — the SDK is stdlib-only. Reads/enhance/clarify are free;
generate/edit/relayout cost credits (a Pro test key has plenty)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
from diagrams_so import DiagramsClient, DiagramsAPIError  # noqa: E402

KEY = os.environ.get("DIAGRAMS_KEY")
BASE = os.environ.get("DIAGRAMS_BASE", "http://localhost:8000/api/v2")
if not KEY:
    sys.exit("Set DIAGRAMS_KEY (mint one — see the steps).")

c = DiagramsClient(api_key=KEY, base_url=BASE)

print("1) who am I / free reads")
print("   me:", c.me())
print("   providers:", c.meta("providers"))
print("   usage:", c.usage())

print("\n2) free prompt helpers")
print("   enhance:", c.enhance_prompt("aws web app")["enhanced_prompt"][:60], "…")

print("\n3) error handling (bad key → typed error)")
try:
    DiagramsClient(api_key="dgz_test_bogus", base_url=BASE).me()
except DiagramsAPIError as e:
    print(f"   raised DiagramsAPIError: {e.code} {e.status}")

print("\n4) generate (real LLM — costs a credit)")
d = c.generate("AWS 3-tier web app: ALB, 2x EC2, RDS", cloud_provider="aws")
did = d["id"]
print(f"   id={did}  score={d['score']['score']}  warnings={len(d['warnings'])}")

print("\n5) streaming a generation")
for event, data in c.generate_stream("Azure event pipeline: Event Hub, Functions, Cosmos DB", cloud_provider="azure"):
    if event == "progress":
        print(f"   …{data['progress']}% {data['message'][:40]}")
    elif event == "complete":
        stream_id = data["id"]
        print(f"   complete → {stream_id}")

print("\n6) async re-layout (poll to done)")
job = c.relayout_and_wait(did, poll_interval=2.0, timeout=120.0)
if job.get("status") == "confirmation_required":
    job = c.relayout_and_wait(did, confirm=True, poll_interval=2.0, timeout=120.0)
print("   relayout:", job.get("status"), "applied:", job.get("applied"))

print("\n7) export + cleanup")
svg = c.export(did, "svg")
print("   svg bytes:", len(svg))
c.delete(did)
c.delete(stream_id)
print("   deleted. done ✓")
