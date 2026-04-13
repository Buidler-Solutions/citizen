import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256DigestHex } from "../src/index.js";

import {
  appendCoSignature,
  BrowserWalletSigner,
  CitizenNodeClient,
  OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES,
  canonicalizeJson,
  createFormCommitmentReceipt,
  createMultisigCreditGrant,
  createSponsorshipUsage,
  finalizeEnvelope,
  wrapEnvelopeMulti,
  signCitizenPayloadWithWallet
} from "../src/index.js";

class StubSigner {
  constructor(id = "did:ledger:builder:demo") {
    this.id = id;
  }

  async getSignerId() {
    return this.id;
  }

  async sign(message) {
    return `sig:${Buffer.from(message).toString("base64url")}`;
  }
}

class RecordingSigner extends StubSigner {
  constructor(id) {
    super(id);
    this.messages = [];
  }

  async sign(message) {
    this.messages.push(message);
    return super.sign(message);
  }
}

function resolveVectorFixturePath(filename) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(testDir, "../../../docs/test-vectors", filename),
    path.resolve(testDir, "../../../citizen-protocol/docs/test-vectors", filename)
  ];

  const fixturePath = candidatePaths.find((candidate) => existsSync(candidate));
  if (!fixturePath) {
    throw new Error(`Fixture ${filename} not found in expected test-vector directories`);
  }

  return fixturePath;
}

test("canonicalizeJson sorts keys recursively", () => {
  const output = canonicalizeJson({ z: 1, a: { d: 2, c: 1 } });
  assert.equal(output, '{"a":{"c":1,"d":2},"z":1}');
});

test("OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES includes runtime-supported media/doc aliases", () => {
  const expectedMimeTypes = [
    "audio/mp3",
    "video/quicktime",
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.ms-word",
    "application/msexcel"
  ];

  expectedMimeTypes.forEach((mimeType) => {
    assert.equal(
      OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES.includes(mimeType),
      true,
      `Expected ${mimeType} to be allowlisted`
    );
  });
});

test("createFormCommitmentReceipt returns forms.commitment operation payload", () => {
  const operation = createFormCommitmentReceipt({
    formId: "form-123",
    dataHash: "sha256:abcdef123456",
    encryptedFormUrl: "https://storage.citizen.local/forms/form-123.cipher",
    commitmentReceipt: {
      hosted_at: "2026-04-05T02:00:00Z",
      host: "storage.citizen.local"
    }
  });

  assert.equal(operation.namespace, "forms.commitment");
  assert.equal(operation.action, "SUBMIT_COMMITMENT_RECEIPT");
  assert.equal(operation.objectId, "form-123");
  assert.equal(operation.payload.data_hash, "sha256:abcdef123456");
  assert.equal(
    operation.payload.encrypted_form_url,
    "https://storage.citizen.local/forms/form-123.cipher"
  );
  assert.equal(operation.payload.commitment_receipt.host, "storage.citizen.local");
});

test("createFormCommitmentReceipt validates hash and URL inputs", () => {
  assert.throws(
    () =>
      createFormCommitmentReceipt({
        formId: "form-123",
        dataHash: "not-a-sha",
        encryptedFormUrl: "https://storage.citizen.local/forms/form-123.cipher"
      }),
    /dataHash must be a sha256:<hex> digest string/
  );

  assert.throws(
    () =>
      createFormCommitmentReceipt({
        formId: "form-123",
        dataHash: "sha256:abcdef123456",
        encryptedFormUrl: "ftp://storage.citizen.local/forms/form-123.cipher"
      }),
    /encryptedFormUrl must be a valid http\(s\) URL/
  );
});



test("signCitizenPayloadWithWallet uses Citizen extension methods and returns runtime commitment envelope", async () => {
  const providerCalls = [];
  const provider = {
    async request({ method, params }) {
      providerCalls.push({ method, params });
      if (method === "ctzn_getCitizenSigner") {
        return {
          did: "did:key:ed25519:abcd",
          verifyingKey: "abcd",
          algorithm: "ed25519",
          signatureScope: "payload_hash_v1"
        };
      }

      if (method === "ctzn_signCitizenTx") {
        return {
          signer: "did:key:ed25519:abcd",
          verifyingKey: "abcd",
          signature: "deadbeef",
          signingPayload: '{"a":1}',
          payloadHash: "sha256:1234",
          payloadHashHex: "1234",
          algorithm: "ed25519",
          signatureScope: "payload_hash_v1"
        };
      }

      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await signCitizenPayloadWithWallet({
    payload: { a: 1 },
    provider
  });

  assert.equal(result.signer, "did:key:ed25519:abcd");
  assert.equal(result.payloadHash, "sha256:1234");
  assert.equal(result.signature, "deadbeef");
  assert.equal(result.signatureScope, "payload_hash_v1");
  assert.equal(providerCalls[0].method, "ctzn_getCitizenSigner");
  assert.equal(providerCalls[1].method, "ctzn_signCitizenTx");
});
test("submitTransaction builds signed envelope and posts to runtime", async () => {
  let capturedRequest;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, init };
    return new Response(
      JSON.stringify({
        status: "accepted",
        receipt: { receipt_id: "receipt-123", status: "Accepted" }
      }),
      { status: 202, headers: { "content-type": "application/json" } }
    );
  };

  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    apiKey: "builder-demo",
    fetchImpl
  });

  const result = await client.submitTransaction({
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    objectId: "proc-1",
    payload: { event: "BID_OPENED" },
    signer: new StubSigner()
  });

  assert.equal(result.receipt.receipt_id, "receipt-123");
  assert.equal(capturedRequest.url, "http://127.0.0.1:8080/api/v1/envelopes/submit");
  assert.equal(capturedRequest.init.method, "POST");
  assert.equal(capturedRequest.init.headers["x-api-key"], "builder-demo");

  const body = JSON.parse(capturedRequest.init.body);
  assert.equal(body.payload.namespace, "audit.procurement");
  assert.equal(body.payload.action, "RECORD_EVENT");
  assert.equal(typeof body.signature, "string");
  assert.equal(typeof body.payload.signature, "string");
});

test("submitWithBrowserWallet requests account and signs through wallet provider", async () => {
  const providerCalls = [];
  const provider = {
    async request({ method, params }) {
      providerCalls.push({ method, params });
      if (method === "citizen_requestAccounts") {
        return ["0xabc123"];
      }

      if (method === "personal_sign") {
        return "0xwalletsig";
      }

      throw new Error(`unexpected method ${method}`);
    }
  };

  let postedBody;
  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl: async (_url, init) => {
      postedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ receipt: { receipt_id: "r1" } }), { status: 202 });
    }
  });

  await client.submitWithBrowserWallet({
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    objectId: "obj-1",
    payload: { event: "OPENED" },
    walletProvider: provider
  });

  assert.equal(postedBody.signer, "0xabc123");
  assert.equal(postedBody.payload.author, "0xabc123");
  assert.equal(postedBody.payload.signature, "0xwalletsig");
  assert.equal(postedBody.signature, "0xwalletsig");
  assert.equal(providerCalls[0].method, "citizen_requestAccounts");
  assert.equal(providerCalls.filter((call) => call.method === "personal_sign").length, 2);
});

test("submitEnvelopeBatch posts array payload to batch endpoint", async () => {
  let capturedRequest;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, init };
    return new Response(
      JSON.stringify({
        status: "accepted",
        batch_size: 2,
        receipts: [{ entry_id: "e1" }, { entry_id: "e2" }]
      }),
      { status: 202, headers: { "content-type": "application/json" } }
    );
  };

  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl
  });

  const envelopeA = {
    envelope_id: "11111111-1111-1111-1111-111111111111",
    signer: "did:ledger:alice",
    signature: "sig-a",
    submitted_at: new Date().toISOString(),
    payload: {
      entry_id: "22222222-2222-2222-2222-222222222222",
      namespace: "audit.procurement",
      action: "RECORD_EVENT",
      object_id: "PO-1",
      payload: { event: "OPENED" },
      author: "did:ledger:alice",
      signature: "sig-a",
      timestamp: Math.floor(Date.now() / 1000)
    }
  };
  const envelopeB = {
    ...envelopeA,
    envelope_id: "33333333-3333-3333-3333-333333333333",
    signature: "sig-b",
    payload: {
      ...envelopeA.payload,
      entry_id: "44444444-4444-4444-4444-444444444444",
      object_id: "PO-2",
      signature: "sig-b"
    }
  };

  const result = await client.submitEnvelopeBatch([envelopeA, envelopeB]);
  assert.equal(result.batch_size, 2);
  assert.equal(capturedRequest.url, "http://127.0.0.1:8080/api/v1/envelopes/submit-batch");
  assert.equal(capturedRequest.init.method, "POST");

  const body = JSON.parse(capturedRequest.init.body);
  assert.equal(Array.isArray(body), true);
  assert.equal(body.length, 2);
});

test("wrapEnvelopeMulti signs a canonical payload preimage across all signers", async () => {
  const entry = {
    entry_id: "22222222-2222-2222-2222-222222222222",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    object_id: "PO-1",
    payload: { event: "OPENED" },
    author: "did:ledger:alice",
    signature: "entry-sig",
    timestamp: 1_713_151_200
  };

  const alice = new RecordingSigner("did:ledger:alice");
  const bob = new RecordingSigner("did:ledger:bob");

  const envelope = await wrapEnvelopeMulti({
    entry,
    signer: alice,
    coSigners: [bob],
    multisigPolicy: {
      threshold: 2,
      allowed_signers: ["did:ledger:alice", "did:ledger:bob"],
      require_author_signature: true
    }
  });

  assert.equal(envelope.signature_scope, "canonical_payload_v1");
  assert.equal(envelope.co_signatures.length, 1);
  assert.equal(alice.messages.length, 1);
  assert.equal(bob.messages.length, 1);
  assert.equal(alice.messages[0], bob.messages[0]);
  assert.equal(alice.messages[0], canonicalizeJson({ ...entry, signature: undefined }));
});

test("wrapEnvelopeMulti supports canonical_payload_v2 replay protection binding", async () => {
  const entry = {
    entry_id: "33333333-3333-3333-3333-333333333333",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    object_id: "PO-9",
    payload: {
      event: "AWARDED",
      replay_protection: {
        request_id: "req-123",
        expires_at: 1_713_151_500
      }
    },
    author: "did:ledger:alice",
    signature: "entry-sig",
    timestamp: 1_713_151_200
  };

  const alice = new RecordingSigner("did:ledger:alice");
  const bob = new RecordingSigner("did:ledger:bob");

  const envelope = await wrapEnvelopeMulti({
    entry,
    signer: alice,
    coSigners: [bob],
    signatureScope: "canonical_payload_v2",
    multisigPolicy: {
      threshold: 2,
      allowed_signers: ["did:ledger:alice", "did:ledger:bob"],
      require_author_signature: true
    }
  });

  assert.equal(envelope.signature_scope, "canonical_payload_v2");
  assert.equal(alice.messages.length, 1);
  assert.equal(bob.messages[0], alice.messages[0]);
  assert.match(alice.messages[0], /replay_protection/);
});

test("wrapEnvelopeMulti rejects canonical_payload_v2 without replay request id", async () => {
  const entry = {
    entry_id: "44444444-4444-4444-4444-444444444444",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    object_id: "PO-10",
    payload: { event: "AWARDED", replay_protection: {} },
    author: "did:ledger:alice",
    signature: "entry-sig",
    timestamp: 1_713_151_200
  };
  const alice = new StubSigner("did:ledger:alice");

  await assert.rejects(
    () =>
      wrapEnvelopeMulti({
        entry,
        signer: alice,
        signatureScope: "canonical_payload_v2",
        multisigPolicy: {
          threshold: 1,
          allowed_signers: ["did:ledger:alice"],
          require_author_signature: true
        }
      }),
    /canonical_payload_v2 requires payload.replay_protection.request_id/
  );
});

test("appendCoSignature and finalizeEnvelope enforce threshold and uniqueness", async () => {
  const entry = {
    entry_id: "22222222-2222-2222-2222-222222222222",
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    object_id: "PO-1",
    payload: { event: "OPENED" },
    author: "did:ledger:alice",
    signature: "entry-sig",
    timestamp: 1_713_151_200
  };

  const alice = new StubSigner("did:ledger:alice");
  const bob = new StubSigner("did:ledger:bob");
  const carol = new StubSigner("did:ledger:carol");

  const twoOfThree = {
    threshold: 2,
    allowed_signers: ["did:ledger:alice", "did:ledger:bob", "did:ledger:carol"],
    require_author_signature: true
  };

  let envelope = await wrapEnvelopeMulti({
    entry,
    signer: alice,
    multisigPolicy: twoOfThree
  });
  assert.throws(() => finalizeEnvelope({ envelope }), /threshold is 2/);

  envelope = await appendCoSignature({ envelope, signer: bob });
  const finalized = finalizeEnvelope({ envelope });
  assert.equal(finalized.co_signatures.length, 1);

  await assert.rejects(
    () => appendCoSignature({ envelope: finalized, signer: bob }),
    /signer already present/
  );
});

test("BrowserWalletSigner accepts explicit account", async () => {
  const signer = new BrowserWalletSigner({
    account: "0xdef456",
    provider: { request: async () => "0xsignature" }
  });

  assert.equal(await signer.getSignerId(), "0xdef456");
  assert.equal(await signer.sign("hello"), "0xsignature");
});



test("submitWithBrowserWallet supports custom wallet sign method", async () => {
  const providerCalls = [];
  const provider = {
    async request({ method }) {
      providerCalls.push(method);
      if (method === "citizen_requestAccounts") {
        return ["0xbeef"];
      }

      if (method === "citizen_signTypedEntry") {
        return "0xcustomsig";
      }

      throw new Error(`unexpected method ${method}`);
    }
  };

  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 202 })
  });

  await client.submitWithBrowserWallet({
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    objectId: "obj-2",
    walletProvider: provider,
    requestMethod: "citizen_signTypedEntry"
  });

  assert.equal(providerCalls.filter((method) => method === "citizen_signTypedEntry").length, 2);
});


test("waitForReceipt polls until terminal receipt status", async () => {
  let calls = 0;
  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl: async () => {
      calls += 1;
      const status = calls < 2 ? "Pending" : "Accepted";
      return new Response(JSON.stringify({ receipt: { receipt_id: "r1", status } }), { status: 200 });
    }
  });

  const receipt = await client.waitForReceipt("r1", { pollIntervalMs: 1, timeoutMs: 500 });

  assert.equal(calls, 2);
  assert.equal(receipt.receipt.status, "Accepted");
});


test("waitForReceipt throws when timeout is reached", async () => {
  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl: async () => new Response(JSON.stringify({ receipt: { receipt_id: "r2", status: "Pending" } }), { status: 200 })
  });

  await assert.rejects(
    client.waitForReceipt("r2", { pollIntervalMs: 1, timeoutMs: 5 }),
    /Timed out waiting for receipt r2/
  );
});
test("getReceipt calls deterministic receipt endpoint", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "http://127.0.0.1:8080/api/v1/receipts/receipt-123");
    return new Response(
      JSON.stringify({
        receipt: {
          receipt_id: "receipt-123",
          status: "Accepted",
          finality: { block_height: 1 }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const client = new CitizenNodeClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
  const result = await client.getReceipt("receipt-123");
  assert.equal(result.receipt.finality.block_height, 1);
});


test("createMultisigCreditGrant builds builder.credits operation", () => {
  const operation = createMultisigCreditGrant({
    builderId: "builder:alpha",
    amount: 100,
    multisigProofs: [
      { approver: "approver-1", public_key: "ed25519:pk1", signature: "deadbeef" }
    ]
  });

  assert.equal(operation.namespace, "builder.credits");
  assert.equal(operation.action, "MULTISIG_CREDIT_GRANT");
  assert.equal(operation.objectId, "builder:alpha");
  assert.equal(operation.payload.amount, 100);
});

test("createSponsorshipUsage builds sponsorship operation", () => {
  const operation = createSponsorshipUsage({
    builderId: "builder:alpha",
    amount: 25,
    creditGrantId: "grant-123",
    sponsorshipId: "spn-1",
    sponsoredDid: "did:ledger:user1"
  });

  assert.equal(operation.namespace, "builder.credits");
  assert.equal(operation.action, "SPONSOR_USAGE");
  assert.equal(operation.objectId, "builder:alpha");
  assert.equal(operation.payload.credit_grant_id, "grant-123");
});

test("submitTransaction validates builder.credits payloads before submitting", async () => {
  const client = new CitizenNodeClient({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl: async () => {
      throw new Error("network should not be called on invalid payload");
    }
  });

  await assert.rejects(
    client.submitTransaction({
      namespace: "builder.credits",
      action: "SPONSOR_USAGE",
      objectId: "builder:alpha",
      payload: { amount: 10 },
      signer: new StubSigner()
    }),
    /payload.credit_grant_id must be a non-empty string/
  );
});

test("file commitment vectors match canonical hash outputs", async () => {
  const fixturePath = resolveVectorFixturePath("file_commitment_test_vectors.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  for (const vector of fixture.vectors) {
    const canonical = canonicalizeJson(vector.manifest);
    assert.equal(canonical, vector.expected_canonical_json);
    assert.equal(await sha256DigestHex(canonical), vector.expected_sha256);
  }
});

test("payload field commitment vectors match canonical hash outputs", async () => {
  const fixturePath = resolveVectorFixturePath("payload_field_commitment_test_vectors.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  for (const vector of fixture.vectors) {
    const canonical = canonicalizeJson(vector.field_commitment_input);
    assert.equal(canonical, vector.expected_canonical_json);
    assert.equal(await sha256DigestHex(canonical), vector.expected_sha256);
  }
});
