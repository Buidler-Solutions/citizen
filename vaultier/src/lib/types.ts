export type VaultRole = 'decoy' | 'critical';

export type PortableProfile = {
  usbLabel: string;
  vaultVersion: string;
  createdAt: string;
  lastVerifiedAt?: string;
};

export type BackupRequest = {
  targetPath: string;
  roles: VaultRole[];
  includeConsentReceipts: boolean;
  portableMode: boolean;
};

export type VerifyRequest = {
  targetPath: string;
  expectedVaultVersion: string;
  requireSignedManifest: boolean;
  manifestSignatureKeyId?: string;
};

export type RestoreRequest = {
  targetPath: string;
  role: VaultRole;
  restoreIdentityKeys: boolean;
  restoreAccountKeys: boolean;
  restoreConsentReceipts: boolean;
};

export type OperationLog = {
  at: string;
  action: string;
  status: 'ok' | 'warn';
  details: string;
};

export type BackupResult = {
  profile: PortableProfile;
  kdfProfile: {
    algorithm: 'argon2id';
    profile: 'interactive' | 'balanced' | 'hardened' | 'critical-hardened';
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  };
  log: OperationLog[];
};

export type VerifyResult = {
  verifiedAt: string;
  checks: Array<{ label: string; status: 'ok' | 'warn'; detail: string }>;
  manifest: { signed: boolean; signatureKeyId: string; verified: boolean };
  log: OperationLog[];
};

export type RestoreResult = {
  restoredAt: string;
  restoredRole: VaultRole;
  restoredArtifacts: string[];
  log: OperationLog[];
};


export type PerformanceTarget = {
  operation: 'create' | 'verify' | 'restore';
  thresholdMs: number;
};

export type PerformanceMeasurement = {
  operation: 'create' | 'verify' | 'restore';
  elapsedMs: number;
  thresholdMs: number;
  status: 'ok' | 'warn';
  measuredAt: string;
};

export type DiagnosticBundle = {
  generatedAt: string;
  platform: string;
  appVersion: string;
  profile: PortableProfile;
  recentLogs: OperationLog[];
  recentErrors: string[];
  performanceMeasurements: PerformanceMeasurement[];
};

export type HeadlessCommand =
  | { command: 'backup_init'; targetPath: string; roles: VaultRole[]; includeConsentReceipts: boolean; portableMode: boolean }
  | {
      command: 'backup_verify';
      targetPath: string;
      expectedVaultVersion: string;
      requireSignedManifest: boolean;
      manifestSignatureKeyId?: string;
    }
  | {
      command: 'backup_restore';
      targetPath: string;
      role: VaultRole;
      restoreIdentityKeys: boolean;
      restoreAccountKeys: boolean;
      restoreConsentReceipts: boolean;
    };

export type HeadlessResponse = {
  schemaVersion: 'v1alpha1';
  contractVersion: '2026-05-01';
  ok: boolean;
  command: HeadlessCommand['command'];
  result?: Record<string, unknown>;
  error?: {
    code: VaultierErrorCode;
    message: string;
  };
};

export type VaultierErrorCode =
  | 'path_invalid'
  | 'mount_unwritable'
  | 'insufficient_space'
  | 'filesystem_incompatible'
  | 'critical_entropy_too_low'
  | 'manifest_signature_missing'
  | 'manifest_signature_invalid'
  | 'header_auth_failed'
  | 'slot_table_tampered'
  | 'rollback_counter_mismatch';

export type RemovableDrive = {
  id: string;
  label: string;
  mountPath: string;
  platform: 'macos' | 'windows' | 'linux';
  filesystem: 'exfat' | 'ntfs' | 'fat32' | 'ext4' | 'apfs';
  writable: boolean;
  estimatedFreeGb: number;
};

export type DriveDiscoveryResult = {
  drives: RemovableDrive[];
  errors: Array<{ mountPath: string; code: 'mount_unwritable' | 'media_unavailable' | 'path_invalid' | 'filesystem_incompatible' | 'insufficient_space'; detail: string }>;
};

export type RuntimeShell = 'tauri' | 'web-mock';

export type RuntimePlatform = 'macos' | 'windows' | 'linux';

export type DriveRecord = {
  id: string;
  label: string;
  mountPath: string;
  filesystem: RemovableDrive['filesystem'];
  writable: boolean;
  estimatedFreeGb: number;
};

export type DriveProbeIssue = {
  mountPath: string;
  code: 'mount_unwritable' | 'media_unavailable' | 'path_invalid' | 'filesystem_incompatible' | 'insufficient_space';
  detail: string;
};

export type CrashSafeWriteStep = {
  step: 'temp_write' | 'fsync_file' | 'atomic_rename' | 'fsync_parent';
  status: 'ok' | 'warn';
  detail: string;
};

export type FlushResult = {
  logs: OperationLog[];
  strategy: CrashSafeWriteStep[];
};
