import Link from 'next/link';
import { fetchBlockByHeight } from '../../lib/blocks';
import { shortHash, toReadableDate } from '../../lib/format';
import CopyableHash from '../../components/copyable-hash';
import { blockDetailHref, parseBlockHeightParam } from '../../lib/block-routes';
import { resolveEntryWeights } from '../../lib/indexer-metrics';
import { computeCanonicalWeight } from '../../lib/local-indexer';

export const dynamic = 'force-dynamic';

type Params = {
  height: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function toHexByteLength(value: string | undefined): string {
  if (!value) {
    return 'N/A';
  }

  return `${Math.floor(value.length / 2)} bytes`;
}

function renderEpoch(value: number | null): string {
  if (!value || value <= 0) {
    return 'N/A';
  }

  return toReadableDate(value);
}

function consentValidity(expiresAt: number | null): string {
  if (!expiresAt || expiresAt <= 0) {
    return 'Unknown';
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  return expiresAt >= nowUnix ? 'Active' : 'Expired';
}

function renderRecord(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Unable to render JSON payload';
  }
}

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const resolvedParams = await params;
  const height = parseBlockHeightParam(resolvedParams.height);

  if (height === null) {
    return (
      <>
        <section className="panel-card">
          <h1>Invalid block height</h1>
          <Link href="/blocks" className="button-link">
            Back to blocks
          </Link>
        </section>
      </>
    );
  }

  const blockResponse = await fetchBlockByHeight(height);
  const backHref = '/blocks';

  if (!blockResponse?.data?.block) {
    return (
      <>
        <section className="panel-card">
          <h1>Block not found</h1>
          <p className="subtitle">No block was returned for height {height}.</p>
          <Link href={backHref} className="button-link">
            Back to blocks
          </Link>
        </section>
      </>
    );
  }

  const block = blockResponse.data.block;
  const entryIds = block.entries
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { entry_id?: unknown }).entry_id : null))
    .filter((entryId): entryId is string => typeof entryId === 'string');
  const entryWeights = await resolveEntryWeights(entryIds, block.entries);
  const blockWeightBytes = computeCanonicalWeight(block);

  return (
    <>
      <section className="hero compact">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Block #{block.header.height}</h1>
          <p className="subtitle">Source: {blockResponse.source}</p>
          <p className="subtitle">Entry weight source: {entryWeights.source}</p>
        </div>
      </section>

      <section className="pagination-row">
        <Link href={backHref} className="button-link">
          Back to blocks
        </Link>
        {height > 0 ? (
          <Link href={blockDetailHref(height - 1)} className="button-link">
            Previous block
          </Link>
        ) : null}
        <Link href={blockDetailHref(height + 1)} className="button-link">
          Next block
        </Link>
      </section>

      <section className="panel-card">
        <h2>Header</h2>
        <div className="stack">
          <div className="row">
            <span className="label">Timestamp</span>
            <span>{toReadableDate(block.header.timestamp)}</span>
          </div>
          <div className="row">
            <span className="label">Proposer</span>
            <CopyableHash
              label="proposer value"
              value={block.header.proposer}
              preview={shortHash(block.header.proposer)}
            />
          </div>
          <div className="row">
            <span className="label">Prev hash</span>
            <CopyableHash
              label="previous hash"
              value={block.header.prev_hash}
              preview={shortHash(block.header.prev_hash)}
            />
          </div>
          <div className="row">
            <span className="label">Entry root</span>
            <CopyableHash
              label="entry root"
              value={block.header.entry_root}
              preview={shortHash(block.header.entry_root)}
            />
          </div>
          <div className="row">
            <span className="label">Aggregated signature</span>
            <CopyableHash
              label="aggregated signature"
              value={block.header.commit_proof.aggregated_signature}
              preview={shortHash(block.header.commit_proof.aggregated_signature)}
            />
          </div>
          <div className="row">
            <span className="label">Block weight</span>
            <span>{blockWeightBytes.toLocaleString('en-US')} bytes (runtime)</span>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <h2>Entries</h2>
        <p className="subtitle">Total entries: {block.entries.length}</p>

        {block.entries.length === 0 ? (
          <p className="subtitle">No entries were included in this block.</p>
        ) : null}

        <div className="stack">
          {block.entries.map((entry, index) => {
            const entryRecord = asRecord(entry);
            const payloadRecord = asRecord(entryRecord?.payload);
            const walletSigRecord = asRecord(payloadRecord?.payload_wallet_signature);
            const walletReaderRecord = asRecord(payloadRecord?.wallet_reader);
            const consentReceiptRecord = asRecord(entryRecord?.consent_receipt);
            const wrappedSecrets = Array.isArray(entryRecord?.key_wrapped_secrets)
              ? entryRecord.key_wrapped_secrets
              : [];
            const authorizedReaders = asStringArray(entryRecord?.authorized_readers);

            const ciphertextHex = asString(entryRecord?.ciphertext_hex);
            const nonceHex = asString(entryRecord?.nonce_hex);
            const grantedAt = asNumber(consentReceiptRecord?.granted_at);
            const expiresAt = asNumber(consentReceiptRecord?.expires_at);
            const rawEntryJson = renderRecord(entry);

            return (
              <article key={`${block.header.height}-entry-${index}`} className="panel-card">
                <div className="block-card-header">
                  <h3>Entry #{index + 1}</h3>
                  <span className="status-chip ok">{asString(entryRecord?.action) ?? 'Unknown action'}</span>
                </div>

                <div className="stack">
                  <div className="row">
                    <span className="label">Entry ID</span>
                    <CopyableHash
                      label={`entry ${index + 1} id`}
                      value={asString(entryRecord?.entry_id)}
                      preview={shortHash(asString(entryRecord?.entry_id), 10)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Namespace</span>
                    <span className="mono">{asString(entryRecord?.namespace) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Author</span>
                    <span className="mono">{asString(entryRecord?.author) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Object ID</span>
                    <CopyableHash
                      label={`entry ${index + 1} object id`}
                      value={asString(entryRecord?.object_id)}
                      preview={shortHash(asString(entryRecord?.object_id), 10)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Entry timestamp</span>
                    <span>{renderEpoch(asNumber(entryRecord?.timestamp))}</span>
                  </div>
                  <div className="row">
                    <span className="label">Entry weight</span>
                    <span>{(() => {
                      const entryId = asString(entryRecord?.entry_id);
                      if (!entryId) return 'N/A';
                      const bytes = entryWeights.weights.get(entryId);
                      return bytes === undefined ? 'N/A' : `${bytes.toLocaleString('en-US')} bytes`;
                    })()}</span>
                  </div>
                  <div className="row">
                    <span className="label">Privacy mode</span>
                    <span>{asString(entryRecord?.privacy_mode) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Privacy flag</span>
                    <span>{asBoolean(entryRecord?.privacy_flag) === true ? 'True' : 'False'}</span>
                  </div>
                </div>

                <h4>Encrypted payload envelope</h4>
                <div className="stack">
                  <div className="row">
                    <span className="label">Ciphertext</span>
                    <CopyableHash
                      label={`entry ${index + 1} ciphertext`}
                      value={ciphertextHex}
                      preview={`${shortHash(ciphertextHex, 14)} (${toHexByteLength(ciphertextHex)})`}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Nonce</span>
                    <CopyableHash
                      label={`entry ${index + 1} nonce`}
                      value={nonceHex}
                      preview={shortHash(nonceHex, 10)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Payload commitment</span>
                    <CopyableHash
                      label={`entry ${index + 1} payload commitment`}
                      value={asString(entryRecord?.payload_commitment)}
                      preview={shortHash(asString(entryRecord?.payload_commitment), 10)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Entry signature</span>
                    <CopyableHash
                      label={`entry ${index + 1} signature`}
                      value={asString(entryRecord?.signature)}
                      preview={shortHash(asString(entryRecord?.signature), 12)}
                    />
                  </div>
                </div>

                <h4>Consent receipt</h4>
                <div className="stack">
                  <div className="row">
                    <span className="label">Subject DID</span>
                    <span className="mono">{asString(consentReceiptRecord?.subject_did) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Policy ref</span>
                    <span className="mono">{asString(consentReceiptRecord?.policy_ref) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Granted at</span>
                    <span>{renderEpoch(grantedAt)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Expires at</span>
                    <span>{renderEpoch(expiresAt)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Grant validity</span>
                    <span>{consentValidity(expiresAt)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Receipt data hash</span>
                    <CopyableHash
                      label={`entry ${index + 1} receipt data hash`}
                      value={asString(consentReceiptRecord?.data_hash)}
                      preview={shortHash(asString(consentReceiptRecord?.data_hash), 10)}
                    />
                  </div>
                </div>

                <h4>Readers and key wrapping</h4>
                <ul>
                  {authorizedReaders.length === 0 ? (
                    <li className="subtitle">No authorized readers declared.</li>
                  ) : (
                    authorizedReaders.map((reader, readerIndex) => (
                      <li key={`entry-${index}-reader-${readerIndex}`} className="mono">
                        {reader}
                      </li>
                    ))
                  )}
                </ul>
                <ul>
                  {wrappedSecrets.length === 0 ? (
                    <li className="subtitle">No wrapped DEKs included.</li>
                  ) : (
                    wrappedSecrets.map((secret, secretIndex) => {
                      const record = asRecord(secret);
                      return (
                        <li key={`entry-${index}-secret-${secretIndex}`}>
                          <div className="row">
                            <span className="label">Reader</span>
                            <span className="mono">{asString(record?.reader_id) ?? 'N/A'}</span>
                          </div>
                          <div className="row">
                            <span className="label">Wrap algorithm</span>
                            <span>{asString(record?.wrap_algorithm) ?? 'N/A'}</span>
                          </div>
                          <div className="row">
                            <span className="label">Wrapped DEK</span>
                            <CopyableHash
                              label={`entry ${index + 1} wrapped dek ${secretIndex + 1}`}
                              value={asString(record?.wrapped_dek)}
                              preview={shortHash(asString(record?.wrapped_dek), 12)}
                            />
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>

                <h4>Signer and payload metadata</h4>
                <div className="stack">
                  <div className="row">
                    <span className="label">Wallet signer</span>
                    <span className="mono">{asString(payloadRecord?.wallet_signer) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Wallet reader DID</span>
                    <span className="mono">{asString(walletReaderRecord?.did) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Wallet reader key</span>
                    <CopyableHash
                      label={`entry ${index + 1} wallet reader key`}
                      value={asString(walletReaderRecord?.x25519_public_key)}
                      preview={shortHash(asString(walletReaderRecord?.x25519_public_key), 12)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Wallet signature signer</span>
                    <span className="mono">{asString(walletSigRecord?.signer) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Wallet signature algorithm</span>
                    <span>{asString(walletSigRecord?.algorithm) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Signature scope</span>
                    <span>{asString(walletSigRecord?.signature_scope) ?? 'N/A'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Payload hash</span>
                    <CopyableHash
                      label={`entry ${index + 1} payload hash`}
                      value={asString(walletSigRecord?.payload_hash)}
                      preview={shortHash(asString(walletSigRecord?.payload_hash), 10)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Signature</span>
                    <CopyableHash
                      label={`entry ${index + 1} wallet signature`}
                      value={asString(walletSigRecord?.signature)}
                      preview={shortHash(asString(walletSigRecord?.signature), 12)}
                    />
                  </div>
                  <div className="row">
                    <span className="label">Verifying key</span>
                    <CopyableHash
                      label={`entry ${index + 1} verifying key`}
                      value={asString(walletSigRecord?.verifying_key)}
                      preview={shortHash(asString(walletSigRecord?.verifying_key), 10)}
                    />
                  </div>
                </div>

                <details>
                  <summary>Raw entry JSON</summary>
                  <div className="row">
                    <span className="label">Clipboard</span>
                    <CopyableHash
                      label={`entry ${index + 1} raw entry json`}
                      value={rawEntryJson}
                      preview="Copy full JSON payload"
                    />
                  </div>
                  <pre className="mono">{rawEntryJson}</pre>
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
