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
  log: OperationLog[];
};

export type VerifyResult = {
  verifiedAt: string;
  checks: Array<{ label: string; status: 'ok' | 'warn'; detail: string }>;
  log: OperationLog[];
};

export type RestoreResult = {
  restoredAt: string;
  restoredRole: VaultRole;
  restoredArtifacts: string[];
  log: OperationLog[];
};

export type DiagnosticBundle = {
  generatedAt: string;
  platform: string;
  appVersion: string;
  profile: PortableProfile;
  recentLogs: OperationLog[];
  recentErrors: string[];
};

export type HeadlessCommand =
  | { command: 'backup_init'; targetPath: string; roles: VaultRole[]; includeConsentReceipts: boolean; portableMode: boolean }
  | { command: 'backup_verify'; targetPath: string; expectedVaultVersion: string }
  | {
      command: 'backup_restore';
      targetPath: string;
      role: VaultRole;
      restoreIdentityKeys: boolean;
      restoreAccountKeys: boolean;
      restoreConsentReceipts: boolean;
    };

export type HeadlessResponse = {
  ok: true;
  command: HeadlessCommand['command'];
  result: Record<string, unknown>;
};

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
  errors: Array<{ mountPath: string; code: 'mount_unwritable' | 'media_unavailable' | 'path_invalid'; detail: string }>;
};

export type RuntimeShell = 'tauri' | 'web-mock';

export type CrashSafeWriteStep = {
  step: 'temp_write' | 'fsync_file' | 'atomic_rename' | 'fsync_parent';
  status: 'ok' | 'warn';
  detail: string;
};

export type FlushResult = {
  logs: OperationLog[];
  strategy: CrashSafeWriteStep[];
};
