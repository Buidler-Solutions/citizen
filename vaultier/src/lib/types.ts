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
};

export type RemovableDrive = {
  id: string;
  label: string;
  mountPath: string;
  platform: 'macos' | 'windows' | 'linux';
  filesystem: 'exfat' | 'ntfs' | 'fat32' | 'ext4' | 'apfs';
};
