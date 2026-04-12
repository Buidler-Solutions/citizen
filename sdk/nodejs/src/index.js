function hasWebCrypto() {
  return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function";
}

function createUuid() {
  if (hasWebCrypto()) {
    return globalThis.crypto.randomUUID();
  }

  throw new Error("crypto.randomUUID is required (Node.js 18+ or modern browser)");
}

function canonicalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }

  if (value && typeof value === "object") {
    const orderedEntries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)]);

    return Object.fromEntries(orderedEntries);
  }

  return value;
}

export function canonicalizeJson(value) {
  return JSON.stringify(canonicalizeValue(value));
}

export async function sha256DigestHex(input) {
  const source = typeof input === "string" ? new TextEncoder().encode(input) : input;

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
    return `sha256:${Buffer.from(digest).toString("hex")}`;
  }

  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

const DEFAULT_RECEIPT_TERMINAL_STATUSES = new Set(["Accepted", "Rejected"]);
export const OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveWalletProvider(explicitProvider) {
  if (explicitProvider) {
    return explicitProvider;
  }

  if (typeof window === "undefined") {
    throw new Error("Browser wallet provider is unavailable outside a browser context");
  }

  const provider = window.citizen ?? window.ctzn;
  if (!provider || typeof provider.request !== "function") {
    throw new Error("Citizen wallet extension provider was not found on window.citizen/window.ctzn");
  }

  return provider;
}


export async function signCitizenPayloadWithWallet({ payload, provider } = {}) {
  const walletProvider = resolveWalletProvider(provider);
  if (payload === undefined || payload === null) {
    throw new Error("payload is required");
  }

  const [signerProfile, signingResult] = await Promise.all([
    walletProvider.request({ method: "ctzn_getCitizenSigner" }),
    walletProvider.request({ method: "ctzn_signCitizenTx", params: [payload] })
  ]);

  const signerDid = signingResult?.signer ?? signerProfile?.did;
  const verifyingKey = signingResult?.verifyingKey ?? signerProfile?.verifyingKey;
  const payloadHash = signingResult?.payloadHash;

  if (typeof signerDid !== "string" || !signerDid) {
    throw new Error("Wallet did not return a valid Citizen signer DID");
  }
  if (typeof verifyingKey !== "string" || !verifyingKey) {
    throw new Error("Wallet did not return a valid Citizen verifying key");
  }
  if (typeof signingResult?.signature !== "string" || !signingResult.signature) {
    throw new Error("Wallet did not return a valid Citizen payload signature");
  }
  if (typeof signingResult?.signingPayload !== "string" || !signingResult.signingPayload) {
    throw new Error("Wallet did not return canonical signing payload");
  }
  if (typeof payloadHash !== "string" || !payloadHash.startsWith("sha256:")) {
    throw new Error("Wallet did not return a runtime-formatted payloadHash");
  }

  return {
    signer: signerDid,
    verifyingKey,
    signature: signingResult.signature,
    algorithm: signingResult.algorithm ?? "ed25519",
    signingPayload: signingResult.signingPayload,
    payloadHash,
    payloadHashHex: signingResult.payloadHashHex ?? payloadHash.replace("sha256:", ""),
    signatureScope: signingResult.signatureScope === "canonical_payload_v1" ? "canonical_payload_v1" : "payload_hash_v1"
  };
}

function assertPositiveAmount(payload) {
  if (!payload || typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
    throw new Error("builder.credits payload.amount must be a positive number");
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertSha256Digest(value, field) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{6,}$/i.test(value)) {
    throw new Error(`${field} must be a sha256:<hex> digest string`);
  }
}

function assertHttpUrl(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty URL`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid http(s) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must be a valid http(s) URL`);
  }
}

export function createFormCommitmentReceipt({
  formId,
  dataHash,
  encryptedFormUrl,
  commitmentReceipt
}) {
  assertNonEmptyString(formId, "formId");
  assertSha256Digest(dataHash, "dataHash");
  assertHttpUrl(encryptedFormUrl, "encryptedFormUrl");

  if (commitmentReceipt !== undefined && (typeof commitmentReceipt !== "object" || commitmentReceipt === null || Array.isArray(commitmentReceipt))) {
    throw new Error("commitmentReceipt must be an object when provided");
  }

  return {
    namespace: "forms.commitment",
    action: "SUBMIT_COMMITMENT_RECEIPT",
    objectId: formId,
    payload: {
      data_hash: dataHash,
      encrypted_form_url: encryptedFormUrl,
      commitment_receipt: commitmentReceipt ?? null
    }
  };
}

export function createMultisigCreditGrant({ builderId, amount, multisigProofs }) {
  assertNonEmptyString(builderId, "builderId");

  const payload = {
    amount,
    multisig_proofs: multisigProofs
  };

  validateBuilderCreditsPayload({ action: "MULTISIG_CREDIT_GRANT", payload });

  return {
    namespace: "builder.credits",
    action: "MULTISIG_CREDIT_GRANT",
    objectId: builderId,
    payload
  };
}

export function createSponsorshipUsage({ builderId, amount, creditGrantId, sponsorshipId, sponsoredDid }) {
  assertNonEmptyString(builderId, "builderId");

  const payload = {
    amount,
    credit_grant_id: creditGrantId,
    sponsorship_id: sponsorshipId,
    sponsored_did: sponsoredDid
  };

  validateBuilderCreditsPayload({ action: "SPONSOR_USAGE", payload });

  return {
    namespace: "builder.credits",
    action: "SPONSOR_USAGE",
    objectId: builderId,
    payload
  };
}

export function validateBuilderCreditsPayload({ action, payload }) {
  assertNonEmptyString(action, "action");

  if (action === "MULTISIG_CREDIT_GRANT") {
    assertPositiveAmount(payload);
    if (!Array.isArray(payload.multisig_proofs) || payload.multisig_proofs.length === 0) {
      throw new Error("MULTISIG_CREDIT_GRANT requires payload.multisig_proofs");
    }

    for (const [index, proof] of payload.multisig_proofs.entries()) {
      if (!proof || typeof proof !== "object") {
        throw new Error(`payload.multisig_proofs[${index}] must be an object`);
      }

      assertNonEmptyString(proof.approver, `payload.multisig_proofs[${index}].approver`);
      assertNonEmptyString(proof.public_key, `payload.multisig_proofs[${index}].public_key`);
      assertNonEmptyString(proof.signature, `payload.multisig_proofs[${index}].signature`);
    }

    return;
  }

  if (action === "SPONSOR_USAGE") {
    assertPositiveAmount(payload);
    assertNonEmptyString(payload.credit_grant_id, "payload.credit_grant_id");
    assertNonEmptyString(payload.sponsorship_id, "payload.sponsorship_id");
    assertNonEmptyString(payload.sponsored_did, "payload.sponsored_did");
  }
}

export class BrowserWalletSigner {
  constructor({ provider, account, requestMethod = "personal_sign" } = {}) {
    this.provider = resolveWalletProvider(provider);
    this.account = account?.toLowerCase();
    this.requestMethod = requestMethod;
  }

  async getSignerId() {
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

  async sign(message) {
    const account = await this.getSignerId();
    return this.provider.request({
      method: this.requestMethod,
      params: [message, account]
    });
  }
}

export class Ed25519Signer {
  constructor({ signerId, privateKeyPem }) {
    if (!signerId) {
      throw new Error("signerId is required");
    }

    if (!privateKeyPem) {
      throw new Error("privateKeyPem is required");
    }

    this.signerId = signerId;
    this.privateKeyPem = privateKeyPem;
  }

  async getSignerId() {
    return this.signerId;
  }

  async sign(message) {
    const { createPrivateKey, sign } = await import("node:crypto");
    const privateKey = createPrivateKey(this.privateKeyPem);
    const signature = sign(null, Buffer.from(message), privateKey);
    return `ed25519:${signature.toString("base64")}`;
  }
}

export class CitizenNodeClient {
  constructor({ baseUrl, apiKey, fetchImpl } = {}) {
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new Error("fetch implementation was not found");
    }
  }

  async submitTransaction({ namespace, action, objectId, payload, signer, timestamp }) {
    if (!namespace || !action || !objectId || !signer) {
      throw new Error("namespace, action, objectId, and signer are required");
    }

    if (namespace === "builder.credits") {
      validateBuilderCreditsPayload({ action, payload: payload ?? {} });
    }

    const signerId = await signer.getSignerId();
    const entry = {
      entry_id: createUuid(),
      namespace,
      action,
      object_id: objectId,
      payload: payload ?? {},
      author: signerId,
      timestamp: timestamp ?? Math.floor(Date.now() / 1000)
    };

    const signedEntry = await this.signEntry(entry, signer);
    const envelope = await this.wrapEnvelope({ entry: signedEntry, signer });
    return this.submitEnvelope(envelope);
  }

  async submitWithBrowserWallet({
    namespace,
    action,
    objectId,
    payload,
    walletProvider,
    account,
    requestMethod,
    timestamp
  }) {
    const signer = new BrowserWalletSigner({
      provider: walletProvider,
      account,
      requestMethod
    });
    return this.submitTransaction({ namespace, action, objectId, payload, signer, timestamp });
  }

  async signEntry(entry, signer) {
    const signaturePayload = {
      ...entry,
      signature: undefined
    };
    const signature = await signer.sign(canonicalizeJson(signaturePayload));
    return {
      ...entry,
      signature
    };
  }

  async wrapEnvelope({ entry, signer, submittedAt }) {
    const signerId = await signer.getSignerId();
    const envelope = {
      envelope_id: createUuid(),
      signer: signerId,
      submitted_at: submittedAt ?? new Date().toISOString(),
      payload: entry
    };

    const signature = await signer.sign(
      canonicalizeJson({
        ...envelope,
        signature: undefined
      })
    );

    return {
      ...envelope,
      signature
    };
  }

  async submitEnvelope(envelope) {
    return this.#request("/api/v1/envelopes/submit", {
      method: "POST",
      body: envelope
    });
  }

  async submitEnvelopeBatch(envelopes) {
    if (!Array.isArray(envelopes) || envelopes.length === 0) {
      throw new Error("envelopes must be a non-empty array");
    }

    return this.#request("/api/v1/envelopes/submit-batch", {
      method: "POST",
      body: envelopes
    });
  }

  async getReceipt(receiptId) {
    if (!receiptId) {
      throw new Error("receiptId is required");
    }

    return this.#request(`/api/v1/receipts/${encodeURIComponent(receiptId)}`);
  }

  async waitForReceipt(
    receiptId,
    {
      pollIntervalMs = 1_000,
      timeoutMs = 30_000,
      isTerminal = (receipt) => DEFAULT_RECEIPT_TERMINAL_STATUSES.has(receipt?.receipt?.status)
    } = {}
  ) {
    if (!receiptId) {
      throw new Error("receiptId is required");
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const receipt = await this.getReceipt(receiptId);
      if (isTerminal(receipt)) {
        return receipt;
      }

      await sleep(pollIntervalMs);
    }

    const error = new Error(`Timed out waiting for receipt ${receiptId}`);
    error.receiptId = receiptId;
    error.timeoutMs = timeoutMs;
    throw error;
  }

  async #request(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      ...(init.headers ?? {})
    };

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const error = new Error(`Citizen runtime request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }
}
