export declare function canonicalizeJson(value: any): string;
export declare function sha256DigestHex(input: any): Promise<string>;
export declare const OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES: readonly string[];
export declare function signCitizenPayloadWithWallet({ payload, provider }?: {}): Promise<{
    signer: string;
    verifyingKey: string;
    signature: any;
    algorithm: any;
    signingPayload: any;
    payloadHash: string;
    payloadHashHex: any;
    signatureScope: string;
}>;
export declare function createFormCommitmentReceipt({ formId, dataHash, encryptedFormUrl, commitmentReceipt }: {
    formId: any;
    dataHash: any;
    encryptedFormUrl: any;
    commitmentReceipt: any;
}): {
    namespace: string;
    action: string;
    objectId: any;
    payload: {
        data_hash: any;
        encrypted_form_url: any;
        commitment_receipt: any;
    };
};
export declare function createMultisigCreditGrant({ builderId, amount, multisigProofs }: {
    builderId: any;
    amount: any;
    multisigProofs: any;
}): {
    namespace: string;
    action: string;
    objectId: any;
    payload: {
        amount: any;
        multisig_proofs: any;
    };
};
export declare function createSponsorshipUsage({ builderId, amount, creditGrantId, sponsorshipId, sponsoredDid }: {
    builderId: any;
    amount: any;
    creditGrantId: any;
    sponsorshipId: any;
    sponsoredDid: any;
}): {
    namespace: string;
    action: string;
    objectId: any;
    payload: {
        amount: any;
        credit_grant_id: any;
        sponsorship_id: any;
        sponsored_did: any;
    };
};
export declare function validateBuilderCreditsPayload({ action, payload }: {
    action: any;
    payload: any;
}): void;
export declare function wrapEnvelopeMulti({ entry, signer, coSigners, multisigPolicy, signatureScope, submittedAt }: {
    entry: any;
    signer: any;
    coSigners?: never[] | undefined;
    multisigPolicy: any;
    signatureScope?: string | undefined;
    submittedAt: any;
}): Promise<{
    envelope_id: `${string}-${string}-${string}-${string}-${string}`;
    signer: any;
    signature: any;
    signature_scope: string;
    co_signatures: {
        signer: any;
        signature: any;
    }[];
    multisig_policy: any;
    submitted_at: any;
    payload: any;
}>;
export declare function appendCoSignature({ envelope, signer }: {
    envelope: any;
    signer: any;
}): Promise<any>;
export declare function finalizeEnvelope({ envelope }: {
    envelope: any;
}): any;
export declare class BrowserWalletSigner {
    constructor({ provider, account, requestMethod }?: {
        requestMethod?: string | undefined;
    });
    getSignerId(): Promise<any>;
    sign(message: any): Promise<any>;
}
export declare class Ed25519Signer {
    constructor({ signerId, privateKeyPem }: {
        signerId: any;
        privateKeyPem: any;
    });
    getSignerId(): Promise<any>;
    sign(message: any): Promise<string>;
}
export declare class CitizenNodeClient {
    #private;
    constructor({ baseUrl, apiKey, fetchImpl }?: {});
    submitTransaction({ namespace, action, objectId, payload, signer, timestamp }: {
        namespace: any;
        action: any;
        objectId: any;
        payload: any;
        signer: any;
        timestamp: any;
    }): Promise<any>;
    submitWithBrowserWallet({ namespace, action, objectId, payload, walletProvider, account, requestMethod, timestamp }: {
        namespace: any;
        action: any;
        objectId: any;
        payload: any;
        walletProvider: any;
        account: any;
        requestMethod: any;
        timestamp: any;
    }): Promise<any>;
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
    wrapEnvelopeMulti(args: any): Promise<{
        envelope_id: `${string}-${string}-${string}-${string}-${string}`;
        signer: any;
        signature: any;
        signature_scope: string;
        co_signatures: {
            signer: any;
            signature: any;
        }[];
        multisig_policy: any;
        submitted_at: any;
        payload: any;
    }>;
    appendCoSignature(args: any): Promise<any>;
    finalizeEnvelope(args: any): any;
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