# @diagrams-so/sdk — TypeScript SDK

A thin, typed, **zero-dependency** client for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`). Works in Node ≥ 18, browsers, and edge/workers (uses platform `fetch`).

- Covers **all 26** `/api/v2` operations · one method per endpoint · fully typed responses
- Zero deps · single `DiagramsAPIError` with `.code` / `.status` / `.requestId`
- Built-in **retry** on `429`/`503` (honors `Retry-After`), **idempotency keys**, an async-generator **stream**, and a re-layout poll helper

## Install
```bash
npm install @diagrams-so/sdk
```

## Quickstart
```ts
import { DiagramsClient } from "@diagrams-so/sdk";

const client = new DiagramsClient({ apiKey: "dgz_live_…" }); // or dgz_test_… (test mode — bills the same credits)

const d = await client.generate("AWS 3-tier web app: ALB, EC2, RDS", { cloudProvider: "aws" });
console.log(d.id, d.score?.score, d.warnings.length);

const w = await client.warnings(d.id);
if (w.length) await client.fix(d.id, w[0].message, { component: w[0].component ?? undefined, warningType: w[0].type });

const drawio = await client.export(d.id, "drawio"); // native .drawio XML string
```

## Authentication & billing
Pass your key (from the **API Keys** page). `dgz_live_` keys bill credits for `generate`/`edit`/`fix`/`relayout`/`fork`; `dgz_test_` keys are test mode — they bill the same credits (drawing your real balance, like a live key), at lower test rate limits. Reads and `enhancePrompt`/`clarifyPrompt` are free. Check balance with `client.usage()`.

## Errors
```ts
import { DiagramsAPIError } from "@diagrams-so/sdk";
try {
  await client.generate("…");
} catch (e) {
  if (e instanceof DiagramsAPIError) {
    console.log(e.code, e.status, e.requestId); // e.g. QUOTA_EXCEEDED 402 req_abc
  }
}
```

## Idempotency
```ts
await client.generate("…", { idempotencyKey: "order-42" }); // replays the stored result for 24h
```
Supported on `generate`, `generateStream`, `edit`, `fix`.

## Streaming
```ts
for await (const { event, data } of client.generateStream("AWS event-driven pipeline")) {
  if (event === "progress") console.log(data.progress, data.message);
  else if (event === "complete") console.log(data.id, data.usage.credits_charged);
  else if (event === "error") throw new Error(data.error.message);
}
```
(The TS SDK yields `{ event, data }` objects; the Python SDK yields `(event, data)` tuples — each idiomatic to its language.)
The diagram XML arrives only in the terminal `complete` event (after the charge).

## Async re-layout
```ts
let job = await client.relayoutAndWait(d.id);
if ((job as any).status === "confirmation_required") {
  job = await client.relayoutAndWait(d.id, { confirm: true }); // accept the credit charge
}
```

## Pagination
`list` / `searchGallery` / `versions` return `Page<T>` = `{ items, next_cursor, has_more }`:
```ts
let cursor: string | undefined;
do {
  const page = await client.list({ limit: 50, cursor });
  page.items.forEach((item) => { /* … */ });
  cursor = page.next_cursor ?? undefined;
} while (cursor);
```

## Config, retries & timeouts
```ts
new DiagramsClient({ apiKey, baseUrl?, timeoutMs?, maxRetries?, backoffMs? });
```
`baseUrl` defaults to `https://api.diagrams.so/api/v2` (point at `http://localhost:8000/api/v2` for local dev). Only `429`/`503` are retried (pre-charge rejections, so no double-billing); `Retry-After` is honored.

## Full method list
`generate` · `generateStream` · `list` · `get` · `update` · `delete` · `edit` · `fix` · `warnings` · `startRelayout` · `relayoutStatus` · `relayoutAndWait` · `export` · `versions` · `getVersion` · `revert` · `import` · `searchGallery` · `fork` · `enhancePrompt` · `clarifyPrompt` · `usage` · `me` · `meta`

## License
MIT · docs at [developers.diagrams.so](https://developers.diagrams.so)
