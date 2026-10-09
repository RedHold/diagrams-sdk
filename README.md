# Diagrams.so SDKs

[![CI](https://github.com/RedHold/diagrams-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/RedHold/diagrams-sdk/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/diagrams-so?label=pypi%20diagrams-so)](https://pypi.org/project/diagrams-so/)
[![npm](https://img.shields.io/npm/v/%40diagrams-so%2Fsdk?label=npm%20%40diagrams-so%2Fsdk)](https://www.npmjs.com/package/@diagrams-so/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Official **Python** and **TypeScript** SDKs for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`) — generate, edit, and manage cloud-architecture diagrams (draw.io / SVG) with AI.

| SDK | Package | Source |
|---|---|---|
| Python | [`diagrams-so`](https://pypi.org/project/diagrams-so/) | [`python/`](./python) |
| TypeScript | [`@diagrams-so/sdk`](https://www.npmjs.com/package/@diagrams-so/sdk) | [`typescript/`](./typescript) |

Both are thin, typed clients covering **all 27** `/api/v2` operations, with auto same-key idempotent retries on ambiguous failures (a timeout never makes a second diagram), `429`/`503` backoff, SSE streaming, an async re-layout helper, and an in-process task tally.

---

## 📖 How to read this guide

This guide has two kinds of steps. The icon tells you **where** each one goes:

- 🖥️ **Terminal** — a command you **type into your terminal** and press Enter.
  (Terminal app: **macOS** → press ⌘+Space, type "Terminal". **Windows** → Start menu, "PowerShell". **Linux** → your terminal app.)
- 📄 **File** — code you **save into a file**, then run with a terminal command shown right below it.

> **Golden rule:** unless a step says otherwise, run **every** terminal command from **inside the `diagrams-sdk` folder** — the one you download in Step 1. Your terminal prompt should show you're in `.../diagrams-sdk`.

New to terminals? You only ever *copy → paste → Enter*. Nothing here can harm your computer.

---

## Contents

[0. Check you're ready](#0-check-youre-ready) · [1. Get the code & install](#1-get-the-code--install) · [2. Get an API key](#2-get-an-api-key) · [3. Try everything — Python](#3-try-everything--python) · [4. Try everything — TypeScript](#4-try-everything--typescript) · [5. Retry safety](#5-retry-safety-idempotency-retries-tally) · [6. Test locally, offline](#6-test-locally-offline) · [7. Develop & release](#7-develop--release) · [Troubleshooting](#-troubleshooting)

---

## 0. Check you're ready

You need **Python 3.9+** (for the Python SDK) and/or **Node.js 18+** (for the TypeScript SDK). You only need the one(s) you want to try.

🖥️ **Terminal** — check what you have:
```bash
python3 --version      # want 3.9 or higher
node --version         # want v18 or higher
git --version          # any version
```
If any says *"command not found"*, install it: [python.org/downloads](https://www.python.org/downloads/) · [nodejs.org](https://nodejs.org/) · [git-scm.com](https://git-scm.com/). Then re-open your terminal and check again.

> On some systems Python is `python` instead of `python3`. If `python3` isn't found, try `python --version`.

---

## 1. Get the code & install

> The packages aren't on PyPI/npm yet — so for now you install **from this downloaded copy**. (Once published, it'll be a one-line `pip install diagrams-so` / `npm install @diagrams-so/sdk`.)

🖥️ **Terminal** — download the code and enter the folder (do this once, from anywhere, e.g. your home or Desktop):
```bash
git clone https://github.com/RedHold/diagrams-sdk.git
cd diagrams-sdk
```
✅ You are now inside the `diagrams-sdk` folder. **Stay here** for every command below.

**If you want the Python SDK** — 🖥️ Terminal:
```bash
python3 -m venv .venv                 # make an isolated Python environment (once)
source .venv/bin/activate             # turn it on  ·  Windows: .venv\Scripts\activate
python -m pip install --upgrade pip   # old pip can't install a pyproject-only editable package
pip install -e ./python               # install the SDK from this folder
pip install pytest requests           # test tools + faster HTTP (both optional)
```
✅ Your prompt now starts with `(.venv)`. That means the environment is on. **Re-run `source .venv/bin/activate` whenever you open a new terminal.**

**If you want the TypeScript SDK** — 🖥️ Terminal:
```bash
cd typescript && npm install && npm run build && cd ..
```
✅ This builds the SDK into `typescript/dist/`. Re-run `cd typescript && npm run build && cd ..` any time you change TS code.

---

## 2. Get an API key

Create a key on **Settings → AI Provider** in your Diagrams.so account.

- `dgz_test_…` — **use this while trying out.** Test mode: works on your real account, at lower rate limits.
- `dgz_live_…` — production key.
- Every plan has **unlimited diagrams and edits**. Nothing is metered; there is only a per-minute rate limit. Paid adds no watermark and draw.io export; Free diagrams can be private.

🖥️ **Terminal** — tell the SDK your key (do this in the **same** terminal you'll run the scripts in):
```bash
export DIAGRAMS_API_KEY="dgz_test_your_key_here"      # macOS / Linux
```
On **Windows PowerShell** instead:
```powershell
$env:DIAGRAMS_API_KEY="dgz_test_your_key_here"
```
> This lasts only for the current terminal window. Open a new one? Set it again.

**No key yet, or want to try it offline first?** Skip to [Section 6](#6-test-locally-offline). It runs everything against a local fake API.

---

## 3. Try everything — Python

📄 **File** — in the `diagrams-sdk` folder, create a file named **`try_all.py`** and paste this in. It exercises **every** capability.

```python
import os
from diagrams_so import DiagramsClient, DiagramsAPIError

client = DiagramsClient(
    api_key=os.environ["DIAGRAMS_API_KEY"],
    # base_url="http://localhost:8000/api/v2",   # uncomment to use a local API instead of production
    # timeout=450.0,                             # default; above the server timeout ladder
)

# ---- reads & capabilities ----
print("me:", client.me())                         # account, plan, livemode
print("providers:", client.meta("providers"))     # 'diagram-types' | 'providers' | 'formats' | 'features'
print("usage:", client.usage())                   # your plan and usage

# ---- prompt helpers ----
print("enhanced:", client.enhance_prompt("aws web app", cloud_provider="aws"))
print("clarify:", client.clarify_prompt("a system with a database"))

# ---- generate (auto-idempotent) ----
# diagram_type is optional: leave it out and the server picks the type.
# "architecture" was the SDK default up to 1.3.0; pass it to keep that.
try:
    d = client.generate("AWS 3-tier web app: ALB, EC2 auto-scaling, RDS Multi-AZ",
                         cloud_provider="aws", diagram_type="architecture")
except DiagramsAPIError as e:
    print(e.code, e.status, e.request_id)          # e.g. QUOTA_EXCEEDED 402 req_abc
    raise
did = d["id"]
print("generated", did, "| score", d["score"]["score"])

# ---- warnings + fix ----
# Fix ONLY the warnings you care about, one at a time. Each client.fix() is its
# own AI call and makes a new version, so do not loop-fix every warning; this is
# exactly how the site/MCP work.
warnings = client.warnings(did)
if warnings:
    w = warnings[0]                    # fix just the first (most important) one
    client.fix(did, w["message"], component=w.get("component"), warning_type=w["type"])

# ---- edit ----
client.edit(did, "add a CloudFront CDN in front of the ALB")

# ---- export -> files ----
open("diagram.drawio", "w").write(client.export(did, "drawio"))
open("diagram.svg", "w").write(client.export(did, "svg"))

# ---- versions + revert ----
versions = client.versions(did, limit=10)
print("versions:", len(versions["items"]))
# client.revert(did, version_number=1)             # roll back to a prior version

# ---- async AI re-layout (confirm required) ----
job = client.relayout_and_wait(did)                # starts + polls to completion
if job.get("status") == "confirmation_required":
    job = client.relayout_and_wait(did, confirm=True)
print("relayout:", job.get("status"), "applied:", job.get("applied"))

# ---- streaming generate ----
for event, data in client.generate_stream("event-driven order pipeline on AWS"):
    if event == "progress":
        print("  ", data["progress"], data["message"])
    elif event == "complete":
        print("streamed:", data["id"])
    elif event == "error":
        raise RuntimeError(data["error"]["message"])

# ---- import your own draw.io XML ----
mine = client.import_diagram("<mxGraphModel><root/></mxGraphModel>", title="hand-made")
print("imported:", mine["id"])

# ---- gallery (search + fork) ----
gallery = client.search_gallery(q="kubernetes", limit=5)
print("gallery hits:", len(gallery["items"]))
# forked = client.fork(gallery["items"][0]["id"])

# ---- list your diagrams (paginated) ----
page = client.list(limit=20)
print("your diagrams (page 1):", len(page["items"]))

# ---- usage history: the durable task record ----
hist = client.usage_history(limit=10)              # filters: action=, source=, since=, until=
for item in hist["items"]:
    print("  ", item["action_type"], item.get("source"))
print("total tasks:", hist["summary"]["task_count"])
# for item in client.iter_usage_history(action=["generate"]): ...   # auto-paginate

# ---- what THIS run did (in-process tally) ----
for s in client.session_charges:
    print("  tally:", s["status"], s["action"])

# ---- cleanup ----
# client.delete(did)
```

▶️ **Run it** — 🖥️ Terminal (from `diagrams-sdk`, with `(.venv)` on and your key set):
```bash
python try_all.py
```
✅ **Success looks like:** a stream of `me: …`, `generated dgm_… | score …`, `relayout: done …`, `streamed: …`, `total tasks: …`. It also writes `diagram.drawio` and `diagram.svg` into the folder — open `diagram.drawio` at [app.diagrams.net](https://app.diagrams.net).

---

## 4. Try everything — TypeScript

📄 **File** — in the `diagrams-sdk` folder, create **`try_all.mjs`** and paste this in.

```ts
import { DiagramsClient, DiagramsAPIError } from "./typescript/dist/index.js";
// after the package is published, use instead:
// import { DiagramsClient, DiagramsAPIError } from "@diagrams-so/sdk";
import { writeFileSync } from "node:fs";

const client = new DiagramsClient({
  apiKey: process.env.DIAGRAMS_API_KEY,
  // baseUrl: "http://localhost:8000/api/v2",   // uncomment to use a local API instead of production
  // timeoutMs: 450_000,                         // default; above the server timeout ladder
});

// ---- reads & capabilities ----
console.log("me:", await client.me());
console.log("providers:", await client.meta("providers")); // 'diagram-types'|'providers'|'formats'|'features'
console.log("usage:", await client.usage());

// ---- prompt helpers ----
console.log("enhanced:", await client.enhancePrompt("aws web app", { cloudProvider: "aws" }));
console.log("clarify:", await client.clarifyPrompt("a system with a database"));

// ---- generate (auto-idempotent) ----
// diagramType is optional: leave it out and the server picks the type.
// "architecture" was the SDK default up to 1.3.0; pass it to keep that.
let d;
try {
  d = await client.generate("AWS 3-tier web app: ALB, EC2 auto-scaling, RDS Multi-AZ",
                             { cloudProvider: "aws", diagramType: "architecture" });
} catch (e) {
  if (e instanceof DiagramsAPIError) console.log(e.code, e.status, e.requestId);
  throw e;
}
const id = d.id;
console.log("generated", id, "| score", d.score?.score);

// ---- warnings + fix ----
// Fix ONLY the warnings you care about, one at a time. Each fix() is its own AI
// call and makes a new version, so do not loop-fix every warning; this mirrors
// how the site/MCP work.
const warnings = await client.warnings(id);
if (warnings.length) {
  const w = warnings[0];
  await client.fix(id, w.message, { component: w.component ?? undefined, warningType: w.type });
}

// ---- edit ----
await client.edit(id, "add a CloudFront CDN in front of the ALB");

// ---- export -> files ----
writeFileSync("diagram.drawio", await client.export(id, "drawio"));
writeFileSync("diagram.svg", await client.export(id, "svg"));

// ---- versions + revert ----
const versions = await client.versions(id, { limit: 10 });
console.log("versions:", versions.items.length);
// await client.revert(id, { versionNumber: 1 });

// ---- async AI re-layout (confirm required) ----
let job = await client.relayoutAndWait(id);
if (job.status === "confirmation_required") {
  job = await client.relayoutAndWait(id, { confirm: true });
}
console.log("relayout:", job.status, "applied:", job.applied);

// ---- streaming generate ----
for await (const { event, data } of client.generateStream("event-driven order pipeline on AWS")) {
  if (event === "progress") console.log("  ", data.progress, data.message);
  else if (event === "complete") console.log("streamed:", data.id);
  else if (event === "error") throw new Error(data.error.message);
}

// ---- import your own draw.io XML ----
const mine = await client.import("<mxGraphModel><root/></mxGraphModel>", { title: "hand-made" });
console.log("imported:", mine.id);

// ---- gallery (search + fork) ----
const gallery = await client.searchGallery({ q: "kubernetes", limit: 5 });
console.log("gallery hits:", gallery.items.length);
// const forked = await client.fork(gallery.items[0].id);

// ---- list your diagrams (paginated) ----
const page = await client.list({ limit: 20 });
console.log("your diagrams (page 1):", page.items.length);

// ---- usage history: the durable task record ----
const hist = await client.usageHistory({ limit: 10 }); // filters: action, source, since, until
for (const item of hist.items) console.log("  ", item.action_type, item.source);
console.log("total tasks:", hist.summary.task_count);
// for await (const item of client.iterUsageHistory({ action: ["generate"] })) { ... }

// ---- what THIS run did (in-process tally) ----
for (const s of client.sessionCharges) console.log("  tally:", s.status, s.action);

// ---- cleanup ----
// await client.delete(id);
```

▶️ **Run it** — 🖥️ Terminal (from `diagrams-sdk`; make sure you built the SDK in Step 1 and your key is set):
```bash
node try_all.mjs
```
✅ **Success looks like** the same flow as Python, ending in `total tasks: …`, and writing `diagram.drawio` / `diagram.svg`.

> The `import … "./typescript/dist/index.js"` path is why you run from the `diagrams-sdk` folder — it points at the SDK you built in Step 1.

---

## 5. Retry safety (idempotency, retries, tally)

Every AI call (`generate` / `edit` / `fix` / `relayout`) **auto-attaches a fresh `Idempotency-Key`** and retries *ambiguous* failures (timeout, `502`/`503`/`504`, idempotency-in-progress) with the **same key** — so a response lost to a gateway timeout is replayed by the server: **one diagram, never two**. Definite rejections (`401`/`402`/`404`/`422`) are never retried. You don't have to do anything to get this — it's on by default.

📄 Add to either `try_all` file to see it (Python shown; TS is the same with `idempotencyKey` / `sessionCharges` / `usageHistory`):
```python
# pass your own key to make the 24h replay window explicit / dedupe across processes
client.generate("monthly report", idempotency_key="report-2026-08")

# a call whose outcome is lost is tallied as "unknown" (it may still have run on the server);
# the server ledger is authoritative — reconcile:
for s in client.session_charges:
    if s["status"] == "unknown":
        print("verify:", client.usage_history(limit=5)["items"])
```

Tuning (defaults shown — pass these to the constructor):
```python
DiagramsClient(api_key, timeout=450.0, max_retries=3, backoff=0.5,
               retry_delays=(5.0, 15.0, 30.0), retry_budget=600.0)
```
```ts
new DiagramsClient({ apiKey, timeoutMs: 450_000, maxRetries: 3, backoffMs: 500,
                     retryDelaysMs: [5_000, 15_000, 30_000], retryBudgetMs: 600_000 });
```

---

## 6. Test locally, offline

Want to see *all* the safety behaviour — idempotency replay, retries, the honest tally, streaming, the re-layout confirm flow — **without a key?** A tiny fake API is bundled. This needs **two terminals** (one to run the fake server, one to run the tests).

**Terminal 1** 🖥️ — start the fake API (from `diagrams-sdk`, with `(.venv)` on). Leave it running:
```bash
python local-test/stub_api.py
```
✅ It prints `stub API on http://127.0.0.1:8899/api/v2`. Keep this window open.

**Open a second terminal** (macOS Terminal: ⌘+N · VS Code: `+` in the terminal panel), then 🖥️ from `diagrams-sdk` (turn the venv on again with `source .venv/bin/activate`):
```bash
python local-test/it_python.py                    # Python SDK  ->  28 passed
cd typescript && npm run build && cd ..            # (if not already built)
node local-test/it_typescript.mjs                 # TypeScript SDK -> 28 passed
```
✅ Each prints `28 passed, 0 failed`. When done, go to **Terminal 1** and press **Ctrl-C** to stop the fake server.

Peek at the fake server's own task ledger any time — 🖥️ (second terminal):
```bash
curl -s http://127.0.0.1:8899/__debug | python3 -m json.tool
```

**Unit tests** (no server needed) — 🖥️ from `diagrams-sdk`:
```bash
cd python && pytest -q && cd ..                     # 17 passed
cd typescript && npm run build && npm test && cd ..  # 13 pass
```

Full step-by-step with expected counts and an optional live smoke: **[`TESTING.md`](./TESTING.md)**.

---

## 7. Develop & release

🖥️ From `diagrams-sdk`:
```bash
# Python
cd python && pip install -e . && pytest -q && cd ..

# TypeScript
cd typescript && npm install && npm run build && npm test && cd ..
```

Tests include a **drift-guard** that asserts each SDK covers exactly the operations in [`spec/openapi-v2.json`](./spec/openapi-v2.json). When the API changes, run [`scripts/sync-spec.sh`](./scripts/sync-spec.sh) to re-vendor the spec — the tests then flag anything the SDKs are missing. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the coverage contract and conventions.

**Releasing** — CI publishes on a version tag **if** the registry token secret is set:
- `sdk-py-vX.Y.Z` → PyPI (needs `PYPI_TOKEN`)
- `sdk-ts-vX.Y.Z` → npm (needs `NPM_TOKEN`)

Per-language docs: [`python/README.md`](./python/README.md) · [`typescript/README.md`](./typescript/README.md). Runnable demos: [`examples/`](./examples).

---

## 🛟 Troubleshooting

| You see… | Fix |
|---|---|
| `command not found: python3` | Install Python (or try `python` instead of `python3`). See [Step 0](#0-check-youre-ready). |
| `command not found: node` / `npm` | Install Node.js 18+ from [nodejs.org](https://nodejs.org/), re-open the terminal. |
| `ModuleNotFoundError: No module named 'diagrams_so'` | The venv isn't on or the SDK isn't installed. Run `source .venv/bin/activate` then `pip install -e ./python` from `diagrams-sdk`. |
| `KeyError: 'DIAGRAMS_API_KEY'` (Python) / `apiKey is required` (TS) | You didn't set the key in **this** terminal. Redo [Step 2](#2-get-an-api-key). |
| `Cannot find module './typescript/dist/index.js'` | Run `node try_all.mjs` from the **`diagrams-sdk`** folder, and build first: `cd typescript && npm run build && cd ..`. |
| `[QUOTA_EXCEEDED] (HTTP 402)` | The task needs the Paid plan (no watermark, draw.io export). Upgrade, or try it offline with [Section 6](#6-test-locally-offline). |
| `Address already in use` on the fake API | Another copy is running, or pick a new port: `PORT=8901 python local-test/stub_api.py` (and pass `BASE=http://127.0.0.1:8901/api/v2` to the test scripts). |
| Prompt lost the `(.venv)` after opening a new terminal | Run `source .venv/bin/activate` again (Windows: `.venv\Scripts\activate`). |

## License and legal

- **Code:** [Apache-2.0](./LICENSE). See [NOTICE](./NOTICE). Each package ships its license and notice files.
- **Service:** the SDKs are clients for the Diagrams.so API. Use of the API is governed by the [Terms of Service](https://diagrams.so/policy/terms) and [Acceptable Use Policy](https://diagrams.so/policy/acceptable-use); the code license grants no rights to the API itself.
- **Plans:** every plan has unlimited diagrams and edits, with a per-minute rate limit. Paid adds no watermark and draw.io export; Free diagrams can be private. Test-mode keys act on your real account; there is no separate sandbox. The offline stub in `local-test/` needs no account.
- **Trademarks:** Diagrams.so and the Diagrams.so logo are trademarks of RedHold LLC. This license does not grant permission to use them, except to accurately describe the package's origin. See the [Trademark Policy](https://diagrams.so/policy/trademark).
- **Security:** report vulnerabilities to security@diagrams.so per [SECURITY.md](./SECURITY.md).
- Docs: [diagrams.so/developers](https://diagrams.so/developers)
