import type { PortableProfile } from './types';

export type ReminderPolicy = {
  enabled: boolean;
  cadenceDays: number;
};

export type ReminderAuditEntry = {
  at: string;
  action: 'reminder_enabled' | 'reminder_disabled' | 'cadence_updated';
  detail: string;
};

const REMINDER_STORAGE_KEY = 'vaultier.reminder_policy.v1';
const REMINDER_AUDIT_STORAGE_KEY = 'vaultier.reminder_policy_audit.v1';
const PROFILE_STORAGE_KEY = 'vaultier.portable_profile.v1';
const DEFAULT_POLICY: ReminderPolicy = { enabled: true, cadenceDays: 30 };

export function defaultReminderPolicy(): ReminderPolicy {
  return { ...DEFAULT_POLICY };
}

export function loadReminderSettings(): ReminderPolicy {
  if (typeof window === 'undefined' || !window.localStorage) {
    return defaultReminderPolicy();
  }

  try {
    const raw = window.localStorage.getItem(REMINDER_STORAGE_KEY);
    if (!raw) return defaultReminderPolicy();

    const parsed = JSON.parse(raw) as Partial<ReminderPolicy>;
    const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_POLICY.enabled;
    const cadence = typeof parsed.cadenceDays === 'number' ? parsed.cadenceDays : DEFAULT_POLICY.cadenceDays;
    const cadenceDays = clampCadence(cadence);

    return { enabled, cadenceDays };
  } catch {
    return defaultReminderPolicy();
  }
}

export function saveReminderSettings(policy: ReminderPolicy): void {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const normalized: ReminderPolicy = {
    enabled: policy.enabled,
    cadenceDays: clampCadence(policy.cadenceDays),
  };

  window.localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(normalized));
}

export function loadReminderAudit(): ReminderAuditEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];

  try {
    const raw = window.localStorage.getItem(REMINDER_AUDIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ReminderAuditEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<ReminderAuditEntry>;
      return typeof candidate.at === 'string' && typeof candidate.action === 'string' && typeof candidate.detail === 'string';
    }).slice(0, 50);
  } catch {
    return [];
  }
}

export function appendReminderAudit(entry: ReminderAuditEntry): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const current = loadReminderAudit();
  const next = [entry, ...current].slice(0, 50);
  window.localStorage.setItem(REMINDER_AUDIT_STORAGE_KEY, JSON.stringify(next));
}

export function savePortableProfile(profile: PortableProfile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const normalized: PortableProfile = {
    portableLabel: profile.portableLabel,
    schemaVersion: profile.schemaVersion,
    createdAt: profile.createdAt,
    lastVerifiedAt: profile.lastVerifiedAt,
  };

  window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized));
}

export function loadPortableProfile(): PortableProfile | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PortableProfile>;

    if (typeof parsed.portableLabel !== 'string' || typeof parsed.schemaVersion !== 'string' || typeof parsed.createdAt !== 'string') {
      return null;
    }

    return {
      portableLabel: parsed.portableLabel,
      schemaVersion: parsed.schemaVersion,
      createdAt: parsed.createdAt,
      lastVerifiedAt: typeof parsed.lastVerifiedAt === 'string' ? parsed.lastVerifiedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function getNextReminderAt(lastVerifiedAt: string, policy: ReminderPolicy): string | null {
  if (!policy.enabled) return null;
  const base = new Date(lastVerifiedAt);
  if (Number.isNaN(base.valueOf())) return null;

  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + clampCadence(policy.cadenceDays));
  return next.toISOString();
}

export function isReminderDue(nextReminderAt: string): boolean {
  const at = new Date(nextReminderAt);
  if (Number.isNaN(at.valueOf())) return false;
  return Date.now() >= at.getTime();
}

function clampCadence(value: number): number {
  return Math.max(7, Math.min(365, Math.round(value)));
}
