# Citizen Wallet Signer

Dedicated browser-wallet UX project for transaction/event signing flows.

## Why this project exists

The existing `wallet/react` app is a broad web console for onboarding, governance, and operational workflows. Browser wallets require a focused interaction model optimized for:

- Popup-sized viewport (~380–420px wide)
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

The popup now includes a **Sponsorship draft builder** to generate strict `builder.credits` / `SPONSOR_USAGE` payloads with required fields (`credit_grant_id`, `sponsorship_id`, `sponsored_did`, `amount`) and optional `sponsor_builder_id` fallback behavior. Preset templates (article/governance) and an inline strict-field checklist help authors verify grant linkage before signing.

## Quality gates

```bash
npm run lint
npm run test
```

These commands are the baseline CI gates for the extension workspace (type-check/lint and smoke tests for provider injection + signing flow).

## Build extension bundle

```bash
npm run build
```

Build output is written to `dist/`.

## Load extension in Chromium browsers

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `wallet/browser/dist`
5. Pin and open the extension popup

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
