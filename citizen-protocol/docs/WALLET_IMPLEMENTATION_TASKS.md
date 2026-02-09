# Wallet Implementation Task Stubs

This checklist turns the wallet plan into ready-to-assign tasks. It is scoped to the
CLI + React wallet apps while reusing the existing `crates/wallet` library.

## Phase 0 — Repository Prep
- [ ] Confirm Rust wallet crate API surface needed by apps (keygen/import, sign/verify).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Decide storage format for CLI keystore (JSON vs SQLite).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Align on node API base URL + versioning for wallet submissions.  
      Owner: _TBD_ · Status: _Not started_

## Phase 1 — CLI Wallet (Developer/Operator Ready)
- [ ] Scaffold `wallet/cli` as a standalone Rust binary (workspace or separate crate).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Implement CLI commands for key lifecycle (init, keygen, import, list, export).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Add entry authoring helpers per namespace (identity, governance, registry, audit).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Implement `submit` command to POST signed entries to node API.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Add receipt persistence (entry_id, tx_hash, block_height, merkle_proof).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Provide `verify` command for entry + merkle proof.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Document localnet usage + example flows.  
      Owner: _TBD_ · Status: _Not started_

## Phase 2 — React Wallet (User Facing)
- [ ] Scaffold `wallet/react` app (Vite/Next/Remix decision).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Implement onboarding (create/import key + passphrase).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Build key management views (list, export, rotate).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Add namespace-specific entry builders with validation.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Implement submission + status tracking UI.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Add audit receipt viewer + export bundle.  
      Owner: _TBD_ · Status: _Not started_

## Phase 3 — Governance + Validator Support
- [ ] Proposal creation flow (validator add/remove, param change).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Vote casting flow with signature previews.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Governance history view + finality confirmations.  
      Owner: _TBD_ · Status: _Not started_

## Phase 4 — Security & Hardening
- [ ] Add hardware-backed key provider abstraction (TPM/HSM).  
      Owner: _TBD_ · Status: _Not started_
- [ ] Implement policy controls (multisig/approvals) for high-impact actions.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Threat model + security review for wallet storage/encryption.  
      Owner: _TBD_ · Status: _Not started_

## Phase 5 — QA & Release
- [ ] End-to-end test suite for CLI flows against localnet.  
      Owner: _TBD_ · Status: _Not started_
- [ ] UI integration tests + accessibility audit.  
      Owner: _TBD_ · Status: _Not started_
- [ ] Release packaging + versioned changelog.  
      Owner: _TBD_ · Status: _Not started_

