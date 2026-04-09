import test from 'node:test';
import assert from 'node:assert/strict';
import { shortHash, toReadableDate } from './app/lib/format';

test('toReadableDate returns N/A when timestamp is missing', () => {
  assert.equal(toReadableDate(undefined), 'N/A');
  assert.equal(toReadableDate(0), 'N/A');
});

test('toReadableDate returns stable UTC-readable string', () => {
  assert.equal(
    toReadableDate(1710000000),
    'Mar 09, 2024, 16:00:00 UTC',
  );
});

test('shortHash returns N/A when hash is missing', () => {
  assert.equal(shortHash(undefined), 'N/A');
});

test('shortHash returns full value when hash length is already compact', () => {
  const value = 'abc123';
  assert.equal(shortHash(value), value);
});

test('shortHash returns leading and trailing segments for long hashes', () => {
  const hash = '0123456789abcdef0123456789abcdef';
  assert.equal(shortHash(hash, 6), '012345...abcdef');
});
