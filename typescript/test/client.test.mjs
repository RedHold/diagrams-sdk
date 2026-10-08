// Behavioural tests for the TS SDK — runs against the built dist/ with a mocked
// global fetch. Run: npm run build && npm test  (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

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

test("requires an apiKey (no env, no login cache)", (t) => {
  // Isolate from the login() cache and env so "no credentials anywhere" is real.
  const { HOME, DIAGRAMS_API_KEY } = process.env;
  process.env.HOME = mkdtempSync(join(tmpdir(), "dgz-nocreds-"));
  delete process.env.DIAGRAMS_API_KEY;
  t.after(() => {
    process.env.HOME = HOME;
    if (DIAGRAMS_API_KEY !== undefined) process.env.DIAGRAMS_API_KEY = DIAGRAMS_API_KEY;
  });
  assert.throws(() => new DiagramsClient({ apiKey: "" }), /Not connected/);
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
  "POST /api/v2/oauth/device/code", "POST /api/v2/oauth/device/token", // login() device flow

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

// Operations the API exposes but the SDK deliberately does NOT wrap: the device
// consent endpoints are session-authenticated and driven by the diagrams.so web
// consent page — an API-key SDK has no business calling them.
const WEB_ONLY = new Set([
  "GET /api/v2/oauth/device/info",
  "POST /api/v2/oauth/device/approve",
  "POST /api/v2/oauth/device/deny",
]);

test("SDK covers every API operation (drift guard)", { skip: !existsSync(SPEC) && "spec not alongside SDK" }, () => {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const actual = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) {
      if (["get", "post", "patch", "delete", "put"].includes(m)) actual.add(`${m.toUpperCase()} ${p}`);
    }
  }
  const missing = [...actual].filter((x) => !COVERED.has(x) && !WEB_ONLY.has(x));
  const removed = [...COVERED, ...WEB_ONLY].filter((x) => !actual.has(x));
  assert.deepEqual(missing, [], `API added ops the SDK must implement: ${missing}`);
  assert.deepEqual(removed, [], `SDK lists ops the API removed: ${removed}`);
});

// -- diagramType: left out unless given (server picks the type) --

test("generate omits diagram_type when not given", async () => {
  const calls = mockFetch([{ status: 200, body: { id: "d1" } }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  await c.generate("hi");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal("diagram_type" in sent, false);
  assert.equal(sent.cloud_provider, "general");
});

for (const value of ["architecture", "auto"]) {
  test(`generate sends explicit diagramType "${value}"`, async () => {
    const calls = mockFetch([{ status: 200, body: { id: "d1" } }]);
    const c = new DiagramsClient({ apiKey: "dgz_test_x" });
    await c.generate("hi", { diagramType: value });
    assert.equal(JSON.parse(calls[0].init.body).diagram_type, value);
  });
}

test("import omits diagram_type when not given, sends it when given", async () => {
  const calls = mockFetch([{ status: 200, body: { id: "d1" } }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  await c.import("<mxfile/>");
  await c.import("<mxfile/>", { diagramType: "architecture" });
  assert.equal("diagram_type" in JSON.parse(calls[0].init.body), false);
  assert.equal(JSON.parse(calls[1].init.body).diagram_type, "architecture");
});

for (const value of [undefined, "architecture", "auto"]) {
  test(`generateStream diagramType ${value ?? "(not given)"}`, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const sse = 'event: complete\ndata: {"id":"d1","usage":{"credits_charged":1}}\n\n';
      const bytes = new TextEncoder().encode(sse);
      let done = false;
      return {
        ok: true, status: 200, headers: new Map(),
        body: { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })) }) },
      };
    };
    const c = new DiagramsClient({ apiKey: "dgz_test_x" });
    const opts = value === undefined ? {} : { diagramType: value };
    for await (const _ of c.generateStream("hi", opts)) { /* drain */ }
    const sent = JSON.parse(calls[0].init.body);
    if (value === undefined) assert.equal("diagram_type" in sent, false);
    else assert.equal(sent.diagram_type, value);
  });
}
