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

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

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
  return safeFetchJson<BlockResponse>(`${apiBase}/blocks/${blockHeight}`);
}

async function loadEntries(): Promise<EntryResponse | null> {
  return safeFetchJson<EntryResponse>(`${apiBase}/entries/${namespace}`);
}

async function loadWalletSignerEntries(
  namespaceName: string,
  signerDid: string,
): Promise<WalletSignerEntryResponse | null> {
  return safeFetchJson<WalletSignerEntryResponse>(
    `${apiBase}/entries/${encodeURIComponent(namespaceName)}/wallet-signers/${encodeURIComponent(signerDid)}`
  );
}

async function loadReceipt(id: string): Promise<ReceiptResponse | null> {
  return safeFetchJson<ReceiptResponse>(`${apiBase}/receipts/${id}`);
}

async function loadFileManifest(manifestId: string): Promise<FileManifestResponse | null> {
  return safeFetchJson<FileManifestResponse>(
    `${apiBase}/files/manifests/${encodeURIComponent(manifestId)}`
  );
}



async function loadFileTimeline(manifestId: string): Promise<FileTimelineResponse | null> {
  return safeFetchJson<FileTimelineResponse>(
    `${apiBase}/files/timeline/${encodeURIComponent(manifestId)}`
  );
}

async function loadPayloadFieldRefs(
  entryId: string,
  namespaceName: string,
): Promise<PayloadFieldRefsResponse | null> {
  return safeFetchJson<PayloadFieldRefsResponse>(
    `${apiBase}/payloads/fields/${encodeURIComponent(entryId)}/${encodeURIComponent(namespaceName)}`
  );
}

async function loadAssetPositions(accountId: string): Promise<AssetPositionsResponse | null> {
  return safeFetchJson<AssetPositionsResponse>(`${apiBase}/assets/${encodeURIComponent(accountId)}`);
}

export default async function HomePage() {
  const [block, entries, walletSignerEntries, receipt, fileManifest, fileTimeline, payloadFieldRefs, assetPositions] = await Promise.all([
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
            <span className="label">Backend</span>
            <span>{apiBase}</span>
          </div>
          <div>
            <span className="label">Node Source</span>
            <span>{block?.source ?? 'unavailable'}</span>
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Block {block?.data.height ?? blockHeight}</h2>
          {block?.data.block ? (
            <ul>
              <li>
                <div className="row">
                  <span>Proposer</span>
                  <strong>{block.data.block.header.proposer}</strong>
                </div>
                <div className="row">
                  <span>Entry Root</span>
                  <strong className="mono">{block.data.block.header.entry_root}</strong>
                </div>
                <div className="row">
                  <span>Commit Signature</span>
                  <strong className="mono">
                    {block.data.block.header.commit_proof.aggregated_signature}
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
          <h2>Namespace Entries ({entries?.data.namespace ?? namespace})</h2>
          {(entries?.data.entries ?? []).length > 0 ? (
            <ul>
              {(entries?.data.entries ?? []).map((entry) => (
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

        <div className="card">
          <h2>Deterministic Receipt</h2>
          {receipt ? (
            <ul>
              <li>
                <div className="row">
                  <span>Status</span>
                  <strong>{receipt.data.receipt.status}</strong>
                </div>
                <div className="row">
                  <span>Namespace</span>
                  <strong>{receipt.data.receipt.validation.namespace}</strong>
                </div>
                <div className="row">
                  <span>Finality Height</span>
                  <strong>{receipt.data.receipt.finality?.block_height ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Block Hash</span>
                  <strong className="mono">
                    {receipt.data.receipt.finality?.block_hash ?? 'N/A'}
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
          {walletSignerEntries ? (
            <>
              <p className="subtitle">
                Signer: <code>{walletSignerEntries.data.wallet_signer}</code>
              </p>
              <p className="privacy-note">
                Matched {walletSignerEntries.data.matched_entries} of {walletSignerEntries.data.total_entries} entries in namespace{' '}
                <code>{walletSignerEntries.data.namespace}</code>.
              </p>
              {(walletSignerEntries.data.entries ?? []).length > 0 ? (
                <ul>
                  {walletSignerEntries.data.entries.map((entry) => (
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
                ? 'Wallet-signer index unavailable. Confirm backend API service is running and reachable.'
                : <>Set <code>NEXT_PUBLIC_WALLET_SIGNER_DID</code> to inspect entries by <code>payload.payload_wallet_signature.signer</code>.</>}
            </p>
          )}
        </div>


        <div className="card">
          <h2>Encrypted File Manifest Metadata</h2>
          {fileManifest ? (
            <ul>
              <li>
                <div className="row">
                  <span>Manifest ID</span>
                  <strong className="mono">{fileManifest.data.manifest_id}</strong>
                </div>
                <div className="row">
                  <span>Namespace</span>
                  <strong>{fileManifest.data.namespace}</strong>
                </div>
                <div className="row">
                  <span>Encryption mode</span>
                  <strong>{fileManifest.data.encryption_mode ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Ciphertext hash</span>
                  <strong className="mono">{fileManifest.data.ciphertext_hash ?? 'N/A'}</strong>
                </div>
                <div className="row">
                  <span>Consent state</span>
                  <strong className={`status-chip ${consentTone(fileManifest.data.consent_state)}`}>
                    {fileManifest.data.consent_state}
                  </strong>
                </div>
                <div className="row">
                  <span>Revoked readers</span>
                  <strong className={`status-chip ${revocationTone(fileManifest.data.revoked_readers)}`}>
                    {fileManifest.data.revoked_readers.length}
                  </strong>
                </div>
                <p className="privacy-note">
                  Privacy label:{' '}
                  <strong>
                    {fileManifest.data.consent_state === 'active'
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
          {fileTimeline ? (
            <>
              <p className="subtitle">
                Manifest: <code>{fileTimeline.data.manifest.manifest_id}</code>
              </p>
              {(fileTimeline.data.events ?? []).length > 0 ? (
                <ul>
                  {fileTimeline.data.events.map((event, index) => (
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
          {payloadFieldRefs ? (
            <>
              <p className="subtitle">
                Entry: <code>{payloadFieldRefs.data.entry_id}</code>
              </p>
              <ul>
                {payloadFieldRefs.data.field_refs.map((fieldRef) => (
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
          {assetPositions ? (
            <>
              <p className="subtitle">Account: <code>{assetPositions.data.account_id}</code></p>
              <ul>
                {assetPositions.data.positions.map((position) => (
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
