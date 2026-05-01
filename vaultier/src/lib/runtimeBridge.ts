import type { CrashSafeWriteStep, DriveProbeIssue, DriveRecord, RuntimePlatform, RuntimeShell } from './types';

type BridgeDrive = DriveRecord & { platform: RuntimePlatform };

type TauriBridgeApi = {
  discover_removable_drives: () => Promise<{ drives: BridgeDrive[] }>;
  flush_vault_writes: (payload: { targetPath: string }) => Promise<{ strategy: CrashSafeWriteStep[] }>;
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
