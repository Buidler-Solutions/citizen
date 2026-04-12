import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  CursorState,
  IndexerAlert,
  IndexedBlock,
  IndexedEntry,
  IndexerSummary,
  LatencySnapshot,
  MetricWindow,
  MetricWindowName,
  PaginatedResult,
  RuntimeBlock,
} from './metrics.types';
import { computeCanonicalWeight, roundHalfAwayFromZero } from './weight';

type BlockLookup = {
  height: number;
  block: RuntimeBlock | null;
};

const WINDOW_SECONDS: Record<MetricWindowName, number> = {
  '10s': 10,
  '60s': 60,
  '5m': 300,
  '1h': 3600,
};

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

@Injectable()
export class IndexerMetricsService {
  private readonly logger = new Logger(IndexerMetricsService.name);
  private readonly baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://127.0.0.1:8081';
  private readonly pollMs = Number(process.env.INDEXER_POLL_MS ?? '4000');
  private readonly backoffMs = [250, 500, 1000];
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly allowedLatenessSeconds = Number(process.env.INDEXER_ALLOWED_LATENESS_SECONDS ?? '120');
  private readonly blockRetentionSeconds = Number(process.env.INDEXER_BLOCK_RETENTION_SECONDS ?? '2592000');
  private readonly entryRetentionSeconds = Number(process.env.INDEXER_ENTRY_RETENTION_SECONDS ?? '604800');
  private readonly windowRetentionSeconds = Number(process.env.INDEXER_WINDOW_RETENTION_SECONDS ?? '604800');
  private readonly maxLagBlocksSlo = Number(process.env.INDEXER_SLO_MAX_INGESTION_LAG_BLOCKS ?? '5');
  private readonly maxBlockProcessingP95MsSlo = Number(process.env.INDEXER_SLO_MAX_P95_BLOCK_PROCESSING_MS ?? '2000');
  private readonly maxAggregationP95MsSlo = Number(process.env.INDEXER_SLO_MAX_P95_AGGREGATION_MS ?? '1000');
  private readonly minAvailabilityRatioSlo = Number(process.env.INDEXER_SLO_MIN_AVAILABILITY_RATIO ?? '0.995');
  private readonly stallThresholdSeconds = Number(process.env.INDEXER_ALERT_STALL_CURSOR_SECONDS ?? '120');
  private readonly sustainedLagPollThreshold = Number(process.env.INDEXER_ALERT_SUSTAINED_LAG_POLLS ?? '3');

  private readonly indexedBlocks = new Map<number, IndexedBlock>();
  private readonly indexedEntries = new Map<string, IndexedEntry>();
  private readonly metricWindows = new Map<MetricWindowName, MetricWindow[]>();
  private readonly poisonBlocks: Array<{ height: number; reason: string; detected_at: number }> = [];
  private latestCommittedAt: number | null = null;
  private lateEntriesAccepted = 0;
  private failedBlockCount = 0;
  private retryCountTotal = 0;
  private fetchAttemptTotal = 0;
  private successfulBlockCount = 0;
  private consecutiveLagPolls = 0;
  private readonly blockProcessingLatenciesMs: number[] = [];
  private readonly aggregationLatenciesMs: number[] = [];

  private cursor: CursorState = {
    last_indexed_height: -1,
    last_indexed_block_hash: null,
    degraded: false,
    last_error: null,
    retry_count: 0,
    updated_at: null,
  };

  startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.catchUpToLatest();
    }, this.pollMs);
    void this.catchUpToLatest();
  }

  stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async getSummary(): Promise<IndexerSummary> {
    await this.catchUpToLatest();
    const runtimeLatestHeight = await this.findLatestHeight();
    const indexedHeight = this.cursor.last_indexed_height;
    const ingestionLagBlocks =
      runtimeLatestHeight < 0 || indexedHeight < 0
        ? 0
        : Math.max(runtimeLatestHeight - indexedHeight, 0);
    const alerts = this.evaluateAlerts(runtimeLatestHeight, indexedHeight, ingestionLagBlocks);
    const slo = this.evaluateSlo(alerts, ingestionLagBlocks);
    return {
      cursor: { ...this.cursor },
      counts: {
        indexed_blocks: this.indexedBlocks.size,
        indexed_entries: this.indexedEntries.size,
      },
      lag: {
        runtime_latest_height: runtimeLatestHeight,
        indexed_height: indexedHeight,
        ingestion_lag_blocks: ingestionLagBlocks,
      },
      poison_blocks: this.poisonBlocks.slice(-20),
      late_data: {
        accepted_entries: this.lateEntriesAccepted,
        latest_committed_at: this.latestCommittedAt,
        allowed_lateness_seconds: this.allowedLatenessSeconds,
      },
      internal_metrics: {
        failed_block_count: this.failedBlockCount,
        retry_count_total: this.retryCountTotal,
        block_processing_latency_ms: this.toLatencySnapshot(this.blockProcessingLatenciesMs),
        aggregation_job_latency_ms: this.toLatencySnapshot(this.aggregationLatenciesMs),
      },
      slo,
      alerts,
    };
  }

  async getAlerts(): Promise<IndexerAlert[]> {
    const summary = await this.getSummary();
    return summary.alerts;
  }

  async queryBlockMetrics(
    fromHeight?: number,
    toHeight?: number,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedResult<IndexedBlock>> {
    await this.catchUpToLatest();
    const rows = Array.from(this.indexedBlocks.values()).sort((a, b) => b.block_height - a.block_height);
    const filtered = rows.filter((row) => {
      if (fromHeight !== undefined && row.block_height < fromHeight) {
        return false;
      }
      if (toHeight !== undefined && row.block_height > toHeight) {
        return false;
      }
      if (cursor !== undefined && row.block_height >= this.parseCursorInteger(cursor, 'cursor')) {
        return false;
      }
      return true;
    });
    return this.paginate(filtered, limit, (row) => String(row.block_height));
  }

  async queryEntryMetrics(
    namespace?: string,
    entryIds?: string[],
    from?: number,
    to?: number,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedResult<IndexedEntry>> {
    await this.catchUpToLatest();
    const rows = Array.from(this.indexedEntries.values()).sort(
      (a, b) => b.committed_at - a.committed_at || b.block_height - a.block_height,
    );
    const cursorKey = cursor ? this.decodeCursor(cursor) : null;
    const entryIdSet = entryIds && entryIds.length > 0 ? new Set(entryIds) : null;
    const filtered = rows.filter((row) => {
      if (namespace && row.namespace !== namespace) {
        return false;
      }
      if (entryIdSet && !entryIdSet.has(row.entry_id)) {
        return false;
      }
      if (from !== undefined && row.committed_at < from) {
        return false;
      }
      if (to !== undefined && row.committed_at > to) {
        return false;
      }
      if (cursorKey && this.entryCursorKey(row) >= cursorKey) {
        return false;
      }
      return true;
    });
    return this.paginate(filtered, limit, (row) => this.entryCursorToken(row));
  }

  async queryTps(
    windowName: MetricWindowName,
    from?: number,
    to?: number,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedResult<MetricWindow>> {
    await this.catchUpToLatest();
    const rows = this.metricWindows.get(windowName) ?? [];
    const filtered = rows
      .slice()
      .sort((a, b) => b.window_start - a.window_start)
      .filter((row) => {
      if (from !== undefined && row.window_start < from) {
        return false;
      }
      if (to !== undefined && row.window_end > to) {
        return false;
      }
      if (cursor !== undefined && row.window_start >= this.parseCursorInteger(cursor, 'cursor')) {
        return false;
      }
      return true;
    });
    return this.paginate(filtered, limit, (row) => String(row.window_start));
  }

  private async catchUpToLatest(): Promise<void> {
    if (this.cursor.degraded) {
      return;
    }

    const latest = await this.findLatestHeight();
    if (latest < 0 || latest <= this.cursor.last_indexed_height) {
      return;
    }

    for (let height = this.cursor.last_indexed_height + 1; height <= latest; height += 1) {
      const candidate = await this.fetchBlockWithRetry(height);
      if (!candidate?.block) {
        if (
          this.cursor.last_indexed_height < 0 &&
          this.indexedBlocks.size === 0 &&
          height < latest
        ) {
          continue;
        }
        this.markDegraded(height, 'missing-block');
        return;
      }
      const continuityError = this.verifyContinuity(candidate.block);
      if (continuityError) {
        this.markDegraded(height, continuityError);
        return;
      }
      const blockStartMs = Date.now();
      this.persistBlockAtomically(candidate.block);
      this.recordLatency(this.blockProcessingLatenciesMs, Date.now() - blockStartMs);
    }
  }

  private verifyContinuity(block: RuntimeBlock): string | null {
    const height = block.header.height;
    if (this.cursor.last_indexed_height < 0 && this.indexedBlocks.size === 0) {
      return null;
    }
    if (height === 0) {
      return null;
    }
    const previousBlock = this.indexedBlocks.get(height - 1);
    if (!previousBlock) {
      return `gap-detected:missing-prev-height:${height - 1}`;
    }
    if (this.isUnknownHash(previousBlock.block_hash)) {
      return null;
    }
    if (block.header.prev_hash !== previousBlock.block_hash) {
      return `prev-hash-mismatch:expected=${previousBlock.block_hash},actual=${block.header.prev_hash}`;
    }
    return null;
  }

  private persistBlockAtomically(block: RuntimeBlock): void {
    const now = Date.now();
    const blockHeight = block.header.height;
    const blockHash = this.deriveBlockHash(block);
    const blockWeight = computeCanonicalWeight(block);
    const stagedEntries: IndexedEntry[] = block.entries.map((entry, entryIndex) => ({
      entry_id: entry.entry_id,
      block_height: blockHeight,
      entry_index: entryIndex,
      namespace: entry.namespace,
      action: entry.action,
      committed_at: entry.timestamp,
      entry_weight_bytes: computeCanonicalWeight(entry),
      signer: typeof entry.author === 'string' ? entry.author : null,
      first_seen_at: now,
      updated_at: now,
    }));
    const blockLatestCommittedAt = stagedEntries.reduce(
      (current, entry) => Math.max(current, entry.committed_at),
      this.latestCommittedAt ?? Number.MIN_SAFE_INTEGER,
    );

    const existingBlock = this.indexedBlocks.get(blockHeight);
    if (
      existingBlock &&
      existingBlock.block_hash !== blockHash &&
      !(this.isUnknownHash(existingBlock.block_hash) && !this.isUnknownHash(blockHash))
    ) {
      this.markDegraded(
        blockHeight,
        `poison-block:block-hash-changed:existing=${existingBlock.block_hash},incoming=${blockHash}`,
      );
      return;
    }

    for (const entry of stagedEntries) {
      const existingEntry = this.indexedEntries.get(entry.entry_id);
      if (
        existingEntry &&
        (existingEntry.block_height !== entry.block_height ||
          existingEntry.entry_index !== entry.entry_index ||
          existingEntry.entry_weight_bytes !== entry.entry_weight_bytes)
      ) {
        this.markDegraded(
          blockHeight,
          `poison-entry:entry-id-conflict:${entry.entry_id}`,
        );
        return;
      }
    }

    this.indexedBlocks.set(blockHeight, {
      block_height: blockHeight,
      block_hash: blockHash,
      prev_hash: block.header.prev_hash,
      proposer: typeof block.header.proposer === 'string' ? block.header.proposer : null,
      committed_at: block.header.timestamp,
      entry_count: block.entries.length,
      block_weight_bytes: blockWeight,
      first_seen_at: existingBlock?.first_seen_at ?? now,
      updated_at: now,
    });

    for (const entry of stagedEntries) {
      if (
        this.latestCommittedAt !== null &&
        entry.committed_at < this.latestCommittedAt - this.allowedLatenessSeconds
      ) {
        this.lateEntriesAccepted += 1;
      }
      const existing = this.indexedEntries.get(entry.entry_id);
      this.indexedEntries.set(entry.entry_id, {
        ...entry,
        first_seen_at: existing?.first_seen_at ?? entry.first_seen_at,
      });
    }
    this.latestCommittedAt =
      this.latestCommittedAt === null ? blockLatestCommittedAt : Math.max(this.latestCommittedAt, blockLatestCommittedAt);

    this.cursor = {
      ...this.cursor,
      last_indexed_height: blockHeight,
      last_indexed_block_hash: blockHash,
      updated_at: now,
      last_error: null,
      retry_count: 0,
    };
    this.successfulBlockCount += 1;

    this.recomputeWindows();
    this.compactRetention();
  }

  private recomputeWindows(): void {
    const recomputeStartMs = Date.now();
    const entries = Array.from(this.indexedEntries.values());
    const now = Date.now();
    (Object.keys(WINDOW_SECONDS) as MetricWindowName[]).forEach((windowName) => {
      const seconds = WINDOW_SECONDS[windowName];
      const buckets = new Map<number, number>();
      for (const entry of entries) {
        const start = Math.floor(entry.committed_at / seconds) * seconds;
        buckets.set(start, (buckets.get(start) ?? 0) + 1);
      }

      const windows = Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([windowStart, entriesCommitted]) => ({
          window_name: windowName,
          window_start: windowStart,
          window_end: windowStart + seconds,
          entries_committed: entriesCommitted,
          tps: roundHalfAwayFromZero(entriesCommitted / seconds, 3),
          computed_at: now,
          is_estimated:
            this.latestCommittedAt === null
              ? false
              : windowStart + seconds > this.latestCommittedAt - this.allowedLatenessSeconds,
        }));
      this.metricWindows.set(windowName, windows);
    });
    this.recordLatency(this.aggregationLatenciesMs, Date.now() - recomputeStartMs);
  }

  private compactRetention(): void {
    const watermark = this.latestCommittedAt ?? Math.floor(Date.now() / 1000);
    const blockCutoff = watermark - this.blockRetentionSeconds;
    const entryCutoff = watermark - this.entryRetentionSeconds;
    const windowCutoff = watermark - this.windowRetentionSeconds;

    for (const [height, block] of this.indexedBlocks.entries()) {
      if (block.committed_at < blockCutoff) {
        this.indexedBlocks.delete(height);
      }
    }

    for (const [entryId, entry] of this.indexedEntries.entries()) {
      if (entry.committed_at < entryCutoff) {
        this.indexedEntries.delete(entryId);
      }
    }

    for (const [windowName, windows] of this.metricWindows.entries()) {
      this.metricWindows.set(
        windowName,
        windows.filter((window) => window.window_end >= windowCutoff),
      );
    }
  }

  private deriveBlockHash(block: RuntimeBlock): string {
    if (typeof block.hash === 'string' && block.hash.trim()) {
      return block.hash;
    }
    const headerHash = (block.header as { hash?: unknown }).hash;
    if (typeof headerHash === 'string' && headerHash.trim()) {
      return headerHash;
    }
    const headerBlockHash = (block.header as { block_hash?: unknown }).block_hash;
    if (typeof headerBlockHash === 'string' && headerBlockHash.trim()) {
      return headerBlockHash;
    }
    return `unknown:${block.header.height}`;
  }

  private isUnknownHash(hash: string): boolean {
    return hash.startsWith('unknown:');
  }

  private markDegraded(height: number, reason: string): void {
    const detectedAt = Date.now();
    this.failedBlockCount += 1;
    this.cursor = {
      ...this.cursor,
      degraded: true,
      last_error: reason,
      updated_at: detectedAt,
    };
    this.poisonBlocks.push({ height, reason, detected_at: detectedAt });
    this.logger.error(`Indexer degraded at height=${height}: ${reason}`);
  }

  private async fetchBlockWithRetry(height: number): Promise<BlockLookup | null> {
    let lastError = '';
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt += 1) {
      try {
        this.fetchAttemptTotal += 1;
        const block = await this.fetchBlockOrNull(height);
        this.cursor.retry_count = attempt;
        return block;
      } catch (error) {
        this.retryCountTotal += 1;
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === this.backoffMs.length) {
          break;
        }
        await this.sleep(this.backoffMs[attempt]);
      }
    }
    this.markDegraded(height, `fetch-failed:${lastError}`);
    return null;
  }

  private async findLatestHeight(): Promise<number> {
    const heightZeroBlock = await this.fetchBlockOrNull(0);
    const heightOneBlock = await this.fetchBlockOrNull(1);

    if (!heightZeroBlock?.block && !heightOneBlock?.block) {
      return -1;
    }

    let lowerBound = heightOneBlock?.block ? 1 : 0;
    let upperBound = lowerBound;

    while (true) {
      const candidate = Math.max(upperBound * 2, upperBound + 1);
      const block = await this.fetchBlockOrNull(candidate);
      if (!block?.block) {
        upperBound = candidate;
        break;
      }
      lowerBound = candidate;
      upperBound = candidate;
    }

    let left = lowerBound;
    let right = upperBound;
    while (left + 1 < right) {
      const mid = Math.floor((left + right) / 2);
      const block = await this.fetchBlockOrNull(mid);
      if (block?.block) {
        left = mid;
      } else {
        right = mid;
      }
    }
    return left;
  }

  private async fetchBlockOrNull(height: number): Promise<BlockLookup | null> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks/${height}`;
    const response = await fetch(endpoint);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
    }
    return (await response.json()) as BlockLookup;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private parseCursorInteger(cursor: string, label: string): number {
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`${label} must be an integer cursor`);
    }
    return parsed;
  }

  private decodeCursor(cursor: string): string {
    try {
      return Buffer.from(cursor, 'base64url').toString('utf8');
    } catch (_error) {
      throw new BadRequestException('cursor must be valid base64url');
    }
  }

  private entryCursorKey(entry: IndexedEntry): string {
    const committed = String(entry.committed_at).padStart(12, '0');
    const height = String(entry.block_height).padStart(12, '0');
    return `${committed}:${height}:${entry.entry_id}`;
  }

  private entryCursorToken(entry: IndexedEntry): string {
    return Buffer.from(this.entryCursorKey(entry), 'utf8').toString('base64url');
  }

  private paginate<T>(rows: T[], requestedLimit: number | undefined, cursorFor: (row: T) => string): PaginatedResult<T> {
    const limit = this.clampLimit(requestedLimit);
    const data = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore && data.length > 0 ? cursorFor(data[data.length - 1]) : null;
    return {
      data,
      page: {
        limit,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    };
  }

  private clampLimit(limit?: number): number {
    if (limit === undefined) {
      return DEFAULT_PAGE_LIMIT;
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(limit, MAX_PAGE_LIMIT);
  }

  private recordLatency(target: number[], latencyMs: number): void {
    target.push(Math.max(latencyMs, 0));
    if (target.length > 1024) {
      target.splice(0, target.length - 1024);
    }
  }

  private toLatencySnapshot(latencies: number[]): LatencySnapshot {
    if (latencies.length === 0) {
      return {
        samples: 0,
        avg: 0,
        p95: 0,
        max: 0,
        last: null,
      };
    }
    const sorted = latencies.slice().sort((a, b) => a - b);
    const p95Index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      samples: latencies.length,
      avg: roundHalfAwayFromZero(total / sorted.length, 2),
      p95: sorted[p95Index],
      max: sorted[sorted.length - 1],
      last: latencies[latencies.length - 1] ?? null,
    };
  }

  private evaluateSlo(alerts: IndexerAlert[], ingestionLagBlocks: number) {
    const blockLatencySnapshot = this.toLatencySnapshot(this.blockProcessingLatenciesMs);
    const aggregationLatencySnapshot = this.toLatencySnapshot(this.aggregationLatenciesMs);
    const availabilityRatio = this.fetchAttemptTotal === 0
      ? 1
      : this.successfulBlockCount / this.fetchAttemptTotal;
    const checks = [
      {
        name: 'freshness',
        target: `ingestion_lag_blocks <= ${this.maxLagBlocksSlo}`,
        observed: `${ingestionLagBlocks}`,
        status: this.compareNumber(ingestionLagBlocks, this.maxLagBlocksSlo),
      },
      {
        name: 'api_availability_proxy',
        target: `successful_fetch_ratio >= ${this.minAvailabilityRatioSlo}`,
        observed: `${roundHalfAwayFromZero(availabilityRatio, 4)}`,
        status: this.compareNumberDescending(availabilityRatio, this.minAvailabilityRatioSlo),
      },
      {
        name: 'aggregation_correctness_proxy',
        target: 'no checksum mismatch alerts',
        observed: alerts.some((alert) => alert.id === 'checksum_mismatch' && alert.active)
          ? 'checksum mismatch active'
          : 'no mismatches',
        status: alerts.some((alert) => alert.id === 'checksum_mismatch' && alert.active) ? 'fail' : 'pass',
      },
      {
        name: 'block_processing_latency',
        target: `p95_ms <= ${this.maxBlockProcessingP95MsSlo}`,
        observed: `${blockLatencySnapshot.p95}`,
        status: this.compareNumber(blockLatencySnapshot.p95, this.maxBlockProcessingP95MsSlo),
      },
      {
        name: 'aggregation_job_latency',
        target: `p95_ms <= ${this.maxAggregationP95MsSlo}`,
        observed: `${aggregationLatencySnapshot.p95}`,
        status: this.compareNumber(aggregationLatencySnapshot.p95, this.maxAggregationP95MsSlo),
      },
    ];
    const hasFail = checks.some((check) => check.status === 'fail');
    return {
      status: hasFail ? 'fail' : 'pass',
      checks,
    };
  }

  private evaluateAlerts(runtimeLatestHeight: number, indexedHeight: number, ingestionLagBlocks: number): IndexerAlert[] {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const updatedAtSeconds = this.cursor.updated_at === null ? null : Math.floor(this.cursor.updated_at / 1000);
    const stalledCursorActive = updatedAtSeconds !== null
      && runtimeLatestHeight > indexedHeight
      && nowSeconds - updatedAtSeconds >= this.stallThresholdSeconds;

    if (ingestionLagBlocks > this.maxLagBlocksSlo) {
      this.consecutiveLagPolls += 1;
    } else {
      this.consecutiveLagPolls = 0;
    }
    const sustainedLagActive = this.consecutiveLagPolls >= this.sustainedLagPollThreshold;
    const checksumMismatchActive = this.poisonBlocks.some((candidate) =>
      candidate.reason.includes('prev-hash-mismatch')
      || candidate.reason.includes('poison-entry')
      || candidate.reason.includes('poison-block'),
    );

    return [
      {
        id: 'stalled_cursor',
        severity: 'critical',
        active: stalledCursorActive,
        message: 'Indexer cursor has not advanced while runtime has newer blocks.',
        observed: updatedAtSeconds === null ? 'never-indexed' : `${nowSeconds - updatedAtSeconds}s since last cursor update`,
        threshold: `${this.stallThresholdSeconds}s`,
        playbook: [
          'Check indexer logs for fetch-failed or missing-block degradation reasons.',
          'Verify node API reachability and /blocks/{height} latency.',
          'Restart indexer after resolving connectivity or data-source issues.',
        ],
      },
      {
        id: 'sustained_lag',
        severity: 'warning',
        active: sustainedLagActive,
        message: 'Indexer lag exceeded freshness target for multiple consecutive polls.',
        observed: `${ingestionLagBlocks} lag blocks for ${this.consecutiveLagPolls} polls`,
        threshold: `${this.maxLagBlocksSlo} lag blocks for ${this.sustainedLagPollThreshold} polls`,
        playbook: [
          'Inspect processing latency and retry counters for bottlenecks.',
          'Scale indexer worker resources or reduce polling interval if needed.',
          'Evaluate whether upstream node is saturated or returning intermittent failures.',
        ],
      },
      {
        id: 'checksum_mismatch',
        severity: 'critical',
        active: checksumMismatchActive,
        message: 'Indexer continuity or idempotency checks detected inconsistent chain data.',
        observed: checksumMismatchActive
          ? `${this.poisonBlocks[this.poisonBlocks.length - 1]?.reason ?? 'mismatch-detected'}`
          : 'none',
        threshold: '0 mismatches',
        playbook: [
          'Freeze explorer analytics source to runtime/fallback until resolved.',
          'Run targeted replay from last known good height and compare block hashes.',
          'Escalate to protocol operators with poison block evidence and timestamps.',
        ],
      },
    ];
  }

  private compareNumber(observed: number, targetMax: number): 'pass' | 'fail' {
    return observed <= targetMax ? 'pass' : 'fail';
  }

  private compareNumberDescending(observed: number, targetMin: number): 'pass' | 'fail' {
    return observed >= targetMin ? 'pass' : 'fail';
  }
}
