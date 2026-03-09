# Off-Chain Encrypted Files — First 10 Tickets (Created + Assigned)

Status: ✅ Created and assigned
Date: 2026-03-08
Reference: `OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md` Section "First 10 implementation tickets"

## Ticket Board

| # | Ticket ID | Title | Owner Team | Due Date | Status |
|---|---|---|---|---|---|
| 1 | OFFCHAIN-001 | Spec: canonical encrypted file manifest JSON schema + examples | Protocol | 2026-02-10 | Done |
| 2 | OFFCHAIN-002 | Spec: namespace field policy JSON schema + examples | Protocol | 2026-02-10 | Done |
| 3 | OFFCHAIN-003 | Crypto: deterministic canonicalization for manifest + field commitments | Wallet/SDK | 2026-02-14 | Done |
| 4 | OFFCHAIN-004 | Test: shared vectors consumed by Rust and TypeScript | Protocol + SDK | 2026-02-14 | Done |
| 5 | OFFCHAIN-005 | Wallet: streaming encrypt/decrypt (passphrase mode) | Wallet | 2026-02-18 | Done |
| 6 | OFFCHAIN-006 | Wallet: hybrid ACL/DEK wrapping with per-wallet wraps | Wallet | 2026-02-20 | Done |
| 7 | OFFCHAIN-007 | SDK: namespace-aware payload field partitioning helper | SDK | 2026-02-20 | Done |
| 8 | OFFCHAIN-008 | API: `/files/intents` with consent + policy precheck | API/Node | 2026-02-22 | Done |
| 9 | OFFCHAIN-009 | API: `/files/commit` and `/payloads/commit` idempotent endpoints | API/Node | 2026-02-25 | Done |
| 10 | OFFCHAIN-010 | Security: adversarial suite (unauthorized decrypt + replay) | Security + QA | 2026-02-28 | Done |

## Notes

- Ticket completion is evidenced by merged code/tests/docs referenced in the implementation plan checklists.
- Future scope expansion uses new IDs starting at `OFFCHAIN-011`.
- Any reopened ticket must include updated threat-model impact notes and gate impact (`Gate 0`, `Gate 1`, or `Gate 2`).
