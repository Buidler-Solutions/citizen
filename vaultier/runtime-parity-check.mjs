import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeBridge = readFileSync(new URL('./src/lib/runtimeBridge.ts', import.meta.url), 'utf8');
const headlessContract = readFileSync(new URL('./src/lib/headlessContract.test.ts', import.meta.url), 'utf8');

const mockVaultCore = readFileSync(new URL('./src/lib/mockVaultCore.ts', import.meta.url), 'utf8');
const resultShapeFixture = JSON.parse(
  readFileSync(new URL('./fixtures/command-result-shape.v1.json', import.meta.url), 'utf8'),
);

const commands = ['backup_init', 'backup_add_slot', 'backup_export_credentials', 'backup_verify', 'backup_restore'];

assert.equal(resultShapeFixture.schemaVersion, 'v1alpha1', 'result-shape fixture schema version drifted');
assert.equal(resultShapeFixture.contractVersion, '2026-05-01', 'result-shape fixture contract version drifted');

for (const [command, expectedKeys] of Object.entries(resultShapeFixture.commands)) {
  const snapshotLiteral = `['${expectedKeys.join("', '")}']`;
  assert.match(headlessContract, new RegExp(`command: '${command}'`), `WB-mode fixture missing command ${command}`);
  assert.ok(
    headlessContract.includes(snapshotLiteral),
    `WB-mode result shape snapshot missing expected keys for ${command}`,
  );
}

for (const command of commands) {
  assert.match(runtimeBridge, new RegExp(`${command}: \\(`), `runtimeBridge tauri API missing ${command}`);
  assert.match(headlessContract, new RegExp(`command: '${command}'`), `WB-mode contract fixture missing ${command}`);
}

assert.match(
  runtimeBridge,
  /invokeTauri<HeadlessResponse>\(commandName, payload\)/,
  'runtime bridge must preserve CLI command-name passthrough parity',
);

assert.match(runtimeBridge, /sanitizePayload\(payload\)/, 'runtime bridge must sanitize payload before logging failures');


assert.match(
  runtimeBridge,
  /tauri_response_redaction_blocked/,
  'runtime bridge must reject secret-like response payload fields deterministically',
);

assert.match(
  mockVaultCore,
  /Response contained redaction-blocked fields:/,
  'WB-mode simulator must reject secret-like response payload fields deterministically',
);

console.log('runtime-parity-check: wb-mode snapshots, tauri bridge coverage, and redaction parity validated');
