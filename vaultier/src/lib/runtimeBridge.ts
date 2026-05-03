import type { CrashSafeWriteStep, DriveProbeIssue, DriveRecord, HeadlessCommand, HeadlessResponse, RuntimePlatform, RuntimeProfile, RuntimeShell, VaultierErrorCode } from './types';
import { scanForSecretFields } from './redaction';

type BridgeDrive = DriveRecord & { platform: RuntimePlatform };

type TauriBridgeApi = {
  backup_bridge_status: () => Promise<{
    contractVersion: string;
    cliContractVersion: string;
    executionMode: 'in_process' | 'shell_fallback';
    productionReady: boolean;
    blockers: string[];
  }>;
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

type TauriBridgeWrappedResponse = {
  contract_version: string;
  status: 'ok' | 'error';
  error_id?: string | null;
  details?: {
    wallet_cli?: HeadlessResponse;
  };
};
const TAURI_BRIDGE_CONTRACT_VERSION = 'citizen.wallet.backup.desktop.v1alpha1';

const hasTauriRuntime = () => typeof window !== 'undefined' && '__TAURI__' in window;

const SECRET_KEY_MARKERS = ['passphrase', 'password', 'secret', 'seed', 'mnemonic', 'privatekey', 'private_key'];
const SECRET_VALUE_MARKERS = ['passphrase=', 'password=', 'secret=', 'seed=', 'mnemonic=', 'private-key=', 'private_key='];
const RUNTIME_PROFILE_KEY = 'vaultier.runtime.profile';
let tauriCommandQueue: Promise<void> = Promise.resolve();


const VAULTIER_ERROR_CODES: ReadonlySet<VaultierErrorCode> = new Set([
  'path_invalid',
  'mount_unwritable',
  'insufficient_space',
  'filesystem_incompatible',
  'critical_entropy_too_low',
  'manifest_signature_missing',
  'manifest_signature_invalid',
  'header_auth_failed',
  'slot_table_tampered',
  'rollback_counter_mismatch',
  'decrypt_failed',
  'slot_not_found',
  'checksum_mismatch',
  'invalid_payload',
]);

function normalizeErrorCode(errorId: string | null | undefined): VaultierErrorCode {
  if (errorId && VAULTIER_ERROR_CODES.has(errorId as VaultierErrorCode)) {
    return errorId as VaultierErrorCode;
  }
  return 'invalid_payload';
}

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
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    return SECRET_VALUE_MARKERS.some((marker) => lowered.includes(marker)) ? '[REDACTED]' : value;
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

function normalizeBackupResponse(commandName: HeadlessCommand['command'], response: HeadlessResponse | TauriBridgeWrappedResponse): HeadlessResponse {
  if ('schemaVersion' in response && 'contractVersion' in response && 'ok' in response) {
    return response;
  }

  const wrapped = response as TauriBridgeWrappedResponse;
  if (wrapped.contract_version !== TAURI_BRIDGE_CONTRACT_VERSION) {
    return {
      schemaVersion: 'v1alpha1',
      contractVersion: '2026-05-01',
      ok: false,
      command: commandName,
      error: {
        code: 'invalid_payload',
        message: `unexpected tauri bridge contract version: ${wrapped.contract_version}`,
      },
      result: {
        error_id: 'invalid_payload',
        message: 'Tauri runtime bridge contract_version mismatch.',
      },
    };
  }
  if (wrapped.status === 'ok' && wrapped.details?.wallet_cli) {
    return wrapped.details.wallet_cli;
  }

  return {
    schemaVersion: 'v1alpha1',
    contractVersion: '2026-05-01',
    ok: false,
    command: commandName,
    error: {
      code: normalizeErrorCode(wrapped.error_id),
      message: wrapped.error_id ?? 'wallet_cli_error',
    },
    result: {
      error_id: wrapped.error_id ?? 'wallet_cli_error',
      message: 'Tauri runtime command failed before CLI contract payload could be returned.',
    },
  };
}

export function detectRuntimeShell(): RuntimeShell {
  const profile = resolveRuntimeProfile();
  if (profile === 'tauri-runtime' && hasTauriRuntime()) return 'tauri';
  return 'web-mock';
}

export async function fetchBridgeStatusViaTauri(): Promise<{
  executionMode: 'in_process' | 'shell_fallback';
  productionReady: boolean;
  blockers: string[];
} | null> {
  if (!hasTauriRuntime()) return null;
  try {
    const response = await invokeTauri<{
      executionMode: 'in_process' | 'shell_fallback';
      productionReady: boolean;
      blockers: string[];
    }>('backup_bridge_status');
    return response;
  } catch {
    return null;
  }
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
  return enqueueTauriCommand(async () => invokeBackupCommandViaTauriImmediate(command));
}

function enqueueTauriCommand<T>(operation: () => Promise<T>): Promise<T> {
  const result = tauriCommandQueue.then(operation, operation);
  tauriCommandQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function invokeBackupCommandViaTauriImmediate(command: HeadlessCommand): Promise<HeadlessResponse> {
  const { command: commandName, ...payload } = command;
  const sanitizedPayload = sanitizePayload(payload);

  try {
    const raw = await invokeTauri<HeadlessResponse | TauriBridgeWrappedResponse>(commandName, payload);
    const response = normalizeBackupResponse(commandName, raw);
    const redaction = scanForSecretFields(response.result);
    if (!redaction.ok) {
      throw new Error(`tauri_response_redaction_blocked:${redaction.redactedFields.join(',')}`);
    }
    return response;
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
