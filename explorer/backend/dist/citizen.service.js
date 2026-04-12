"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CitizenService = void 0;
const common_1 = require("@nestjs/common");
let CitizenService = class CitizenService {
    constructor() {
        this.baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://127.0.0.1:8081';
    }
    async getStatus() {
        return {
            node: this.baseUrl,
            timestamp: Date.now(),
        };
    }
    async getBlocks(cursor, limitRaw) {
        const limit = this.parseLimit(limitRaw);
        const requestedStartHeight = this.parseCursor(cursor);
        const latestHeight = await this.findLatestHeight();
        if (latestHeight < 0) {
            return {
                source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
                data: {
                    items: [],
                    next_cursor: null,
                    has_more: false,
                },
            };
        }
        const startHeight = requestedStartHeight === null ? latestHeight : Math.min(requestedStartHeight, latestHeight);
        if (startHeight < 0) {
            return {
                source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
                data: {
                    items: [],
                    next_cursor: null,
                    has_more: false,
                },
            };
        }
        const items = [];
        let nextHeight = startHeight;
        while (nextHeight >= 0 && items.length < limit) {
            const lookup = await this.fetchBlockOrNull(nextHeight);
            if (lookup?.block) {
                items.push({
                    height: lookup.height,
                    header: lookup.block.header,
                    entry_count: lookup.block.entries.length,
                });
            }
            nextHeight -= 1;
        }
        const hasMore = nextHeight >= 0;
        return {
            source: `${this.baseUrl.replace(/\/$/, '')}/blocks/:height`,
            data: {
                items,
                next_cursor: hasMore ? String(nextHeight) : null,
                has_more: hasMore,
            },
        };
    }
    async getBlock(height) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks/${height}`;
        return this.fetchJson(endpoint);
    }
    async getEntries(namespace) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/entries/${namespace}`;
        return this.fetchJson(endpoint);
    }
    async getEntriesByWalletSigner(namespace, signerDid) {
        const entries = await this.getEntries(namespace);
        const normalizedSigner = signerDid.trim().toLowerCase();
        const filteredEntries = entries.data.entries.filter((entry) => {
            const payloadWalletSignature = entry.payload.payload_wallet_signature;
            const legacyWalletSignature = entry.payload.wallet_signature;
            const signerCandidate = payloadWalletSignature && typeof payloadWalletSignature === 'object'
                ? payloadWalletSignature.signer
                : legacyWalletSignature && typeof legacyWalletSignature === 'object'
                    ? legacyWalletSignature.signer
                    : null;
            if (typeof signerCandidate !== 'string') {
                return false;
            }
            return signerCandidate.trim().toLowerCase() === normalizedSigner;
        });
        return {
            source: entries.source,
            data: {
                namespace,
                wallet_signer: signerDid,
                total_entries: entries.data.entries.length,
                matched_entries: filteredEntries.length,
                entries: filteredEntries,
            },
        };
    }
    async getReceipt(receiptId) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/receipts/${receiptId}`;
        return this.fetchJson(endpoint);
    }
    async getPayloadFieldRefs(entryId, namespace) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/payloads/fields/${encodeURIComponent(entryId)}/${encodeURIComponent(namespace)}`;
        return this.fetchJson(endpoint);
    }
    async getPayloadDataHash(dataHash) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/payloads/data-hash/${encodeURIComponent(dataHash)}`;
        return this.fetchJson(endpoint);
    }
    async getFileManifest(manifestId) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/files/manifests/${manifestId}`;
        return this.fetchJson(endpoint);
    }
    async getFileTimeline(manifestId) {
        const manifest = await this.getFileManifest(manifestId);
        const [namespaceEntries, consentEntries] = await Promise.all([
            this.getEntries(manifest.data.namespace),
            manifest.data.consent_receipt_ref
                ? this.getEntries('consent.receipt')
                : Promise.resolve(null),
        ]);
        const namespaceEvents = namespaceEntries.data.entries
            .filter((entry) => {
            const payloadManifestId = typeof entry.payload.manifest_id === 'string'
                ? entry.payload.manifest_id
                : null;
            return (entry.object_id === manifest.data.object_id ||
                payloadManifestId === manifest.data.manifest_id);
        })
            .map((entry) => ({
            timestamp: entry.timestamp,
            event_type: entry.action,
            detail: `namespace=${entry.namespace} author=${entry.author}`,
        }));
        const consentEvents = (consentEntries?.data.entries ?? [])
            .filter((entry) => {
            const payload = entry.payload;
            const receiptId = typeof payload.receipt_id === 'string' ? payload.receipt_id : null;
            return receiptId === manifest.data.consent_receipt_ref;
        })
            .map((entry) => ({
            timestamp: entry.timestamp,
            event_type: 'CONSENT_RECEIPT_EVENT',
            detail: `action=${entry.action} receipt=${manifest.data.consent_receipt_ref}`,
        }));
        const derivedStateEvent = {
            timestamp: manifest.data.committed_at,
            event_type: 'CONSENT_STATE',
            detail: `${manifest.data.consent_state}${manifest.data.consent_state_reason
                ? ` (${manifest.data.consent_state_reason})`
                : ''}`,
        };
        const events = [...namespaceEvents, ...consentEvents, derivedStateEvent].sort((a, b) => a.timestamp - b.timestamp);
        return {
            source: `${manifest.source} + ${namespaceEntries.source}`,
            data: {
                manifest: manifest.data,
                events,
            },
        };
    }
    parseLimit(limitRaw) {
        if (limitRaw === undefined) {
            return 20;
        }
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
            throw new common_1.BadRequestException('limit must be an integer between 1 and 100');
        }
        return parsed;
    }
    parseCursor(cursor) {
        if (!cursor) {
            return null;
        }
        const parsed = Number(cursor);
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new common_1.BadRequestException('cursor must be a non-negative integer block height');
        }
        return parsed;
    }
    async findLatestHeight() {
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
            }
            else {
                right = mid;
            }
        }
        return left;
    }
    async fetchBlockOrNull(height) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/blocks/${height}`;
        const response = await fetch(endpoint);
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
        }
        return (await response.json());
    }
    async fetchJson(endpoint) {
        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error(`Citizen node responded with ${response.status} for ${endpoint}`);
        }
        const data = (await response.json());
        return { source: endpoint, data };
    }
};
exports.CitizenService = CitizenService;
exports.CitizenService = CitizenService = __decorate([
    (0, common_1.Injectable)()
], CitizenService);
