import type { BlockSummary } from './blocks';

export function dedupeByHeight(items: BlockSummary[]): BlockSummary[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.height)) {
      return false;
    }

    seen.add(item.height);
    return true;
  });
}

export function sortByHeightDesc(items: BlockSummary[]): BlockSummary[] {
  return [...items].sort((a, b) => b.height - a.height);
}

export function mergePaginatedBlocks(
  existing: BlockSummary[],
  incoming: BlockSummary[],
): BlockSummary[] {
  return dedupeByHeight([...existing, ...incoming]);
}

type BlocksPaginationState = {
  items: BlockSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

function blockIdentity(block: BlockSummary): string {
  return [
    block.header.prev_hash,
    block.header.entry_root,
    block.header.commit_proof.aggregated_signature,
    String(block.header.timestamp),
    String(block.entry_count),
  ].join('|');
}

export function isRestoredStateCompatible(
  initialItems: BlockSummary[],
  restoredItems: BlockSummary[],
): boolean {
  if (initialItems.length === 0 || restoredItems.length === 0) {
    return true;
  }

  const initialByHeight = new Map(initialItems.map((item) => [item.height, item]));
  let hasOverlap = false;

  for (const restored of restoredItems) {
    const current = initialByHeight.get(restored.height);
    if (!current) {
      continue;
    }
    hasOverlap = true;
    if (blockIdentity(current) !== blockIdentity(restored)) {
      return false;
    }
  }

  if (!hasOverlap) {
    const initialMaxHeight = Math.max(...initialItems.map((item) => item.height));
    const restoredMaxHeight = Math.max(...restoredItems.map((item) => item.height));
    if (restoredMaxHeight > initialMaxHeight) {
      return false;
    }
  }

  return true;
}

export function mergeWithInitialBlocksState(
  initial: BlocksPaginationState,
  restored: BlocksPaginationState,
): BlocksPaginationState {
  return {
    items: mergePaginatedBlocks(initial.items, restored.items),
    nextCursor: restored.nextCursor ?? initial.nextCursor,
    hasMore: initial.hasMore || restored.hasMore,
  };
}
