import type { Store } from "../store.ts";

/**
 * Scheduler module — expiry watcher. Reads game.escrow / game.hunts state,
 * and after expires_at passes triggers owner-signed refund entries. Refunds
 * require the hunt GM's key over two different canonical messages
 * (`refund:<escrow_id>` and `refund:<hunt_id>:<gm_did>`); when the
 * configured GM refund key matches the hunt owner the backend self-serves
 * the refund, otherwise the hunt stays marked expired for console completion.
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
    for (const hunt of this.deps.store.hunts.values()) {
      result.checked += 1;
      if (["created", "funded", "active", "paused"].includes(hunt.status)) {
        const expired = new Date(hunt.expires_at).getTime() < now.getTime();
        if (!expired) continue;
        result.expired += 1;
        hunt.status = "expired";
        this.deps.store.upsertHunt(hunt);
        this.deps.store.recordEvent("hunt.expired", "game.escrow", { hunt_id: hunt.hunt_id });
      } else if (hunt.status !== "expired") {
        continue;
      }
      // Retry refunds for every still-expired hunt: the escrow deadline
      // block may lag the wall clock, and the refund attempt is idempotent
      // (the module rejects an already-refunded escrow).
      try {
        await this.deps.onExpiry(hunt.hunt_id);
        if (this.deps.store.hunts.get(hunt.hunt_id)?.status === "refunded") {
          result.refundsTriggered.push(hunt.hunt_id);
        }
      } catch {
        // Refund requires the GM key: the console surfaces the pending
        // refund instead; keep the hunt marked expired for the GM.
      }
    }
    return result;
  }
}
