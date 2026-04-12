"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppController = void 0;
const common_1 = require("@nestjs/common");
const citizen_service_1 = require("./citizen.service");
const indexer_metrics_service_1 = require("./indexer/indexer-metrics.service");
const metrics_access_service_1 = require("./indexer/metrics-access.service");
let AppController = class AppController {
    constructor(citizenService, indexerMetricsService, indexerMetricsAccessService) {
        this.citizenService = citizenService;
        this.indexerMetricsService = indexerMetricsService;
        this.indexerMetricsAccessService = indexerMetricsAccessService;
    }
    health() {
        return { status: 'ok' };
    }
    async status() {
        return this.citizenService.getStatus();
    }
    async blocks(cursor, limit) {
        return this.citizenService.getBlocks(cursor, limit);
    }
    async block(height) {
        return this.citizenService.getBlock(Number(height));
    }
    async entries(namespace) {
        return this.citizenService.getEntries(namespace);
    }
    async entriesByWalletSigner(namespace, signerDid) {
        return this.citizenService.getEntriesByWalletSigner(namespace, decodeURIComponent(signerDid));
    }
    async receipt(receiptId) {
        return this.citizenService.getReceipt(receiptId);
    }
    async fileManifest(manifestId) {
        return this.citizenService.getFileManifest(manifestId);
    }
    async fileTimeline(manifestId) {
        return this.citizenService.getFileTimeline(manifestId);
    }
    async payloadFieldRefs(entryId, namespace) {
        return this.citizenService.getPayloadFieldRefs(entryId, namespace);
    }
    async payloadDataHash(dataHash) {
        return this.citizenService.getPayloadDataHash(decodeURIComponent(dataHash));
    }
    async payloadDataHashByQuery(dataHash) {
        if (!dataHash || !dataHash.trim()) {
            throw new common_1.BadRequestException('missing required query parameter: q');
        }
        return this.citizenService.getPayloadDataHash(dataHash.trim());
    }
    async metricsSummary(headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.getSummary();
    }
    async metricsAlerts(headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.getAlerts();
    }
    async metricsBlocks(fromHeight, toHeight, cursor, limit, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.queryBlockMetrics(this.optionalInteger(fromHeight, 'from_height'), this.optionalInteger(toHeight, 'to_height'), cursor, this.optionalInteger(limit, 'limit'));
    }
    async metricsEntries(namespace, entryIds, from, to, cursor, limit, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.queryEntryMetrics(namespace, this.optionalCsv(entryIds), this.optionalInteger(from, 'from'), this.optionalInteger(to, 'to'), cursor, this.optionalInteger(limit, 'limit'));
    }
    async metricsTps(window, from, to, cursor, limit, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.queryTps(this.parseWindow(window), this.optionalInteger(from, 'from'), this.optionalInteger(to, 'to'), cursor, this.optionalInteger(limit, 'limit'));
    }
    async metricsBackfill(body, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.backfill(body?.from_height ?? 0, body?.to_height);
    }
    async metricsVerifySamples(sampleCount, seed, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.verifySampledHeights(this.optionalInteger(sampleCount, 'sample_count') ?? 10, this.optionalInteger(seed, 'seed') ?? 1337);
    }
    async metricsVerifyTps(window, from, to, headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.crossCheckTps(this.parseWindow(window), this.optionalInteger(from, 'from'), this.optionalInteger(to, 'to'));
    }
    async metricsVerifyEvidence(headers, req) {
        this.indexerMetricsAccessService.enforce(headers ?? {}, req?.ip);
        return this.indexerMetricsService.buildEvidenceBundle();
    }
    parseWindow(window) {
        const value = window ?? '60s';
        if (value === '10s' || value === '60s' || value === '5m' || value === '1h') {
            return value;
        }
        throw new common_1.BadRequestException('window must be one of: 10s, 60s, 5m, 1h');
    }
    optionalInteger(raw, label) {
        if (raw === undefined) {
            return undefined;
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
            throw new common_1.BadRequestException(`${label} must be an integer`);
        }
        return parsed;
    }
    optionalCsv(raw) {
        if (raw === undefined) {
            return undefined;
        }
        const values = raw
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        return values.length > 0 ? values : undefined;
    }
};
exports.AppController = AppController;
__decorate([
    (0, common_1.Get)('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "health", null);
__decorate([
    (0, common_1.Get)('status'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AppController.prototype, "status", null);
__decorate([
    (0, common_1.Get)('blocks'),
    __param(0, (0, common_1.Query)('cursor')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "blocks", null);
__decorate([
    (0, common_1.Get)('blocks/:height'),
    __param(0, (0, common_1.Param)('height')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "block", null);
__decorate([
    (0, common_1.Get)('entries/:namespace'),
    __param(0, (0, common_1.Param)('namespace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "entries", null);
__decorate([
    (0, common_1.Get)('entries/:namespace/wallet-signers/:signerDid'),
    __param(0, (0, common_1.Param)('namespace')),
    __param(1, (0, common_1.Param)('signerDid')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "entriesByWalletSigner", null);
__decorate([
    (0, common_1.Get)('receipts/:receiptId'),
    __param(0, (0, common_1.Param)('receiptId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "receipt", null);
__decorate([
    (0, common_1.Get)('files/manifests/:manifestId'),
    __param(0, (0, common_1.Param)('manifestId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "fileManifest", null);
__decorate([
    (0, common_1.Get)('files/timeline/:manifestId'),
    __param(0, (0, common_1.Param)('manifestId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "fileTimeline", null);
__decorate([
    (0, common_1.Get)('payloads/fields/:entryId/:namespace'),
    __param(0, (0, common_1.Param)('entryId')),
    __param(1, (0, common_1.Param)('namespace')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "payloadFieldRefs", null);
__decorate([
    (0, common_1.Get)('payloads/data-hash/:dataHash'),
    __param(0, (0, common_1.Param)('dataHash')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "payloadDataHash", null);
__decorate([
    (0, common_1.Get)('data-hash'),
    __param(0, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "payloadDataHashByQuery", null);
__decorate([
    (0, common_1.Get)('metrics/summary'),
    __param(0, (0, common_1.Headers)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsSummary", null);
__decorate([
    (0, common_1.Get)('metrics/alerts'),
    __param(0, (0, common_1.Headers)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsAlerts", null);
__decorate([
    (0, common_1.Get)('metrics/blocks'),
    __param(0, (0, common_1.Query)('from_height')),
    __param(1, (0, common_1.Query)('to_height')),
    __param(2, (0, common_1.Query)('cursor')),
    __param(3, (0, common_1.Query)('limit')),
    __param(4, (0, common_1.Headers)()),
    __param(5, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsBlocks", null);
__decorate([
    (0, common_1.Get)('metrics/entries'),
    __param(0, (0, common_1.Query)('namespace')),
    __param(1, (0, common_1.Query)('entry_ids')),
    __param(2, (0, common_1.Query)('from')),
    __param(3, (0, common_1.Query)('to')),
    __param(4, (0, common_1.Query)('cursor')),
    __param(5, (0, common_1.Query)('limit')),
    __param(6, (0, common_1.Headers)()),
    __param(7, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsEntries", null);
__decorate([
    (0, common_1.Get)('metrics/tps'),
    __param(0, (0, common_1.Query)('window')),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __param(3, (0, common_1.Query)('cursor')),
    __param(4, (0, common_1.Query)('limit')),
    __param(5, (0, common_1.Headers)()),
    __param(6, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsTps", null);
__decorate([
    (0, common_1.Post)('metrics/backfill'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Headers)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsBackfill", null);
__decorate([
    (0, common_1.Get)('metrics/verify/samples'),
    __param(0, (0, common_1.Query)('sample_count')),
    __param(1, (0, common_1.Query)('seed')),
    __param(2, (0, common_1.Headers)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsVerifySamples", null);
__decorate([
    (0, common_1.Get)('metrics/verify/tps'),
    __param(0, (0, common_1.Query)('window')),
    __param(1, (0, common_1.Query)('from')),
    __param(2, (0, common_1.Query)('to')),
    __param(3, (0, common_1.Headers)()),
    __param(4, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsVerifyTps", null);
__decorate([
    (0, common_1.Get)('metrics/verify/evidence'),
    __param(0, (0, common_1.Headers)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "metricsVerifyEvidence", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [citizen_service_1.CitizenService,
        indexer_metrics_service_1.IndexerMetricsService,
        metrics_access_service_1.IndexerMetricsAccessService])
], AppController);
