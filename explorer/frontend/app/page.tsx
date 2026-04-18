import { fetchBlocksPage } from './lib/blocks';
import { HomeDashboard } from './components/home-dashboard';
import { deriveLocalIndexerMetrics, type RuntimeBlock } from './lib/local-indexer';
import { metricsSourceMode, shouldUseIndexerMetrics } from './lib/metrics-source';

export const dynamic = 'force-dynamic';

type BlockLookupResponse = {
  data?: {
    block?: RuntimeBlock | null;
  };
};

type BackendSummary = {
  lag?: {
    indexed_height?: number;
  };
};

type BackendBlockMetric = {
  block_height: number;
  committed_at: number;
  entry_count: number;
  block_weight_bytes: number;
};

type BackendEntryMetric = {
  entry_id: string;
  committed_at: number;
  entry_weight_bytes: number;
  signer: string | null;
};

type BackendTpsPoint = {
  tps: number;
};

type PaginatedPayload<T> = {
  data?: T[];
};

const nodeRuntimeBase = process.env.NEXT_PUBLIC_NODE_RUNTIME_URL ?? 'http://127.0.0.1:8081';
const explorerBackendBase = process.env.NEXT_PUBLIC_EXPLORER_BACKEND_URL ?? 'http://127.0.0.1:4444';

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { next: { revalidate: 5 } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function asArrayPayload<T>(value: T[] | PaginatedPayload<T> | null): T[] | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value.data)) {
    return value.data;
  }

  return null;
}

function formatRelativeMinutes(epochSeconds: number | undefined): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) {
    return 'N/A';
  }

  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(1, Math.floor((now - epochSeconds) / 60));
  return `${delta} minutes`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function buildComparisonSeries(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  return values.map((current, index) => {
    if (index === 0) {
      return 100;
    }

    const previous = values[index - 1];
    if (!Number.isFinite(previous) || previous <= 0) {
      return 100;
    }

    return Math.max(1, Math.round((current / previous) * 100));
  });
}

function formatEntryComparison(currentWeight: number, previousWeight: number | undefined): string {
  const prev = previousWeight ?? 0;
  if (!Number.isFinite(prev) || prev <= 0) {
    return 'No previous entry to compare';
  }

  const delta = ((currentWeight - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `vs previous entry: ${sign}${delta.toFixed(1)}%`;
}

function formatSeriesComparison(
  currentValue: number,
  previousValue: number | undefined,
  emptyLabel: string,
  prefixLabel: string,
): string {
  const prev = previousValue ?? 0;
  if (!Number.isFinite(prev) || prev <= 0) {
    return emptyLabel;
  }

  const delta = ((currentValue - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${prefixLabel}: ${sign}${delta.toFixed(1)}%`;
}

function compactDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

function shortId(value: string | undefined | null): string {
  if (!value || value.length < 12) {
    return value ?? 'N/A';
  }

  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

async function fetchBackendMetrics() {
  const base = explorerBackendBase.replace(/\/$/, '');
  const [summary, blocks, entries, tps] = await Promise.all([
    safeFetchJson<BackendSummary>(`${base}/metrics/summary`),
    safeFetchJson<BackendBlockMetric[] | PaginatedPayload<BackendBlockMetric>>(`${base}/metrics/blocks`),
    safeFetchJson<BackendEntryMetric[] | PaginatedPayload<BackendEntryMetric>>(`${base}/metrics/entries`),
    safeFetchJson<BackendTpsPoint[] | PaginatedPayload<BackendTpsPoint>>(`${base}/metrics/tps?window=60s`),
  ]);

  const normalizedBlocks = asArrayPayload(blocks);
  const normalizedEntries = asArrayPayload(entries);
  const normalizedTps = asArrayPayload(tps);

  if (!summary || !normalizedBlocks || !normalizedEntries || !normalizedTps) {
    return null;
  }

  return { summary, blocks: normalizedBlocks, entries: normalizedEntries, tps: normalizedTps };
}

export default async function HomePage() {
  const backendMetrics = shouldUseIndexerMetrics() ? await fetchBackendMetrics() : null;

  if (backendMetrics) {
    const { blocks, entries, tps, summary } = backendMetrics;
    const uniqueAuthors = new Set(entries.map((entry) => entry.signer).filter(Boolean));
    const latestTps = tps[tps.length - 1]?.tps ?? 0;

    const topMetrics = [
      { label: 'Sampled Blocks', value: `${blocks.length.toLocaleString('en-US')}`, icon: '⛓' },
      { label: 'Indexed Entries', value: `${entries.length.toLocaleString('en-US')}`, icon: '⇄' },
      { label: 'Latest TPS (60s)', value: latestTps.toFixed(3), icon: '⏱' },
      { label: 'Indexed Height', value: `${summary.lag?.indexed_height ?? 'N/A'}`, icon: '◎' },
    ];

    const charts = [
      (() => {
        const currentEntryWindow = entries.slice(0, 10);
        const currentWeight = currentEntryWindow[0]?.entry_weight_bytes ?? 0;
        const previousWeight = currentEntryWindow[1]?.entry_weight_bytes;

        return {
          title: 'Entry Weight (indexer API)',
          primary: `${formatBytes(currentWeight)}`,
          secondary: formatEntryComparison(currentWeight, previousWeight),
          dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
          points: buildComparisonSeries(currentEntryWindow.map((entry) => entry.entry_weight_bytes).reverse()),
          mode: 'line' as const,
        };
      })(),
      {
        title: 'TPS (60s, indexer API)',
        primary: `${latestTps.toFixed(3)}`,
        secondary: formatSeriesComparison(
          latestTps,
          tps[tps.length - 2]?.tps,
          'No previous TPS sample to compare',
          'vs previous TPS sample',
        ),
        dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
        points: buildComparisonSeries(tps.slice(-10).map((point) => point.tps)),
        mode: 'line' as const,
      },
      {
        title: 'Block Weight (indexer API)',
        primary: `${formatBytes(blocks[0]?.block_weight_bytes ?? 0)}`,
        secondary: formatSeriesComparison(
          blocks[0]?.block_weight_bytes ?? 0,
          blocks[1]?.block_weight_bytes,
          'No previous block to compare',
          'vs previous block',
        ),
        dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
        points: buildComparisonSeries(blocks.slice(0, 10).map((item) => item.block_weight_bytes).reverse()),
        mode: 'line' as const,
      },
    ];

    const transactions = entries.slice(0, 10).map((entry) => ({
      id: shortId(entry.entry_id),
      from: shortId(entry.signer),
      sizeLabel: formatBytes(entry.entry_weight_bytes),
      ageLabel: formatRelativeMinutes(entry.committed_at),
    }));

    const blockRows = blocks.slice(0, 10).map((block) => ({
      height: block.block_height,
      txCount: block.entry_count,
      timestampLabel: compactDate(block.committed_at),
      sizeLabel: formatBytes(block.block_weight_bytes),
    }));

    return (
      <HomeDashboard
        topMetrics={topMetrics}
        charts={charts}
        transactions={transactions}
        blocks={blockRows}
        sourceLabel="indexer (backend)"
      />
    );
  }

  const blocksResult = await fetchBlocksPage(undefined, 20);
  const blockHeaders = blocksResult.ok ? blocksResult.payload.data.items : [];

  const blockResponses = await Promise.all(
    blockHeaders.map((item) =>
      safeFetchJson<BlockLookupResponse>(`${nodeRuntimeBase.replace(/\/$/, '')}/blocks/${item.height}`),
    ),
  );

  const runtimeBlocks = blockResponses
    .map((response) => response?.data?.block ?? null)
    .filter((block): block is RuntimeBlock => block !== null);

  const localMetrics = deriveLocalIndexerMetrics(runtimeBlocks, 60);

  const uniqueAuthors = new Set(localMetrics.indexedEntries.map((entry) => entry.author).filter(Boolean));
  const latestTps = localMetrics.tpsSeries[localMetrics.tpsSeries.length - 1]?.tps ?? 0;

  const topMetrics = [
    { label: 'Sampled Blocks', value: `${localMetrics.indexedBlocks.length.toLocaleString('en-US')}`, icon: '⛓' },
    { label: 'Indexed Entries', value: `${localMetrics.indexedEntries.length.toLocaleString('en-US')}`, icon: '⇄' },
    { label: 'Latest TPS (60s)', value: latestTps.toFixed(3), icon: '⏱' },
    { label: 'Distinct Authors', value: `${uniqueAuthors.size.toLocaleString('en-US')}`, icon: '◎' },
  ];

  const currentEntryWindow = localMetrics.indexedEntries.slice(0, 10);
  const currentWeight = currentEntryWindow[0]?.weightBytes ?? 0;
  const previousWeight = currentEntryWindow[1]?.weightBytes;
  const tpsLine = localMetrics.tpsSeries.slice(-10).map((point) => point.tps);

  const charts = [
    {
      title: 'Entry Weight Comparison (local indexer)',
      primary: `Current weight: ${formatBytes(currentWeight)}`,
      secondary: formatEntryComparison(currentWeight, previousWeight),
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: buildComparisonSeries(currentEntryWindow.map((entry) => entry.weightBytes).reverse()),
      mode: 'line' as const,
    },
    {
      title: 'TPS (60s, local windows)',
      primary: `Current TPS: ${latestTps.toFixed(3)}`,
      secondary: formatSeriesComparison(
        latestTps,
        localMetrics.tpsSeries[localMetrics.tpsSeries.length - 2]?.tps,
        'No previous TPS sample to compare',
        'vs previous TPS sample',
      ),
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: buildComparisonSeries(tpsLine),
      mode: 'line' as const,
    },
    {
      title: 'Block Weight Comparison (local indexer)',
      primary: `Current weight: ${formatBytes(localMetrics.indexedBlocks[0]?.blockWeightBytes ?? 0)}`,
      secondary: formatSeriesComparison(
        localMetrics.indexedBlocks[0]?.blockWeightBytes ?? 0,
        localMetrics.indexedBlocks[1]?.blockWeightBytes,
        'No previous block to compare',
        'vs previous block',
      ),
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: buildComparisonSeries(localMetrics.indexedBlocks.slice(0, 10).map((item) => item.blockWeightBytes).reverse()),
      mode: 'line' as const,
    },
  ];

  const transactions = localMetrics.indexedEntries.slice(0, 10).map((entry) => ({
    id: shortId(entry.entryId),
    from: shortId(entry.author),
    sizeLabel: formatBytes(entry.weightBytes),
    ageLabel: formatRelativeMinutes(entry.timestamp),
  }));

  const blockRows = localMetrics.indexedBlocks.slice(0, 10).map((block) => ({
    height: block.height,
    txCount: block.entryCount,
    timestampLabel: compactDate(block.timestamp),
    sizeLabel: formatBytes(block.blockWeightBytes),
  }));

  return (
    <HomeDashboard
      topMetrics={topMetrics}
      charts={charts}
      transactions={transactions}
      blocks={blockRows}
      sourceLabel="local-indexer fallback (frontend)"
    />
  );
}
