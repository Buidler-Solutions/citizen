export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export interface WalletAuthWindow {
  citizen?: WalletProvider;
  ctzn?: WalletProvider;
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

export declare class WalletAuthClientError extends Error {
  constructor(message: string);
}

export declare const detectWalletProvider: (windowObject: WalletAuthWindow) => WalletProvider | null;

export declare class WalletAuthClient {
  constructor(options?: WalletAuthClientOptions);
  requestChallenge(wallet: string): Promise<WalletAuthChallengeResponse>;
  verifySignature(payload: WalletAuthVerifyRequest): Promise<WalletAuthVerifyResponse>;
  loginWithBrowserWallet(): Promise<WalletLoginResult>;
  getStoredToken(): string | null;
  clearStoredToken(): void;
}

export declare const createWalletAuthClient: (options?: WalletAuthClientOptions) => WalletAuthClient;
