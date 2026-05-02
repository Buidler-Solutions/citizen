import { detectRuntimeShell, discoverDrivesViaTauri, flushViaTauri, invokeBackupCommandViaTauri, safeEjectViaTauri, sanitizeTauriPayloadForLogs } from './runtimeBridge';
import { readFileSync } from 'node:fs';
import type { HeadlessResponse } from './types';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type InvokeFn = (name: string, args?: unknown) => Promise<unknown>;


function assertKeys(response: Record<string, unknown>, expected: string[], label: string): void {
  const responseKeys = Object.keys(response).sort();
  const expectedKeys = [...expected].sort();
  assert(
    JSON.stringify(responseKeys) === JSON.stringify(expectedKeys),
    `${label}: expected keys [${expectedKeys.join(',')}] but got [${responseKeys.join(',')}]`,
  );
}

const resultShapeFixturePath = decodeURIComponent(new URL('../../fixtures/command-result-shape.v1.json', import.meta.url).pathname);
const resultShapeFixture = JSON.parse(readFileSync(resultShapeFixturePath, 'utf8')) as {
  commands: Record<string, string[]>;
  expectedTopLevelValues: Record<string, unknown>;
  expectedResultKeys: Record<string, string[]>;
  expectedResultValues: Record<string, Record<string, unknown>>;
};


function assertTopLevelFixtureValues(response: Record<string, unknown>, expected: Record<string, unknown>, command: string): void {
  for (const [key, value] of Object.entries(expected)) {
    assert(
      JSON.stringify(response[key]) === JSON.stringify(value),
      `runtime parity snapshot value drift for ${command}:${key}`,
    );
  }
}


function buildFixtureResult(command: string): Record<string, unknown> {
  const keys = resultShapeFixture.expectedResultKeys[command] ?? [];
  const response: Record<string, unknown> = {};
  for (const key of keys) {
    response[key] = `fixture-${command}-${key}`;
  }
  return response;
}


function assertResultFixtureValues(response: Record<string, unknown>, expected: Record<string, unknown>, command: string): void {
  for (const [key, value] of Object.entries(expected)) {
    assert(
      JSON.stringify(response[key]) === JSON.stringify(value),
      `runtime parity result-value drift for ${command}:${key}`,
    );
  }
}

function withTauriInvoke(invoke?: InvokeFn): void {
  (globalThis as unknown as { window?: unknown }).window = invoke ? ({ __TAURI__: { core: { invoke } } } as unknown) : ({} as unknown);
}

async function main() {
  const sanitized = sanitizeTauriPayloadForLogs({ passphrase: 'x', nested: { backupPassword: 'y', notes: 'safe' }, args: ['--slot-password=abc123'] }) as Record<string, unknown>;
  assert(sanitized.passphrase === '[REDACTED]', 'top-level secret field should be redacted');
  assert((sanitized.nested as Record<string, unknown>).backupPassword === '[REDACTED]', 'nested password field should be redacted');
  assert(((sanitized.args as unknown[])[0] as string) === '[REDACTED]', 'secret-like CLI arg strings should be redacted');

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
    if (['backup_init', 'backup_add_slot', 'backup_export_credentials', 'backup_verify', 'backup_restore', 'backup_diagnostics'].includes(name)) {
      const response: HeadlessResponse = { schemaVersion: 'v1alpha1', contractVersion: '2026-05-01', ok: true, command: name as HeadlessResponse['command'], result: {} };
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

  const parityCommands = [
    { command: 'backup_init', payload: { command: 'backup_init', targetPath: '/media/usb/vault.cvb', decoyPassword: 'decoy-pass', criticalPassword: 'critical-pass' } },
    { command: 'backup_add_slot', payload: { command: 'backup_add_slot', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    { command: 'backup_export_credentials', payload: { command: 'backup_export_credentials', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    { command: 'backup_verify', payload: { command: 'backup_verify', targetPath: '/media/usb/vault.cvb', expectedVaultVersion: '1', requireSignedManifest: true } },
    { command: 'backup_restore', payload: { command: 'backup_restore', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    { command: 'backup_diagnostics', payload: { command: 'backup_diagnostics', targetPath: '/media/usb/vault.cvb', profile: { portableLabel: 'Citizen Vault', schemaVersion: 'citizen.wallet.backup.v1', createdAt: '2026-05-02T00:00:00.000Z' }, recentLogs: [], recentErrors: [], performanceMeasurements: [] } },
  ] as const;

  withTauriInvoke(async (name) => {
    if (!parityCommands.some((entry) => entry.command === name)) {
      throw new Error(`unexpected_command:${name}`);
    }

    const fixtureKeys = resultShapeFixture.commands[name] ?? [];
    const response: Record<string, unknown> = {
      ...resultShapeFixture.expectedTopLevelValues,
      command: name,
      result: buildFixtureResult(name),
    };

    for (const key of fixtureKeys) {
      if (!(key in response)) {
        response[key] = key === 'result' ? {} : 'fixture-value';
      }
    }

    return response;
  });

  for (const parity of parityCommands) {
    const response = await invokeBackupCommandViaTauri(parity.payload as Parameters<typeof invokeBackupCommandViaTauri>[0]);
    const responseRecord = response as Record<string, unknown>;
    assertTopLevelFixtureValues(responseRecord, resultShapeFixture.expectedTopLevelValues, parity.command);
    const responseKeys = Object.keys(responseRecord).sort();
    const expectedKeys = [...resultShapeFixture.commands[parity.command]].sort();
    assert(JSON.stringify(responseKeys) === JSON.stringify(expectedKeys), `runtime parity snapshot key drift for ${parity.command}`);
    const resultRecord = (responseRecord.result ?? {}) as Record<string, unknown>;
    const resultKeys = Object.keys(resultRecord).sort();
    const expectedResultKeys = [...(resultShapeFixture.expectedResultKeys[parity.command] ?? [])].sort();
    assert(JSON.stringify(resultKeys) === JSON.stringify(expectedResultKeys), `runtime parity result-key drift for ${parity.command}`);
    const expectedResultValues = resultShapeFixture.expectedResultValues[parity.command] ?? {};
    assertResultFixtureValues(resultRecord, expectedResultValues, parity.command);
  }

  withTauriInvoke(async (name, args) => {
    if (name === 'flush_vault_writes') {
      assert((args as { targetPath: string }).targetPath === '/media/usb/vault.cvb', 'flush parity should forward targetPath payload');
      return { strategy: [{ step: 'temp_write', status: 'ok', detail: 'fixture-step' }] };
    }
    if (name === 'safe_eject_media') {
      assert((args as { targetPath: string }).targetPath === '/media/usb/vault.cvb', 'safe-eject parity should forward targetPath payload');
      return { ok: true };
    }
    throw new Error(`unexpected_command:${name}`);
  });

  const flushParity = await flushViaTauri('/media/usb/vault.cvb');
  assert(flushParity.bridgeIssue === undefined, 'flush parity should not return bridgeIssue when tauri bridge responds');
  assert(flushParity.strategy.length === 1, 'flush parity should preserve runtime strategy shape');
  const flushStep = flushParity.strategy[0] as Record<string, unknown>;
  assertKeys(flushStep, ['detail', 'status', 'step'], 'flush_vault_writes parity');

  const ejectParity = await safeEjectViaTauri('/media/usb/vault.cvb');
  assert(ejectParity.bridgeIssue === undefined, 'safe-eject parity should not return bridgeIssue when tauri bridge responds');
  assert(ejectParity.ok === true, 'safe-eject parity should preserve runtime ok status');


  withTauriInvoke(async () => {
    throw new Error('bridge_failure');
  });

  try {
    await invokeBackupCommandViaTauri({ command: 'backup_verify', targetPath: '/media/usb/vault.cvb', expectedVaultVersion: '1', requireSignedManifest: true, manifestSignatureKeyId: 'password=super-secret' });
    throw new Error('expected failure');
  } catch (error) {
    const message = String((error as Error).message);
    assert(message.includes('tauri_backup_verify_failed'), 'bridge failures should include deterministic command prefix');
    assert(!message.includes('super-secret'), 'bridge failure details must redact secrets when present');
  }



  const commandsForRedaction = [
    { command: 'backup_init', payload: { command: 'backup_init', targetPath: '/media/usb/vault.cvb', decoyPassword: 'decoy-pass', criticalPassword: 'critical-pass' } },
    { command: 'backup_add_slot', payload: { command: 'backup_add_slot', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    { command: 'backup_export_credentials', payload: { command: 'backup_export_credentials', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    { command: 'backup_verify', payload: { command: 'backup_verify', targetPath: '/media/usb/vault.cvb', expectedVaultVersion: '1', requireSignedManifest: true } },
    { command: 'backup_restore', payload: { command: 'backup_restore', targetPath: '/media/usb/vault.cvb', role: 'critical', password: 'critical-pass' } },
    {
      command: 'backup_diagnostics',
      payload: {
        command: 'backup_diagnostics',
        targetPath: '/media/usb/vault.cvb',
        profile: { portableLabel: 'Citizen Vault', schemaVersion: 'citizen.wallet.backup.v1', createdAt: '2026-05-02T00:00:00.000Z' },
        recentLogs: [],
        recentErrors: [],
        performanceMeasurements: [],
      },
    },
  ] as const;

  for (const entry of commandsForRedaction) {
    withTauriInvoke(async (name) => {
      if (name === entry.command) {
        return {
          schemaVersion: 'v1alpha1',
          contractVersion: '2026-05-01',
          ok: true,
          command: entry.command,
          result: { backupPassword: 'should-never-leak' },
        } satisfies HeadlessResponse;
      }
      throw new Error(`unexpected_command:${name}`);
    });

    try {
      await invokeBackupCommandViaTauri(entry.payload as Parameters<typeof invokeBackupCommandViaTauri>[0]);
      throw new Error('expected redaction failure');
    } catch (error) {
      const message = String((error as Error).message);
      assert(message.includes(`tauri_${entry.command}_failed`), `redaction failures should use deterministic command prefix for ${entry.command}`);
      assert(!message.includes('should-never-leak'), `redaction failures must not expose raw secret values for ${entry.command}`);
    }
  }
}

main();
