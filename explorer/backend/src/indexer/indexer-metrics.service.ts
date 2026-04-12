import { Injectable, Logger } from '@nestjs/common';
import {
  CursorState,
  IndexedBlock,
  IndexedEntry,
  IndexerSummary,
  MetricWindow,
  MetricWindowName,
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

@Injectable()
export class IndexerMetricsService {
  private readonly logger = new Logger(IndexerMetricsService.name);
  private readonly baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://127.0.0.1:8081';
  private readonly pollMs = Number(process.env.INDEXER_POLL_MS ?? '4000');
  private readonly backoffMs = [250, 500, 1000];
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly indexedBlocks = new Map<number, IndexedBlock>();
  private readonly indexedEntries = new Map<string, IndexedEntry>();
  private readonly metricWindows = new Map<MetricWindowName, MetricWindow[]>();
  private readonly poisonBlocks: Array<{ height: number; reason: string; detected_at: number }> = [];

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
    return {
      cursor: { ...this.cursor },
      counts: {
        indexed_blocks: this.indexedBlocks.size,
        indexed_entries: this.indexedEntries.size,
      },
      lag: {
        runtime_latest_height: runtimeLatestHeight,
        indexed_height: indexedHeight,
        ingestion_lag_blocks:
          runtimeLatestHeight < 0 || indexedHeight < 0
            ? 0
            : Math.max(runtimeLatestHeight - indexedHeight, 0),
      },
      poison_blocks: this.poisonBlocks.slice(-20),
    };
  }

  async queryBlockMetrics(fromHeight?: number, toHeight?: number): Promise<IndexedBlock[]> {
    await this.catchUpToLatest();
    const rows = Array.from(this.indexedBlocks.values()).sort((a, b) => b.block_height - a.block_height);
    return rows.filter((row) => {
      if (fromHeight !== undefined && row.block_height < fromHeight) {
        return false;
      }
      if (toHeight !== undefined && row.block_height > toHeight) {
        return false;
      }
      return true;
    });
  }

  async queryEntryMetrics(namespace?: string, from?: number, to?: number): Promise<IndexedEntry[]> {
    await this.catchUpToLatest();
    const rows = Array.from(this.indexedEntries.values()).sort(
      (a, b) => b.committed_at - a.committed_at || b.block_height - a.block_height,
    );
    return rows.filter((row) => {
      if (namespace && row.namespace !== namespace) {
        return false;
      }
      if (from !== undefined && row.committed_at < from) {
        return false;
      }
      if (to !== undefined && row.committed_at > to) {
        return false;
      }
      return true;
    });
  }

  async queryTps(windowName: MetricWindowName, from?: number, to?: number): Promise<MetricWindow[]> {
    await this.catchUpToLatest();
    const rows = this.metricWindows.get(windowName) ?? [];
    return rows.filter((row) => {
      if (from !== undefined && row.window_start < from) {
        return false;
      }
      if (to !== undefined && row.window_end > to) {
        return false;
      }
      return true;
    });
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
      this.persistBlockAtomically(candidate.block);
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
      const existing = this.indexedEntries.get(entry.entry_id);
      this.indexedEntries.set(entry.entry_id, {
        ...entry,
        first_seen_at: existing?.first_seen_at ?? entry.first_seen_at,
      });
    }

    this.cursor = {
      ...this.cursor,
      last_indexed_height: blockHeight,
      last_indexed_block_hash: blockHash,
      updated_at: now,
      last_error: null,
      retry_count: 0,
    };

    this.recomputeWindows();
  }

  private recomputeWindows(): void {
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
        }));
      this.metricWindows.set(windowName, windows);
    });
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
        const block = await this.fetchBlockOrNull(height);
        this.cursor.retry_count = attempt;
        return block;
      } catch (error) {
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
}
