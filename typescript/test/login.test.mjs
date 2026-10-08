// Device-flow login, credential cache, and client credential resolution.
// Runs a REAL stub HTTP server (node:http) so login() is exercised over an
// actual socket — request bodies, 400-signal handling, slow_down backoff, and
// the atomic 0600 cache write are all asserted for real.
// Run: npm run build && npm test.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DiagramsClient, DiagramsAPIError, DiagramsAuthError, DEFAULT_BASE,
  login, logout, credentialsPath, _internal,
} from "../dist/index.js";

const EMAIL = "me@corp.com";
// New contract: the response carries NO user_code and NO code-bearing URL — the
// one-time code is emailed, never in the link.
const CODE_RESP = {
  device_code: "dc_1",
  verification_uri: "https://diagrams.so/device",
  expires_in: 60, interval: 0,
};
const TOKEN_RESP = {
  access_token: "dgz_live_new", token_type: "bearer",
  scope: "diagrams:read diagrams:write", livemode: true, expires_in: null,
};

/** Serve /oauth/device/code and /oauth/device/token; token responses pop off
 * `tokenScript` ([status, payload] pairs, last one repeats). */
async function stubServer(tokenScript, codeResp = CODE_RESP) {
  const log = [];
  let i = 0;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      log.push({ path: req.url, body });
      let status = 404, payload = { error: "not_found" };
      if (req.url.endsWith("/oauth/device/code")) { status = 200; payload = codeResp; }
      else if (req.url.endsWith("/oauth/device/confirm")) { status = 200; payload = { revoked: 0 }; }
      else if (req.url.endsWith("/oauth/device/token")) {
        [status, payload] = tokenScript[Math.min(i, tokenScript.length - 1)];
        i += 1;
      }
      const data = JSON.stringify(payload);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/v2`;
  return { base, log, close: () => new Promise((r) => srv.close(r)) };
}

// Every test gets a fresh HOME (own cache file), no DIAGRAMS_API_KEY, and
// zero-delay poll sleeps (recorded for the slow_down assertion).
const savedEnv = {};
const realSleep = _internal.sleep;
let sleeps;
beforeEach(() => {
  savedEnv.HOME = process.env.HOME;
  savedEnv.DIAGRAMS_API_KEY = process.env.DIAGRAMS_API_KEY;
  process.env.HOME = mkdtempSync(join(tmpdir(), "dgz-login-"));
  delete process.env.DIAGRAMS_API_KEY;
  sleeps = [];
  _internal.sleep = async (ms) => { sleeps.push(ms); };
});
afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.DIAGRAMS_API_KEY !== undefined) process.env.DIAGRAMS_API_KEY = savedEnv.DIAGRAMS_API_KEY;
  else delete process.env.DIAGRAMS_API_KEY;
  _internal.sleep = realSleep;
});

function writeCache(overrides = {}, raw = undefined) {
  const path = credentialsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  if (raw !== undefined) { writeFileSync(path, raw); return path; }
  writeFileSync(path, JSON.stringify({
    version: 1, api_key: "dgz_live_cached", scope: "diagrams:read", livemode: true,
    auth_method: "device", created_at: "2026-08-04T00:00:00.000Z", expires_at: null,
    base_url: DEFAULT_BASE, ...overrides,
  }));
  return path;
}

// -- login() -----------------------------------------------------------------

test("login happy path writes the shared cache and returns a ready client", async () => {
  const { base, log, close } = await stubServer([
    [400, { error: "authorization_pending" }], [200, TOKEN_RESP],
  ]);
  try {
    const client = await login({ baseUrl: base, openBrowser: false, email: EMAIL });
    assert.ok(client instanceof DiagramsClient);
    // wire contract of the code request
    assert.ok(log[0].path.endsWith("/oauth/device/code"));
    // the email travels with the code request (backend emails the one-time code)
    assert.deepEqual(log[0].body, { client_id: "sdk-ts", livemode: true, device_name: hostname(), email: EMAIL });
    // token polls carry the RFC 8628 grant
    assert.equal(log[1].body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(log[1].body.device_code, "dc_1");
    assert.equal(log[1].body.client_id, "sdk-ts");
    // after writing the key, the client confirms so the server rotates safely
    const confirm = log.find((e) => e.path.endsWith("/oauth/device/confirm"));
    assert.ok(confirm, "login calls /oauth/device/confirm after saving the key");
    // cache: exact shape (shared contract with the Python SDK), 0600 in 0700 dir
    const path = credentialsPath();
    const creds = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(creds, {
      version: 1, api_key: "dgz_live_new", scope: "diagrams:read diagrams:write",
      livemode: true, auth_method: "device", created_at: creds.created_at,
      expires_at: null, base_url: base,
    });
    assert.ok(creds.created_at); // ISO timestamp present
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    // and new DiagramsClient() with no args now resolves from the cache
    assert.doesNotThrow(() => new DiagramsClient({ baseUrl: base }));
  } finally {
    await close();
  }
});

test("login honors interval and slow_down (+5s)", async () => {
  const { base, close } = await stubServer(
    [[400, { error: "slow_down" }], [400, { error: "authorization_pending" }], [200, TOKEN_RESP]],
    { ...CODE_RESP, interval: 1 },
  );
  try {
    await login({ baseUrl: base, openBrowser: false, email: EMAIL });
    // first poll at the server's interval; slow_down adds 5s to every later poll
    assert.deepEqual(sleeps, [1000, 6000, 6000]);
  } finally {
    await close();
  }
});

test("login denied throws", async () => {
  const { base, close } = await stubServer([[400, { error: "access_denied" }]]);
  try {
    await assert.rejects(() => login({ baseUrl: base, openBrowser: false, email: EMAIL }),
      (e) => e instanceof DiagramsAuthError && /denied/.test(e.message));
  } finally {
    await close();
  }
});

test("login expired_token throws 'run login again'", async () => {
  const { base, close } = await stubServer([[400, { error: "expired_token" }]]);
  try {
    await assert.rejects(() => login({ baseUrl: base, openBrowser: false, email: EMAIL }), /run login again/);
  } finally {
    await close();
  }
});

test("login deadline timeout throws 'run login again'", async () => {
  const { base, close } = await stubServer(
    [[400, { error: "authorization_pending" }]], { ...CODE_RESP, expires_in: 0 });
  try {
    await assert.rejects(() => login({ baseUrl: base, openBrowser: false, email: EMAIL }), /run login again/);
  } finally {
    await close();
  }
});

test("login key_limit_reached carries the revoke instructions", async () => {
  const { base, close } = await stubServer([[400, { error: "key_limit_reached" }]]);
  try {
    await assert.rejects(() => login({ baseUrl: base, openBrowser: false, email: EMAIL }),
      /25 active keys.*diagrams\.so\/api-keys/);
  } finally {
    await close();
  }
});

test("login test mode warns and requests livemode:false", async (t) => {
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  t.after(() => { console.log = realLog; });
  const token = { ...TOKEN_RESP, access_token: "dgz_test_new", livemode: false };
  const { base, log, close } = await stubServer([[200, token]]);
  try {
    await login({ test: true, baseUrl: base, openBrowser: false, email: EMAIL });
    assert.ok(lines.some((l) => l.includes("Test keys are not a sandbox")));
    assert.equal(log[0].body.livemode, false);
    assert.equal(JSON.parse(readFileSync(credentialsPath(), "utf8")).livemode, false);
  } finally {
    await close();
  }
});

test("login persists expires_in as an ISO expires_at", async () => {
  const { base, close } = await stubServer([[200, { ...TOKEN_RESP, expires_in: 3600 }]]);
  try {
    await login({ baseUrl: base, openBrowser: false, email: EMAIL });
    const creds = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    assert.ok(creds.expires_at && creds.expires_at > creds.created_at);
  } finally {
    await close();
  }
});

// -- credential resolution ---------------------------------------------------

test("explicit apiKey beats env and cache", () => {
  process.env.DIAGRAMS_API_KEY = "dgz_live_env";
  writeCache();
  const c = new DiagramsClient({ apiKey: "dgz_live_explicit" });
  assert.equal(c["apiKey"], "dgz_live_explicit");
});

test("env beats cache", () => {
  process.env.DIAGRAMS_API_KEY = "dgz_live_env";
  writeCache();
  assert.equal(new DiagramsClient()["apiKey"], "dgz_live_env");
});

test("cache is used when nothing else is set", () => {
  writeCache();
  assert.equal(new DiagramsClient()["apiKey"], "dgz_live_cached");
});

test("cache ignored on baseUrl mismatch", () => {
  writeCache({ base_url: "https://api.staging.diagrams.so/api/v2" });
  assert.throws(() => new DiagramsClient(), /Not connected/);
});

test("cache with trailing slash still matches", () => {
  writeCache({ base_url: DEFAULT_BASE + "/" });
  assert.equal(new DiagramsClient()["apiKey"], "dgz_live_cached");
});

for (const [name, raw] of [
  ["corrupt JSON", "{not json"],
  ["non-object", "[]"],
  ["wrong version", JSON.stringify({ version: 2, api_key: "k", base_url: DEFAULT_BASE })],
  ["missing api_key", JSON.stringify({ version: 1, base_url: DEFAULT_BASE })],
  ["empty file", ""],
]) {
  test(`cache treated as absent when ${name}`, () => {
    writeCache({}, raw);
    assert.throws(() => new DiagramsClient(), /Not connected/);
  });
}

test("not-connected error message is exact", () => {
  assert.throws(() => new DiagramsClient(),
    (e) => e.message === "Not connected — call login() or set DIAGRAMS_API_KEY.");
});

// -- logout ------------------------------------------------------------------

test("logout deletes the cache and is idempotent", () => {
  writeCache();
  assert.ok(existsSync(credentialsPath()));
  logout();
  assert.ok(!existsSync(credentialsPath()));
  logout(); // second call: no file, no error
});

// -- upgradeUrl --------------------------------------------------------------

test("upgradeUrl surfaces from the 402 QUOTA_EXCEEDED payload", async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 402, headers: new Map(),
    text: async () => JSON.stringify({ error: {
      code: "QUOTA_EXCEEDED", message: "no credits",
      upgrade_url: "https://diagrams.so/billing?upgrade=1",
    } }),
  });
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  await assert.rejects(() => c.generate("hi"),
    (e) => e instanceof DiagramsAPIError && e.upgradeUrl === "https://diagrams.so/billing?upgrade=1");
});

test("upgradeUrl is undefined when the payload has none", async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 400, headers: new Map(),
    text: async () => JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "bad" } }),
  });
  const c = new DiagramsClient({ apiKey: "dgz_test_x" });
  await assert.rejects(() => c.generate("hi"),
    (e) => e instanceof DiagramsAPIError && e.upgradeUrl === undefined);
});
