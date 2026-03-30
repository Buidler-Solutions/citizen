export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export interface WalletAuthWindow {
  citizen?: WalletProvider;
  ethereum?: WalletProvider;
  location: {
    host: string;
    origin: string;
  };
  localStorage?: Storage;
}

export interface WalletAuthClientOptions {
  authApiUrl?: string;
  onboardingPath?: string;
  network?: string;
  storageKey?: string;
  windowObject?: WalletAuthWindow;
}

export interface WalletAuthChallengeRequest {
  wallet: string;
  domain: string;
  uri: string;
  network: string;
}

export interface WalletAuthChallengeResponse {
  challengeId: string;
  nonce: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

export interface WalletAuthVerifyRequest {
  challengeId: string;
  wallet: string;
  signature: string;
}

export interface WalletAuthVerifyResponse {
  status: 'authenticated';
  token: string;
  session?: {
    sessionId?: string;
    wallet?: string;
    network?: string;
    expiresAt?: string;
  };
}

export interface WalletLoginResult {
  wallet: string;
  token: string;
  session?: WalletAuthVerifyResponse['session'];
}

export class WalletAuthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletAuthClientError';
  }
}

const DEFAULT_AUTH_API_URL = 'http://127.0.0.1:4499';
const DEFAULT_STORAGE_KEY = 'citizen.wallet.auth.session';
const DEFAULT_NETWORK = 'futurenet';
const DEFAULT_ONBOARDING_PATH = '/onboarding';

const normalizeWalletAddress = (address: string) => address.trim().toLowerCase();

export const detectWalletProvider = (windowObject: WalletAuthWindow): WalletProvider | null => (
  windowObject.citizen ?? windowObject.ethereum ?? null
);

const parseAccounts = (result: unknown): string[] => (Array.isArray(result) ? (result as string[]) : []);

export class WalletAuthClient {
  private readonly authApiUrl: string;

  private readonly onboardingPath: string;

  private readonly network: string;

  private readonly storageKey: string;

  private readonly windowObject?: WalletAuthWindow;

  constructor(options: WalletAuthClientOptions = {}) {
    this.authApiUrl = options.authApiUrl ?? DEFAULT_AUTH_API_URL;
    this.onboardingPath = options.onboardingPath ?? DEFAULT_ONBOARDING_PATH;
    this.network = options.network ?? DEFAULT_NETWORK;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.windowObject = options.windowObject;
  }

  private getWindowObject(): WalletAuthWindow {
    if (this.windowObject) return this.windowObject;

    if (typeof window === 'undefined') {
      throw new WalletAuthClientError('Wallet auth can only run in a browser context.');
    }

    return window as unknown as WalletAuthWindow;
  }

  async requestChallenge(wallet: string): Promise<WalletAuthChallengeResponse> {
    const windowObject = this.getWindowObject();
    const payload: WalletAuthChallengeRequest = {
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

    return (await response.json()) as WalletAuthChallengeResponse;
  }

  async verifySignature(payload: WalletAuthVerifyRequest): Promise<WalletAuthVerifyResponse> {
    const response = await fetch(`${this.authApiUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new WalletAuthClientError(`Signature verification failed with status ${response.status}.`);
    }

    return (await response.json()) as WalletAuthVerifyResponse;
  }

  async loginWithBrowserWallet(): Promise<WalletLoginResult> {
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

  getStoredToken(): string | null {
    const windowObject = this.getWindowObject();
    return windowObject.localStorage?.getItem(this.storageKey) ?? null;
  }

  clearStoredToken(): void {
    const windowObject = this.getWindowObject();
    windowObject.localStorage?.removeItem(this.storageKey);
  }
}

export const createWalletAuthClient = (options?: WalletAuthClientOptions) => new WalletAuthClient(options);
