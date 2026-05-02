# Wallet Backup USB Cross-Machine Drill — 2026-05-02

## Objective

Record one end-to-end operator drill for the checklist requirement:

- create on USB A,
- verify on machine 1,
- restore on machine 2,
- capture caveats.

## Environment

- Date: 2026-05-02 (UTC)
- Vault contract: `citizen.wallet.backup.v1`
- CLI contract: `citizen.wallet.backup.cli.v1`
- Media profile: removable USB (portable label set during init)

## Procedure Summary

1. **Machine 1 — create + export**
   - Initialized vault on removable media with portable label.
   - Added `decoy` and `critical` slots.
   - Exported wallet credentials into encrypted slot payloads.
2. **Machine 1 — verify**
   - Ran verify flow for both roles and captured deterministic JSON status.
3. **Machine 2 — restore + verify continuity**
   - Mounted same removable media.
   - Restored selected role into clean wallet profile.
   - Re-verified checksum/decrypt path and identity continuity expectations.

## Result

- Drill status: **PASS** for create/export/verify/restore command path continuity across two machines.
- Deterministic contract behavior observed for success and advisory messages.

## Observed Caveats

1. Desktop rehearsal builds are unsigned in local/dev paths; production trust posture still depends on signed packaging completion.
2. Safe-eject may require manual OS fallback when adapter command tooling is unavailable or blocked by local policy.
3. Cross-platform parity remains partially open until full Linux/macOS/Windows runtime-backed smoke evidence is attached.

## Follow-up Actions

- Keep signed artifact and reproducible metadata workstream open in the portable app track.
- Continue runtime adapter parity evidence collection for removable-media operations.
- Re-run this drill after packaging/signing and adapter parity milestones close.
