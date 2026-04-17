'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BlockSummary,
  type BlocksPageResponse,
  fetchBlocksPage,
} from '../lib/blocks';
import { shortHash, toReadableDate } from '../lib/format';
import { withBlockWeights, type WeightSource } from '../lib/indexer-metrics';
import {
  isRestoredStateCompatible,
  mergePaginatedBlocks,
  mergeWithInitialBlocksState,
  sortByHeightDesc,
} from '../lib/blocks-list-state';
import { blockDetailHref } from '../lib/block-routes';

type BlocksListClientProps = {
  initialPayload: BlocksPageResponse;
  initialCursor?: string;
  searchQuery?: string;
  weightSource: WeightSource;
};

type StoredBlocksState = {
  cursor: string;
  items: BlockSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  scrollY: number;
};

const storageKey = 'citizen.explorer.blocks.state.v1';

export default function BlocksListClient({
  initialPayload,
  initialCursor,
  searchQuery,
  weightSource,
}: BlocksListClientProps) {
  const currentCursor = initialCursor ?? '';
  const [items, setItems] = useState<BlockSummary[]>(initialPayload.data.items);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialPayload.data.next_cursor,
  );
  const [hasMore, setHasMore] = useState<boolean>(initialPayload.data.has_more);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || currentCursor) {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (!raw) {
        return;
      }

      const stored = JSON.parse(raw) as StoredBlocksState;
      if (stored.cursor !== currentCursor || stored.items.length === 0) {
        return;
      }
      if (!isRestoredStateCompatible(initialPayload.data.items, stored.items)) {
        window.sessionStorage.removeItem(storageKey);
        return;
      }

      const merged = mergeWithInitialBlocksState(
        {
          items: initialPayload.data.items,
          nextCursor: initialPayload.data.next_cursor,
          hasMore: initialPayload.data.has_more,
        },
        {
          items: stored.items,
          nextCursor: stored.nextCursor,
          hasMore: stored.hasMore,
        },
      );

      setItems(merged.items);
      setNextCursor(merged.nextCursor);
      setHasMore(merged.hasMore);

      window.requestAnimationFrame(() => {
        window.scrollTo({ top: stored.scrollY, behavior: 'auto' });
      });
    } catch {
      // ignore state restoration failures
    }
  }, [currentCursor, initialPayload.data.has_more, initialPayload.data.items, initialPayload.data.next_cursor]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const state: StoredBlocksState = {
      cursor: currentCursor,
      items,
      nextCursor,
      hasMore,
      scrollY: window.scrollY,
    };

    window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  }, [currentCursor, hasMore, items, nextCursor]);

  const persistScrollSnapshot = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as StoredBlocksState) : null;
      const state: StoredBlocksState = {
        cursor: currentCursor,
        items,
        nextCursor,
        hasMore,
        scrollY: window.scrollY,
      };

      if (!parsed || parsed.scrollY !== state.scrollY) {
        window.sessionStorage.setItem(storageKey, JSON.stringify(state));
      }
    } catch {
      // ignore persistence failures
    }
  }, [currentCursor, hasMore, items, nextCursor]);

  const weightSourceLabel = weightSource === 'indexer' ? 'indexer' : 'fallback';

  const detailHrefFor = useCallback((height: number) => blockDetailHref(height), []);

  const filteredItems = useMemo(
    () => filterBlocksBySearch(items, searchQuery),
    [items, searchQuery],
  );
  const orderedItems = useMemo(() => sortByHeightDesc(filteredItems), [filteredItems]);

  const onLoadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setLoadMoreError(null);

    const result = await fetchBlocksPage(nextCursor);

    if (!result.ok) {
      setLoadMoreError(result.message);
      setIsLoadingMore(false);
      return;
    }

    const weighted = await withBlockWeights(result.payload.data.items);
    setItems((existing) => mergePaginatedBlocks(existing, weighted.items));
    setNextCursor(result.payload.data.next_cursor);
    setHasMore(result.payload.data.has_more);
    setIsLoadingMore(false);
  }, [hasMore, isLoadingMore, nextCursor]);

  return (
    <>
      <section className="panel-card">
        <h2>Metric sources</h2>
        <p className="subtitle">Block records: runtime. Block weight: {weightSourceLabel}.</p>
      </section>
      {orderedItems.length === 0 ? (
        <section className="card">
          <h2>{searchQuery?.trim() ? 'No blocks matched your search' : 'No blocks yet'}</h2>
          <p className="subtitle">
            {searchQuery?.trim()
              ? 'Try hash:, blocks:, signer:, reader:, or namespace: keywords with a different value.'
              : 'The node runtime returned an empty block list.'}
          </p>
        </section>
      ) : (
        <section className="block-list">
          {orderedItems.map((block) => (
            <Link
              key={block.height}
              className="block-card"
              href={detailHrefFor(block.height)}
              aria-label={`Open block ${block.height}`}
              onClick={persistScrollSnapshot}
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
                  <span className="label">Block weight</span>
                  <span>{block.block_weight_bytes !== undefined ? `${block.block_weight_bytes.toLocaleString('en-US')} bytes` : 'N/A'}</span>
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
          ))}
        </section>
      )}

      {loadMoreError ? (
        <section className="card">
          <h2>Unable to load more blocks</h2>
          <p className="subtitle">{loadMoreError}</p>
        </section>
      ) : null}

      {hasMore && nextCursor ? (
        <section className="pagination-row">
          <button
            type="button"
            className="button-link button-control"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? 'Loading…' : 'Load older blocks'}
          </button>
        </section>
      ) : null}
    </>
  );
}

type SearchToken = {
  key: 'hash' | 'blocks' | 'signer' | 'reader' | 'namespace' | 'any';
  value: string;
};

function filterBlocksBySearch(items: BlockSummary[], rawQuery?: string): BlockSummary[] {
  const query = rawQuery?.trim();
  if (!query) {
    return items;
  }

  const tokens = parseSearchTokens(query);
  if (tokens.length === 0) {
    return items;
  }

  return items.filter((item) => tokens.every((token) => matchesToken(item, token)));
}

function parseSearchTokens(query: string): SearchToken[] {
  const parts = query
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.map((part) => {
    const match = /^(hash|blocks|signer|reader|namespace):(.+)$/i.exec(part);
    if (!match) {
      return { key: 'any', value: part.toLowerCase() };
    }

    return {
      key: match[1].toLowerCase() as SearchToken['key'],
      value: match[2].toLowerCase(),
    };
  });
}

function matchesToken(item: BlockSummary, token: SearchToken): boolean {
  const hashFields = [
    item.header.prev_hash,
    item.header.entry_root,
    item.header.commit_proof.aggregated_signature,
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const searchableBlob = [
    item.height.toString(),
    item.header.proposer,
    ...item.entry_ids,
    ...hashFields,
  ]
    .join(' ')
    .toLowerCase();

  switch (token.key) {
    case 'hash':
      return hashFields.some((value) => value.includes(token.value));
    case 'blocks':
      return item.height.toString().includes(token.value);
    case 'signer':
      return item.header.proposer.toLowerCase().includes(token.value);
    case 'reader':
    case 'namespace':
      return searchableBlob.includes(token.value);
    case 'any':
      return searchableBlob.includes(token.value);
    default:
      return false;
  }
}
