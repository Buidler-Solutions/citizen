import { createServer } from "node:http";
import { loadConfig, configFingerprint } from "./config.ts";
import { buildContext, buildRouter, handleRequest } from "./app.ts";

/**
 * TreasureNet Citizen Edition backend (port 7755).
 *
 * Chain mode:
 *   - TREASURENET_NODE_URL unset  -> deterministic in-memory mock chain
 *   - TREASURENET_NODE_URL set    -> real Citizen node adapter
 *
 * Keys:
 *   - TREASURENET_SERVICE_KEY / TREASURENET_ORACLE_KEY (64-hex Ed25519)
 *     come from the environment / KMS; dev fallbacks are ephemeral.
 */

async function main() {
  const config = loadConfig();
  const ctx = buildContext(config);
  const router = buildRouter(ctx);

  // Optional backends first (Postgres projection, Redis streams, webhook):
  // rehydrate the in-memory store and the durable retry queue before the
  // modules bootstrap so a restarted process resumes where it stopped.
  await ctx.persistence.connect();
  const rehydrated = await ctx.persistence.rehydrate(ctx.store);
  ctx.store.attach(ctx.persistence);
  const restoredRetries = await ctx.chain.restoreRetryQueue();

  await ctx.chain.bootstrap();
  await ctx.chain.refreshHeight();
  ctx.indexer.start();
  ctx.scheduler.start();

  const server = createServer((req, res) => {
    handleRequest(ctx, router, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "unhandled server error", code: "InternalError" }));
    });
  });

  server.listen(config.port, () => {
    console.log(
      `treasurenet-citizen server on :${config.port} (chain=${ctx.chain.mode()}, fingerprint=${configFingerprint(config)})`
    );
    if (ctx.persistence.enabled) {
      console.log(
        `[persistence] rehydrated hunts=${rehydrated.hunts} claims=${rehydrated.claims} requests=${rehydrated.requests} retries=${restoredRetries}`
      );
    }
  });

  const shutdown = () => {
    ctx.scheduler.stop();
    ctx.indexer.stop();
    server.close(() => {
      ctx.persistence.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
