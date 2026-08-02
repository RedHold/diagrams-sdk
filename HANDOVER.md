# Handover — Diagrams.so SDKs v1.1.0

**Status:** ready for review → merge → release. CI is green. This document is everything the team needs to take it live.

## What this is
Official **Python** (`diagrams-so`) and **TypeScript** (`@diagrams-so/sdk`) SDKs over the public `/api/v2` (all 27 operations, one method per endpoint). This release aligns both SDKs with the 2026-08 API billing contract (app-core #782) and the MCP client (diagrams-mcp-app-core #5).

- **PR:** `RedHold/diagrams-sdk` #1 — branch `fix/audit-findings` → `main` (Closes Issue #2)
- **Version:** 1.1.0 (`pyproject.toml`, `package.json`, `package-lock.json` — all in sync)

## What's in v1.1.0
- **Idempotent billable calls** — `generate/edit/fix/relayout` auto-attach an `Idempotency-Key` and retry only *ambiguous* failures (timeout/5xx/in-progress) with the same key → one charge, never two on a gateway timeout. Definite rejections (401/402/404/422) never retry.
- **Honest tally** (`session_charges`/`sessionCharges`): `confirmed` vs `unknown`; streamed generate → confirmed, applied chargeable re-layout → unknown (credits bill async). `usage_history` is authoritative.
- **450s timeout** (above the server ladder); typed `TIMEOUT`/`CONNECTION_ERROR`.
- **Re-layout** token-billed per run, `confirm=true`, charged on delivery.
- Spec re-synced to **27 ops**; single-retry-layer for billable 5xx (no double-retry).

## Verified (all local, 0 credits unless noted)
| Suite | Result |
|---|---|
| Python unit (`pytest -q`) | 17 passed |
| TypeScript unit (`npm test`) | 13 pass |
| Python integration (stub) | 30 passed |
| TypeScript integration (stub) | 30 passed |
| Python edge-case audit | 46 passed |
| TypeScript edge-case audit | 46 passed |
| Packaging | `twine check` PASSED x2 · `npm pack` 6 files |
| Fresh-clone dry run | every command matched the guide |
| CI (PR #1) | python 3.9/3.12 + TypeScript 18/20 all green |

A separate **live-API audit** (2026-08-02) exercised every billable + free operation against production and confirmed the billing-safety behaviour in practice (a 502 was retried with the same key and **not** charged; no double-charges in the ledger).

## Audit outcome — no SDK defects
The audit found **no real problem in the SDK code**. The only genuinely actionable items were:
1. Two guide examples taught an expensive pattern (fix-all-warnings loop + an error demo that billed) — **fixed** (fix selectively; free error example).
2. `npm test` script forward-compat + a `pip install --upgrade pip` note — **fixed**.
3. **A test API key was leaked (pasted/hardcoded) — must be rotated.** (Team action below.)

Everything else in the audit (package-lock sync, `npm ci`, pytest import, the 502 "crash") was verified as a non-issue or already fine.

## How to go live
1. **Review + merge PR #1 → `main`.** (Auto-closes Issue #2.)
2. **Add repo secrets** (Settings → Secrets → Actions): `PYPI_TOKEN`, `NPM_TOKEN`. *(Without them, tagging is a safe no-op.)*
   - Needs a PyPI account for `diagrams-so` and an npm account with `@diagrams-so` scope. The first tag-push **claims the names**.
3. **Tag to publish** (on the merged `main` commit):
   ```bash
   git tag sdk-py-v1.1.0 && git push origin sdk-py-v1.1.0   # -> PyPI
   git tag sdk-ts-v1.1.0 && git push origin sdk-ts-v1.1.0   # -> npm
   ```
4. **Verify:** `pip install diagrams-so==1.1.0` · `npm i @diagrams-so/sdk@1.1.0`.

## Team actions
- **Rotate the leaked test API key** in the dashboard (it was hardcoded in a local `try_sdk.py` and pasted into a chat).
- Delete any local `try_sdk.py` with a hardcoded key (now git-ignored).

## Credit model (so testing doesn't surprise anyone)
- **Free:** all reads, prompt helpers (`enhance`/`clarify`), export, gallery search, usage/history, me/meta.
- **Billable (0.5–3.0 credits each, tiered by tokens):** `generate`, `edit`, `fix`, `relayout`, `fork`. One call = one charge.
- **Test everything for 0 credits offline** (`local-test/` stub). Spend credits only on the specific AI ops you need. Fix warnings **selectively** — never loop-fix all of them.
- Full run-and-test walkthrough: `README.md` and `TESTING.md`. A companion PDF (clone → endpoints → real credit usage) is available locally.
