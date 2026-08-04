import ArticlePublisher from "./components/ArticlePublisher";
const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      return fallback;
    }
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

const fallbackCapabilities = {
  consensus: {
    name: "Deterministic Finality",
    detail: "Linear BFT consensus requiring ≥80% quorum with immediate finalization."
  },
  governance: {
    name: "Governance Engine",
    detail: "Validator-driven proposals and votes control protocol upgrades and validator sets."
  },
  validators: {
    name: "Validator Lifecycle",
    detail: "Identity-anchored admission, suspension, and removal with on-chain auditability."
  },
  namespaces: {
    name: "Namespace Rule Engine",
    detail: "Domain-specific rules enforce who can write and what proof is required."
  },
  ledger: {
    name: "Ledger Entries",
    detail: "Append-only event records secured with signatures and merkle roots."
  },
  security: {
    name: "Security Guarantees",
    detail: "Sybil resistance, deterministic finality, and governance-first safety controls."
  }
};

const fallbackWorkflows = {
  identity: {
    entry_id: "uuid-identity-001",
    namespace: "identity.citizen",
    action: "REGISTER_IDENTITY",
    subject: "did:ledger:citizen:alexa",
    claims_hash: "bafybeigdyr...",
    signature: "sig:citizen-alexa",
    timestamp: 1736500000
  },
  land: {
    entry_id: "uuid-land-239-a",
    namespace: "registry.land",
    action: "TRANSFER_OWNERSHIP",
    parcel_id: "LOT-239-A",
    from: "did:ledger:citizen:alexa",
    to: "did:ledger:citizen:jamal",
    signature: "sig:citizen-alexa",
    timestamp: 1736500100
  },
  audit: {
    entry_id: "uuid-audit-402",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    event: "BID_OPENED",
    document_hash: "sha256:9d35...",
    timestamp: 1736500200
  },
  governance: {
    proposal_type: "ADD_VALIDATOR",
    candidate_id: "did:ledger:validator:univ-x",
    pubkey: "bls:0xabc123",
    anchors: ["University of X"],
    voting_period: "14 days"
  },
  sponsorship: {
    namespace: "builder.credits",
    action: "SPONSOR_USAGE",
    credit_grant_id: "grant:builder:alpha",
    sponsor_builder_id: "did:ledger:builder:alpha",
    sponsorship_id: "sponsor:demo:001",
    sponsored_did: "did:ledger:app:demo",
    units: 1
  }
};

const fallbackNamespaces = [
  {
    namespace: "identity.citizen",
    actions: ["REGISTER_IDENTITY", "UPDATE_CLAIM", "REVOKE_IDENTITY"]
  },
  {
    namespace: "registry.land",
    actions: ["REGISTER_PARCEL", "TRANSFER_OWNERSHIP", "ANNOTATE_DISPUTE"]
  },
  {
    namespace: "audit.procurement",
    actions: ["RECORD_EVENT", "LINK_DOCUMENT", "CLOSE_AUDIT"]
  },
  {
    namespace: "governance.vote",
    actions: ["SUBMIT_PROPOSAL", "CAST_VOTE", "EXECUTE_PROPOSAL"]
  },
  {
    namespace: "builder.credits",
    actions: ["MULTISIG_CREDIT_GRANT", "PROGRAMMABLE_CREDIT_GRANT", "SPONSOR_USAGE"]
  }
];

export default async function Home() {
  const capabilities = await fetchJson("/capabilities", fallbackCapabilities);
  const workflows = await fetchJson("/workflows", fallbackWorkflows);
  const namespaces = await fetchJson("/namespaces", fallbackNamespaces);

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">CITIZEN · Governance-first public ledger</p>
          <h1>Citizen DApp capability console</h1>
          <p className="lead">
            A Next.js front-end backed by NestJS that demonstrates consensus, governance,
            namespaces, and data entry workflows.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="#capabilities">
              Explore capabilities
            </a>
            <a className="button ghost" href="#workflows">
              View workflows
            </a>
            <a className="button ghost" href="/civic-voting">
              Vote on Proposals
            </a>
          </div>
        </div>
        <div className="hero-card">
          <h2>Live status</h2>
          <dl>
            <div>
              <dt>API base</dt>
              <dd>{apiBase}</dd>
            </div>
            <div>
              <dt>Finality target</dt>
              <dd>~1 second</dd>
            </div>
            <div>
              <dt>Quorum</dt>
              <dd>80% supermajority</dd>
            </div>
            <div>
              <dt>Node mode</dt>
              <dd>Observer demo</dd>
            </div>
          </dl>
          <p className="status-pill">Ready for integration</p>
        </div>
      </header>

      <section id="capabilities" className="section">
        <div className="section-heading">
          <h2>Protocol capabilities</h2>
          <p>Each card maps to a core Citizen blockchain feature.</p>
        </div>
        <div className="grid">
          {Object.values(capabilities).map((capability) => (
            <article key={capability.name} className="card">
              <h3>{capability.name}</h3>
              <p>{capability.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="workflows" className="section alt">
        <div className="section-heading">
          <h2>Workflow payloads</h2>
          <p>Prefilled examples match the JSON payloads expected by the ledger.</p>
        </div>
        <div className="workflow-grid">
          {Object.entries(workflows).map(([key, payload]) => (
            <article key={key} className="workflow">
              <header>
                <h3>{key.toUpperCase()} workflow</h3>
                <p>JSON payload ready for submission.</p>
              </header>
              <pre>{JSON.stringify(payload, null, 2)}</pre>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <h2>Namespaces and rules</h2>
          <p>Domain isolation with enforced actions and proof requirements.</p>
        </div>
        <div className="namespace-grid">
          {namespaces.map((namespace) => (
            <article key={namespace.namespace} className="card">
              <h3>{namespace.namespace}</h3>
              <ul>
                {namespace.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <ArticlePublisher />

      <section className="section alt">
        <div className="section-heading">
          <h2>Suggested API surface</h2>
          <p>Use these endpoints to integrate with the Citizen protocol.</p>
        </div>
        <div className="api-grid">
          <div>
            <h4>Read APIs</h4>
            <ul>
              <li>GET /blocks/latest</li>
              <li>GET /entries?namespace=registry.land</li>
              <li>GET /governance/proposals</li>
              <li>GET /validators</li>
            </ul>
          </div>
          <div>
            <h4>Write APIs</h4>
            <ul>
              <li>POST /entries</li>
              <li>POST /governance/proposals</li>
              <li>POST /governance/votes</li>
              <li>POST /validators/heartbeat</li>
            </ul>
          </div>
          <div>
            <h4>Observer APIs</h4>
            <ul>
              <li>GET /consensus/status</li>
              <li>GET /metrics/finality</li>
              <li>GET /namespaces</li>
              <li>GET /audit/logs</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
