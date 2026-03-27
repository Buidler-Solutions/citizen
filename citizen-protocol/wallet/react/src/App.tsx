import { useMemo, useState } from 'react';
import { walletStorage } from './lib/storage';
import type { AssetDisclosurePosition, DraftEntry, GovernanceProposal, Submission, WalletKey } from './types';

const apiDefaults = {
  baseUrl: 'http://127.0.0.1:8080',
  apiVersion: 'v1',
};

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

const assetDisclosureSamples: AssetDisclosurePosition[] = [
  {
    issuer: 'did:ledger:issuer:builder-a',
    assetCode: 'BUILD_CREDIT',
    heldAmount: 120,
    trustlineStatus: 'active',
    disclosureMode: 'hashed',
    clawbackEnabled: true,
    holderNotice: 'Issuer clawback is ENABLED for this trustline. Issuer may revoke held units according to policy.',
  },
  {
    issuer: 'did:ledger:issuer:builder-b',
    assetCode: 'SPONSORED_TX',
    heldAmount: 40,
    trustlineStatus: 'active',
    disclosureMode: 'public',
    clawbackEnabled: false,
    holderNotice: 'Issuer clawback is DISABLED for this trustline. Only holder-initiated releases reduce holdings.',
  },
];

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
    payloadJson: '{"credit_grant_id":"grant:builder:alpha","sponsor_builder_id":"did:ledger:builder:alpha"}',
  });
  const [grantTemplate, setGrantTemplate] = useState({
    grantId: 'grant:builder:alpha',
    sponsorBuilderId: 'did:ledger:builder:alpha',
    sponsoredDid: 'did:ledger:app:demo',
    sponsorshipId: 'sponsor:demo:001',
  });
  const [submissionError, setSubmissionError] = useState<string | null>(null);

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

  const validateStrictPayload = (): string | null => {
    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = JSON.parse(draft.payloadJson) as Record<string, unknown>;
    } catch {
      return 'Payload JSON must be valid JSON before submission.';
    }

    const isBootstrapGrant =
      draft.namespace === 'builder.credits'
      && (draft.action === 'MULTISIG_CREDIT_GRANT' || draft.action === 'PROGRAMMABLE_CREDIT_GRANT');

    if (!isBootstrapGrant && typeof parsedPayload.credit_grant_id !== 'string') {
      return 'Strict write policy: payload.credit_grant_id is required for non-bootstrap writes.';
    }

    if (
      draft.namespace === 'builder.credits'
      && draft.action === 'SPONSOR_USAGE'
      && (typeof parsedPayload.sponsored_did !== 'string' || typeof parsedPayload.sponsorship_id !== 'string')
    ) {
      return 'SPONSOR_USAGE requires payload.sponsored_did and payload.sponsorship_id.';
    }

    return null;
  };

  const submitDraft = () => {
    const error = validateStrictPayload();
    if (error) {
      setSubmissionError(error);
      return;
    }

    setSubmissionError(null);
    const submission: Submission = {
      id: crypto.randomUUID(),
      status: 'pending',
      txHash: randomHex(64),
      createdAt: new Date().toISOString(),
    };
    persistReceipts([submission, ...receipts]);
  };

  const loadGrantDraft = () => {
    setSubmissionError(null);
    setDraft({
      namespace: 'builder.credits',
      action: 'MULTISIG_CREDIT_GRANT',
      objectId: grantTemplate.grantId,
      author: grantTemplate.sponsorBuilderId,
      payloadJson: JSON.stringify(
        {
          credit_grant_id: grantTemplate.grantId,
          sponsor_builder_id: grantTemplate.sponsorBuilderId,
          grant_scope: 'content.article',
          amount: 100,
          multisig_threshold: 2,
        },
        null,
        2,
      ),
    });
  };

  const loadSponsorshipDraft = () => {
    setSubmissionError(null);
    setDraft({
      namespace: 'builder.credits',
      action: 'SPONSOR_USAGE',
      objectId: grantTemplate.sponsorshipId,
      author: grantTemplate.sponsorBuilderId,
      payloadJson: JSON.stringify(
        {
          credit_grant_id: grantTemplate.grantId,
          sponsor_builder_id: grantTemplate.sponsorBuilderId,
          sponsorship_id: grantTemplate.sponsorshipId,
          sponsored_did: grantTemplate.sponsoredDid,
          amount: 1,
          purpose: 'content.article publish',
        },
        null,
        2,
      ),
    });
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
              <option>builder.credits</option>
            </select>
          </label>
          <label>Action<input value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label>
          <label>Object ID<input value={draft.objectId} onChange={(event) => setDraft({ ...draft, objectId: event.target.value })} /></label>
          <label>Author<input value={draft.author} onChange={(event) => setDraft({ ...draft, author: event.target.value })} /></label>
          <label>Payload JSON
            <textarea value={draft.payloadJson} onChange={(event) => setDraft({ ...draft, payloadJson: event.target.value })} rows={4} />
          </label>
          <p className="notice">Strict write policy: include <code>credit_grant_id</code> and optional <code>sponsor_builder_id</code> in payload for non-bootstrap writes.</p>
          <button onClick={submitDraft} disabled={!activeKey}>Submit signed entry</button>
          {!activeKey && <p className="notice">Create a key first to enable submissions.</p>}
          {submissionError && <p className="notice">{submissionError}</p>}
        </article>

        <article className="card">
          <h2>Builder Credit Templates</h2>
          <p>Prepare strict payloads for grant + sponsorship actions before signing.</p>
          <label>Grant ID<input value={grantTemplate.grantId} onChange={(event) => setGrantTemplate({ ...grantTemplate, grantId: event.target.value })} /></label>
          <label>Sponsor Builder DID<input value={grantTemplate.sponsorBuilderId} onChange={(event) => setGrantTemplate({ ...grantTemplate, sponsorBuilderId: event.target.value })} /></label>
          <label>Sponsored DID<input value={grantTemplate.sponsoredDid} onChange={(event) => setGrantTemplate({ ...grantTemplate, sponsoredDid: event.target.value })} /></label>
          <label>Sponsorship ID<input value={grantTemplate.sponsorshipId} onChange={(event) => setGrantTemplate({ ...grantTemplate, sponsorshipId: event.target.value })} /></label>
          <div className="row">
            <button onClick={loadGrantDraft}>Load MULTISIG_CREDIT_GRANT draft</button>
            <button onClick={loadSponsorshipDraft}>Load SPONSOR_USAGE draft</button>
          </div>
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

        <article className="card">
          <h2>Builder-Issued Asset Disclosure</h2>
          <p className="notice">Parity checkpoint: wallet UI now renders the same holder notice text exposed by <code>GET /api/v1/assets/:account_id</code>.</p>
          <ul>
            {assetDisclosureSamples.map((position) => (
              <li key={`${position.issuer}-${position.assetCode}`}>
                <strong>{position.assetCode}</strong> · {position.heldAmount} units
                <div className="asset-meta">
                  <span>Issuer: <code>{position.issuer}</code></span>
                  <span>Trustline: {position.trustlineStatus}</span>
                  <span>Disclosure mode: {position.disclosureMode}</span>
                  <span>Policy flag clawback_enabled: {position.clawbackEnabled ? 'true' : 'false'}</span>
                </div>
                <p className="policy-note">{position.holderNotice}</p>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
