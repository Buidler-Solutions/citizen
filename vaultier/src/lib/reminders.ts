export type ReminderPolicy = {
  enabled: boolean;
  cadenceDays: number;
};

const STORAGE_KEY = 'vaultier.reminder_policy.v1';
const DEFAULT_POLICY: ReminderPolicy = { enabled: true, cadenceDays: 30 };

export function defaultReminderPolicy(): ReminderPolicy {
  return { ...DEFAULT_POLICY };
}

export function loadReminderSettings(): ReminderPolicy {
  if (typeof window === 'undefined' || !window.localStorage) {
    return defaultReminderPolicy();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function getNextReminderAt(lastVerifiedAt: string, policy: ReminderPolicy): string | null {
  if (!policy.enabled) return null;
  const base = new Date(lastVerifiedAt);
  if (Number.isNaN(base.valueOf())) return null;

  const next = new Date(base.getTime() + clampCadence(policy.cadenceDays) * 24 * 60 * 60 * 1000);
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
