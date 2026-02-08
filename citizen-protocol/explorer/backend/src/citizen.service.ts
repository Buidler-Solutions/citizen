import { Injectable } from '@nestjs/common';

type CitizenBlock = {
  height: number;
  prev_hash: string;
  entry_root: string;
  proposer: string;
  timestamp: number;
  commit_proof: string;
};

type CitizenEntry = {
  entry_id: string;
  namespace: string;
  action: string;
  object_id?: string;
  payload: Record<string, unknown>;
  author: string;
  signature: string;
  timestamp: number;
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

  async getBlocks(): Promise<{ source: string; blocks: CitizenBlock[] }> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks`;
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Citizen node responded with ${response.status}`);
      }
      const blocks = (await response.json()) as CitizenBlock[];
      return { source: endpoint, blocks };
    } catch (error) {
      return {
        source: endpoint,
        blocks: [
          {
            height: 0,
            prev_hash: 'GENESIS',
            entry_root: 'mock-entry-root',
            proposer: 'mock-validator',
            timestamp: Math.floor(Date.now() / 1000),
            commit_proof: 'mock-proof',
          },
        ],
      };
    }
  }

  async getEntries(): Promise<{ source: string; entries: CitizenEntry[] }> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/entries`;
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Citizen node responded with ${response.status}`);
      }
      const entries = (await response.json()) as CitizenEntry[];
      return { source: endpoint, entries };
    } catch (error) {
      return {
        source: endpoint,
        entries: [
          {
            entry_id: 'mock-entry',
            namespace: 'governance.vote',
            action: 'CAST_VOTE',
            object_id: 'GOV-000',
            payload: { vote: 'YES' },
            author: 'did:validator:mock',
            signature: 'mock-signature',
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };
    }
  }
}
