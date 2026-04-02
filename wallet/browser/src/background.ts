import { HDNodeWallet, Wallet } from 'ethers';
import {
  DAPP_SIGNING_METHOD,
  type DappSigningRequestEnvelope,
  createDappSigningRequestEnvelope,
  signingScopePayloadV2FromEnvelope,
  signingPreimageFromEnvelope,
} from './dappSigningRequest';
import {
  pruneRetainedRequests,
  sanitizeRequestForStorage,
  type DappRequestState,
  type PendingDappSigningRequest,
} from './dappRequestIsolation';
import { canAcceptDappSigningRequest } from './dappRequestQueue';
import {
  decryptJsonValue,
  encryptJsonValue,
  importAesKey,
  isEncryptedJsonEnvelope,
} from './sensitiveStorage';

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

type DappRequestAuditEvent = {
  eventId: string;
  requestId: string;
  state: DappRequestState;
  reason: string;
  occurredAt: string;
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
const PROTOCOL_SIGNER_KEY = 'citizen.browser.wallet.protocol_signer.v1';
const DAPP_PENDING_REQUESTS_KEY = 'citizen.browser.wallet.dapp_pending_requests.v1';
const DAPP_REQUEST_AUDIT_KEY = 'citizen.browser.wallet.dapp_request_audit.v1';
const DAPP_ORIGIN_PERMISSIONS_KEY = 'citizen.browser.wallet.dapp_origin_permissions.v1';
const LOCAL_ENCRYPTION_KEY_KEY = 'citizen.browser.wallet.local_encryption_key.v1';
const DEFAULT_DERIVATION_PATH = "m/44'/930'/0'/0'/0'";
const MAX_ACTIVITY = 100;
const MAX_DAPP_AUDIT_EVENTS = 1_000;
const DAPP_DECIDED_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const DAPP_REQUEST_CONCURRENCY_MODE = 'single_active';

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

type StoredProtocolSigner = {
  keyId: string;
  did: string;
  verifyingKeyHex: string;
  spkiBase64: string;
  pkcs8Base64: string;
  createdAt: string;
};

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
  const expected = chrome.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(expected);
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
    name: `Wallet ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
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
  return [
    'ctzn_requestAccounts',
    'citizen_requestAccounts',
    'citizen_login',
    'wallet_login',
    'personal_sign',
    'ctzn_signTypedData_v4',
    'ctzn_signCitizenTx',
  ].includes(method);
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
    params: request.params ?? [],
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

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getOrCreateProtocolSigner(): Promise<StoredProtocolSigner> {
  const stored = await chrome.storage.local.get(PROTOCOL_SIGNER_KEY);
  const existing = stored[PROTOCOL_SIGNER_KEY];
  if (existing && typeof existing === 'object') {
    const signer = existing as StoredProtocolSigner;
    if (
      typeof signer.pkcs8Base64 === 'string'
      && typeof signer.spkiBase64 === 'string'
      && typeof signer.verifyingKeyHex === 'string'
      && typeof signer.did === 'string'
    ) {
      return signer;
    }
  }

  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in generated) || !('publicKey' in generated)) {
    throw new Error('Unable to generate Citizen protocol signer keypair.');
  }
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', generated.privateKey),
    crypto.subtle.exportKey('spki', generated.publicKey),
  ]);

  const verifyingKeyHex = toHex(new Uint8Array(spki).slice(-32));
  const signer: StoredProtocolSigner = {
    keyId: crypto.randomUUID(),
    did: `did:key:ed25519:${verifyingKeyHex}`,
    verifyingKeyHex,
    spkiBase64: bytesToBase64(spki),
    pkcs8Base64: bytesToBase64(pkcs8),
    createdAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [PROTOCOL_SIGNER_KEY]: signer });
  return signer;
}

async function createSignedCitizenResult(envelope: DappSigningRequestEnvelope): Promise<WalletResponse> {
  const signer = await getOrCreateProtocolSigner();
  const requestScopePreimage = signingPreimageFromEnvelope(envelope);
  const payloadBytes = new TextEncoder().encode(envelope.payloadHash);
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
      requestScopePayload: signingScopePayloadV2FromEnvelope(envelope),
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      riskFlags: envelope.riskFlags,
      algorithm: 'ed25519',
      signatureScope: 'payload_hash_v1',
    },
  };
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
  const now = new Date().toISOString();
  const pendingEntry: PendingDappSigningRequest = {
    requestId: envelope.requestId,
    envelope,
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
    name: `Imported ${derived.address.slice(0, 6)}…${derived.address.slice(-4)}`,
    createdAt: new Date().toISOString(),
    privateKey: derived.privateKey,
    mnemonicPhrase: normalizedPhrase,
    derivationPath,
  };
  await saveWalletVault([nextWallet, ...vault], nextWallet.id);
  await markUnlocked();

  return {
    ok: true,
    result: {
      account: derived.address,
      walletId: nextWallet.id,
      derivationPath,
    },
  };
}

async function generateMnemonicWallet(
  derivationPath = DEFAULT_DERIVATION_PATH,
): Promise<WalletResponse> {
  const created = Wallet.createRandom();
  const mnemonicPhrase = created.mnemonic?.phrase;
  if (!mnemonicPhrase) {
    return { ok: false, error: 'Unable to generate mnemonic phrase for new wallet.' };
  }

  const derived = HDNodeWallet.fromPhrase(mnemonicPhrase, undefined, derivationPath);
  const vault = await ensureVaultInitialized();
  const nextWallet: StoredWallet = {
    id: createWalletId(),
    name: `Wallet ${derived.address.slice(0, 6)}…${derived.address.slice(-4)}`,
    createdAt: new Date().toISOString(),
    privateKey: derived.privateKey,
    mnemonicPhrase,
    derivationPath,
  };
  await saveWalletVault([nextWallet, ...vault], nextWallet.id);
  await markUnlocked();

  return {
    ok: true,
    result: {
      account: derived.address,
      walletId: nextWallet.id,
      mnemonicPhrase,
      derivationPath,
    },
  };
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
    return {
      ok: true,
      result: vault.map((wallet) => ({
        id: wallet.id,
        name: wallet.name,
        address: new Wallet(wallet.privateKey).address,
        hasMnemonic: Boolean(wallet.mnemonicPhrase),
        createdAt: wallet.createdAt,
        isActive: wallet.id === activeWallet?.id,
      })),
    };
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
    const [derivationPath] = request.params ?? [];
    if (derivationPath !== undefined && typeof derivationPath !== 'string') {
      return { ok: false, error: 'wallet_generateMnemonicWallet derivation path must be a string.' };
    }
    return generateMnemonicWallet(derivationPath ?? DEFAULT_DERIVATION_PATH);
  }

  if (request.method === 'wallet_getNetwork') {
    return { ok: true, result: await getSelectedNetwork() };
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
  const account = wallet.address;
  await recordRequest(request, account);

  switch (request.method) {
    case 'ctzn_requestAccounts':
    case 'ctzn_accounts':
    case 'citizen_requestAccounts':
    case 'citizen_accounts':
      return { ok: true, result: [account] };
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
      const [loginParams] = request.params ?? [];
      if (loginParams !== undefined && (typeof loginParams !== 'object' || loginParams === null)) {
        return { ok: false, error: 'citizen_login expects an optional object param.' };
      }

      const payload = (loginParams ?? {}) as DappLoginParams;
      const origin = request.origin ?? 'unknown';
      const selectedNetwork = await getSelectedNetwork();
      const loginPayload = normalizeLoginPayload(origin, {
        ...payload,
        chainId: payload.chainId ?? NETWORKS[selectedNetwork].chainIdHex,
      });
      const message = buildLoginMessage(account, loginPayload);
      const signature = await wallet.signMessage(message);
      return {
        ok: true,
        result: {
          account,
          origin,
          message,
          signature,
          domain: loginPayload.domain,
          uri: loginPayload.uri,
          chainId: loginPayload.chainId,
          statement: loginPayload.statement,
          expirationTime: loginPayload.expirationTime ?? null,
          issuedAt: loginPayload.issuedAt,
          nonce: loginPayload.nonce,
        },
      };
    }
    case 'personal_sign': {
      const [rawMessage, requestedAccount] = request.params ?? [];
      const messageCandidateA = rawMessage;
      const messageCandidateB = requestedAccount;
      const message = typeof messageCandidateA === 'string'
        ? messageCandidateA
        : typeof messageCandidateB === 'string'
          ? messageCandidateB
          : null;
      const targetAccount = typeof messageCandidateA === 'string'
        ? requestedAccount
        : rawMessage;

      if (typeof message !== 'string') {
        return { ok: false, error: 'personal_sign requires message + account params' };
      }
      if (
        typeof targetAccount === 'string' &&
        targetAccount.toLowerCase() !== account.toLowerCase()
      ) {
        return { ok: false, error: 'Requested account does not match active wallet account' };
      }
      const signature = await wallet.signMessage(message);
      return { ok: true, result: signature };
    }
    case 'ctzn_signTypedData_v4': {
      const [requestedAccount, typedDataRaw] = request.params ?? [];
      if (
        typeof requestedAccount !== 'string' ||
        requestedAccount.toLowerCase() !== account.toLowerCase()
      ) {
        return { ok: false, error: 'Typed-data signing requires the active account as first param.' };
      }
      const typedData = parseTypedDataPayload(typedDataRaw);
      if (!typedData?.domain || !typedData?.types || !typedData?.message) {
        return { ok: false, error: 'Invalid typed payload for typed-data signing.' };
      }
      const { EIP712Domain: _ignoredDomain, ...types } = typedData.types;
      const signature = await wallet.signTypedData(typedData.domain, types, typedData.message);
      return { ok: true, result: signature };
    }
    case 'ctzn_getCitizenSigner': {
      const signer = await getOrCreateProtocolSigner();
      return {
        ok: true,
        result: {
          did: signer.did,
          verifyingKey: signer.verifyingKeyHex,
          algorithm: 'ed25519',
          createdAt: signer.createdAt,
        },
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
    default:
      return walletError('ERR_UNSUPPORTED_METHOD', `Unsupported method: ${request.method}`);
  }
}

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
