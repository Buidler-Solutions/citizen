import { fetchBlocksPage } from '../lib/blocks';
import BlocksListClient from './blocks-list-client';

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
      ) : (
        <BlocksListClient initialPayload={result.payload} initialCursor={cursor} />
      )}
    </main>
  );
}
