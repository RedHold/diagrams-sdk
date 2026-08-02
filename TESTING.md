# Local testing guide — Diagrams.so SDKs (v1.1.0)

Everything here runs **fully offline and spends zero credits**. It exercises both
SDKs — unit tests, real-socket end-to-end tests against a local stub API, and the
release packaging — and proves the v1.1.0 billing-safety behaviour (idempotent
retries, honest tally, timeout ladder, no-free-relayout).

> A live smoke against the real API (which **does** spend credits) is optional and
> covered last.

**Prerequisites:** Python ≥ 3.9, Node ≥ 18. From the repo root unless noted.

---

## 0. One-time setup

```bash
# Python: an isolated venv with the test tools
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
python -m pip install -U pip pytest build twine requests

# TypeScript
cd typescript && npm install && cd ..
```

`requests` is optional for the SDK itself (it falls back to stdlib `urllib`), but
installing it lets you test **both** transports.

---

## 1. Python unit tests

Mocked transport — asserts the wire contract: idempotency, the same-key retry
ladder, ambiguous-vs-definite classification, error mapping, and the OpenAPI
drift-guard.

```bash
cd python && pytest -q && cd ..
```

**Expect:** `17 passed`.

Test the **stdlib `urllib`** transport too (no `requests`):

```bash
pip uninstall -y requests
cd python && pytest -q && cd ..        # 16 passed, 1 skipped (the requests-only test)
pip install requests                   # restore
```

---

## 2. TypeScript unit tests

Mocked `fetch` — same contract, plus the drift-guard.

```bash
cd typescript && npm run build && npm test && cd ..
```

**Expect:** `# pass 13`, `# fail 0`.

---

## 3. End-to-end integration (real transport, local stub API)

This is the important one: the **real** SDK transport talks HTTP over a socket to a
local stub (`local-test/stub_api.py`) that injects failures to prove the billing
guarantees. No mocks, no credits.

Open **two terminals** (or background the stub).

**Terminal A — start the stub:**
```bash
python local-test/stub_api.py           # http://127.0.0.1:8899
```

**Terminal B — run each SDK against it:**
```bash
python local-test/it_python.py          # Python SDK  -> 28 passed
cd typescript && npm run build && cd ..  # (if not already built)
node local-test/it_typescript.mjs        # TypeScript SDK -> 28 passed
```

**Expect:** `28 passed, 0 failed` for each.

### What the 10 scenarios prove

| # | Scenario | What it verifies |
|---|----------|------------------|
| 1 | reads (`me`, `usage`) | auth headers + JSON round-trip |
| 2 | generate happy path | one charge; tally = `confirmed` |
| 3 | **`FAIL_ONCE_504`** — response lost after the charge | same-key retry **replays** the stored result → **exactly one charge**, id recovered, tally `confirmed` |
| 4 | **`FAIL_ALWAYS_504`** — hard ambiguous outage | retries exhaust → error raised, **server never charged**, tally = `unknown` |
| 5 | **`FAIL_422`** — definite reject | **no retry**, no charge, no tally entry |
| 6 | shared explicit `idempotency_key` | two calls, **one charge** (server replays the 2nd) |
| 7 | edit + fix | both billable + idempotent |
| 8 | re-layout confirm flow | first call → `confirmation_required`; `confirm=true` → `done`/`applied`, charged **on delivery** |
| 9 | SSE streaming generate | `progress` then terminal `complete` with an id |
| 10 | `usage_history` | reflects the server ledger |

> The stub's failure tokens (`FAIL_ONCE_504`, `FAIL_ALWAYS_504`, `FAIL_422`) are just
> magic strings in the prompt — see the header of `local-test/stub_api.py`.

**Inspect the server-side ledger any time** (proves charge counts independently):
```bash
curl -s http://127.0.0.1:8899/__debug | python3 -m json.tool
```

Stop the stub with `Ctrl-C` in Terminal A.

### One-liner (no second terminal)

```bash
python local-test/stub_api.py & STUB=$!; sleep 1
python local-test/it_python.py
(cd typescript && npm run build) && node local-test/it_typescript.mjs
kill $STUB
```

---

## 4. Release packaging (build the exact published artifacts)

**Python** — build sdist + wheel and validate metadata:
```bash
cd python && rm -rf dist && python -m build && twine check dist/* && cd ..
```
**Expect:** `Checking dist/…: PASSED` for both the `.whl` and `.tar.gz`.

**TypeScript** — see the exact tarball that would publish:
```bash
cd typescript && npm run build && npm pack --dry-run && cd ..
```
**Expect:** `@diagrams-so/sdk@1.1.0`, `total files: 6` (dist/index.js, index.d.ts,
README, LICENSE, NOTICE, package.json).

---

## 5. (Optional) Live smoke against the real API — spends credits

Only if you want to confirm against production. **This bills your account** for
generate/edit/relayout. Use a `dgz_test_` key (still bills, at lower rate limits).

```bash
export DIAGRAMS_API_KEY="dgz_test_…"
# Python
python examples/try_local.py
# TypeScript
cd typescript && npm run build && node ../examples/try_local.mjs
```

To point any test at a **local** API instead of production, set the base URL:
`DiagramsClient(api_key=…, base_url="http://localhost:8000/api/v2")` (Python) or
`new DiagramsClient({ apiKey, baseUrl: "http://localhost:8000/api/v2" })` (TS).

---

## Quick "all-in" checklist

- [ ] `cd python && pytest -q` → **17 passed**
- [ ] urllib path: uninstall `requests`, `pytest -q` → **16 passed, 1 skipped**, reinstall
- [ ] `cd typescript && npm run build && npm test` → **13 pass, 0 fail**
- [ ] stub up + `python local-test/it_python.py` → **28 passed**
- [ ] stub up + `node local-test/it_typescript.mjs` → **28 passed**
- [ ] `cd python && python -m build && twine check dist/*` → **PASSED ×2**
- [ ] `cd typescript && npm pack --dry-run` → **1.1.0, 6 files**

Everything green = the SDKs are correct and release-ready locally. Nothing here
touches the network beyond `127.0.0.1` or spends credits.

---

### Notes
- `local-test/` and this `TESTING.md` are **local test helpers** (not part of the
  shipped packages). Keep or delete them as you like.
- The stub is a minimal fake — never point a real `dgz_live_` key at it.
- My run (for reference): Python unit **17**, TS unit **13**, integration **28 + 28**
  (on both the `urllib` and `requests` transports), packaging clean.
