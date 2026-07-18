# diagrams-so — Python SDK

A thin, typed, **dependency-free** client for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`). Generate, edit, and manage cloud-architecture diagrams (draw.io / SVG) with AI.

- Covers **all 26** `/api/v2` operations · one method per endpoint
- **No hard dependencies** — uses `requests` if installed, else stdlib `urllib`
- Typed, ships `py.typed` · raises a single `DiagramsAPIError` with `code` / `status` / `request_id`
- Built-in **retry** on `429`/`503` (honors `Retry-After`), **idempotency keys**, **SSE streaming**, and an async **re-layout** poll helper

## Install
```bash
pip install diagrams-so
```
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

## Authentication & billing
Pass your key (from the **API Keys** page in your account). `dgz_live_` keys bill credits for `generate`/`edit`/`fix`/`relayout`/`fork`; `dgz_test_` keys are test mode — they bill the same credits (drawing your real balance, like a live key), at lower test rate limits. Reads and `enhance`/`clarify` are free. Check balance with `client.usage()`.

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
```python
client.generate("…", idempotency_key="order-42")   # replays the stored result for 24h
```
Supported on `generate`, `generate_stream`, `edit`, `fix`.

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
```python
job = client.relayout_and_wait(d["id"])           # starts + polls to completion
if job.get("status") == "confirmation_required":  # free tier exhausted
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
               timeout=120.0, max_retries=3, backoff=0.5)
```
Only `429`/`503` are retried (rate-limit / backpressure are pre-charge rejections, so a retry never double-bills); `Retry-After` is honored. Point `base_url` at `http://localhost:8000/api/v2` for local development.

## Full method list
`generate` · `generate_stream` · `list` · `get` · `update` · `delete` · `edit` · `fix` · `warnings` · `relayout` · `relayout_status` · `relayout_and_wait` · `export` · `versions` · `get_version` · `revert` · `import_diagram` · `search_gallery` · `fork` · `enhance_prompt` · `clarify_prompt` · `usage` · `me` · `meta` — each maps 1:1 to an endpoint.

## License
MIT · docs at [developers.diagrams.so](https://developers.diagrams.so)
