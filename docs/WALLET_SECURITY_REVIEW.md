# Wallet Security Hardening Review (Phase 4)

Date: 2026-02-11

## Implemented hardening items

- Added hardware-key provider abstraction in the wallet core (`KeyProvider`) to support software and hardware-backed signing providers.
- Added policy control primitives for high-impact actions (`ActionPolicy`, multisig approval checks).
- Documented deterministic 3-of-5 multisig builder-credit grant mechanics, including approver allowlisting, key binding, and proof validation requirements.
- Added explicit threat checklist and recommended controls for CLI and React contexts.

## Threat model summary

1. **Keystore theft**
   - Mitigation: encrypted secret keys, passphrase-derived key encryption, key export controls.
2. **Malicious submission tampering**
   - Mitigation: deterministic canonical payload signing and signature verification.
3. **High-impact governance action abuse**
   - Mitigation: policy threshold checks before signing/submission.
4. **Multisig grant proof forgery/replay**
   - Mitigation: per-approver signed deterministic payloads, strict approver-to-key matching, and minimum unique proof threshold (`required_grant_approvals`).
5. **Hardware key substitution attacks**
   - Mitigation: provider identity metadata + explicit allowlist of trusted key providers.

## Remaining follow-up

- Integrate real TPM/HSM providers behind `KeyProvider` trait.
- Introduce audited external signer over IPC/USB with attestation support.
- Add independent cryptographic review before production launch.
- Run recurring operational drills using `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md` (manual and programmatic modes).
