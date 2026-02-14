# Asset Control Clawback Behavior Matrix (Opt-In)

This document defines normative `asset.control` behavior for issuer clawback, aligned with the deep-research baseline requirement that clawback is explicit, governed, and holder-visible.

## Policy Flag

- `clawback_enabled`
  - **Meaning:** issuer may submit `ASSET_REVOKE` to remove held units from a holder trustline.
  - **Default:** disabled unless included in `TRUSTLINE_OPEN.payload.policy_flags`.
  - **Holder visibility:** wallets/explorers should display a high-signal warning before trustline opt-in.

## Normative Matrix

| Trustline `clawback_enabled` flag | Action | Required author | Expected outcome |
| --- | --- | --- | --- |
| Disabled | `ASSET_HOLD` | Issuer (`payload.issuer`) | Allowed, subject to trustline and cap checks. |
| Disabled | `ASSET_RELEASE` | Holder (`object_id`) | Allowed with sufficient balance. |
| Disabled | `ASSET_REVOKE` | Issuer | **Rejected**: revocation requires `clawback_enabled`. |
| Enabled | `ASSET_HOLD` | Issuer (`payload.issuer`) | Allowed, subject to trustline and cap checks. |
| Enabled | `ASSET_RELEASE` | Holder (`object_id`) | Allowed with sufficient balance. |
| Enabled | `ASSET_REVOKE` | Issuer | Allowed with sufficient balance; holdings are reduced. |

## Wallet/Explorer Disclosure Requirements

For each trustline position returned by `GET /api/v1/assets/:account_id`:

- If clawback is enabled, render:
  - `Issuer clawback is ENABLED for this trustline. Issuer may revoke held units according to policy.`
- If clawback is disabled, render:
  - `Issuer clawback is DISABLED for this trustline. Only holder-initiated releases reduce holdings.`

Wallets and explorers should present this text before holder opt-in and wherever trustline policy flags are displayed.
