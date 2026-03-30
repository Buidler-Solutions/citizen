const DEFAULT_AUTH_API_URL = 'http://127.0.0.1:4499';
const DEFAULT_STORAGE_KEY = 'citizen.wallet.auth.session';
const DEFAULT_NETWORK = 'futurenet';
const DEFAULT_ONBOARDING_PATH = '/onboarding';

const normalizeWalletAddress = (address) => address.trim().toLowerCase();

export class WalletAuthClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletAuthClientError';
  }
}

export const detectWalletProvider = (windowObject) => windowObject.citizen ?? windowObject.ethereum ?? null;

const parseAccounts = (result) => (Array.isArray(result) ? result : []);

export class WalletAuthClient {
  constructor(options = {}) {
    this.authApiUrl = options.authApiUrl ?? DEFAULT_AUTH_API_URL;
    this.onboardingPath = options.onboardingPath ?? DEFAULT_ONBOARDING_PATH;
    this.network = options.network ?? DEFAULT_NETWORK;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.windowObject = options.windowObject;
  }

  getWindowObject() {
    if (this.windowObject) return this.windowObject;

    if (typeof window === 'undefined') {
      throw new WalletAuthClientError('Wallet auth can only run in a browser context.');
    }

    return window;
  }

  async requestChallenge(wallet) {
    const windowObject = this.getWindowObject();
    const payload = {
      wallet,
      domain: windowObject.location.host,
      uri: `${windowObject.location.origin}${this.onboardingPath}`,
      network: this.network,
    };

    const response = await fetch(`${this.authApiUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new WalletAuthClientError(`Challenge request failed with status ${response.status}.`);
    }

    return await response.json();
  }

  async verifySignature(payload) {
    const response = await fetch(`${this.authApiUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new WalletAuthClientError(`Signature verification failed with status ${response.status}.`);
    }

    return await response.json();
  }

  async loginWithBrowserWallet() {
    const windowObject = this.getWindowObject();
    const provider = detectWalletProvider(windowObject);

    if (!provider) {
      throw new WalletAuthClientError('Citizen wallet extension was not detected in this browser.');
    }

    const accountsResult = await provider.request({ method: 'eth_requestAccounts' });
    const accounts = parseAccounts(accountsResult);
    const selectedWallet = accounts[0];

    if (!selectedWallet) {
      throw new WalletAuthClientError('Wallet did not return an account.');
    }

    const challenge = await this.requestChallenge(selectedWallet);

    const signatureResult = await provider.request({
      method: 'personal_sign',
      params: [challenge.message, selectedWallet],
    });

    if (typeof signatureResult !== 'string' || !signatureResult.startsWith('0x')) {
      throw new WalletAuthClientError('Wallet returned an invalid signature.');
    }

    const verified = await this.verifySignature({
      challengeId: challenge.challengeId,
      wallet: selectedWallet,
      signature: signatureResult,
    });

    const token = verified.token?.trim();
    if (!token) {
      throw new WalletAuthClientError('Wallet auth backend did not return a session token.');
    }

    windowObject.localStorage?.setItem(this.storageKey, token);

    return {
      wallet: normalizeWalletAddress(selectedWallet),
      token,
      session: verified.session,
    };
  }

  getStoredToken() {
    const windowObject = this.getWindowObject();
    return windowObject.localStorage?.getItem(this.storageKey) ?? null;
  }

  clearStoredToken() {
    const windowObject = this.getWindowObject();
    windowObject.localStorage?.removeItem(this.storageKey);
  }
}

export const createWalletAuthClient = (options) => new WalletAuthClient(options);
