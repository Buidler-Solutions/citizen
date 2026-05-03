import { describe, expect, it } from 'vitest';
import {
  evaluatePassphraseStrength,
  normalizePassphrase,
  validateDistinctPassphrases,
} from './backupPassphrasePolicy';

describe('backup passphrase policy', () => {
  it('rejects short passphrases and trims valid values', () => {
    expect(normalizePassphrase('short')).toBeNull();
    expect(normalizePassphrase('   long enough value   ')).toBe('long enough value');
  });

  it('validates decoy and critical distinct requirements', () => {
    expect(validateDistinctPassphrases('samepassphrase1!', 'samepassphrase1!')).toContain('must be different');
    expect(validateDistinctPassphrases('validdecoypass1!', 'validcriticalpass2!')).toBeNull();
  });

  it('scores passphrase strength deterministically', () => {
    expect(evaluatePassphraseStrength('aaaaaaaaaaaa')).toBe('weak');
    expect(evaluatePassphraseStrength('ModeratePass12')).toBe('moderate');
    expect(evaluatePassphraseStrength('StrongPassphrase#2026')).toBe('strong');
  });
});
