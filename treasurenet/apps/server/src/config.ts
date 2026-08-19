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
  };
}

/** Deterministic dev-only fingerprint for logging config identities. */
export function configFingerprint(config: ServerConfig): string {
  return createHash("sha256")
    .update(`${config.serviceDid}:${config.oracleDid}`)
    .digest("hex")
    .slice(0, 12);
}
