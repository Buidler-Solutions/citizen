# Citizen Node.js SDK

> Status: ✅ Working and ready for dApp builders.

Node.js/browser client library for dApps that need to trigger the Citizen browser wallet extension for signing, submit signed CITIZEN runtime transactions (`LedgerEntry` wrapped in `SignedEnvelope`), and fetch deterministic receipts.

## Install

From npm (published package):

```bash
npm install @citizen-protocol/nodejs-sdk
```

For local development in this repository:

```bash
cd citizen-protocol/sdk/nodejs
npm install
```

## Browser wallet flow (recommended for dApps)

```js
import { CitizenNodeClient } from "@citizen-protocol/nodejs-sdk";

const client = new CitizenNodeClient({
  baseUrl: "http://127.0.0.1:8080",
  apiKey: process.env.NEXT_PUBLIC_CITIZEN_API_KEY
});

// Uses window.citizen (or window.ethereum fallback) to:
// 1) request wallet account
// 2) sign entry payload + envelope with personal_sign
// 3) submit to runtime
const submission = await client.submitWithBrowserWallet({
  namespace: "audit.procurement",
  action: "RECORD_EVENT",
  objectId: "procurement:event:42",
  payload: {
    event: "BID_OPENED",
    document_hash: "sha256:abcd"
  }
});

const receipt = await client.waitForReceipt(submission.receipt.receipt_id, {
  pollIntervalMs: 500,
  timeoutMs: 30_000
});
console.log(receipt);
```

## Server-side signer flow (optional)

```js
import { CitizenNodeClient, Ed25519Signer } from "@citizen-protocol/nodejs-sdk";
import { readFileSync } from "node:fs";

const signer = new Ed25519Signer({
  signerId: "did:ledger:builder:alpha",
  privateKeyPem: readFileSync("./builder-ed25519.pem", "utf8")
});

const client = new CitizenNodeClient({ baseUrl: "http://127.0.0.1:8080" });
const submission = await client.submitTransaction({
  namespace: "audit.procurement",
  action: "RECORD_EVENT",
  objectId: "procurement:event:42",
  payload: { event: "BID_OPENED" },
  signer
});
```

## API

- `new CitizenNodeClient({ baseUrl, apiKey?, fetchImpl? })`
- `submitWithBrowserWallet({ namespace, action, objectId, payload?, walletProvider?, account?, requestMethod?, timestamp? })`
- `submitTransaction({ namespace, action, objectId, payload?, signer, timestamp? })`
- `submitEnvelope(envelope)`
- `getReceipt(receiptId)`
- `waitForReceipt(receiptId, { pollIntervalMs?, timeoutMs?, isTerminal? })`
- `signEntry(entry, signer)`
- `wrapEnvelope({ entry, signer, submittedAt? })`
- `createMultisigCreditGrant({ builderId, amount, multisigProofs })`
- `createSponsorshipUsage({ builderId, amount, creditGrantId, sponsorshipId, sponsoredDid })`
- `validateBuilderCreditsPayload({ action, payload })`

Signer options:

- `BrowserWalletSigner({ provider?, account?, requestMethod? })`
- `Ed25519Signer({ signerId, privateKeyPem })`

## Notes

- Canonical JSON key ordering is applied before signatures are generated, keeping signatures deterministic across runtimes.
- Runtime write endpoints may require `x-api-key` depending on node operator policy (`api_auth_required`).
- Browser wallet signing expects the Citizen extension provider to expose `citizen_requestAccounts` and `personal_sign` (or a custom `requestMethod`).
- `builder.credits` helper builders provide first-class operation construction for `MULTISIG_CREDIT_GRANT` and `SPONSOR_USAGE`, including pre-submit payload validation for required fields.
