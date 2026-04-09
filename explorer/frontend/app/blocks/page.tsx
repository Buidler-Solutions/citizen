import Link from 'next/link';
import { fetchBlocksPage } from '../lib/blocks';
import { shortHash, toReadableDate } from '../lib/format';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedParams = await searchParams;
  const cursor =
    typeof resolvedParams.cursor === 'string' ? resolvedParams.cursor : undefined;

  const result = await fetchBlocksPage(cursor);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Blocks</h1>
          <p className="subtitle">Recent finalized blocks from the explorer backend.</p>
        </div>
      </section>

      {!result.ok ? (
        <section className="card">
          <h2>Node unavailable</h2>
          <p className="subtitle">{result.message}</p>
        </section>
      ) : result.payload.data.items.length === 0 ? (
        <section className="card">
          <h2>No blocks yet</h2>
          <p className="subtitle">The backend returned an empty block list.</p>
        </section>
      ) : (
        <section className="block-list">
          {result.payload.data.items.map((block) => {
            const detailHref = `/blocks/${block.height}?from=${encodeURIComponent(
              cursor ?? '',
            )}`;

            return (
              <Link
                key={block.height}
                className="block-card"
                href={detailHref}
                aria-label={`Open block ${block.height}`}
              >
                <div className="block-card-header">
                  <h2>Block #{block.height}</h2>
                  <span className="status-chip ok">{block.entry_count} entries</span>
                </div>
                <div className="stack">
                  <div className="row">
                    <span className="label">Timestamp</span>
                    <span>{toReadableDate(block.header.timestamp)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Proposer</span>
                    <span className="mono">{shortHash(block.header.proposer)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Prev hash</span>
                    <span className="mono">{shortHash(block.header.prev_hash)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Entry root</span>
                    <span className="mono">{shortHash(block.header.entry_root)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Aggregated sig</span>
                    <span className="mono">
                      {shortHash(block.header.commit_proof.aggregated_signature)}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      )}

      {result.ok && result.payload.data.has_more && result.payload.data.next_cursor ? (
        <section className="pagination-row">
          <Link
            className="button-link"
            href={`/blocks?cursor=${encodeURIComponent(result.payload.data.next_cursor)}`}
          >
            Load older blocks
          </Link>
        </section>
      ) : null}
    </main>
  );
}
