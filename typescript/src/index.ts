/**
 * Diagrams.so TypeScript SDK — a thin, typed client over the public /api/v2 REST API.
 *
 *   import { DiagramsClient } from "@diagrams-so/sdk";
 *   const client = new DiagramsClient({ apiKey: "dgz_live_…" });
 *   const d = await client.generate("AWS 3-tier web app", { cloudProvider: "aws" });
 *   console.log(d.id, d.score?.score);
 *
 * Every method maps 1:1 to an endpoint. Non-2xx responses throw `DiagramsAPIError`
 * carrying the API's error code, HTTP status, and request_id. Reads are free;
 * generate/edit/fix/fork cost credits (drawing is always billed).
 *
 * Zero runtime dependencies — uses the platform `fetch`. Node ≥ 18 required for
 * `login()` and the credential cache (they use node builtins: fs/os/path/child_process).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_BASE = "https://api.diagrams.so/api/v2";
/** Bumped with the package; sent so the API attributes charges to source="sdk-ts". */
export const SDK_VERSION = "1.4.0";

export class DiagramsAPIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId?: string,
    /** Where to add credits/upgrade — from the 402 QUOTA_EXCEEDED payload if the
     * API sent one, else undefined. */
    public upgradeUrl?: string,
  ) {
    super(`[${code}] (HTTP ${status}) ${message}`);
    this.name = "DiagramsAPIError";
  }
}

/** Raised when the device-login flow cannot complete (denied, expired, …). */
export class DiagramsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramsAuthError";
  }
}

// Errors where a billable call's outcome is UNKNOWN — the work may have completed
// and been charged server-side even though this process saw a failure. Retrying
// with the SAME Idempotency-Key replays the stored result instead of re-running
// (and re-billing). Definite rejections (401/402/404/422 …) are deliberately absent.
const AMBIGUOUS_STATUSES = new Set([502, 503, 504, 409]);
const AMBIGUOUS_CODES = new Set(["TIMEOUT", "CONNECTION_ERROR", "IDEMPOTENCY_IN_PROGRESS"]);

/** True if `err` leaves a billable call's outcome unknown (safe to retry with the
 * same Idempotency-Key). */
export function isAmbiguous(err: unknown): boolean {
  if (!(err instanceof DiagramsAPIError)) return false;
  return AMBIGUOUS_STATUSES.has(err.status) || AMBIGUOUS_CODES.has(err.code);
}

// --- response shapes (partial; the API may add fields) ---
export interface Warning { type: string; component?: string | null; message: string; }
export interface ScoreBreakdown { type: string; label: string; count: number; deduction: number; }
export interface Score { score: number; tier: string; warning_count: number; recoverable_points: number; breakdown: ScoreBreakdown[]; }
export interface Usage { credits_charged: number; credits_remaining: number; tier?: string | null; }
export interface Diagram {
  id: string; title: string; xml: string;
  cloud_provider?: string | null; diagram_type?: string | null;
  is_public: boolean; created_at: string;
  warnings: Warning[]; score?: Score | null; usage?: Usage | null;
}
export interface Page<T> { items: T[]; next_cursor?: string | null; has_more: boolean; }
export interface UsageHistoryItem {
  id: string; created_at: string;
  action_type: string;      // generate | edit | fix | relayout
  credits_charged: number;  // 0 == free
  diagram_id?: string | null; tier?: string | null;
  tokens_input?: number | null; tokens_output?: number | null; tokens_total?: number | null;
  source?: string | null;   // api | sdk-python | sdk-ts | mcp | web
  livemode?: boolean | null; request_id?: string | null;
}
export interface UsageHistorySummary { total_credits_charged: number; task_count: number; }
export interface UsageHistoryList { items: UsageHistoryItem[]; next_cursor?: string | null; has_more: boolean; summary: UsageHistorySummary; }
/** One entry in the in-process tally of what each billable task charged. `status`
 * is `"unknown"` when the outcome was lost to an ambiguous failure (the server may
 * or may not have charged — only `usageHistory` is authoritative). */
export interface SessionCharge {
  action: string;
  status: "confirmed" | "unknown";
  diagramId?: string;
  creditsCharged?: number;
  creditsRemaining?: number;
  note?: string;
}
export interface UsageHistoryFilters {
  limit?: number; cursor?: string; action?: string[]; source?: string[];
  diagramId?: string; livemode?: boolean; since?: string; until?: string; includeGrants?: boolean;
}
export interface RelayoutJob {
  job_id?: string; status: string; // "pending" | "confirmation_required" | ...
  chargeable?: boolean | null; message?: string; reason?: string;
}
export interface RelayoutStatus {
  job_id: string; status: string; // "pending" | "done" | "failed"
  applied?: boolean | null; reason?: string | null; version_number?: number | null;
  progress: number; xml?: string | null; warnings: Warning[]; score?: Score | null;
}

export interface DiagramsClientOptions {
  /** Optional: falls back to `DIAGRAMS_API_KEY`, then the `login()` cache. */
  apiKey?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; backoffMs?: number;
  /** Same-key retry delays (ms) for billable calls on ambiguous failures. */
  retryDelaysMs?: number[];
  /** Wall-clock ceiling (ms) for one billable call including its retries. */
  retryBudgetMs?: number;
}

export class DiagramsClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private backoffMs: number;
  private retryDelaysMs: number[];
  private retryBudgetMs: number;
  private clientId = `sdk-ts/${SDK_VERSION}`;
  private userAgent = `@diagrams-so/sdk/${SDK_VERSION}`;
  /** Running tally of what each billable task charged this session — answers
   * "how much did each task cost?" with no server round-trip. Counts only what
   * THIS process saw; `usageHistory` is the authoritative ledger. */
  public sessionCharges: SessionCharge[] = [];

  constructor(opts: DiagramsClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    // Credential resolution: explicit option > DIAGRAMS_API_KEY env > the login()
    // cache (~/.diagrams-so/credentials.json, only if well-formed and minted for
    // this baseUrl — any problem means "absent", never a crash).
    const apiKey = opts.apiKey
      || (typeof process !== "undefined" ? process.env?.DIAGRAMS_API_KEY : undefined)
      || loadCachedApiKey(this.baseUrl);
    if (!apiKey) throw new Error("Not connected — call login() or set DIAGRAMS_API_KEY.");
    this.apiKey = apiKey;
    // 450s sits ABOVE the server-side timeout ladder (LLM worst-case ~160s <
    // gunicorn 300s < nginx 330s < ALB 360s) so the client never aborts work the
    // server would still deliver (and bill for).
    this.timeoutMs = opts.timeoutMs ?? 450_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.retryDelaysMs = opts.retryDelaysMs ?? [5_000, 15_000, 30_000];
    this.retryBudgetMs = opts.retryBudgetMs ?? 600_000;
  }

  /** Record what a billable task charged (from the response `usage` block). */
  private track(action: string, result: any): any {
    const u = result?.usage;
    if (u) this.sessionCharges.push({
      action, status: "confirmed", diagramId: result?.id,
      creditsCharged: u.credits_charged, creditsRemaining: u.credits_remaining,
    });
    return result;
  }

  /** Record a billable call whose outcome this process never saw — the server may
   * or may not have charged; only `usageHistory` knows for sure. */
  private recordUnknown(action: string, note?: string): void {
    this.sessionCharges.push({ action, status: "unknown", note });
  }

  private newKey(): string {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  /** Send a billable call with a fresh Idempotency-Key and bounded same-key retries
   * on AMBIGUOUS failures (timeout / 5xx / in-progress). A response lost to a
   * gateway timeout is REPLAYED by the server on retry — one charge, result
   * recovered; retrying WITHOUT a key would create a second diagram and a second
   * charge. Definite rejections (401/402/404/422 …) never retry. On final ambiguous
   * failure the outcome is tallied as `status:"unknown"` and re-thrown — reconcile
   * against `usageHistory`. */
  private async requestBillable<T = any>(
    method: string, path: string,
    opts: { action: string; query?: Record<string, any>; body?: any; idempotencyKey?: string },
  ): Promise<T> {
    const key = opts.idempotencyKey ?? this.newKey();
    const started = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        // retryStatuses [429]: 503 is left to this idempotent ladder so it isn't
        // retried by both the inner Retry-After loop and here.
        return await this.request<T>(method, path, {
          query: opts.query, body: opts.body, headers: { "Idempotency-Key": key }, retryStatuses: [429],
        });
      } catch (e) {
        lastErr = e;
        const outOfBudget = Date.now() - started + (this.retryDelaysMs[attempt] ?? 0) >= this.retryBudgetMs;
        if (!isAmbiguous(e) || attempt === this.retryDelaysMs.length || outOfBudget) break;
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
      }
    }
    if (isAmbiguous(lastErr)) {
      this.recordUnknown(opts.action, `${(lastErr as DiagramsAPIError).code} after retries — may have been charged`);
    }
    throw lastErr;
  }

  private async request<T = any>(
    method: string, path: string,
    opts: { query?: Record<string, any>; body?: any; raw?: boolean; headers?: Record<string, string>; retryStatuses?: number[] } = {},
  ): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) { for (const item of v) if (item !== undefined && item !== null) qs.append(k, String(item)); }
        else qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      "X-Diagrams-Client": this.clientId,
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    // Retry transient statuses — pre-processing rejections (rate limit / backpressure),
    // so a retry never double-charges. Honors Retry-After. Billable calls pass `[429]`
    // so `503` is handled once by the idempotent ladder, not by both layers.
    const retryOn = opts.retryStatuses ?? [429, 503];
    let resp!: Response;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        resp = await fetch(url, {
          method, headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: ctrl.signal,
        });
      } catch (e: any) {
        // Map transport failures to typed errors so the billable retry ladder can
        // classify them (both are AMBIGUOUS — the request may have reached the server).
        if (e?.name === "AbortError") {
          throw new DiagramsAPIError("TIMEOUT",
            `The Diagrams.so API did not respond within ${Math.round(this.timeoutMs / 1000)}s.`, 0);
        }
        throw new DiagramsAPIError("CONNECTION_ERROR",
          `Could not reach the Diagrams.so API at ${this.baseUrl}. (${e?.message ?? e})`, 0);
      } finally {
        clearTimeout(t);
      }
      if (retryOn.includes(resp.status) && attempt < this.maxRetries) {
        const ra = Number(resp.headers.get("retry-after"));
        const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.backoffMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(delay, 30_000)));
        continue;
      }
      break;
    }

    const text = await resp.text();
    if (opts.raw) {
      if (!resp.ok) this.throwErr(resp.status, text);
      return text as unknown as T;
    }
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      const e = payload?.error ?? {};
      throw new DiagramsAPIError(e.code ?? "ERROR", e.message ?? text ?? "request failed", resp.status, e.request_id,
        e.upgrade_url ?? payload?.upgrade_url);
    }
    return payload as T;
  }

  private throwErr(status: number, text: string): never {
    let e: any = {};
    try { e = (JSON.parse(text) || {}).error || {}; } catch { /* noop */ }
    throw new DiagramsAPIError(e.code ?? "ERROR", e.message ?? text ?? "request failed", status, e.request_id, e.upgrade_url);
  }

  // -- diagrams --
  /** Generate a diagram. `diagramType` is optional: left out, the field is not
   * sent and the server picks the kind of diagram. A value (for example
   * `"architecture"` or `"auto"`) is sent as given. Before 1.4.0 the SDK always
   * sent `"architecture"`. */
  async generate(prompt: string, opts: { cloudProvider?: string; diagramType?: string; opinionated?: boolean; idempotencyKey?: string } = {}) {
    return this.track("generate", await this.requestBillable<Diagram>("POST", "/diagrams", {
      action: "generate",
      body: { prompt, cloud_provider: opts.cloudProvider ?? "general", diagram_type: opts.diagramType, opinionated: opts.opinionated ?? false },
      idempotencyKey: opts.idempotencyKey,
    })) as Diagram;
  }
  /** Stream a generation as Server-Sent Events. Yields `{event, data}` where
   * `event` is `"progress" | "complete" | "error"`. Progress events carry only
   * `{stage, progress, message}` — the diagram XML arrives ONLY in the terminal
   * `complete` event (after the charge). Example:
   *
   *     for await (const { event, data } of client.generateStream("AWS 3-tier app")) {
   *       if (event === "progress") console.log(data.progress, data.message);
   *       else if (event === "complete") console.log(data.id, data.usage?.credits_charged);
   *       else if (event === "error") throw new Error(data.error.message);
   *     }
   *
   * `diagramType` works as in `generate`: left out, the server picks.
   */
  async *generateStream(
    prompt: string,
    opts: { cloudProvider?: string; diagramType?: string; opinionated?: boolean; idempotencyKey?: string } = {},
  ): AsyncGenerator<{ event: string; data: any }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "X-Diagrams-Client": this.clientId,
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
    };
    const body = JSON.stringify({
      prompt, cloud_provider: opts.cloudProvider ?? "general",
      diagram_type: opts.diagramType, opinionated: opts.opinionated ?? false,
    });
    const resp = await fetch(this.baseUrl + "/diagrams/stream", { method: "POST", headers, body });
    if (!resp.ok) this.throwErr(resp.status, await resp.text());
    if (!resp.body) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = "message";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev = line.slice(7);
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length) {
          let parsed: any;
          try { parsed = JSON.parse(dataLines.join("")); } catch { continue; /* skip malformed */ }
          // A streamed generation is billable; the terminal event carries `usage`,
          // so record it as a confirmed charge (parity with non-streaming generate()).
          if (ev === "complete") this.track("generate", parsed);
          yield { event: ev, data: parsed };
        }
      }
    }
  }
  get(id: string) { return this.request<Diagram>("GET", `/diagrams/${id}`); }
  list(opts: { limit?: number; cursor?: string } = {}) { return this.request<Page<Diagram>>("GET", "/diagrams", { query: opts }); }
  delete(id: string) { return this.request<void>("DELETE", `/diagrams/${id}`, { raw: true }); }
  update(id: string, patch: { title?: string; isPublic?: boolean; xml?: string }) {
    return this.request("PATCH", `/diagrams/${id}`, { body: { title: patch.title, is_public: patch.isPublic, xml: patch.xml } });
  }
  async edit(id: string, editPrompt: string, opts: { idempotencyKey?: string } = {}) {
    return this.track("edit", await this.requestBillable<Diagram>("POST", `/diagrams/${id}/edit`, {
      action: "edit", body: { edit_prompt: editPrompt }, idempotencyKey: opts.idempotencyKey,
    })) as Diagram;
  }
  async fix(id: string, message: string, opts: { component?: string; warningType?: string; idempotencyKey?: string } = {}) {
    return this.track("fix", await this.requestBillable<Diagram>("POST", `/diagrams/${id}/fix`, {
      action: "fix", body: { message, component: opts.component, warning_type: opts.warningType }, idempotencyKey: opts.idempotencyKey,
    })) as Diagram;
  }
  warnings(id: string) { return this.request<Warning[]>("GET", `/diagrams/${id}/warnings`); }

  // -- async AI re-layout (202 + job_id; poll to completion) --
  /** Start an async AI re-layout. Re-layout is token-billed on **every** run (no
   * free allowance): the API returns `{status:"confirmation_required"}` until you
   * re-call with `{confirm:true}` to accept the charge, which is applied only on
   * delivery of the re-laid diagram (crash = no charge). Idempotent + same-key
   * retried like other billable calls. */
  startRelayout(id: string, opts: { confirm?: boolean; idempotencyKey?: string } = {}) {
    return this.requestBillable<RelayoutJob>("POST", `/diagrams/${id}/relayout`, {
      action: "relayout", query: { confirm: opts.confirm || undefined }, idempotencyKey: opts.idempotencyKey,
    });
  }
  /** Poll a re-layout job. On `status:"done"` with `applied:true`, the result
   * includes the re-laid `xml` + fresh `warnings`/`score`. */
  relayoutStatus(id: string, jobId: string) {
    return this.request<RelayoutStatus>("GET", `/diagrams/${id}/relayout/${jobId}`);
  }
  /** Convenience: start a re-layout and poll until it reaches a terminal state
   * (`done`/`failed`) or `timeoutMs` elapses. If the API asks for confirmation,
   * that response is returned as-is (re-call with `{confirm:true}`). If the poll
   * budget expires the charge may still land on delivery, so it is recorded as
   * `status:"unknown"` in `sessionCharges` before a TIMEOUT is thrown. */
  async relayoutAndWait(id: string, opts: { confirm?: boolean; pollIntervalMs?: number; timeoutMs?: number; idempotencyKey?: string } = {}): Promise<RelayoutJob | RelayoutStatus> {
    const started = await this.startRelayout(id, { confirm: opts.confirm, idempotencyKey: opts.idempotencyKey });
    if (started.status === "confirmation_required" || !started.job_id) return started;
    const chargeable = started.chargeable;   // the server's verdict, echoed on start
    const interval = opts.pollIntervalMs ?? 3000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    let recorded = false;
    try {
      for (;;) {
        const st = await this.relayoutStatus(id, started.job_id);
        if (st.status === "done") {
          // The re-layout charge bills asynchronously and isn't in the poll response,
          // so the exact credits are unknown to this process — usageHistory has them.
          if (chargeable) { this.recordUnknown("relayout", "chargeable re-layout applied; exact credits are in usageHistory"); recorded = true; }
          return st;
        }
        if (st.status === "failed") return st;
        if (Date.now() >= deadline) {
          if (chargeable) { this.recordUnknown("relayout", "chargeable re-layout still running when the wait elapsed; check usageHistory"); recorded = true; }
          throw new DiagramsAPIError("TIMEOUT", "re-layout did not finish in time", 0);
        }
        await new Promise((r) => setTimeout(r, interval));
      }
    } catch (e) {
      // A polling error leaves the outcome unknown: the job may still complete and
      // bill server-side. Record it once (unless already recorded above).
      if (chargeable && !recorded && e instanceof DiagramsAPIError) {
        this.recordUnknown("relayout", "re-layout polling failed; the job may still complete and charge — check usageHistory");
      }
      throw e;
    }
  }
  export(id: string, format: "drawio" | "svg" = "drawio") { return this.request<string>("GET", `/diagrams/${id}/export`, { query: { format }, raw: true }); }
  versions(id: string, opts: { limit?: number; cursor?: string } = {}) { return this.request<Page<any>>("GET", `/diagrams/${id}/versions`, { query: opts }); }
  getVersion(id: string, versionId: string) { return this.request<Diagram>("GET", `/diagrams/${id}/versions/${versionId}`); }
  revert(id: string, opts: { versionId?: string; versionNumber?: number }) {
    return this.request("POST", `/diagrams/${id}/revert`, { body: { version_id: opts.versionId, version_number: opts.versionNumber } });
  }
  /** Import draw.io XML. `diagramType` is sent only when given; left out, the
   * server default applies (`"architecture"` today). */
  import(xml: string, opts: { title?: string; cloudProvider?: string; diagramType?: string } = {}) {
    return this.request("POST", "/diagrams/import", { body: { xml, title: opts.title, cloud_provider: opts.cloudProvider ?? "general", diagram_type: opts.diagramType } });
  }

  // -- gallery --
  searchGallery(opts: { q?: string; cloudProvider?: string; diagramType?: string; source?: "all" | "community" | "library"; limit?: number; cursor?: string } = {}) {
    return this.request<Page<any>>("GET", "/gallery", { query: { q: opts.q, cloud_provider: opts.cloudProvider, diagram_type: opts.diagramType, source: opts.source ?? "all", limit: opts.limit, cursor: opts.cursor } });
  }
  fork(id: string) { return this.request("POST", `/gallery/${id}/fork`); }

  // -- prompts (free) --
  enhancePrompt(prompt: string, opts: { cloudProvider?: string } = {}) { return this.request("POST", "/prompts/enhance", { body: { prompt, cloud_provider: opts.cloudProvider ?? "general" } }); }
  clarifyPrompt(prompt: string) { return this.request("POST", "/prompts/clarify", { body: { prompt } }); }

  // -- account --
  usage() { return this.request("GET", "/usage"); }
  /** One page of the per-task credit-consumption history (how much each task
   * charged), newest first. Returns `{items, next_cursor, has_more, summary}`. */
  usageHistory(filters: UsageHistoryFilters = {}) {
    return this.request<UsageHistoryList>("GET", "/usage/history", { query: {
      limit: filters.limit, cursor: filters.cursor, action: filters.action, source: filters.source,
      diagram_id: filters.diagramId, livemode: filters.livemode,
      from: filters.since, to: filters.until,
      include_grants: filters.includeGrants ? "true" : undefined,
    } });
  }
  /** Yield every history item across pages, auto-following `next_cursor`. */
  async *iterUsageHistory(filters: Omit<UsageHistoryFilters, "cursor"> = {}): AsyncGenerator<UsageHistoryItem> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.usageHistory({ ...filters, cursor });
      for (const item of page.items) yield item;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
  me() { return this.request("GET", "/me"); }
  meta(kind: "diagram-types" | "providers" | "formats" | "features") { return this.request("GET", `/meta/${kind}`); }
}

// ---------------------------------------------------------------------------
// Device-flow login (RFC 8628) + credential cache — node builtins only.
// The cache file is SHARED with the Python SDK (identical JSON contract).
// ---------------------------------------------------------------------------

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const AUTH_CLIENT_ID = "sdk-ts";

/** The on-disk credential cache written by `login()` (v1 contract, shared with
 * the Python SDK — same file, same shape, byte-for-byte compatible). */
export interface StoredCredentials {
  version: 1;
  api_key: string;
  scope?: string | null;
  livemode?: boolean | null;
  auth_method: "device";
  created_at: string;
  expires_at?: string | null;
  base_url: string;
}

export interface LoginOptions {
  /** Mint a test-mode key (`livemode=false`). Test keys charge the same credits
   * as live — not a free sandbox (lower rate limits only). */
  test?: boolean;
  /** API base (defaults to the production API). */
  baseUrl?: string;
  /** Open the verification URL automatically (best-effort). Default true. */
  openBrowser?: boolean;
  /** Email to receive the one-time sign-in code. Defaults to
   * `DIAGRAMS_LOGIN_EMAIL`, or an interactive prompt on a TTY. */
  email?: string;
}

/** `~/.diagrams-so/credentials.json` — same file for every Diagrams.so SDK. */
export function credentialsPath(): string {
  return join(homedir(), ".diagrams-so", "credentials.json");
}

/** Return the cached API key if the cache is well-formed, `version === 1`, and
 * was minted for `baseUrl`. ANY problem (missing, corrupt JSON, wrong version,
 * base mismatch) returns undefined — the cache must never crash a client. */
export function loadCachedApiKey(baseUrl: string): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    if (!creds || typeof creds !== "object" || creds.version !== 1) return undefined;
    if (typeof creds.api_key !== "string" || !creds.api_key) return undefined;
    if (typeof creds.base_url !== "string") return undefined;
    if (creds.base_url.replace(/\/+$/, "") !== baseUrl.replace(/\/+$/, "")) return undefined;
    return creds.api_key;
  } catch {
    return undefined;
  }
}

/** Delete the cached credentials. Idempotent — a missing cache is fine. */
export function logout(): void {
  try {
    unlinkSync(credentialsPath());
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

/** Write the cache ATOMICALLY (tmp file + rename), dir 0700, file 0600. */
function writeCredentials(creds: StoredCredentials): string {
  const path = credentialsPath();
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.credentials-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600); // writeFileSync mode is masked by umask; be explicit
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw e;
  }
  return path;
}

/** Only auto-open https URLs, or http to a loopback host (self-hosted/dev).
 * javascript:/file:/leading-dash tricks are refused — the URL is still printed. */
function isSafeToOpen(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
    return false;
  } catch { return false; }
}

/** Best-effort "open this URL in the default browser". Never throws.
 * Windows uses rundll32's FileProtocolHandler instead of `cmd /c start` —
 * cmd re-parses its argument line, so URL metacharacters (&, ^, ") could
 * inject commands (CVE-2024-27980 class); rundll32 takes plain argv. */
function openUrl(url: string): void {
  if (!isSafeToOpen(url)) return;
  try {
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [url]] :
      process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] :
      ["xdg-open", [url]];
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => { /* headless / no opener — the printed URL still works */ });
    child.unref();
  } catch { /* noop */ }
}

/** Internal seam so tests can observe/skip the poll sleeps. Not public API. */
export const _internal = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

async function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; payload: any }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new DiagramsAuthError(`Could not reach the Diagrams.so API at ${url}. (${e?.message ?? e})`);
  }
  const text = await resp.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  return { status: resp.status, payload };
}

/** Resolve the sign-in email: `DIAGRAMS_LOGIN_EMAIL` wins; otherwise prompt on a
 * TTY. The one-time code is emailed here and the approver's account must match
 * it, so it can't be left to the browser session alone. */
async function promptLoginEmail(): Promise<string> {
  const env = (process.env.DIAGRAMS_LOGIN_EMAIL ?? "").trim();
  if (env) return env;
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((r) => rl.question("Email to receive your sign-in code: ", r))).trim();
  } finally {
    rl.close();
  }
}

/** Tell the server the new key is safely stored, so it revokes this machine's
 * previous key only now — never leaving the account with no valid key.
 * Best-effort: a failure here does not undo a successful login. */
async function confirmDeviceKey(base: string, apiKey: string): Promise<void> {
  try {
    await postJson(base + "/oauth/device/confirm", {}, { Authorization: `Bearer ${apiKey}` });
  } catch { /* best-effort */ }
}

/** Sign in via the OAuth device flow and return a ready `DiagramsClient`.
 *
 * You provide an email; the API emails you a one-time code. A browser opens the
 * (plain) verification page where you sign in — new accounts sign up there — and
 * enter the code, then approve. The code is emailed, never placed in the URL, so
 * a stolen link can't be approved from someone else's browser. On approval the
 * minted API key is cached at `~/.diagrams-so/credentials.json` so
 * `new DiagramsClient()` works with no arguments from then on. */
export async function login(opts: LoginOptions = {}): Promise<DiagramsClient> {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");

  if (opts.test) {
    console.log("Test keys charge the same credits as live — not a free sandbox (lower rate limits only).");
  }

  const email = ((opts.email ?? "").trim()) || (await promptLoginEmail());
  if (!email || !email.includes("@")) {
    throw new DiagramsAuthError(
      "A valid email is required to receive your sign-in code. Pass email or set DIAGRAMS_LOGIN_EMAIL.");
  }

  const { status, payload: code } = await postJson(base + "/oauth/device/code", {
    client_id: AUTH_CLIENT_ID,
    livemode: !opts.test,
    device_name: hostname(),
    email,
  });
  if (status !== 200 || !code?.device_code) {
    throw new DiagramsAuthError(`Could not start device login (HTTP ${status}): ${JSON.stringify(code).slice(0, 200)}`);
  }

  const verificationUri = code.verification_uri ?? "https://diagrams.so/device";
  console.log(`\nWe emailed a sign-in code to ${email}.`);
  console.log(`Open ${verificationUri}, sign in, and enter the code to approve.\n`);
  if (opts.openBrowser !== false) openUrl(verificationUri);

  const deadline = Date.now() + Number(code.expires_in ?? 900) * 1000;
  let intervalMs = Number(code.interval ?? 5) * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new DiagramsAuthError("Login expired before the device was approved — run login again.");
    }
    await _internal.sleep(intervalMs);
    const { status: st, payload: poll } = await postJson(base + "/oauth/device/token", {
      grant_type: GRANT_TYPE,
      device_code: code.device_code,
      client_id: AUTH_CLIENT_ID,
    });
    if (st === 200 && poll?.access_token) {
      const now = new Date();
      const expiresAt = poll.expires_in
        ? new Date(now.getTime() + Number(poll.expires_in) * 1000).toISOString()
        : null;
      const path = writeCredentials({
        version: 1,
        api_key: poll.access_token,
        scope: poll.scope ?? null,
        livemode: poll.livemode ?? !opts.test,
        auth_method: "device",
        created_at: now.toISOString(),
        expires_at: expiresAt,
        base_url: base,
      });
      await confirmDeviceKey(base, poll.access_token);
      console.log(`Logged in. Credentials saved to ${path}`);
      return new DiagramsClient({ apiKey: poll.access_token, baseUrl: base });
    }
    const err = poll?.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { intervalMs += 5_000; continue; } // RFC 8628 §3.5
    if (err === "access_denied") {
      throw new DiagramsAuthError("Login was denied in the browser — no key was created.");
    }
    if (err === "expired_token") {
      throw new DiagramsAuthError("Login expired before the device was approved — run login again.");
    }
    if (err === "key_limit_reached") {
      throw new DiagramsAuthError(
        "You have 25 active keys. Revoke one at https://diagrams.so/api-keys, then re-run login.");
    }
    throw new DiagramsAuthError(`Device login failed (HTTP ${st}): ${err ?? JSON.stringify(poll).slice(0, 200)}`);
  }
}
