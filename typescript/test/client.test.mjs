// Behavioural tests for the TS SDK — runs against the built dist/ with a mocked
// global fetch. Run: npm run build && npm test  (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { DiagramsClient, DiagramsAPIError } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function mockFetch(sequence) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return {
      ok: r.status < 400,
      status: r.status,
      headers: new Map(Object.entries(r.headers ?? {})),
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  return calls;
}

test("requires an apiKey", () => {
  assert.throws(() => new DiagramsClient({ apiKey: "" }));
});

test("generate posts body + Idempotency-Key header", async () => {
  const calls = mockFetch([{ status: 200, body: { id: "d1" } }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  const out = await c.generate("hi", { cloudProvider: "aws", idempotencyKey: "k1" });
  assert.equal(out.id, "d1");
  const { url, init } = calls[0];
  assert.ok(url.endsWith("/diagrams"));
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Idempotency-Key"], "k1");
  assert.equal(JSON.parse(init.body).prompt, "hi");
  assert.equal(JSON.parse(init.body).cloud_provider, "aws");
});

test("error envelope throws a typed DiagramsAPIError", async () => {
  mockFetch([{ status: 402, body: { error: { code: "QUOTA_EXCEEDED", message: "x", request_id: "req_1" } } }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  await assert.rejects(
    () => c.generate("hi"),
    (e) => e instanceof DiagramsAPIError && e.status === 402 && e.code === "QUOTA_EXCEEDED" && e.requestId === "req_1",
  );
});

test("retries on 429 then succeeds", async () => {
  const calls = mockFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { error: { code: "RATE_LIMITED" } } },
    { status: 200, body: { id: "d2" } },
  ]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x", maxRetries: 2, backoffMs: 1 });
  const out = await c.generate("hi");
  assert.equal(out.id, "d2");
  assert.equal(calls.length, 2);
});

test("does not retry on 4xx other than 429", async () => {
  const calls = mockFetch([{ status: 400, body: { error: { code: "VALIDATION_ERROR" } } }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x", maxRetries: 3 });
  await assert.rejects(() => c.generate("hi"), DiagramsAPIError);
  assert.equal(calls.length, 1);
});

// Drift guard: SDK coverage must equal the live OpenAPI spec.
const SPEC = resolve(__dirname, "../../spec/openapi-v2.json");
const COVERED = new Set([
  "GET /api/v2/usage/history",
  "POST /api/v2/diagrams", "GET /api/v2/diagrams", "POST /api/v2/diagrams/import",
  "POST /api/v2/diagrams/stream", "GET /api/v2/diagrams/{diagram_id}",
  "DELETE /api/v2/diagrams/{diagram_id}", "PATCH /api/v2/diagrams/{diagram_id}",
  "POST /api/v2/diagrams/{diagram_id}/edit", "GET /api/v2/diagrams/{diagram_id}/export",
  "POST /api/v2/diagrams/{diagram_id}/fix", "POST /api/v2/diagrams/{diagram_id}/relayout",
  "GET /api/v2/diagrams/{diagram_id}/relayout/{job_id}", "POST /api/v2/diagrams/{diagram_id}/revert",
  "GET /api/v2/diagrams/{diagram_id}/versions", "GET /api/v2/diagrams/{diagram_id}/versions/{version_id}",
  "GET /api/v2/diagrams/{diagram_id}/warnings", "GET /api/v2/gallery",
  "POST /api/v2/gallery/{diagram_id}/fork", "GET /api/v2/me", "GET /api/v2/meta/diagram-types",
  "GET /api/v2/meta/features", "GET /api/v2/meta/formats", "GET /api/v2/meta/providers",
  "POST /api/v2/prompts/clarify", "POST /api/v2/prompts/enhance", "GET /api/v2/usage",
]);

test("SDK covers every API operation (drift guard)", { skip: !existsSync(SPEC) && "spec not alongside SDK" }, () => {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const actual = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) {
      if (["get", "post", "patch", "delete", "put"].includes(m)) actual.add(`${m.toUpperCase()} ${p}`);
    }
  }
  const missing = [...actual].filter((x) => !COVERED.has(x));
  const removed = [...COVERED].filter((x) => !actual.has(x));
  assert.deepEqual(missing, [], `API added ops the SDK must implement: ${missing}`);
  assert.deepEqual(removed, [], `SDK lists ops the API removed: ${removed}`);
});
