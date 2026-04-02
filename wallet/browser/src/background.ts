import { HDNodeWallet, Wallet } from 'ethers';
import {
  createDappSigningRequestEnvelope,
  signingPreimageFromEnvelope,
} from './dappSigningRequest';

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

const STORAGE_KEY = 'citizen.browser.wallet.v1';
const LAST_REQUEST_KEY = 'citizen.browser.wallet.last_request.v1';
const ACTIVITY_KEY = 'citizen.browser.wallet.activity.v1';
const VAULT_KEY = 'citizen.browser.wallet.vault.v1';
const ACTIVE_WALLET_ID_KEY = 'citizen.browser.wallet.active_wallet_id.v1';
const PASSWORD_HASH_KEY = 'citizen.browser.wallet.password_hash.v1';
const SESSION_UNLOCKED_KEY = 'citizen.browser.wallet.unlocked.v1';
const NETWORK_KEY = 'citizen.browser.wallet.network.v1';
const PROTOCOL_SIGNER_KEY = 'citizen.browser.wallet.protocol_signer.v1';
const DEFAULT_DERIVATION_PATH = "m/44'/930'/0'/0'/0'";
const MAX_ACTIVITY = 100;

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

function isExtensionUiMessage(sender: chrome.runtime.MessageSender): boolean {
  const expected = chrome.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(expected);
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

async function signCitizenPayload(
  rawPayload: unknown,
  request: WalletRequest,
  sender: chrome.runtime.MessageSender,
): Promise<WalletResponse> {
  const signer = await getOrCreateProtocolSigner();
  const envelope = await createDappSigningRequestEnvelope({
    origin: request.origin,
    tabUrl: sender.url ?? sender.tab?.url ?? null,
    payload: rawPayload,
  });
  const preimage = signingPreimageFromEnvelope(envelope);
  const payloadBytes = new TextEncoder().encode(preimage);
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
      preimage,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      riskFlags: envelope.riskFlags,
      algorithm: 'ed25519',
      signatureScope: 'payload_hash_v1',
    },
  };
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
    return { ok: false, error: 'Wallet is locked. Open the extension side panel to unlock.' };
  }

  if (
    isDappRequest
    && shouldPromptWalletUi(request.method)
    && !(await hasStoredWallet())
  ) {
    return {
      ok: false,
      error: 'Wallet is not configured. Open the extension side panel to create or import a wallet first.',
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
        return { ok: false, error: 'ctzn_signCitizenTx requires a payload object or canonical JSON string.' };
      }
      return signCitizenPayload(payload, request, sender);
    }
    default:
      return { ok: false, error: `Unsupported method: ${request.method}` };
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
