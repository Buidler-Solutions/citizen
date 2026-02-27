export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export type Signer = {
  getSignerId: () => Promise<string>;
  sign: (message: string) => Promise<string>;
};

export type LedgerEntry = {
  entry_id: string;
  namespace: string;
  action: string;
  object_id: string;
  payload: Record<string, unknown>;
  author: string;
  signature?: string;
  timestamp: number;
};

export type SignedEnvelope = {
  envelope_id: string;
  signer: string;
  submitted_at: string;
  payload: LedgerEntry;
  signature: string;
};

export function canonicalizeJson(value: unknown): string;

export class BrowserWalletSigner implements Signer {
  constructor(args?: { provider?: WalletProvider; account?: string; requestMethod?: string });
  getSignerId(): Promise<string>;
  sign(message: string): Promise<string>;
}

export class Ed25519Signer implements Signer {
  constructor(args: { signerId: string; privateKeyPem: string });
  getSignerId(): Promise<string>;
  sign(message: string): Promise<string>;
}

export class CitizenNodeClient {
  constructor(args: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch });
  submitTransaction(args: {
    namespace: string;
    action: string;
    objectId: string;
    payload?: Record<string, unknown>;
    signer: Signer;
    timestamp?: number;
  }): Promise<unknown>;
  submitWithBrowserWallet(args: {
    namespace: string;
    action: string;
    objectId: string;
    payload?: Record<string, unknown>;
    walletProvider?: WalletProvider;
    account?: string;
    timestamp?: number;
  }): Promise<unknown>;
  signEntry(entry: LedgerEntry, signer: Signer): Promise<LedgerEntry>;
  wrapEnvelope(args: { entry: LedgerEntry; signer: Signer; submittedAt?: string }): Promise<SignedEnvelope>;
  submitEnvelope(envelope: SignedEnvelope): Promise<unknown>;
  getReceipt(receiptId: string): Promise<unknown>;
}
