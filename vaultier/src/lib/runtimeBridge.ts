import type { CrashSafeWriteStep, DriveProbeIssue, DriveRecord, HeadlessCommand, HeadlessResponse, RuntimePlatform, RuntimeShell } from './types';

type BridgeDrive = DriveRecord & { platform: RuntimePlatform };

type TauriBridgeApi = {
  discover_removable_drives: () => Promise<{ drives: BridgeDrive[] }>;
  flush_vault_writes: (payload: { targetPath: string }) => Promise<{ strategy: CrashSafeWriteStep[] }>;
  backup_init: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_init' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_add_slot: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_add_slot' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_export_credentials: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_export_credentials' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_verify: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_verify' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_restore: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_restore' }>, 'command'>) => Promise<HeadlessResponse>;
};

const hasTauriRuntime = () => typeof window !== 'undefined' && '__TAURI__' in window;

async function invokeTauri<T>(command: keyof TauriBridgeApi, payload?: unknown): Promise<T> {
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: <R>(name: string, args?: unknown) => Promise<R> } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    throw new Error('tauri_invoke_unavailable');
  }
  return invoke<T>(command, payload);
}

export function detectRuntimeShell(): RuntimeShell {
  return hasTauriRuntime() ? 'tauri' : 'web-mock';
}

export async function discoverDrivesViaTauri(): Promise<{ drives: BridgeDrive[]; issues: DriveProbeIssue[] }> {
  try {
    const response = await invokeTauri<{ drives: BridgeDrive[] }>('discover_removable_drives');
    return { drives: response.drives, issues: [] };
  } catch {
    return {
      drives: [],
      issues: [
        {
          mountPath: 'runtime://tauri',
          code: 'media_unavailable',
          detail: 'Tauri removable-drive discovery bridge unavailable; falling back to deterministic mock adapter.',
        },
      ],
    };
  }
}

export async function flushViaTauri(targetPath: string): Promise<{ strategy: CrashSafeWriteStep[]; bridgeIssue?: DriveProbeIssue }> {
  try {
    const response = await invokeTauri<{ strategy: CrashSafeWriteStep[] }>('flush_vault_writes', { targetPath });
    return { strategy: response.strategy };
  } catch {
    return {
      strategy: [],
      bridgeIssue: {
        mountPath: targetPath,
        code: 'media_unavailable',
        detail: 'Tauri flush bridge unavailable; fallback strategy used for mock runtime.',
      },
    };
  }
}

export async function invokeBackupCommandViaTauri(command: HeadlessCommand): Promise<HeadlessResponse> {
  const { command: commandName, ...payload } = command;
  return invokeTauri<HeadlessResponse>(commandName, payload);
}
