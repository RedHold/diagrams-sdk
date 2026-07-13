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
export interface RelayoutJob {
  job_id?: string; status: string; // "pending" | "confirmation_required" | ...
  chargeable?: boolean | null; message?: string; reason?: string;
}
export interface RelayoutStatus {
  job_id: string; status: string; // "pending" | "done" | "failed"
  applied?: boolean | null; reason?: string | null; version_number?: number | null;
  progress: number; xml?: string | null; warnings: Warning[]; score?: Score | null;
}

export interface DiagramsClientOptions { apiKey: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; backoffMs?: number; }

export class DiagramsClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private backoffMs: number;

  constructor(opts: DiagramsClientOptions) {
    if (!opts?.apiKey) throw new Error("apiKey is required (dgz_live_… or dgz_test_…)");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  private async request<T = any>(
    method: string, path: string,
    opts: { query?: Record<string, any>; body?: any; raw?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    // Retry only on 429/503 — pre-processing rejections (rate limit / backpressure),
    // so a retry never double-charges a billable op. Honors Retry-After.
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
      } finally {
        clearTimeout(t);
      }
      if ((resp.status === 429 || resp.status === 503) && attempt < this.maxRetries) {
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

  private idem(key?: string) { return key ? { "Idempotency-Key": key } : undefined; }

  // -- diagrams --
  generate(prompt: string, opts: { cloudProvider?: string; diagramType?: string; opinionated?: boolean; idempotencyKey?: string } = {}) {
    return this.request<Diagram>("POST", "/diagrams", {
      body: { prompt, cloud_provider: opts.cloudProvider ?? "general", diagram_type: opts.diagramType ?? "architecture", opinionated: opts.opinionated ?? false },
      headers: this.idem(opts.idempotencyKey),
    });
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
          try { yield { event: ev, data: JSON.parse(dataLines.join("")) }; } catch { /* skip malformed */ }
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
  edit(id: string, editPrompt: string, opts: { idempotencyKey?: string } = {}) {
    return this.request<Diagram>("POST", `/diagrams/${id}/edit`, { body: { edit_prompt: editPrompt }, headers: this.idem(opts.idempotencyKey) });
  }
  fix(id: string, message: string, opts: { component?: string; warningType?: string; idempotencyKey?: string } = {}) {
    return this.request<Diagram>("POST", `/diagrams/${id}/fix`, {
      body: { message, component: opts.component, warning_type: opts.warningType }, headers: this.idem(opts.idempotencyKey),
    });
  }
  warnings(id: string) { return this.request<Warning[]>("GET", `/diagrams/${id}/warnings`); }

  // -- async AI re-layout (202 + job_id; poll to completion) --
  /** Start an async AI re-layout. The first few per diagram are free; once
   * exhausted the API returns `{status:"confirmation_required"}` — re-call with
   * `{confirm:true}` to accept the credit charge. */
  startRelayout(id: string, opts: { confirm?: boolean } = {}) {
    return this.request<RelayoutJob>("POST", `/diagrams/${id}/relayout`, { query: { confirm: opts.confirm || undefined } });
  }
  /** Poll a re-layout job. On `status:"done"` with `applied:true`, the result
   * includes the re-laid `xml` + fresh `warnings`/`score`. */
  relayoutStatus(id: string, jobId: string) {
    return this.request<RelayoutStatus>("GET", `/diagrams/${id}/relayout/${jobId}`);
  }
  /** Convenience: start a re-layout and poll until it reaches a terminal state
   * (`done`/`failed`) or `timeoutMs` elapses. If the API asks for confirmation,
   * that response is returned as-is (re-call with `{confirm:true}`). */
  async relayoutAndWait(id: string, opts: { confirm?: boolean; pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<RelayoutJob | RelayoutStatus> {
    const started = await this.startRelayout(id, { confirm: opts.confirm });
    if (started.status === "confirmation_required" || !started.job_id) return started;
    const interval = opts.pollIntervalMs ?? 3000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    for (;;) {
      const st = await this.relayoutStatus(id, started.job_id);
      if (st.status === "done" || st.status === "failed") return st;
      if (Date.now() >= deadline) throw new DiagramsAPIError("TIMEOUT", "re-layout did not finish in time", 0);
      await new Promise((r) => setTimeout(r, interval));
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
  me() { return this.request("GET", "/me"); }
  meta(kind: "diagram-types" | "providers" | "formats" | "features") { return this.request("GET", `/meta/${kind}`); }
}
