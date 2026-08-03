# GDPR Compliance

Citizen is designed with GDPR compliance as a first-class concern. The project maintains a comprehensive compliance framework covering data protection, privacy by design, and data subject rights.

## Compliance Framework

The project uses the **GESF (Governance Evidence & Security Framework)** for automated compliance monitoring. Configuration and evidence are tracked in the `.ges/` directory.

## Data Protection Documents

| Document | Purpose |
|----------|---------|
| [Data Inventory](https://github.com/greenarmor/citizen/blob/main/compliance/data-inventory.md) | Categories of personal data processed |
| [Processing Records (ROPA)](https://github.com/greenarmor/citizen/blob/main/compliance/processing-records.md) | Article 30 records of processing activities |
| [Privacy Impact Assessment](https://github.com/greenarmor/citizen/blob/main/compliance/privacy-impact-assessment.md) | DPIA for data protection risk assessment |
| [Risk Register](https://github.com/greenarmor/citizen/blob/main/compliance/risk-register.md) | Identified risks and mitigation measures |
| [Retention Policy](https://github.com/greenarmor/citizen/blob/main/compliance/retention-policy.md) | Data retention periods per category |
| [Access Control Matrix](https://github.com/greenarmor/citizen/blob/main/compliance/access-control-matrix.md) | Role-based access controls |

## Privacy by Design

Citizen implements privacy by design through:

### On-Chain / Off-Chain Separation
- **On-chain**: Only commitments, proofs, and events (no personal data)
- **Off-chain**: Encrypted user-controlled data custody

### Selective Field Privacy
- Individual fields within entries can be encrypted
- Users control decryption through hybrid ACL/DEK-based sharing

### Consent Receipts
- Namespace policies can require consent receipts for entries
- Consent is recorded on-chain with audit trails

### Encryption by Default
- Off-chain data is encrypted with ChaCha20-Poly1305 (via X25519 ECDH)
- Backup vaults use AES-256-GCM with PBKDF2 (210K iterations)

## Data Subject Rights

The protocol's architecture supports GDPR data subject rights:

| Right | Implementation |
|-------|---------------|
| Access | Users can decrypt and view their own data |
| Rectification | Users can submit corrected entries |
| Erasure | Off-chain data is user-controlled; on-chain commitments are immutable by design (ledger integrity) |
| Portability | Encrypted backup vaults enable data export |
| Objection | Consent policies allow users to withhold consent |

## Control Packs

The project maintains control packs for multiple frameworks:

- **GDPR** — General Data Protection Regulation
- **OWASP** — Application security best practices
- **CIS** — Critical Security Controls
- **NIST** — Cybersecurity Framework

These are configured in the `.ges/` directory and validated through the CI compliance workflow.

## CI Compliance Checks

The `.github/workflows/compliance.yml` workflow runs GESF audits on every push, checking for:

- Secret exposure
- Weak cryptography
- Injection vulnerabilities
- Authentication issues
- Configuration problems
- Database anti-patterns

Findings are reported but do not block CI (configured with `continue-on-error`).
