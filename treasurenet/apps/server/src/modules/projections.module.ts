import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";

/** Leaderboard, analytics, notification, and health projections. */

export class LeaderboardModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  top(limit = 20) {
    return this.store.leaderboard().slice(0, limit);
  }
}

export class AnalyticsModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  summary() {
    const hunts = [...this.store.hunts.values()];
    return {
      ...this.store.analytics,
      hunts_total: hunts.length,
      hunts_by_status: hunts.reduce<Record<string, number>>((acc, hunt) => {
        acc[hunt.status] = (acc[hunt.status] ?? 0) + 1;
        return acc;
      }, {}),
      events_total: this.store.events.length,
    };
  }
}

export class NotificationModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  forDid(did: string) {
    return this.store.notifications.filter((n) => n.did === did).slice(-50).reverse();
  }
}

export class AdminModule {
  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  async overview() {
    let registryCounts: Record<string, unknown> = {};
    try {
      const result = await this.chain.adapter.execute("player-registry.v1", {
        operation: "list_counts",
      });
      registryCounts = result.output;
    } catch {
      registryCounts = { error: "registry not configured" };
    }
    return {
      chain_mode: this.chain.mode(),
      service_did: this.chain.config.serviceDid,
      oracle_did: this.chain.config.oracleDid,
      reward_module: this.chain.config.rewardTokenModuleId,
      registry: registryCounts,
      namespaces: ["game.hunts", "game.escrow", "identity.roles", "game.claims"],
      events: this.store.events.slice(-25).reverse(),
    };
  }

  fileAlerts() {
    // Encrypted file store alerts feed (revocations, suspicious reads).
    return this.store.events.filter((event) => event.type.startsWith("clue.")).slice(-25).reverse();
  }
}

export class HealthModule {
  private readonly chain: ChainModule;

  constructor(chain: ChainModule) {
    this.chain = chain;
  }

  check() {
    return {
      status: "ok",
      chain_mode: this.chain.mode(),
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
