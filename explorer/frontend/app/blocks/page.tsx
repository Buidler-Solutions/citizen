import { fetchBlocksPage } from '../lib/blocks';
import { cursorFromSearchParams, type SearchParams } from '../lib/block-routes';
import BlocksListClient from './blocks-list-client';
import { withBlockWeights } from '../lib/indexer-metrics';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^(?:sha256:)?[0-9a-f]{64}$/i;
const EXPLORER_BACKEND = 'http://localhost:4444';

async function resolveEntryBlock(entryId: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`${EXPLORER_BACKEND}/entries/lookup/${entryId}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    return json?.data?.block_height ?? null;
  } catch {
    return null;
  }
}

async function resolveByDataHash(hash: string): Promise<number | null> {
  try {
    // Strip sha256: prefix if present
    const clean = hash.replace(/^sha256:/i, '').trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`${EXPLORER_BACKEND}/data-hash?q=sha256:${encodeURIComponent(clean)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const matches = json?.data?.matches;
    if (!Array.isArray(matches) || matches.length === 0) return null;
    const entryId = matches[0].entry_id;
    if (!entryId) return null;
    return resolveEntryBlock(entryId);
  } catch {
    return null;
  }
}

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedParams = await searchParams;
  const cursor = cursorFromSearchParams(resolvedParams);
  const rawQuery = typeof resolvedParams.q === 'string' ? resolvedParams.q.trim() : '';

  // If query is an entry_id (UUID), resolve it to a block and redirect
  if (UUID_RE.test(rawQuery)) {
    const blockHeight = await resolveEntryBlock(rawQuery);
    if (blockHeight !== null) {
      redirect(`/blocks/${blockHeight}`);
    }
    return (
      <>
        <section className="hero compact">
          <div><p className="eyebrow">Citizen Explorer</p><h1>Blocks</h1></div>
        </section>
        <section className="panel-card">
          <p>Entry ID <code>{rawQuery}</code> was not found in recent blocks.</p>
        </section>
      </>
    );
  }

  // If query is a SHA256 data_hash, resolve via data-hash lookup then redirect
  if (SHA256_RE.test(rawQuery)) {
    const blockHeight = await resolveByDataHash(rawQuery);
    if (blockHeight !== null) {
      redirect(`/blocks/${blockHeight}`);
    }
    return (
      <>
        <section className="hero compact">
          <div><p className="eyebrow">Citizen Explorer</p><h1>Blocks</h1></div>
        </section>
        <section className="panel-card">
          <p>Data hash <code>{rawQuery}</code> was not found. The entry may not be finalized yet.</p>
        </section>
      </>
    );
  }

  const searchQuery = rawQuery;

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
