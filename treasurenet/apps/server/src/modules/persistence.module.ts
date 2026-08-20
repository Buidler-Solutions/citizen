import type { Hunt, ClaimRecord, ClaimRequest, ConsentReceipt, OracleVerdict, Role } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ServerConfig } from "../config.ts";

/**
 * Persistence module — Postgres projection (Prisma) + Redis streams +
 * outbound notification webhook. All backends are optional and loaded via
 * dynamic import so the zero-dependency dev path (no install) keeps working:
 *
 *   DATABASE_URL              -> durable projection (survives restarts)
 *   REDIS_URL                 -> events/notifications fan-out to Redis streams
 *   TREASURENET_NOTIFY_WEBHOOK_URL -> delivery adapter (FCM relay / ntfy / ops)
 *
 * The chain remains the source of truth; Postgres is a queryable projection
 * exactly like the original TreasureNet stack.
 */

export interface DurableQueueItem {
  id: string;
  moduleId: string;
  operation: string;
  params: Record<string, unknown>;
  attempts: number;
}

type PrismaLike = {
  hunt: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  clue: {
    deleteMany: (args: unknown) => Promise<unknown>;
    createMany: (args: unknown) => Promise<unknown>;
  };
  claim: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  claimRequest: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  roleEntry: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  wallet: {
    upsert: (args: unknown) => Promise<unknown>;
  };
  oracleVerdict: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  consentReceipt: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  chainEvent: {
    create: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  notification: {
    create: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  retryQueueItem: {
    create: (args: unknown) => Promise<{ id: string }>;
    delete: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  indexerCursor: {
    upsert: (args: unknown) => Promise<unknown>;
    findUnique: (args: unknown) => Promise<{ height: bigint } | null>;
  };
  org: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  orgMember: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
  unlockedClue: {
    create: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  };
  $disconnect: () => Promise<void>;
};

type RedisLike = {
  xadd: (stream: string, ...args: unknown[]) => Promise<unknown>;
  quit: () => Promise<void>;
};

export class PersistenceModule {
  readonly enabled: boolean;
  private prisma?: PrismaLike;
  private redis?: RedisLike;
  private readonly config: ServerConfig;
  private failures = 0;

  constructor(config: ServerConfig) {
    this.enabled = Boolean(config.databaseUrl || config.redisUrl || config.notifyWebhookUrl);
    this.config = config;
  }

  /** Connect optional backends. Never fatal: chain writes already succeeded. */
  async connect(): Promise<void> {
    if (this.config.databaseUrl) {
      try {
        const mod = (await import("@prisma/client")) as { PrismaClient: new () => PrismaLike };
        this.prisma = new mod.PrismaClient();
      } catch (error) {
        this.warn("prisma unavailable (run pnpm install); continuing in-memory", error);
      }
    }
    if (this.config.redisUrl) {
      try {
        const mod = (await import("ioredis")) as unknown as { default: new (url: string) => RedisLike };
        this.redis = new mod.default(this.config.redisUrl);
      } catch (error) {
        this.warn("ioredis unavailable (run pnpm install); continuing without streams", error);
      }
    }
  }

  async close(): Promise<void> {
    await this.prisma?.$disconnect().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }

  get postgres(): boolean {
    return this.prisma !== undefined;
  }

  get redisEnabled(): boolean {
    return this.redis !== undefined;
  }

  private warn(message: string, error: unknown) {
    this.failures += 1;
    if (this.failures <= 3) {
      console.warn(`[persistence] ${message}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async sink(fn: () => Promise<void>): Promise<void> {
    if (!this.prisma) return;
    try {
      await fn();
    } catch (error) {
      this.warn("projection write failed", error);
    }
  }

  // ── write-through projection ──

  saveHunt(hunt: Hunt): Promise<void> {
    return this.sink(async () => {
      const p = this.prisma!;
      await p.hunt.upsert({
        where: { huntId: hunt.hunt_id },
        create: {
          huntId: hunt.hunt_id,
          gmDid: hunt.gm_did,
          title: hunt.title,
          status: hunt.status,
          rewardAmount: hunt.reward_amount,
          rewardToken: hunt.reward_token,
          escrowId: hunt.escrow_id,
          expiresAt: new Date(hunt.expires_at),
          expiresBlock: BigInt(hunt.expires_block),
          winnerDid: hunt.winner_did,
          receiptId: hunt.receipt_id,
          createdAt: new Date(hunt.created_at),
        },
        update: {
          status: hunt.status,
          winnerDid: hunt.winner_did,
          receiptId: hunt.receipt_id,
        },
      });
      await p.clue.deleteMany({ where: { huntId: hunt.hunt_id } });
      await p.clue.createMany({
        data: hunt.clues.map((clue) => ({
          huntId: hunt.hunt_id,
          index: clue.index,
          manifestId: clue.manifest_id,
          latitude: clue.latitude,
          longitude: clue.longitude,
          radiusMeters: clue.radius_meters,
        })),
      });
    });
  }

  saveClaim(record: ClaimRecord): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.claim.upsert({
        where: { claimId: record.claim_id },
        create: {
          claimId: record.claim_id,
          huntId: record.hunt_id,
          escrowId: record.escrow_id,
          winnerDid: record.winner_did,
          rewardAmount: record.reward_amount,
          rewardToken: record.reward_token,
          gmSignature: record.gm_signature,
          oracleSignature: record.oracle_signature,
          receiptId: record.receipt_id,
          blockHeight: record.block_height === undefined ? undefined : BigInt(record.block_height),
          status: record.status,
          createdAt: new Date(record.created_at),
        },
        update: {
          status: record.status,
          receiptId: record.receipt_id,
          blockHeight: record.block_height === undefined ? undefined : BigInt(record.block_height),
        },
      });
    });
  }

  saveClaimRequest(request: ClaimRequest): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.claimRequest.upsert({
        where: { requestId: request.request_id },
        create: {
          requestId: request.request_id,
          huntId: request.hunt_id,
          escrowId: request.escrow_id,
          playerDid: request.player_did,
          photoB64: request.photo_b64,
          latitude: request.latitude,
          longitude: request.longitude,
          status: request.status,
          createdAt: new Date(request.created_at),
        },
        update: { status: request.status },
      });
    });
  }

  saveRole(did: string, role: Role | "revoked"): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.roleEntry.upsert({
        where: { did },
        create: { did, role: role === "revoked" ? "none" : role, revoked: role === "revoked" },
        update: { role: role === "revoked" ? "none" : role, revoked: role === "revoked" },
      });
    });
  }

  touchWallet(did: string): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.wallet.upsert({
        where: { did },
        create: { did },
        update: { lastSeenAt: new Date() },
      });
    });
  }

  saveVerdict(verdict: OracleVerdict): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.oracleVerdict.upsert({
        where: {
          huntId_playerDid_clueIndex: {
            huntId: verdict.hunt_id,
            playerDid: verdict.player_did,
            clueIndex: verdict.clue_index,
          },
        },
        create: {
          huntId: verdict.hunt_id,
          playerDid: verdict.player_did,
          clueIndex: verdict.clue_index,
          passed: verdict.passed,
          confidence: verdict.confidence,
          oracleDid: verdict.oracle_did,
          verdictSignature: verdict.verdict_signature,
          reason: verdict.reason,
        },
        update: {
          passed: verdict.passed,
          confidence: verdict.confidence,
          verdictSignature: verdict.verdict_signature,
          reason: verdict.reason,
        },
      });
    });
  }

  saveConsent(receipt: ConsentReceipt): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.consentReceipt.upsert({
        where: { receiptId: receipt.receipt_id },
        create: {
          receiptId: receipt.receipt_id,
          subjectDid: receipt.subject_did,
          purposes: receipt.purposes.join(","),
          grantedAt: new Date(receipt.granted_at),
          expiresAt: new Date(receipt.expires_at),
        },
        update: {
          purposes: receipt.purposes.join(","),
          grantedAt: new Date(receipt.granted_at),
          expiresAt: new Date(receipt.expires_at),
        },
      });
    });
  }

  saveEvent(event: { id: string; type: string; namespace: string; payload: Record<string, unknown>; created_at: string }): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.chainEvent.create({
        data: {
          id: event.id,
          type: event.type,
          namespace: event.namespace,
          payload: JSON.stringify(event.payload),
          createdAt: new Date(event.created_at),
        },
      });
    });
  }

  saveNotification(notification: { id: string; did: string; type: string; message: string; created_at: string }): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.notification.create({
        data: {
          id: notification.id,
          did: notification.did,
          type: notification.type,
          message: notification.message,
          createdAt: new Date(notification.created_at),
        },
      });
    });
  }

  saveOrg(org: { org_id: string; name: string; owner_did: string; created_at: string }): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.org.upsert({
        where: { orgId: org.org_id },
        create: {
          orgId: org.org_id,
          name: org.name,
          ownerDid: org.owner_did,
          createdAt: new Date(org.created_at),
        },
        update: { name: org.name },
      });
    });
  }

  saveOrgMember(membership: { org_id: string; did: string; role: string }): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.orgMember.upsert({
        where: { orgId_did: { orgId: membership.org_id, did: membership.did } },
        create: membership,
        update: { role: membership.role },
      });
    });
  }

  removeOrgMember(orgId: string, did: string): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.orgMember.deleteMany({ where: { orgId, did } });
    });
  }

  saveUnlockedClue(huntId: string, playerDid: string, clueIndex: number): Promise<void> {
    return this.sink(async () => {
      await this.prisma!.unlockedClue.deleteMany({
        where: { huntId, playerDid, clueIndex },
      }).catch(() => undefined);
      await this.prisma!.unlockedClue.create({
        data: { huntId, playerDid, clueIndex },
      });
    });
  }

  // ── durable retry queue ──

  async enqueueRetry(item: { moduleId: string; operation: string; params: Record<string, unknown>; attempts: number }): Promise<DurableQueueItem> {
    if (!this.prisma) {
      return { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...item };
    }
    try {
      const row = await this.prisma.retryQueueItem.create({
        data: {
          moduleId: item.moduleId,
          operation: item.operation,
          params: JSON.stringify(item.params),
          attempts: item.attempts,
        },
      });
      return { id: row.id, ...item };
    } catch (error) {
      this.warn("retry queue enqueue failed", error);
      return { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...item };
    }
  }

  async dequeueRetry(id: string): Promise<void> {
    if (!this.prisma || id.startsWith("mem-")) return;
    try {
      await this.prisma.retryQueueItem.delete({ where: { id } }).catch(() => undefined);
    } catch (error) {
      this.warn("retry queue dequeue failed", error);
    }
  }

  async bumpRetryAttempts(id: string, attempts: number): Promise<void> {
    if (!this.prisma || id.startsWith("mem-")) return;
    try {
      await this.prisma.retryQueueItem.update({ where: { id }, data: { attempts } }).catch(() => undefined);
    } catch (error) {
      this.warn("retry queue update failed", error);
    }
  }

  async loadRetryQueue(): Promise<DurableQueueItem[]> {
    if (!this.prisma) return [];
    try {
      const rows = await this.prisma.retryQueueItem.findMany();
      return rows.map((row) => ({
        id: String(row.id),
        moduleId: String(row.moduleId),
        operation: String(row.operation),
        params: JSON.parse(String(row.params)) as Record<string, unknown>,
        attempts: Number(row.attempts ?? 0),
      }));
    } catch (error) {
      this.warn("retry queue load failed", error);
      return [];
    }
  }

  // ── indexer cursor ──

  async saveCursor(height: number): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.indexerCursor.upsert({
        where: { id: "main" },
        create: { id: "main", height: BigInt(height) },
        update: { height: BigInt(height) },
      });
    } catch (error) {
      this.warn("cursor save failed", error);
    }
  }

  async loadCursor(): Promise<number | null> {
    if (!this.prisma) return null;
    try {
      const row = await this.prisma.indexerCursor.findUnique({ where: { id: "main" } });
      return row ? Number(row.height) : null;
    } catch (error) {
      this.warn("cursor load failed", error);
      return null;
    }
  }

  // ── Redis streams + webhook delivery ──

  async publishEvent(event: { type: string; namespace: string; payload: Record<string, unknown> }): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.xadd(
        "treasurenet:events",
        "*",
        "type",
        event.type,
        "namespace",
        event.namespace,
        "payload",
        JSON.stringify(event.payload)
      );
    } catch (error) {
      this.warn("redis xadd failed", error);
    }
  }

  async deliverNotification(notification: { did: string; type: string; message: string }): Promise<void> {
    if (!this.config.notifyWebhookUrl) return;
    try {
      const response = await fetch(this.config.notifyWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) this.warn(`webhook returned ${response.status}`, new Error("http"));
    } catch (error) {
      this.warn("webhook delivery failed", error);
    }
  }

  // ── boot rehydration ──

  /** Reload the projection into the in-memory store after a restart. */
  async rehydrate(store: Store): Promise<{ hunts: number; claims: number; requests: number }> {
    if (!this.prisma) return { hunts: 0, claims: 0, requests: 0 };
    const p = this.prisma;
    try {
      const hunts = await p.hunt.findMany({ include: { clues: true } });
      for (const row of hunts) {
        const clues = ((row as { clues?: Array<Record<string, unknown>> }).clues ?? [])
          .map((clue) => ({
            index: Number(clue.index),
            manifest_id: String(clue.manifestId),
            latitude: Number(clue.latitude),
            longitude: Number(clue.longitude),
            radius_meters: Number(clue.radiusMeters),
          }))
          .sort((a, b) => a.index - b.index);
        store.hunts.set(String(row.huntId), {
          hunt_id: String(row.huntId),
          gm_did: String(row.gmDid),
          title: String(row.title),
          status: String(row.status) as Hunt["status"],
          reward_amount: Number(row.rewardAmount),
          reward_token: String(row.rewardToken),
          escrow_id: String(row.escrowId),
          expires_at: new Date(row.expiresAt as unknown as string).toISOString(),
          expires_block: Number(row.expiresBlock),
          clues,
          created_at: new Date(row.createdAt as unknown as string).toISOString(),
          ...(row.winnerDid ? { winner_did: String(row.winnerDid) } : {}),
          ...(row.receiptId ? { receipt_id: String(row.receiptId) } : {}),
        });
      }
      const claims = await p.claim.findMany();
      for (const row of claims) {
        store.claims.set(String(row.claimId), {
          claim_id: String(row.claimId),
          hunt_id: String(row.huntId),
          escrow_id: String(row.escrowId ?? ""),
          winner_did: String(row.winnerDid),
          reward_amount: Number(row.rewardAmount),
          reward_token: String(row.rewardToken),
          gm_signature: String(row.gmSignature),
          oracle_signature: String(row.oracleSignature),
          status: String(row.status) as ClaimRecord["status"],
          created_at: new Date(row.createdAt as unknown as string).toISOString(),
          ...(row.receiptId ? { receipt_id: String(row.receiptId) } : {}),
          ...(row.blockHeight !== undefined && row.blockHeight !== null
            ? { block_height: Number(row.blockHeight) }
            : {}),
        });
      }
      const requests = await p.claimRequest.findMany();
      for (const row of requests) {
        store.claimRequests.set(String(row.requestId), {
          request_id: String(row.requestId),
          hunt_id: String(row.huntId),
          escrow_id: String(row.escrowId),
          player_did: String(row.playerDid),
          photo_b64: String(row.photoB64),
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          status: String(row.status) as ClaimRequest["status"],
          created_at: new Date(row.createdAt as unknown as string).toISOString(),
        });
      }
      const clues = await p.unlockedClue.findMany();
      for (const row of clues) {
        store.unlockedClues.add(
          `${String(row.huntId)}:${String(row.playerDid)}:${Number(row.clueIndex)}`
        );
      }
      const consents = await p.consentReceipt.findMany();
      for (const row of consents) {
        store.consentReceipts.set(String(row.subjectDid), {
          subject_did: String(row.subjectDid),
          purposes: String(row.purposes).split(",").filter(Boolean) as ("location" | "photo")[],
          granted_at: new Date(row.grantedAt as unknown as string).toISOString(),
          expires_at: new Date(row.expiresAt as unknown as string).toISOString(),
          receipt_id: String(row.receiptId),
        });
      }
      return { hunts: hunts.length, claims: claims.length, requests: requests.length };
    } catch (error) {
      this.warn("rehydrate failed", error);
      return { hunts: 0, claims: 0, requests: 0 };
    }
  }
}
