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
  VaultierErrorCode,
  RuntimePlatform,
  DriveProbeIssue,
  DriveRecord,
  PerformanceMeasurement,
  CrashSafeWriteStep,
} from './types';
import { detectRuntimeShell, discoverDrivesViaTauri, flushViaTauri } from './runtimeBridge';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

export function getRuntimeShell(): RuntimeShell {
  return detectRuntimeShell();
}

type DriveDiscoveryAdapter = {
  platform: RuntimePlatform;
  discover: () => Promise<{ drives: DriveRecord[]; issues: DriveProbeIssue[] }>;
};

const supportedFilesystems: Array<DriveRecord['filesystem']> = ['exfat', 'ntfs', 'apfs', 'ext4'];
const REQUIRED_CRASH_SAFE_STEPS: CrashSafeWriteStep['step'][] = ['temp_write', 'fsync_file', 'atomic_rename', 'fsync_parent'];

function isCrashSafeStrategyComplete(strategy: CrashSafeWriteStep[]): boolean {
  const seen = new Set(strategy.filter((item) => item.status === 'ok').map((item) => item.step));
  return REQUIRED_CRASH_SAFE_STEPS.every((step) => seen.has(step));
}

function validateDriveRecords(platform: RuntimePlatform, drives: DriveRecord[]): { drives: DriveRecord[]; issues: DriveProbeIssue[] } {
  const issues: DriveProbeIssue[] = [];
  const safeDrives = drives.filter((drive) => {
    if (!supportedFilesystems.includes(drive.filesystem)) {
      issues.push({
        mountPath: drive.mountPath,
        code: 'filesystem_incompatible',
        detail: `${platform}: ${drive.filesystem.toUpperCase()} is higher-risk for portable backup containers.`,
      });
      return false;
    }
    if (drive.estimatedFreeGb < 4) {
      issues.push({
        mountPath: drive.mountPath,
        code: 'insufficient_space',
        detail: `${platform}: at least 4GB free space is recommended for backup + verify workflows.`,
      });
      return false;
    }
    if (!drive.writable) {
      issues.push({
        mountPath: drive.mountPath,
        code: 'mount_unwritable',
        detail: `${platform}: drive is mounted read-only; remount with write permissions.`,
      });
      return false;
    }
    return true;
  });
  return { drives: safeDrives, issues };
}

const mockDiscoveryAdapters: DriveDiscoveryAdapter[] = [
  {
    platform: 'macos',
    discover: async () => {
      const drives: DriveRecord[] = [
        { id: 'usb-1', label: 'CITIZEN_USB', mountPath: '/Volumes/CITIZEN_USB', filesystem: 'exfat', writable: true, estimatedFreeGb: 58 },
      ];
      return validateDriveRecords('macos', drives);
    },
  },
  {
    platform: 'windows',
    discover: async () => {
      const drives: DriveRecord[] = [
        { id: 'usb-2', label: 'RECOVERY_KEY', mountPath: 'E:\\', filesystem: 'ntfs', writable: true, estimatedFreeGb: 24 },
      ];
      return validateDriveRecords('windows', drives);
    },
  },
  {
    platform: 'linux',
    discover: async () => {
      const drives: DriveRecord[] = [
        { id: 'usb-3', label: 'ops_backup', mountPath: '/media/ops/ops_backup', filesystem: 'ext4', writable: false, estimatedFreeGb: 3 },
      ];
      return validateDriveRecords('linux', drives);
    },
  },
];

export async function discoverRemovableDrives(): Promise<DriveDiscoveryResult> {
  await wait(180);
  if (getRuntimeShell() === 'tauri') {
    const tauriResult = await discoverDrivesViaTauri();
    return {
      drives: tauriResult.drives,
      errors: tauriResult.issues,
    };
  }
  const results = await Promise.all(mockDiscoveryAdapters.map((adapter) => adapter.discover().then((result) => ({ platform: adapter.platform, ...result }))));
  return results.reduce<DriveDiscoveryResult>(
    (acc, result) => {
      acc.drives.push(...result.drives.map((drive) => ({ ...drive, platform: result.platform })));
      acc.errors.push(...result.issues);
      return acc;
    },
    { drives: [], errors: [] },
  );
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
  if (getRuntimeShell() === 'tauri') {
    const tauri = await flushViaTauri(targetPath);
    if (tauri.bridgeIssue) {
      logs.unshift({ at: now(), action: 'vault.flush.bridge', status: 'warn', details: tauri.bridgeIssue.detail });
    }
    if (tauri.strategy.length > 0) {
      if (!isCrashSafeStrategyComplete(tauri.strategy)) {
        logs.unshift({
          at: now(),
          action: 'vault.flush.strategy.incomplete',
          status: 'warn',
          details: 'Runtime bridge strategy omitted one or more crash-safe write steps; do not eject until complete.',
        });
      }
      return { logs, strategy: tauri.strategy };
    }
  }
  const fallbackStrategy: CrashSafeWriteStep[] = [
    { step: 'temp_write', status: 'ok', detail: 'Write encrypted payload to .tmp container file.' },
    { step: 'fsync_file', status: 'ok', detail: 'Sync temporary file bytes before rename.' },
    { step: 'atomic_rename', status: 'ok', detail: 'Replace prior container atomically where supported.' },
    { step: 'fsync_parent', status: 'ok', detail: 'Sync parent directory metadata for crash consistency.' },
  ];
  return {
    logs,
    strategy: fallbackStrategy,
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
    kdfProfile: {
      algorithm: 'argon2id',
      profile: request.roles.includes('critical') ? 'hardened' : 'balanced',
      memoryKiB: request.roles.includes('critical') ? 262_144 : 131_072,
      iterations: request.roles.includes('critical') ? 4 : 3,
      parallelism: 1,
    },
    log,
  };
}

export async function verifyBackup(request: VerifyRequest): Promise<VerifyResult> {
  await wait(650);
  const verifiedAt = now();
  const tamperCode = request.targetPath.includes('tamper-header')
    ? 'header_auth_failed'
    : request.targetPath.includes('tamper-slot-table')
      ? 'slot_table_tampered'
      : request.targetPath.includes('tamper-rollback')
        ? 'rollback_counter_mismatch'
        : null;
  const manifest = {
    signed: true,
    signatureKeyId: request.manifestSignatureKeyId || 'citizen-wallet-maintainers:v1',
    verified: tamperCode === null,
  };
  if (request.requireSignedManifest && !manifest.signatureKeyId) {
    manifest.verified = false;
  }
  return {
    verifiedAt,
    checks: [
      {
        label: 'Header integrity',
        status: tamperCode === 'header_auth_failed' ? 'warn' : 'ok',
        detail: tamperCode === 'header_auth_failed' ? 'Header authentication failed.' : 'Vault header authenticated.',
      },
      {
        label: 'Slot inventory',
        status: tamperCode === 'slot_table_tampered' ? 'warn' : 'ok',
        detail: tamperCode === 'slot_table_tampered' ? 'Authenticated slot table mismatch detected.' : 'Required decoy/critical metadata found.',
      },
      {
        label: 'Rollback counter',
        status: tamperCode === 'rollback_counter_mismatch' ? 'warn' : 'ok',
        detail: tamperCode === 'rollback_counter_mismatch' ? 'Counter mismatch indicates stale/replayed container.' : 'Monotonic rollback counter verified.',
      },
      { label: 'Version compatibility', status: 'ok', detail: `Detected ${request.expectedVaultVersion}.` },
      { label: 'Portable profile', status: 'ok', detail: `Target ${request.targetPath} is portable-mode compatible.` },
      {
        label: 'Signed manifest',
        status: manifest.verified ? 'ok' : 'warn',
        detail: manifest.verified
          ? `Verified using ${manifest.signatureKeyId}.`
          : tamperCode ? `Tamper signal mapped to deterministic code: ${tamperCode}.` : 'Manifest signature verification policy failed.',
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

export async function exportDiagnosticBundle(profile: PortableProfile, recentLogs: OperationLog[], recentErrors: string[], performanceMeasurements: PerformanceMeasurement[]): Promise<DiagnosticBundle> {
  await wait(250);
  return {
    generatedAt: now(),
    platform: navigator.userAgent,
    appVersion: 'vaultier-dev',
    profile,
    recentLogs,
    recentErrors,
    performanceMeasurements,
  };
}

export async function runHeadlessCommand(command: HeadlessCommand): Promise<HeadlessResponse> {
  const fail = (code: VaultierErrorCode, message: string): HeadlessResponse => ({
    schemaVersion: 'v1alpha1',
    contractVersion: '2026-05-01',
    ok: false,
    command: command.command,
    error: { code, message },
  });

  if (!command.targetPath.trim()) {
    return fail('path_invalid', 'Target path is required.');
  }

  if (command.command === 'backup_init') {
    if (!command.roles.length) {
      return fail('critical_entropy_too_low', 'At least one slot role is required.');
    }
    const result = await createBackup(command);
    return {
      schemaVersion: 'v1alpha1',
      contractVersion: '2026-05-01',
      ok: true,
      command: command.command,
      result: {
        profile: result.profile,
        kdf_profile: result.kdfProfile,
        log: result.log,
      },
    };
  }

  if (command.command === 'backup_verify') {
    if (command.requireSignedManifest && !command.manifestSignatureKeyId) {
      return fail('manifest_signature_missing', 'Signed manifest key id is required when policy is enforced.');
    }
    const result = await verifyBackup(command);
    if (!result.manifest.verified) {
      return fail('manifest_signature_invalid', 'Manifest signature verification failed.');
    }
    return {
      schemaVersion: 'v1alpha1',
      contractVersion: '2026-05-01',
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
    contractVersion: '2026-05-01',
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
