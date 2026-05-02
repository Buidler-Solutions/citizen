import type { RedactionScanResult } from './types';

const SECRET_FIELD_MARKERS = ['passphrase', 'password', 'secret', 'seed', 'privatekey', 'private_key', 'mnemonic'];
const SECRET_VALUE_MARKERS = ['passphrase=', 'password=', 'secret=', 'seed=', 'mnemonic=', 'private-key=', 'private_key='];

export function scanForSecretFields(payload: unknown): RedactionScanResult {
  const redactedFields: string[] = [];

  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (SECRET_VALUE_MARKERS.some((marker) => lowered.includes(marker))) {
        redactedFields.push(path || '$');
      }
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (SECRET_FIELD_MARKERS.some((marker) => lower.includes(marker))) {
        redactedFields.push(path ? `${path}.${key}` : key);
      }
      walk(nested, path ? `${path}.${key}` : key);
    }
  };

  walk(payload, '');
  return { ok: redactedFields.length === 0, redactedFields };
}

