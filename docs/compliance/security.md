# Security Policies

The Citizen project maintains formal security policies covering backup, disaster recovery, encryption, key management, and incident response.

## Policy Documents

### [Backup Policy](https://github.com/greenarmor/citizen/blob/main/security/backup-policy.md)
Defines backup procedures, frequency, verification, and retention for protocol data and wallet backups.

### [Disaster Recovery](https://github.com/greenarmor/citizen/blob/main/security/disaster-recovery.md)
Outlines recovery procedures for validator failures, storage corruption, network partitions, and complete network restart scenarios.

### [Encryption Standard](https://github.com/greenarmor/citizen/blob/main/security/encryption-standard.md)
Specifies the cryptographic algorithms, key sizes, and protocols used throughout the system:

| Use Case | Algorithm |
|----------|-----------|
| Transaction signing | Ed25519 |
| Data decryption key exchange | X25519 ECDH |
| Transaction encryption | ChaCha20-Poly1305 |
| Backup vault encryption | AES-256-GCM |
| Key derivation (mnemonic → seed) | PBKDF2-HMAC-SHA512 (2048 iters) |
| Key derivation (backup password) | PBKDF2-HMAC-SHA512 (210K iters) |
| Canonical hashing | SHA-256 |

### Key Management

Key management follows these principles:

- **Node identity keys** - generated locally, stored in `data/IDENTITY`, must be backed up securely
- **Wallet private keys** - stored in platform secure storage (Keychain, Keystore, OS keyring)
- **Wallet mnemonics** - stored in platform secure storage, never in plaintext
- **Backup vault keys** - derived from user password via PBKDF2, never stored

### [Incident Response](https://github.com/greenarmor/citizen/blob/main/security/incident-response.md)
Defines the incident response process for security events including:

- Vulnerability disclosure procedures
- Incident severity classification
- Response team roles and responsibilities
- Communication protocols
- Post-incident review process

## Secret Scanning

The project includes automated secret scanning via `.github/workflows/secret-scan.yml` which runs on every push and pull request.

## Dependency Scanning

Dependency vulnerabilities are checked via `.github/workflows/dependency-scan.yml` which runs `npm audit` across all Node.js workspaces in the monorepo.

## Security Reviews

Wallet-specific security reviews are documented in:

- `wallet/docs/WALLET_SECURITY_REVIEW.md`
- `wallet/docs/WALLET_SIGNED_SUBMISSION_ARCHITECTURE_DECISION.md`
- `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_THREAT_MODEL.md`
- `citizen-protocol/docs/OFFCHAIN_ENCRYPTED_FILES_SECURITY_DESIGN_REVIEW_SCHEDULE.md`
