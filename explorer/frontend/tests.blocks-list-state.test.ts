import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlockSummary } from './app/lib/blocks';
import {
  dedupeByHeight,
  mergePaginatedBlocks,
  sortByHeightDesc,
} from './app/lib/blocks-list-state';

function makeBlock(height: number): BlockSummary {
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

test('dedupeByHeight keeps first block for duplicate heights', () => {
  const first = makeBlock(12);
  const dupe = makeBlock(12);
  dupe.header.proposer = 'different';

  const deduped = dedupeByHeight([first, makeBlock(11), dupe, makeBlock(10)]);

  assert.deepEqual(
    deduped.map((item) => item.height),
    [12, 11, 10],
  );
  assert.equal(deduped[0].header.proposer, first.header.proposer);
});

test('mergePaginatedBlocks appends unseen blocks only once', () => {
  const merged = mergePaginatedBlocks(
    [makeBlock(15), makeBlock(14), makeBlock(13)],
    [makeBlock(13), makeBlock(12), makeBlock(11), makeBlock(12)],
  );

  assert.deepEqual(
    merged.map((item) => item.height),
    [15, 14, 13, 12, 11],
  );
});

test('sortByHeightDesc returns blocks in descending height order', () => {
  const sorted = sortByHeightDesc([makeBlock(3), makeBlock(8), makeBlock(5)]);

  assert.deepEqual(
    sorted.map((item) => item.height),
    [8, 5, 3],
  );
});
