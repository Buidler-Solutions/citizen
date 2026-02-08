type BlockResponse = {
  source: string;
  blocks: {
    height: number;
    prev_hash: string;
    entry_root: string;
    proposer: string;
    timestamp: number;
    commit_proof: string;
  }[];
};

type EntryResponse = {
  source: string;
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

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

async function loadBlocks(): Promise<BlockResponse> {
  const response = await fetch(`${apiBase}/blocks`, { next: { revalidate: 5 } });
  if (!response.ok) {
    throw new Error('Failed to load blocks');
  }
  return response.json();
}

async function loadEntries(): Promise<EntryResponse> {
  const response = await fetch(`${apiBase}/entries`, { next: { revalidate: 5 } });
  if (!response.ok) {
    throw new Error('Failed to load entries');
  }
  return response.json();
}

export default async function HomePage() {
  const [blocks, entries] = await Promise.all([loadBlocks(), loadEntries()]);

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Citizen Protocol</p>
          <h1>Citizen Explorer</h1>
          <p className="subtitle">
            Read-only explorer for governance-driven ledger data.
          </p>
        </div>
        <div className="meta">
          <div>
            <span className="label">Backend</span>
            <span>{apiBase}</span>
          </div>
          <div>
            <span className="label">Blocks Source</span>
            <span>{blocks.source}</span>
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Latest Blocks</h2>
          <ul>
            {blocks.blocks.map((block) => (
              <li key={block.height}>
                <div className="row">
                  <span>Height</span>
                  <strong>{block.height}</strong>
                </div>
                <div className="row">
                  <span>Proposer</span>
                  <strong>{block.proposer}</strong>
                </div>
                <div className="row">
                  <span>Entry Root</span>
                  <strong className="mono">{block.entry_root}</strong>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Recent Entries</h2>
          <ul>
            {entries.entries.map((entry) => (
              <li key={entry.entry_id}>
                <div className="row">
                  <span>Namespace</span>
                  <strong>{entry.namespace}</strong>
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
        </div>
      </section>
    </main>
  );
}
