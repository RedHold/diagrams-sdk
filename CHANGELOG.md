# Changelog

## [1.4.0] - 2026-10
`diagram_type` is now optional and left out of the request when not given, in
both SDKs.

- **`generate` / `generate_stream`** (Python) and **`generate` / `generateStream`**
  (TS): `diagram_type` / `diagramType` defaults to `None` / `undefined` and the key
  is not sent. The server then picks the kind of diagram. An explicit value,
  including `"architecture"` and `"auto"`, is sent as given.
- **`import_diagram`** / **`import`**: same rule. Left out, the server default
  applies (`"architecture"` today).
- **Behaviour is unchanged until the API turns automatic pick on.** While the
  server setting `API_DEFAULT_DIAGRAM_TYPE_AUTO` is off (the default), a request
  with no type still gets `"architecture"`, exactly as before. Once it is on, a
  request with no type is treated as `"auto"`.
- Up to 1.3.0 the SDKs always sent `"architecture"`. Pass it explicitly to keep
  that type after the server setting changes.
- **Unlimited diagrams and edits on every plan.** READMEs, docstrings, examples
  and the `login` test-key notice no longer talk about a balance or a cost per
  task. The examples stop printing the `usage` numbers. Field and key names
  (`credits_charged`, `credits_remaining`, `total_credits_charged`, and the
  `session_charges` / `sessionCharges` entries) are unchanged so existing code
  keeps working; `credits_remaining` is always -1 now. The README section
  "Test locally, offline" replaces the old section 6 title, and its links are
  updated.

## [1.2.0] — 2026-08
Device-flow login (RFC 8628) — both SDKs, zero new runtime dependencies.

- **`login()`** (`diagrams_so.login()` / `login()` in TS): starts the OAuth device
  flow, prints the one-time code + verification URL, opens the browser
  (best-effort), polls honoring the server `interval` and `slow_down` (+5s), and
  returns a ready client. `test=True` mints a test-mode key (test keys charge the
  same credits as live — not a free sandbox). Clear errors on denial, expiry, and
  the 25-active-key limit.
- **Shared credential cache** at `~/.diagrams-so/credentials.json` (identical v1
  JSON contract across Python and TS), written atomically with dir `0700` / file
  `0600`. **Client credential resolution**: explicit `api_key` > `DIAGRAMS_API_KEY`
  env > cache (ignored if malformed, wrong version, or minted for a different
  `base_url`); otherwise: "Not connected — call login() or set DIAGRAMS_API_KEY."
- **`logout()`** deletes the cache (idempotent).
- **`DiagramsAPIError.upgrade_url`** / **`.upgradeUrl`**: the upgrade link from a
  402 `QUOTA_EXCEEDED` payload, else `None`/`undefined`.
- Spec/drift-guard: the 5 new `/oauth/device/*` operations are tracked; the SDKs
  cover `code` + `token`, while the consent endpoints (`info`/`approve`/`deny`)
  are web-only and explicitly excluded.

## [1.1.0] — 2026-08
Billing-integrity hardening, aligned with the API's 2026-08 audit remediation
(app-core #782) and the MCP client (diagrams-mcp-app-core #5).

- **Idempotent billable calls.** `generate` / `edit` / `fix` / `relayout` now
  auto-attach a fresh `Idempotency-Key` and retry *ambiguous* failures (timeout,
  502/503/504, idempotency-in-progress) with the **same key** — a response lost to a
  gateway timeout is replayed by the server, so there is one charge, never two.
  Definite rejections (401/402/404/422) are never retried. Bounded by `retry_delays`
  / `retry_budget` (Python) and `retryDelaysMs` / `retryBudgetMs` (TS). Billable `5xx`
  retries go through this single idempotent ladder (`429` still honors `Retry-After`
  via the inner loop), so a transient error is never retried by two layers; reads keep
  retrying `429`/`503`.
- **Honest session tally.** `session_charges` / `sessionCharges` entries carry a
  `status` of `"confirmed"` or `"unknown"`; a call whose outcome is lost is recorded
  as `unknown` (may still have been charged) rather than silently dropped. The server
  ledger (`usage_history`) is authoritative. **Every billable surface now feeds the
  tally**: streamed generations record a `confirmed` charge on their terminal event,
  and an applied chargeable re-layout records an `unknown` entry (its credits bill
  asynchronously and live only in `usage_history`) — using the server's `chargeable`
  verdict, matching the MCP client.
- **Timeout ladder.** Default request timeout raised 120s → **450s**, above the
  server-side ladder (gunicorn 300 < nginx 330 < ALB 360), so the client never aborts
  work the server would still deliver. Transport timeouts / connection failures now
  surface as typed `TIMEOUT` / `CONNECTION_ERROR` errors.
- **Re-layout is token-billed on every run** (no free allowance) and charged only on
  delivery — docs/examples updated; `confirm=true` required to accept the charge. The
  API echoes `chargeable` on start; the SDK uses it to tally honestly.
- `/usage` `cost_estimates` now covers **generate / edit / fix / relayout** at the
  true tiered **0.5–3.0** range (fractional credits like `0.5` are real) — surfaced
  as-is. Well-Architected `score` excludes `type == "suggestion"` warnings; the SDK
  returns warnings (including `suggestion`) and the score verbatim.
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
