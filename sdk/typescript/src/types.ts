export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface CitizenSigner {
  getSignerId(): Promise<string>;
  sign(message: string): Promise<string>;
}

export interface MultisigPolicy {
  threshold: number;
  allowed_signers?: string[];
  require_author_signature?: boolean;
}

export interface EntryRecord {
  entry_id: string;
  namespace: string;
  action: string;
  object_id: string;
  payload: Record<string, unknown>;
  author: string;
  timestamp: number;
  signature?: string;
  replay_protection?: {
    request_id: string;
    expires_at?: number;
  };
}

export interface CoSignature {
  signer: string;
  signature: string;
}

export interface EnvelopeRecord {
  envelope_id: string;
  signer: string;
  signature?: string;
  signature_scope?: "canonical_payload_v1" | "canonical_payload_v2";
  co_signatures?: CoSignature[];
  multisig_policy?: MultisigPolicy;
  submitted_at: string;
  payload: EntryRecord;
}

export interface WrapEnvelopeMultiArgs {
  entry: EntryRecord;
  signer: CitizenSigner;
  coSigners?: CitizenSigner[];
  multisigPolicy: MultisigPolicy;
  signatureScope?: "canonical_payload_v1" | "canonical_payload_v2";
  submittedAt?: string;
}

export interface BrowserWalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletSignedPayload {
  signer: string;
  verifyingKey: string;
  signature: string;
  algorithm: string;
  signingPayload: string;
  payloadHash: string;
  payloadHashHex: string;
  signatureScope: "canonical_payload_v1" | "payload_hash_v1";
}

export interface SignCitizenPayloadWithWalletArgs {
  payload: Record<string, unknown>;
  provider?: BrowserWalletProvider;
}

export interface CreateFormCommitmentReceiptArgs {
  formId: string;
  dataHash: string;
  encryptedFormUrl: string;
  commitmentReceipt?: Record<string, unknown>;
}

export interface MultisigProof {
  approver: string;
  public_key: string;
  signature: string;
}

export interface CreateMultisigCreditGrantArgs {
  builderId: string;
  amount: number;
  multisigProofs: MultisigProof[];
}

export interface CreateSponsorshipUsageArgs {
  builderId: string;
  amount: number;
  creditGrantId: string;
  sponsorshipId: string;
  sponsoredDid: string;
}

export type BuilderCreditsAction = "MULTISIG_CREDIT_GRANT" | "SPONSOR_USAGE";
export type BuilderCreditsPayload =
  | { amount: number; multisig_proofs: MultisigProof[] }
  | { amount: number; credit_grant_id: string; sponsorship_id: string; sponsored_did: string };

export interface ValidateBuilderCreditsPayloadArgs {
  action: BuilderCreditsAction | string;
  payload: Record<string, unknown>;
}

export interface CitizenNodeClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface SubmitTransactionArgs {
  namespace: string;
  action: string;
  objectId: string;
  payload?: Record<string, unknown>;
  signer: CitizenSigner;
  timestamp?: number;
}

export interface SubmitWithBrowserWalletArgs {
  namespace: string;
  action: string;
  objectId: string;
  payload?: Record<string, unknown>;
  walletProvider?: BrowserWalletProvider;
  account?: string;
  requestMethod?: string;
  timestamp?: number;
}

export interface WaitForReceiptOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  isTerminal?: (receipt: unknown) => boolean;
}
