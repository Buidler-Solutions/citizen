import { runHeadlessCommand } from './mockVaultCore';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertKeys(obj: Record<string, unknown>, expected: string[], label: string): void {
  const got = Object.keys(obj).sort().join(',');
  const want = [...expected].sort().join(',');
  assert(got === want, `${label}: expected keys [${want}] but got [${got}]`);
}

async function main() {
  const init = await runHeadlessCommand({
    command: 'backup_init',
    targetPath: '/Volumes/CITIZEN_USB',
    roles: ['decoy', 'critical'],
    includeConsentReceipts: true,
    portableMode: true,
  });

  assert(init.schemaVersion === 'v1alpha1', 'backup_init schema version drifted');
  assert(init.contractVersion === '2026-05-01', 'backup_init contract version drifted');
  assert(init.command === 'backup_init', 'backup_init command mismatch');
  assert(init.ok === true, 'backup_init should succeed');
  assert(!!init.result, 'backup_init result missing');
  assertKeys(init.result as Record<string, unknown>, ['kdf_profile', 'log', 'profile'], 'backup_init');

  const addSlot = await runHeadlessCommand({
    command: 'backup_add_slot',
    targetPath: '/Volumes/CITIZEN_USB',
    role: 'critical',
  });
  assert(addSlot.ok === true, 'backup_add_slot should succeed');
  assert(!!addSlot.result, 'backup_add_slot result missing');
  assertKeys(addSlot.result as Record<string, unknown>, ['added_role', 'log', 'target_path'], 'backup_add_slot');

  const exportCredentials = await runHeadlessCommand({
    command: 'backup_export_credentials',
    targetPath: '/Volumes/CITIZEN_USB',
    role: 'critical',
    includeIdentityKeys: true,
    includeAccountKeys: true,
    includeConsentReceipts: false,
  });
  assert(exportCredentials.ok === true, 'backup_export_credentials should succeed');
  assert(!!exportCredentials.result, 'backup_export_credentials result missing');
  assertKeys(exportCredentials.result as Record<string, unknown>, ['exported_artifacts', 'log', 'performance', 'role'], 'backup_export_credentials');

  const verify = await runHeadlessCommand({
    command: 'backup_verify',
    targetPath: '/Volumes/CITIZEN_USB',
    expectedVaultVersion: 'v1alpha1',
    requireSignedManifest: true,
    manifestSignatureKeyId: 'citizen-wallet-maintainers:v1',
  });

  assert(verify.schemaVersion === 'v1alpha1', 'backup_verify schema version drifted');
  assert(verify.contractVersion === '2026-05-01', 'backup_verify contract version drifted');
  assert(verify.command === 'backup_verify', 'backup_verify command mismatch');
  assert(verify.ok === true, 'backup_verify should succeed');
  assert(!!verify.result, 'backup_verify result missing');
  assertKeys(verify.result as Record<string, unknown>, ['checks', 'log', 'manifest', 'performance', 'verified_at'], 'backup_verify');

  const restore = await runHeadlessCommand({
    command: 'backup_restore',
    targetPath: '/Volumes/CITIZEN_USB',
    role: 'critical',
    restoreIdentityKeys: true,
    restoreAccountKeys: true,
    restoreConsentReceipts: false,
    backupCandidates: [
      { id: 'backup-z', createdAt: '2026-04-01T00:00:00.000Z', verifiedAt: '2026-04-02T00:00:00.000Z' },
      { id: 'backup-a', createdAt: '2026-04-02T00:00:00.000Z', verifiedAt: '2026-04-02T00:00:00.000Z' },
    ],
  });

  assert(restore.schemaVersion === 'v1alpha1', 'backup_restore schema version drifted');
  assert(restore.contractVersion === '2026-05-01', 'backup_restore contract version drifted');
  assert(restore.command === 'backup_restore', 'backup_restore command mismatch');
  assert(restore.ok === true, 'backup_restore should succeed');
  assert(!!restore.result, 'backup_restore result missing');
  assertKeys(restore.result as Record<string, unknown>, ['log', 'performance', 'restored_artifacts', 'restored_at', 'restored_role', 'selected_backup_id'], 'backup_restore');
  assert((restore.result as Record<string, unknown>).selected_backup_id === 'backup-a', 'backup_restore selected backup ordering drifted');

  const manifestPolicy = await runHeadlessCommand({
    command: 'backup_verify',
    targetPath: '/Volumes/CITIZEN_USB',
    expectedVaultVersion: 'v1alpha1',
    requireSignedManifest: true,
  });
  assert(manifestPolicy.ok === false, 'manifest policy failure should return error');
  assert(manifestPolicy.error?.code === 'manifest_signature_missing', 'expected manifest_signature_missing error code');

  const invalidPath = await runHeadlessCommand({
    command: 'backup_init',
    targetPath: './relative/path',
    roles: ['decoy'],
    includeConsentReceipts: false,
    portableMode: true,
  });
  assert(invalidPath.ok === false, 'relative non-mounted path should be rejected');
  assert(invalidPath.error?.code === 'path_invalid', 'expected path_invalid for non-mounted path');

  const windowsPath = await runHeadlessCommand({
    command: 'backup_init',
    targetPath: 'E:\\Vaultier\\wallet-backup.cvb',
    roles: ['decoy'],
    includeConsentReceipts: false,
    portableMode: true,
  });
  assert(windowsPath.ok === true, 'windows mounted removable path should be accepted');

  const diagnostics = await runHeadlessCommand({
    command: 'backup_diagnostics',
    targetPath: '/Volumes/CITIZEN_USB',
    profile: {
      portableLabel: 'CITIZEN_USB',
      schemaVersion: 'v1alpha1',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastVerifiedAt: '2026-05-01T00:30:00.000Z',
    },
    recentLogs: [
      { at: '2026-05-01T00:30:00.000Z', action: 'vault.verify', status: 'ok', details: 'Deterministic verification checks completed.' },
    ],
    recentErrors: [],
    performanceMeasurements: [
      { operation: 'verify', elapsedMs: 620, thresholdMs: 2000, status: 'ok', measuredAt: '2026-05-01T00:30:00.000Z' },
    ],
  });
  assert(diagnostics.ok === true, 'backup_diagnostics should succeed');
  assert(!!diagnostics.result, 'backup_diagnostics result missing');
  assertKeys(
    diagnostics.result as Record<string, unknown>,
    ['app_version', 'generated_at', 'performance_measurements', 'platform', 'profile', 'recent_errors', 'recent_logs'],
    'backup_diagnostics',
  );
}

void main();
