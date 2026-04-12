import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, computeCanonicalWeight, deriveLocalIndexerMetrics } from './app/lib/local-indexer';

test('canonicalJson sorts object keys deterministically', () => {
  const value = { b: 1, a: { z: true, y: false } };
  assert.equal(canonicalJson(value), '{"a":{"y":false,"z":true},"b":1}');
});

test('computeCanonicalWeight returns UTF-8 byte length', () => {
  const value = { msg: 'hello' };
  assert.equal(computeCanonicalWeight(value), Buffer.byteLength('{"msg":"hello"}', 'utf8'));
});

test('deriveLocalIndexerMetrics computes block, entry, and 60s TPS windows', () => {
  const metrics = deriveLocalIndexerMetrics(
    [
      {
        header: { height: 2, timestamp: 120 },
        entries: [
          {
            entry_id: 'e2',
            namespace: 'ns',
            action: 'WRITE',
            timestamp: 125,
            author: 'did:citizen:2',
          },
        ],
      },
      {
        header: { height: 1, timestamp: 60 },
        entries: [
          {
            entry_id: 'e1a',
            namespace: 'ns',
            action: 'WRITE',
            timestamp: 61,
            author: 'did:citizen:1',
          },
          {
            entry_id: 'e1b',
            namespace: 'ns',
            action: 'WRITE',
            timestamp: 62,
            author: 'did:citizen:1',
          },
        ],
      },
    ],
    60,
  );

  assert.equal(metrics.indexedBlocks.length, 2);
  assert.equal(metrics.indexedEntries.length, 3);
  assert.deepEqual(
    metrics.tpsSeries.map((item) => ({ start: item.windowStart, count: item.entriesCommitted, tps: item.tps })),
    [
      { start: 60, count: 2, tps: 0.033 },
      { start: 120, count: 1, tps: 0.017 },
    ],
  );
});
