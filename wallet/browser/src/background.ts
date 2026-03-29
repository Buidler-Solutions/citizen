import { HDNodeWallet, Wallet } from 'ethers';

type WalletRequest = {
  method: string;
  params?: unknown[];
  origin?: string;
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
};

type StoredWallet = {
  privateKey: string;
  mnemonicPhrase?: string;
  derivationPath?: string;
};

const STORAGE_KEY = 'citizen.browser.wallet.v1';
const LAST_REQUEST_KEY = 'citizen.browser.wallet.last_request.v1';
const PASSWORD_HASH_KEY = 'citizen.browser.wallet.password_hash.v1';
const SESSION_UNLOCKED_KEY = 'citizen.browser.wallet.unlocked.v1';
const NETWORK_KEY = 'citizen.browser.wallet.network.v1';
const DEFAULT_DERIVATION_PATH = "m/44'/930'/0'/0'/0'";

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

function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && value in NETWORKS;
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

async function getStoredWallet(): Promise<WalletSigner> {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  const stored = existing[STORAGE_KEY] as StoredWallet | undefined;

  if (stored?.mnemonicPhrase) {
    const derived = HDNodeWallet.fromPhrase(
      stored.mnemonicPhrase,
      undefined,
      stored.derivationPath ?? DEFAULT_DERIVATION_PATH,
    );
    if (stored.privateKey !== derived.privateKey) {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          privateKey: derived.privateKey,
          mnemonicPhrase: stored.mnemonicPhrase,
          derivationPath: stored.derivationPath ?? DEFAULT_DERIVATION_PATH,
        } satisfies StoredWallet,
      });
    }
    return derived;
  }

  if (stored?.privateKey) {
    return new Wallet(stored.privateKey);
  }

  const created = Wallet.createRandom();
  const mnemonicPhrase = created.mnemonic?.phrase;
  const derived = mnemonicPhrase
    ? HDNodeWallet.fromPhrase(mnemonicPhrase, undefined, DEFAULT_DERIVATION_PATH)
    : created;
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      privateKey: derived.privateKey,
      mnemonicPhrase,
      derivationPath: DEFAULT_DERIVATION_PATH,
    } satisfies StoredWallet,
  });
  return derived;
}

async function recordRequest(request: WalletRequest, account: string) {
  await chrome.storage.local.set({
    [LAST_REQUEST_KEY]: {
      requestedAt: new Date().toISOString(),
      origin: request.origin ?? 'unknown',
      method: request.method,
      params: request.params ?? [],
      account,
    },
  });
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

  const existing = await chrome.storage.local.get(STORAGE_KEY);
  const stored = existing[STORAGE_KEY] as StoredWallet | undefined;
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

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      privateKey: derived.privateKey,
      mnemonicPhrase: normalizedPhrase,
      derivationPath,
    } satisfies StoredWallet,
  });
  await markUnlocked();

  return {
    ok: true,
    result: {
      account: derived.address,
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
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      privateKey: derived.privateKey,
      mnemonicPhrase,
      derivationPath,
    } satisfies StoredWallet,
  });
  await markUnlocked();

  return {
    ok: true,
    result: {
      account: derived.address,
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

  if (request.method === 'wallet_isPasswordSet') {
    return { ok: true, result: (await getPasswordHash()) !== null };
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

  const wallet = await getStoredWallet();
  const account = wallet.address;
  await recordRequest(request, account);

  switch (request.method) {
    case 'citizen_requestAccounts':
    case 'citizen_accounts':
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return { ok: true, result: [account] };
    case 'citizen_chainId':
    case 'eth_chainId':
      return { ok: true, result: NETWORKS[await getSelectedNetwork()].chainIdHex };
    case 'personal_sign': {
      const [rawMessage, requestedAccount] = request.params ?? [];
      if (typeof rawMessage !== 'string') {
        return { ok: false, error: 'personal_sign requires message as first param' };
      }
      if (
        typeof requestedAccount === 'string' &&
        requestedAccount.toLowerCase() !== account.toLowerCase()
      ) {
        return { ok: false, error: 'Requested account does not match active wallet account' };
      }
      const signature = await wallet.signMessage(rawMessage);
      return { ok: true, result: signature };
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
