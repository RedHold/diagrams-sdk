#!/usr/bin/env node
// End-to-end integration test: the REAL TypeScript SDK transport (built dist/)
// against the local stub API (local-test/stub_api.py). Zero credits. Proves
// idempotency replay, the ambiguous-retry ladder, the honest tally, streaming,
// and the re-layout confirm flow over an actual socket.
//
// Run the stub first (PORT=8899 python local-test/stub_api.py), then:
//     cd typescript && npm run build && node ../local-test/it_typescript.mjs
// Exits non-zero on the first failed assertion.
import { DiagramsClient, DiagramsAPIError } from "../typescript/dist/index.js";

const BASE = process.env.BASE || "http://127.0.0.1:8899/api/v2";
const DEBUG = BASE.replace(/\/api\/.*$/, "") + "/__debug";

let PASS = 0, FAIL = 0;
const check = (name, cond) => { cond ? (PASS++, console.log(`  ✓ ${name}`)) : (FAIL++, console.log(`  ✗ ${name}`)); };
const charges = async () => (await (await fetch(DEBUG)).json()).charge_count;
const client = () => new DiagramsClient({
  apiKey: "dgz_test_local", baseUrl: BASE, retryDelaysMs: [0, 0, 0], retryBudgetMs: 30_000, timeoutMs: 10_000,
});

const c = client();

console.log("1) reads");
check("me() returns account", (await c.me()).email === "you@example.com");
check("usage() has cost_estimates", "cost_estimates" in (await c.usage()));

console.log("2) generate happy path");
let n0 = await charges();
let d = await c.generate("a simple VPC");
check("returned a diagram id", !!d.id);
check("charged exactly once", (await charges()) - n0 === 1);
check("tally recorded confirmed", c.sessionCharges.at(-1).status === "confirmed");

console.log("3) idempotency replay (response lost to a 504, same key retried)");
n0 = await charges();
d = await c.generate("FAIL_ONCE_504 build me a mesh");
check("recovered the diagram id after replay", !!d.id);
check("server charged ONCE despite the retry", (await charges()) - n0 === 1);
check("tally is confirmed (not unknown)", c.sessionCharges.at(-1).status === "confirmed");

console.log("4) hard ambiguous outage -> unknown tally, no phantom charge");
{
  const c2 = client();
  n0 = await charges();
  let raised = false;
  try { await c2.generate("FAIL_ALWAYS_504 nope"); }
  catch (e) { raised = true; check("surfaced a 504/timeout error", e instanceof DiagramsAPIError && (e.status === 504 || e.code === "TIMEOUT")); }
  check("did raise after exhausting retries", raised);
  check("server was NOT charged", (await charges()) - n0 === 0);
  check("tally recorded UNKNOWN", c2.sessionCharges.at(-1).status === "unknown");
}

console.log("5) definite 422 -> no retry, no charge, no tally");
{
  const c3 = client();
  n0 = await charges();
  let raised = false;
  try { await c3.generate("FAIL_422 bad input"); }
  catch (e) { raised = true; check("422 surfaced", e instanceof DiagramsAPIError && e.status === 422); }
  check("did raise", raised);
  check("not charged", (await charges()) - n0 === 0);
  check("no tally entry", c3.sessionCharges.length === 0);
}

console.log("6) explicit shared key dedupes across calls");
const sharedKey = `order-${process.pid}`; // unique per run (the stub's idem store is long-lived)
n0 = await charges();
const a = await c.generate("first", { idempotencyKey: sharedKey });
const b = await c.generate("second-ignored", { idempotencyKey: sharedKey });
check("same id replayed", a.id === b.id);
check("charged only once for the shared key", (await charges()) - n0 === 1);

console.log("7) edit + fix are billable & idempotent");
n0 = await charges();
const e = await c.edit(d.id, "make it HA");
const f = await c.fix(d.id, "close the SG");
check("edit charged", e.usage?.credits_charged === 3);
check("fix charged", f.usage?.credits_charged === 3);
check("two charges recorded", (await charges()) - n0 === 2);

console.log("8) re-layout confirm flow (no free allowance)");
let job = await c.relayoutAndWait(d.id);
check("first call needs confirmation", job.status === "confirmation_required");
n0 = await charges();
let t0 = c.sessionCharges.length;
job = await c.relayoutAndWait(d.id, { confirm: true });
check("confirmed run reaches done+applied", job.status === "done" && job.applied === true);
check("re-layout charged on delivery", (await charges()) - n0 === 1);
check("re-layout recorded an UNKNOWN tally (credits async in ledger)",
  c.sessionCharges.slice(t0).some((s) => s.action === "relayout" && s.status === "unknown"));

console.log("9) SSE streaming generate");
{
  t0 = c.sessionCharges.length;
  const seen = {};
  let final = null;
  for await (const { event, data } of c.generateStream("stream me")) {
    seen[event] = (seen[event] || 0) + 1;
    if (event === "complete") final = data;
  }
  check("saw a progress event", (seen.progress || 0) >= 1);
  check("saw a complete event with an id", !!(final && final.id));
  check("streamed generate recorded a CONFIRMED tally",
    c.sessionCharges.slice(t0).some((s) => s.action === "generate" && s.status === "confirmed"));
}

console.log("10) usageHistory reflects the ledger");
const hist = await c.usageHistory({ limit: 100 });
check("history has items", (hist.items?.length ?? 0) >= 1);
check("summary task_count present", "task_count" in (hist.summary ?? {}));

console.log(`\nTypeScript integration: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
