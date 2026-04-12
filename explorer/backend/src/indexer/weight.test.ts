import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, computeCanonicalWeight, roundHalfAwayFromZero } from './weight';

test('canonicalJson sorts object keys recursively', () => {
  const payload = {
    z: 1,
    a: {
      b: 2,
      a: 1,
    },
    m: [
      { y: 2, x: 1 },
      'ok',
    ],
  };

  assert.equal(
    canonicalJson(payload),
    '{"a":{"a":1,"b":2},"m":[{"x":1,"y":2},"ok"],"z":1}',
  );
});

test('computeCanonicalWeight returns deterministic utf8 byte length', () => {
  const left = { b: 'hello', a: 1 };
  const right = { a: 1, b: 'hello' };

  assert.equal(computeCanonicalWeight(left), computeCanonicalWeight(right));
  assert.equal(computeCanonicalWeight(left), Buffer.byteLength('{"a":1,"b":"hello"}', 'utf8'));
});

test('roundHalfAwayFromZero rounds positive and negative half values away from zero', () => {
  assert.equal(roundHalfAwayFromZero(0.0165, 3), 0.017);
  assert.equal(roundHalfAwayFromZero(-0.0165, 3), -0.017);
  assert.equal(roundHalfAwayFromZero(12.344, 2), 12.34);
  assert.equal(roundHalfAwayFromZero(12.345, 2), 12.35);
});
