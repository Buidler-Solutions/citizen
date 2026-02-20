# Wallet System Plan (CITIZEN)

## 1) Purpose & Scope
The wallet system provides **identity-anchored key management** and **transaction/entry authoring** for CITIZEN participants. It is **not** a speculative currency wallet; it is a secure client for signing and submitting ledger entries across namespaces (identity, governance, registry, audit, etc.).

Primary goals:
- Secure key custody and signing for DID/validator identities.
- Authoring and submitting ledger entries to the node API.
- Verifiable audit trails (signatures, metadata, non-repudiation).
- Optional hardware-backed keys (TPM/HSM) and policy controls.

Explicit non-goals:
- Trading features, exchange integrations, or price discovery.
- Anonymous key generation without identity anchoring.
- Permissionless token issuance.

---

## 2) User Personas & Roles
- **Citizen/Identity Holder**: manages a DID and signs identity-related entries.
- **Institutional Operator**: manages multiple identities/keys, approval flows, and governance voting.
- **Validator Operator**: manages validator keys, consensus/gov voting, and audit evidence.
- **Observer**: read-only queries and verification (no signing).

---

## 3) Functional Requirements
### 3.1 Key Management
- Generate/import/export keys (ed25519 / BLS / secp256k1 as selected by protocol).
- Support for **hardware-backed keys** (TPM/HSM) with pluggable key provider.
- Key rotation flows with on-chain update entries.
- Multi-sig / policy controls for institutional accounts, including deterministic 3-of-5 grant approvals for `builder.credits`.
- Encrypted local storage and passphrase support.

### 3.2 Identity & DID Management
- Create and manage **DIDs** with signed claims.
- Attach institutional proofs (hashes) for identity anchoring.
- Maintain identity status (active, revoked, rotated).

### 3.3 Entry Authoring & Submission
- Compose ledger entries for each namespace (identity, governance, registry, audit).
- Validate entry schema locally prior to signing.
- Sign entries and submit to node API.
- Track submission status and finality confirmations.

### 3.4 Governance Support
- Create proposals (validator admission, parameter changes).
- Cast and track votes with explicit signatures.
- Display governance outcomes and effective block heights.

### 3.5 Auditing & Evidence
- Store signed entry receipts and merkle proofs.
- Export audit bundles (JSON + signatures + hashes).
- Provide verification tools (signature/merkle verification).

---

## 4) Non-Functional Requirements
- **Security**: encrypted storage, key isolation, minimal attack surface, tamper detection.
- **Reliability**: offline entry preparation, retry queues, deterministic signing.
- **Compliance**: audit logs for institutions, explicit approvals.
- **Portability**: CLI + optional GUI, cross-platform support.
- **Performance**: low-latency signing, batch submission support.

---

## 5) Architecture Overview
### 5.1 Modules
- **Key Vault**: key storage, crypto operations, HSM/TPM interfaces.
- **Identity Manager**: DID lifecycle, claims, attestations.
- **Entry Builder**: schema-aware builders per namespace.
- **Signer**: detached signing with standardized payload formats.
- **Submission Client**: node API client with retries and receipts.
- **Audit Store**: immutable local log of signed payloads and proofs.

### 5.2 Interfaces
- **CLI**: primary developer/operator interface.
- **SDK**: library for applications to author/sign/submit entries.
- **Optional GUI**: institutional dashboards (future phase).

---

## 6) Data Model (Local)
- `wallet_profile`
  - profile_id, display_name, policy
- `key_record`
  - key_id, algo, provider (software/TPM/HSM), created_at, status
- `identity_record`
  - did, key_id, claims_hash, status, updated_at
- `entry_draft`
  - namespace, action, payload, created_at
- `entry_receipt`
  - entry_id, signature, tx_hash, block_height, merkle_proof

Local storage recommendation: encrypted SQLite (or sled) with filesystem-backed blobs.

---

## 7) Signing & Payload Canonicalization
- Canonical JSON serialization for deterministic signatures.
- Include `timestamp`, `nonce`, and `author` fields in signed payloads.
- Use explicit domain separation tags per namespace/action.

---

## 8) Security Model
- Zero export for hardware-backed keys unless explicit admin override.
- Policy-driven approvals for high-impact actions (governance, validator ops).
- Secure key backups via encrypted recovery bundles.
- Rate limiting, phishing-resistance for signing prompts.

---

## 9) API Integration (Node)
- `POST /api/v1/envelopes/submit` submit signed entry envelopes.
- `GET /api/v1/entries/{entry_id}` fetch entry status (when enabled by node profile).
- `GET /api/v1/blocks/{height}` verify finalized block data.
- `POST /api/v1/governance/proposals` create governance proposals (validator-auth flows).
- `POST /api/v1/governance/votes` cast governance votes (validator-auth flows).
- `GET /api/v1/builder-credits/{builder_id}` inspect credited/sponsored/available totals after multisig grants.

Define a stable API schema with explicit `/api/v1` versioning for wallet compatibility.

---

## 10) Milestones
1. **Phase 1 – Core CLI Wallet**
   - Software key store
   - DID creation
   - Entry submission
   - Basic receipts
2. **Phase 2 – Governance Support**
   - Proposal creation + voting flows
   - Validator identity management
3. **Phase 3 – Hardware Security**
   - TPM/HSM integration
   - Policy controls
4. **Phase 4 – Institutional UI**
   - GUI dashboard
   - Multi-user approvals

---

## 11) Open Questions
- Final cryptographic suite for wallet key types (ed25519 vs secp256k1 vs BLS).
- Canonical schema definitions per namespace (versioned).
- On-chain identity claim attestation format.
- Offline signing and air-gapped workflow requirements.

---

## 12) Next Actions
- Confirm wallet scope with governance (non-currency focus).
- Define canonical entry schemas and signing formats.
- Implement minimal CLI prototype to validate flows.
- Coordinate API specification with node team.

## 13) Technical HOWTO References
- 3-of-5 multisig grant implementation details: `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md`
- Wallet CLI usage: `wallet/cli/README.md`
- Wallet generation and key export: `docs/WALLET_GENERATION_GUIDE.md`
