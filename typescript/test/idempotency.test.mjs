// Idempotency + bounded same-key retry for billable calls (audit remediation).
// Mirrors the MCP server's test-idempotency contract. Runs against built dist/
// with a mocked global fetch. Run: npm run build && npm test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DiagramsClient, DiagramsAPIError, isAmbiguous } from "../dist/index.js";

function mockFetch(sequence) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const r = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    calls.push({ url, init });
    if (r.throw) throw r.throw;
    return {
      ok: r.status < 400,
      status: r.status,
      headers: new Map(Object.entries(r.headers ?? {})),
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  return calls;
}

// zero retry delays so the ladder doesn't actually sleep during tests
const fast = { apiKey: "dgz_test_x", retryDelaysMs: [0, 0, 0], retryBudgetMs: 60_000 };
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const ok = (id) => ({ status: 200, body: { id, usage: { credits_charged: 3, credits_remaining: 9 } } });

test("isAmbiguous classification", () => {
  assert.ok(isAmbiguous(new DiagramsAPIError("TIMEOUT", "", 0)));
  assert.ok(isAmbiguous(new DiagramsAPIError("CONNECTION_ERROR", "", 0)));
  assert.ok(isAmbiguous(new DiagramsAPIError("GW", "", 504)));
  assert.ok(isAmbiguous(new DiagramsAPIError("IDEMPOTENCY_IN_PROGRESS", "", 409)));
  assert.ok(!isAmbiguous(new DiagramsAPIError("QUOTA_EXCEEDED", "", 402)));
  assert.ok(!isAmbiguous(new DiagramsAPIError("VALIDATION_ERROR", "", 422)));
  assert.ok(!isAmbiguous(new Error("nope")));
});

test("generate auto-attaches an Idempotency-Key", async () => {
  const calls = mockFetch([ok("d1")]);
  const c = new DiagramsClient(fast);
  await c.generate("hi");
  assert.ok((calls[0].init.headers["Idempotency-Key"] ?? "").length >= 16);
});

test("504 replays with the SAME key then succeeds (one confirmed charge)", async () => {
  const calls = mockFetch([{ status: 504, body: { error: { code: "GATEWAY_TIMEOUT" } } }, ok("d2")]);
  const c = new DiagramsClient(fast);
  const out = await c.generate("hi");
  assert.equal(out.id, "d2");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
  assert.deepEqual(c.sessionCharges.map((s) => s.status), ["confirmed"]);
});

test("fetch abort maps to TIMEOUT and is retried", async () => {
  const calls = mockFetch([{ throw: abortErr() }, ok("d3")]);
  const c = new DiagramsClient(fast);
  const out = await c.generate("hi");
  assert.equal(out.id, "d3");
  assert.equal(calls.length, 2);
});

test("definite 422 is not retried and leaves no tally", async () => {
  const calls = mockFetch([{ status: 422, body: { detail: "bad" } }]);
  const c = new DiagramsClient(fast);
  await assert.rejects(() => c.generate("hi"), DiagramsAPIError);
  assert.equal(calls.length, 1);
  assert.deepEqual(c.sessionCharges, []);
});

test("exhausted ambiguous records an unknown tally and throws", async () => {
  const calls = mockFetch([{ status: 504, body: { error: { code: "GATEWAY_TIMEOUT" } } }]);
  const c = new DiagramsClient(fast);
  await assert.rejects(() => c.generate("hi"), (e) => e instanceof DiagramsAPIError && e.status === 504);
  assert.equal(calls.length, 4); // initial + 3 retries
  assert.deepEqual(c.sessionCharges.map((s) => s.status), ["unknown"]);
  assert.equal(c.sessionCharges[0].action, "generate");
});

test("network failure maps to CONNECTION_ERROR", async () => {
  mockFetch([{ throw: new TypeError("fetch failed") }]);
  const c = new DiagramsClient({ apiKey: "dgz_test_x", retryDelaysMs: [], retryBudgetMs: 1000 });
  await assert.rejects(() => c.get("d1"), (e) => e instanceof DiagramsAPIError && e.code === "CONNECTION_ERROR");
});
