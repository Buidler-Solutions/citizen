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
let AppController = class AppController {
    constructor(citizenService) {
        this.citizenService = citizenService;
    }
    health() {
        return { status: 'ok' };
    }
    async status() {
        return this.citizenService.getStatus();
    }
    async block(height) {
        return this.citizenService.getBlock(Number(height));
    }
    async entries(namespace) {
        return this.citizenService.getEntries(namespace);
    }
    async receipt(receiptId) {
        return this.citizenService.getReceipt(receiptId);
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
    (0, common_1.Get)('receipts/:receiptId'),
    __param(0, (0, common_1.Param)('receiptId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "receipt", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [citizen_service_1.CitizenService])
], AppController);
