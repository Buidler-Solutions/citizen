import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/lib/operationState.ts', import.meta.url), 'utf8');

for (const state of ['idle', 'preflight', 'writing', 'flushing', 'verified', 'verify_required', 'completed', 'action_required']) {
  assert.match(source, new RegExp(`${state}:\\s*\\{`), `operation state "${state}" copy missing`);
}

for (const errorCode of [
  'unsupported_schema',
  'slot_not_found',
  'decrypt_failed',
  'checksum_mismatch',
  'invalid_payload',
  'mount_unwritable',
  'insufficient_space',
  'path_invalid',
  'media_unavailable',
  'manifest_signature_missing',
  'manifest_signature_invalid',
  'header_auth_failed',
  'slot_table_tampered',
  'rollback_counter_mismatch',
  'filesystem_incompatible',
  'critical_entropy_too_low',
]) {
  assert.match(source, new RegExp(`${errorCode}:\\s*\\{`), `error copy for "${errorCode}" missing`);
}

assert.match(
  source,
  /Do not restore from this media; switch to a verified duplicate and preserve this drive for investigation\./,
  'critical tamper warning copy changed unexpectedly',
);
assert.match(
  source,
  /Sync in progress: keep media connected until flush and rename complete\./,
  'flush safety warning copy changed unexpectedly',
);

console.log('operation-copy-check: operation states and warning copy markers validated');
