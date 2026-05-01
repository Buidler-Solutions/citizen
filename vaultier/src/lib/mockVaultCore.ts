import type { BackupRequest, OperationLog, PortableProfile } from './types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createBackup(
  request: BackupRequest
): Promise<{ profile: PortableProfile; log: OperationLog[] }> {
  await wait(700);
  const timestamp = new Date().toISOString();
  return {
    profile: {
      usbLabel: request.targetPath.split('/').pop() || 'USB_DRIVE',
      vaultVersion: 'v1alpha1',
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
    },
    log: [
      { at: timestamp, action: 'vault.init', status: 'ok', details: 'Container initialized with Argon2id profile.' },
      { at: timestamp, action: 'vault.slot.decoy', status: 'ok', details: request.roles.includes('decoy') ? 'Decoy slot provisioned.' : 'Decoy slot skipped.' },
      { at: timestamp, action: 'vault.slot.critical', status: 'ok', details: request.roles.includes('critical') ? 'Critical slot provisioned.' : 'Critical slot skipped.' },
    ],
  };
}
