import { fetchBlocksPage } from '../lib/blocks';
import { cursorFromSearchParams, type SearchParams } from '../lib/block-routes';
import BlocksListClient from './blocks-list-client';
import { withBlockWeights } from '../lib/indexer-metrics';

export const dynamic = 'force-dynamic';

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedParams = await searchParams;
  const cursor = cursorFromSearchParams(resolvedParams);
  const searchQuery = typeof resolvedParams.q === 'string' ? resolvedParams.q : '';

  const result = await fetchBlocksPage(cursor);
  const weighted = result.ok ? await withBlockWeights(result.payload.data.items) : null;

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
        <BlocksListClient
          initialPayload={{ ...result.payload, data: { ...result.payload.data, items: weighted?.items ?? result.payload.data.items } }}
          weightSource={weighted?.source ?? 'fallback'}
          initialCursor={cursor}
          searchQuery={searchQuery}
        />
      )}
    </>
  );
}
