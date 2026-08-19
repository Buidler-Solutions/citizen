import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";

/**
 * Indexer module — projects chain writes into the query store and emits
 * events for live UI + leaderboard. Against a real node this polls
 * /api/v1/blocks and /api/v1/entries; with the mock chain every module
 * gateway write is projected directly.
 */

export class IndexerModule {
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
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

  async poll(): Promise<{ block: number; projected: number }> {
    const block = this.chain.currentBlock();
    let projected = 0;
    for (const hunt of this.store.hunts.values()) {
      if (["created", "funded", "active", "paused"].includes(hunt.status)) {
        if (block > hunt.expires_block && hunt.status !== "expired") {
          hunt.status = "expired";
          this.store.recordEvent("hunt.expired", "game.hunts", { hunt_id: hunt.hunt_id });
          projected += 1;
        }
      }
    }
    return { block, projected };
  }

  events(sinceIndex = 0) {
    return this.store.events.slice(sinceIndex);
  }
}
