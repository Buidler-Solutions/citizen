import { validateBuilderCreditsPayload } from "./builders.js";
import { appendCoSignature, finalizeEnvelope, wrapEnvelopeMulti } from "./multisig.js";
import type {
  CitizenNodeClientOptions,
  CitizenSigner,
  EntryRecord,
  EnvelopeRecord,
  SubmitTransactionArgs,
  SubmitWithBrowserWalletArgs,
  WaitForReceiptOptions
} from "./types.js";
import { DEFAULT_RECEIPT_TERMINAL_STATUSES, canonicalizeJson, createUuid, sleep } from "./utils.js";
import { BrowserWalletSigner } from "./wallet.js";

export class CitizenNodeClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private fetchImpl: typeof fetch;

  constructor({ baseUrl, apiKey, fetchImpl }: CitizenNodeClientOptions = {} as CitizenNodeClientOptions) {
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

  async submitTransaction({
    namespace,
    action,
    objectId,
    payload,
    signer,
    timestamp
  }: SubmitTransactionArgs): Promise<unknown> {
    if (!namespace || !action || !objectId || !signer) {
      throw new Error("namespace, action, objectId, and signer are required");
    }

    if (namespace === "builder.credits") {
      validateBuilderCreditsPayload({ action, payload: payload ?? {} });
    }

    const signerId = await signer.getSignerId();
    const entry: EntryRecord = {
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
  }: SubmitWithBrowserWalletArgs): Promise<unknown> {
    const signerArgs: { provider?: typeof walletProvider; account?: string; requestMethod?: string } = {};
    if (walletProvider !== undefined) signerArgs.provider = walletProvider;
    if (account !== undefined) signerArgs.account = account;
    if (requestMethod !== undefined) signerArgs.requestMethod = requestMethod;
    const signer = new BrowserWalletSigner(signerArgs);

    const txArgs: SubmitTransactionArgs = { namespace, action, objectId, signer };
    if (payload !== undefined) txArgs.payload = payload;
    if (timestamp !== undefined) txArgs.timestamp = timestamp;
    return this.submitTransaction(txArgs);
  }

  async signEntry(entry: EntryRecord, signer: CitizenSigner): Promise<EntryRecord> {
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

  async wrapEnvelope({
    entry,
    signer,
    submittedAt
  }: {
    entry: EntryRecord;
    signer: CitizenSigner;
    submittedAt?: string;
  }): Promise<EnvelopeRecord> {
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

  async wrapEnvelopeMulti(args: Parameters<typeof wrapEnvelopeMulti>[0]): Promise<EnvelopeRecord> {
    return wrapEnvelopeMulti(args);
  }

  async appendCoSignature(args: Parameters<typeof appendCoSignature>[0]): Promise<EnvelopeRecord> {
    return appendCoSignature(args);
  }

  finalizeEnvelope(args: Parameters<typeof finalizeEnvelope>[0]): EnvelopeRecord {
    return finalizeEnvelope(args);
  }

  async submitEnvelope(envelope: EnvelopeRecord): Promise<unknown> {
    return this.#request("/api/v1/envelopes/submit", {
      method: "POST",
      body: envelope
    });
  }

  async submitEnvelopeBatch(envelopes: EnvelopeRecord[]): Promise<unknown> {
    if (!Array.isArray(envelopes) || envelopes.length === 0) {
      throw new Error("envelopes must be a non-empty array");
    }

    return this.#request("/api/v1/envelopes/submit-batch", {
      method: "POST",
      body: envelopes
    });
  }

  async getReceipt(receiptId: string): Promise<unknown> {
    if (!receiptId) {
      throw new Error("receiptId is required");
    }

    return this.#request(`/api/v1/receipts/${encodeURIComponent(receiptId)}`);
  }

  async waitForReceipt(receiptId: string, options: WaitForReceiptOptions = {}): Promise<unknown> {
    if (!receiptId) {
      throw new Error("receiptId is required");
    }

    const {
      pollIntervalMs = 1_000,
      timeoutMs = 30_000,
      isTerminal = (receipt: unknown) =>
        DEFAULT_RECEIPT_TERMINAL_STATUSES.has(
          (receipt as { receipt?: { status?: string } })?.receipt?.status ?? ""
        )
    } = options;

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const receipt = await this.getReceipt(receiptId);
      if (isTerminal(receipt)) {
        return receipt;
      }

      await sleep(pollIntervalMs);
    }

    const error = new Error(`Timed out waiting for receipt ${receiptId}`) as Error & {
      receiptId: string;
      timeoutMs: number;
    };
    error.receiptId = receiptId;
    error.timeoutMs = timeoutMs;
    throw error;
  }

  async #request(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const headers = {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      ...(init.headers ?? {})
    };

    const requestInit: RequestInit = { headers };
    if (init.method !== undefined) {
      requestInit.method = init.method;
    }
    if (init.body !== undefined) {
      requestInit.body = JSON.stringify(init.body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, requestInit);

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const error = new Error(`Citizen runtime request failed (${response.status})`) as Error & {
        status: number;
        payload: unknown;
      };
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }
}
