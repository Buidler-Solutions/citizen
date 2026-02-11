import { useMemo, useState } from 'react';
import { walletStorage } from './lib/storage';
import type { DraftEntry, GovernanceProposal, Submission, WalletKey } from './types';

const apiDefaults = {
  baseUrl: 'http://127.0.0.1:8080',
  apiVersion: 'v1',
};

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function App() {
  const [keys, setKeys] = useState<WalletKey[]>(() => walletStorage.keys());
  const [receipts, setReceipts] = useState<Submission[]>(() => walletStorage.receipts());
  const [proposals, setProposals] = useState<GovernanceProposal[]>(() => walletStorage.governance());
  const [onboardingLabel, setOnboardingLabel] = useState('Primary validator key');
  const [draft, setDraft] = useState<DraftEntry>({
    namespace: 'identity.citizen',
    action: 'REGISTER_IDENTITY',
    objectId: 'did:ledger:abc',
    author: 'did:ledger:abc',
    payloadJson: '{"claims_hash":"abc123"}',
  });

  const activeKey = keys[0];
  const walletHealth = useMemo(() => ({
    keys: keys.length,
    pendingReceipts: receipts.filter((receipt) => receipt.status === 'pending').length,
    activeProposals: proposals.filter((proposal) => proposal.status === 'open').length,
  }), [keys, receipts, proposals]);

  const persistKeys = (next: WalletKey[]) => {
    setKeys(next);
    walletStorage.setKeys(next);
  };

  const persistReceipts = (next: Submission[]) => {
    setReceipts(next);
    walletStorage.setReceipts(next);
  };

  const persistProposals = (next: GovernanceProposal[]) => {
    setProposals(next);
    walletStorage.setGovernance(next);
  };

  const createKey = () => {
    const newKey: WalletKey = {
      id: crypto.randomUUID(),
      label: onboardingLabel,
      publicKey: randomHex(64),
      createdAt: new Date().toISOString(),
    };
    persistKeys([newKey, ...keys]);
  };

  const submitDraft = () => {
    const submission: Submission = {
      id: crypto.randomUUID(),
      status: 'pending',
      txHash: randomHex(64),
      createdAt: new Date().toISOString(),
    };
    persistReceipts([submission, ...receipts]);
  };

  const markFinal = (id: string) => {
    persistReceipts(receipts.map((receipt) => receipt.id === id ? { ...receipt, status: 'finalized', blockHeight: 1024 } : receipt));
  };

  const exportBundle = () => {
    const blob = new Blob([JSON.stringify({ keys, receipts }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'citizen-wallet-receipts.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const addProposal = () => {
    const proposal: GovernanceProposal = {
      id: `GOV-${Math.floor(Math.random() * 1000)}`,
      kind: 'ADD_VALIDATOR',
      description: 'Add did:ledger:validator:new to active set',
      status: 'open',
    };
    persistProposals([proposal, ...proposals]);
  };

  const finalizeProposal = (id: string) => {
    persistProposals(proposals.map((proposal) => proposal.id === id ? { ...proposal, status: 'finalized', finalityHeight: 2048 } : proposal));
  };

  return (
    <main className="app-shell">
      <header>
        <h1>Citizen Wallet Console</h1>
        <p>Phase 2-5 execution dashboard for onboarding, submissions, governance, and release readiness.</p>
      </header>

      <section className="card stats" aria-label="wallet health">
        <div><strong>{walletHealth.keys}</strong><span>Keys</span></div>
        <div><strong>{walletHealth.pendingReceipts}</strong><span>Pending receipts</span></div>
        <div><strong>{walletHealth.activeProposals}</strong><span>Open proposals</span></div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Onboarding + Key Management</h2>
          <label>
            Key label
            <input value={onboardingLabel} onChange={(event) => setOnboardingLabel(event.target.value)} />
          </label>
          <div className="row">
            <button onClick={createKey}>Create key</button>
            <button onClick={() => persistKeys(keys.slice(1))} disabled={keys.length === 0}>Rotate (archive latest)</button>
          </div>
          <ul>
            {keys.map((key) => (
              <li key={key.id}><code>{key.id.slice(0, 8)}</code> · {key.label} · {key.publicKey.slice(0, 12)}…</li>
            ))}
          </ul>
        </article>

        <article className="card">
          <h2>Namespace Entry Builder + Submission</h2>
          <p>Endpoint: <code>{apiDefaults.baseUrl}/api/{apiDefaults.apiVersion}/entries/submit</code></p>
          <label>Namespace
            <select value={draft.namespace} onChange={(event) => setDraft({ ...draft, namespace: event.target.value as DraftEntry['namespace'] })}>
              <option>identity.citizen</option>
              <option>registry.land</option>
              <option>audit.procurement</option>
              <option>governance.vote</option>
            </select>
          </label>
          <label>Action<input value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label>
          <label>Object ID<input value={draft.objectId} onChange={(event) => setDraft({ ...draft, objectId: event.target.value })} /></label>
          <label>Author<input value={draft.author} onChange={(event) => setDraft({ ...draft, author: event.target.value })} /></label>
          <label>Payload JSON
            <textarea value={draft.payloadJson} onChange={(event) => setDraft({ ...draft, payloadJson: event.target.value })} rows={4} />
          </label>
          <button onClick={submitDraft} disabled={!activeKey}>Submit signed entry</button>
          {!activeKey && <p className="notice">Create a key first to enable submissions.</p>}
        </article>

        <article className="card">
          <h2>Receipt Viewer + Export</h2>
          <button onClick={exportBundle} disabled={receipts.length === 0}>Export receipt bundle</button>
          <ul>
            {receipts.map((receipt) => (
              <li key={receipt.id}>
                <code>{receipt.id.slice(0, 8)}</code> · {receipt.status} · {receipt.txHash.slice(0, 10)}…
                {receipt.status === 'pending' && <button onClick={() => markFinal(receipt.id)}>Mark finalized</button>}
              </li>
            ))}
          </ul>
        </article>

        <article className="card">
          <h2>Governance UX</h2>
          <div className="row">
            <button onClick={addProposal}>Create proposal</button>
            <button disabled={proposals.length === 0}>Cast vote (preview signature)</button>
          </div>
          <ul>
            {proposals.map((proposal) => (
              <li key={proposal.id}>
                {proposal.id} · {proposal.kind} · {proposal.status}
                {proposal.status === 'open' && <button onClick={() => finalizeProposal(proposal.id)}>Finalize</button>}
                {proposal.finalityHeight && <span> · height {proposal.finalityHeight}</span>}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
