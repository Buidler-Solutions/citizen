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

## 13. Production depth: persistence, refunds, limits, external oracle

Closes the Tier 2 deployment blockers and the Tier 1 node-operation gap
with live evidence.

### Persistence and rehydration

- `PersistenceModule` (dynamic imports, zero hard dependencies) write-through
  upserts hunts, claims, claim requests, roles, wallets, verdicts, consents,
  events, notifications, orgs and unlocked clues to Postgres via Prisma
  (pinned to 6.x; Prisma 7 dropped schema-level `DATABASE_URL`), publishes
  every event to the Redis stream `treasurenet:events`, and delivers
  notifications to `TREASURENET_NOTIFY_WEBHOOK_URL` with a 5s timeout.
- Boot order in `main.ts`: connect, rehydrate the in-memory store from
  Postgres, attach for write-through, restore the durable retry queue,
  bootstrap modules, refresh the chain height hint, then start the indexer
  and scheduler. The smoke restart scenario proves a hunt survives a cold
  restart via the projection.
- The server remains the source of truth for chain writes; Postgres is a
  projection. Chain errors surface to the client regardless of projection
  state.

### Dual refund signatures and self-serve scheduler refunds

- The escrow and hunt modules sign different refund messages
  (`refund:<escrow_id>` vs `refund:<hunt_id>:<gm_did>`), so refunds carry
  both signatures and each module verifies its own.
- When `TREASURENET_GM_REFUND_KEY` matches a hunt's GM DID, the scheduler
  completes expired hunts itself instead of waiting for the GM console. It
  retries every tick until the on-chain deadline block passes because the
  escrow deadline block can lag wall-clock expiry.

### Rate limiting

- Token-bucket limiter per client IP (`X-Forwarded-For` aware) with a
  stricter authenticated-request class; over-limit calls get 429 plus
  `Retry-After`. Tunable via `TREASURENET_RATE_LIMIT_PER_MIN` (default 240)
  and `TREASURENET_RATE_LIMIT_AUTH_PER_MIN` (default 30).

### External oracle mode

- `TREASURENET_ORACLE_MODE=external` POSTs
  `{hunt_id, player_did, clue_index, photo_b64, geo_ok}` to
  `TREASURENET_ORACLE_URL` and expects
  `{passed, confidence, reason, verdict_signature, oracle_did}`. When
  `TREASURENET_ORACLE_VERIFIER_DID` is pinned, the verdict DID must match
  and the signature must verify; external failures surface as 400
  (`OracleUnavailable`/`VerificationFailed`) instead of silently falling
  back to the heuristic.

### Node mode on a live chain

- `deploy_treasurenet.py --bootstrap-governance` submits the governance
  PROPOSE+APPROVED entries the modules demand for first configure, then
  registers, activates and configures treasure-escrow.v1, treasure-hunt.v1,
  player-registry.v1 and ctzn-token.v1 (issuers: service+oracle, threshold
  2) in one run.
- Node-mode smoke passes the full journey against
  `config/solo/validator-solo-tn.toml` (single validator, mock network,
  advancing blocks): role grants, hunt create/fund/activate, consent, GPS
  check-ins, oracle claim, 2-of-2 payout, on-chain soulbound CTZN mint,
  wallet balance and receipts, mobile claim request plus GM approval,
  scheduler refund after escrow expiry, orgs CRUD, admin persistence
  status, retry flush and rate limits.
- Two protocol fixes were required and are part of the workspace: the
  ledger host accepts module signature messages hex-encoded or raw UTF-8,
  and module state reads select the latest write deterministically (v7
  time-ordered entry ids) instead of relying on RocksDB scan order of
  random UUIDs. The consensus engine also evicts stale rounds so a failed
  proposal round cannot freeze block production.
- Node-mode claims reference their finality as `node:<height>:<escrow_id>`
  because module executions finalize through block height plus module
  state rather than ledger receipt ids; the wallet enriches receipts from
  the chain when a ledger receipt id exists.

### Multi-validator triolet verification

- `config/triolet/validator-{alpha,beta,gamma}-tn.toml` run a 3-validator
  localnet (api 8091/8092/8093, QUIC 9210-9212) with the bare `governance`
  namespace, `game.hunts`, and `asset`/`identity` added to the allowed
  module classes.
- Protocol support for replication: consensus gossips and block-includes
  `execution.module`, `governance` and `game.hunts` entries alongside the
  civic namespaces; STATE_WRITE entries carry `payload.module_id` and are
  validated on receipt by recomputing the SHA-256 commitment over
  `STATE_WRITE\n<module_id>\n<key>\n<value>` rather than re-executing the
  module.
- Verified live: rotating proposers with 3-party aggregated commit
  signatures, identical heights across validators, identical module state
  (REGISTER/ACTIVATE/STATE_WRITE counts) after deploy, and the full
  node-mode smoke green against the triolet with the treasurenet backend
  pointed at the alpha API.
- Boot recipe: fresh `data/triolet-tn-*` dirs, start all three
  `validator-*-tn.toml` nodes, then `deploy_treasurenet.py
  --bootstrap-governance --node http://127.0.0.1:8091 ...` and run the
  smoke with `TREASURENET_NODE_URL=http://127.0.0.1:8091`.

## 14. Encrypted clue delivery, anti-spoof mobile, governance and oracle service

Closes gaps 3, 10, 12, 13 and 14 with live node-mode evidence.

### Node files API additions

- The node API gained local object-store endpoints the generated intent
  upload URLs pointed at but nothing served: `PUT
  /api/v1/files/upload/local/:namespace/:object_id/:intent_id` validates
  the intent still matches (namespace, object, author, byte count equals
  `file_size_bytes`), stores the bytes keyed by object ref and returns the
  sha256 ciphertext hash; `GET /api/v1/files/local/:namespace/:object_id/:intent_id`
  serves the bytes back and falls back to manifest lookup by `file_ref`
  once the intent is consumed by the commit (expected ref shape
  `<prefix>.cipher`). Rust round-trip test:
  `local_object_store_upload_and_download_roundtrip` in `citizen-api`.
- The ledger accepts `offchain_encrypted_file_policy` as a namespace rule
  (enforcement lives at the API edge), and consensus replicates the
  `treasure.files` namespace (REPLICATED_NAMESPACES).

### Files-enabled solo node profile

- `config/solo/validator-solo-tn-files.toml`: solo validator on api 8185 /
  QUIC 9203 with `api_offchain_encrypted_files_v1_enabled = true`, an
  `[[api_clients]]` service key entry (scopes incl. `files.*`), the
  `treasure.files` namespace (`offchain_encrypted_file_policy`: 1 MiB cap,
  aes-gcm-256, ENCRYPTED_FILE_COMMIT/REVOKE actions) and a
  `consent.receipt` namespace (open writers, require_signature,
  CONSENT_GRANTED/CONSENT_REVOKED) — the files intent path requires the
  consent receipt on-chain in that namespace, which the standard tn configs
  do not carry.
- Gotchas learned live: `citizen-node` takes the config path as a
  positional argument (`./target/debug/citizen-node config/solo/...`),
  NOT a `--config` flag — a flag is silently treated as the path,
  `NodeConfig::load` fails and `main()` falls back to `unwrap_or_default`
  (validator.local, api 8080, `data/`). The `files_config_parses` test in
  citizen-node now guards the shipped config. Also: node-mode hunt creation
  refreshes the chain height hint before converting short wall-clock
  expiries to `expires_block`, otherwise finalization latency can push the
  derived block at-or-behind the executing block (`InvalidStatus`).

### Clue crypto scheme (and its honest boundary)

- GM console encrypts clue plaintext client-side with WebCrypto
  AES-GCM-256 (random 256-bit key, 12-byte IV), then wraps the content key
  with an AES-GCM key derived via HKDF-SHA256 over the manifest_id (salt
  `treasurenet:clue-key-wrap`, info `clue-aes-key`, zero IV, tag appended).
  The wrapped key attaches separately (`POST /files/clue/key`) with its own
  GM signature (`clue-key:<manifest_id>`).
- Flutter mirrors both steps byte-exactly (`clue_crypto.dart`, package
  `cryptography`; fixed WebCrypto-generated vectors in
  `test/clue_crypto_test.dart`). Reads only decrypt after the node serves
  the ciphertext through the consent-gated read path.
- Boundary: the wrap key is deterministic from the manifest_id, so it
  protects the content key at rest in the store/chain (transport
  protection under GM/service custody) — it is NOT end-to-end encryption
  against a malicious backend. Per-player X25519 ephemeral wrapping is the
  documented follow-up if that threat model matters.

### Backend files flow and governance surface

- `FilesModule` (node mode): GM-signed upload
  (`clue-upload:<hunt>:<index>`) → on-chain CONSENT_GRANTED to
  `consent.receipt` (object_id `<hunt>#<index>`, policy_ref
  `treasurenet:clue-delivery:v1`, 90-day TTL) → file intent → ciphertext
  upload → commit with ENCRYPTED_FILE_COMMIT envelope whose
  payload.manifest_id equals the sha256 canonical-manifest commitment.
  Reads require game unlock + consent + no revocation (`ClueLocked` /
  `ReaderRevoked` 403s); revocation (`clue-revoke:<hunt>:<index>:<reader>`)
  files an ENCRYPTED_FILE_REVOKE entry. `/admin/file-alerts` merges local
  and node-side alerts.
- New env vars: `TREASURENET_NODE_API_KEY` (sent as `x-api-key`; localnet
  runs auth-off and the backend just sends it anyway),
  `TREASURENET_FILES_NAMESPACE` (default `treasure.files`).
- Governance surface: `/admin/governance/proposals*` (propose, decide,
  list). Node mode signs PROPOSE/APPROVED/REJECTED entries to the
  `governance` namespace; the list folds on-chain decisions
  order-independently (PROPOSE pass first, decisions applied by timestamp)
  because the node returns entries in non-chronological order. The admin
  panel ships a propose/decide UI over it.
- Short-expiry fix: hunt creation calls `refreshHeight()` before
  `expiryToBlock` in node mode so tight expiries still land in a future
  block.

### Anti-spoof mobile checks

- `anti_spoof.dart` derives a trust verdict from GPS fix sequences plus
  accelerometer variance: rejects impossible inter-fix speeds
  (`maxPlausibleSpeedMps = 56`), non-increasing timestamps, and
  still-device-with-moving-GPS contradictions (accel variance below
  `stillAccelVariance` while fixes move at sustained walking speed).
- `hunt_provider.trustedFix()` enforces two fixes across a 4s window plus
  sensor variance and rejects `isMocked` fixes outright; the hunt and
  claim screens consume the trusted fix. 7 unit tests cover the
  heuristics.

### Reference oracle service

- `apps/oracle/service.mjs`: `GET /health`, `POST /verdict`
  `{hunt_id, player_did, clue_index, photo_b64, geo_ok}` →
  `{passed, confidence, reason, verdict_signature, oracle_did}` with the
  verdict signed over
  `verdict:<hunt_id>:<player_did>:<clue_index>:<pass|fail>`. Env:
  `ORACLE_KEY_HEX`, `ORACLE_PORT` (default 7760),
  `ORACLE_MIN_PHOTO_BYTES` (default 32). This is the integration template
  for the real model; smoke section 16 runs a claim through it with a
  pinned verifier DID and section 17 proves rogue-DID verdicts are
  rejected.

## 15. Reward custody on citizen-asset.v1 (transferable tokens + vaults)

CTZN is a soulbound identity token — transfers are structurally rejected —
so it cannot back escrowed prizes. Escrow settlement now uses the new
**generic transferable token module** `citizen-asset.v1`
(`citizen-protocol/modules/citizen-asset`, 14 integration tests in
`crates/execution/tests/citizen_asset_test.rs`): issuer-threshold minting,
owner-signed transfer/burn, and **timed M-of-N vaults** as the custody
primitive. The module is deliberately use-case-agnostic (crowdfunding
refunds, delayed payments, governance-gated releases all fit the same
vault shape); TreasureNet is just the first consumer.

### Module operations and signed messages

Formats live in `assetMessages` (`chain/sdk/src/modules.ts`), shared
verbatim by backend, GM console, smoke, and the mock chain.

| Operation | Signed message | Enforced by |
|-----------|----------------|-------------|
| `configure` | `configure:<issuers>:<threshold>` (admin sig; first configure is governance-gated instead) | mirrors ctzn-token bootstrap |
| `create_token` | `create:<token_id>:<symbol>:<decimals>` | issuer threshold |
| `mint` | `mint:<token>:<recipient>:<amount>:<ref>` | issuer threshold |
| `burn` | `burn:<token>:<owner>:<amount>:<ref>` | owner sig |
| `transfer` | `transfer:<token>:<from>:<to>:<amount>:<ref>` | sender sig + balance |
| `open_vault` | `vopen:<vault>:<token>:<threshold>:<expiry>` | admin sig |
| `vault_transfer` | `vt:<vault>:<to>:<amount>:<ref>` | pre-expiry: approver threshold; post-expiry: ONLY fallback owner (empty signature rejected before host verify) |
| `balance` / `token_info` / `vault_info` | — | reads |

Vault balances live in the generic balance namespace under account
`vault:<vault_id>` (a separate per-vault balance key was the first cut and
broke deposit-then-payout; unified so `vault_transfer` and `transfer`
share one ledger).

### TreasureNet wiring

- Default hunt reward is the transferable asset `treasurenet.gold`
  (TNG, 2 decimals), created idempotently at server bootstrap
  (`ensureRewardAsset`, issuer-threshold signed by service+oracle).
  Env: `TREASURENET_ASSET_MODULE` (default `citizen-asset.v1`),
  `TREASURENET_REWARD_ASSET` (default `treasurenet.gold`).
- **create**: escrow init + `create_hunt` + `openRewardVault` — vault
  `esc-<huntId>`, approvers GM+oracle, threshold 2, fallback owner GM,
  expiry = the hunt deadline block.
- **fund** (`asset_gm_signature`): issuers mint to the GM
  (`mint:...:fund-<hunt>`), then the GM deposits into
  `vault:esc-<huntId>` by signing
  `transfer:<token>:<gm>:vault:<escrow>:<amount>:deposit-<hunt>`. The
  signature is verified server-side before any chain state moves.
- **claim** (`asset_gm_signature`): GM co-signs
  `vt:<escrow>:<winner>:<amount>:claim-<hunt>`, the backend adds the
  oracle co-signature and the vault pays the winner real tokens.
- **refund after expiry**: only the fallback owner can reclaim — GM signs
  `vt:<escrow>:<gm>:<amount>:refund-<hunt>`; the scheduler adds it
  (from `TREASURENET_GM_REFUND_KEY`) to its self-serve refund envelope.
- Wallet `GET /wallet/:did/balance` reads the asset module in both modes
  (mock parity); unreachable module → local projection of confirmed
  custody payouts.
- Hunts created with an explicit non-default `reward_token` keep the
  legacy escrow-only path (the smoke's refund hunt uses `"CTZN"` to prove
  both branches).
- Failure ordering: the claim settles the vault payout BEFORE the
  hunt/escrow completion writes — an under-funded or missing vault fails
  the claim while the hunt is still active (retryable), never stranding a
  winner behind a Completed hunt. The deadline window is covered: an
  escrow claim accepted at exactly the deadline block pays out one block
  later via the expired branch, which accepts the fallback owner's
  signature anywhere in the cosigner pair (regression test
  `asset_vault_deadline_window_payout_after_expiry_with_pair`). Refunds
  treat the vault reclaim as idempotent (`ReplayedSubmission`,
  `InsufficientVaultFunds`, `VaultNotFound` = nothing left to move) so a
  partially-funded vault cannot loop the scheduler against an
  already-refunded escrow.
- Deploy: `deploy_treasurenet.py` registers `citizen-asset.v1` with
  `module_class="asset"` (special-cased; the old prefix heuristic would
  have mislabeled it `identity`), bootstraps governance proposal
  `proposal-treasurenet-asset`, and configures issuers
  `<admin>,<oracle>` threshold 2. Server-side reconfigure carries the
  admin signature over `configure:<issuers>:2`.

### Mock parity fixes that surfaced during wiring

- The mock's replay-scope key now matches the gateway exactly
  (`vault_id`/`ref` included) — without it a second mint of the same
  token was rejected as `ReplayedSubmission`, and repeated `balance`
  reads were treated as writes. Read-op lists are identical too.
- Two module bugs were caught by the Rust tests before deployment:
  vault balances in a separate key namespace (deposit-then-payout broke)
  and an empty fallback-owner signature passing host verification.

## 16. Full game flow: funding gate, admission, sequential clues, instant claim

The Stellar contract activated hunts unconditionally; here the complete
game-design loop is enforced across modules and backend:

- **Funding gate**: `treasure-hunt.v1` rejects `activate` unless the hunt
  is `funded` (`InvalidStatus`), and the backend only accepts joins while
  a hunt is `active` — so no game can start without the GM funding the
  escrow (and depositing real tokens for custody hunts).
- **Admission** (`POST /games/:id/join`, player session): `admission`
  on hunt create is `{mode: "free"|"paid", fee_amount}`. Paid joins
  require the player's `payment_signature` over the canonical transfer
  `transfer:<token>:<player>:<gm>:<fee>:join-<huntId>`; the backend
  verifies it against the player's DID key and relays the transfer to
  `citizen-asset.v1` before recording the participant (`fee_paid`
  persisted in the new `HuntParticipant` projection table). Roster:
  `GET /games/:id/players`; hunts carry `player_count`.
- **Sequential clue chain**: check-ins now require participation
  (`NotParticipant`) and unlock strictly in order — only the next
  expected clue index opens (`OutOfOrderClue`); already-unlocked clues
  stay readable for review. The GM's per-clue riddles/hints ride the
  existing AES-GCM encrypted clue channel (console uploads them at
  create time), so each solved riddle reveals the next coordinates.
- **Instant claim** (`auto_claim: true` on create): the GM signs a claim
  delegation at setup — `delegate:<huntId>:<serviceDid>` and
  `delegate:<escrowId>:<serviceDid>` — executed on both modules via the
  new `set_claim_delegate` operation (owner-gated, re-callable to
  rotate, refunds stay owner-only). The reward vault for such hunts is
  opened with approvers `<gm>,<service>,<oracle>` threshold 2 (fallback
  GM), so both manual (GM+oracle) and delegated (service+oracle) payouts
  verify. When the first player unlocks the final treasure coordinates,
  the same request settles: the service DID signs both claim envelopes
  as the GM's delegate, the oracle co-signs the geo verdict
  (`evaluateInstant`: final-coordinate geo proof replaces the photo —
  the GM pre-authorized settlement), `vaultPayoutDelegated` moves the
  tokens, then the hunt/escrow complete. The same
  payout-before-completion failure invariant as manual claims applies.
- Refund authority is unchanged: only the GM (owner) can refund, and a
  delegate cannot (`hunt_refund_delegate_rejected` regression test).
- Backend error mapping: module rejections (mock chain errors and
  `ModuleError`) now surface as HTTP 400 with the module's error code
  instead of a generic 500.

