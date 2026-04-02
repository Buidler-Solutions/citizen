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
cd sdk/nodejs
npm install
```

## Browser wallet flow (recommended for dApps)

```js
import { CitizenNodeClient } from "@citizen-protocol/nodejs-sdk";

const client = new CitizenNodeClient({
  baseUrl: "http://127.0.0.1:8080",
  apiKey: process.env.NEXT_PUBLIC_CITIZEN_API_KEY
});

// Uses window.citizen (or window.ctzn alias) to:
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


## Wallet-controlled form signing flow (builder app pattern)

For app-builder forms where sensitive user fields should stay in wallet-controlled flows, use the Citizen extension protocol-signing methods via the SDK helper:

```js
import { signCitizenPayloadWithWallet } from "@citizen-protocol/nodejs-sdk";

const signed = await signCitizenPayloadWithWallet({
  payload: {
    schema_version: "1.0.0",
    namespace: "identity.citizen",
    action: "SUBMIT_PROFILE",
    form_payload: formJson
  }
});

// Send signed envelope to builder backend
await fetch("/api/forms/submit", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(signed)
});
```

The helper calls `ctzn_getCitizenSigner` + `ctzn_signCitizenTx` and returns runtime-aligned commitment fields:
- `payloadHash` in `sha256:<hex>` format
- canonical `signingPayload`
- signer metadata + signature for backend verification and chain anchoring
- `signatureScope` indicating whether signature verification should use `payloadHash` (`payload_hash_v1`) or canonical payload (`canonical_payload_v1`)

For landing-page onboarding backends that enforce wallet-first submission, map these fields directly:
- `signer` -> `walletSignerDid`
- `verifyingKey` -> `walletVerifyingKey`
- `signature` -> `walletSignature`
- `payloadHash` -> `walletPayloadHash`
- `signingPayload` -> `walletSigningPayload`
- `signatureScope` -> `walletSignatureScope`
- `algorithm` -> `walletAlgorithm`

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


## Live smoke script modes

The release-gate smoke script supports both externally managed nodes and self-started local runs:

```bash
# default: expect node already running at CITIZEN_NODE_URL
node sdk/nodejs/scripts/live_node_smoke.mjs

# start a local blockchain node without Docker (cargo run)
CITIZEN_NODE_MODE=local \
CITIZEN_LOCAL_PROTOCOL_DIR=citizen-protocol \
CITIZEN_LOCAL_CONFIG_PATH=config/localnet/validator-alpha.toml \
node sdk/nodejs/scripts/live_node_smoke.mjs

# start/stop through custom commands (for Docker or other runtimes)
CITIZEN_NODE_MODE=command \
CITIZEN_NODE_START_COMMAND="docker compose -f my-stack.yml up -d citizen-node" \
CITIZEN_NODE_STOP_COMMAND="docker compose -f my-stack.yml down" \
node sdk/nodejs/scripts/live_node_smoke.mjs
```

Environment variables:
- `CITIZEN_NODE_URL` (default `http://127.0.0.1:8081`)
- `CITIZEN_NODE_MODE` (`external`, `local`, or `command`)
- `CITIZEN_LOCAL_PROTOCOL_DIR` (default `citizen-protocol`)
- `CITIZEN_LOCAL_CONFIG_PATH` (default `config/localnet/validator-alpha.toml`)
- `CITIZEN_NODE_START_COMMAND` / `CITIZEN_NODE_STOP_COMMAND` (for `command` mode)

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
- `signCitizenPayloadWithWallet({ payload, provider? })`

Signer options:

- `BrowserWalletSigner({ provider?, account?, requestMethod? })`
- `Ed25519Signer({ signerId, privateKeyPem })`

## Notes

- Canonical JSON key ordering is applied before signatures are generated, keeping signatures deterministic across runtimes.
- Runtime write endpoints may require `x-api-key` depending on node operator policy (`api_auth_required`).
- Browser wallet signing expects the Citizen extension provider to expose `citizen_requestAccounts` and `personal_sign` (or a custom `requestMethod`).
- `builder.credits` helper builders provide first-class operation construction for `MULTISIG_CREDIT_GRANT` and `SPONSOR_USAGE`, including pre-submit payload validation for required fields.
