# TypeScript SDK Public API Surface Baseline

Captured from `sdk/typescript/src/index.ts` exports.

## Runtime exports

- `canonicalizeJson`
- `sha256DigestHex`
- `OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES`
- `signCitizenPayloadWithWallet`
- `createFormCommitmentReceipt`
- `createMultisigCreditGrant`
- `createSponsorshipUsage`
- `validateBuilderCreditsPayload`
- `wrapEnvelopeMulti`
- `appendCoSignature`
- `finalizeEnvelope`
- `BrowserWalletSigner`
- `Ed25519Signer`
- `CitizenNodeClient`

## Public builder-facing types

- `CitizenSigner`
- `MultisigPolicy`
- `EntryRecord`
- `EnvelopeRecord`
- `WrapEnvelopeMultiArgs`
- `BrowserWalletProvider`
- `WalletSignedPayload`
- `SignCitizenPayloadWithWalletArgs`
- `CreateFormCommitmentReceiptArgs`
- `CreateMultisigCreditGrantArgs`
- `CreateSponsorshipUsageArgs`
- `BuilderCreditsAction`
- `BuilderCreditsPayload`
- `ValidateBuilderCreditsPayloadArgs`
- `CitizenNodeClientOptions`
- `SubmitTransactionArgs`
