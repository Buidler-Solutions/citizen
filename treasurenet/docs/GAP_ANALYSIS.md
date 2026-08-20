# Gap Analysis: TreasureNet Citizen Edition

What stands between the current scaffold and full production parity with
the original Stellar system. Ordered by blocking impact; each item lists
evidence of current state and the concrete work to close it.

## Tier 1: Blocks real-chain operation

| # | Gap | Current state | Work required |
|---|---|---|---|
| 1 | Governance-gated module bootstrap on a real node | Resolved: live solo node boot verified end to end. `deploy_treasurenet.py --bootstrap-governance` submits PROPOSE+APPROVED governance entries, registers and configures all four modules (escrow, hunt, registry, ctzn-token); node-mode smoke (`TREASURENET_NODE_URL=...`) passes the full player journey including dual-sig refund after expiry and on-chain CTZN mint | Run the same flow against a multi-validator localnet/triolet before mainline staging |
| 2 | CTZN reward token distribution on payout | Resolved: escrow payout triggers `ctzn-token.v1 mint` under service+oracle dual signatures (threshold 2); node-mode wallet balance counts soulbound tokens via `owner_of`; `/api/v1/ctzn/:id/check/:did` verified | Consider batch distribution if reward volume grows |
| 3 | Encrypted clue file store integration | Clues carry `manifest_id`s; check-in state gates reads in the store | Wire `citizen_create_file_intent` / `citizen_commit_file` on clue upload, `citizen_read_file` authorization on unlock, `citizen_revoke_file_reader` on cheat detection, feed alerts into `/admin/file-alerts` |
| 4 | Node-backed wallet balances and receipts | Resolved: node mode reads `owner_of` per confirmed claim for balances and enriches receipts from chain where a ledger receipt id exists; module-execution claims carry deterministic `node:<height>:<escrow_id>` receipt references | None for the solo-node profile; revisit if module executions gain ledger-level receipt ids |

## Tier 2: Blocks production deployment

| # | Gap | Current state | Work required |
|---|---|---|---|
| 5 | Postgres/Redis persistence | Resolved: `PersistenceModule` write-through upserts to Postgres (16 tables), Redis `treasurenet:events` stream fan-out, webhook notification delivery, boot-time rehydration verified by the smoke restart scenario (`DATABASE_URL` required) | Move to managed Postgres/Redis; add migrations to CI |
| 6 | NestJS framework parity | Dependency-free Node router with identical module folders and REST shapes | Mechanical lift to NestJS controllers/providers when adding Prisma/Redis deps; port `smoke.mjs` assertions unchanged |
| 7 | Indexer polling a real node | Resolved: indexer polls `/blocks` and `/entries/:namespace`, tracks a durable cursor (Postgres when configured, memory fallback), projects new entries into the store and refreshes the chain height hint | None for current scope |
| 8 | Retry queue durability | Resolved in-process + Postgres: failed chain writes enqueue to a durable retry table (`RetryQueueItem`), rehydrate on boot, flush via `POST /admin/flush-retries`; gateway marks write scopes replayed only on success (mock matches) | Redis/BullMQ backend if multi-instance horizontal scale is needed |
| 9 | Scheduler-triggered refunds | Resolved: scheduler self-serve refunds with `TREASURENET_GM_REFUND_KEY` (dual signatures over `refund:<escrow_id>` and `refund:<hunt_id>:<gm_did>`); retries each tick until the on-chain deadline block passes; verified in node-mode smoke | KMS-held GM key in production; document custody |
| 10 | AI photo oracle | Heuristic verdict with production signing interface; external mode implemented (`TREASURENET_ORACLE_MODE=external` POSTs `{hunt_id, player_did, clue_index, photo_b64, geo_ok}`, verifies verdict signature when `TREASURENET_ORACLE_VERIFIER_DID` is pinned, surfaces `OracleUnavailable` instead of silently downgrading) | Host the real model behind the external contract |

## Tier 3: Client parity

| # | Gap | Current state | Work required |
|---|---|---|---|
| 11 | Flutter player app | Resolved: implemented in `apps/flutter/` (seven screens, device Ed25519 wallet, GPS check-ins, photo claims with finality receipts); analyzer clean, tests green, debug APK builds | Remaining polish: flutter_map surface, biometric unlock, widget tests for the full onboarding/login flow |
| 12 | GM console clue encryption | Console supplies manifest ids as strings | Client-side clue encryption (AES-GPU hybrid to reader ACL) before file intent creation |
| 13 | Mobile anti-spoof sensors | Documented in the port plan | Port mock-location and accelerometer checks from the original app |
| 14 | Admin governance actions | Panel shows overview/alerts/roles only | Add civic proposal creation UI for parameter changes (fees, oracle rotation) per the port spec |

## Tier 4: Hardening

| # | Gap | Current state | Work required |
|---|---|---|---|
| 15 | Interop bridging of rewards | Not started | Governed interop adapter entries for reward bridging to other chains |
| 16 | Rate limiting and abuse controls | Resolved: token-bucket limiter per client IP with separate auth class (`TREASURENET_RATE_LIMIT_PER_MIN`, `TREASURENET_RATE_LIMIT_AUTH_PER_MIN`); 429 with `Retry-After` verified in smoke | Distributed limiter (Redis counters) for multi-instance deploys |
| 17 | Orgs module depth | Resolved: orgs CRUD (`POST/GET /orgs`, member add/remove) with owner checks (`NotOrgOwner`, `OwnerImmutable`, `MemberNotFound`), events and persistence | Billing/seat management if multi-tenant GM organizations grow |
| 18 | Notification delivery | Resolved: webhook POST with 5s timeout when `TREASURENET_NOTIFY_WEBHOOK_URL` is set, plus the in-app list; delivery recorded in the notifications table | Push/email adapters from the original notification module |

## Verified working today

- 41 ported contract scenarios green in `cargo test -p citizen-execution --test treasurenet_test`
- 77 ledger tests and 6 consensus tests green; the ledger now accepts module
  signature messages hex-encoded or raw UTF-8, orders module state writes
  deterministically (time-ordered v7 entry ids, latest-write selection), and
  the consensus engine evicts stale rounds so a failed round can no longer
  freeze block production
- Full E2E smoke green in all three modes: mock (`node scripts/smoke.mjs`),
  persistence (`DATABASE_URL=... REDIS_URL=... node scripts/smoke.mjs`,
  including server-restart rehydration), and node mode
  (`TREASURENET_NODE_URL=... node scripts/smoke.mjs` against a live
  citizen-node with governance bootstrapped modules, escrow expiry refunds,
  on-chain CTZN mint, rate limits and orgs)
- GM console and admin panel serve and talk to the 7755 API; the GM console
  lists and approves pending mobile claim requests
- Flutter player app: `dart analyze` clean, `flutter test` green including
  byte-exact Ed25519 parity with the node chain SDK, debug APK builds
- Deploy script bootstraps governance approvals, registers and configures
  all four modules against a live node end to end
