import { Injectable } from '@nestjs/common';

type ApiSource<T> = {
  source: string;
  data: T;
};

type BlockLookup = {
  height: number;
  block: {
    header: {
      height: number;
      prev_hash: string;
      entry_root: string;
      proposer: string;
      timestamp: number;
      commit_proof: {
        aggregated_signature: string;
        participant_ids: string[];
      };
    };
    entries: unknown[];
  } | null;
};

type NamespaceEntries = {
  namespace: string;
  entries: Array<{
    entry_id: string;
    namespace: string;
    action: string;
    object_id?: string;
    payload: Record<string, unknown>;
    author: string;
    signature: string;
    timestamp: number;
  }>;
};

type ReceiptLookup = {
  receipt: {
    receipt_id: string;
    envelope_id: string;
    status: string;
    validation: {
      namespace: string;
      action: string;
      outcome: string;
    };
    finality: {
      block_height: number;
      block_hash: string;
      commit_proof: {
        aggregated_signature: string;
        participant_ids: string[];
      };
    } | null;
    recorded_at: string;
  };
};

@Injectable()
export class CitizenService {
  private readonly baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://localhost:8080';

  async getStatus() {
    return {
      node: this.baseUrl,
      timestamp: Date.now(),
    };
  }

  async getBlock(height: number): Promise<ApiSource<BlockLookup>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks/${height}`;
    return this.fetchJson<BlockLookup>(endpoint);
  }

  async getEntries(namespace: string): Promise<ApiSource<NamespaceEntries>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/entries/${namespace}`;
    return this.fetchJson<NamespaceEntries>(endpoint);
  }

  async getReceipt(receiptId: string): Promise<ApiSource<ReceiptLookup>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/receipts/${receiptId}`;
    return this.fetchJson<ReceiptLookup>(endpoint);
  }

  private async fetchJson<T>(endpoint: string): Promise<ApiSource<T>> {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
    }

    const data = (await response.json()) as T;
    return { source: endpoint, data };
  }
}
