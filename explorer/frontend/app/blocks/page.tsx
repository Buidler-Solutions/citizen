import { fetchBlocksPage } from '../lib/blocks';
import { cursorFromSearchParams, type SearchParams } from '../lib/block-routes';
import BlocksListClient from './blocks-list-client';

export const dynamic = 'force-dynamic';

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedParams = await searchParams;
  const cursor = cursorFromSearchParams(resolvedParams);

  const result = await fetchBlocksPage(cursor);

  return (
    <>
      <section className="hero compact">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Blocks</h1>
          <p className="subtitle">Recent finalized blocks from the Citizen node runtime.</p>
        </div>
      </section>

      {!result.ok ? (
        <section className="panel-card">
          <h2>Node unavailable</h2>
          <p className="subtitle">{result.message}</p>
        </section>
      ) : (
        <BlocksListClient initialPayload={result.payload} initialCursor={cursor} />
      )}
    </>
  );
}
