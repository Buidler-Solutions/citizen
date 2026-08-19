# Gap Analysis: TreasureNet Citizen Edition

What stands between the current scaffold and full production parity with
the original Stellar system. Ordered by blocking impact; each item lists
evidence of current state and the concrete work to close it.

## Tier 1: Blocks real-chain operation

| # | Gap | Current state | Work required |
|---|---|---|---|
| 1 | Governance-gated module bootstrap on a real node | Mock chain accepts `proposal-approved-*` ids; deploy script passes proposal ids through | Create and approve real civic proposals for the three module configurations, then run `deploy_treasurenet.py` against a localnet/triolet |
| 2 | CTZN reward token distribution on payout | Escrow/hunt modules write `payout:<id>` records; mock chain credits balances | Wire payout records to the ctzn-token module distribution op (mint/transfer under module authority) and verify with the ctzn balance API |
| 3 | Encrypted clue file store integration | Clues carry `manifest_id`s; check-in state gates reads in the store | Wire `citizen_create_file_intent` / `citizen_commit_file` on clue upload, `citizen_read_file` authorization on unlock, `citizen_revoke_file_reader` on cheat detection, feed alerts into `/admin/file-alerts` |
| 4 | Node-backed wallet balances and receipts | `/wallet/:did/balance` returns a stub in node mode | Query `/api/v1/ctzn/:module/balance/:did` and `/api/v1/receipts/:id` from the chain adapter and merge with the projection store |

## Tier 2: Blocks production deployment

| # | Gap | Current state | Work required |
|---|---|---|---|
| 5 | Postgres/Redis persistence | In-memory store; Prisma schema written (`packages/shared/prisma/schema.prisma`) | Run prisma generate/migrate, back the store with Prisma, swap notification/event lists for Redis streams |
| 6 | NestJS framework parity | Dependency-free Node router with identical module folders and REST shapes | Mechanical lift to NestJS controllers/providers when adding Prisma/Redis deps; port `smoke.mjs` assertions unchanged |
| 7 | Indexer polling a real node | Indexer projects mock writes; `poll()` scans local state | Poll `/api/v1/blocks` and `/api/v1/entries` for `game.*` and `identity.roles` namespaces, project into Prisma tables, publish Redis events |
| 8 | Retry queue durability | ModuleGateway holds an in-memory retry queue | Move the queue to Redis (BullMQ) per the original stack; keep the surface (`flushRetryQueue`, `pendingRetries`) |
| 9 | Scheduler-triggered refunds | Scheduler marks expiry; GM console completes the refund entry | Add a KMS-signed GM refund option or timed escrow refunds once the platform exposes them; document the custody choice |
| 10 | AI photo oracle | Heuristic verdict with production signing interface | Port the AI verification model behind `OracleModule.evaluate`; keep verdict signature format unchanged |

## Tier 3: Client parity

| # | Gap | Current state | Work required |
|---|---|---|---|
| 11 | Flutter player app | Port plan in `apps/flutter/README.md`; all backend endpoints live | Implement the seven screens reusing `wallet/mobile` structure (Riverpod, secure storage, GoRouter) |
| 12 | GM console clue encryption | Console supplies manifest ids as strings | Client-side clue encryption (AES-GPU hybrid to reader ACL) before file intent creation |
| 13 | Mobile anti-spoof sensors | Documented in the port plan | Port mock-location and accelerometer checks from the original app |
| 14 | Admin governance actions | Panel shows overview/alerts/roles only | Add civic proposal creation UI for parameter changes (fees, oracle rotation) per the port spec |

## Tier 4: Hardening

| # | Gap | Current state | Work required |
|---|---|---|---|
| 15 | Interop bridging of rewards | Not started | Governed interop adapter entries for reward bridging to other chains |
| 16 | Rate limiting and abuse controls | None on the API | Standard middleware in the NestJS migration |
| 17 | Orgs module depth | Roles only; org modeling folded into role grants | Port the original orgs service if multi-tenant GM organizations are required |
| 18 | Notification delivery | In-app notification list | Push/email delivery adapters from the original notification module |

## Verified working today

- 41 ported contract scenarios green in `cargo test -p citizen-execution --test treasurenet_test`
- Full E2E smoke (roles, hunt lifecycle, consent, GPS gating, oracle claim,
  2-of-2 payout, balance, receipt, double-claim rejection) green in
  `node scripts/smoke.mjs`
- GM console and admin panel serve and talk to the 7755 API
- Deploy script compiles-ready against a local node once governance
  proposals exist
