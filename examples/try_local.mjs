// Try the TypeScript SDK against your LOCAL API. Reads key + base from env.
//
//   cd sdk/typescript && npm install && npm run build
//   DIAGRAMS_KEY=dgz_test_… DIAGRAMS_BASE=http://localhost:8000/api/v2 \
//     node ../examples/try_local.mjs
//
// Reads/enhance/clarify are free; generate/edit/relayout cost credits.
import { DiagramsClient, DiagramsAPIError } from "../typescript/dist/index.js";

const KEY = process.env.DIAGRAMS_KEY;
const BASE = process.env.DIAGRAMS_BASE ?? "http://localhost:8000/api/v2";
if (!KEY) { console.error("Set DIAGRAMS_KEY (mint one — see the steps)."); process.exit(1); }

const c = new DiagramsClient({ apiKey: KEY, baseUrl: BASE });

console.log("1) who am I / free reads");
console.log("   me:", await c.me());
console.log("   providers:", await c.meta("providers"));

console.log("\n2) free prompt helper");
console.log("   enhance:", (await c.enhancePrompt("aws web app")).enhanced_prompt.slice(0, 60), "…");

console.log("\n3) error handling (bad key → typed error)");
try {
  await new DiagramsClient({ apiKey: "dgz_test_bogus", baseUrl: BASE }).me();
} catch (e) {
  if (e instanceof DiagramsAPIError) console.log(`   raised DiagramsAPIError: ${e.code} ${e.status}`);
}

console.log("\n4) generate (real LLM — costs a credit)");
const d = await c.generate("GCP web app: LB, GCE, Cloud SQL", { cloudProvider: "gcp" });
console.log(`   id=${d.id}  score=${d.score?.score}  warnings=${d.warnings.length}`);

console.log("\n5) streaming (note: TS yields {event, data} objects)");
let streamId;
for await (const { event, data } of c.generateStream("Kubernetes app: Ingress, 3 pods, Postgres", { cloudProvider: "kubernetes" })) {
  if (event === "progress") console.log(`   …${data.progress}% ${(data.message || "").slice(0, 40)}`);
  else if (event === "complete") { streamId = data.id; console.log(`   complete → ${streamId}`); }
}

console.log("\n6) async re-layout (poll to done)");
let job = await c.relayoutAndWait(d.id, { pollIntervalMs: 2000, timeoutMs: 120000 });
if (job.status === "confirmation_required") job = await c.relayoutAndWait(d.id, { confirm: true, pollIntervalMs: 2000, timeoutMs: 120000 });
console.log("   relayout:", job.status, "applied:", job.applied);

console.log("\n7) export + cleanup");
const svg = await c.export(d.id, "svg");
console.log("   svg bytes:", svg.length);
await c.delete(d.id);
await c.delete(streamId);
console.log("   deleted. done ✓");
