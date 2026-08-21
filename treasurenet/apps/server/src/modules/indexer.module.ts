import type { Hunt } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import type { PersistenceModule } from "./persistence.module.ts";

/**
 * Indexer module — projects chain writes into the query store and emits
 * events for live UI + leaderboard.
 *
 * Mock mode: every module gateway write is projected directly; the poller
 * walks expiry blocks off the deterministic mock clock.
 *
 * Node mode: polls /api/v1/blocks and /api/v1/entries?namespace=game.hunts
 * with a durable cursor (IndexerCursor row), so a restarted backend resumes
 * where it left off instead of rescanning the ledger.
 */

interface NodeBlockItem {
  height?: number;
}

interface NodeLedgerEntry {
  namespace?: string;
  object_id?: string;
  action?: string;
  author?: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}

export class IndexerModule {
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor: number | null = null;
  private cursorLoaded = false;

  private readonly chain: ChainModule;
  private readonly store: Store;
  private readonly persistence?: PersistenceModule;

  constructor(chain: ChainModule, store: Store, persistence?: PersistenceModule) {
    this.chain = chain;
    this.store = store;
    this.persistence = persistence;
  }

  start(intervalMs = 5_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(() => undefined);
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  currentCursor(): number | null {
    return this.cursor;
  }

  async poll(): Promise<{ block: number; projected: number }> {
    if (this.chain.nodeClient) {
      return this.pollNode();
    }
    const block = this.chain.currentBlock();
    let projected = 0;
    for (const hunt of this.store.hunts.values()) {
      if (["created", "funded", "active", "paused"].includes(hunt.status)) {
        if (block > hunt.expires_block && hunt.status !== "expired") {
          hunt.status = "expired";
          this.store.upsertHunt(hunt);
          this.store.recordEvent("hunt.expired", "game.hunts", { hunt_id: hunt.hunt_id });
          projected += 1;
        }
      }
    }
    return { block, projected };
  }

  /**
   * Node-mode projection: follow the block list, then project new
   * game.hunts ledger entries into the store (hunts created by other
   * service instances or submitted directly to the node).
   */
  private async pollNode(): Promise<{ block: number; projected: number }> {
    const client = this.chain.nodeClient!;
    if (!this.cursorLoaded) {
      this.cursor = await this.persistence?.loadCursor() ?? null;
      this.cursorLoaded = true;
    }
    let projected = 0;
    let latestSeen = this.cursor ?? 0;
    const blocks = (await client.listBlocks()) as { items?: NodeBlockItem[] };
    const items = blocks.items ?? [];
    if (items.length > 0) {
      const newest = Math.max(...items.map((item) => Number(item.height ?? 0)));
      this.chain.setHeightHint(newest);
      if (this.cursor === null || newest > this.cursor) {
        this.store.recordEvent("chain.block", "game.hunts", {
          height: newest,
          new_blocks: this.cursor === null ? items.length : newest - this.cursor,
        });
        projected += 1;
      }
      latestSeen = newest;
    }
    try {
      const entriesResponse = (await client.listEntries("game.hunts")) as { entries?: NodeLedgerEntry[] };
      for (const entry of entriesResponse.entries ?? []) {
        if (!entry.object_id) continue;
        const existing = this.store.hunts.get(entry.object_id);
        if (existing) continue;
        const payload = entry.payload ?? {};
        const hunt = this.projectHuntEntry(entry.object_id, payload, entry.author ?? "");
        if (hunt) {
          this.store.upsertHunt(hunt);
          this.store.recordEvent("hunt.indexed", "game.hunts", { hunt_id: hunt.hunt_id });
          projected += 1;
        }
      }
    } catch {
      // Namespace reads are best-effort; the local write path already
      // projects hunts created through this instance.
    }
    if (latestSeen !== this.cursor) {
      this.cursor = latestSeen;
      await this.persistence?.saveCursor(latestSeen);
    }
    return { block: latestSeen, projected };
  }

  private projectHuntEntry(
    huntId: string,
    payload: Record<string, unknown>,
    author: string
  ): Hunt | undefined {
    const clues = Array.isArray(payload.clues) ? payload.clues : [];
    if (!author && !payload.gm_did) return undefined;
    return {
      hunt_id: huntId,
      gm_did: String(payload.gm_did ?? author),
      title: String(payload.title ?? huntId),
      status: "created",
      reward_amount: Number(payload.reward_amount ?? 0),
      reward_token: String(payload.reward_token ?? "CTZN"),
      escrow_id: String(payload.escrow_id ?? `esc-${huntId}`),
      expires_at: new Date(Number(payload.expires_at ?? Date.now() + 86_400_000)).toISOString(),
      expires_block: Number(payload.expires_block ?? 0),
      clues: (clues as Array<Record<string, unknown>>).map((clue, index) => ({
        index: Number(clue.index ?? index),
        manifest_id: String(clue.manifest_id ?? ""),
        latitude: Number(clue.latitude ?? 0),
        longitude: Number(clue.longitude ?? 0),
        radius_meters: Number(clue.radius_meters ?? 50),
      })),
      admission: {
        mode: (String(payload.admission_mode ?? "free") as "free" | "paid"),
        fee_amount: Number(payload.admission_fee ?? 0),
      },
      auto_claim: Boolean(payload.auto_claim ?? false),
      created_at: new Date().toISOString(),
    };
  }

  events(sinceIndex = 0) {
    return this.store.events.slice(sinceIndex);
  }
}
