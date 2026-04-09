import { fetchBlocksPage } from './lib/blocks';
import { HomeDashboard } from './components/home-dashboard';

export const dynamic = 'force-dynamic';

type EntryResponse = {
  source: string;
  data: {
    namespace: string;
    entries: {
      entry_id?: string;
      author?: string;
      timestamp?: number;
      privacy_flag?: boolean;
      authorized_readers?: string[];
      payload: Record<string, unknown>;
    }[];
  };
};

const nodeRuntimeBase = process.env.NEXT_PUBLIC_NODE_RUNTIME_URL ?? 'http://127.0.0.1:8081';
const namespace = process.env.NEXT_PUBLIC_NAMESPACE ?? 'governance.vote';

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { next: { revalidate: 5 } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
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

function pseudoSizeFromPayload(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
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

function shortId(value: string | undefined): string {
  if (!value || value.length < 12) {
    return value ?? 'N/A';
  }

  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export default async function HomePage() {
  const [entries, blocksResult] = await Promise.all([
    safeFetchJson<EntryResponse>(`${nodeRuntimeBase}/entries/${namespace}`),
    fetchBlocksPage(undefined, 10),
  ]);

  const latestEntries = (entries?.data?.entries ?? []).slice(0, 10);
  const blocks = blocksResult.ok ? blocksResult.payload.data.items.slice(0, 10) : [];
  const encryptedEntries = latestEntries.filter((entry) => entry.privacy_flag);
  const publicEntries = Math.max(0, latestEntries.length - encryptedEntries.length);
  const readerAccessCount = new Set(
    latestEntries.flatMap((entry) => entry.authorized_readers ?? [])
  ).size;

  const topMetrics = [
    { label: 'Public Data', value: `${publicEntries.toLocaleString('en-US')}`, icon: '⇄' },
    { label: 'Encrypted Data', value: `${encryptedEntries.length.toLocaleString('en-US')}`, icon: '⏱' },
    {
      label: 'Addresses',
      value: `${new Set(latestEntries.map((item) => item.author).filter(Boolean)).size.toLocaleString('en-US')}`,
      icon: '◫',
    },
    { label: 'Reader Access', value: `${readerAccessCount.toLocaleString('en-US')}`, icon: '◎' },
  ];

  const txBars = latestEntries.map((entry) => pseudoSizeFromPayload(entry.payload));
  const tpsLine = blocks.map((item) => item.entry_count);

  const charts = [
    {
      title: 'Transactions',
      primary: `${latestEntries.length.toLocaleString('en-US')}`,
      secondary: `${(latestEntries.length * 14.9).toFixed(2)}K EOD Estimate`,
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: txBars,
      mode: 'bars' as const,
    },
    {
      title: 'TPS',
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: tpsLine,
      mode: 'line' as const,
    },
    {
      title: 'Data Uploaded',
      primary: `${(txBars.reduce((sum, point) => sum + point, 0) / (1024 * 1024)).toFixed(2)} MiB`,
      secondary: `${(txBars.length * 0.48).toFixed(2)} GiB EOD Estimate`,
      dateLabel: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }),
      points: txBars.slice().reverse(),
      mode: 'bars' as const,
    },
  ];

  const transactions = latestEntries.map((entry) => ({
    id: shortId(entry.entry_id),
    from: shortId(entry.author),
    sizeLabel: formatBytes(pseudoSizeFromPayload(entry.payload)),
    ageLabel: formatRelativeMinutes(entry.timestamp),
  }));

  const blockRows = blocks.map((item) => ({
    height: item.height,
    txCount: item.entry_count,
    timestampLabel: compactDate(item.header.timestamp),
    sizeLabel: formatBytes(item.entry_count * 1024 * 0.82),
  }));

  return (
    <HomeDashboard
      topMetrics={topMetrics}
      charts={charts}
      transactions={transactions}
      blocks={blockRows}
    />
  );
}
