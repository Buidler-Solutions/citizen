import { computeCanonicalWeight } from './local-indexer';
import { fetchBlockByHeight, type BlockSummary } from './blocks';

const explorerBackendBase =
  process.env.NEXT_PUBLIC_EXPLORER_BACKEND_URL ?? 'http://127.0.0.1:4444';

export type WeightSource = 'indexer' | 'fallback';

type BackendBlockMetric = {
  block_height: number;
  block_weight_bytes: number;
};

type BackendEntryMetric = {
  entry_id: string;
  entry_weight_bytes: number;
};

type PaginatedPayload<T> = {
  data?: T[];
  page?: {
    next_cursor?: string | null;
    has_more?: boolean;
  };
};

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function withBlockWeights(blocks: BlockSummary[]): Promise<{ items: BlockSummary[]; source: WeightSource }> {
  if (blocks.length === 0) {
    return { items: blocks, source: 'fallback' };
  }

  const heights = blocks.map((block) => block.height);
  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);
  const params = new URLSearchParams({
    from_height: String(minHeight),
    to_height: String(maxHeight),
    limit: String(Math.max(blocks.length, 100)),
  });

  const payload = await safeFetchJson<PaginatedPayload<BackendBlockMetric>>(
    `${explorerBackendBase.replace(/\/$/, '')}/metrics/blocks?${params.toString()}`,
  );

  const metricRows = Array.isArray(payload?.data) ? payload.data : null;
  if (metricRows) {
    const byHeight = new Map(metricRows.map((row) => [row.block_height, row.block_weight_bytes]));
    if (blocks.every((block) => byHeight.has(block.height))) {
      return {
        source: 'indexer',
        items: blocks.map((block) => ({
          ...block,
          block_weight_bytes: byHeight.get(block.height),
        })),
      };
    }
  }

  const items = await Promise.all(
    blocks.map(async (block) => {
      const detail = await fetchBlockByHeight(block.height);
      const runtimeBlock = detail?.data?.block;
      return {
        ...block,
        block_weight_bytes:
          runtimeBlock !== null && runtimeBlock !== undefined
            ? computeCanonicalWeight(runtimeBlock)
            : computeCanonicalWeight({ header: block.header, entries: block.entry_ids }),
      };
    }),
  );

  return {
    source: 'fallback',
    items,
  };
}

export async function resolveEntryWeights(
  entryIds: string[],
  fallbackEntries: unknown[],
): Promise<{ weights: Map<string, number>; source: WeightSource }> {
  const unresolved = new Set(entryIds.filter((entryId) => entryId.trim().length > 0));
  const weights = new Map<string, number>();

  let cursor: string | null | undefined = undefined;
  for (let page = 0; page < 5 && unresolved.size > 0; page += 1) {
    const params = new URLSearchParams({ limit: '500' });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const payload = await safeFetchJson<PaginatedPayload<BackendEntryMetric>>(
      `${explorerBackendBase.replace(/\/$/, '')}/metrics/entries?${params.toString()}`,
    );

    if (!Array.isArray(payload?.data)) {
      break;
    }

    for (const metric of payload.data) {
      if (unresolved.has(metric.entry_id)) {
        unresolved.delete(metric.entry_id);
        weights.set(metric.entry_id, metric.entry_weight_bytes);
      }
    }

    const hasMore = payload.page?.has_more === true;
    cursor = payload.page?.next_cursor;
    if (!hasMore || !cursor) {
      break;
    }
  }

  if (unresolved.size === 0) {
    return { weights, source: 'indexer' };
  }

  fallbackEntries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const entryId = (entry as { entry_id?: unknown }).entry_id;
    if (typeof entryId === 'string' && unresolved.has(entryId)) {
      unresolved.delete(entryId);
      weights.set(entryId, computeCanonicalWeight(entry));
    }
  });

  return { weights, source: 'fallback' };
}
