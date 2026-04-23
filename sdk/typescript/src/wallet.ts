import type {
  BrowserWalletProvider,
  SignCitizenPayloadWithWalletArgs,
  WalletSignedPayload
} from "./types.js";

function resolveWalletProvider(explicitProvider?: BrowserWalletProvider): BrowserWalletProvider {
  if (explicitProvider) {
    return explicitProvider;
  }

  if (typeof window === "undefined") {
    throw new Error("Browser wallet provider is unavailable outside a browser context");
  }

  const walletWindow = window as Window & {
    citizen?: BrowserWalletProvider;
    ctzn?: BrowserWalletProvider;
  };

  const provider = walletWindow.citizen ?? walletWindow.ctzn;
  if (!provider || typeof provider.request !== "function") {
    throw new Error("Citizen wallet extension provider was not found on window.citizen/window.ctzn");
  }

  return provider;
}

export async function signCitizenPayloadWithWallet(
  { payload, provider }: SignCitizenPayloadWithWalletArgs = {} as SignCitizenPayloadWithWalletArgs
): Promise<WalletSignedPayload> {
  const walletProvider = resolveWalletProvider(provider);
  if (payload === undefined || payload === null) {
    throw new Error("payload is required");
  }

  const [signerProfile, signingResult] = await Promise.all([
    walletProvider.request({ method: "ctzn_getCitizenSigner" }),
    walletProvider.request({ method: "ctzn_signCitizenTx", params: [payload] })
  ]);

  const signerProfileObj = signerProfile as { did?: string; verifyingKey?: string };
  const signingResultObj = signingResult as {
    signer?: string;
    verifyingKey?: string;
    signature?: string;
    signingPayload?: string;
    payloadHash?: string;
    payloadHashHex?: string;
    algorithm?: string;
    signatureScope?: string;
  };

  const signerDid = signingResultObj.signer ?? signerProfileObj.did;
  const verifyingKey = signingResultObj.verifyingKey ?? signerProfileObj.verifyingKey;
  const payloadHash = signingResultObj.payloadHash;

  if (typeof signerDid !== "string" || !signerDid) {
    throw new Error("Wallet did not return a valid Citizen signer DID");
  }
  if (typeof verifyingKey !== "string" || !verifyingKey) {
    throw new Error("Wallet did not return a valid Citizen verifying key");
  }
  if (typeof signingResultObj.signature !== "string" || !signingResultObj.signature) {
    throw new Error("Wallet did not return a valid Citizen payload signature");
  }
  if (typeof signingResultObj.signingPayload !== "string" || !signingResultObj.signingPayload) {
    throw new Error("Wallet did not return canonical signing payload");
  }
  if (typeof payloadHash !== "string" || !payloadHash.startsWith("sha256:")) {
    throw new Error("Wallet did not return a runtime-formatted payloadHash");
  }

  return {
    signer: signerDid,
    verifyingKey,
    signature: signingResultObj.signature,
    algorithm: signingResultObj.algorithm ?? "ed25519",
    signingPayload: signingResultObj.signingPayload,
    payloadHash,
    payloadHashHex: signingResultObj.payloadHashHex ?? payloadHash.replace("sha256:", ""),
    signatureScope:
      signingResultObj.signatureScope === "canonical_payload_v1"
        ? "canonical_payload_v1"
        : "payload_hash_v1"
  };
}

export class BrowserWalletSigner {
  private provider: BrowserWalletProvider;
  private account: string | undefined;
  private requestMethod: string;

  constructor({
    provider,
    account,
    requestMethod = "personal_sign"
  }: {
    provider?: BrowserWalletProvider;
    account?: string;
    requestMethod?: string;
  } = {}) {
    this.provider = resolveWalletProvider(provider);
    this.account = account?.toLowerCase();
    this.requestMethod = requestMethod;
  }

  async getSignerId(): Promise<string> {
    if (this.account) {
      return this.account;
    }

    const accounts = await this.provider.request({ method: "citizen_requestAccounts" });
    if (!Array.isArray(accounts) || !accounts[0] || typeof accounts[0] !== "string") {
      throw new Error("Wallet provider did not return an account");
    }

    this.account = accounts[0].toLowerCase();
    return this.account;
  }

  async sign(message: string): Promise<string> {
    const account = await this.getSignerId();
    return this.provider.request({
      method: this.requestMethod,
      params: [message, account]
    }) as Promise<string>;
  }
}
