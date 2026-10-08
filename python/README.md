# diagrams-so — Python SDK

A thin, typed, **dependency-free** client for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`). Generate, edit, and manage cloud-architecture diagrams (draw.io / SVG) with AI.

- Covers **all 27** `/api/v2` operations · one method per endpoint
- **No hard dependencies** — uses `requests` if installed, else stdlib `urllib`
- Typed, ships `py.typed` · raises a single `DiagramsAPIError` with `code` / `status` / `request_id`
- **Safe retries:** every AI call auto-attaches an `Idempotency-Key` and retries *ambiguous* failures (timeout / 5xx / in-progress) with the **same key**, so a response lost to a gateway timeout is replayed — one diagram, never two
- Built-in `429`/`503` backoff (honors `Retry-After`), **SSE streaming**, async **re-layout** helper, and an in-process cost tally (`session_charges`)

## Install
```bash
pip install diagrams-so
```

Then connect. This puts a `diagrams-so` command on your PATH, so there is no key
to copy and nothing to paste:

```bash
diagrams-so login      # a browser opens, press Approve
diagrams-so whoami     # check which account this machine is connected as
```

In code, `DiagramsClient()` then needs no arguments. For CI, set
`DIAGRAMS_API_KEY` instead; it always takes priority over a stored login.

(Uses `requests` if present, otherwise the stdlib `urllib` — no hard dependency.)

## Quickstart
```python
from diagrams_so import DiagramsClient

client = DiagramsClient(api_key="dgz_live_…")   # or dgz_test_… (test mode — same real account, lower rate limit)

d = client.generate("AWS 3-tier web app: ALB, EC2, RDS", cloud_provider="aws")
print(d["id"], d["score"]["score"], len(d["warnings"]))

# fix the first Well-Architected warning
w = client.warnings(d["id"])
if w:
    client.fix(d["id"], w[0]["message"], component=w[0].get("component"), warning_type=w[0]["type"])

open("diagram.drawio", "w").write(client.export(d["id"], "drawio"))
```

## Authentication & plans
Pass your key (from **Settings → AI Provider** in your account). **Nothing you call is metered:** generation is unlimited on both plans — Free ($0) and Paid ($20/month, or $100/year) — and the per-minute rate limit is the only ceiling. The Paid plan adds exactly two things: exports without a watermark, and `.drawio` export. `dgz_test_` keys are test mode, not a sandbox — they act on the same real account (real diagrams created, edited, deleted; real AI calls) at a lower rate limit (20 requests/minute instead of 60). `client.usage()` reports your plan and what each action costs us to run.

## Errors
Every non-2xx raises `DiagramsAPIError`:
```python
from diagrams_so import DiagramsAPIError
try:
    client.generate("…")
except DiagramsAPIError as e:
    print(e.code, e.status, e.request_id)   # e.g. VALIDATION_ERROR 422 req_abc
    if e.status == 403 and e.code == "UPGRADE_REQUIRED":
        ...  # a Paid-plan feature (e.g. `.drawio` export) → send the user to upgrade
```

## Idempotency (safe retries on AI calls)
Every AI call (`generate`, `edit`, `fix`, `relayout`) **auto-attaches a fresh
`Idempotency-Key`** and retries ambiguous failures with that same key, so a timeout
never turns one call into two diagrams. Pass your own key to make the safety window
explicit or to dedupe across processes:
```python
client.generate("…", idempotency_key="order-42")   # server replays the stored result for 24h
```
Definite rejections (`401`/`403`/`404`/`422`) are never retried; a call whose outcome
is lost is recorded in `session_charges` as `status="unknown"` — reconcile with
`client.usage_history()`. Streamed generations tally a `confirmed` cost on their
terminal event; an applied re-layout tallies `unknown` (its cost is recorded
asynchronously — the exact figure is in `usage_history`).

## Streaming
```python
for event, data in client.generate_stream("AWS event-driven pipeline"):
    if event == "progress":
        print(data["progress"], data["message"])
    elif event == "complete":
        print(data["id"], data["usage"]["credits_charged"])
    elif event == "error":
        raise RuntimeError(data["error"]["message"])
```
The diagram XML arrives only in the terminal `complete` event, once generation finishes.

## Async re-layout
Re-layout runs the model on **every** call, so it always asks first. The first call
returns `confirmation_required`; re-call with `confirm=True` to go ahead:
```python
job = client.relayout_and_wait(d["id"])           # starts + polls to completion
if job.get("status") == "confirmation_required":  # re-layout always needs confirmation
    job = client.relayout_and_wait(d["id"], confirm=True)
```

## Pagination
List / gallery / versions return `{items, next_cursor, has_more}`:
```python
cursor = None
while True:
    page = client.list(limit=50, cursor=cursor)
    for item in page["items"]:
        ...
    if not page.get("has_more"):
        break
    cursor = page["next_cursor"]
```

## Config, retries & timeouts
```python
DiagramsClient(api_key, base_url="https://api.diagrams.so/api/v2",
               timeout=450.0, max_retries=3, backoff=0.5,
               retry_delays=(5.0, 15.0, 30.0), retry_budget=600.0)
```
`timeout` defaults to **450s**, above the server-side timeout ladder, so the client
never aborts work the server would still deliver. Reads retry `429`/`503` (honoring
`Retry-After`). AI calls retry `429` the same way and every *ambiguous* failure
(timeout / `502`/`503`/`504` / in-progress) through the same-key idempotent ladder
(`retry_delays` between attempts, capped at `retry_budget` seconds) — a **single** retry
layer, so a busy server is never poked twice. Point `base_url` at
`http://localhost:8000/api/v2` for local development.

## Full method list
`generate` · `generate_stream` · `list` · `get` · `update` · `delete` · `edit` · `fix` · `warnings` · `relayout` · `relayout_status` · `relayout_and_wait` · `export` · `versions` · `get_version` · `revert` · `import_diagram` · `search_gallery` · `fork` · `enhance_prompt` · `clarify_prompt` · `usage` · `usage_history` · `iter_usage_history` · `me` · `meta` — each maps 1:1 to an endpoint.

## License
Apache-2.0 · docs at [diagrams.so/developers](https://diagrams.so/developers)
