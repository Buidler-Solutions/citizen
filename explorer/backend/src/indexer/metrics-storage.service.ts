import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { IndexerMetricsSnapshot } from './metrics.types';

@Injectable()
export class IndexerMetricsStorageService {
  private readonly logger = new Logger(IndexerMetricsStorageService.name);
  private readonly stateFile =
    process.env.INDEXER_METRICS_STATE_FILE ?? '.citizen/indexer-metrics-state.json';

  async loadSnapshot(): Promise<IndexerMetricsSnapshot | null> {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as IndexerMetricsSnapshot;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        return null;
      }
      this.logger.warn(`Unable to read indexer snapshot (${this.stateFile}): ${message}`);
      return null;
    }
  }

  async writeSnapshot(snapshot: IndexerMetricsSnapshot): Promise<void> {
    const resolvedStateFile = resolve(this.stateFile);
    const tempPath = `${resolvedStateFile}.tmp`;
    await mkdir(dirname(resolvedStateFile), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    try {
      await rename(tempPath, resolvedStateFile);
    } catch {
      // Fallback for environments where atomic rename fails with relative paths
      await writeFile(resolvedStateFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await unlink(tempPath).catch(() => {});
    }
  }
}
