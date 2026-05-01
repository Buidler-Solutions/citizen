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
  assertKeys(init.result as Record<string, unknown>, ['log', 'profile'], 'backup_init');

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
  assertKeys(verify.result as Record<string, unknown>, ['checks', 'log', 'manifest', 'verified_at'], 'backup_verify');

  const restore = await runHeadlessCommand({
    command: 'backup_restore',
    targetPath: '/Volumes/CITIZEN_USB',
    role: 'critical',
    restoreIdentityKeys: true,
    restoreAccountKeys: true,
    restoreConsentReceipts: false,
  });

  assert(restore.schemaVersion === 'v1alpha1', 'backup_restore schema version drifted');
  assert(restore.contractVersion === '2026-05-01', 'backup_restore contract version drifted');
  assert(restore.command === 'backup_restore', 'backup_restore command mismatch');
  assert(restore.ok === true, 'backup_restore should succeed');
  assert(!!restore.result, 'backup_restore result missing');
  assertKeys(restore.result as Record<string, unknown>, ['log', 'restored_artifacts', 'restored_at', 'restored_role'], 'backup_restore');

  const manifestPolicy = await runHeadlessCommand({
    command: 'backup_verify',
    targetPath: '/Volumes/CITIZEN_USB',
    expectedVaultVersion: 'v1alpha1',
    requireSignedManifest: true,
  });
  assert(manifestPolicy.ok === false, 'manifest policy failure should return error');
  assert(manifestPolicy.error?.code === 'manifest_signature_missing', 'expected manifest_signature_missing error code');
}

void main();
