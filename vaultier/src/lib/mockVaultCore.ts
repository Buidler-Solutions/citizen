import type {
  BackupRequest,
  BackupResult,
  FlushResult,
  DiagnosticBundle,
  DriveDiscoveryResult,
  PortableProfile,
  OperationLog,
  RestoreRequest,
  RestoreResult,
  VerifyRequest,
  VerifyResult,
  RuntimeShell,
  HeadlessCommand,
  HeadlessResponse,
} from './types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

const ACTIVE_RUNTIME: RuntimeShell = 'web-mock';

export function getRuntimeShell(): RuntimeShell {
  return ACTIVE_RUNTIME;
}

export async function discoverRemovableDrives(): Promise<DriveDiscoveryResult> {
  await wait(180);
  return {
    drives: [
      { id: 'usb-1', label: 'CITIZEN_USB', mountPath: '/Volumes/CITIZEN_USB', platform: 'macos', filesystem: 'exfat', writable: true, estimatedFreeGb: 58 },
      { id: 'usb-2', label: 'RECOVERY_KEY', mountPath: 'E:\\', platform: 'windows', filesystem: 'ntfs', writable: true, estimatedFreeGb: 24 },
      { id: 'usb-3', label: 'ops_backup', mountPath: '/media/ops/ops_backup', platform: 'linux', filesystem: 'ext4', writable: false, estimatedFreeGb: 3 },
    ],
    errors: [
      { mountPath: '/media/ops/ops_backup', code: 'mount_unwritable', detail: 'Drive is mounted read-only; remount with write permissions.' },
    ],
  };
}

export async function flushPendingWrites(targetPath: string): Promise<OperationLog[]> {
  await wait(220);
  const at = now();
  const logs: OperationLog[] = [
    { at, action: 'vault.flush.begin', status: 'ok', details: `Flushing buffered writes for ${targetPath}.` },
    { at, action: 'vault.flush.complete', status: 'ok', details: 'All writes synced with fsync + atomic rename policy.' },
  ];
  return logs;
}

export async function flushPendingWritesWithStrategy(targetPath: string): Promise<FlushResult> {
  const logs = await flushPendingWrites(targetPath);
  return {
    logs,
    strategy: [
      { step: 'temp_write', status: 'ok', detail: 'Write encrypted payload to .tmp container file.' },
      { step: 'fsync_file', status: 'ok', detail: 'Sync temporary file bytes before rename.' },
      { step: 'atomic_rename', status: 'ok', detail: 'Replace prior container atomically where supported.' },
      { step: 'fsync_parent', status: 'ok', detail: 'Sync parent directory metadata for crash consistency.' },
    ],
  };
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
  const manifest = {
    signed: true,
    signatureKeyId: request.manifestSignatureKeyId || 'citizen-wallet-maintainers:v1',
    verified: true,
  };
  if (request.requireSignedManifest && !manifest.signatureKeyId) {
    manifest.verified = false;
  }
  return {
    verifiedAt,
    checks: [
      { label: 'Header integrity', status: 'ok', detail: 'Vault header authenticated.' },
      { label: 'Slot inventory', status: 'ok', detail: 'Required decoy/critical metadata found.' },
      { label: 'Version compatibility', status: 'ok', detail: `Detected ${request.expectedVaultVersion}.` },
      { label: 'Portable profile', status: 'ok', detail: `Target ${request.targetPath} is portable-mode compatible.` },
      {
        label: 'Signed manifest',
        status: manifest.verified ? 'ok' : 'warn',
        detail: manifest.verified
          ? `Verified using ${manifest.signatureKeyId}.`
          : 'Manifest signature verification policy failed.',
      },
    ],
    manifest,
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

export async function exportDiagnosticBundle(profile: PortableProfile, recentLogs: OperationLog[], recentErrors: string[]): Promise<DiagnosticBundle> {
  await wait(250);
  return {
    generatedAt: now(),
    platform: navigator.userAgent,
    appVersion: 'vaultier-dev',
    profile,
    recentLogs,
    recentErrors,
  };
}

export async function runHeadlessCommand(command: HeadlessCommand): Promise<HeadlessResponse> {
  if (command.command === 'backup_init') {
    const result = await createBackup(command);
    return {
      schemaVersion: 'v1alpha1',
      ok: true,
      command: command.command,
      result: {
        profile: result.profile,
        log: result.log,
      },
    };
  }

  if (command.command === 'backup_verify') {
    const result = await verifyBackup(command);
    return {
      schemaVersion: 'v1alpha1',
      ok: true,
      command: command.command,
      result: {
        verified_at: result.verifiedAt,
        manifest: result.manifest,
        checks: result.checks,
        log: result.log,
      },
    };
  }

  const result = await testRestore(command);
  return {
    schemaVersion: 'v1alpha1',
    ok: true,
    command: command.command,
    result: {
      restored_at: result.restoredAt,
      restored_role: result.restoredRole,
      restored_artifacts: result.restoredArtifacts,
      log: result.log,
    },
  };
}
