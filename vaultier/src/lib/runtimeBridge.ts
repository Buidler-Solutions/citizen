import type { CrashSafeWriteStep, DriveProbeIssue, DriveRecord, HeadlessCommand, HeadlessResponse, RuntimePlatform, RuntimeProfile, RuntimeShell } from './types';

type BridgeDrive = DriveRecord & { platform: RuntimePlatform };

type TauriBridgeApi = {
  discover_removable_drives: () => Promise<{ drives: BridgeDrive[] }>;
  flush_vault_writes: (payload: { targetPath: string }) => Promise<{ strategy: CrashSafeWriteStep[] }>;
  safe_eject_media: (payload: { targetPath: string }) => Promise<{ ok: boolean }>;
  backup_init: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_init' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_add_slot: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_add_slot' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_export_credentials: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_export_credentials' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_verify: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_verify' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_restore: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_restore' }>, 'command'>) => Promise<HeadlessResponse>;
  backup_diagnostics: (payload: Omit<Extract<HeadlessCommand, { command: 'backup_diagnostics' }>, 'command'>) => Promise<HeadlessResponse>;
};

const hasTauriRuntime = () => typeof window !== 'undefined' && '__TAURI__' in window;

const SECRET_KEY_MARKERS = ['passphrase', 'password', 'secret', 'seed', 'mnemonic', 'privatekey', 'private_key'];
const RUNTIME_PROFILE_KEY = 'vaultier.runtime.profile';

function resolveRuntimeProfile(): RuntimeProfile {
  if (typeof window === 'undefined') return 'wb-simulation';
  const query = new URLSearchParams(window.location.search).get('runtime_profile');
  if (query === 'tauri-runtime' || query === 'wb-simulation') return query;

  const stored = window.localStorage.getItem(RUNTIME_PROFILE_KEY);
  if (stored === 'tauri-runtime' || stored === 'wb-simulation') return stored;

  return 'wb-simulation';
}

export function getRuntimeProfile(): RuntimeProfile {
  return resolveRuntimeProfile();
}

export function setRuntimeProfile(profile: RuntimeProfile): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(RUNTIME_PROFILE_KEY, profile);
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      const lowered = key.toLowerCase();
      const isSecret = SECRET_KEY_MARKERS.some((marker) => lowered.includes(marker));
      return [key, isSecret ? '[REDACTED]' : sanitizePayload(nested)];
    }),
  );
}

export function sanitizeTauriPayloadForLogs(payload: unknown): unknown {
  return sanitizePayload(payload);
}

async function invokeTauri<T>(command: keyof TauriBridgeApi, payload?: unknown): Promise<T> {
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: <R>(name: string, args?: unknown) => Promise<R> } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    throw new Error('tauri_invoke_unavailable');
  }
  return invoke<T>(command, payload);
}

export function detectRuntimeShell(): RuntimeShell {
  const profile = resolveRuntimeProfile();
  if (profile === 'tauri-runtime' && hasTauriRuntime()) return 'tauri';
  return 'web-mock';
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
  const sanitizedPayload = sanitizePayload(payload);

  try {
    return await invokeTauri<HeadlessResponse>(commandName, payload);
  } catch (error) {
    const details = JSON.stringify(sanitizedPayload);
    const wrapped = new Error(`tauri_${commandName}_failed:${details}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

export async function safeEjectViaTauri(targetPath: string): Promise<{ ok: boolean; bridgeIssue?: DriveProbeIssue }> {
  try {
    const response = await invokeTauri<{ ok: boolean }>('safe_eject_media', { targetPath });
    return { ok: response.ok };
  } catch {
    return {
      ok: false,
      bridgeIssue: {
        mountPath: targetPath,
        code: 'media_unavailable',
        detail: 'Tauri safe-eject bridge unavailable; manual OS eject is still required.',
      },
    };
  }
}
