# diagrams-so — Python SDK

A thin, typed, **dependency-free** client for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`). Generate, edit, and manage cloud-architecture diagrams (draw.io / SVG) with AI.

- Covers **all 27** `/api/v2` operations · one method per endpoint
- **No hard dependencies** — uses `requests` if installed, else stdlib `urllib`
- Typed, ships `py.typed` · raises a single `DiagramsAPIError` with `code` / `status` / `request_id`
- **Safe billing:** every billable call auto-attaches an `Idempotency-Key` and retries *ambiguous* failures (timeout / 5xx / in-progress) with the **same key**, so a response lost to a gateway timeout is replayed — one charge, never two
- Built-in `429`/`503` backoff (honors `Retry-After`), **SSE streaming**, async **re-layout** helper, and an in-process credit tally (`session_charges`)

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

client = DiagramsClient(api_key="dgz_live_…")   # or dgz_test_… (test mode — bills the same credits)

d = client.generate("AWS 3-tier web app: ALB, EC2, RDS", cloud_provider="aws")
print(d["id"], d["score"]["score"], len(d["warnings"]))

# fix the first Well-Architected warning
w = client.warnings(d["id"])
if w:
    client.fix(d["id"], w[0]["message"], component=w[0].get("component"), warning_type=w[0]["type"])

open("diagram.drawio", "w").write(client.export(d["id"], "drawio"))
```

### Diagram type
`diagram_type` is optional. Leave it out and the SDK does not send it, so the server picks the kind of diagram for your prompt. Pass a value to choose: `diagram_type="architecture"` or `diagram_type="auto"` is sent as given. Up to 1.3.0 the SDK always sent `"architecture"`; to keep that exact behaviour, pass it explicitly. `client.meta("diagram-types")` lists the values the API accepts.

## Authentication & billing
Pass your key (from **Settings → AI Provider** in your account). `dgz_live_` keys bill credits for `generate`/`edit`/`fix`/`relayout`/`fork`; `dgz_test_` keys are test mode — they bill the same credits (drawing your real balance, like a live key), at lower test rate limits. Reads and `enhance`/`clarify` are free. Check balance with `client.usage()`.

## Errors
Every non-2xx raises `DiagramsAPIError`:
```python
from diagrams_so import DiagramsAPIError
try:
    client.generate("…")
except DiagramsAPIError as e:
    print(e.code, e.status, e.request_id)   # e.g. QUOTA_EXCEEDED 402 req_abc
    if e.status == 402:
        ...  # out of credits → send the user to upgrade
```

## Idempotency (safe retries on billable ops)
Every billable call (`generate`, `edit`, `fix`, `relayout`) **auto-attaches a fresh
`Idempotency-Key`** and retries ambiguous failures with that same key, so you never
double-charge on a timeout. Pass your own key to make the safety window explicit or
to dedupe across processes:
```python
client.generate("…", idempotency_key="order-42")   # server replays the stored result for 24h
```
Definite rejections (`401`/`402`/`404`/`422`) are never retried; a call whose outcome
is lost is recorded in `session_charges` as `status="unknown"` — reconcile with
`client.usage_history()`. Streamed generations tally a `confirmed` charge on their
terminal event; an applied re-layout tallies `unknown` (its credits bill
asynchronously — the exact amount is in `usage_history`).

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
The diagram XML arrives only in the terminal `complete` event (after the charge).

## Async re-layout
Re-layout is token-billed on **every** run (no free allowance) and charged only on
delivery of the re-laid diagram. The first call returns `confirmation_required`;
re-call with `confirm=True` to accept the charge:
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
`Retry-After`). Billable calls retry `429` the same way and every *ambiguous* failure
(timeout / `502`/`503`/`504` / in-progress) through the same-key idempotent ladder
(`retry_delays` between attempts, capped at `retry_budget` seconds) — a **single** retry
layer, so a busy server is never poked twice. Point `base_url` at
`http://localhost:8000/api/v2` for local development.

## Full method list
`generate` · `generate_stream` · `list` · `get` · `update` · `delete` · `edit` · `fix` · `warnings` · `relayout` · `relayout_status` · `relayout_and_wait` · `export` · `versions` · `get_version` · `revert` · `import_diagram` · `search_gallery` · `fork` · `enhance_prompt` · `clarify_prompt` · `usage` · `usage_history` · `iter_usage_history` · `me` · `meta` — each maps 1:1 to an endpoint.

## License
Apache-2.0 · docs at [diagrams.so/developers](https://diagrams.so/developers)
