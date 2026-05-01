import type {
  BackupRequest,
  BackupResult,
  DiagnosticBundle,
  PortableProfile,
  OperationLog,
  RemovableDrive,
  RestoreRequest,
  RestoreResult,
  VerifyRequest,
  VerifyResult,
} from './types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const now = () => new Date().toISOString();

export async function discoverRemovableDrives(): Promise<RemovableDrive[]> {
  await wait(180);
  return [
    { id: 'usb-1', label: 'CITIZEN_USB', mountPath: '/Volumes/CITIZEN_USB', platform: 'macos', filesystem: 'exfat' },
    { id: 'usb-2', label: 'RECOVERY_KEY', mountPath: 'E:\\', platform: 'windows', filesystem: 'ntfs' },
    { id: 'usb-3', label: 'ops_backup', mountPath: '/media/ops/ops_backup', platform: 'linux', filesystem: 'ext4' },
  ];
}

export async function flushPendingWrites(targetPath: string): Promise<OperationLog[]> {
  await wait(220);
  const at = now();
  return [
    { at, action: 'vault.flush.begin', status: 'ok', details: `Flushing buffered writes for ${targetPath}.` },
    { at, action: 'vault.flush.complete', status: 'ok', details: 'All writes synced with fsync + atomic rename policy.' },
  ];
}

export async function createBackup(request: BackupRequest): Promise<BackupResult> {
  await wait(800);
  const timestamp = now();
  const log: OperationLog[] = [
    { at: timestamp, action: 'vault.init', status: 'ok', details: 'Container initialized with Argon2id baseline profile.' },
    { at: timestamp, action: 'vault.slot.decoy', status: request.roles.includes('decoy') ? 'ok' : 'warn', details: request.roles.includes('decoy') ? 'Decoy slot provisioned.' : 'Decoy slot skipped.' },
    { at: timestamp, action: 'vault.slot.critical', status: request.roles.includes('critical') ? 'ok' : 'warn', details: request.roles.includes('critical') ? 'Critical slot provisioned.' : 'Critical slot skipped.' },
    { at: timestamp, action: 'wallet.export', status: 'ok', details: request.includeConsentReceipts ? 'Identity, account, and consent artifacts exported.' : 'Identity and account artifacts exported.' },
  ];

  return {
    profile: {
      usbLabel: request.targetPath.split('/').pop() || 'USB_DRIVE',
      vaultVersion: 'v1alpha1',
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
    },
    log,
  };
}

export async function verifyBackup(request: VerifyRequest): Promise<VerifyResult> {
  await wait(650);
  const verifiedAt = now();
  return {
    verifiedAt,
    checks: [
      { label: 'Header integrity', status: 'ok', detail: 'Vault header authenticated.' },
      { label: 'Slot inventory', status: 'ok', detail: 'Required decoy/critical metadata found.' },
      { label: 'Version compatibility', status: 'ok', detail: `Detected ${request.expectedVaultVersion}.` },
      { label: 'Portable profile', status: 'ok', detail: `Target ${request.targetPath} is portable-mode compatible.` },
    ],
    log: [
      { at: verifiedAt, action: 'vault.verify', status: 'ok', details: 'Deterministic verification checks completed.' },
    ],
  };
}

export async function testRestore(request: RestoreRequest): Promise<RestoreResult> {
  await wait(900);
  const restoredAt = now();
  const restoredArtifacts = [
    request.restoreIdentityKeys && 'identity_keys',
    request.restoreAccountKeys && 'account_keys',
    request.restoreConsentReceipts && 'consent_receipts',
  ].filter(Boolean) as string[];

  return {
    restoredAt,
    restoredRole: request.role,
    restoredArtifacts,
    log: [
      { at: restoredAt, action: 'vault.restore.simulation', status: 'ok', details: `Restore simulation completed using ${request.role} slot.` },
      { at: restoredAt, action: 'wallet.recover', status: 'ok', details: `Recovered artifacts: ${restoredArtifacts.join(', ') || 'none selected'}.` },
    ],
  };
}

export async function exportDiagnosticBundle(profile: PortableProfile, recentLogs: OperationLog[]): Promise<DiagnosticBundle> {
  await wait(250);
  return {
    generatedAt: now(),
    platform: navigator.userAgent,
    appVersion: 'vaultier-dev',
    profile,
    recentLogs,
  };
}
