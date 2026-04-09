"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBlocksPage = fetchBlocksPage;
exports.fetchBlockByHeight = fetchBlockByHeight;
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001';
const nodeBase = process.env.NEXT_PUBLIC_NODE_SOURCE_URL ?? 'http://127.0.0.1:8081';
async function fetchBlocksPage(cursor, limit = 20) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
        query.set('cursor', cursor);
    }
    try {
        const response = await fetch(`${apiBase}/blocks?${query.toString()}`, {
            cache: 'no-store',
        });
        if (response.ok) {
            const payload = (await response.json());
            return { ok: true, payload };
        }
        const fallback = await fetchBlocksPageFromNode(cursor, limit);
        if (fallback.ok) {
            return fallback;
        }
        return {
            ok: false,
            message: `Backend returned ${response.status} for /blocks pagination endpoint, and localnet fallback also failed.`,
        };
    }
    catch {
        return fetchBlocksPageFromNode(cursor, limit);
    }
}
async function fetchBlockByHeight(height) {
    try {
        const response = await fetch(`${apiBase}/blocks/${height}`, {
            cache: 'no-store',
        });
        if (response.ok) {
            return (await response.json());
        }
    }
    catch {
        // fallback to direct node lookup below
    }
    const nodeBlock = await fetchNodeBlock(height);
    if (!nodeBlock) {
        return null;
    }
    return {
        source: `${nodeBase.replace(/\/$/, '')}/blocks/${height}`,
        data: nodeBlock,
    };
}
async function fetchBlocksPageFromNode(cursor, limit = 20) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
        query.set('cursor', cursor);
    }
    try {
        const response = await fetch(`${nodeBase.replace(/\/$/, '')}/blocks?${query.toString()}`, {
            cache: 'no-store',
        });
        if (response.ok) {
            const data = (await response.json());
            if (Array.isArray(data.items)) {
                return {
                    ok: true,
                    payload: {
                        source: `${nodeBase.replace(/\/$/, '')}/blocks`,
                        data,
                    },
                };
            }
        }
    }
    catch {
        // continue to compatibility fallback for older runtimes
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        return {
            ok: false,
            message: 'Invalid blocks pagination limit. Expected 1..100.',
        };
    }
    const requestedCursor = parseCursor(cursor);
    if (requestedCursor === null && cursor) {
        return {
            ok: false,
            message: 'Invalid blocks pagination cursor. Expected a non-negative integer block height.',
        };
    }
    const latestHeight = await findLatestNodeHeight();
    if (latestHeight < 0) {
        return {
            ok: true,
            payload: {
                source: `${nodeBase.replace(/\/$/, '')}/blocks/:height`,
                data: {
                    items: [],
                    next_cursor: null,
                    has_more: false,
                },
            },
        };
    }
    const startHeight = requestedCursor === null ? latestHeight : Math.min(requestedCursor, latestHeight);
    if (startHeight < 0) {
        return {
            ok: true,
            payload: {
                source: `${nodeBase.replace(/\/$/, '')}/blocks/:height`,
                data: {
                    items: [],
                    next_cursor: null,
                    has_more: false,
                },
            },
        };
    }
    const items = [];
    let nextHeight = startHeight;
    while (nextHeight >= 0 && items.length < limit) {
        const lookup = await fetchNodeBlock(nextHeight);
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
        ok: true,
        payload: {
            source: `${nodeBase.replace(/\/$/, '')}/blocks/:height`,
            data: {
                items,
                next_cursor: hasMore ? String(nextHeight) : null,
                has_more: hasMore,
            },
        },
    };
}
function parseCursor(cursor) {
    if (!cursor) {
        return null;
    }
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return null;
    }
    return parsed;
}
async function findLatestNodeHeight() {
    const zero = await fetchNodeBlock(0);
    const one = await fetchNodeBlock(1);
    if (!zero?.block && !one?.block) {
        return -1;
    }
    let lowerBound = one?.block ? 1 : 0;
    let upperBound = lowerBound;
    while (true) {
        const candidate = Math.max(upperBound * 2, upperBound + 1);
        const block = await fetchNodeBlock(candidate);
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
        const block = await fetchNodeBlock(mid);
        if (block?.block) {
            left = mid;
        }
        else {
            right = mid;
        }
    }
    return left;
}
async function fetchNodeBlock(height) {
    try {
        const response = await fetch(`${nodeBase.replace(/\/$/, '')}/blocks/${height}`, {
            cache: 'no-store',
        });
        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            return null;
        }
        return (await response.json());
    }
    catch {
        return null;
    }
}
