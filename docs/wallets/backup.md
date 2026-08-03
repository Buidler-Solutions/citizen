# Backup Vault

The backup vault provides encrypted wallet export and import for secure key backup and cross-device transfer.

## Overview

Backup vaults allow users to encrypt their wallet keys with a password and export them as a portable file. This file can be stored offline, transferred to another device, or used for disaster recovery.

## Encryption

| Parameter | Value |
|-----------|-------|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2-HMAC-SHA512 |
| Iterations | 210,000 |
| Salt | Random (stored in envelope) |
| Nonce | Random (stored in envelope) |

## Backup Format

Backups use the `backup-command-envelope.v1` schema:

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "kdf": {
    "name": "pbkdf2",
    "hash": "sha512",
    "iterations": 210000,
    "salt": "<base64>"
  },
  "nonce": "<base64>",
  "ciphertext": "<base64>",
  "timestamp": "<iso8601>"
}
```

## Creating a Backup

=== "Desktop Wallet"
    Vault → Export Backup → Enter password → Save file

=== "Browser Extension"
    Settings → Backup → Enter password → Download file

=== "CLI"
    ```bash
    citizen-wallet-cli backup \
      --wallet-id <id> \
      --output backup.citizen-vault \
      --password
    ```

## Restoring from Backup

=== "Desktop Wallet"
    Vault → Import Backup → Select file → Enter password

=== "Browser Extension"
    Settings → Restore → Select file → Enter password

=== "CLI"
    ```bash
    citizen-wallet-cli restore \
      --input backup.citizen-vault \
      --password
    ```

## Security Considerations

- The backup password is **never stored** — it exists only in memory during encrypt/decrypt
- A wrong password produces an authentication error (AES-GCM tag verification fails)
- The 210K PBKDF2 iteration count provides strong resistance to brute-force attacks
- Always store backup files offline and in multiple physical locations

## Desktop Rust Bridge

The desktop wallet uses a Rust bridge (`backup_bridge.rs`) for backup operations, keeping cryptographic operations in the compiled native layer rather than the JavaScript frontend. This provides an additional security boundary.
