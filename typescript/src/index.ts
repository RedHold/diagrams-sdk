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
 * Zero runtime dependencies — uses the platform `fetch` (Node ≥ 18, browsers, workers).
 */

export const DEFAULT_BASE = "https://api.diagrams.so/api/v2";
/** Bumped with the package; sent so the API attributes charges to source="sdk-ts". */
export const SDK_VERSION = "1.1.0";

export class DiagramsAPIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(`[${code}] (HTTP ${status}) ${message}`);
    this.name = "DiagramsAPIError";
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
  apiKey: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; backoffMs?: number;
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

  constructor(opts: DiagramsClientOptions) {
    if (!opts?.apiKey) throw new Error("apiKey is required (dgz_live_… or dgz_test_…)");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
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
      throw new DiagramsAPIError(e.code ?? "ERROR", e.message ?? text ?? "request failed", resp.status, e.request_id);
    }
    return payload as T;
  }

  private throwErr(status: number, text: string): never {
    let e: any = {};
    try { e = (JSON.parse(text) || {}).error || {}; } catch { /* noop */ }
    throw new DiagramsAPIError(e.code ?? "ERROR", e.message ?? text ?? "request failed", status, e.request_id);
  }

  // -- diagrams --
  async generate(prompt: string, opts: { cloudProvider?: string; diagramType?: string; opinionated?: boolean; idempotencyKey?: string } = {}) {
    return this.track("generate", await this.requestBillable<Diagram>("POST", "/diagrams", {
      action: "generate",
      body: { prompt, cloud_provider: opts.cloudProvider ?? "general", diagram_type: opts.diagramType ?? "architecture", opinionated: opts.opinionated ?? false },
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
      diagram_type: opts.diagramType ?? "architecture", opinionated: opts.opinionated ?? false,
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
  import(xml: string, opts: { title?: string; cloudProvider?: string; diagramType?: string } = {}) {
    return this.request("POST", "/diagrams/import", { body: { xml, title: opts.title, cloud_provider: opts.cloudProvider ?? "general", diagram_type: opts.diagramType ?? "architecture" } });
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
