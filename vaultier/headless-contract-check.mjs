import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/lib/mockVaultCore.ts', import.meta.url), 'utf8');

assert.match(source, /contractVersion:\s*'2026-05-01'/, 'contractVersion must remain pinned');
assert.match(source, /schemaVersion:\s*'v1alpha1'/, 'schemaVersion must remain pinned');
assert.match(source, /command === 'backup_init'/, 'backup_init command branch missing');
assert.match(source, /command === 'backup_verify'/, 'backup_verify command branch missing');
assert.match(source, /restored_role/, 'backup_restore contract payload missing restored_role');
assert.match(source, /manifest_signature_missing/, 'deterministic manifest signature error missing');
assert.match(source, /scanForSecretFields/, 'headless response redaction scan missing');
assert.match(source, /invalid_payload/, 'deterministic invalid_payload code missing');

console.log('headless-contract-check: contract markers validated');
