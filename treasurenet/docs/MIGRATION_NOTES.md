# Migration Notes: TreasureNet (Stellar/Soroban) to Citizen Protocol

Every deviation forced by the platform move, and why. No em dashes per repo
convention. The ported contract state machines themselves are faithful:
statuses, operations, and error codes match the originals unless listed
here.

## 1. Contracts become WASM modules plus namespaces

- Soroban contract instances with persistent storage map to governance-gated
  WASM modules (`citizen-protocol/modules/`) with host-provided state
  (`host_store_state` / `host_load_state`).
- Contract storage keys become module state keys (`esc:<id>:status`,
  `hunt:<id>:gm`, `p:<did>:role`).
- Cross-contract calls (player-registry consulted by hunt/escrow) become
  backend-mediated checks via module reads at submission time. The runtime
  `host_call_module` cross-call ABI exists but the port keeps authorization
  at the backend boundary for audit simplicity.

## 2. Escrow module

| Aspect | Stellar original | Citizen port | Why |
|---|---|---|---|
| Escrow balance | Contract holds XLM/SAC tokens | Module state tracks amount/token; CTZN distribution records payout under `payout:<id>` | Citizen modules do not custody native balances; the reward token module distributes on payout |
| `claim(winner, caller=owner)` | `require_auth(owner)` only | 2-of-2 multisig: owner plus an authorized oracle, message `claim:<escrow_id>:<winner>` | Port spec requires GM + oracle co-signature for authorized claims |
| New error `OracleSignatureRequired` | did not exist | added | Distinguishes missing oracle co-signature from missing GM signature (`NotOwner`) |
| New errors `AlreadyInitialized`, `Uninitialized`, `InvalidAmount`, `InvalidDeadline`, `SignatureRequired` | contract errors/panics | explicit JSON error codes | Module ABI returns JSON instead of Soroban `Result`/panics; tests assert exact codes |
| Status model | stored Created/Funded/Active/Completed/Refunded/Expired | stored created/funded/completed/refunded plus derived Active/Expired (deadline vs block height) | Avoids a separate activation op the original escrow never exposed; `get_status` reports identical strings |
| Time | ledger close time | block height deadline | Platform time primitive; backend converts `expires_at` timestamps to approximate block deadlines (configurable cadence) |

## 3. Treasure hunt module

| Aspect | Stellar original | Citizen port | Why |
|---|---|---|---|
| Internal escrow | hunt contract held funds | separate escrow module linked by `escrow_id`; fund and claim require GM signatures over both modules' messages | Citizen module boundaries; the port spec defines escrow and hunt as separate modules |
| `fund_hunt` | one require_auth | two signatures: `gm_signature` over `fund:<hunt_id>:<gm>` and `escrow_gm_signature` over `fund:<escrow_id>` | Paired-module funding; the GM console signs both |
| Claim payout | internal token transfer | `payout:<hunt_id>` record plus 2-of-2 multisig claim on both hunt and escrow modules; `TransferFailed` preserved for payout-record write failure | Distribution happens at the reward token layer |
| Double-claim guard | storage status check | status check plus explicit `claimed` marker; `game.claims` namespace ruleset adds unique object ids | Defense in depth required by the port spec |
| Cancel policy | cancel allowed per contract states | cancel from created/funded only (`CannotCancel` otherwise) | Matches observed original test (`cancel_before_activation`); activated hunts must pause/expire/refund instead |

## 4. Identity: soulbound tokens plus player registry

- SBT mint/owner/revoke semantics port to `player-registry` `grant_role`,
  `role_of`, `revoke_role`. Transfers are rejected identically
  (`soulbound: non-transferable`).
- Role assignment requires the module admin (backend service DID) after
  KYC/civic registry checks, mirroring `InsufficientRole` and
  `NoSoulboundToken` via `has_role`/`role_of` error codes.
- The `identity.roles` namespace forbids TRANSFER actions by ruleset, so
  even raw entry submission cannot move a role.
- Original `set_sbt_contract` wiring becomes module `configure`, gated by a
  governance-approved proposal id (Citizen bootstrap rule, same as ctzn-token
  and admin-registry modules in this repo).

## 5. Backend

- NestJS module boundaries, ports (7755 API, 7777 web, 7778 admin), and
  REST shapes are preserved. The initial implementation is dependency-free
  Node (TypeScript, native type stripping) to keep the scaffold runnable
  without an install step; the module folder structure mirrors the NestJS
  layout one-to-one for a mechanical NestJS lift-and-shift.
- Stellar SDK wallet operations become Ed25519 keypair handling:
  challenge-response auth signs `treasurenet-login:<nonce>`.
- Escrow claim flow: oracle verification result plus GM authorization
  assemble the 2-of-2 co-signatures executed against both modules.
- Scheduler expiry watcher marks hunts expired and surfaces pending GM
  refunds. Refund entries are GM-signed (deviation: the original scheduler
  held the owner key and called the contract directly; Citizen keeps owner
  keys with the owner).
- Indexer projects chain writes into the store and emits events for live UI
  plus leaderboard. Postgres/Redis backing is defined in
  `packages/shared/prisma/schema.prisma` but the in-memory store serves the
  API until the database wiring lands (see GAP_ANALYSIS).
- Builder credits sponsor all player-submitted actions; players never hold
  tokens to play.

## 6. Wallets and clients

- Mobile: device-generated Ed25519 keypair in secure enclave, DID
  registration, challenge login; claim screen shows receipt id, block
  height, hash from finality receipts. Full port plan in
  `apps/flutter/README.md`.
- GM console: browser-held keypair (WebCrypto Ed25519 in localStorage,
  Citizen's replacement for Freighter), signs every hunt mutation
  client-side.
- Admin panel: namespace/ruleset overview, role grants/revocations, oracle
  health, file access alerts, live event feed.

## 7. Clues and files

- Clue payloads are encrypted file store manifests (`manifest_id` per
  clue); the hunt entry references manifest ids only. Reader ACLs track
  unlocked players; revocation on cheat detection maps to
  `citizen_revoke_file_reader` and the alerts feed maps to
  `citizen_list_file_alerts`. The current scaffold stores manifest ids and
  gates reads through check-in state; wiring the live file store API is a
  tracked gap.

## 8. Consent

- First location/photo upload creates a consent receipt (90-day expiry,
  location + photo purposes); `ConsentModule.requireValid` gates geo
  check-ins and oracle photo processing, mirroring `citizen_check_consent`.

## 9. Oracles

- The oracle service DID is a configured co-signer on every claim in both
  escrow and hunt modules. Verdicts are Ed25519-signed records
  (`verdict:<hunt>:<player>:<clue>:<pass|fail>`). Key rotation is a module
  reconfiguration (admin-signed) after a civic governance decision.
- The photo verification heuristic in this scaffold stands in for the AI
  model; the verdict signing path is the production interface.

## 10. Testing

- Every original scenario is ported as a deterministic integration test
  against the compiled WASM in `treasurenet_test.rs` (41 tests): escrow
  lifecycle and error matrix, hunt lifecycle, double-claim prevention,
  SBT/registry semantics, unauthorized mutations, transfer rejection.
- Golden JSON fixtures per scenario (the `test_snapshots/` equivalent) are
  the exact module outputs asserted in tests.
- The backend smoke test (`scripts/smoke.mjs`) runs the full E2E player
  journey against the mock chain.

## 11. Replay protection and idempotency

- The module gateway rejects replayed write scopes in-process
  (`ReplayedSubmission`); on-chain replay protection uses the canonical
  entry signature scope (`signature_scope` helper in the chain SDK).

## 12. Player claim requests and GM web approval

The original Stellar app assembled claim envelopes entirely client-side
because the phone wallet held funds. In the Citizen port the player app is
strictly a player surface, GM keys never leave the browser, so the claim
flow gained an explicit approval hop:

- `POST /games/:id/claim/request` (player session): stores photo + geo
  proof as a pending `ClaimRequest` after re-checking the final-clue
  unlock, active status, and proximity. Duplicate pending requests per
  (hunt, player) are rejected with `ClaimAlreadyRequested`.
- The GM console lists pending requests (`GET /claims/pending`) and
  approves by signing both claim messages over the request's player DID;
  `POST /games/:id/claim` with `request_id` resolves the player fields
  from the request, so the approving GM needs no player session. The
  direct path (player session plus pre-issued GM signatures) is unchanged
  and remains what the smoke test's first scenario exercises.
- Denial (`POST /claims/:requestId/deny`) notifies the player without
  touching chain state.

This deviation keeps the signing model verifiable (both GM signatures are
still bound to the winner DID and verified on-chain by the modules) while
matching the split-surface product: mobile players, web GMs.
