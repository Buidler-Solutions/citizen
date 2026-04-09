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

  private async fetchJson<T>(endpoint: string): Promise<ApiSource<T>> {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
    }

    const data = (await response.json()) as T;
    return { source: endpoint, data };
  }
}
