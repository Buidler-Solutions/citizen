'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BlockSummary,
  type BlocksPageResponse,
  fetchBlocksPage,
} from '../lib/blocks';
import { shortHash, toReadableDate } from '../lib/format';
import { dedupeByHeight, mergePaginatedBlocks, sortByHeightDesc } from '../lib/blocks-list-state';
import { blockDetailHref } from '../lib/block-routes';

type BlocksListClientProps = {
  initialPayload: BlocksPageResponse;
  initialCursor?: string;
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

      setItems(dedupeByHeight(stored.items));
      setNextCursor(stored.nextCursor);
      setHasMore(stored.hasMore);

      window.requestAnimationFrame(() => {
        window.scrollTo({ top: stored.scrollY, behavior: 'auto' });
      });
    } catch {
      // ignore state restoration failures
    }
  }, [currentCursor]);

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

  const detailHrefFor = useCallback((height: number) => blockDetailHref(height), []);

  const orderedItems = useMemo(() => sortByHeightDesc(items), [items]);

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

    setItems((existing) => mergePaginatedBlocks(existing, result.payload.data.items));
    setNextCursor(result.payload.data.next_cursor);
    setHasMore(result.payload.data.has_more);
    setIsLoadingMore(false);
  }, [hasMore, isLoadingMore, nextCursor]);

  return (
    <>
      {orderedItems.length === 0 ? (
        <section className="card">
          <h2>No blocks yet</h2>
          <p className="subtitle">The node runtime returned an empty block list.</p>
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
