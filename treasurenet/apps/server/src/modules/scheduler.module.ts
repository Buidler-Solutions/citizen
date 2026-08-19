import type { Store } from "../store.ts";

/**
 * Scheduler module — expiry watcher. Reads game.escrow / game.hunts state,
 * and after expires_at passes triggers owner-signed refund entries. In this
 * port the refund entry is GM-signed by the escrow owner key held via the
 * backend KMS signer (documented deviation: original TreasureNet scheduler
 * called the escrow contract directly with the owner key).
 */

export interface SchedulerTick {
  checked: number;
  expired: number;
  refundsTriggered: string[];
}

export interface SchedulerDeps {
  store: Store;
  onExpiry: (huntId: string) => Promise<void>;
}

export class SchedulerModule {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined);
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<SchedulerTick> {
    const now = new Date();
    const result: SchedulerTick = { checked: 0, expired: 0, refundsTriggered: [] };
    for (const hunt of this.store.hunts.values()) {
      result.checked += 1;
      const expired = new Date(hunt.expires_at).getTime() < now.getTime();
      if (!expired) continue;
      if (!["created", "funded", "active", "paused"].includes(hunt.status)) continue;
      result.expired += 1;
      hunt.status = "expired";
      this.deps.store.recordEvent("hunt.expired", "game.escrow", { hunt_id: hunt.hunt_id });
      try {
        await this.deps.onExpiry(hunt.hunt_id);
        result.refundsTriggered.push(hunt.hunt_id);
      } catch {
        // Refund requires the GM key: the console surfaces the pending
        // refund instead; keep the hunt marked expired for the GM.
      }
    }
    return result;
  }
}
