import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256DigestHex } from "../src/index.js";

import {
  BrowserWalletSigner,
  CitizenNodeClient,
  canonicalizeJson,
  createMultisigCreditGrant,
  createSponsorshipUsage
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

test("canonicalizeJson sorts keys recursively", () => {
  const output = canonicalizeJson({ z: 1, a: { d: 2, c: 1 } });
  assert.equal(output, '{"a":{"c":1,"d":2},"z":1}');
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
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/test-vectors/file_commitment_test_vectors.json"
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  for (const vector of fixture.vectors) {
    const canonical = canonicalizeJson(vector.manifest);
    assert.equal(canonical, vector.expected_canonical_json);
    assert.equal(await sha256DigestHex(canonical), vector.expected_sha256);
  }
});

test("payload field commitment vectors match canonical hash outputs", async () => {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/test-vectors/payload_field_commitment_test_vectors.json"
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  for (const vector of fixture.vectors) {
    const canonical = canonicalizeJson(vector.field_commitment_input);
    assert.equal(canonical, vector.expected_canonical_json);
    assert.equal(await sha256DigestHex(canonical), vector.expected_sha256);
  }
});
