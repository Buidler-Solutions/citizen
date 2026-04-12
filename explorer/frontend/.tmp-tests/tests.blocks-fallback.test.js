"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const blocks_1 = require("./app/lib/blocks");
function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}
(0, node_test_1.default)('fetchBlocksPage fallback height-walk accepts /blocks/:height envelope shape', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/blocks?')) {
            throw new Error('simulate unavailable pagination endpoint');
        }
        const match = url.match(/\/blocks\/(\d+)$/);
        if (!match) {
            return jsonResponse({ message: 'not found' }, 404);
        }
        const height = Number(match[1]);
        if (height < 0 || height > 3) {
            return jsonResponse({ message: 'not found' }, 404);
        }
        return jsonResponse({
            data: {
                height,
                block: {
                    header: {
                        height,
                        prev_hash: `prev-${height}`,
                        entry_root: `root-${height}`,
                        proposer: `did:ledger:validator:${height}`,
                        timestamp: 1_710_000_000 + height,
                        commit_proof: { aggregated_signature: `sig-${height}` },
                    },
                    entries: [{ id: `entry-${height}` }],
                },
            },
        });
    });
    try {
        const result = await (0, blocks_1.fetchBlocksPage)(undefined, 4);
        strict_1.default.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        strict_1.default.deepEqual(result.payload.data.items.map((item) => item.height), [3, 2, 1, 0]);
        strict_1.default.equal(result.payload.data.has_more, false);
        strict_1.default.equal(result.payload.data.next_cursor, null);
        strict_1.default.ok(calls.some((entry) => entry.includes('/blocks?limit=4')));
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
(0, node_test_1.default)('fetchBlocksPage normalizes block-list items when runtime returns {height, block}', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
        const url = String(input);
        if (!url.includes('/blocks?')) {
            return jsonResponse({ message: 'unexpected route' }, 404);
        }
        return jsonResponse({
            data: {
                items: [3, 2, 1, 0].map((height) => ({
                    height,
                    block: {
                        header: {
                            height,
                            prev_hash: `prev-${height}`,
                            entry_root: `root-${height}`,
                            proposer: `did:ledger:validator:${height}`,
                            timestamp: 1_710_000_000 + height,
                            commit_proof: { aggregated_signature: `sig-${height}` },
                        },
                        entries: [{ id: `entry-${height}` }],
                    },
                })),
                next_cursor: null,
                has_more: false,
            },
        });
    });
    try {
        const result = await (0, blocks_1.fetchBlocksPage)(undefined, 4);
        strict_1.default.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        strict_1.default.deepEqual(result.payload.data.items.map((item) => item.height), [3, 2, 1, 0]);
        strict_1.default.equal(result.payload.data.items[0]?.entry_count, 1);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
