function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clampCadence(value) {
  return Math.max(7, Math.min(365, Math.round(value)));
}

function getNextReminderAt(lastVerifiedAt, policy) {
  if (!policy.enabled) return null;
  const base = new Date(lastVerifiedAt);
  if (Number.isNaN(base.valueOf())) return null;

  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + clampCadence(policy.cadenceDays));
  return next.toISOString();
}

function isReminderDue(nextReminderAt) {
  const at = new Date(nextReminderAt);
  if (Number.isNaN(at.valueOf())) return false;
  return Date.now() >= at.getTime();
}

function run() {
  const policy = { enabled: true, cadenceDays: 30 };

  const jan = getNextReminderAt('2026-01-15T12:00:00.000Z', policy);
  assert(jan === '2026-02-14T12:00:00.000Z', `expected 30-day UTC cadence; got ${jan}`);

  const leapCross = getNextReminderAt('2024-02-29T00:00:00.000Z', { enabled: true, cadenceDays: 365 });
  assert(leapCross === '2025-02-28T00:00:00.000Z', `expected leap-year rollover; got ${leapCross}`);

  const offsetInput = getNextReminderAt('2026-03-08T01:30:00-08:00', { enabled: true, cadenceDays: 7 });
  assert(offsetInput === '2026-03-15T09:30:00.000Z', `expected timezone-safe UTC output; got ${offsetInput}`);

  const disabled = getNextReminderAt('2026-01-01T00:00:00.000Z', { enabled: false, cadenceDays: 30 });
  assert(disabled === null, `expected null for disabled policy; got ${disabled}`);

  const duePast = isReminderDue('2000-01-01T00:00:00.000Z');
  const dueFuture = isReminderDue('2999-01-01T00:00:00.000Z');
  assert(duePast === true, 'expected past reminder to be due');
  assert(dueFuture === false, 'expected future reminder to be not due');

  console.log('reminder-policy-check: UTC cadence + due-state checks passed');
}

run();
