# Gap Analysis: TreasureNet Citizen Edition

What stands between the current scaffold and full production parity with
the original Stellar system. Ordered by blocking impact; each item lists
evidence of current state and the concrete work to close it.

## Tier 1: Blocks real-chain operation

| # | Gap | Current state | Work required |
|---|---|---|---|
| 1 | Governance-gated module bootstrap on a real node | Resolved: verified on both a solo node and a 3-validator triolet localnet. `deploy_treasurenet.py --bootstrap-governance` submits PROPOSE+APPROVED governance entries, registers and configures all four modules (escrow, hunt, registry, ctzn-token); node-mode smoke passes the full player journey including dual-sig refund after expiry and on-chain CTZN mint against rotating proposers with 3-party aggregate commit proofs, and module state (STATE_WRITE entries) replicates identically across all validators | Multi-validator profile is single-writer (backend talks to one node); add entry-submit load balancing only if needed |
| 2 | CTZN reward token distribution on payout | Resolved: escrow payout triggers `ctzn-token.v1 mint` under service+oracle dual signatures (threshold 2); node-mode wallet balance counts soulbound tokens via `owner_of`; `/api/v1/ctzn/:id/check/:did` verified | Consider batch distribution if reward volume grows |
| 3 | Encrypted clue file store integration | Resolved: `FilesModule` drives the full node lifecycle — GM-signed upload (`clue-upload:<hunt>:<index>`) submits an on-chain `CONSENT_GRANTED` consent receipt, creates the file intent, uploads ciphertext, and commits with an `ENCRYPTED_FILE_COMMIT` envelope whose payload `manifest_id` equals the sha256 canonical-manifest commitment; unlock-gated reads via `readFile`, reader revocation via `ENCRYPTED_FILE_REVOKE`; locked/revoked reads surface as `ClueLocked`/`ReaderRevoked` 403s and feed `/admin/file-alerts` alongside node alerts. The node API gained local object-store endpoints (`PUT /api/v1/files/upload/local/:ns/:object/:intent`, `GET /api/v1/files/local/:ns/:object/:intent`) with intent-match + byte-count validation and a Rust round-trip test (`local_object_store_upload_and_download_roundtrip`). Smoke section 13b green in both mock and node mode | MinIO/S3 profile for multi-instance deploys (the node's `api_offchain_minio` config path is exercised by API tests); current local store is per-node |
| 4 | Node-backed wallet balances and receipts | Resolved: node mode reads `owner_of` per confirmed claim for balances and enriches receipts from chain where a ledger receipt id exists; module-execution claims carry deterministic `node:<height>:<escrow_id>` receipt references | None for the solo-node profile; revisit if module executions gain ledger-level receipt ids |

## Tier 2: Blocks production deployment

| # | Gap | Current state | Work required |
|---|---|---|---|
| 5 | Postgres/Redis persistence | Resolved: `PersistenceModule` write-through upserts to Postgres (16 tables), Redis `treasurenet:events` stream fan-out, webhook notification delivery, boot-time rehydration verified by the smoke restart scenario (`DATABASE_URL` required) | Move to managed Postgres/Redis; add migrations to CI |
| 6 | NestJS framework parity | Deliberately deferred: dependency-free Node router retained — zero-install dev loop on Node 24 strip-mode TS, no framework/toolchain drift between CI and the smoke harness. Module folders (`game`, `escrow`, `chain`, `files`, `governance`, `orgs`, `indexer`, `persistence`, `scheduler`, `notifications`, `admin`) mirror Nest controllers/providers one-to-one and expose the same REST shapes; `smoke.mjs` asserts HTTP contracts, not framework internals | Mechanical lift to NestJS controllers/providers when Prisma/Redis deps actually land; port `smoke.mjs` assertions unchanged. Revisit when the service grows DI/testing needs the router cannot express cleanly |
| 7 | Indexer polling a real node | Resolved: indexer polls `/blocks` and `/entries/:namespace`, tracks a durable cursor (Postgres when configured, memory fallback), projects new entries into the store and refreshes the chain height hint | None for current scope |
| 8 | Retry queue durability | Resolved in-process + Postgres: failed chain writes enqueue to a durable retry table (`RetryQueueItem`), rehydrate on boot, flush via `POST /admin/flush-retries`; gateway marks write scopes replayed only on success (mock matches) | Redis/BullMQ backend if multi-instance horizontal scale is needed |
| 9 | Scheduler-triggered refunds | Resolved: scheduler self-serve refunds with `TREASURENET_GM_REFUND_KEY` (dual signatures over `refund:<escrow_id>` and `refund:<hunt_id>:<gm_did>`); retries each tick until the on-chain deadline block passes; verified in node-mode smoke | KMS-held GM key in production; document custody |
| 10 | AI photo oracle | Resolved: external mode implemented (`TREASURENET_ORACLE_MODE=external` POSTs `{hunt_id, player_did, clue_index, photo_b64, geo_ok}`, verifies the verdict signature when `TREASURENET_ORACLE_VERIFIER_DID` is pinned, surfaces `OracleUnavailable` instead of silently downgrading) plus a reference oracle service (`apps/oracle/service.mjs`: `GET /health`, `POST /verdict` with verdicts signed over `verdict:<hunt>:<did>:<clue>:<pass|fail>`, env `ORACLE_KEY_HEX`/`ORACLE_PORT`/`ORACLE_MIN_PHOTO_BYTES`); smoke section 16 confirms a claim with a pinned oracle DID and section 17 rejects a rogue verifier DID | Host the real model behind the same external contract (the reference service is the integration template) |

## Tier 3: Client parity

| # | Gap | Current state | Work required |
|---|---|---|---|
| 11 | Flutter player app | Resolved: implemented in `apps/flutter/` (seven screens, device Ed25519 wallet, GPS check-ins, photo claims with finality receipts); analyzer clean, tests green, debug APK builds | Remaining polish: flutter_map surface, biometric unlock, widget tests for the full onboarding/login flow |
| 12 | GM console clue encryption | Resolved: GM console encrypts clue plaintext client-side (WebCrypto AES-GCM-256, random key + 12-byte IV) and attaches the content key wrapped with an HKDF-SHA256(manifest_id)-derived wrap key; Flutter decrypts via `clue_crypto.dart` (byte-exact with WebCrypto, verified by fixed-vector tests) only after the node serves the ciphertext through the consent-gated read path. Honest scope note: the key wrap protects the content key at rest in store/chain under GM/service custody — it is transport protection, not end-to-end encryption against a malicious backend | Per-player E2E wrapping (X25519 ephemeral per reader DID instead of the manifest-derived wrap key) is the follow-up if the threat model includes the backend itself |
| 13 | Mobile anti-spoof sensors | Resolved: `anti_spoof.dart` assesses location trust from GPS fix sequences and accelerometer variance — rejects impossible inter-fix speeds (>56 m/s), non-increasing fix timestamps, and still-device-with-moving-GPS contradictions; `hunt_provider.trustedFix()` requires two fixes across a 4s window plus accel variance, `isMocked` fixes are rejected outright, and both the hunt and claim screens consume the trusted fix (7 unit tests) | Heuristics are tuned to walking-pace hunts; revisit thresholds for vehicle-scale hunts |
| 14 | Admin governance actions | Resolved: admin panel governance section (propose with title + parameters JSON, color-coded status list, approve/reject); backend `/admin/governance/proposals*` signs PROPOSE/APPROVED/REJECTED entries to the `governance` namespace in node mode and folds on-chain decisions into the list order-independently (PROPOSE pass first, decisions by timestamp); smoke section 13 covers propose → list → approve → decision-visible → re-decision-rejected in both modes | Operator key custody (TREASURENET_SERVICE_KEY) doubles as the governance key; split them if multi-admin |

## Tier 4: Hardening

| # | Gap | Current state | Work required |
|---|---|---|---|
| 15 | Interop bridging of rewards | Scoped out with rationale: CTZN rewards are soulbound module tokens (`owner_of` balances, no transfer op), so bridging would first require a governance decision to mint/burn on adapter events — a product decision, not a wiring gap. Citizen's interop adapters must remain governed and explicit (per the architecture baseline), so any bridge starts as a governed `interop.adapter` namespace entry with its own policy, not a backend integration | Governed interop adapter namespace + policy, oracle-signed bridge attestations, and a dual-sig mint/burn decision per bridged chain — only if cross-chain rewards become a product requirement |
| 16 | Rate limiting and abuse controls | Resolved: token-bucket limiter per client IP with separate auth class (`TREASURENET_RATE_LIMIT_PER_MIN`, `TREASURENET_RATE_LIMIT_AUTH_PER_MIN`); 429 with `Retry-After` verified in smoke | Distributed limiter (Redis counters) for multi-instance deploys |
| 17 | Orgs module depth | Resolved: orgs CRUD (`POST/GET /orgs`, member add/remove) with owner checks (`NotOrgOwner`, `OwnerImmutable`, `MemberNotFound`), events and persistence | Billing/seat management if multi-tenant GM organizations grow |
| 18 | Notification delivery | Resolved: webhook POST with 5s timeout when `TREASURENET_NOTIFY_WEBHOOK_URL` is set, plus the in-app list; delivery recorded in the notifications table | Push/email adapters from the original notification module |

## Verified working today

- 41 ported contract scenarios green in `cargo test -p citizen-execution --test treasurenet_test`
- 77 ledger tests and 6 consensus tests green; the ledger now accepts module
  signature messages hex-encoded or raw UTF-8, orders module state writes
  deterministically (time-ordered v7 entry ids, latest-write selection),
  validates gossiped STATE_WRITE entries via their tamper-evident
  commitment (module_id + key + value), and the consensus engine gossips
  and block-includes execution.module/governance/game.hunts entries and
  evicts stale rounds so a failed round can no longer freeze block
  production
- Two pre-existing citizen-api test failures
  (`election_lifecycle_and_tally`,
  `module_runtime_endpoint_reports_registration_and_activation`) predate
  the TreasureNet work (fail at the pre-port commit) and are unrelated to
  it
- Full E2E smoke green in all three modes: mock (`node scripts/smoke.mjs`),
  persistence (`DATABASE_URL=... REDIS_URL=... node scripts/smoke.mjs`,
  including server-restart rehydration), and node mode
  (`TREASURENET_NODE_URL=... node scripts/smoke.mjs`) against both a live
  solo node and a 3-validator triolet (`config/triolet/validator-*-tn.toml`,
  rotating proposers, aggregate commit proofs, STATE_WRITE module state
  replicated identically across validators: governance-gated module
  bootstrap, escrow expiry refunds, on-chain CTZN mint, rate limits, orgs)
- Encrypted clue files verified end to end in node mode on a files-enabled
  solo node (`config/solo/validator-solo-tn-files.toml`: `treasure.files` +
  `consent.receipt` namespaces, local object store): consent receipt → file
  intent → ciphertext upload → manifest-bound commit → locked-read 403 →
  unlocked read → HKDF key unwrap → plaintext decrypt → ciphertext hash
  match → revocation → revoked-read 403 → forged-signature rejection →
  admin file-alert feed (smoke section 13b, all assertions in both modes)
- GM console and admin panel serve and talk to the 7755 API; the GM console
  lists and approves pending mobile claim requests and encrypts clue
  content client-side; the admin panel proposes/approves/rejects governance
  decisions that land as signed `governance` namespace entries in node mode
- Flutter player app: `dart analyze` clean, `flutter test` green (21 tests)
  including byte-exact Ed25519 parity with the node chain SDK, AES-GCM
  clue decryption parity with WebCrypto fixed vectors, and anti-spoof
  trust assessments; debug APK builds
- Deploy script bootstraps governance approvals, registers and configures
  all four modules against a live node end to end
- Node config regression guard: `citizen-node` parses every shipped solo
  config in tests (`files_config_parses`), because `NodeConfig::load`
  silently falls back to defaults on a bad file — note the CLI takes the
  config path as a positional argument, not a `--config` flag
