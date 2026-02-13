# Wallet Security Hardening Review (Phase 4)

Date: 2026-02-11

## Implemented hardening items

- Added hardware-key provider abstraction in the wallet core (`KeyProvider`) to support software and hardware-backed signing providers.
- Added policy control primitives for high-impact actions (`ActionPolicy`, multisig approval checks).
- Added explicit threat checklist and recommended controls for CLI and React contexts.

## Threat model summary

1. **Keystore theft**
   - Mitigation: encrypted secret keys, passphrase-derived key encryption, key export controls.
2. **Malicious submission tampering**
   - Mitigation: deterministic canonical payload signing and signature verification.
3. **High-impact governance action abuse**
   - Mitigation: policy threshold checks before signing/submission.
4. **Hardware key substitution attacks**
   - Mitigation: provider identity metadata + explicit allowlist of trusted key providers.

## Remaining follow-up

- Integrate real TPM/HSM providers behind `KeyProvider` trait.
- Introduce audited external signer over IPC/USB with attestation support.
- Add independent cryptographic review before production launch.
