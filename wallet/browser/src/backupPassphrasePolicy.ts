export type PassphraseStrength = 'weak' | 'moderate' | 'strong';

export const MIN_PASSPHRASE_LENGTH = 12;
export const RECOMMENDED_PASSPHRASE_LENGTH = 16;

export function normalizePassphrase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= MIN_PASSPHRASE_LENGTH ? trimmed : null;
}

export function evaluatePassphraseStrength(passphrase: string): PassphraseStrength {
  const score = [
    passphrase.length >= RECOMMENDED_PASSPHRASE_LENGTH,
    /[a-z]/.test(passphrase),
    /[A-Z]/.test(passphrase),
    /\d/.test(passphrase),
    /[^A-Za-z0-9]/.test(passphrase),
    /(.)\1{2,}/.test(passphrase) === false,
  ].filter(Boolean).length;

  if (score >= 5) return 'strong';
  if (score >= 3) return 'moderate';
  return 'weak';
}

export function validateDistinctPassphrases(decoy: unknown, critical: unknown): string | null {
  const normalizedDecoy = normalizePassphrase(decoy);
  const normalizedCritical = normalizePassphrase(critical);
  if (!normalizedDecoy || !normalizedCritical) {
    return `Both decoy and critical passphrases must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (normalizedDecoy === normalizedCritical) {
    return 'Decoy and critical passphrases must be different.';
  }
  return null;
}
