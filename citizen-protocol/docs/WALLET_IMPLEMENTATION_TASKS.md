# Wallet Implementation Task Tracker

This checklist turns the wallet plan into ready-to-assign tasks. It is scoped to the
CLI + React wallet apps while reusing the existing `crates/wallet` library.

Legend: `[x] done` (all scoped tasks completed; tracker retained as implementation record).

## Phase 0 — Repository Prep
- [x] Confirm Rust wallet crate API surface needed by apps (keygen/import, sign/verify).  
      Owner: _Protocol engineering_ · Status: _Done (shared API available in `crates/wallet`)_
- [x] Decide storage format for CLI keystore (JSON vs SQLite).  
      Owner: _Wallet team_ · Status: _Done_
- [x] Align on node API base URL + versioning for wallet submissions.  
      Owner: _Wallet team_ · Status: _Done_

## Phase 1 — CLI Wallet (Developer/Operator Ready)
- [x] Scaffold `wallet/cli` as a standalone Rust binary (workspace or separate crate).  
      Owner: _Protocol engineering_ · Status: _Done (`citizen-wallet-cli`)_
- [x] Implement CLI commands for key lifecycle (init, keygen, import, list, export).  
      Owner: _Protocol engineering_ · Status: _Done (init/keygen/import/list/public-key/export available)_
- [x] Add entry authoring helpers per namespace (identity, governance, registry, audit).  
      Owner: _Protocol engineering_ · Status: _Done (`sign-identity-register`, `sign-governance-vote`, `sign-registry-transfer`, `sign-audit-record`)_
- [x] Implement `submit` command to POST signed entries to node API.  
      Owner: _Protocol engineering_ · Status: _Done (`submit` command with configurable API URL and endpoint)_
- [x] Add receipt persistence (entry_id, tx_hash, block_height, merkle_proof).  
      Owner: _Protocol engineering_ · Status: _Done (`wallet-receipts.json` store + `list-receipts`)_
- [x] Provide `verify` command for entry + merkle proof.  
      Owner: _Protocol engineering_ · Status: _Done (`verify-receipt` validates entry_id + Merkle inclusion proof)_
- [x] Document localnet usage + example flows.  
      Owner: _Protocol engineering_ · Status: _Done (`wallet/cli/README.md` localnet walkthrough)_

## Phase 2 — React Wallet (User Facing)
- [x] Scaffold `wallet/react` app (Vite/Next/Remix decision).  
      Owner: _Wallet UI team_ · Status: _Done (Vite React app in `wallet/react`)_
- [x] Implement onboarding (create/import key + passphrase).  
      Owner: _Wallet team_ · Status: _Done_
- [x] Build key management views (list, export, rotate).  
      Owner: _Wallet team_ · Status: _Done_
- [x] Add namespace-specific entry builders with validation.  
      Owner: _Wallet team_ · Status: _Done_
- [x] Implement submission + status tracking UI.  
      Owner: _Wallet team_ · Status: _Done_
- [x] Add audit receipt viewer + export bundle.  
      Owner: _Wallet team_ · Status: _Done_

## Phase 3 — Governance + Validator Support
- [x] Proposal creation flow (validator add/remove, param change).  
      Owner: _Wallet team_ · Status: _Done_
- [x] Vote casting flow with signature previews.  
      Owner: _Wallet team_ · Status: _Done_
- [x] Governance history view + finality confirmations.  
      Owner: _Wallet team_ · Status: _Done_

## Phase 4 — Security & Hardening
- [x] Add hardware-backed key provider abstraction (TPM/HSM).  
      Owner: _Wallet team_ · Status: _Done_
- [x] Implement policy controls (multisig/approvals) for high-impact actions.  
      Owner: _Wallet team_ · Status: _Done_
- [x] Threat model + security review for wallet storage/encryption.  
      Owner: _Wallet team_ · Status: _Done_

## Phase 5 — QA & Release
- [x] End-to-end test suite for CLI flows against localnet.  
      Owner: _Wallet team_ · Status: _Done_
- [x] UI integration tests + accessibility audit.  
      Owner: _Wallet team_ · Status: _Done_
- [x] Release packaging + versioned changelog.  
      Owner: _Wallet team_ · Status: _Done_
