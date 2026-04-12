export type IndexedEntryMetric = {
  entryId: string;
  blockHeight: number;
  timestamp: number;
  weightBytes: number;
  author: string;
  namespace: string;
  action: string;
};

export type IndexedBlockMetric = {
  height: number;
  timestamp: number;
  entryCount: number;
  blockWeightBytes: number;
};

export type TpsPoint = {
  windowStart: number;
  windowEnd: number;
  entriesCommitted: number;
  tps: number;
};

export type RuntimeBlock = {
  header: {
    height: number;
    timestamp: number;
  };
  entries: Array<{
    entry_id: string;
    namespace: string;
    action: string;
    timestamp: number;
    author: string;
    [key: string]: unknown;
  }>;
};

export function computeCanonicalWeight(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

export function deriveLocalIndexerMetrics(
  blocks: RuntimeBlock[],
  windowSeconds = 60,
): {
  indexedBlocks: IndexedBlockMetric[];
  indexedEntries: IndexedEntryMetric[];
  tpsSeries: TpsPoint[];
} {
  const indexedBlocks = blocks
    .map((block) => ({
      height: block.header.height,
      timestamp: block.header.timestamp,
      entryCount: block.entries.length,
      blockWeightBytes: computeCanonicalWeight(block),
    }))
    .sort((a, b) => b.height - a.height);

  const indexedEntries = blocks
    .flatMap((block) =>
      block.entries.map((entry) => ({
        entryId: entry.entry_id,
        blockHeight: block.header.height,
        timestamp: entry.timestamp,
        weightBytes: computeCanonicalWeight(entry),
        author: entry.author,
        namespace: entry.namespace,
        action: entry.action,
      })),
    )
    .sort((a, b) => b.timestamp - a.timestamp || b.blockHeight - a.blockHeight);

  const bucketCounts = new Map<number, number>();
  for (const entry of indexedEntries) {
    const start = Math.floor(entry.timestamp / windowSeconds) * windowSeconds;
    bucketCounts.set(start, (bucketCounts.get(start) ?? 0) + 1);
  }

  const tpsSeries = Array.from(bucketCounts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([windowStart, entriesCommitted]) => ({
      windowStart,
      windowEnd: windowStart + windowSeconds,
      entriesCommitted,
      tps: roundHalfAwayFromZero(entriesCommitted / windowSeconds, 3),
    }));

  return { indexedBlocks, indexedEntries, tpsSeries };
}

function roundHalfAwayFromZero(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return rounded / factor;
}
