import { sanitizeTauriPayloadForLogs } from './runtimeBridge';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const sanitized = sanitizeTauriPayloadForLogs({
    role: 'critical',
    passphrase: 'top-secret',
    nested: {
      backupPassword: 'abc',
      mnemonic_phrase: 'seed words',
      notes: 'safe',
    },
  }) as Record<string, unknown>;

  assert(sanitized.passphrase === '[REDACTED]', 'top-level secret field should be redacted');
  const nested = sanitized.nested as Record<string, unknown>;
  assert(nested.backupPassword === '[REDACTED]', 'nested password field should be redacted');
  assert(nested.mnemonic_phrase === '[REDACTED]', 'mnemonic field should be redacted');
  assert(nested.notes === 'safe', 'non-secret field should not be modified');
}

main();
