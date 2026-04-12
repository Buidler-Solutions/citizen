import { BadRequestException, Injectable } from '@nestjs/common';

type ApiSource<T> = {
  source: string;
  data: T;
};

type BlockHeader = {
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

type BlockData = {
  header: BlockHeader;
  entries: unknown[];
};

type BlockLookup = {
  height: number;
  block: BlockData | null;
};

type BlocksPageResponse = {
  items: Array<{
    height: number;
    header: BlockHeader;
    entry_count: number;
  }>;
  next_cursor: string | null;
  has_more: boolean;
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

type WalletSignerEntry = NamespaceEntries['entries'][number] & {
  payload: NamespaceEntries['entries'][number]['payload'] & {
    payload_wallet_signature?: {
      signer?: string;
    };
    wallet_signature?: {
      signer?: string;
    };
  };
};

type WalletSignerEntries = {
  namespace: string;
  wallet_signer: string;
  total_entries: number;
  matched_entries: number;
  entries: WalletSignerEntry[];
};

type FileManifestMetadata = {
  manifest_id: string;
  namespace: string;
  object_id: string;
  committed_at: number;
  encryption_mode: string | null;
  ciphertext_hash: string | null;
  payload_commitment: string | null;
  consent_receipt_ref: string | null;
  consent_state: string;
  consent_state_reason: string | null;
  revoked_readers: string[];
};

type FileTimelineResponse = {
  manifest: FileManifestMetadata;
  events: Array<{
    timestamp: number;
    event_type: string;
    detail: string;
  }>;
};

type PayloadFieldRefs = {
  entry_id: string;
  namespace: string;
  field_refs: Array<{
    field_path: string;
    blob_ref: string;
    ciphertext_hash: string;
    payload_commitment: string;
  }>;
};

type PayloadDataHashLookup = {
  data_hash: string;
  matches: Array<{
    entry_id: string;
    namespace: string;
    field_path: string;
    committed_at: number;
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
  private readonly baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://127.0.0.1:8081';

  async getStatus() {
    return {
      node: this.baseUrl,
      timestamp: Date.now(),
    };
  }

  async getBlocks(cursor?: string, limitRaw?: string): Promise<ApiSource<BlocksPageResponse>> {
    const limit = this.parseLimit(limitRaw);
    const requestedStartHeight = this.parseCursor(cursor);
    const latestHeight = await this.findLatestHeight();

    if (latestHeight < 0) {
      return {
        source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
        data: {
          items: [],
          next_cursor: null,
          has_more: false,
        },
      };
    }

    const startHeight = requestedStartHeight === null ? latestHeight : Math.min(requestedStartHeight, latestHeight);

    if (startHeight < 0) {
      return {
        source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
        data: {
          items: [],
          next_cursor: null,
          has_more: false,
        },
      };
    }

    const items: BlocksPageResponse['items'] = [];
    let nextHeight = startHeight;

    while (nextHeight >= 0 && items.length < limit) {
      const lookup = await this.fetchBlockOrNull(nextHeight);
      if (lookup?.block) {
        items.push({
          height: lookup.height,
          header: lookup.block.header,
          entry_count: lookup.block.entries.length,
        });
      }
      nextHeight -= 1;
    }

    const hasMore = nextHeight >= 0;

    return {
      source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
      data: {
        items,
        next_cursor: hasMore ? String(nextHeight) : null,
        has_more: hasMore,
      },
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

  async getEntriesByWalletSigner(
    namespace: string,
    signerDid: string,
  ): Promise<ApiSource<WalletSignerEntries>> {
    const entries = await this.getEntries(namespace);
    const normalizedSigner = signerDid.trim().toLowerCase();
    const filteredEntries = entries.data.entries.filter((entry) => {
      const payloadWalletSignature = entry.payload.payload_wallet_signature;
      const legacyWalletSignature = entry.payload.wallet_signature;
      const signerCandidate =
        payloadWalletSignature && typeof payloadWalletSignature === 'object'
          ? (payloadWalletSignature as { signer?: unknown }).signer
          : legacyWalletSignature && typeof legacyWalletSignature === 'object'
            ? (legacyWalletSignature as { signer?: unknown }).signer
            : null;
      if (typeof signerCandidate !== 'string') {
        return false;
      }
      return signerCandidate.trim().toLowerCase() === normalizedSigner;
    }) as WalletSignerEntry[];

    return {
      source: entries.source,
      data: {
        namespace,
        wallet_signer: signerDid,
        total_entries: entries.data.entries.length,
        matched_entries: filteredEntries.length,
        entries: filteredEntries,
      },
    };
  }

  async getReceipt(receiptId: string): Promise<ApiSource<ReceiptLookup>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/receipts/${receiptId}`;
    return this.fetchJson<ReceiptLookup>(endpoint);
  }

  async getPayloadFieldRefs(entryId: string, namespace: string): Promise<ApiSource<PayloadFieldRefs>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/payloads/fields/${encodeURIComponent(entryId)}/${encodeURIComponent(namespace)}`;
    return this.fetchJson<PayloadFieldRefs>(endpoint);
  }

  async getPayloadDataHash(dataHash: string): Promise<ApiSource<PayloadDataHashLookup>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/payloads/data-hash/${encodeURIComponent(dataHash)}`;
    return this.fetchJson<PayloadDataHashLookup>(endpoint);
  }

  async getFileManifest(manifestId: string): Promise<ApiSource<FileManifestMetadata>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/files/manifests/${manifestId}`;
    return this.fetchJson<FileManifestMetadata>(endpoint);
  }

  async getFileTimeline(manifestId: string): Promise<ApiSource<FileTimelineResponse>> {
    const manifest = await this.getFileManifest(manifestId);
    const [namespaceEntries, consentEntries] = await Promise.all([
      this.getEntries(manifest.data.namespace),
      manifest.data.consent_receipt_ref
        ? this.getEntries('consent.receipt')
        : Promise.resolve<ApiSource<NamespaceEntries> | null>(null),
    ]);

    const namespaceEvents = namespaceEntries.data.entries
      .filter((entry) => {
        const payloadManifestId =
          typeof entry.payload.manifest_id === 'string'
            ? entry.payload.manifest_id
            : null;
        return (
          entry.object_id === manifest.data.object_id ||
          payloadManifestId === manifest.data.manifest_id
        );
      })
      .map((entry) => ({
        timestamp: entry.timestamp,
        event_type: entry.action,
        detail: `namespace=${entry.namespace} author=${entry.author}`,
      }));

    const consentEvents = (consentEntries?.data.entries ?? [])
      .filter((entry) => {
        const payload = entry.payload;
        const receiptId =
          typeof payload.receipt_id === 'string' ? payload.receipt_id : null;
        return receiptId === manifest.data.consent_receipt_ref;
      })
      .map((entry) => ({
        timestamp: entry.timestamp,
        event_type: 'CONSENT_RECEIPT_EVENT',
        detail: `action=${entry.action} receipt=${manifest.data.consent_receipt_ref}`,
      }));

    const derivedStateEvent = {
      timestamp: manifest.data.committed_at,
      event_type: 'CONSENT_STATE',
      detail: `${manifest.data.consent_state}${
        manifest.data.consent_state_reason
          ? ` (${manifest.data.consent_state_reason})`
          : ''
      }`,
    };

    const events = [...namespaceEvents, ...consentEvents, derivedStateEvent].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    return {
      source: `${manifest.source} + ${namespaceEntries.source}`,
      data: {
        manifest: manifest.data,
        events,
      },
    };
  }

  private parseLimit(limitRaw?: string): number {
    if (limitRaw === undefined) {
      return 20;
    }

    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }

    return parsed;
  }

  private parseCursor(cursor?: string): number | null {
    if (!cursor) {
      return null;
    }

    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException('cursor must be a non-negative integer block height');
    }

    return parsed;
  }

  private async findLatestHeight(): Promise<number> {
    const heightZeroBlock = await this.fetchBlockOrNull(0);
    const heightOneBlock = await this.fetchBlockOrNull(1);

    if (!heightZeroBlock?.block && !heightOneBlock?.block) {
      return -1;
    }

    let lowerBound = heightOneBlock?.block ? 1 : 0;
    let upperBound = lowerBound;

    while (true) {
      const candidate = Math.max(upperBound * 2, upperBound + 1);
      const block = await this.fetchBlockOrNull(candidate);
      if (!block?.block) {
        upperBound = candidate;
        break;
      }

      lowerBound = candidate;
      upperBound = candidate;
    }

    let left = lowerBound;
    let right = upperBound;

    while (left + 1 < right) {
      const mid = Math.floor((left + right) / 2);
      const block = await this.fetchBlockOrNull(mid);
      if (block?.block) {
        left = mid;
      } else {
        right = mid;
      }
    }

    return left;
  }

  private async fetchBlockOrNull(height: number): Promise<BlockLookup | null> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks/${height}`;
    const response = await fetch(endpoint);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
    }

    return (await response.json()) as BlockLookup;
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
