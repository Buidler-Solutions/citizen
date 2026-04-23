export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
    [key: string]: JsonValue | undefined;
};
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
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<any>;
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
export type BuilderCreditsPayload = {
    amount: number;
    multisig_proofs: MultisigProof[];
} | {
    amount: number;
    credit_grant_id: string;
    sponsorship_id: string;
    sponsored_did: string;
};
export interface ValidateBuilderCreditsPayloadArgs {
    action: BuilderCreditsAction | string;
    payload: Record<string, any>;
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
export declare function canonicalizeJson(value: any): string;
export declare function sha256DigestHex(input: any): Promise<string>;
export declare const OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES: readonly string[];
export declare function signCitizenPayloadWithWallet({ payload, provider }?: SignCitizenPayloadWithWalletArgs): Promise<WalletSignedPayload>;
export declare function createFormCommitmentReceipt({ formId, dataHash, encryptedFormUrl, commitmentReceipt }: CreateFormCommitmentReceiptArgs): {
    namespace: string;
    action: string;
    objectId: string;
    payload: {
        data_hash: string;
        encrypted_form_url: string;
        commitment_receipt: Record<string, unknown> | null;
    };
};
export declare function createMultisigCreditGrant({ builderId, amount, multisigProofs }: CreateMultisigCreditGrantArgs): {
    namespace: string;
    action: string;
    objectId: string;
    payload: {
        amount: number;
        multisig_proofs: MultisigProof[];
    };
};
export declare function createSponsorshipUsage({ builderId, amount, creditGrantId, sponsorshipId, sponsoredDid }: CreateSponsorshipUsageArgs): {
    namespace: string;
    action: string;
    objectId: string;
    payload: {
        amount: number;
        credit_grant_id: string;
        sponsorship_id: string;
        sponsored_did: string;
    };
};
export declare function validateBuilderCreditsPayload({ action, payload }: ValidateBuilderCreditsPayloadArgs): void;
export declare function wrapEnvelopeMulti({ entry, signer, coSigners, multisigPolicy, signatureScope, submittedAt }: WrapEnvelopeMultiArgs): Promise<EnvelopeRecord>;
export declare function appendCoSignature({ envelope, signer }: {
    envelope: EnvelopeRecord;
    signer: CitizenSigner;
}): Promise<EnvelopeRecord>;
export declare function finalizeEnvelope({ envelope }: {
    envelope: EnvelopeRecord;
}): EnvelopeRecord;
export declare class BrowserWalletSigner {
    constructor({ provider, account, requestMethod }?: {
        provider?: BrowserWalletProvider;
        account?: string;
        requestMethod?: string;
    });
    getSignerId(): Promise<any>;
    sign(message: any): Promise<any>;
}
export declare class Ed25519Signer {
    constructor({ signerId, privateKeyPem }: {
        signerId: string;
        privateKeyPem: string;
    });
    getSignerId(): Promise<any>;
    sign(message: any): Promise<string>;
}
export declare class CitizenNodeClient {
    #private;
    constructor({ baseUrl, apiKey, fetchImpl }?: CitizenNodeClientOptions);
    submitTransaction({ namespace, action, objectId, payload, signer, timestamp }: SubmitTransactionArgs): Promise<any>;
    submitWithBrowserWallet({ namespace, action, objectId, payload, walletProvider, account, requestMethod, timestamp }: SubmitWithBrowserWalletArgs): Promise<any>;
    signEntry(entry: any, signer: any): Promise<any>;
    wrapEnvelope({ entry, signer, submittedAt }: {
        entry: any;
        signer: any;
        submittedAt: any;
    }): Promise<{
        signature: any;
        envelope_id: `${string}-${string}-${string}-${string}-${string}`;
        signer: any;
        submitted_at: any;
        payload: any;
    }>;
    wrapEnvelopeMulti(args: any): Promise<EnvelopeRecord>;
    appendCoSignature(args: any): Promise<EnvelopeRecord>;
    finalizeEnvelope(args: any): EnvelopeRecord;
    submitEnvelope(envelope: any): Promise<any>;
    submitEnvelopeBatch(envelopes: any): Promise<any>;
    getReceipt(receiptId: any): Promise<any>;
    waitForReceipt(receiptId: any, { pollIntervalMs, timeoutMs, isTerminal }?: {
        pollIntervalMs?: number | undefined;
        timeoutMs?: number | undefined;
        isTerminal?: ((receipt: any) => boolean) | undefined;
    }): Promise<any>;
}
//# sourceMappingURL=index.d.ts.map