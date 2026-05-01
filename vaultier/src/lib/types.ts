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

export type OperationLog = {
  at: string;
  action: string;
  status: 'ok' | 'warn';
  details: string;
};
