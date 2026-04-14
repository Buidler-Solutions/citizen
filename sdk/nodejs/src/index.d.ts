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
  signature_scope?: string;
  co_signatures?: EnvelopeCoSignature[];
  multisig_policy?: EnvelopeMultisigPolicy | null;
};

export type EnvelopeCoSignature = {
  signer: string;
  signature: string;
};

export type EnvelopeMultisigPolicy = {
  threshold: number;
  allowed_signers?: string[];
  require_author_signature?: boolean;
};

export type ReceiptEnvelope = {
  receipt?: {
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};


export type CitizenPayloadSignature = {
  signer: string;
  verifyingKey: string;
  signature: string;
  algorithm: string;
  signingPayload: string;
  payloadHash: string;
  payloadHashHex: string;
  signatureScope: 'payload_hash_v1' | 'canonical_payload_v1';
};

export type BuilderCreditMultisigProof = {
  approver: string;
  public_key: string;
  signature: string;
};

export type CreateMultisigCreditGrantRequest = {
  builderId: string;
  amount: number;
  multisigProofs: BuilderCreditMultisigProof[];
};

export type CreateSponsorshipUsageRequest = {
  builderId: string;
  amount: number;
  creditGrantId: string;
  sponsorshipId: string;
  sponsoredDid: string;
};

export type BuilderCreditsOperation = {
  namespace: "builder.credits";
  action: "MULTISIG_CREDIT_GRANT" | "SPONSOR_USAGE";
  objectId: string;
  payload: Record<string, unknown>;
};

export type CreateFormCommitmentReceiptRequest = {
  formId: string;
  dataHash: string;
  encryptedFormUrl: string;
  commitmentReceipt?: Record<string, unknown>;
};

export type FormCommitmentOperation = {
  namespace: "forms.commitment";
  action: "SUBMIT_COMMITMENT_RECEIPT";
  objectId: string;
  payload: {
    data_hash: string;
    encrypted_form_url: string;
    commitment_receipt: Record<string, unknown> | null;
  };
};

export const OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES: readonly string[];
export function canonicalizeJson(value: unknown): string;
export function sha256DigestHex(input: string | Uint8Array): Promise<string>;
export function signCitizenPayloadWithWallet(args: { payload: unknown; provider?: WalletProvider }): Promise<CitizenPayloadSignature>;
export function createFormCommitmentReceipt(args: CreateFormCommitmentReceiptRequest): FormCommitmentOperation;
export function createMultisigCreditGrant(args: CreateMultisigCreditGrantRequest): BuilderCreditsOperation;
export function createSponsorshipUsage(args: CreateSponsorshipUsageRequest): BuilderCreditsOperation;
export function validateBuilderCreditsPayload(args: {
  action: string;
  payload: Record<string, unknown>;
}): void;
export function wrapEnvelopeMulti(args: {
  entry: LedgerEntry;
  signer: Signer;
  coSigners?: Signer[];
  multisigPolicy: EnvelopeMultisigPolicy;
  signatureScope?: "canonical_payload_v1";
  submittedAt?: string;
}): Promise<SignedEnvelope>;
export function appendCoSignature(args: {
  envelope: SignedEnvelope;
  signer: Signer;
}): Promise<SignedEnvelope>;
export function finalizeEnvelope(args: { envelope: SignedEnvelope }): SignedEnvelope;

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
    requestMethod?: string;
    timestamp?: number;
  }): Promise<unknown>;
  signEntry(entry: LedgerEntry, signer: Signer): Promise<LedgerEntry>;
  wrapEnvelope(args: { entry: LedgerEntry; signer: Signer; submittedAt?: string }): Promise<SignedEnvelope>;
  wrapEnvelopeMulti(args: {
    entry: LedgerEntry;
    signer: Signer;
    coSigners?: Signer[];
    multisigPolicy: EnvelopeMultisigPolicy;
    signatureScope?: "canonical_payload_v1";
    submittedAt?: string;
  }): Promise<SignedEnvelope>;
  appendCoSignature(args: { envelope: SignedEnvelope; signer: Signer }): Promise<SignedEnvelope>;
  finalizeEnvelope(args: { envelope: SignedEnvelope }): SignedEnvelope;
  submitEnvelope(envelope: SignedEnvelope): Promise<unknown>;
  submitEnvelopeBatch(envelopes: SignedEnvelope[]): Promise<unknown>;
  getReceipt(receiptId: string): Promise<unknown>;
  waitForReceipt(
    receiptId: string,
    args?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      isTerminal?: (receipt: ReceiptEnvelope) => boolean;
    }
  ): Promise<ReceiptEnvelope>;
}
