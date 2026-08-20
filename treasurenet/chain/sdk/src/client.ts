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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
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
}
