# @diagrams-so/sdk — TypeScript SDK

A thin, typed, **zero-dependency** client for the [Diagrams.so](https://diagrams.so) public API (`/api/v2`). Works in Node ≥ 18, browsers, and edge/workers (uses platform `fetch`).

- Covers **all 27** `/api/v2` operations · one method per endpoint · fully typed responses
- Zero deps · single `DiagramsAPIError` with `.code` / `.status` / `.requestId`
- **Safe retries:** every AI call auto-attaches an `Idempotency-Key` and retries *ambiguous* failures (timeout / 5xx / in-progress) with the **same key**, so a response lost to a gateway timeout is replayed: one diagram, never two
- Built-in `429`/`503` backoff (honors `Retry-After`), async-generator **stream**, re-layout helper, and an in-process task tally (`sessionCharges`)

## Install
```bash
npm install @diagrams-so/sdk
```

Then connect once, with no key to copy:

```ts
import { login, DiagramsClient } from "@diagrams-so/sdk";

await login();                       // a browser opens, press Approve
const client = new DiagramsClient(); // reads the stored credential
```

Prefer a terminal command? `npm i -g @diagrams-so/mcp` then `diagrams-so login`
connects this machine for every Diagrams.so client, including this SDK. For CI,
set `DIAGRAMS_API_KEY`.


## Quickstart
```ts
import { DiagramsClient } from "@diagrams-so/sdk";

const client = new DiagramsClient({ apiKey: "dgz_live_…" }); // or dgz_test_… (test mode: same account, lower rate limits)

const d = await client.generate("AWS 3-tier web app: ALB, EC2, RDS", { cloudProvider: "aws" });
console.log(d.id, d.score?.score, d.warnings.length);

const w = await client.warnings(d.id);
if (w.length) await client.fix(d.id, w[0].message, { component: w[0].component ?? undefined, warningType: w[0].type });

const drawio = await client.export(d.id, "drawio"); // native .drawio XML string
```

### Diagram type
`diagramType` is optional. Leave it out and the SDK does not send it, so the server picks the kind of diagram for your prompt. Pass a value to choose: `diagramType: "architecture"` or `diagramType: "auto"` is sent as given. Up to 1.3.0 the SDK always sent `"architecture"`; to keep that exact behaviour, pass it explicitly. `client.meta("diagram-types")` lists the values the API accepts.

## Authentication & plans
Pass your key (from **Settings → AI Provider**). Every plan has unlimited diagrams and edits; nothing is metered, there is only a per-minute rate limit. Paid adds no watermark and draw.io export; Free diagrams can be private. `dgz_test_` keys are test mode: they work on your real account, like a live key, at lower test rate limits. See your plan with `client.usage()`.

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
Every AI call (`generate`, `edit`, `fix`, `startRelayout`) **auto-attaches a
fresh `Idempotency-Key`** and retries ambiguous failures with that same key, so a
timeout never makes a second diagram. Pass your own key to make the window explicit or to
dedupe across processes:
```ts
await client.generate("…", { idempotencyKey: "order-42" }); // server replays the stored result for 24h
```
Definite rejections (`401`/`402`/`404`/`422`) are never retried; a call whose outcome
is lost is recorded in `client.sessionCharges` as `status:"unknown"` — reconcile with
`client.usageHistory()`. Streamed generations tally a `confirmed` entry on their
terminal event; an applied re-layout tallies `unknown` (the server records it
asynchronously, so check `usageHistory`).

## Streaming
```ts
for await (const { event, data } of client.generateStream("AWS event-driven pipeline")) {
  if (event === "progress") console.log(data.progress, data.message);
  else if (event === "complete") console.log(data.id);
  else if (event === "error") throw new Error(data.error.message);
}
```
(The TS SDK yields `{ event, data }` objects; the Python SDK yields `(event, data)` tuples — each idiomatic to its language.)
The diagram XML arrives only in the terminal `complete` event.

## Async re-layout
Re-layout replaces the current layout, so it asks first. The first call returns
`confirmation_required`; re-call with `confirm:true` to go ahead:
```ts
let job = await client.relayoutAndWait(d.id);
if ((job as any).status === "confirmation_required") { // re-layout always needs confirmation
  job = await client.relayoutAndWait(d.id, { confirm: true }); // go ahead
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
new DiagramsClient({ apiKey, baseUrl?, timeoutMs?, maxRetries?, backoffMs?,
                     retryDelaysMs?, retryBudgetMs? });
```
`timeoutMs` defaults to **450 000** (above the server-side timeout ladder, so the
client never aborts work the server would still deliver). `baseUrl` defaults to
`https://api.diagrams.so/api/v2` (point at `http://localhost:8000/api/v2` for local
dev). Reads retry `429`/`503` (honoring `Retry-After`). Billable calls retry `429` the
same way and every *ambiguous* failure (timeout / `502`/`503`/`504` / in-progress)
through the same-key idempotent ladder (`retryDelaysMs` between attempts, capped at
`retryBudgetMs` total) — a **single** retry layer, so a busy server is never poked twice.

## Full method list
`generate` · `generateStream` · `list` · `get` · `update` · `delete` · `edit` · `fix` · `warnings` · `startRelayout` · `relayoutStatus` · `relayoutAndWait` · `export` · `versions` · `getVersion` · `revert` · `import` · `searchGallery` · `fork` · `enhancePrompt` · `clarifyPrompt` · `usage` · `usageHistory` · `iterUsageHistory` · `me` · `meta`

## License
Apache-2.0 · docs at [diagrams.so/developers](https://diagrams.so/developers)
