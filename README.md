# Diagrams.so SDKs

Official **Python** and **TypeScript** SDKs for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`) — generate, edit, and manage cloud-architecture diagrams (draw.io / SVG) with AI.

| SDK | Package | Source |
|---|---|---|
| Python | [`diagrams-so`](https://pypi.org/project/diagrams-so/) | [`python/`](./python) |
| TypeScript | [`@diagrams-so/sdk`](https://www.npmjs.com/package/@diagrams-so/sdk) | [`typescript/`](./typescript) |

Both are thin, typed clients covering **all 26** `/api/v2` operations, with retry/backoff, idempotency keys, SSE streaming, and an async re-layout helper.

## Quickstart

**Python** (stdlib-only — no hard deps):
```python
from diagrams_so import DiagramsClient
c = DiagramsClient(api_key="dgz_live_…")
d = c.generate("AWS 3-tier web app: ALB, EC2, RDS", cloud_provider="aws")
open("diagram.drawio", "w").write(c.export(d["id"], "drawio"))
```

**TypeScript** (Node ≥ 18, browsers, edge):
```ts
import { DiagramsClient } from "@diagrams-so/sdk";
const c = new DiagramsClient({ apiKey: "dgz_live_…" });
const d = await c.generate("AWS 3-tier web app: ALB, EC2, RDS", { cloudProvider: "aws" });
```

See [`python/README.md`](./python/README.md) and [`typescript/README.md`](./typescript/README.md) for the full API (auth, errors, streaming, idempotency, pagination), and [`examples/`](./examples) for runnable demos.

## Get a key
Create an API key from the **API Keys** page in your Diagrams.so account. `dgz_live_` keys bill credits for generate/edit/fix/relayout/fork; `dgz_test_` keys are a no-bill sandbox. Reads and prompt helpers are free.

## Develop

```bash
# Python
cd python && pip install -e . && pytest -q

# TypeScript
cd typescript && npm install && npm run build && npm test
```

Tests include a **drift-guard** that asserts each SDK covers exactly the operations in [`spec/openapi-v2.json`](./spec/openapi-v2.json). When the API changes, run [`scripts/sync-spec.sh`](./scripts/sync-spec.sh) to re-vendor the spec — the tests then flag anything the SDKs are missing.

## Releasing
CI publishes on a version tag **if** the registry token secret is set:
- `sdk-py-vX.Y.Z` → PyPI (needs `PYPI_TOKEN`)
- `sdk-ts-vX.Y.Z` → npm (needs `NPM_TOKEN`)

## License
[MIT](./LICENSE) · docs at [developers.diagrams.so](https://developers.diagrams.so)
