import { detectRuntimeShell, discoverDrivesViaTauri, flushViaTauri, invokeBackupCommandViaTauri, safeEjectViaTauri, sanitizeTauriPayloadForLogs } from './runtimeBridge';
import type { HeadlessResponse } from './types';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type InvokeFn = (name: string, args?: unknown) => Promise<unknown>;

function withTauriInvoke(invoke?: InvokeFn): void {
  (globalThis as unknown as { window?: unknown }).window = invoke ? ({ __TAURI__: { core: { invoke } } } as unknown) : ({} as unknown);
}

async function main() {
  const sanitized = sanitizeTauriPayloadForLogs({ passphrase: 'x', nested: { backupPassword: 'y', notes: 'safe' } }) as Record<string, unknown>;
  assert(sanitized.passphrase === '[REDACTED]', 'top-level secret field should be redacted');
  assert((sanitized.nested as Record<string, unknown>).backupPassword === '[REDACTED]', 'nested password field should be redacted');

  withTauriInvoke(undefined);
  assert(detectRuntimeShell() === 'web-mock', 'runtime detection should default to web-mock without tauri bridge');
  assert((await discoverDrivesViaTauri()).issues[0]?.code === 'media_unavailable', 'discovery fallback should emit media_unavailable issue');
  assert((await flushViaTauri('/mnt/usb')).bridgeIssue?.code === 'media_unavailable', 'flush fallback should emit media_unavailable issue');

  assert((await safeEjectViaTauri('/mnt/usb')).bridgeIssue?.code === 'media_unavailable', 'safe-eject fallback should emit media_unavailable issue');

  withTauriInvoke(async (name, args) => {
    if (name === 'discover_removable_drives') {
      return {
        drives: [
          { id: 'usb-1', label: 'Citizen Vault', mountPath: '/media/usb', filesystem: 'exfat', estimatedFreeGb: 64, writable: true, platform: 'linux' },
        ],
      };
    }
    if (name === 'flush_vault_writes') {
      assert((args as { targetPath: string }).targetPath === '/media/usb/vault.cvb', 'flush should forward targetPath payload');
      return {
        strategy: [
          { step: 'temp_write', status: 'ok', detail: 'temp file written' },
          { step: 'fsync_file', status: 'ok', detail: 'file synced' },
        ],
      };
    }

    if (name === 'safe_eject_media') {
      assert((args as { targetPath: string }).targetPath === '/media/usb/vault.cvb', 'safe-eject should forward targetPath payload');
      return { ok: true };
    }
    if (name === 'backup_verify') {
      const response: HeadlessResponse = { schemaVersion: 'v1alpha1', contractVersion: '2026-05-01', ok: true, command: 'backup_verify', result: {} };
      return response;
    }
    throw new Error(`unexpected_command:${name}`);
  });

  assert(detectRuntimeShell() === 'tauri', 'runtime detection should report tauri when bridge exists');
  assert((await discoverDrivesViaTauri()).drives.length === 1, 'tauri discovery should surface bridged drive records');
  assert((await flushViaTauri('/media/usb/vault.cvb')).strategy.length > 0, 'tauri flush should return strategy evidence');
  assert((await safeEjectViaTauri('/media/usb/vault.cvb')).ok === true, 'tauri safe-eject should return bridged result');

  const verify = await invokeBackupCommandViaTauri({ command: 'backup_verify', targetPath: '/media/usb/vault.cvb', expectedVaultVersion: '1', requireSignedManifest: true });
  assert(verify.ok === true, 'verify bridge command should return headless response payload');

  withTauriInvoke(async () => {
    throw new Error('bridge_failure');
  });

  try {
    await invokeBackupCommandViaTauri({ command: 'backup_restore', targetPath: '/media/usb/vault.cvb', role: 'critical', restoreIdentityKeys: true, restoreAccountKeys: true, restoreConsentReceipts: true });
    throw new Error('expected failure');
  } catch (error) {
    const message = String((error as Error).message);
    assert(message.includes('tauri_backup_restore_failed'), 'bridge failures should include deterministic command prefix');
    assert(!message.includes('super-secret'), 'bridge failure details must redact secrets when present');
  }
}

main();
