"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const format_1 = require("./app/lib/format");
(0, node_test_1.default)('toReadableDate returns N/A when timestamp is missing', () => {
    strict_1.default.equal((0, format_1.toReadableDate)(undefined), 'N/A');
    strict_1.default.equal((0, format_1.toReadableDate)(0), 'N/A');
});
(0, node_test_1.default)('toReadableDate returns stable UTC-readable string', () => {
    strict_1.default.equal((0, format_1.toReadableDate)(1710000000), 'Mar 09, 2024, 16:00:00 UTC');
});
(0, node_test_1.default)('shortHash returns N/A when hash is missing', () => {
    strict_1.default.equal((0, format_1.shortHash)(undefined), 'N/A');
});
(0, node_test_1.default)('shortHash returns full value when hash length is already compact', () => {
    const value = 'abc123';
    strict_1.default.equal((0, format_1.shortHash)(value), value);
});
(0, node_test_1.default)('shortHash returns leading and trailing segments for long hashes', () => {
    const hash = '0123456789abcdef0123456789abcdef';
    strict_1.default.equal((0, format_1.shortHash)(hash, 6), '012345...abcdef');
});
