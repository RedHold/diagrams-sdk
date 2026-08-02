#!/usr/bin/env node
// Hard audit of the TypeScript SDK: every retry/classification/header/parsing aspect,
// with a fully mocked fetch. Run: cd typescript && npm run build && cd .. && node local-test/audit_ts.mjs
import { DiagramsClient, DiagramsAPIError, isAmbiguous } from "../typescript/dist/index.js";

let P = 0, F = 0;
const check = (n, c) => c ? (P++, console.log(`  ✓ ${n}`)) : (F++, console.log(`  ✗ ${n}   <-- FAIL`));

function mockFetch(seq) {
  const calls = []; let i = 0;
  globalThis.fetch = async (url, init) => {
    const r = seq[Math.min(i, seq.length - 1)]; i++; calls.push({ url, init });
    if (r.throw) throw r.throw;
    return { ok: r.status < 400, status: r.status,
             headers: new Map(Object.entries(r.headers ?? {})),
             text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})) };
  };
  return calls;
}
const R = (status, body, headers) => ({ status, body, headers });
const OK = { id: "d1", usage: { credits_charged: 2, credits_remaining: 9 } };
const abort = () => Object.assign(new Error("a"), { name: "AbortError" });
const cl = (o = {}) => new DiagramsClient({ apiKey: "dgz_test_x", retryDelaysMs: [0, 0, 0], retryBudgetMs: 30_000, ...o });

console.log("A) isAmbiguous classification (must match MCP)");
for (const [code, st, exp] of [["TIMEOUT",0,true],["CONNECTION_ERROR",0,true],["IDEMPOTENCY_IN_PROGRESS",409,true],
     ["X",502,true],["X",503,true],["X",504,true],["X",409,true],["QUOTA",402,false],["V",422,false],
     ["X",400,false],["X",401,false],["X",404,false],["X",500,false],["X",429,false]])
  check(`${code}/${st} -> ${exp ? "ambiguous" : "definite"}`, isAmbiguous(new DiagramsAPIError(code, "", st)) === exp);
check("non-APIError never ambiguous", isAmbiguous(new Error("x")) === false);

console.log("B) ambiguous statuses retried (same key) then succeed");
for (const st of [502, 503, 504, 409]) {
  const calls = mockFetch([R(st, { error: { code: "X" } }), R(200, OK)]);
  const out = await cl().generate("hi");
  const keys = new Set(calls.map((c) => c.init.headers["Idempotency-Key"]));
  check(`${st} retried to success, one stable key`, out.id === "d1" && keys.size === 1 && !keys.has(undefined));
}

console.log("C) definite statuses NOT retried");
for (const st of [400, 401, 402, 404, 422, 500]) {
  const calls = mockFetch([R(st, { error: { code: "E" } })]);
  const c = cl(); let raised = false;
  try { await c.generate("hi"); } catch { raised = true; }
  check(`${st} raises without retry (1 call)`, raised && calls.length === 1 && c.sessionCharges.length === 0);
}

console.log("D) thrown transport errors retried");
{
  let calls = mockFetch([{ throw: abort() }, R(200, OK)]);
  check("AbortError->TIMEOUT retried to success", (await cl().generate("hi")).id === "d1" && calls.length === 2);
  calls = mockFetch([{ throw: new TypeError("fetch failed") }, R(200, OK)]);
  check("network->CONNECTION_ERROR retried to success", (await cl().generate("hi")).id === "d1" && calls.length === 2);
}

console.log("E) 429 handled by inner Retry-After loop");
{
  const calls = mockFetch([R(429, { error: { code: "RL" } }, { "retry-after": "0" }), R(200, OK)]);
  const out = await cl({ maxRetries: 2, backoffMs: 1 }).generate("hi");
  check("429 then 200 succeeds (2 calls)", out.id === "d1" && calls.length === 2);
}

console.log("F) exhausted ambiguous -> unknown tally + raise");
{
  const calls = mockFetch([R(504, { error: { code: "GW" } })]);
  const c = cl(); let raised = false;
  try { await c.generate("hi"); } catch { raised = true; }
  check("504 forever: raises, 4 calls, one unknown", raised && calls.length === 4
        && c.sessionCharges.map((s) => s.status).join() === "unknown");
}

console.log("G) budget exhaustion stops early");
{
  const calls = mockFetch([R(504, { error: { code: "GW" } })]);
  const c = cl({ retryDelaysMs: [100000, 100000], retryBudgetMs: 1 });
  try { await c.generate("hi"); } catch {}
  check("tiny budget -> 1 call, unknown tallied", calls.length === 1 && c.sessionCharges.at(-1).status === "unknown");
}

console.log("H) idempotency key auto-attached + stable across retry");
for (const [name, fn] of [["generate", (c) => c.generate("x")], ["edit", (c) => c.edit("d", "x")],
     ["fix", (c) => c.fix("d", "x")], ["startRelayout", (c) => c.startRelayout("d", { confirm: true })]]) {
  const calls = mockFetch([R(504, { error: { code: "GW" } }), R(200, { ...OK, status: "pending", chargeable: true })]);
  await fn(cl());
  const keys = calls.map((c) => c.init.headers["Idempotency-Key"]);
  check(`${name}: key present + identical across retry`, keys.every(Boolean) && new Set(keys).size === 1);
}

console.log("I) attribution headers on every request");
{
  const calls = mockFetch([R(200, OK)]);
  await cl().generate("hi");
  const h = calls[0].init.headers;
  check("X-Diagrams-Client = sdk-ts/1.1.0", h["X-Diagrams-Client"] === "sdk-ts/1.1.0");
  check("User-Agent = @diagrams-so/sdk/1.1.0", h["User-Agent"] === "@diagrams-so/sdk/1.1.0");
}

console.log("J) query params: arrays repeat, undefined dropped, from mapping");
{
  const calls = mockFetch([R(200, { items: [], has_more: false, summary: {} })]);
  await cl().usageHistory({ action: ["generate", "edit"], since: "2026-01-01", limit: undefined });
  const url = calls[0].url;
  check("action repeated", (url.match(/action=/g) || []).length === 2 && url.includes("action=generate") && url.includes("action=edit"));
  check("since -> from", url.includes("from=2026-01-01"));
  check("undefined limit dropped", !url.includes("limit="));
}

console.log("K) response parsing: raw export, 204 delete, error envelope, 422 detail");
{
  mockFetch([R(200, "<mxGraphModel/>")]);
  check("export returns raw text", (await cl().export("d", "drawio")) === "<mxGraphModel/>");
  mockFetch([R(204, "")]);
  let threw = false; try { await cl().delete("d"); } catch { threw = true; }
  check("delete does not throw on 204", !threw);
  mockFetch([R(402, { error: { code: "QUOTA_EXCEEDED", message: "no", request_id: "r1" } })]);
  try { await cl().get("d"); check("error envelope parsed", false); }
  catch (e) { check("error envelope -> code/status/requestId", e.code === "QUOTA_EXCEEDED" && e.status === 402 && e.requestId === "r1"); }
  mockFetch([R(422, { detail: [{ msg: "bad" }] })]);
  try { await cl().get("d"); check("422 surfaced", false); }
  catch (e) { check("422 surfaced", e.status === 422); }
}

console.log("L) no apiKey throws at construction");
try { new DiagramsClient({ apiKey: "" }); check("empty key throws", false); }
catch { check("empty key throws", true); }

console.log("M) persistent 503 on a billable call -> single retry layer (no double-retry)");
{
  const calls = mockFetch([R(503, { error: { code: "X" } })]);
  const c = cl({ maxRetries: 2, backoffMs: 1 });   // retryDelaysMs [0,0,0] -> outer ladder 1 + 3
  try { await c.generate("hi"); } catch {}
  console.log(`     (note) persistent 503 -> ${calls.length} transport calls (outer idempotent ladder only)`);
  check("persistent 503 uses only the outer ladder (4 calls) + unknown tally",
        calls.length === 4 && c.sessionCharges.at(-1).status === "unknown");
}

console.log("N) re-layout poll error records an unknown tally");
{
  const calls = mockFetch([R(200, { job_id: "j1", status: "pending", chargeable: true }), R(504, { error: { code: "GW" } })]);
  const c = cl(); let raised = false;
  try { await c.relayoutAndWait("d", { confirm: true }); } catch { raised = true; }
  check("poll failure -> raise + one unknown relayout tally", raised && calls.length === 2
        && c.sessionCharges.length === 1 && c.sessionCharges[0].action === "relayout" && c.sessionCharges[0].status === "unknown");
}

console.log(`\nTypeScript audit: ${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
