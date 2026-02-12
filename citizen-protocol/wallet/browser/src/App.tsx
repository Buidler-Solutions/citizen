const signingRequest = {
  origin: 'registry.citizen.gov',
  network: 'citizen-mainnet',
  account: 'did:ledger:wallet:6f83b9',
  action: 'TRANSFER_OWNERSHIP',
  namespace: 'registry.land',
  objectId: 'LOT-239-A',
  feePolicy: 'governance-bond enforced',
};

const riskChecks = [
  { label: 'Domain verified', value: 'Yes', good: true },
  { label: 'Known contract namespace', value: 'registry.land', good: true },
  { label: 'Simulation result', value: 'No state conflict detected', good: true },
  { label: 'Permissions requested', value: 'Sign one event entry', good: true },
];

export function App() {
  return (
    <main className="wallet-root">
      <section className="wallet-frame" aria-label="browser wallet sign request">
        <header className="wallet-header">
          <p className="network-pill">{signingRequest.network}</p>
          <h1>Citizen Browser Wallet</h1>
          <p>Review and sign this ledger event request.</p>
        </header>

        <article className="request-card">
          <h2>Signature request</h2>
          <dl>
            <div><dt>Origin</dt><dd>{signingRequest.origin}</dd></div>
            <div><dt>Account</dt><dd>{signingRequest.account}</dd></div>
            <div><dt>Namespace</dt><dd>{signingRequest.namespace}</dd></div>
            <div><dt>Action</dt><dd>{signingRequest.action}</dd></div>
            <div><dt>Object</dt><dd>{signingRequest.objectId}</dd></div>
            <div><dt>Policy</dt><dd>{signingRequest.feePolicy}</dd></div>
          </dl>
        </article>

        <article className="request-card">
          <h2>Security checks</h2>
          <ul>
            {riskChecks.map((check) => (
              <li key={check.label}>
                <span>{check.label}</span>
                <strong className={check.good ? 'ok' : 'warn'}>{check.value}</strong>
              </li>
            ))}
          </ul>
        </article>

        <footer className="wallet-actions">
          <button className="ghost">Reject</button>
          <button className="primary">Sign event</button>
        </footer>
      </section>
    </main>
  );
}
