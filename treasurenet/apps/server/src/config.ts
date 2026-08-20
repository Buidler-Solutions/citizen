import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { generateKeyPair, didFromPublicKey } from "../../../chain/sdk/src/index.ts";

/**
 * Server configuration. All secrets come from the environment; generated
 * dev keys are ephemeral and clearly marked. Never log key material.
 */

export interface ServerConfig {
  port: number;
  nodeUrl: string | undefined;
  serviceDid: string;
  serviceKeyHex: string;
  oracleDid: string;
  oracleKeyHex: string;
  rewardTokenModuleId: string;
  /** Approximate blocks per second for expiry scheduling (dev mock cadence). */
  blockCadencePerSecond: number;
  /** Postgres projection persistence (unset -> in-memory only). */
  databaseUrl: string | undefined;
  /** Redis streams for events/notifications (unset -> skip). */
  redisUrl: string | undefined;
  /** Rate limiting: general requests per minute per IP (0 disables). */
  rateLimitPerMin: number;
  /** Rate limiting: auth endpoint requests per minute per IP (0 disables). */
  rateLimitAuthPerMin: number;
  /** GM escrow-refund key (64-hex) enabling scheduler-triggered refunds. */
  gmRefundKeyHex: string | undefined;
  /** Oracle mode: heuristic (in-process) or external (AI service). */
  oracleMode: "heuristic" | "external";
  oracleUrl: string | undefined;
  oracleVerifierDid: string | undefined;
  /** Distribute CTZN rewards via the token module after escrow payout (node mode). */
  rewardDistribute: boolean;
  /** Outbound notification webhook (FCM gateway / ntfy / ops relay). */
  notifyWebhookUrl: string | undefined;
  /** Node API key (x-api-key) for nodes running with api_auth_required. */
  nodeApiKey: string | undefined;
  /** Namespace carrying the offchain encrypted file policy (node mode). */
  filesNamespace: string;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function envHex(name: string): string | undefined {
  const value = process.env[name];
  if (value && /^[0-9a-fA-F]{64}$/.test(value)) return value;
  return undefined;
}

function publicHexFromPrivate(privateKeyHex: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return Buffer.from(publicKey.export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("hex");
}

export function loadConfig(): ServerConfig {
  const nodeUrl = process.env.TREASURENET_NODE_URL;
  const serviceKeyHex = envHex("TREASURENET_SERVICE_KEY") ?? generateKeyPair().privateKeyHex;
  const oracleKeyHex = envHex("TREASURENET_ORACLE_KEY") ?? generateKeyPair().privateKeyHex;
  const gmRefundKeyHex = envHex("TREASURENET_GM_REFUND_KEY");
  const oracleMode =
    process.env.TREASURENET_ORACLE_MODE === "external" ? "external" : "heuristic";
  if (oracleMode === "external" && !process.env.TREASURENET_ORACLE_URL) {
    throw new Error("TREASURENET_ORACLE_MODE=external requires TREASURENET_ORACLE_URL");
  }
  return {
    port: Number(process.env.TREASURENET_PORT ?? 7755),
    nodeUrl,
    serviceDid:
      process.env.TREASURENET_SERVICE_DID ?? didFromPublicKey(publicHexFromPrivate(serviceKeyHex)),
    serviceKeyHex,
    oracleDid:
      process.env.TREASURENET_ORACLE_DID ?? didFromPublicKey(publicHexFromPrivate(oracleKeyHex)),
    oracleKeyHex,
    rewardTokenModuleId: process.env.TREASURENET_REWARD_MODULE ?? "ctzn-token.v1",
    blockCadencePerSecond: Number(process.env.TREASURENET_BLOCK_CADENCE ?? 1),
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    rateLimitPerMin: Number(process.env.TREASURENET_RATE_LIMIT_PER_MIN ?? 240),
    rateLimitAuthPerMin: Number(process.env.TREASURENET_RATE_LIMIT_AUTH_PER_MIN ?? 30),
    gmRefundKeyHex,
    oracleMode,
    oracleUrl: process.env.TREASURENET_ORACLE_URL,
    oracleVerifierDid: process.env.TREASURENET_ORACLE_VERIFIER_DID,
    rewardDistribute: process.env.TREASURENET_REWARD_DISTRIBUTE !== "false",
    notifyWebhookUrl: process.env.TREASURENET_NOTIFY_WEBHOOK_URL,
    nodeApiKey: process.env.TREASURENET_NODE_API_KEY,
    filesNamespace: process.env.TREASURENET_FILES_NAMESPACE ?? "treasure.files",
  };
}

/** Deterministic dev-only fingerprint for logging config identities. */
export function configFingerprint(config: ServerConfig): string {
  return createHash("sha256")
    .update(`${config.serviceDid}:${config.oracleDid}`)
    .digest("hex")
    .slice(0, 12);
}
