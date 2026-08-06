import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { chacha20Poly1305Decrypt } from './chacha20poly1305';
import { normalizePassphrase, validateDistinctPassphrases } from './backupPassphrasePolicy';
import {
  DAPP_SIGNING_METHOD,
  type DappSigningRequestEnvelope,
  createDappSigningRequestEnvelope,
  signingScopePayloadV2FromEnvelope,
  signingPreimageFromEnvelope,
  protocolSigningPreimageFromEnvelope,
} from './dappSigningRequest';
import {
  pruneRetainedRequests,
  sanitizeRequestForStorage,
  type DappRequestState,
  type PendingDappSigningRequest,
} from './dappRequestIsolation';
import { canAcceptDappSigningRequest } from './dappRequestQueue';
import { buildApprovalMetricsSnapshot, type DappRequestAuditEvent } from './dappApprovalMetrics';
import {
  decryptJsonValue,
  encryptJsonValue,
  importAesKey,
  isEncryptedJsonEnvelope,
} from './sensitiveStorage';
import {
  submitEnvelopesToCitizenNetworkBatch,
  submitSignedArtifact,
  type DirectSubmitResponse,
  type SignedEnvelope,
  type SignedSubmissionArtifact,
} from './directSubmitClient';
import { canonicalJson } from './canonical';
import { encryptKycDataHybrid, decryptKycAsHolderHybrid } from './kycCrypto';

type WalletRequest = {
  method: string;
  params?: unknown[];
  origin?: string;
};

type DappLoginParams = {
  domain?: string;
  uri?: string;
  statement?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  chainId?: string;
};

type TypedDataPayload = {
  domain?: Record<string, unknown>;
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

type WalletResponse =
  | {
      ok: true;
      result: unknown;
    }
  | {
      ok: false;
      error: string;
    };

type HybridDecryptInput = {
  authorPublicKeyHex: string;
  ciphertextHex: string;
  nonceHex: string;
  wrappedDekHex: string;
};


type WalletSigner = {
  address: string;
  privateKey: string;
  signMessage: (message: string) => Promise<string>;
  signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
};

type StoredWallet = {
  id: string;
  name: string;
  createdAt: string;
  privateKey: string;
  mnemonicPhrase?: string;
  derivationPath?: string;
};

type ActivityEntry = {
  requestedAt: string;
  origin: string;
  method: string;
  params: unknown[];
  account: string;
};

type PendingDappResolution = {
  resolve: (response: WalletResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type DappOriginPermission = 'prompt' | 'blocked';

type DappOriginPermissionEntry = {
  origin: string;
  permission: DappOriginPermission;
  updatedAt: string;
};

const STORAGE_KEY = 'citizen.browser.wallet.v1';
const LAST_REQUEST_KEY = 'citizen.browser.wallet.last_request.v1';
const ACTIVITY_KEY = 'citizen.browser.wallet.activity.v1';
const VAULT_KEY = 'citizen.browser.wallet.vault.v1';
const ACTIVE_WALLET_ID_KEY = 'citizen.browser.wallet.active_wallet_id.v1';
const PASSWORD_HASH_KEY = 'citizen.browser.wallet.password_hash.v1';
const SESSION_UNLOCKED_KEY = 'citizen.browser.wallet.unlocked.v1';
const NETWORK_KEY = 'citizen.browser.wallet.network.v1';
const DAPP_PENDING_REQUESTS_KEY = 'citizen.browser.wallet.dapp_pending_requests.v1';
const DAPP_REQUEST_AUDIT_KEY = 'citizen.browser.wallet.dapp_request_audit.v1';
const DAPP_ORIGIN_PERMISSIONS_KEY = 'citizen.browser.wallet.dapp_origin_permissions.v1';
const LOCAL_ENCRYPTION_KEY_KEY = 'citizen.browser.wallet.local_encryption_key.v1';
const DIRECT_SUBMIT_RECEIPTS_KEY = 'citizen.browser.wallet.direct_submit_receipts.v1';
const DIRECT_SUBMIT_DEFAULT_DESTINATION_KEY = 'citizen.browser.wallet.direct_submit_default_destination.v1';
const BACKUP_POSTURE_KEY = 'citizen.browser.wallet.backup_posture.v1';
const DEFAULT_DERIVATION_PATH = "m/44'/930'/0'/0'/0'";
const SUPPORTED_MNEMONIC_WORD_COUNTS = [12, 24] as const;
type SupportedMnemonicWordCount = (typeof SUPPORTED_MNEMONIC_WORD_COUNTS)[number];

function getMnemonicWordCount(mnemonicPhrase?: string): SupportedMnemonicWordCount | null {
  if (!mnemonicPhrase) {
    return null;
  }
  const words = mnemonicPhrase.trim().split(/\s+/).filter(Boolean).length;
  return SUPPORTED_MNEMONIC_WORD_COUNTS.includes(words as SupportedMnemonicWordCount)
    ? (words as SupportedMnemonicWordCount)
    : null;
}
const MAX_ACTIVITY = 100;
const MAX_ACTIVITY_PARAMS = 8;
const MAX_ACTIVITY_PARAM_STRING_LENGTH = 512;
const MAX_ACTIVITY_PARAM_DEPTH = 3;
const MAX_DAPP_AUDIT_EVENTS = 1_000;
const DAPP_DECIDED_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const DAPP_REQUEST_CONCURRENCY_MODE = 'single_active';
const MAX_DIRECT_SUBMIT_RECEIPTS = 100;
const STRICT_PROTOCOL_MODE = true;
const DIRECT_SUBMIT_ALLOWLIST: readonly string[] = [
  'https://mainnet.ctzn.space/api/v1/direct-submit',
  'https://futurenet.ctzn.space/api/v1/direct-submit',
  'https://testnet.ctzn.space/api/v1/direct-submit',
  'http://localhost:8091/api/v1/direct-submit',
];
const CITIZEN_API_BASE_ALLOWLIST: readonly string[] = [
  'https://mainnet.ctzn.space',
  'https://futurenet.ctzn.space',
  'https://testnet.ctzn.space',
  'http://localhost:8091',
];

type DirectSubmitReceipt = {
  requestId: string;
  payloadHash: string | null;
  walletId: string;
  signerDid: string;
  networkId: NetworkId;
  destinationUrl: string;
  traceId: string;
  status: number;
  latencyMs: number;
  receiptId: string | null;
  receiptHash: string | null;
  blockHeight: number | null;
  entryId: string | null;
  submittedAt: string;
};

const pendingDappResolutions = new Map<string, PendingDappResolution>();

const NETWORKS = {
  mainnet: {
    id: 'mainnet',
    chainIdHex: '0xc17',
    label: 'Mainnet',
  },
  futurenet: {
    id: 'futurenet',
    chainIdHex: '0xc18',
    label: 'Futurenet',
  },
  testnet: {
    id: 'testnet',
    chainIdHex: '0xc19',
    label: 'Testnet',
  },
  localnode: {
    id: 'localnode',
    chainIdHex: '0x539',
    label: 'Local Node',
  },
} as const;

type NetworkId = keyof typeof NETWORKS;
const NETWORK_HEALTHCHECK_URL_BY_NETWORK: Record<NetworkId, string> = {
  mainnet: 'https://mainnet.ctzn.space/health',
  futurenet: 'https://futurenet.ctzn.space/health',
  testnet: 'https://testnet.ctzn.space/health',
  localnode: 'http://localhost:8091/health',
};

type StoredProtocolSigner = {
  keyId: string;
  did: string;
  verifyingKeyHex: string;
  spkiBase64: string;
  pkcs8Base64: string;
  createdAt: string;
};

type StoredEncryptionReaderKey = {
  walletId: string;
  did: string;
  publicKeyHex: string;
  spkiBase64: string;
  pkcs8Base64: string;
  createdAt: string;
};

type BackupPosture = {
  lastVerifiedAt: string | null;
  reminderIntervalDays: number;
};

type BackupSlotRole = 'decoy' | 'critical';
type BackupVaultSlot = {
  role: BackupSlotRole;
  passphraseHint: string | null;
  createdAt: string;
  updatedAt: string;
};
type BackupVaultState = {
  version: 1;
  slots: BackupVaultSlot[];
};

async function getBackupPosture(): Promise<BackupPosture> {
  const stored = await chrome.storage.local.get(BACKUP_POSTURE_KEY);
  const posture = stored[BACKUP_POSTURE_KEY] as Partial<BackupPosture> | undefined;
  return {
    lastVerifiedAt: typeof posture?.lastVerifiedAt === 'string' ? posture.lastVerifiedAt : null,
    reminderIntervalDays:
      typeof posture?.reminderIntervalDays === 'number' && posture.reminderIntervalDays > 0
        ? posture.reminderIntervalDays
        : 30,
  };
}

async function markBackupVerifiedNow(): Promise<BackupPosture> {
  const current = await getBackupPosture();
  const next: BackupPosture = {
    ...current,
    lastVerifiedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [BACKUP_POSTURE_KEY]: next });
  return next;
}

const BACKUP_VAULT_STATE_KEY = 'citizen.browser.wallet.backup_vault_state.v1';
const BACKUP_KDF_ITERATIONS = 210_000;

function normalizeBackupRole(value: unknown): BackupSlotRole | null {
  return value === 'decoy' || value === 'critical' ? value : null;
}

function requirePassphrase(value: unknown): string | null {
  return normalizePassphrase(value);
}

async function deriveBackupAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: BACKUP_KDF_ITERATIONS, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBackupPayload(passphrase: string, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBackupAesKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))),
  );
  const envelope = { version: 1, algorithm: 'aes-256-gcm', kdf: { name: 'pbkdf2-sha256', iterations: BACKUP_KDF_ITERATIONS }, salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(ciphertext) };
  return btoa(JSON.stringify(envelope));
}

async function decryptBackupPayload(passphrase: string, encoded: string): Promise<unknown> {
  const json = JSON.parse(atob(encoded)) as { salt?: string; iv?: string; ciphertext?: string };
  if (typeof json.salt !== 'string' || typeof json.iv !== 'string' || typeof json.ciphertext !== 'string') {
    throw new Error('Malformed encrypted backup envelope.');
  }
  const key = await deriveBackupAesKey(passphrase, fromHex(json.salt));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(json.iv) }, key, fromHex(json.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function getBackupVaultState(): Promise<BackupVaultState> {
  const stored = await chrome.storage.local.get(BACKUP_VAULT_STATE_KEY);
  const state = stored[BACKUP_VAULT_STATE_KEY] as BackupVaultState | undefined;
  if (!state || !Array.isArray(state.slots)) return { version: 1, slots: [] };
  return state;
}

function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && value in NETWORKS;
}

function getNetworkIdFromChainIdHex(value: unknown): NetworkId | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase();
  return (
    (Object.keys(NETWORKS) as NetworkId[]).find(
      (networkId) => NETWORKS[networkId].chainIdHex.toLowerCase() === normalized,
    ) ?? null
  );
}

async function getSelectedNetwork(): Promise<NetworkId> {
  const stored = await chrome.storage.local.get(NETWORK_KEY);
  const network = stored[NETWORK_KEY];
  if (isNetworkId(network)) {
    return network;
  }
  return 'mainnet';
}

async function setSelectedNetwork(network: NetworkId): Promise<void> {
  await chrome.storage.local.set({ [NETWORK_KEY]: network });
}

async function isSelectedNetworkAlive(networkId: NetworkId): Promise<boolean> {
  const healthUrl = NETWORK_HEALTHCHECK_URL_BY_NETWORK[networkId];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getNetworkLivenessByNetwork(): Promise<Record<NetworkId, boolean>> {
  const livenessEntries = await Promise.all(
    (Object.keys(NETWORKS) as NetworkId[]).map(async (networkId) => [networkId, await isSelectedNetworkAlive(networkId)] as const),
  );
  return Object.fromEntries(livenessEntries) as Record<NetworkId, boolean>;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function walletError(code: string, message: string): WalletResponse {
  return { ok: false, error: `${code}: ${message}` };
}

function isExtensionUiMessage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const walletUiUrl = new URL(chrome.runtime.getURL('index.html'));
    return senderUrl.origin === walletUiUrl.origin && senderUrl.pathname === walletUiUrl.pathname;
  } catch {
    return false;
  }
}


async function getLocalEncryptionKey(): Promise<CryptoKey> {
  const stored = await chrome.storage.local.get(LOCAL_ENCRYPTION_KEY_KEY);
  const rawKeyBase64 = stored[LOCAL_ENCRYPTION_KEY_KEY];
  if (typeof rawKeyBase64 === 'string' && rawKeyBase64.length > 0) {
    try {
      const bytes = base64ToBytes(rawKeyBase64);
      if (bytes.length === 32) {
        return importAesKey(bytes);
      }
    } catch {
      // rotate malformed key material below
    }
  }

  const generated = crypto.getRandomValues(new Uint8Array(32));
  await chrome.storage.local.set({ [LOCAL_ENCRYPTION_KEY_KEY]: bytesToBase64(generated) });
  return importAesKey(generated);
}

async function getEncryptedArrayFromStorage<T>(key: string): Promise<T[]> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (!isEncryptedJsonEnvelope(value)) {
    return [];
  }
  const encryptionKey = await getLocalEncryptionKey();
  const decrypted = await decryptJsonValue<T[]>(value, encryptionKey);
  return Array.isArray(decrypted) ? decrypted : [];
}

async function setEncryptedArrayInStorage<T>(key: string, value: T[]): Promise<void> {
  const encryptionKey = await getLocalEncryptionKey();
  const encrypted = await encryptJsonValue(value, encryptionKey);
  await chrome.storage.local.set({ [key]: encrypted });
}

async function getDirectSubmitReceipts(): Promise<DirectSubmitReceipt[]> {
  return getEncryptedArrayFromStorage<DirectSubmitReceipt>(DIRECT_SUBMIT_RECEIPTS_KEY);
}

async function appendDirectSubmitReceipt(receipt: DirectSubmitReceipt): Promise<void> {
  const existing = await getDirectSubmitReceipts();
  await setEncryptedArrayInStorage(
    DIRECT_SUBMIT_RECEIPTS_KEY,
    [receipt, ...existing].slice(0, MAX_DIRECT_SUBMIT_RECEIPTS),
  );
}

async function confirmSubmittedRequestFromBuilderApp(
  requestId: string,
  receiptHash: string,
  origin: string | undefined,
): Promise<WalletResponse> {
  if (!requestId.trim()) {
    return walletError('ERR_MALFORMED_REQUEST', 'requestId is required for submission confirmation.');
  }
  if (!/^sha256:[a-f0-9]{64}$/iu.test(receiptHash.trim())) {
    return walletError('ERR_MALFORMED_REQUEST', 'receiptHash must be sha256:<64-hex>.');
  }
  const requests = await getPendingDappRequests();
  const entry = requests.find((candidate) => candidate.requestId === requestId);
  if (!entry) {
    return walletError('ERR_REQUEST_NOT_FOUND', 'Cannot confirm unknown signed request.');
  }
  if (entry.state !== 'signed') {
    return walletError('ERR_REQUEST_NOT_SIGNED', 'Only signed requests can be marked as submitted.');
  }
  if (origin && entry.envelope.origin !== origin) {
    return walletError('ERR_ORIGIN_MISMATCH', 'Submission confirmation origin does not match signer origin.');
  }

  await appendDirectSubmitReceipt({
    requestId: entry.requestId,
    payloadHash: entry.envelope.payloadHash,
    walletId: entry.walletId,
    signerDid: entry.signerDid,
    networkId: entry.networkId,
    destinationUrl: origin ?? 'unknown',
    traceId: `builder-confirmation:${entry.requestId}`,
    status: 200,
    latencyMs: 0,
    receiptId: null,
    receiptHash: receiptHash.trim(),
    blockHeight: null,
    entryId: null,
    submittedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    result: {
      requestId: entry.requestId,
      receiptHash: receiptHash.trim(),
      source: 'builder_app_confirmation',
    },
  };
}

async function getDirectSubmitDefaultDestination(): Promise<string> {
  const stored = await chrome.storage.local.get(DIRECT_SUBMIT_DEFAULT_DESTINATION_KEY);
  const value = stored[DIRECT_SUBMIT_DEFAULT_DESTINATION_KEY];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return DIRECT_SUBMIT_ALLOWLIST[0];
}

async function setDirectSubmitDefaultDestination(destinationUrl: string): Promise<void> {
  await chrome.storage.local.set({ [DIRECT_SUBMIT_DEFAULT_DESTINATION_KEY]: destinationUrl });
}

async function getPasswordHash(): Promise<string | null> {
  const stored = await chrome.storage.local.get(PASSWORD_HASH_KEY);
  const value = stored[PASSWORD_HASH_KEY];
  return typeof value === 'string' ? value : null;
}

async function isUnlocked(): Promise<boolean> {
  const stored = await chrome.storage.session.get(SESSION_UNLOCKED_KEY);
  return stored[SESSION_UNLOCKED_KEY] === true;
}

async function markUnlocked() {
  await chrome.storage.session.set({ [SESSION_UNLOCKED_KEY]: true });
}

async function markLocked() {
  await chrome.storage.session.set({ [SESSION_UNLOCKED_KEY]: false });
}

async function isWalletLocked(): Promise<boolean> {
  const hash = await getPasswordHash();
  if (!hash) {
    return false;
  }
  return !(await isUnlocked());
}

async function setWalletPassword(password: string): Promise<WalletResponse> {
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }

  const hash = await sha256Hex(password);
  await chrome.storage.local.set({ [PASSWORD_HASH_KEY]: hash });
  await markUnlocked();
  return { ok: true, result: true };
}

async function unlockWallet(password: string): Promise<WalletResponse> {
  const storedHash = await getPasswordHash();
  if (!storedHash) {
    return { ok: false, error: 'No password configured. Set one first.' };
  }

  const inputHash = await sha256Hex(password);
  if (inputHash !== storedHash) {
    await markLocked();
    return { ok: false, error: 'Invalid password.' };
  }

  await markUnlocked();
  return { ok: true, result: true };
}

async function lockWallet(): Promise<WalletResponse> {
  await markLocked();
  return { ok: true, result: true };
}

async function getPendingDappRequests(): Promise<PendingDappSigningRequest[]> {
  return getEncryptedArrayFromStorage<PendingDappSigningRequest>(DAPP_PENDING_REQUESTS_KEY);
}

async function savePendingDappRequests(requests: PendingDappSigningRequest[]): Promise<void> {
  await setEncryptedArrayInStorage(DAPP_PENDING_REQUESTS_KEY, requests);
}

async function cleanupRetainedDappRequests(): Promise<void> {
  const requests = await getPendingDappRequests();
  if (requests.length === 0) {
    return;
  }
  const next = pruneRetainedRequests(requests, Date.now(), DAPP_DECIDED_REQUEST_RETENTION_MS);
  if (next.length !== requests.length) {
    await savePendingDappRequests(next);
  }
}

async function getDappOriginPermissions(): Promise<DappOriginPermissionEntry[]> {
  const stored = await chrome.storage.local.get(DAPP_ORIGIN_PERMISSIONS_KEY);
  const list = stored[DAPP_ORIGIN_PERMISSIONS_KEY];
  return Array.isArray(list) ? (list as DappOriginPermissionEntry[]) : [];
}

async function setDappOriginPermission(
  origin: string,
  permission: DappOriginPermission,
): Promise<DappOriginPermissionEntry[]> {
  const normalizedOrigin = origin.trim();
  if (normalizedOrigin.length === 0) {
    return getDappOriginPermissions();
  }
  const existing = await getDappOriginPermissions();
  const nextEntry: DappOriginPermissionEntry = {
    origin: normalizedOrigin,
    permission,
    updatedAt: new Date().toISOString(),
  };
  const filtered = existing.filter((entry) => entry.origin !== normalizedOrigin);
  const next = [nextEntry, ...filtered].slice(0, 500);
  await chrome.storage.local.set({ [DAPP_ORIGIN_PERMISSIONS_KEY]: next });
  return next;
}

async function removeDappOriginPermission(origin: string): Promise<DappOriginPermissionEntry[]> {
  const normalizedOrigin = origin.trim();
  const existing = await getDappOriginPermissions();
  const next = existing.filter((entry) => entry.origin !== normalizedOrigin);
  await chrome.storage.local.set({ [DAPP_ORIGIN_PERMISSIONS_KEY]: next });
  return next;
}

async function getOriginPermission(origin: string | undefined): Promise<DappOriginPermission> {
  if (!origin) {
    return 'prompt';
  }
  const existing = await getDappOriginPermissions();
  const match = existing.find((entry) => entry.origin === origin);
  return match?.permission ?? 'prompt';
}

async function appendDappAuditEvent(event: Omit<DappRequestAuditEvent, 'eventId' | 'occurredAt'>): Promise<void> {
  const existing = await getEncryptedArrayFromStorage<DappRequestAuditEvent>(DAPP_REQUEST_AUDIT_KEY);
  const next: DappRequestAuditEvent = {
    ...event,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
  };
  await setEncryptedArrayInStorage(
    DAPP_REQUEST_AUDIT_KEY,
    [next, ...existing].slice(0, MAX_DAPP_AUDIT_EVENTS),
  );
}

async function getDappApprovalMetricsSnapshot() {
  const events = await getEncryptedArrayFromStorage<DappRequestAuditEvent>(DAPP_REQUEST_AUDIT_KEY);
  return buildApprovalMetricsSnapshot(events);
}

async function transitionDappRequestState(
  requestId: string,
  toState: DappRequestState,
  reason: string,
): Promise<PendingDappSigningRequest | null> {
  const requests = await getPendingDappRequests();
  const now = new Date().toISOString();
  const next = requests.map((entry) => {
    if (entry.requestId !== requestId) {
      return entry;
    }
    const transitioned = {
      ...entry,
      state: toState,
      updatedAt: now,
      decidedAt: toState === 'approved' || toState === 'rejected' || toState === 'expired' || toState === 'signed'
        ? now
        : entry.decidedAt,
    };
    return sanitizeRequestForStorage(transitioned, toState);
  });
  await savePendingDappRequests(next);
  const updated = next.find((entry) => entry.requestId === requestId) ?? null;
  if (updated) {
    await appendDappAuditEvent({ requestId, state: toState, reason });
  }
  return updated;
}

async function expireStaleDappRequests(): Promise<void> {
  const requests = await getPendingDappRequests();
  if (requests.length === 0) {
    return;
  }
  const now = Date.now();
  const stale = requests.filter(
    (entry) => entry.state === 'pending' && new Date(entry.envelope.expiresAt).getTime() <= now,
  );
  for (const entry of stale) {
    const updated = await transitionDappRequestState(entry.requestId, 'expired', 'request_expired');
    const resolution = pendingDappResolutions.get(entry.requestId);
    if (resolution) {
      clearTimeout(resolution.timeoutId);
      pendingDappResolutions.delete(entry.requestId);
      resolution.resolve(walletError('ERR_REQUEST_EXPIRED', 'The signing request expired before approval.'));
    }
    if (!updated) {
      continue;
    }
  }
}

function createWalletId() {
  return `wallet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toStoredWallet(wallet: WalletSigner, mnemonicPhrase?: string, derivationPath?: string): StoredWallet {
  return {
    id: createWalletId(),
    name: `Wallet seed-backed`,
    createdAt: new Date().toISOString(),
    privateKey: wallet.privateKey,
    mnemonicPhrase,
    derivationPath,
  };
}

async function getWalletVault(): Promise<StoredWallet[]> {
  const existing = await chrome.storage.local.get(VAULT_KEY);
  const stored = existing[VAULT_KEY];
  return Array.isArray(stored) ? (stored as StoredWallet[]) : [];
}

async function saveWalletVault(vault: StoredWallet[], activeWalletId?: string): Promise<void> {
  const nextActiveId = activeWalletId ?? vault[0]?.id ?? null;
  await chrome.storage.local.set({
    [VAULT_KEY]: vault,
    [ACTIVE_WALLET_ID_KEY]: nextActiveId,
    [STORAGE_KEY]: vault.find((wallet) => wallet.id === nextActiveId) ?? vault[0] ?? null,
  });
}

async function ensureVaultInitialized(): Promise<StoredWallet[]> {
  const vault = await getWalletVault();
  if (vault.length > 0) {
    return vault;
  }

  const existing = await chrome.storage.local.get(STORAGE_KEY);
  const legacy = existing[STORAGE_KEY] as Partial<StoredWallet> | undefined;
  if (legacy?.privateKey) {
    const migrated: StoredWallet = {
      id: createWalletId(),
      name: `Wallet ${legacy.privateKey.slice(2, 8)}…`,
      createdAt: new Date().toISOString(),
      privateKey: legacy.privateKey,
      mnemonicPhrase: legacy.mnemonicPhrase,
      derivationPath: legacy.derivationPath,
    };
    await saveWalletVault([migrated], migrated.id);
    return [migrated];
  }

  return [];
}

async function getActiveWalletRecord(): Promise<StoredWallet | null> {
  const vault = await ensureVaultInitialized();
  if (vault.length === 0) {
    return null;
  }
  const stored = await chrome.storage.local.get(ACTIVE_WALLET_ID_KEY);
  const activeId = stored[ACTIVE_WALLET_ID_KEY];
  const active = typeof activeId === 'string' ? vault.find((wallet) => wallet.id === activeId) : null;
  return active ?? vault[0];
}

async function getWalletRecordById(walletId: string): Promise<StoredWallet | null> {
  const vault = await ensureVaultInitialized();
  return vault.find((wallet) => wallet.id === walletId) ?? null;
}

async function getActiveWalletId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(ACTIVE_WALLET_ID_KEY);
  const activeId = stored[ACTIVE_WALLET_ID_KEY];
  return typeof activeId === 'string' ? activeId : null;
}

async function getStoredWallet(): Promise<WalletSigner> {
  const active = await getActiveWalletRecord();
  if (!active) {
    const created = Wallet.createRandom();
    const mnemonicPhrase = created.mnemonic?.phrase;
    const derived = mnemonicPhrase
      ? HDNodeWallet.fromPhrase(mnemonicPhrase, undefined, DEFAULT_DERIVATION_PATH)
      : created;
    const firstWallet = toStoredWallet(derived, mnemonicPhrase, DEFAULT_DERIVATION_PATH);
    await saveWalletVault([firstWallet], firstWallet.id);
    return derived;
  }

  if (active.mnemonicPhrase) {
    const derived = HDNodeWallet.fromPhrase(
      active.mnemonicPhrase,
      undefined,
      active.derivationPath ?? DEFAULT_DERIVATION_PATH,
    );
    return derived;
  }

  return new Wallet(active.privateKey);
}

async function hasStoredWallet(): Promise<boolean> {
  return (await ensureVaultInitialized()).length > 0;
}

function shouldPromptWalletUi(method: string): boolean {
  if (STRICT_PROTOCOL_MODE) {
    return [
      'ctzn_signCitizenTx',
      'ctzn_signAuthChallenge',
      'ctzn_getCitizenSigner',
      'ctzn_getEncryptionPublicKey',
      'ctzn_getCitizenKeyMaterial',
    ].includes(method);
  }
  return ['ctzn_signCitizenTx'].includes(method);
}

async function openWalletSidePanel(sender: chrome.runtime.MessageSender): Promise<void> {
  if (!chrome.sidePanel || sender.tab?.id === undefined) {
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId: sender.tab.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to open wallet side panel for dapp request: ${message}`);
  }
}

async function recordRequest(request: WalletRequest, account: string) {
  const nextEntry: ActivityEntry = {
    requestedAt: new Date().toISOString(),
    origin: request.origin ?? 'unknown',
    method: request.method,
    params: sanitizeActivityParams(request.params ?? []),
    account,
  };
  const existing = await chrome.storage.local.get(ACTIVITY_KEY);
  const list = Array.isArray(existing[ACTIVITY_KEY]) ? (existing[ACTIVITY_KEY] as ActivityEntry[]) : [];
  const trimmed = [nextEntry, ...list].slice(0, MAX_ACTIVITY);
  await chrome.storage.local.set({
    [LAST_REQUEST_KEY]: nextEntry,
    [ACTIVITY_KEY]: trimmed,
  });
}

function truncateActivityString(value: string): string {
  if (value.length <= MAX_ACTIVITY_PARAM_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_ACTIVITY_PARAM_STRING_LENGTH)}…[truncated ${value.length - MAX_ACTIVITY_PARAM_STRING_LENGTH} chars]`;
}

function sanitizeActivityParamValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_ACTIVITY_PARAM_DEPTH) {
    return '[truncated_depth]';
  }
  if (typeof value === 'string') {
    return truncateActivityString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ACTIVITY_PARAMS).map((item) => sanitizeActivityParamValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ACTIVITY_PARAMS);
    for (const [key, entryValue] of entries) {
      out[key] = sanitizeActivityParamValue(entryValue, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeActivityParams(params: unknown[]): unknown[] {
  return params.slice(0, MAX_ACTIVITY_PARAMS).map((entry) => sanitizeActivityParamValue(entry));
}

function randomNonce(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((value) => alphabet[value % alphabet.length])
    .join('');
}

function normalizeLoginPayload(origin: string, payload: DappLoginParams) {
  let fallbackDomain = origin;
  try {
    fallbackDomain = new URL(origin).host;
  } catch {
    // keep raw origin if URL parsing fails
  }
  const nonce = payload.nonce?.trim() || randomNonce();
  const issuedAt = payload.issuedAt?.trim() || new Date().toISOString();
  return {
    domain: payload.domain?.trim() || fallbackDomain,
    uri: payload.uri?.trim() || origin,
    chainId: payload.chainId?.trim() || NETWORKS.mainnet.chainIdHex,
    nonce,
    issuedAt,
    statement: payload.statement?.trim() || 'Sign in with Citizen Wallet',
    expirationTime: payload.expirationTime?.trim() || undefined,
  };
}

function buildLoginMessage(account: string, login: ReturnType<typeof normalizeLoginPayload>): string {
  const lines = [
    `${login.domain} wants you to sign in with your wallet:`,
    account,
    '',
    login.statement,
    '',
    `URI: ${login.uri}`,
    `Chain ID: ${login.chainId}`,
    `Nonce: ${login.nonce}`,
    `Issued At: ${login.issuedAt}`,
  ];

  if (login.expirationTime) {
    lines.push(`Expiration Time: ${login.expirationTime}`);
  }

  return lines.join('\n');
}

function parseTypedDataPayload(input: unknown): TypedDataPayload | null {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as TypedDataPayload;
    } catch {
      return null;
    }
  }

  if (typeof input === 'object' && input !== null) {
    return input as TypedDataPayload;
  }

  return null;
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    out[index] = raw.charCodeAt(index);
  }
  return out;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00,
  0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

const X25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x03, 0x21, 0x00,
]);

async function x25519DeriveBits(
  privateKeyBytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + privateKeyBytes.length);
  pkcs8.set(X25519_PKCS8_PREFIX, 0);
  pkcs8.set(privateKeyBytes, X25519_PKCS8_PREFIX.length);

  const spki = new Uint8Array(X25519_SPKI_PREFIX.length + publicKeyBytes.length);
  spki.set(X25519_SPKI_PREFIX, 0);
  spki.set(publicKeyBytes, X25519_SPKI_PREFIX.length);

  const privKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'],
  );
  const pubKey = await crypto.subtle.importKey(
    'spki', spki, { name: 'X25519' }, false, [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey }, privKey, 256,
  );
  return new Uint8Array(shared);
}

function fromHex(value: string): Uint8Array {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[a-f0-9]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Invalid hex input.');
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, (i * 2) + 2), 16);
  }
  return out;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(signature);
}

function parseHardenedDerivationPath(path: string): number[] {
  const trimmed = path.trim();
  if (!trimmed.startsWith('m')) {
    throw new Error('Derivation path must start with m.');
  }
  const parts = trimmed.split('/').slice(1).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  return parts.map((part) => {
    if (!part.endsWith('\'')) {
      throw new Error('Only hardened derivation path segments are supported.');
    }
    const index = Number.parseInt(part.slice(0, -1), 10);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Invalid hardened derivation index.');
    }
    return index;
  });
}

async function deriveEd25519SecretFromMnemonic(mnemonicPhrase: string, derivationPath: string): Promise<Uint8Array> {
  const seedHex = Mnemonic.fromPhrase(mnemonicPhrase).computeSeed();
  const seed = fromHex(seedHex);
  let i = await hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  let key = i.slice(0, 32);
  let chainCode = i.slice(32);
  const path = parseHardenedDerivationPath(derivationPath);
  for (const index of path) {
    const data = new Uint8Array(1 + key.length + 4);
    data[0] = 0x00;
    data.set(key, 1);
    const offset = 1 + key.length;
    data[offset] = (index >>> 24) & 0xff;
    data[offset + 1] = (index >>> 16) & 0xff;
    data[offset + 2] = (index >>> 8) & 0xff;
    data[offset + 3] = index & 0xff;
    i = await hmacSha512(chainCode, data);
    key = i.slice(0, 32);
    chainCode = i.slice(32);
  }
  return key;
}

async function resolveProtocolSecretForWallet(walletRecord: StoredWallet): Promise<Uint8Array> {
  if (walletRecord.mnemonicPhrase) {
    const derivationPath = walletRecord.derivationPath ?? DEFAULT_DERIVATION_PATH;
    return deriveEd25519SecretFromMnemonic(walletRecord.mnemonicPhrase, derivationPath);
  }
  return fromHex(walletRecord.privateKey);
}

async function getOrCreateProtocolSigner(walletRecord: StoredWallet): Promise<StoredProtocolSigner> {
  const edPkcs8Prefix = fromHex('302e020100300506032b657004220420');
  const secret = await resolveProtocolSecretForWallet(walletRecord);
  const pkcs8 = new Uint8Array(edPkcs8Prefix.length + secret.length);
  pkcs8.set(edPkcs8Prefix, 0);
  pkcs8.set(secret, edPkcs8Prefix.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (typeof jwk.x !== 'string') {
    throw new Error('Unable to derive Ed25519 verifying key.');
  }
  const verifyingKeyHex = toHex(base64UrlToBytes(jwk.x));
  const spki = fromHex(`302a300506032b6570032100${verifyingKeyHex}`);
  const signer: StoredProtocolSigner = {
    keyId: walletRecord.id,
    did: `did:key:ed25519:${verifyingKeyHex}`,
    verifyingKeyHex,
    spkiBase64: bytesToBase64(spki),
    pkcs8Base64: bytesToBase64(pkcs8),
    createdAt: new Date().toISOString(),
  };
  return signer;
}

async function getOrCreateEncryptionReaderKey(walletRecord: StoredWallet): Promise<StoredEncryptionReaderKey> {
  const xPkcs8Prefix = fromHex('302e020100300506032b656e04220420');
  const secret = await resolveProtocolSecretForWallet(walletRecord);
  const pkcs8 = new Uint8Array(xPkcs8Prefix.length + secret.length);
  pkcs8.set(xPkcs8Prefix, 0);
  pkcs8.set(secret, xPkcs8Prefix.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (typeof jwk.x !== 'string') {
    throw new Error('Unable to derive X25519 public key.');
  }
  const publicKeyHex = toHex(base64UrlToBytes(jwk.x));
  const spki = fromHex(`302a300506032b656e032100${publicKeyHex}`);
  const reader: StoredEncryptionReaderKey = {
    walletId: walletRecord.id,
    did: `did:key:x25519:${publicKeyHex}`,
    publicKeyHex,
    spkiBase64: bytesToBase64(spki),
    pkcs8Base64: bytesToBase64(pkcs8),
    createdAt: new Date().toISOString(),
  };
  return reader;
}

async function getProtocolWalletDisplayName(
  walletRecord: StoredWallet,
  prefix: 'Wallet' | 'Imported',
): Promise<string> {
  const signer = await getOrCreateProtocolSigner(walletRecord);
  const keySuffix = signer.verifyingKeyHex.slice(0, 8);
  return `${prefix} did:key:ed25519:${keySuffix}…`;
}

async function createSignedCitizenResult(envelope: DappSigningRequestEnvelope): Promise<WalletResponse> {
  const activeWalletRecord = await getActiveWalletRecord();
  if (!activeWalletRecord) {
    return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
  }
  const signer = await getOrCreateProtocolSigner(activeWalletRecord);
  const requestScopePreimage = signingPreimageFromEnvelope(envelope);
  const protocolSigningPreimage = protocolSigningPreimageFromEnvelope(envelope);
  const payloadBytes = new TextEncoder().encode(protocolSigningPreimage);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(signer.pkcs8Base64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    payloadBytes,
  );
  const publicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(signer.spkiBase64),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const localSignatureVerified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    payloadBytes,
  );
  if (!localSignatureVerified) {
    return walletError('PROTOCOL_SIGN_VERIFY_FAILED', 'Unable to verify protocol signature locally before returning result.');
  }

  return {
    ok: true,
    result: {
      signer: signer.did,
      verifyingKey: signer.verifyingKeyHex,
      signature: toHex(signature),
      requestId: envelope.requestId,
      origin: envelope.origin,
      tabUrl: envelope.tabUrl,
      method: envelope.method,
      signingPayload: envelope.canonicalPayload,
      payloadHash: envelope.payloadHash,
      payloadHashHex: envelope.payloadHash.replace('sha256:', ''),
      requestScopePreimage,
      protocolSigningPreimage,
      requestScopePayload: signingScopePayloadV2FromEnvelope(envelope),
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      riskFlags: envelope.riskFlags,
      algorithm: 'ed25519',
      signatureScope: 'canonical_payload_v1',
      localSignatureVerified,
    },
  };
}

async function createAuthChallengeSignatureResult(message: string): Promise<WalletResponse> {
  const activeWalletRecord = await getActiveWalletRecord();
  if (!activeWalletRecord) {
    return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
  }
  const signer = await getOrCreateProtocolSigner(activeWalletRecord);
  const payloadBytes = new TextEncoder().encode(message);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(signer.pkcs8Base64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, payloadBytes);
  return {
    ok: true,
    result: {
      signer: signer.did,
      verifyingKey: signer.verifyingKeyHex,
      algorithm: 'ed25519',
      signature: bytesToBase64Url(signature),
      signatureEncoding: 'base64url',
    },
  };
}

async function getCitizenKeyMaterial(walletId: string): Promise<{
  signer: {
    did: string;
    verifyingKey: string;
    algorithm: 'ed25519';
    createdAt: string;
  };
  reader: {
    readerDid: string;
    publicKeyHex: string;
    algorithm: 'x25519';
    createdAt: string;
  };
}> {
  const walletRecord = await getWalletRecordById(walletId);
  if (!walletRecord) {
    throw new Error('No active wallet is configured.');
  }
  const signer = await getOrCreateProtocolSigner(walletRecord);
  const reader = await getOrCreateEncryptionReaderKey(walletRecord);
  return {
    signer: {
      did: signer.did,
      verifyingKey: signer.verifyingKeyHex,
      algorithm: 'ed25519',
      createdAt: signer.createdAt,
    },
    reader: {
      readerDid: reader.did,
      publicKeyHex: reader.publicKeyHex,
      algorithm: 'x25519',
      createdAt: reader.createdAt,
    },
  };
}

function normalizeHybridDecryptInput(payload: unknown): HybridDecryptInput | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  const authorPublicKeyHex = candidate.authorPublicKeyHex;
  const ciphertextHex = candidate.ciphertextHex;
  const nonceHex = candidate.nonceHex;
  const wrappedDekHex = candidate.wrappedDekHex;
  if (
    typeof authorPublicKeyHex !== 'string'
    || typeof ciphertextHex !== 'string'
    || typeof nonceHex !== 'string'
    || typeof wrappedDekHex !== 'string'
  ) {
    return null;
  }
  return {
    authorPublicKeyHex: authorPublicKeyHex.trim(),
    ciphertextHex: ciphertextHex.trim(),
    nonceHex: nonceHex.trim(),
    wrappedDekHex: wrappedDekHex.trim(),
  };
}

async function decryptOwnedTransactionCiphertext(payload: unknown): Promise<WalletResponse> {
  const activeWalletRecord = await getActiveWalletRecord();
  if (!activeWalletRecord) {
    return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
  }
  const decryptInput = normalizeHybridDecryptInput(payload);
  if (!decryptInput) {
    return walletError(
      'ERR_MALFORMED_REQUEST',
      'wallet_decryptOwnedTransactionCiphertext requires { authorPublicKeyHex, wrappedDekHex, nonceHex, ciphertextHex }.',
    );
  }

  try {
    const readerSecret = await resolveProtocolSecretForWallet(activeWalletRecord);
    if (readerSecret.length !== 32) {
      return walletError('ERR_DECRYPT_FAILED', 'Reader key is invalid for X25519 decryption.');
    }

    const authorPublicKey = fromHex(decryptInput.authorPublicKeyHex);
    if (authorPublicKey.length !== 32) {
      return walletError('ERR_DECRYPT_FAILED', 'authorPublicKeyHex must be 32 bytes.');
    }

    const sharedSecret = await x25519DeriveBits(readerSecret, authorPublicKey);
    const wrapKeyBytes = await crypto.subtle.digest('SHA-256', sharedSecret);
    const wrapKey = new Uint8Array(wrapKeyBytes);

    const wrappedDek = fromHex(decryptInput.wrappedDekHex);
    if (wrappedDek.length <= 12) {
      return walletError('ERR_DECRYPT_FAILED', 'wrappedDekHex must include nonce + ciphertext.');
    }

    const tryWrappedDekNonceLengths = [12, 24].filter((nonceLen) => wrappedDek.length > nonceLen + 16);
    let dekBytes: Uint8Array | null = null;
    for (const nonceLen of tryWrappedDekNonceLengths) {
      const wrappedDekNonce = wrappedDek.slice(0, nonceLen);
      const wrappedDekCiphertext = wrappedDek.slice(nonceLen);
      if (nonceLen === 12) {
        const unwrapped = chacha20Poly1305Decrypt(wrapKey, wrappedDekNonce, wrappedDekCiphertext);
        if (unwrapped) {
          dekBytes = unwrapped;
          break;
        }
      }
    }
    if (!dekBytes) {
      return walletError('ERR_DECRYPT_FAILED', 'Unable to unwrap transaction DEK with provided reader key/material.');
    }
    if (dekBytes.length !== 32) {
      return walletError('ERR_DECRYPT_FAILED', 'Unable to unwrap transaction DEK for this wallet.');
    }

    const payloadNonce = fromHex(decryptInput.nonceHex);
    if (payloadNonce.length !== 12 && payloadNonce.length !== 24) {
      return walletError('ERR_DECRYPT_FAILED', 'nonceHex must be 12 or 24 bytes.');
    }
    const payloadCiphertext = fromHex(decryptInput.ciphertextHex);
    if (payloadNonce.length !== 12) {
      return walletError('ERR_DECRYPT_FAILED', 'Only 12-byte ChaCha20-Poly1305 nonce is currently supported in browser decrypt.');
    }
    const plaintextBytes = chacha20Poly1305Decrypt(dekBytes, payloadNonce, payloadCiphertext);
    if (!plaintextBytes) {
      return walletError('ERR_DECRYPT_FAILED', 'Payload decryption failed (invalid key, nonce, or tag).');
    }

    const plaintext = new TextDecoder().decode(plaintextBytes);
    return {
      ok: true,
      result: {
        plaintext,
        plaintextJson: (() => {
          try {
            return JSON.parse(plaintext);
          } catch {
            return null;
          }
        })(),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown decrypt failure.';
    return walletError('ERR_DECRYPT_FAILED', `Unable to decrypt ciphertext: ${reason}`);
  }
}

function asSignedSubmissionArtifact(value: unknown): SignedSubmissionArtifact | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const signerDid = candidate.signer;
  const verifyingKey = candidate.verifyingKey;
  const signature = candidate.signature;
  const payloadHash = candidate.payloadHash;
  const signingPayload = candidate.signingPayload;
  const signatureScope = candidate.signatureScope;
  const algorithm = candidate.algorithm;
  const requestId = candidate.requestId;

  if (
    typeof signerDid !== 'string'
    || typeof verifyingKey !== 'string'
    || typeof signature !== 'string'
    || typeof payloadHash !== 'string'
    || typeof signingPayload !== 'string'
    || typeof signatureScope !== 'string'
    || typeof algorithm !== 'string'
  ) {
    return null;
  }

  return {
    signerDid,
    verifyingKey,
    signature,
    payloadHash,
    signingPayload,
    signatureScope,
    algorithm,
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

async function getLatestSignedCitizenArtifact(): Promise<SignedSubmissionArtifact | null> {
  const requests = await getPendingDappRequests();
  const signed = requests.find((entry) => entry.state === 'signed');
  if (!signed) {
    return null;
  }
  const result = await createSignedCitizenResult(signed.envelope);
  if (!result.ok) {
    return null;
  }
  return asSignedSubmissionArtifact(result.result ?? null);
}

async function directSubmitLatestSignedArtifact(
  destinationUrl: string,
  consentToShareSigningPayload: boolean,
): Promise<WalletResponse> {
  const activeWallet = await getActiveWalletRecord();
  if (!activeWallet) {
    return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured for direct submit.');
  }
  const signerDid = (await getOrCreateProtocolSigner(activeWallet)).did;
  const networkId = await getSelectedNetwork();
  if (!(await isSelectedNetworkAlive(networkId))) {
    return walletError(
      'ERR_NETWORK_UNAVAILABLE',
      `Selected network (${networkId}) is unreachable. Bring it online before signing/submitting.`,
    );
  }
  const signedArtifact = await getLatestSignedCitizenArtifact();
  if (!signedArtifact) {
    return walletError('ERR_NO_SIGNED_ARTIFACT', 'No signed request artifact is available for direct submit.');
  }

  try {
    const response: DirectSubmitResponse = await submitSignedArtifact({
      destinationUrl,
      allowlistedDestinations: DIRECT_SUBMIT_ALLOWLIST,
      signedArtifact,
      consentToShareSigningPayload,
    });
    await appendDirectSubmitReceipt({
      requestId: signedArtifact.requestId ?? 'unknown',
      payloadHash: signedArtifact.payloadHash,
      walletId: activeWallet.id,
      signerDid,
      networkId,
      destinationUrl,
      traceId: response.traceId,
      status: response.status,
      latencyMs: response.latencyMs,
      receiptId: response.receiptId,
      receiptHash: response.receiptHash,
      blockHeight: response.blockHeight,
      entryId: null,
      submittedAt: new Date().toISOString(),
    });
    return { ok: true, result: response };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown direct submit error.';
    return walletError(
      'ERR_DIRECT_SUBMIT_UNAVAILABLE',
      `${reason} Fallback: submit the signed payload through your backend relay.`,
    );
  }
}

function normalizeEntryPayloadForEnvelope(
  requestPayload: unknown,
  signedArtifact: SignedSubmissionArtifact,
): SignedEnvelope | null {
  if (typeof requestPayload !== 'object' || requestPayload === null) {
    return null;
  }
  const payload = requestPayload as Record<string, unknown>;
  const namespace = typeof payload.namespace === 'string' ? payload.namespace : null;
  const action =
    typeof payload.action === 'string'
      ? payload.action
      : typeof payload.operation === 'string'
        ? payload.operation
        : null;
  const objectId =
    typeof payload.object_id === 'string'
      ? payload.object_id
      : typeof payload.objectId === 'string'
        ? payload.objectId
        : typeof payload.entry_id === 'string'
          ? payload.entry_id
          : typeof payload.entryId === 'string'
            ? payload.entryId
            : signedArtifact.requestId ?? signedArtifact.payloadHash;
  if (!namespace || !action || !objectId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const innerPayload =
    typeof payload.payload === 'object' && payload.payload !== null
      ? (payload.payload as Record<string, unknown>)
      : {};

  return {
    envelope_id:
      typeof payload.envelope_id === 'string'
        ? payload.envelope_id
        : typeof payload.envelopeId === 'string'
          ? payload.envelopeId
          : crypto.randomUUID(),
    signer: signedArtifact.signerDid,
    signature: signedArtifact.signature,
    submitted_at: new Date().toISOString(),
    payload: {
      entry_id:
        typeof payload.entry_id === 'string'
          ? payload.entry_id
          : typeof payload.entryId === 'string'
            ? payload.entryId
            : crypto.randomUUID(),
      namespace,
      action,
      object_id: objectId,
      payload: innerPayload,
      author: signedArtifact.signerDid,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : now,
      signature: signedArtifact.signature,
    },
  };
}

async function directSubmitSignedBatchToCitizenNetwork(
  apiBaseUrl: string,
  consentToShareFullPayload: boolean,
  requestIds?: string[],
): Promise<WalletResponse> {
  const activeWallet = await getActiveWalletRecord();
  if (!activeWallet) {
    return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured for direct submit.');
  }
  const signerDid = (await getOrCreateProtocolSigner(activeWallet)).did;
  const networkId = await getSelectedNetwork();
  const requests = await getPendingDappRequests();
  const signedRequests = requests.filter((entry) => entry.state === 'signed');
  const selectedRequests = Array.isArray(requestIds) && requestIds.length > 0
    ? signedRequests.filter((entry) => requestIds.includes(entry.requestId))
    : signedRequests;

  if (selectedRequests.length === 0) {
    return walletError('ERR_NO_SIGNED_ARTIFACT', 'No signed requests are available for batch submit.');
  }

  const envelopes: SignedEnvelope[] = [];
  for (const request of selectedRequests) {
    const signed = await createSignedCitizenResult(request.envelope);
    if (!signed.ok) {
      return signed;
    }
    const signedArtifact = asSignedSubmissionArtifact(signed.result ?? null);
    if (!signedArtifact) {
      return walletError('ERR_NO_SIGNED_ARTIFACT', 'Unable to reconstruct signed artifact.');
    }
    const envelope = normalizeEntryPayloadForEnvelope(request.envelope.payload, signedArtifact);
    if (!envelope) {
      return walletError(
        'ERR_MALFORMED_REQUEST',
        `Signed request ${request.requestId} is missing namespace/action/object_id fields required for runtime submit.`,
      );
    }
    envelopes.push(envelope);
  }

  try {
    const response = await submitEnvelopesToCitizenNetworkBatch({
      apiBaseUrl,
      allowlistedApiBaseUrls: CITIZEN_API_BASE_ALLOWLIST,
      envelopes,
      consentToShareFullPayload,
    });

    const submittedAt = new Date().toISOString();
    for (const receipt of response.receipts) {
      await appendDirectSubmitReceipt({
        requestId: receipt.entryId ?? 'unknown',
        payloadHash: null,
        walletId: activeWallet.id,
        signerDid,
        networkId,
        destinationUrl: apiBaseUrl,
        traceId: response.traceId,
        status: response.status,
        latencyMs: response.latencyMs,
        receiptId: receipt.receiptId,
        receiptHash: receipt.receiptHash,
        blockHeight: null,
        entryId: receipt.entryId ?? null,
        submittedAt,
      });
    }
    return { ok: true, result: response };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown direct submit batch error.';
    return walletError('ERR_DIRECT_SUBMIT_UNAVAILABLE', reason);
  }
}

async function enqueueDappSigningRequest(
  rawPayload: unknown,
  request: WalletRequest,
  sender: chrome.runtime.MessageSender,
): Promise<WalletResponse> {
  await cleanupRetainedDappRequests();
  await expireStaleDappRequests();
  const requests = await getPendingDappRequests();
  const activePending = requests.find((entry) => entry.state === 'pending');
  if (!canAcceptDappSigningRequest(requests, DAPP_REQUEST_CONCURRENCY_MODE) && activePending) {
    await appendDappAuditEvent({
      requestId: activePending.requestId,
      state: activePending.state,
      reason: 'concurrency_blocked_new_request',
    });
    return walletError(
      'ERR_CONCURRENT_REQUEST',
      'A signing request is already pending. Approve or reject it before submitting another.',
    );
  }

  const envelope = await createDappSigningRequestEnvelope({
    origin: request.origin,
    tabUrl: sender.url ?? sender.tab?.url ?? null,
    payload: rawPayload,
  });
  const activeWallet = await getActiveWalletRecord();
  if (!activeWallet) {
    return walletError(
      'ERR_WALLET_NOT_CONFIGURED',
      'Wallet is not configured. Open the extension side panel to create or import a wallet first.',
    );
  }
  const signerDid = (await getOrCreateProtocolSigner(activeWallet)).did;
  const networkId = await getSelectedNetwork();
  const now = new Date().toISOString();
  const pendingEntry: PendingDappSigningRequest = {
    requestId: envelope.requestId,
    envelope,
    walletId: activeWallet.id,
    signerDid,
    networkId,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
  };
  await savePendingDappRequests([pendingEntry, ...requests]);
  await appendDappAuditEvent({
    requestId: envelope.requestId,
    state: 'pending',
    reason: 'request_queued',
  });

  return new Promise<WalletResponse>((resolve) => {
    const timeoutMs = Math.max(0, new Date(envelope.expiresAt).getTime() - Date.now());
    const timeoutId = setTimeout(() => {
      void transitionDappRequestState(envelope.requestId, 'expired', 'request_expired_timeout').then(() => {
        pendingDappResolutions.delete(envelope.requestId);
        resolve(walletError('ERR_REQUEST_EXPIRED', 'The signing request expired before approval.'));
      });
    }, timeoutMs);
    pendingDappResolutions.set(envelope.requestId, { resolve, timeoutId });
  });
}

async function serializePendingDappRequestsForUi() {
  await cleanupRetainedDappRequests();
  await expireStaleDappRequests();
  const requests = await getPendingDappRequests();
  return requests.map((entry) => ({
    requestId: entry.requestId,
    origin: {
      origin: entry.envelope.origin,
      tabUrl: entry.envelope.tabUrl,
    },
    method: entry.envelope.method,
    payload: {
      canonicalJson: entry.envelope.canonicalPayload,
      hash: entry.envelope.payloadHash,
    },
    walletId: entry.walletId,
    signerDid: entry.signerDid,
    networkId: entry.networkId,
    createdAt: entry.envelope.createdAt,
    expiresAt: entry.envelope.expiresAt,
    riskFlags: entry.envelope.riskFlags,
    policyChecks: entry.envelope.policyChecks,
    state: entry.state,
  }));
}

async function approvePendingDappRequest(requestId: string): Promise<WalletResponse> {
  await cleanupRetainedDappRequests();
  await expireStaleDappRequests();
  const selectedNetwork = await getSelectedNetwork();
  if (!(await isSelectedNetworkAlive(selectedNetwork))) {
    return walletError(
      'ERR_NETWORK_UNAVAILABLE',
      `Selected network (${selectedNetwork}) is unreachable. Wallet signing is blocked until it is online.`,
    );
  }
  const requests = await getPendingDappRequests();
  const entry = requests.find((candidate) => candidate.requestId === requestId);
  if (!entry) {
    return walletError('ERR_REQUEST_NOT_FOUND', 'Signing request not found.');
  }
  if (entry.state !== 'pending') {
    return walletError('ERR_REQUEST_ALREADY_DECIDED', `Signing request is already ${entry.state}.`);
  }
  if (new Date(entry.envelope.expiresAt).getTime() <= Date.now()) {
    await transitionDappRequestState(requestId, 'expired', 'request_expired_on_approve');
    return walletError('ERR_REQUEST_EXPIRED', 'The signing request is stale and cannot be approved.');
  }
  await transitionDappRequestState(requestId, 'approved', 'approved_by_user');
  const signed = await createSignedCitizenResult(entry.envelope);
  await transitionDappRequestState(requestId, 'signed', 'signature_emitted');
  const resolution = pendingDappResolutions.get(requestId);
  if (resolution) {
    clearTimeout(resolution.timeoutId);
    pendingDappResolutions.delete(requestId);
    resolution.resolve(signed);
  }
  return { ok: true, result: true };
}

async function rejectPendingDappRequest(requestId: string, reason: string): Promise<WalletResponse> {
  await cleanupRetainedDappRequests();
  await expireStaleDappRequests();
  const requests = await getPendingDappRequests();
  const entry = requests.find((candidate) => candidate.requestId === requestId);
  if (!entry) {
    return walletError('ERR_REQUEST_NOT_FOUND', 'Signing request not found.');
  }
  if (entry.state !== 'pending') {
    return walletError('ERR_REQUEST_ALREADY_DECIDED', `Signing request is already ${entry.state}.`);
  }
  await transitionDappRequestState(requestId, 'rejected', reason);
  const resolution = pendingDappResolutions.get(requestId);
  if (resolution) {
    clearTimeout(resolution.timeoutId);
    pendingDappResolutions.delete(requestId);
    resolution.resolve(walletError('ERR_USER_REJECTED', 'The user rejected the signing request.'));
  }
  return { ok: true, result: true };
}

async function exportPrivateKey(password: string): Promise<WalletResponse> {
  const unlocked = await isUnlocked();
  if (!unlocked) {
    return { ok: false, error: 'Unlock wallet before exporting secret key.' };
  }

  const storedHash = await getPasswordHash();
  if (!storedHash) {
    return { ok: false, error: 'No password configured.' };
  }

  const inputHash = await sha256Hex(password);
  if (inputHash !== storedHash) {
    return { ok: false, error: 'Invalid password.' };
  }

  const wallet = await getStoredWallet();
  return { ok: true, result: wallet.privateKey };
}

async function exportProtocolSignerSecret(password: string): Promise<WalletResponse> {
  const unlocked = await isUnlocked();
  if (!unlocked) {
    return { ok: false, error: 'Unlock wallet before exporting protocol signer secret.' };
  }

  const storedHash = await getPasswordHash();
  if (!storedHash) {
    return { ok: false, error: 'No password configured.' };
  }

  const inputHash = await sha256Hex(password);
  if (inputHash !== storedHash) {
    return { ok: false, error: 'Invalid password.' };
  }

  const walletRecord = await getActiveWalletRecord();
  if (!walletRecord) {
    return { ok: false, error: 'No active wallet is configured.' };
  }
  const secret = await resolveProtocolSecretForWallet(walletRecord);
  return { ok: true, result: toHex(secret) };
}

async function exportProtocolKeypairs(password: string): Promise<WalletResponse> {
  const unlocked = await isUnlocked();
  if (!unlocked) {
    return { ok: false, error: 'Unlock wallet before exporting protocol keypairs.' };
  }

  const storedHash = await getPasswordHash();
  if (!storedHash) {
    return { ok: false, error: 'No password configured.' };
  }

  const inputHash = await sha256Hex(password);
  if (inputHash !== storedHash) {
    return { ok: false, error: 'Invalid password.' };
  }

  const walletRecord = await getActiveWalletRecord();
  if (!walletRecord) {
    return { ok: false, error: 'No active wallet is configured.' };
  }

  const signer = await getOrCreateProtocolSigner(walletRecord);
  const reader = await getOrCreateEncryptionReaderKey(walletRecord);
  const protocolSecretHex = toHex(await resolveProtocolSecretForWallet(walletRecord));
  return {
    ok: true,
    result: {
      signer_did: signer.did,
      signer_algorithm: 'ed25519',
      signer_ed25519_public_key_hex: signer.verifyingKeyHex,
      signer_ed25519_private_key_hex: protocolSecretHex,
      reader_did: reader.did,
      reader_algorithm: 'x25519',
      reader_x25519_public_key_hex: reader.publicKeyHex,
      reader_x25519_private_key_hex: protocolSecretHex,
      mnemonic_phrase: walletRecord.mnemonicPhrase ?? null,
      derivation_path: walletRecord.mnemonicPhrase ? (walletRecord.derivationPath ?? DEFAULT_DERIVATION_PATH) : null,
    },
  };
}

async function exportMnemonic(password: string): Promise<WalletResponse> {
  const unlocked = await isUnlocked();
  if (!unlocked) {
    return { ok: false, error: 'Unlock wallet before exporting seed phrase.' };
  }

  const storedHash = await getPasswordHash();
  if (!storedHash) {
    return { ok: false, error: 'No password configured.' };
  }

  const inputHash = await sha256Hex(password);
  if (inputHash !== storedHash) {
    return { ok: false, error: 'Invalid password.' };
  }

  const stored = await getActiveWalletRecord();
  if (!stored?.mnemonicPhrase) {
    return { ok: false, error: 'Mnemonic is unavailable for this wallet.' };
  }

  return {
    ok: true,
    result: {
      mnemonicPhrase: stored.mnemonicPhrase,
      derivationPath: stored.derivationPath ?? DEFAULT_DERIVATION_PATH,
    },
  };
}

async function importMnemonic(
  mnemonicPhrase: string,
  derivationPath = DEFAULT_DERIVATION_PATH,
): Promise<WalletResponse> {
  const normalizedPhrase = mnemonicPhrase.trim().toLowerCase();
  if (!normalizedPhrase) {
    return { ok: false, error: 'Mnemonic phrase is required.' };
  }

  const mnemonicWordCount = normalizedPhrase.split(/\s+/).filter(Boolean).length;
  if (!SUPPORTED_MNEMONIC_WORD_COUNTS.includes(mnemonicWordCount as SupportedMnemonicWordCount)) {
    return { ok: false, error: 'Mnemonic phrase must contain exactly 12 or 24 words.' };
  }

  let derived: HDNodeWallet;
  try {
    derived = HDNodeWallet.fromPhrase(normalizedPhrase, undefined, derivationPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid mnemonic phrase.';
    return { ok: false, error: message };
  }

  const vault = await ensureVaultInitialized();
  const nextWallet: StoredWallet = {
    id: createWalletId(),
    name: 'Imported pending…',
    createdAt: new Date().toISOString(),
    privateKey: derived.privateKey,
    mnemonicPhrase: normalizedPhrase,
    derivationPath,
  };
  nextWallet.name = await getProtocolWalletDisplayName(nextWallet, 'Imported');
  await saveWalletVault([nextWallet, ...vault], nextWallet.id);
  await markUnlocked();

  return {
    ok: true,
    result: {
      signerDid: (await getOrCreateProtocolSigner(nextWallet)).did,
      walletId: nextWallet.id,
      derivationPath,
    },
  };
}

async function generateMnemonicWallet(
  derivationPath = DEFAULT_DERIVATION_PATH,
  mnemonicWords: SupportedMnemonicWordCount = 12,
): Promise<WalletResponse> {
  if (!SUPPORTED_MNEMONIC_WORD_COUNTS.includes(mnemonicWords)) {
    return { ok: false, error: 'Mnemonic word count must be 12 or 24.' };
  }

  const entropyLengthBytes = mnemonicWords === 24 ? 32 : 16;
  const entropy = crypto.getRandomValues(new Uint8Array(entropyLengthBytes));
  const mnemonicPhrase = Mnemonic.fromEntropy(entropy).phrase;
  const derived = HDNodeWallet.fromPhrase(mnemonicPhrase, undefined, derivationPath);
  const vault = await ensureVaultInitialized();
  const nextWallet: StoredWallet = {
    id: createWalletId(),
    name: 'Wallet pending…',
    createdAt: new Date().toISOString(),
    privateKey: derived.privateKey,
    mnemonicPhrase,
    derivationPath,
  };
  nextWallet.name = await getProtocolWalletDisplayName(nextWallet, 'Wallet');
  await saveWalletVault([nextWallet, ...vault], nextWallet.id);
  await markUnlocked();

  return {
    ok: true,
    result: {
      signerDid: (await getOrCreateProtocolSigner(nextWallet)).did,
      walletId: nextWallet.id,
      mnemonicPhrase,
      derivationPath,
    },
  };
}

async function submitKycOnChain(walletRecord: StoredWallet, fullName: string, address: string): Promise<WalletResponse> {
  const signer = await getOrCreateProtocolSigner(walletRecord);
  const did = signer.did;
  const networkId = await getSelectedNetwork();
  const activeNetwork = NETWORKS[networkId];
  if (!activeNetwork) {
    return walletError('ERR_NETWORK_UNKNOWN', 'Unknown network.');
  }

  const apiBase = networkId === 'localnode' ? 'http://localhost:8091' : `https://${networkId}.ctzn.space`;

  let adminPublicKey: string | null = null;
  try {
    const keyResp = await fetch(`${apiBase}/api/v1/civic/admin/kyc-public-key`);
    if (keyResp.ok) {
      const keyData = await keyResp.json();
      adminPublicKey = keyData.public_key ?? null;
    }
  } catch (err) {
    console.error('[submitKycOnChain] failed to fetch admin KYC public key:', err);
  }

  if (!adminPublicKey) {
    return walletError('ERR_KYC_NO_ADMIN_KEY',
      'No KYC encryption key found. An election admin must connect and publish their KYC public key before submissions are accepted.');
  }

  const readerKey = await getOrCreateEncryptionReaderKey(walletRecord);
  const authorSecret = await resolveProtocolSecretForWallet(walletRecord);
  const adminReaderDid = `did:key:x25519:${adminPublicKey}`;
  const entryId = crypto.randomUUID();

  let envelope: {
    ciphertextHex: string; nonceHex: string; authorPublicKeyHex: string;
    keyWrappedSecrets: Array<{ reader_id: string; wrapped_dek: string }>;
    payloadCommitment: string;
  };

  try {
    envelope = await encryptKycDataHybrid(
      { full_name: fullName, address },
      adminPublicKey,
      authorSecret,
      readerKey.publicKeyHex,
      readerKey.did,
      adminReaderDid,
      entryId,
    );
  } catch (err) {
    return walletError('ERR_KYC_ENCRYPTION_FAILED',
      err instanceof Error ? err.message : 'KYC encryption failed');
  }

  const timestamp = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    hybrid_author_x25519_public_key: envelope.authorPublicKeyHex,
    key_wrapped_secrets: envelope.keyWrappedSecrets,
  };

  const signingPayload = {
    entry_id: entryId,
    namespace: 'identity.kyc',
    action: 'SUBMIT_KYC',
    object_id: did,
    payload,
    author: did,
    timestamp,
  };

  const canonical = canonicalJson(signingPayload);

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(signer.pkcs8Base64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonical),
  );
  const signatureHex = toHex(new Uint8Array(signatureBytes));

  const payloadBytes = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', payloadBytes);
  const payloadCommitment = `sha256:${toHex(new Uint8Array(hashBuffer))}`;

  const entry: Record<string, unknown> = {
    entry_id: entryId,
    namespace: 'identity.kyc',
    action: 'SUBMIT_KYC',
    object_id: did,
    payload,
    payload_commitment: payloadCommitment,
    author: did,
    signature: signatureHex,
    timestamp,
    privacy_flag: true,
    privacy_mode: 'hybrid',
    ciphertext_hex: envelope.ciphertextHex,
    nonce_hex: envelope.nonceHex,
  };

  try {
    const apiBase = networkId === 'localnode' ? 'http://localhost:8091' : `https://${networkId}.ctzn.space`;
    const startTime = performance.now();
    const resp = await fetch(`${apiBase}/api/v1/entries/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    const latencyMs = Math.round(performance.now() - startTime);
    const body = await resp.json();
    if (resp.ok) {
      // Store a receipt so the explorer link appears in the wallet Activity tab
      const receiptId = body?.receipt?.receipt_id ?? null;
      const blockHeight = body?.receipt?.finality?.block_height ?? null;
      const payloadBytes = new TextEncoder().encode(canonical);
      const hashBuffer = await crypto.subtle.digest('SHA-256', payloadBytes);
      const payloadHash = `sha256:${toHex(new Uint8Array(hashBuffer))}`;
      const receiptHash = body?.receipt?.payload_commitment
        ? `sha256:${body.receipt.payload_commitment}`
        : payloadHash;
      await appendDirectSubmitReceipt({
        requestId: entryId,
        payloadHash,
        walletId: walletRecord.id,
        signerDid: did,
        networkId,
        destinationUrl: `${apiBase}/api/v1/entries/submit`,
        traceId: crypto.randomUUID(),
        status: resp.status,
        latencyMs,
        receiptId,
        receiptHash,
        blockHeight,
        entryId,
        submittedAt: new Date().toISOString(),
      });
      return { ok: true, result: { ...body, entry_id: entryId, status: 'submitted', payload_hash: payloadHash } };
    }
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'KYC submission failed' };
  } catch (err) {
    return walletError('ERR_DIRECT_SUBMIT_UNAVAILABLE',
      err instanceof Error ? err.message : 'KYC submission failed');
  }
}

async function fetchKycStatus(did: string): Promise<WalletResponse> {
  const networkId = await getSelectedNetwork();
  const apiBase = networkId === 'localnode' ? 'http://localhost:8091' : `https://${networkId}.ctzn.space`;
  try {
    const resp = await fetch(`${apiBase}/api/v1/identity/kyc/${encodeURIComponent(did)}`);
    if (!resp.ok) {
      return { ok: true, result: { did, kyc_status: 'unknown', message: 'Status unavailable' } };
    }
    const data = await resp.json();
    const result: Record<string, unknown> = { did, ...data };

    if (data.kyc_status === 'approved') {
      try {
        const listResp = await fetch(`${apiBase}/api/v1/identity/kyc`);
        if (listResp.ok) {
          const listData = await listResp.json();
          const self = (listData.submissions || []).find((s: any) => s.did === did);
          if (self?.encrypted?.hybrid_author_x25519_public_key && self?.encrypted?.key_wrapped_secrets) {
            try {
              const activeWallet = await getActiveWalletRecord();
              if (activeWallet) {
                const holderSecret = await resolveProtocolSecretForWallet(activeWallet);
                const holderReaderKey = await getOrCreateEncryptionReaderKey(activeWallet);
                const decrypted = await decryptKycAsHolderHybrid(
                  self.encrypted.ciphertext_hex,
                  self.encrypted.nonce_hex,
                  self.encrypted.hybrid_author_x25519_public_key,
                  self.encrypted.key_wrapped_secrets,
                  holderReaderKey.did,
                  holderSecret,
                );
                if (decrypted) {
                  result.decrypted_full_name = decrypted.full_name;
                  result.decrypted_address = decrypted.address;
                }
              }
            } catch { /* holder decryption optional */ }
          }
        }
      } catch { /* best-effort */ }
    }
    return { ok: true, result };
  } catch {
    return { ok: true, result: { did, kyc_status: 'unknown', message: 'Could not reach network' } };
  }
}

async function fetchCitizenTokens(did: string): Promise<WalletResponse> {
  const networkId = await getSelectedNetwork();
  try {
    const apiBase = networkId === 'localnode' ? 'http://localhost:8091' : `https://${networkId}.ctzn.space`;
    const resp = await fetch(`${apiBase}/api/v1/ctzn/ctzn-token.v1/check/${encodeURIComponent(did)}`);
    if (!resp.ok) {
      return { ok: true, result: { did, has_citizenship: false, tokens: [] } };
    }
    const data = await resp.json();
    return { ok: true, result: data };
  } catch {
    return { ok: true, result: { did, has_citizenship: false, tokens: [], message: 'Could not reach network' } };
  }
}

async function handleWalletRequest(
  request: WalletRequest,
  sender: chrome.runtime.MessageSender,
): Promise<WalletResponse> {
  const isUiRequest = isExtensionUiMessage(sender);
  const isDappRequest = !isUiRequest;

  if (isDappRequest && shouldPromptWalletUi(request.method)) {
    await openWalletSidePanel(sender);
  }

  if (request.method === 'wallet_isPasswordSet') {
    return { ok: true, result: (await getPasswordHash()) !== null };
  }

  if (request.method === 'wallet_hasStoredWallet') {
    return { ok: true, result: await hasStoredWallet() };
  }

  if (request.method === 'wallet_getActivity') {
    const stored = await chrome.storage.local.get(ACTIVITY_KEY);
    const list = Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY] : [];
    return { ok: true, result: list };
  }

  if (request.method === 'wallet_listVault') {
    const vault = await ensureVaultInitialized();
    const activeWallet = await getActiveWalletRecord();
    const vaultWithSigner = await Promise.all(vault.map(async (wallet) => ({
      wallet,
      signer: await getOrCreateProtocolSigner(wallet),
    })));
    return {
      ok: true,
      result: vaultWithSigner.map(({ wallet, signer }) => ({
        id: wallet.id,
        name: wallet.name,
        signerDid: signer.did,
        hasMnemonic: Boolean(wallet.mnemonicPhrase),
        mnemonicWordCount: getMnemonicWordCount(wallet.mnemonicPhrase),
        createdAt: wallet.createdAt,
        isActive: wallet.id === activeWallet?.id,
      })),
    };
  }

  if (request.method === 'wallet_renameVaultWallet') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [walletId, newName] = request.params ?? [];
    if (typeof walletId !== 'string' || typeof newName !== 'string' || !newName.trim()) {
      return walletError('ERR_MALFORMED_REQUEST', 'wallet_renameVaultWallet requires walletId and a non-empty name.');
    }
    const vault = await getWalletVault();
    const index = vault.findIndex((w) => w.id === walletId);
    if (index === -1) {
      return walletError('ERR_NOT_FOUND', 'Wallet not found.');
    }
    vault[index].name = newName.trim();
    const activeId = await getActiveWalletId();
    await saveWalletVault(vault, activeId ?? undefined);
    return { ok: true, result: { id: walletId, name: vault[index].name } };
  }

  if (request.method === 'wallet_getPendingDappRequests') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await serializePendingDappRequestsForUi() };
  }

  if (request.method === 'wallet_getOriginPermissions') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await getDappOriginPermissions() };
  }

  if (request.method === 'wallet_getApprovalMetrics') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await getDappApprovalMetricsSnapshot() };
  }

  if (request.method === 'wallet_getDirectSubmitConfig') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return {
      ok: true,
      result: {
        defaultDestination: await getDirectSubmitDefaultDestination(),
        allowlistedDestinations: DIRECT_SUBMIT_ALLOWLIST,
        allowlistedApiBaseUrls: CITIZEN_API_BASE_ALLOWLIST,
      },
    };
  }

  if (request.method === 'wallet_setDirectSubmitDefaultDestination') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [destinationUrl] = request.params ?? [];
    if (typeof destinationUrl !== 'string' || destinationUrl.trim().length === 0) {
      return walletError(
        'ERR_MALFORMED_REQUEST',
        'wallet_setDirectSubmitDefaultDestination requires destination URL.',
      );
    }
    if (!DIRECT_SUBMIT_ALLOWLIST.includes(destinationUrl)) {
      return walletError('ERR_DESTINATION_NOT_ALLOWLISTED', 'Destination URL is not allowlisted.');
    }
    await setDirectSubmitDefaultDestination(destinationUrl);
    return { ok: true, result: destinationUrl };
  }

  if (request.method === 'wallet_getDirectSubmitReceipts') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await getDirectSubmitReceipts() };
  }

  if (request.method === 'wallet_getBackupPosture') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await getBackupPosture() };
  }

  if (request.method === 'wallet_markBackupVerified') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return { ok: true, result: await markBackupVerifiedNow() };
  }

  if (request.method === 'wallet_createBackupVault') {
    if (!isUiRequest) return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    const [decoyPassphrase, criticalPassphrase, decoyHint, criticalHint] = request.params ?? [];
    const policyError = validateDistinctPassphrases(decoyPassphrase, criticalPassphrase);
    if (policyError) {
      return walletError('ERR_MALFORMED_REQUEST', policyError);
    }
    const now = new Date().toISOString();
    const state: BackupVaultState = {
      version: 1,
      slots: [
        { role: 'decoy', passphraseHint: typeof decoyHint === 'string' ? decoyHint : null, createdAt: now, updatedAt: now },
        { role: 'critical', passphraseHint: typeof criticalHint === 'string' ? criticalHint : null, createdAt: now, updatedAt: now },
      ],
    };
    await chrome.storage.local.set({ [BACKUP_VAULT_STATE_KEY]: state });
    return { ok: true, result: state };
  }

  if (request.method === 'wallet_exportBackupVault') {
    if (!isUiRequest) return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    const [roleParam, passphrase] = request.params ?? [];
    const role = normalizeBackupRole(roleParam);
    const normalizedPassphrase = requirePassphrase(passphrase);
    if (!role || !normalizedPassphrase) {
      return walletError('ERR_MALFORMED_REQUEST', 'Export requires role and passphrase.');
    }
    const vault = await ensureVaultInitialized();
    const exported = vault.map((wallet) => ({
      id: wallet.id, name: wallet.name, createdAt: wallet.createdAt,
      mnemonicPhrase: wallet.mnemonicPhrase ?? null, derivationPath: wallet.derivationPath ?? null,
    }));
    const payload = await encryptBackupPayload(normalizedPassphrase, { schema: 'citizen.wallet.extension.backup.v1', role, exportedAt: new Date().toISOString(), wallets: exported });
    return { ok: true, result: { role, payloadBase64: payload, fileName: `citizen-${role}-backup-${Date.now()}.cwb` } };
  }

  if (request.method === 'wallet_restoreBackupVault') {
    if (!isUiRequest) return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    const [roleParam, passphrase, payloadBase64, conflictResolution] = request.params ?? [];
    const role = normalizeBackupRole(roleParam);
    const normalizedPassphrase = requirePassphrase(passphrase);
    if (!role || !normalizedPassphrase || typeof payloadBase64 !== 'string') {
      return walletError('ERR_MALFORMED_REQUEST', 'Restore requires role, passphrase, and encrypted payload.');
    }
    try {
      const decoded = await decryptBackupPayload(normalizedPassphrase, payloadBase64) as { role?: string; wallets?: StoredWallet[] };
      if (decoded.role !== role || !Array.isArray(decoded.wallets)) {
        return walletError('ERR_BACKUP_INTEGRITY', 'Backup payload role mismatch or malformed payload.');
      }
      const current = await ensureVaultInitialized();
      const existingById = new Map(current.map((wallet) => [wallet.id, wallet]));
      let imported = 0;
      for (const wallet of decoded.wallets) {
        if (existingById.has(wallet.id) && conflictResolution !== 'replace') continue;
        existingById.set(wallet.id, wallet);
        imported += 1;
      }
      const merged = Array.from(existingById.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      await saveWalletVault(merged, merged[0]?.id);
      await markBackupVerifiedNow();
      return { ok: true, result: { imported, total: merged.length } };
    } catch (error) {
      return walletError('ERR_BACKUP_DECRYPT_FAILED', error instanceof Error ? error.message : 'Unable to decrypt backup payload.');
    }
  }

  if (request.method === 'wallet_directSubmitLatestSignedArtifact') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [destinationUrl, consentToShareSigningPayload] = request.params ?? [];
    if (typeof destinationUrl !== 'string' || destinationUrl.trim().length === 0) {
      return walletError(
        'ERR_MALFORMED_REQUEST',
        'wallet_directSubmitLatestSignedArtifact requires destination URL.',
      );
    }
    return directSubmitLatestSignedArtifact(destinationUrl, consentToShareSigningPayload === true);
  }

  if (request.method === 'wallet_directSubmitSignedBatchToCitizenNetwork') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    return walletError(
      'ERR_FEATURE_DISABLED',
      'Batch submit to Citizen runtime is temporarily disabled in the browser extension.',
    );
  }

  if (request.method === 'wallet_setOriginPermission') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [origin, permission] = request.params ?? [];
    if (typeof origin !== 'string' || origin.trim().length === 0) {
      return walletError('ERR_MALFORMED_REQUEST', 'wallet_setOriginPermission requires origin.');
    }
    if (permission === 'prompt') {
      return { ok: true, result: await removeDappOriginPermission(origin) };
    }
    if (permission !== 'blocked') {
      return walletError(
        'ERR_MALFORMED_REQUEST',
        'wallet_setOriginPermission requires prompt or blocked permission.',
      );
    }
    return { ok: true, result: await setDappOriginPermission(origin, permission) };
  }

  if (request.method === 'wallet_approveDappRequest') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [requestId] = request.params ?? [];
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return walletError('ERR_MALFORMED_REQUEST', 'wallet_approveDappRequest requires requestId.');
    }
    return approvePendingDappRequest(requestId);
  }

  if (request.method === 'wallet_rejectDappRequest') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [requestId] = request.params ?? [];
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return walletError('ERR_MALFORMED_REQUEST', 'wallet_rejectDappRequest requires requestId.');
    }
    return rejectPendingDappRequest(requestId, 'rejected_by_user');
  }

  if (request.method === 'wallet_cancelDappRequest') {
    if (!isUiRequest) {
      return walletError('ERR_UNAUTHORIZED', 'Unauthorized wallet method.');
    }
    const [requestId] = request.params ?? [];
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return walletError('ERR_MALFORMED_REQUEST', 'wallet_cancelDappRequest requires requestId.');
    }
    return rejectPendingDappRequest(requestId, 'cancelled_in_wallet_ui');
  }

  if (request.method === 'wallet_setActiveWallet') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [walletId] = request.params ?? [];
    if (typeof walletId !== 'string') {
      return { ok: false, error: 'wallet_setActiveWallet requires a wallet id.' };
    }
    const vault = await ensureVaultInitialized();
    const found = vault.find((wallet) => wallet.id === walletId);
    if (!found) {
      return { ok: false, error: 'Wallet not found in vault.' };
    }
    await saveWalletVault(vault, walletId);
    return { ok: true, result: true };
  }

  if (request.method === 'wallet_isUnlocked') {
    return { ok: true, result: !(await isWalletLocked()) };
  }

  if (request.method === 'wallet_setPassword') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_setPassword requires a password.' };
    }
    return setWalletPassword(password);
  }

  if (request.method === 'wallet_unlock') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_unlock requires a password.' };
    }
    return unlockWallet(password);
  }

  if (request.method === 'wallet_lock') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    return lockWallet();
  }

  if (request.method === 'wallet_exportPrivateKey') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_exportPrivateKey requires your password.' };
    }
    return exportPrivateKey(password);
  }

  if (request.method === 'wallet_exportProtocolSignerSecret') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_exportProtocolSignerSecret requires your password.' };
    }
    return exportProtocolSignerSecret(password);
  }

  if (request.method === 'wallet_exportProtocolKeypairs') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_exportProtocolKeypairs requires your password.' };
    }
    return exportProtocolKeypairs(password);
  }

  if (request.method === 'wallet_exportMnemonic') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [password] = request.params ?? [];
    if (typeof password !== 'string') {
      return { ok: false, error: 'wallet_exportMnemonic requires your password.' };
    }
    return exportMnemonic(password);
  }

  if (request.method === 'wallet_importMnemonic') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [mnemonicPhrase, derivationPath] = request.params ?? [];
    if (typeof mnemonicPhrase !== 'string') {
      return { ok: false, error: 'wallet_importMnemonic requires a mnemonic phrase.' };
    }
    if (derivationPath !== undefined && typeof derivationPath !== 'string') {
      return { ok: false, error: 'wallet_importMnemonic derivation path must be a string.' };
    }
    return importMnemonic(mnemonicPhrase, derivationPath ?? DEFAULT_DERIVATION_PATH);
  }

  if (request.method === 'wallet_generateMnemonicWallet') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [derivationPath, mnemonicWords] = request.params ?? [];
    if (derivationPath !== undefined && typeof derivationPath !== 'string') {
      return { ok: false, error: 'wallet_generateMnemonicWallet derivation path must be a string.' };
    }
    if (
      mnemonicWords !== undefined
      && (typeof mnemonicWords !== 'number'
        || !SUPPORTED_MNEMONIC_WORD_COUNTS.includes(mnemonicWords as SupportedMnemonicWordCount))
    ) {
      return { ok: false, error: 'wallet_generateMnemonicWallet mnemonic words must be 12 or 24.' };
    }
    return generateMnemonicWallet(
      derivationPath ?? DEFAULT_DERIVATION_PATH,
      (mnemonicWords as SupportedMnemonicWordCount | undefined) ?? 12,
    );
  }

  if (request.method === 'wallet_getNetwork') {
    return { ok: true, result: await getSelectedNetwork() };
  }

  if (request.method === 'wallet_getNetworkLiveness') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    return { ok: true, result: await getNetworkLivenessByNetwork() };
  }

  if (request.method === 'wallet_setNetwork') {
    if (!isUiRequest) {
      return { ok: false, error: 'Unauthorized wallet method.' };
    }
    const [network] = request.params ?? [];
    if (!isNetworkId(network)) {
      return { ok: false, error: 'wallet_setNetwork requires mainnet, futurenet, testnet, or localnode.' };
    }
    await setSelectedNetwork(network);
    return { ok: true, result: network };
  }

  if (await isWalletLocked()) {
    return walletError('ERR_WALLET_LOCKED', 'Wallet is locked. Open the extension side panel to unlock.');
  }

  if (
    isDappRequest
    && shouldPromptWalletUi(request.method)
    && !(await hasStoredWallet())
  ) {
    return {
      ...walletError(
        'ERR_WALLET_NOT_CONFIGURED',
        'Wallet is not configured. Open the extension side panel to create or import a wallet first.',
      ),
    };
  }

  const wallet = await getStoredWallet();
  const activeWalletRecord = await getActiveWalletRecord();
  const activeSignerDid = activeWalletRecord ? (await getOrCreateProtocolSigner(activeWalletRecord)).did : 'unknown';
  await recordRequest(request, activeSignerDid);

  switch (request.method) {
    case 'ctzn_requestAccounts':
    case 'ctzn_accounts':
    case 'citizen_requestAccounts':
    case 'citizen_accounts':
      return walletError('ERR_UNSUPPORTED_METHOD', 'Account-based methods are disabled in strict protocol mode.');
    case 'ctzn_chainId':
    case 'citizen_chainId':
      return { ok: true, result: NETWORKS[await getSelectedNetwork()].chainIdHex };
    case 'wallet_switchCtznChain': {
      const [chainConfig] = request.params ?? [];
      if (typeof chainConfig !== 'object' || chainConfig === null) {
        return { ok: false, error: 'wallet_switchCtznChain requires { chainId }.' };
      }
      const chainId = (chainConfig as { chainId?: unknown }).chainId;
      const nextNetwork = getNetworkIdFromChainIdHex(chainId);
      if (!nextNetwork) {
        return { ok: false, error: 'Unsupported chainId for wallet_switchCtznChain.' };
      }
      await setSelectedNetwork(nextNetwork);
      return { ok: true, result: null };
    }
    case 'wallet_addCtznChain':
      return {
        ok: false,
        error: 'wallet_addCtznChain is not supported. Supported chains are preconfigured.',
      };
    case 'citizen_login':
    case 'wallet_login': {
      return walletError('ERR_UNSUPPORTED_METHOD', 'Login/account signature methods are disabled in strict protocol mode.');
    }
    case 'personal_sign': {
      return walletError('ERR_UNSUPPORTED_METHOD', 'personal_sign is disabled in strict protocol mode.');
    }
    case 'ctzn_signTypedData_v4': {
      return walletError('ERR_UNSUPPORTED_METHOD', 'ctzn_signTypedData_v4 is disabled in strict protocol mode.');
    }
    case 'ctzn_getCitizenSigner': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const material = await getCitizenKeyMaterial(activeWalletRecord.id);
      return {
        ok: true,
        result: material.signer,
      };
    }
    case 'ctzn_getEncryptionPublicKey': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const material = await getCitizenKeyMaterial(activeWalletRecord.id);
      return {
        ok: true,
        result: material.reader,
      };
    }
    case 'ctzn_getCitizenKeyMaterial': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const material = await getCitizenKeyMaterial(activeWalletRecord.id);
      return {
        ok: true,
        result: material,
      };
    }
    case 'ctzn_signCitizenTx': {
      const [payload] = request.params ?? [];
      if (payload === undefined || payload === null) {
        return walletError(
          'ERR_MALFORMED_REQUEST',
          'ctzn_signCitizenTx requires a payload object or canonical JSON string.',
        );
      }
      if (request.method !== DAPP_SIGNING_METHOD) {
        return walletError('ERR_UNSUPPORTED_METHOD', `Unsupported signing method: ${request.method}`);
      }
      if (isDappRequest && (await getOriginPermission(request.origin)) === 'blocked') {
        return walletError('ERR_ORIGIN_BLOCKED', 'This origin is blocked in wallet permissions.');
      }
      return enqueueDappSigningRequest(payload, request, sender);
    }
    case 'ctzn_confirmCitizenTxSubmission': {
      const [payload] = request.params ?? [];
      if (typeof payload !== 'object' || payload === null) {
        return walletError(
          'ERR_MALFORMED_REQUEST',
          'ctzn_confirmCitizenTxSubmission requires { requestId, receiptHash }.',
        );
      }
      const { requestId, receiptHash } = payload as { requestId?: unknown; receiptHash?: unknown };
      if (typeof requestId !== 'string' || typeof receiptHash !== 'string') {
        return walletError(
          'ERR_MALFORMED_REQUEST',
          'ctzn_confirmCitizenTxSubmission requires string requestId and receiptHash.',
        );
      }
      return confirmSubmittedRequestFromBuilderApp(requestId, receiptHash, request.origin);
    }
    case 'ctzn_signAuthChallenge': {
      const [message] = request.params ?? [];
      if (typeof message !== 'string' || message.trim().length === 0) {
        return walletError('ERR_MALFORMED_REQUEST', 'ctzn_signAuthChallenge requires a non-empty challenge message.');
      }
      return createAuthChallengeSignatureResult(message);
    }
    case 'wallet_decryptOwnedTransactionCiphertext': {
      if (!isUiRequest) {
        return walletError('ERR_UNAUTHORIZED', 'wallet_decryptOwnedTransactionCiphertext is UI-only.');
      }
      const [payload] = request.params ?? [];
      return decryptOwnedTransactionCiphertext(payload);
    }
    case 'ctzn_submitKyc': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const [params] = request.params ?? [];
      if (typeof params !== 'object' || params === null) {
        return walletError('ERR_MALFORMED_REQUEST', 'ctzn_submitKyc requires { fullName, address }.');
      }
      const { fullName, address } = params as { fullName?: string; address?: string };
      if (typeof fullName !== 'string' || fullName.trim().length === 0) {
        return walletError('ERR_MALFORMED_REQUEST', 'ctzn_submitKyc requires a non-empty fullName.');
      }
      if (typeof address !== 'string' || address.trim().length === 0) {
        return walletError('ERR_MALFORMED_REQUEST', 'ctzn_submitKyc requires a non-empty address.');
      }
      return submitKycOnChain(activeWalletRecord, fullName.trim(), address.trim());
    }
    case 'ctzn_getKycStatus': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const signerDid = (await getOrCreateProtocolSigner(activeWalletRecord)).did;
      return fetchKycStatus(signerDid);
    }
    case 'ctzn_getCitizenTokens': {
      if (!activeWalletRecord) {
        return walletError('ERR_WALLET_NOT_CONFIGURED', 'No active wallet is configured.');
      }
      const signerDid = (await getOrCreateProtocolSigner(activeWalletRecord)).did;
      return fetchCitizenTokens(signerDid);
    }
    default:
      return walletError('ERR_UNSUPPORTED_METHOD', `Unsupported method: ${request.method}`);
  }
}

export const __testHooks = {
  handleWalletRequest,
};

chrome.runtime.onMessage.addListener((
  message: WalletRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: WalletResponse) => void,
) => {
  void handleWalletRequest(message, sender)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown wallet error';
      sendResponse({ ok: false, error: errorMessage });
    });

  return true;
});

if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to enable side panel action behavior: ${message}`);
    });
}
