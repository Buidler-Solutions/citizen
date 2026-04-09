import Link from 'next/link';
import { fetchBlockByHeight } from '../../lib/blocks';
import { shortHash, toReadableDate } from '../../lib/format';
import CopyableHash from '../../components/copyable-hash';

export const dynamic = 'force-dynamic';

type Params = {
  height: string;
};

type SearchParams = Record<string, string | string[] | undefined>;

function parseHeight(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export default async function BlockDetailPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const resolvedParams = await params;
  const resolvedSearch = await searchParams;
  const height = parseHeight(resolvedParams.height);

  if (height === null) {
    return (
      <main className="page">
        <section className="card">
          <h1>Invalid block height</h1>
          <Link href="/blocks" className="button-link">
            Back to blocks
          </Link>
        </section>
      </main>
    );
  }

  const blockResponse = await fetchBlockByHeight(height);
  const backCursor = typeof resolvedSearch.from === 'string' ? resolvedSearch.from : '';
  const backHref = backCursor ? `/blocks?cursor=${encodeURIComponent(backCursor)}` : '/blocks';

  if (!blockResponse?.data.block) {
    return (
      <main className="page">
        <section className="card">
          <h1>Block not found</h1>
          <p className="subtitle">No block was returned for height {height}.</p>
          <Link href={backHref} className="button-link">
            Back to blocks
          </Link>
        </section>
      </main>
    );
  }

  const block = blockResponse.data.block;

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Block #{block.header.height}</h1>
          <p className="subtitle">Source: {blockResponse.source}</p>
        </div>
      </section>

      <section className="pagination-row">
        <Link href={backHref} className="button-link">
          Back to blocks
        </Link>
        {height > 0 ? (
          <Link href={`/blocks/${height - 1}`} className="button-link">
            Previous block
          </Link>
        ) : null}
        <Link href={`/blocks/${height + 1}`} className="button-link">
          Next block
        </Link>
      </section>

      <section className="card">
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
        </div>
      </section>

      <section className="card">
        <h2>Entries</h2>
        <p className="subtitle">Total entries: {block.entries.length}</p>
        <ul>
          {block.entries.slice(0, 20).map((entry, index) => (
            <li key={`${block.header.height}-entry-${index}`}>
              <div className="row">
                <span className="label">Entry #{index + 1}</span>
                <span className="mono">{shortHash(JSON.stringify(entry), 14)}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
