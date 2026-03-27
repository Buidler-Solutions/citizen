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
        this.baseUrl = process.env.CITIZEN_NODE_URL ?? 'http://localhost:8080';
    }
    async getStatus() {
        return {
            node: this.baseUrl,
            timestamp: Date.now(),
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
    async getReceipt(receiptId) {
        const endpoint = `${this.baseUrl.replace(/\/$/, '')}/api/v1/receipts/${receiptId}`;
        return this.fetchJson(endpoint);
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
