# Changelog

## [1.1.0] — 2026-08
Billing-integrity hardening, aligned with the API's 2026-08 audit remediation
(app-core #782) and the MCP client (diagrams-mcp-app-core #5).

- **Idempotent billable calls.** `generate` / `edit` / `fix` / `relayout` now
  auto-attach a fresh `Idempotency-Key` and retry *ambiguous* failures (timeout,
  502/503/504, idempotency-in-progress) with the **same key** — a response lost to a
  gateway timeout is replayed by the server, so there is one charge, never two.
  Definite rejections (401/402/404/422) are never retried. Bounded by `retry_delays`
  / `retry_budget` (Python) and `retryDelaysMs` / `retryBudgetMs` (TS).
- **Honest session tally.** `session_charges` / `sessionCharges` entries carry a
  `status` of `"confirmed"` or `"unknown"`; a call whose outcome is lost is recorded
  as `unknown` (may still have been charged) rather than silently dropped. The server
  ledger (`usage_history`) is authoritative.
- **Timeout ladder.** Default request timeout raised 120s → **450s**, above the
  server-side ladder (gunicorn 300 < nginx 330 < ALB 360), so the client never aborts
  work the server would still deliver. Transport timeouts / connection failures now
  surface as typed `TIMEOUT` / `CONNECTION_ERROR` errors.
- **Re-layout is token-billed on every run** (no free allowance) and charged only on
  delivery — docs/examples updated; `confirm=true` required to accept the charge.
- Vendored spec re-synced to **27 operations** (adds `GET /usage/history`, which the
  client already exposes via `usage_history` / `iter_usage_history`); drift-guards
  updated to match.

## [1.0.0] — 2026-07
Initial release of the Python (`diagrams-so`) and TypeScript (`@diagrams-so/sdk`) SDKs.

- Cover all 26 `/api/v2` operations (verified by a drift-guard against `spec/openapi-v2.json`).
- Retry/backoff on 429/503 (honors `Retry-After`); idempotency keys on generate/edit/fix/stream.
- SSE streaming; async re-layout poll helper; single typed `DiagramsAPIError`.
- Python ships `py.typed`; TypeScript ships ESM + type defs.

### Keeping the spec in sync
`spec/openapi-v2.json` is vendored. When the API changes, run `scripts/sync-spec.sh`
(fetches `/api/v2/openapi.json`) and commit — the drift-guard tests then flag any
operation the SDKs don't cover.
