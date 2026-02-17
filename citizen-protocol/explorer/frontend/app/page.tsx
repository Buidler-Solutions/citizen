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
const blockHeight = Number(process.env.NEXT_PUBLIC_BLOCK_HEIGHT ?? '1');
const namespace = process.env.NEXT_PUBLIC_NAMESPACE ?? 'governance.vote';
const receiptId = process.env.NEXT_PUBLIC_RECEIPT_ID;
const assetAccountId = process.env.NEXT_PUBLIC_ASSET_ACCOUNT_ID ?? 'did:ledger:alice';

async function loadBlock(): Promise<BlockResponse> {
  const response = await fetch(`${apiBase}/blocks/${blockHeight}`, {
    next: { revalidate: 5 },
  });
  if (!response.ok) {
    throw new Error('Failed to load block');
  }
  return response.json();
}

async function loadEntries(): Promise<EntryResponse> {
  const response = await fetch(`${apiBase}/entries/${namespace}`, {
    next: { revalidate: 5 },
  });
  if (!response.ok) {
    throw new Error('Failed to load entries');
  }
  return response.json();
}

async function loadReceipt(id: string): Promise<ReceiptResponse> {
  const response = await fetch(`${apiBase}/receipts/${id}`, {
    next: { revalidate: 5 },
  });
  if (!response.ok) {
    throw new Error('Failed to load receipt');
  }
  return response.json();
}

async function loadAssetPositions(accountId: string): Promise<AssetPositionsResponse | null> {
  const response = await fetch(`${apiBase}/assets/${encodeURIComponent(accountId)}`, {
    next: { revalidate: 5 },
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

export default async function HomePage() {
  const [block, entries, receipt, assetPositions] = await Promise.all([
    loadBlock(),
    loadEntries(),
    receiptId ? loadReceipt(receiptId) : Promise.resolve(null),
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
            <span>{block.source}</span>
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Block {block.data.height}</h2>
          {block.data.block ? (
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
            <p>No block found at this height.</p>
          )}
        </div>

        <div className="card">
          <h2>Namespace Entries ({entries.data.namespace})</h2>
          <ul>
            {entries.data.entries.map((entry) => (
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
              Set <code>NEXT_PUBLIC_RECEIPT_ID</code> to inspect canonical receipt finality proofs.
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
              No asset disclosure data loaded. Confirm <code>/assets/:account_id</code> is exposed by the API.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
