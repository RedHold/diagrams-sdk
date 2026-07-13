# Contributing

Thanks for helping improve the Diagrams.so SDKs. This repo holds two thin clients
over the public API (`/api/v2`): the Python package `diagrams-so` and the TypeScript
package `@diagrams-so/sdk`.

## Repo layout
```
python/        diagrams-so           (stdlib-only; ships py.typed)
typescript/    @diagrams-so/sdk      (ESM; zero deps; uses platform fetch)
examples/      runnable demos (try_local.py / try_local.mjs)
spec/          vendored openapi-v2.json — the source of truth for coverage
scripts/       sync-spec.sh — re-vendor the spec from a running API
```

## Dev setup & tests

**Python** (no runtime deps; needs `pytest` to test):
```bash
cd python
pip install -e . pytest
pytest -q
```

**TypeScript** (Node ≥ 18):
```bash
cd typescript
npm install
npm run build
npm test          # node --test
```

## The coverage contract (important)
Both test suites include a **drift-guard** that asserts each SDK exposes exactly the
operations in `spec/openapi-v2.json`. If you add or change an endpoint in the API:

1. Refresh the vendored spec:
   ```bash
   BASE=https://api.diagrams.so ./scripts/sync-spec.sh
   ```
2. Run the tests. The drift-guard will fail and name any operation the SDKs don't
   cover yet.
3. Add the matching method(s) to **both** clients and update the `COVERED` set in
   `python/tests/test_coverage.py` and `typescript/test/client.test.mjs`.
4. Bump the version + add a `CHANGELOG.md` entry.

Keep the two clients at parity — every method should exist in both languages, named
idiomatically (snake_case in Python, camelCase in TS).

## Conventions
- **Retries:** only `429`/`503` are retried (pre-charge rejections); never retry other
  errors — a billable POST must not be silently re-sent.
- **Errors:** all non-2xx raise/throw `DiagramsAPIError` carrying `code`, `status`,
  `request_id`. Don't leak raw response text when the house envelope is present.
- **No new runtime dependencies** without discussion — both packages are intentionally
  dependency-free.
- Match the surrounding style; keep methods a 1:1 mapping to endpoints.

## Releasing
CI publishes on a version tag **only if** the registry token secret is present:

| Tag | Publishes | Needs secret |
|---|---|---|
| `sdk-py-vX.Y.Z` | `diagrams-so` → PyPI | `PYPI_TOKEN` |
| `sdk-ts-vX.Y.Z` | `@diagrams-so/sdk` → npm | `NPM_TOKEN` |

Steps: bump the version (`python/pyproject.toml`, `typescript/package.json`), update
`CHANGELOG.md`, merge to `main` (CI green), then push the tag(s). Follow semver.

## Reporting issues
Open an issue at https://github.com/RedHold/diagrams-sdk/issues with the SDK + version,
a minimal repro, and the `request_id` from any `DiagramsAPIError` (it lets us trace the
call server-side).
