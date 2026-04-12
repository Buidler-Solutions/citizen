import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { CitizenService } from './citizen.service';
import { IndexerMetricsService } from './indexer/indexer-metrics.service';
import { MetricWindowName } from './indexer/metrics.types';

@Controller()
export class AppController {
  constructor(
    private readonly citizenService: CitizenService,
    private readonly indexerMetricsService: IndexerMetricsService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('status')
  async status() {
    return this.citizenService.getStatus();
  }

  @Get('blocks')
  async blocks(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.citizenService.getBlocks(cursor, limit);
  }

  @Get('blocks/:height')
  async block(@Param('height') height: string) {
    return this.citizenService.getBlock(Number(height));
  }

  @Get('entries/:namespace')
  async entries(@Param('namespace') namespace: string) {
    return this.citizenService.getEntries(namespace);
  }

  @Get('entries/:namespace/wallet-signers/:signerDid')
  async entriesByWalletSigner(
    @Param('namespace') namespace: string,
    @Param('signerDid') signerDid: string,
  ) {
    return this.citizenService.getEntriesByWalletSigner(namespace, decodeURIComponent(signerDid));
  }

  @Get('receipts/:receiptId')
  async receipt(@Param('receiptId') receiptId: string) {
    return this.citizenService.getReceipt(receiptId);
  }

  @Get('files/manifests/:manifestId')
  async fileManifest(@Param('manifestId') manifestId: string) {
    return this.citizenService.getFileManifest(manifestId);
  }

  @Get('files/timeline/:manifestId')
  async fileTimeline(@Param('manifestId') manifestId: string) {
    return this.citizenService.getFileTimeline(manifestId);
  }

  @Get('payloads/fields/:entryId/:namespace')
  async payloadFieldRefs(@Param('entryId') entryId: string, @Param('namespace') namespace: string) {
    return this.citizenService.getPayloadFieldRefs(entryId, namespace);
  }

  @Get('payloads/data-hash/:dataHash')
  async payloadDataHash(@Param('dataHash') dataHash: string) {
    return this.citizenService.getPayloadDataHash(decodeURIComponent(dataHash));
  }

  @Get('data-hash')
  async payloadDataHashByQuery(@Query('q') dataHash?: string) {
    if (!dataHash || !dataHash.trim()) {
      throw new BadRequestException('missing required query parameter: q');
    }
    return this.citizenService.getPayloadDataHash(dataHash.trim());
  }

  @Get('metrics/summary')
  async metricsSummary() {
    return this.indexerMetricsService.getSummary();
  }

  @Get('metrics/blocks')
  async metricsBlocks(@Query('from_height') fromHeight?: string, @Query('to_height') toHeight?: string) {
    return this.indexerMetricsService.queryBlockMetrics(
      this.optionalInteger(fromHeight, 'from_height'),
      this.optionalInteger(toHeight, 'to_height'),
    );
  }

  @Get('metrics/entries')
  async metricsEntries(
    @Query('namespace') namespace?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.indexerMetricsService.queryEntryMetrics(
      namespace,
      this.optionalInteger(from, 'from'),
      this.optionalInteger(to, 'to'),
    );
  }

  @Get('metrics/tps')
  async metricsTps(@Query('window') window?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.indexerMetricsService.queryTps(
      this.parseWindow(window),
      this.optionalInteger(from, 'from'),
      this.optionalInteger(to, 'to'),
    );
  }

  private parseWindow(window?: string): MetricWindowName {
    const value = window ?? '60s';
    if (value === '10s' || value === '60s' || value === '5m' || value === '1h') {
      return value;
    }
    throw new BadRequestException('window must be one of: 10s, 60s, 5m, 1h');
  }

  private optionalInteger(raw: string | undefined, label: string): number | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`${label} must be an integer`);
    }
    return parsed;
  }
}
