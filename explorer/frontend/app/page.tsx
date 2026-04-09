export const dynamic = 'force-dynamic';

type BlockResponse = {
  source: string;
  data: {
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
};

type EntryResponse = {
  source: string;
  data: {
    namespace: string;
    entries: {
      entry_id: string;
      namespace: string;
      action: string;
      object_id?: string;
      payload: Record<string, unknown>;
      author: string;
      signature: string;
      timestamp: number;
      privacy_flag?: boolean;
      privacy_mode?: string;
      payload_commitment?: string;
      consent_receipt?: {
        granted_at?: number;
        expires_at?: number;
        policy_ref?: string;
        subject_did?: string;
        authorized_readers?: string[];
      };
      authorized_readers?: string[];
      key_wrapped_secrets?: {
        reader_id: string;
        wrap_algorithm: string;
      }[];
    }[];
  };
};

type WalletSignerEntryResponse = {
  source: string;
  data: {
    namespace: string;
    wallet_signer: string;
    total_entries: number;
    matched_entries: number;
    entries: {
      entry_id: string;
      namespace: string;
      action: string;
      object_id?: string;
      payload: Record<string, unknown>;
      author: string;
      signature: string;
      timestamp: number;
    }[];
  };
};

type ReceiptResponse = {
  source: string;
  data: {
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
        };
      } | null;
      recorded_at: string;
    };
  };
};

type FileManifestResponse = {
  source: string;
  data: {
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
};

function consentTone(consentState: string): 'ok' | 'warn' {
  return consentState === 'active' ? 'ok' : 'warn';
}

function revocationTone(revokedReaders: string[]): 'ok' | 'warn' {
  return revokedReaders.length === 0 ? 'ok' : 'warn';
}

function toReadableDate(epochSeconds: number | undefined): string {
  if (!epochSeconds) return 'N/A';
  return new Date(epochSeconds * 1000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

function shortHash(value: string | undefined, visible = 10): string {
  if (!value) return 'N/A';
  if (value.length <= visible * 2 + 3) return value;
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function privacyRiskTone(
  entry: EntryResponse['data']['entries'][number] | undefined,
): 'ok' | 'warn' {
  if (!entry) return 'warn';
  const hasConsent = Boolean(entry.consent_receipt?.policy_ref);
  const hasReaders = (entry.authorized_readers?.length ?? 0) > 0;
  return entry.privacy_flag && hasConsent && hasReaders ? 'ok' : 'warn';
}

type FileTimelineResponse = {
  source: string;
  data: {
    manifest: {
      manifest_id: string;
      namespace: string;
      object_id: string;
      committed_at: number;
      consent_state: string;
      consent_state_reason: string | null;
      revoked_readers: string[];
    };
    events: Array<{
      timestamp: number;
      event_type: string;
      detail: string;
    }>;
  };
};



type PayloadFieldRefsResponse = {
  source: string;
  data: {
    entry_id: string;
    namespace: string;
    field_refs: Array<{
      field_path: string;
      blob_ref: string;
      ciphertext_hash: string;
      payload_commitment: string;
    }>;
  };
};


type AssetPositionsResponse = {
  source: string;
  data: {
    account_id: string;
    positions: {
      issuer: string;
      asset_code: string;
      held_amount: number;
      holder_notice: string;
      trustline: {
        status: string;
        policy_flags: string[];
        disclosure: { mode: string; commitment?: string };
      };
    }[];
  };
};

type StatusResponse = {
  node: string;
  timestamp: number;
};

const nodeRuntimeBase = process.env.NEXT_PUBLIC_NODE_RUNTIME_URL ?? 'http://127.0.0.1:8081';

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { next: { revalidate: 5 } });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
const blockHeight = Number(process.env.NEXT_PUBLIC_BLOCK_HEIGHT ?? '1');
const namespace = process.env.NEXT_PUBLIC_NAMESPACE ?? 'governance.vote';
const receiptId = process.env.NEXT_PUBLIC_RECEIPT_ID;
const assetAccountId = process.env.NEXT_PUBLIC_ASSET_ACCOUNT_ID ?? 'did:ledger:alice';
const fileManifestId = process.env.NEXT_PUBLIC_FILE_MANIFEST_ID;
const payloadEntryId = process.env.NEXT_PUBLIC_PAYLOAD_ENTRY_ID;
const payloadNamespace = process.env.NEXT_PUBLIC_PAYLOAD_NAMESPACE;
const walletSignerDid = process.env.NEXT_PUBLIC_WALLET_SIGNER_DID;

async function loadBlock(): Promise<BlockResponse | null> {
  return safeFetchJson<BlockResponse>(`${nodeRuntimeBase}/blocks/${blockHeight}`);
}

async function loadEntries(): Promise<EntryResponse | null> {
  return safeFetchJson<EntryResponse>(`${nodeRuntimeBase}/entries/${namespace}`);
}

async function loadWalletSignerEntries(
  namespaceName: string,
  signerDid: string,
): Promise<WalletSignerEntryResponse | null> {
  return safeFetchJson<WalletSignerEntryResponse>(
    `${nodeRuntimeBase}/entries/${encodeURIComponent(namespaceName)}/wallet-signers/${encodeURIComponent(signerDid)}`
  );
}

async function loadReceipt(id: string): Promise<ReceiptResponse | null> {
  return safeFetchJson<ReceiptResponse>(`${nodeRuntimeBase}/receipts/${id}`);
}

async function loadFileManifest(manifestId: string): Promise<FileManifestResponse | null> {
  return safeFetchJson<FileManifestResponse>(
    `${nodeRuntimeBase}/files/manifests/${encodeURIComponent(manifestId)}`
  );
}



async function loadFileTimeline(manifestId: string): Promise<FileTimelineResponse | null> {
  return safeFetchJson<FileTimelineResponse>(
    `${nodeRuntimeBase}/files/timeline/${encodeURIComponent(manifestId)}`
  );
}

async function loadPayloadFieldRefs(
  entryId: string,
  namespaceName: string,
): Promise<PayloadFieldRefsResponse | null> {
  return safeFetchJson<PayloadFieldRefsResponse>(
    `${nodeRuntimeBase}/payloads/fields/${encodeURIComponent(entryId)}/${encodeURIComponent(namespaceName)}`
  );
}

async function loadAssetPositions(accountId: string): Promise<AssetPositionsResponse | null> {
  return safeFetchJson<AssetPositionsResponse>(`${nodeRuntimeBase}/assets/${encodeURIComponent(accountId)}`);
}

async function loadStatus(): Promise<StatusResponse | null> {
  return safeFetchJson<StatusResponse>(`${nodeRuntimeBase}/status`);
}

export default async function HomePage() {
  const [status, block, entries, walletSignerEntries, receipt, fileManifest, fileTimeline, payloadFieldRefs, assetPositions] = await Promise.all([
    loadStatus(),
    loadBlock(),
    loadEntries(),
    walletSignerDid
      ? loadWalletSignerEntries(namespace, walletSignerDid)
      : Promise.resolve(null),
    receiptId ? loadReceipt(receiptId) : Promise.resolve(null),
    fileManifestId ? loadFileManifest(fileManifestId) : Promise.resolve(null),
    fileManifestId ? loadFileTimeline(fileManifestId) : Promise.resolve(null),
    payloadEntryId && payloadNamespace
      ? loadPayloadFieldRefs(payloadEntryId, payloadNamespace)
      : Promise.resolve(null),
    loadAssetPositions(assetAccountId),
  ]);
  const blockData = block?.data;
  const entriesData = entries?.data;
  const walletSignerData = walletSignerEntries?.data;
  const receiptData = receipt?.data?.receipt;
  const fileManifestData = fileManifest?.data;
  const fileTimelineData = fileTimeline?.data;
  const payloadFieldRefsData = payloadFieldRefs?.data;
  const assetPositionsData = assetPositions?.data;
  const latestNamespaceEntry = entriesData?.entries?.[0];

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Citizen Protocol</p>
          <h1>Citizen Explorer</h1>
          <p className="subtitle">
            Canonical API explorer for deterministic receipts, finality proofs, and builder-issued asset policy disclosures.
          </p>
        </div>
        <div className="meta">
          <div>
            <span className="label">Node Runtime</span>
            <span>{status?.node ?? block?.source ?? nodeRuntimeBase}</span>
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Block {blockData?.height ?? blockHeight}</h2>
          {blockData?.block ? (
            <ul>
              <li>
                <div className="row">
                  <span>Proposer</span>
                  <strong>{blockData.block.header.proposer}</strong>
                </div>
                <div className="row">
                  <span>Entry Root</span>
                  <strong className="mono">{blockData.block.header.entry_root}</strong>
                </div>
                <div className="row">
                  <span>Commit Signature</span>
                  <strong className="mono">
                    {blockData.block.header.commit_proof.aggregated_signature}
                  </strong>
                </div>
              </li>
            </ul>
          ) : (
            <p>
              {block ? 'No block found at this height.' : 'Block data unavailable. Confirm the API service is running and reachable.'}
            </p>
          )}
        </div>

        <div className="card">
          <h2>Namespace Entries ({entriesData?.namespace ?? namespace})</h2>
          {(entriesData?.entries ?? []).length > 0 ? (
            <ul>
              {(entriesData?.entries ?? []).map((entry) => (
              <li key={entry.entry_id}>
                <div className="row">
                  <span>Action</span>
                  <strong>{entry.action}</strong>
                </div>
                <div className="row">
                  <span>Author</span>
                  <strong className="mono">{entry.author}</strong>
                </div>
              </li>
              ))}
            </ul>
          ) : (
            <p>
              {entries
                ? 'No namespace entries available.'
                : 'Namespace entries unavailable. Confirm the API service is running and reachable.'}
            </p>
          )}
        </div>

        <div className="card card-wide">
          <h2>Onboarding Ledger UX View</h2>
          {latestNamespaceEntry ? (
            <>
              <p className="subtitle">
                Structured explorer view for privacy-preserving onboarding commitments.
              </p>
              <div className="kpi-grid">
                <div className="kpi">
                  <span className="label">Entry ID</span>
                  <strong className="mono">{shortHash(latestNamespaceEntry.entry_id)}</strong>
                </div>
                <div className="kpi">
                  <span className="label">Action</span>
                  <strong>{latestNamespaceEntry.action}</strong>
                </div>
                <div className="kpi">
                  <span className="label">Privacy</span>
                  <strong className={`status-chip ${privacyRiskTone(latestNamespaceEntry)}`}>
                    {latestNamespaceEntry.privacy_mode ?? 'not-specified'}
                  </strong>
                </div>
                <div className="kpi">
                  <span className="label">Readers</span>
                  <strong>{latestNamespaceEntry.authorized_readers?.length ?? 0}</strong>
                </div>
              </div>

              <ul className="section-list">
                <li>
                  <h3>Consent lifecycle</h3>
                  <div className="row">
                    <span>Granted At</span>
                    <strong>{toReadableDate(latestNamespaceEntry.consent_receipt?.granted_at)}</strong>
                  </div>
                  <div className="row">
                    <span>Expires At</span>
                    <strong>{toReadableDate(latestNamespaceEntry.consent_receipt?.expires_at)}</strong>
                  </div>
                  <div className="row">
                    <span>Policy Ref</span>
                    <strong className="mono">{latestNamespaceEntry.consent_receipt?.policy_ref ?? 'N/A'}</strong>
                  </div>
                  <div className="row">
                    <span>Subject DID</span>
                    <strong className="mono">
                      {shortHash(latestNamespaceEntry.consent_receipt?.subject_did)}
                    </strong>
                  </div>
                </li>

                <li>
                  <h3>Commitment & object tracking</h3>
                  <div className="row">
                    <span>Object ID</span>
                    <strong className="mono">{shortHash(latestNamespaceEntry.object_id, 14)}</strong>
                  </div>
                  <div className="row">
                    <span>Payload Commitment</span>
                    <strong className="mono">{shortHash(latestNamespaceEntry.payload_commitment, 14)}</strong>
                  </div>
                  <div className="row">
                    <span>Recorded At</span>
                    <strong>{toReadableDate(latestNamespaceEntry.timestamp)}</strong>
                  </div>
                </li>

                <li>
                  <h3>Reader-access envelope</h3>
                  {(latestNamespaceEntry.key_wrapped_secrets ?? []).length > 0 ? (
                    <div className="stack">
                      {(latestNamespaceEntry.key_wrapped_secrets ?? []).map((secret) => (
                        <div className="subrow" key={secret.reader_id}>
                          <span className="mono">{shortHash(secret.reader_id, 12)}</span>
                          <span>{secret.wrap_algorithm}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="privacy-note">No wrapped reader keys were returned for this entry.</p>
                  )}
                </li>
              </ul>
            </>
          ) : (
            <p>
              No onboarding-style entry was found in this namespace. Submit ledger data with consent metadata to unlock this UX panel.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Deterministic Receipt</h2>
          {receiptData ? (
            <ul>
              <li>
                <div className="row">
                  <span>Status</span>
                  <strong>{receiptData.status}</strong>
                </div>
                <div className="row">
                  <span>Namespace</span>
                  <strong>{receiptData.validation.namespace}</strong>
                </div>
                <div className="row">
                  <span>Finality Height</span>
                  <strong>{receiptData.finality?.block_height ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Block Hash</span>
                  <strong className="mono">
                    {receiptData.finality?.block_hash ?? 'N/A'}
                  </strong>
                </div>
              </li>
            </ul>
          ) : (
            <p>
              {receiptId
                ? 'Receipt data unavailable. Confirm the API service is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_RECEIPT_ID</code> to inspect canonical receipt finality proofs.</>}
            </p>
          )}
        </div>

        <div className="card">
          <h2>Wallet Signer Index View</h2>
          {walletSignerData ? (
            <>
              <p className="subtitle">
                Signer: <code>{walletSignerData.wallet_signer}</code>
              </p>
              <p className="privacy-note">
                Matched {walletSignerData.matched_entries} of {walletSignerData.total_entries} entries in namespace{' '}
                <code>{walletSignerData.namespace}</code>.
              </p>
              {(walletSignerData.entries ?? []).length > 0 ? (
                <ul>
                  {walletSignerData.entries.map((entry) => (
                    <li key={entry.entry_id}>
                      <div className="row">
                        <span>Entry ID</span>
                        <strong className="mono">{entry.entry_id}</strong>
                      </div>
                      <div className="row">
                        <span>Action</span>
                        <strong>{entry.action}</strong>
                      </div>
                      <div className="row">
                        <span>Author</span>
                        <strong className="mono">{entry.author}</strong>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No entries found for this wallet signer in the selected namespace.</p>
              )}
            </>
          ) : (
            <p>
              {walletSignerDid
                ? 'Wallet-signer index unavailable. Confirm the node runtime is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_WALLET_SIGNER_DID</code> to inspect entries by <code>payload.payload_wallet_signature.signer</code>.</>}
            </p>
          )}
        </div>


        <div className="card">
          <h2>Encrypted File Manifest Metadata</h2>
          {fileManifestData ? (
            <ul>
              <li>
                <div className="row">
                  <span>Manifest ID</span>
                  <strong className="mono">{fileManifestData.manifest_id}</strong>
                </div>
                <div className="row">
                  <span>Namespace</span>
                  <strong>{fileManifestData.namespace}</strong>
                </div>
                <div className="row">
                  <span>Encryption mode</span>
                  <strong>{fileManifestData.encryption_mode ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Ciphertext hash</span>
                  <strong className="mono">{fileManifestData.ciphertext_hash ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Consent state</span>
                  <strong className={`status-chip ${consentTone(fileManifestData.consent_state)}`}>
                    {fileManifestData.consent_state}
                  </strong>
                </div>
                <div className="row">
                  <span>Revoked readers</span>
                  <strong className={`status-chip ${revocationTone(fileManifestData.revoked_readers)}`}>
                    {fileManifestData.revoked_readers.length}
                  </strong>
                </div>
                <p className="privacy-note">
                  Privacy label:{' '}
                  <strong>
                    {fileManifestData.consent_state === 'active'
                      ? 'Grant-active encrypted object (metadata only)'
                      : 'Revoked/invalid grant state — do not serve plaintext'}
                  </strong>
                </p>
              </li>
            </ul>
          ) : (
            <p>
              {fileManifestId
                ? 'Manifest metadata unavailable. Confirm the API service is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_FILE_MANIFEST_ID</code> to inspect encrypted file manifest hashes and consent status.</>}
            </p>
          )}
        </div>



        <div className="card">
          <h2>Encrypted File Consent & Revocation Timeline</h2>
          {fileTimelineData ? (
            <>
              <p className="subtitle">
                Manifest: <code>{fileTimelineData.manifest.manifest_id}</code>
              </p>
              {(fileTimelineData.events ?? []).length > 0 ? (
                <ul>
                  {fileTimelineData.events.map((event, index) => (
                    <li key={`${event.event_type}-${event.timestamp}-${index}`}>
                      <div className="row">
                        <span>Timestamp</span>
                        <strong>{event.timestamp}</strong>
                      </div>
                      <div className="row">
                        <span>Event</span>
                        <strong>{event.event_type}</strong>
                      </div>
                      <p className="privacy-note">{event.detail}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No consent/revocation timeline events found for this manifest.</p>
              )}
            </>
          ) : (
            <p>
              {fileManifestId
                ? 'Timeline data unavailable. Confirm the API service is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_FILE_MANIFEST_ID</code> to inspect encrypted-file consent and revocation transitions.</>}
            </p>
          )}
        </div>

        <div className="card">
          <h2>Encrypted Payload Field References</h2>
          {payloadFieldRefsData ? (
            <>
              <p className="subtitle">
                Entry: <code>{payloadFieldRefsData.entry_id}</code>
              </p>
              <ul>
                {(payloadFieldRefsData.field_refs ?? []).map((fieldRef) => (
                  <li key={fieldRef.field_path}>
                    <p className="privacy-note">
                      Privacy label: Encrypted field reference only (plaintext suppressed)
                    </p>
                    <div className="row">
                      <span>Field path</span>
                      <strong className="mono">{fieldRef.field_path}</strong>
                    </div>
                    <div className="row">
                      <span>Blob ref</span>
                      <strong className="mono">{fieldRef.blob_ref}</strong>
                    </div>
                    <div className="row">
                      <span>Ciphertext hash</span>
                      <strong className="mono">{fieldRef.ciphertext_hash}</strong>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              {payloadEntryId && payloadNamespace
                ? 'Payload field references unavailable. Confirm the API service is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_PAYLOAD_ENTRY_ID</code> and <code>NEXT_PUBLIC_PAYLOAD_NAMESPACE</code>{' '}
                    to inspect namespace-scoped encrypted payload field refs.</>}
            </p>
          )}
        </div>


        <div className="card">
          <h2>Builder-Issued Asset Policy Disclosure</h2>
          {assetPositionsData ? (
            <>
              <p className="subtitle">Account: <code>{assetPositionsData.account_id}</code></p>
              <ul>
                {(assetPositionsData.positions ?? []).map((position) => (
                  <li key={`${position.issuer}-${position.asset_code}`}>
                    <div className="row">
                      <span>Asset</span>
                      <strong>{position.asset_code}</strong>
                    </div>
                    <div className="row">
                      <span>Issuer</span>
                      <strong className="mono">{position.issuer}</strong>
                    </div>
                    <div className="row">
                      <span>Trustline</span>
                      <strong>{position.trustline.status}</strong>
                    </div>
                    <div className="row">
                      <span>Disclosure mode</span>
                      <strong>{position.trustline.disclosure.mode}</strong>
                    </div>
                    <div className="row">
                      <span>Held amount</span>
                      <strong>{position.held_amount}</strong>
                    </div>
                    <p className="policy-note">{position.holder_notice}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Asset disclosure unavailable. Confirm <code>/assets/:account_id</code> is exposed and API service is reachable.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
