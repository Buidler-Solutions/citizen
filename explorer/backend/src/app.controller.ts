import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { CitizenService } from './citizen.service';
import { IndexerMetricsService } from './indexer/indexer-metrics.service';
import { MetricWindowName } from './indexer/metrics.types';
import { IndexerMetricsAccessService } from './indexer/metrics-access.service';

@Controller()
export class AppController {
  constructor(
    private readonly citizenService: CitizenService,
    private readonly indexerMetricsService: IndexerMetricsService,
    private readonly indexerMetricsAccessService: IndexerMetricsAccessService,
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

  @Get('entries/lookup/:entryId')
  async entryLookup(@Param('entryId') entryId: string) {
    return this.citizenService.lookupEntryBlock(entryId);
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
  async metricsSummary(
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.getSummary();
  }

  @Get('metrics/alerts')
  async metricsAlerts(
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.getAlerts();
  }

  @Get('metrics/blocks')
  async metricsBlocks(
    @Query('from_height') fromHeight?: string,
    @Query('to_height') toHeight?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.queryBlockMetrics(
      this.optionalInteger(fromHeight, 'from_height'),
      this.optionalInteger(toHeight, 'to_height'),
      cursor,
      this.optionalInteger(limit, 'limit'),
    );
  }

  @Get('metrics/entries')
  async metricsEntries(
    @Query('namespace') namespace?: string,
    @Query('entry_ids') entryIds?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.queryEntryMetrics(
      namespace,
      this.optionalCsv(entryIds),
      this.optionalInteger(from, 'from'),
      this.optionalInteger(to, 'to'),
      cursor,
      this.optionalInteger(limit, 'limit'),
    );
  }

  @Get('metrics/tps')
  async metricsTps(
    @Query('window') window?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.queryTps(
      this.parseWindow(window),
      this.optionalInteger(from, 'from'),
      this.optionalInteger(to, 'to'),
      cursor,
      this.optionalInteger(limit, 'limit'),
    );
  }

  @Post('metrics/backfill')
  async metricsBackfill(
    @Body() body?: { from_height?: number; to_height?: number },
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.backfill(
      body?.from_height ?? 0,
      body?.to_height,
    );
  }

  @Get('metrics/verify/samples')
  async metricsVerifySamples(
    @Query('sample_count') sampleCount?: string,
    @Query('seed') seed?: string,
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.verifySampledHeights(
      this.optionalInteger(sampleCount, 'sample_count') ?? 10,
      this.optionalInteger(seed, 'seed') ?? 1337,
    );
  }

  @Get('metrics/verify/tps')
  async metricsVerifyTps(
    @Query('window') window?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.crossCheckTps(
      this.parseWindow(window),
      this.optionalInteger(from, 'from'),
      this.optionalInteger(to, 'to'),
    );
  }

  @Get('metrics/verify/evidence')
  async metricsVerifyEvidence(
    @Headers() headers?: Record<string, string | string[] | undefined>,
    @Req() req?: { ip?: string },
  ) {
    this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
    return this.indexerMetricsService.buildEvidenceBundle();
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

  private optionalCsv(raw: string | undefined): string[] | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return values.length > 0 ? values : undefined;
  }
}
