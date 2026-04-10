import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBlocksPage } from './app/lib/blocks';

type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResponse(payload: unknown, status = 200): MockFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('fetchBlocksPage fallback height-walk accepts /blocks/:height envelope shape', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('/blocks?')) {
      throw new Error('simulate unavailable pagination endpoint');
    }

    const match = url.match(/\/blocks\/(\d+)$/);
    if (!match) {
      return jsonResponse({ message: 'not found' }, 404) as unknown as Response;
    }
    const height = Number(match[1]);
    if (height < 0 || height > 3) {
      return jsonResponse({ message: 'not found' }, 404) as unknown as Response;
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
    }) as unknown as Response;
  }) as typeof fetch;

  try {
    const result = await fetchBlocksPage(undefined, 4);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.payload.data.items.map((item) => item.height),
      [3, 2, 1, 0],
    );
    assert.equal(result.payload.data.has_more, false);
    assert.equal(result.payload.data.next_cursor, null);
    assert.ok(calls.some((entry) => entry.includes('/blocks?limit=4')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBlocksPage normalizes block-list items when runtime returns {height, block}', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/blocks?')) {
      return jsonResponse({ message: 'unexpected route' }, 404) as unknown as Response;
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
    }) as unknown as Response;
  }) as typeof fetch;

  try {
    const result = await fetchBlocksPage(undefined, 4);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.payload.data.items.map((item) => item.height), [3, 2, 1, 0]);
    assert.equal(result.payload.data.items[0]?.entry_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
