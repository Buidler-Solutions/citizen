/**
 * HTTP client for a Citizen node API. Wraps the canonical paths used by
 * TreasureNet Citizen Edition:
 *
 * - POST /api/v1/entries/submit        (signed ledger entries)
 * - POST /api/v1/modules/:id/execute   (WASM module invocations)
 * - GET  /api/v1/modules/:id           (module runtime state)
 * - GET  /api/v1/receipts/:id          (finality receipts)
 * - GET  /entries/:namespace           (entry reads for the indexer)
 * - GET  /blocks                       (block listing for the indexer)
 * - GET  /api/v1/ctzn/:id/check/:did   (soulbound reward token ownership)
 */

export interface SubmitResponse {
  status: number;
  receipt_id?: string;
  block_height?: number;
  entry_hash?: string;
  error?: string;
}

export interface ModuleExecuteResponse {
  module_id: string;
  success: boolean;
  result?: Record<string, unknown> & { ok?: boolean; error?: string };
  gas_consumed?: number;
  logs?: string[];
  error?: string;
}

export class CitizenNodeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey, ...extra } : { ...extra };
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> }
  ): Promise<T> {
    const headers = this.authHeaders(init?.headers);
    if (init?.body) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const message =
        (parsed as { error?: string }).error ?? `HTTP ${response.status} on ${path}`;
      throw new Error(`citizen node: ${message}`);
    }
    return parsed as T;
  }

  async submitEntry(entry: unknown): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("/api/v1/entries/submit", {
      method: "POST",
      body: entry,
    });
  }

  async executeModule(
    moduleId: string,
    params: Record<string, unknown>,
    gasLimit = 1_000_000
  ): Promise<ModuleExecuteResponse> {
    return this.request<ModuleExecuteResponse>(
      `/api/v1/modules/${encodeURIComponent(moduleId)}/execute`,
      { method: "POST", body: { ...params, gas_limit: gasLimit } }
    );
  }

  async getModuleRuntime(moduleId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api/v1/modules/${encodeURIComponent(moduleId)}`
    );
  }

  async getReceipt(receiptId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api/v1/receipts/${encodeURIComponent(receiptId)}`
    );
  }

  async listEntries(namespace: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/entries/${encodeURIComponent(namespace)}`
    );
  }

  async listBlocks(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/blocks?limit=100");
  }

  /** Soulbound CTZN token ownership check for a DID. */
  async checkCtzn(moduleId: string, did: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/api/v1/ctzn/${encodeURIComponent(moduleId)}/check/${encodeURIComponent(did)}`
    );
  }

  getCtznBalance(moduleId: string, did: string): Promise<Record<string, unknown>> {
    return this.checkCtzn(moduleId, did);
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ── off-chain encrypted files (gap 3) ──

  async createFileIntent(body: unknown): Promise<{
    intent_id: string;
    upload: { object_ref: string; upload_url: string; expires_at: number };
    constraints?: Record<string, unknown>;
  }> {
    return this.request("/api/v1/files/intents", { method: "POST", body });
  }

  async uploadCiphertext(uploadUrl: string, bytes: Uint8Array): Promise<{
    ciphertext_hash: string;
  }> {
    const url = uploadUrl.startsWith("/") ? `${this.baseUrl}${uploadUrl}` : uploadUrl;
    const headers = this.authHeaders({ "Content-Type": "application/octet-stream" });
    const response = await fetch(url, { method: "PUT", headers, body: bytes as unknown as BodyInit });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`citizen node: upload failed HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }

  async commitFile(
    body: unknown,
    idempotencyKey: string
  ): Promise<{ manifest_id: string; manifest_commitment: string }> {
    return this.request("/api/v1/files/commit", {
      method: "POST",
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  async readFile(body: unknown): Promise<{
    manifest_id: string;
    file_ref: string;
    ciphertext_hash: string;
  }> {
    return this.request("/api/v1/files/read", { method: "POST", body });
  }

  async revokeFileReader(body: unknown): Promise<{ status: string }> {
    return this.request("/api/v1/files/revoke", { method: "POST", body });
  }

  /** Fetch local-store ciphertext by object_ref (path form `/api/v1/files/local/...`). */
  async downloadCiphertext(path: string): Promise<{ ciphertext_b64: string }> {
    return this.request(path);
  }

  async fileAlerts(): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ alerts?: Array<Record<string, unknown>> }>(
      "/api/v1/files/alerts"
    );
    return result.alerts ?? [];
  }
}
