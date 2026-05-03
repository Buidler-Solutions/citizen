# Wallet Desktop Release Checklist Template (Checkpoint 9 R9-D)

Status: **Template-only (pre-evidence)** — use this checklist to capture final sign-off once packaging/signing and bridge audit prerequisites are complete.

## Scope

Use this template to record the R9-D release checklist packet for wallet desktop alpha/beta gates.

## Required Attachments

- Signed desktop artifacts for Linux/macOS/Windows with immutable digest references.
- Reproducibility notes (build host, toolchain versions, command transcript, artifact hash comparison).
- Final bridge memory/logging audit report confirming no plaintext secret exposure in:
  - runtime bridge logs,
  - crash artifacts,
  - diagnostic bundle exports.

## Maintainer Sign-off Table

| Owner Area | Required Reviewer | Decision | Date (UTC) | Evidence Link |
| --- | --- | --- | --- | --- |
| Wallet | _TBD_ | Pending | _TBD_ | _TBD_ |
| Desktop/Runtime | _TBD_ | Pending | _TBD_ | _TBD_ |
| Security | _TBD_ | Pending | _TBD_ | _TBD_ |

## Release Checklist

- [ ] Linux artifact signed + digest linked.
- [ ] macOS artifact signed + digest linked.
- [ ] Windows artifact signed + digest linked.
- [ ] Reproducibility transcript attached and digest parity verified.
- [ ] Bridge memory/logging audit attached.
- [ ] All three owner approvals captured with date stamps.

## Blocking Rules

Do **not** mark R9-D complete until every checklist item above is checked and all evidence links are immutable and readable from the repo documentation index.
