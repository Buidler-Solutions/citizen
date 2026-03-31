# Citizen Wallet Signer

Dedicated browser-wallet UX project for transaction/event signing flows.

## Seed phrase alignment status vs `citizen-wallet` CLI

Current status is **aligned for mnemonic UX defaults**:

- Browser extension signer now persists mnemonic metadata and supports seed phrase generation/reveal/import in the side panel.
- Extension default derivation path is `m/44'/930'/0'/0'/0'`, matching the CLI default.
- `citizen-wallet` CLI in `citizen-protocol/crates/wallet/src/cli.rs` supports mnemonic-based keygen/import with hardened-path validation.

Important: the browser extension still signs via the injected wallet provider surface, while the Rust CLI key material is managed in the protocol wallet crate. Treat cross-surface restoration as environment-specific until full cryptographic parity is explicitly documented.

## Why this project exists

The existing `wallet/react` app is a broad web console for onboarding, governance, and operational workflows. Browser wallets require a focused interaction model optimized for:

- Side-panel viewport (~380–420px wide)
- Fast transaction/event review
- Security/risk signal clarity
- Explicit sign/reject actions

This project provides that dedicated UX surface.

## Install

```bash
npm install
```

## Development server (UI iteration)

```bash
npm run dev
```


## Builder credit authoring helper

The side panel now includes a **Sponsorship draft builder** to generate strict `builder.credits` / `SPONSOR_USAGE` payloads with required fields (`credit_grant_id`, `sponsorship_id`, `sponsored_did`, `amount`) and optional `sponsor_builder_id` fallback behavior. Preset templates (article/governance) and an inline strict-field checklist help authors verify grant linkage before signing.

## dApp login support

The injected provider now supports Citizen wallet login patterns for dApps:

```ts
const accounts = await window.ctzn.request({ method: "ctzn_requestAccounts" });
const signature = await window.ctzn.request({
  method: "personal_sign",
  params: ["Sign-in challenge from backend", accounts[0]]
});
```

For richer typed auth payloads, dApps can also use `ctzn_signTypedData_v4`.

Like backend-verified wallet sign-in integrations, production login should verify signatures and nonces server-side before issuing app sessions.

For full implementation/operations guidance, see `docs/DAPP_LOGIN_RUNBOOK.md`.

## Quality gates

```bash
npm run lint
npm run test
```

If `npm run test` reports missing packages like `vite`, `@vitejs/plugin-react`, or `vitest`, re-run `npm run test`: a `pretest` dependency check now auto-installs missing dev dependencies before running Vitest.

These commands are the baseline CI gates for the extension workspace (type-check/lint and smoke tests for provider injection + signing flow).

## Build extension bundle

```bash
npm run build
```

Build output is written to `dist/`.

Note: `dist/` is generated locally and intentionally not versioned in git. Re-run `npm run build` before loading the unpacked extension.

## Load extension in Chromium browsers

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `wallet/browser/dist`
5. Pin the extension and click the toolbar icon to open the side panel

## Watch mode for extension development

```bash
npm run build -- --watch
```

After each rebuild, press **Reload** on the extension card.

## Full local testing with localnode + demo blog

Use the runbook at `docs/STACK_TESTING_GUIDE.md` from repo root to run all of:

- Rust local validator network
- Demo blog backend/UI
- Browser wallet extension watch build
