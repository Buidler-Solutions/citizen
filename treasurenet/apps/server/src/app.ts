import type { IncomingMessage, ServerResponse } from "node:http";
import { Router, badRequest, corsHeaders, HttpError } from "./http.ts";
import { Store } from "./store.ts";
import type { ServerConfig } from "./config.ts";
import { ChainModule } from "./modules/chain.module.ts";
import { AuthModule } from "./modules/auth.module.ts";
import { GameModule } from "./modules/game.module.ts";
import { EscrowModule } from "./modules/escrow.module.ts";
import { OracleModule } from "./modules/oracle.module.ts";
import { WalletModule } from "./modules/wallet.module.ts";
import { ConsentModule } from "./modules/consent.module.ts";
import { SchedulerModule } from "./modules/scheduler.module.ts";
import { IndexerModule } from "./modules/indexer.module.ts";
import {
  AdminModule,
  AnalyticsModule,
  HealthModule,
  LeaderboardModule,
  NotificationModule,
} from "./modules/projections.module.ts";
import { checkProximity } from "./modules/geo.module.ts";

/**
 * Application wiring. Module boundaries mirror the original TreasureNet
 * NestJS backend (auth, game, escrow, oracle, geo, leaderboard, wallet,
 * orgs/roles, admin, analytics, notification, scheduler, health) with the
 * new chain module replacing the Stellar SDK.
 */

export interface AppContext {
  config: ServerConfig;
  store: Store;
  chain: ChainModule;
  auth: AuthModule;
  game: GameModule;
  escrow: EscrowModule;
  oracle: OracleModule;
  wallet: WalletModule;
  consent: ConsentModule;
  scheduler: SchedulerModule;
  indexer: IndexerModule;
  leaderboard: LeaderboardModule;
  analytics: AnalyticsModule;
  notification: NotificationModule;
  admin: AdminModule;
  health: HealthModule;
}

export function buildContext(config: ServerConfig): AppContext {
  const store = new Store();
  const chain = new ChainModule(config);
  const auth = new AuthModule(store);
  const oracle = new OracleModule(chain, store);
  const game = new GameModule(chain, store);
  const escrow = new EscrowModule(chain, store, game, oracle);
  const wallet = new WalletModule(chain, store);
  const consent = new ConsentModule(store);
  const indexer = new IndexerModule(chain, store);
  const scheduler = new SchedulerModule({
    store,
    onExpiry: async () => {
      // Refunds are GM-signed; the scheduler marks expiry and the GM
      // console completes the refund entry.
    },
  });
  return {
    config,
    store,
    chain,
    auth,
    game,
    escrow,
    oracle,
    wallet,
    consent,
    scheduler,
    indexer,
    leaderboard: new LeaderboardModule(store),
    analytics: new AnalyticsModule(store),
    notification: new NotificationModule(store),
    admin: new AdminModule(chain, store),
    health: new HealthModule(chain),
  };
}

export function buildRouter(ctx: AppContext): Router {
  const router = new Router();
  const geo = { checkProximity };

  // ── health ──
  router.get("/health", () => ctx.health.check());

  // ── auth (challenge-response with device Ed25519 keys) ──
  router.post("/auth/challenge", (_req, _params, _query, body) => {
    const input = body as { did?: string };
    if (!input?.did) badRequest("MissingDid", "did is required");
    return ctx.auth.challenge(input.did!);
  });
  router.post("/auth/verify", (_req, _params, _query, body) => {
    const input = body as { did?: string; signature?: string };
    if (!input?.did || !input?.signature) badRequest("MissingFields", "did and signature are required");
    return ctx.auth.verify(input.did!, input.signature!);
  });

  // ── wallet ──
  router.post("/wallet/register", (_req, _params, _query, body) =>
    ctx.wallet.register(body as { did?: string; public_key_hex?: string })
  );
  router.get("/wallet/:did/balance", (_req, params) => ctx.wallet.balance(params.did!));
  router.get("/wallet/:did/receipts", (_req, params) => ctx.wallet.receipts(params.did!));
  router.get("/wallet/:did/notifications", (_req, params) => ctx.notification.forDid(params.did!));

  // ── consent ──
  router.post("/consent/grant", (req, _params, _query, body) => {
    const session = ctx.auth.session(ctx.auth.bearer(req));
    const input = body as { purposes?: ("location" | "photo")[] };
    return ctx.consent.grant(session.did, input?.purposes ?? ["location", "photo"]);
  });
  router.get("/consent/status", (req) => {
    const session = ctx.auth.session(ctx.auth.bearer(req));
    return ctx.consent.status(session.did);
  });

  // ── roles (orgs/admin) ──
  router.post("/roles/grant", (_req, _params, _query, body) => {
    const input = body as { did?: string; role?: string };
    if (!input?.did || !input?.role) badRequest("MissingFields", "did and role are required");
    return ctx.wallet.grantRole(ctx.config.serviceDid, input.did!, input.role!);
  });
  router.post("/roles/revoke", (_req, _params, _query, body) => {
    const input = body as { did?: string };
    if (!input?.did) badRequest("MissingFields", "did is required");
    return ctx.wallet.revokeRole(ctx.config.serviceDid, input.did!);
  });
  router.get("/roles/:did", async (_req, params) => {
    const result = await ctx.wallet.roleOf(params.did!);
    return result.output;
  });

  // ── game (GM console + player) ──
  router.get("/games", () => ctx.game.list());
  router.get("/games/:id", (_req, params) => ctx.game.get(params.id!));
  router.post("/games", (_req, _params, _query, body) => ctx.game.createHunt(body as never));
  router.post("/games/:id/fund", (_req, params, _query, body) => {
    const input = body as { gm_signature?: string; escrow_gm_signature?: string; amount?: number };
    if (!input?.gm_signature || !input?.escrow_gm_signature) {
      badRequest("MissingFields", "gm_signature and escrow_gm_signature are required");
    }
    return ctx.game.fundHunt(params.id!, input.gm_signature!, input.escrow_gm_signature!, input.amount);
  });
  for (const op of ["activate", "pause", "resume", "cancel"] as const) {
    router.post(`/games/:id/${op}`, (_req, params, _query, body) => {
      const input = body as { gm_signature?: string };
      if (!input?.gm_signature) badRequest("MissingFields", "gm_signature is required");
      return ctx.game[op](params.id!, input.gm_signature!);
    });
  }
  router.post("/games/:id/checkin", (req, params, _query, body) => {
    const session = ctx.auth.session(ctx.auth.bearer(req));
    const input = body as {
      clue_index?: number;
      latitude?: number;
      longitude?: number;
      accuracy_meters?: number;
    };
    if (input?.clue_index === undefined || input?.latitude === undefined || input?.longitude === undefined) {
      badRequest("MissingFields", "clue_index, latitude, longitude are required");
    }
    ctx.consent.requireValid(session.did, "location");
    return ctx.game.checkIn({
      hunt_id: params.id!,
      player_did: session.did,
      clue_index: input!.clue_index!,
      latitude: input!.latitude!,
      longitude: input!.longitude!,
      accuracy_meters: input!.accuracy_meters,
      geo,
    });
  });

  // ── escrow / claims ──
  router.get("/escrow/:id/status", async (_req, params) => {
    const result = await ctx.escrow.status(params.id!);
    return result.output;
  });
  router.get("/escrow/:id/reward", async (_req, params) => {
    const result = await ctx.escrow.reward(params.id!);
    return result.output;
  });
  router.get("/claims", () => ctx.escrow.listClaims());
  router.post("/games/:id/claim", (req, params, _query, body) => {
    const session = ctx.auth.session(ctx.auth.bearer(req));
    const input = body as {
      gm_signature?: string;
      escrow_gm_signature?: string;
      photo_b64?: string;
      latitude?: number;
      longitude?: number;
    };
    if (!input?.gm_signature || !input?.escrow_gm_signature || !input?.photo_b64) {
      badRequest("MissingFields", "gm_signature, escrow_gm_signature, and photo_b64 are required");
    }
    ctx.consent.requireValid(session.did, "photo");
    return ctx.escrow.claim({
      hunt_id: params.id!,
      player_did: session.did,
      gm_signature: input.gm_signature!,
      escrow_gm_signature: input.escrow_gm_signature!,
      photo_b64: input.photo_b64!,
      latitude: input.latitude ?? 0,
      longitude: input.longitude ?? 0,
      geo,
    });
  });
  router.post("/games/:id/refund", (_req, params, _query, body) => {
    const input = body as { gm_signature?: string };
    if (!input?.gm_signature) badRequest("MissingFields", "gm_signature is required");
    return ctx.escrow.refund(params.id!, input.gm_signature!);
  });

  // ── oracle ──
  router.get("/oracle/verdicts/:huntId", (_req, params) => ctx.oracle.listForHunt(params.huntId!));

  // ── leaderboard / analytics / admin ──
  router.get("/leaderboard", (_req, _params, query) =>
    ctx.leaderboard.top(Number(query.get("limit") ?? 20))
  );
  router.get("/analytics/summary", () => ctx.analytics.summary());
  router.get("/admin/overview", () => ctx.admin.overview());
  router.get("/admin/file-alerts", () => ctx.admin.fileAlerts());
  router.get("/events", (_req, _params, query) =>
    ctx.indexer.events(Number(query.get("since") ?? 0))
  );
  router.post("/admin/scheduler/tick", () => ctx.scheduler.tick());
  router.post("/admin/indexer/poll", () => ctx.indexer.poll());

  return router;
}

export async function handleRequest(
  ctx: AppContext,
  router: Router,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const matched = router.match(req.method ?? "GET", url.pathname);
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  if (!matched) {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "route not found", code: "NotFound", routes: router.listRoutes() }));
    return;
  }
  let body: unknown = undefined;
  if (req.method === "POST" || req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "invalid json body", code: "InvalidJson" }));
        return;
      }
    }
  }
  try {
    const result = await matched.route.handler(req, matched.params, url.searchParams, body);
    res.writeHead(200, headers);
    res.end(JSON.stringify(result ?? {}));
  } catch (error) {
    if (error instanceof HttpError) {
      res.writeHead(error.status, headers);
      res.end(JSON.stringify({ error: error.message, code: error.code, detail: error.detail }));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: message, code: "InternalError" }));
  }
}
