import assert from "node:assert/strict";
import test from "node:test";

import { BrowserWalletSigner, CitizenNodeClient, canonicalizeJson } from "../src/index.js";

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
