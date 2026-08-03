# Error Codes

## API Errors

| Code | Meaning | Action |
|------|---------|--------|
| `ENTRY_REJECTED` | Entry failed namespace policy validation | Check entry format and namespace requirements |
| `INVALID_SIGNATURE` | Signature verification failed | Verify signer key and signing algorithm |
| `NAMESPACE_NOT_FOUND` | Namespace does not exist or is not active | Check namespace name or wait for governance activation |
| `QUORUM_NOT_MET` | Consensus quorum not achieved | Wait for more validators to come online |
| `DUPLICATE_ENTRY` | Entry with same hash already committed | No action needed — entry is already on-chain |
| `UNAUTHORIZED` | Signer not authorized for the namespace | Check namespace admission policy |
| `PAYLOAD_TOO_LARGE` | Entry payload exceeds namespace size limit | Reduce payload size or use off-chain encrypted storage |

## Off-Chain Encrypted File Errors

| Code | Meaning | Action |
|------|---------|--------|
| `OFFCHAIN_FILES_DISABLED` | Off-chain encrypted files not enabled on this node | Enable `api_offchain_encrypted_files_v1_enabled` in config |
| `INVALID_MIME_TYPE` | File MIME type not in namespace allowlist | Check `offchain_encrypted_file_policy.allowed_mime_types` |
| `OBJECT_STORE_UNAVAILABLE` | Object storage backend not reachable | Check MinIO/S3 configuration |
| `ENCRYPTION_KEY_MISSING` | Required decryption key not provided | Provide reader key material |

## Wallet Errors

| Code | Meaning | Action |
|------|---------|--------|
| `WALLET_LOCKED` | Wallet is locked — password required | Unlock with password |
| `WALLET_NOT_FOUND` | No wallet at the requested ID | Create or import a wallet |
| `INVALID_PASSWORD` | Password verification failed | Retry with correct password |
| `INVALID_MNEMONIC` | Mnemonic fails BIP39 checksum | Verify all words are correct |
| `DERIVATION_FAILED` | SLIP-0010 key derivation failed | Ensure full 64-byte seed is used |

## WalletConnect Errors

| Code | Meaning | Action |
|------|---------|--------|
| `WC_SESSION_EXPIRED` | WalletConnect session has expired | Re-pair with the dApp |
| `WC_METHOD_NOT_SUPPORTED` | Method not registered for this session | Check session method allowlist |
| `WC_REQUEST_REJECTED` | User rejected the request | No action needed |
| `WC_PAIRING_FAILED` | QR code or URI invalid | Generate a new pairing URI |
