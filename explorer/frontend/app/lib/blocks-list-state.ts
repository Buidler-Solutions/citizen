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
