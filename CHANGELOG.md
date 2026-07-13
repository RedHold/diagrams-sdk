# Changelog

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
