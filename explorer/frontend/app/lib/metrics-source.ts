export type MetricsSourceMode = 'auto' | 'indexer' | 'fallback';

const rawMode = (process.env.NEXT_PUBLIC_METRICS_SOURCE ?? 'auto').trim().toLowerCase();

export const metricsSourceMode: MetricsSourceMode =
  rawMode === 'indexer' || rawMode === 'fallback' ? rawMode : 'auto';

export function shouldUseIndexerMetrics(): boolean {
  return metricsSourceMode === 'auto' || metricsSourceMode === 'indexer';
}
