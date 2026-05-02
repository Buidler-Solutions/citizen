import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeBridge = readFileSync(new URL('./src/lib/runtimeBridge.ts', import.meta.url), 'utf8');
const headlessContract = readFileSync(new URL('./src/lib/headlessContract.test.ts', import.meta.url), 'utf8');

const commands = ['backup_init', 'backup_add_slot', 'backup_export_credentials', 'backup_verify', 'backup_restore'];

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

console.log('runtime-parity-check: wb-mode and tauri bridge command coverage validated');
