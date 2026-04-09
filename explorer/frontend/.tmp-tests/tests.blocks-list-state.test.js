"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const blocks_list_state_1 = require("./app/lib/blocks-list-state");
function makeBlock(height) {
    return {
        height,
        entry_count: 1,
        header: {
            timestamp: 1710000000 + height,
            proposer: `proposer-${height}`,
            prev_hash: `prev-${height}`,
            entry_root: `root-${height}`,
            commit_proof: {
                aggregated_signature: `sig-${height}`,
            },
        },
    };
}
(0, node_test_1.default)('dedupeByHeight keeps first block for duplicate heights', () => {
    const first = makeBlock(12);
    const dupe = makeBlock(12);
    dupe.header.proposer = 'different';
    const deduped = (0, blocks_list_state_1.dedupeByHeight)([first, makeBlock(11), dupe, makeBlock(10)]);
    strict_1.default.deepEqual(deduped.map((item) => item.height), [12, 11, 10]);
    strict_1.default.equal(deduped[0].header.proposer, first.header.proposer);
});
(0, node_test_1.default)('mergePaginatedBlocks appends unseen blocks only once', () => {
    const merged = (0, blocks_list_state_1.mergePaginatedBlocks)([makeBlock(15), makeBlock(14), makeBlock(13)], [makeBlock(13), makeBlock(12), makeBlock(11), makeBlock(12)]);
    strict_1.default.deepEqual(merged.map((item) => item.height), [15, 14, 13, 12, 11]);
});
(0, node_test_1.default)('sortByHeightDesc returns blocks in descending height order', () => {
    const sorted = (0, blocks_list_state_1.sortByHeightDesc)([makeBlock(3), makeBlock(8), makeBlock(5)]);
    strict_1.default.deepEqual(sorted.map((item) => item.height), [8, 5, 3]);
});
