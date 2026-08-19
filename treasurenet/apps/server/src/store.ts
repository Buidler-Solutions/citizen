import { randomUUID } from "node:crypto";
import type {
  AuthChallenge,
  ClaimRecord,
  ConsentReceipt,
  Hunt,
  LeaderboardEntry,
  OracleVerdict,
} from "../../../packages/shared/src/index.ts";

/**
 * In-memory projections. The chain remains the source of truth; this store
 * mirrors what the original TreasureNet Postgres/Redis stack held, and the
 * indexer module keeps it in sync with chain writes.
 */

export interface Session {
  token: string;
  did: string;
  role?: string;
  expiresAt: number;
}

export interface Notification {
  id: string;
  did: string;
  type: string;
  message: string;
  created_at: string;
}

export interface ChainEvent {
  id: string;
  type: string;
  namespace: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export class Store {
  readonly hunts = new Map<string, Hunt>();
  readonly claims = new Map<string, ClaimRecord>();
  readonly challenges = new Map<string, AuthChallenge>();
  readonly sessions = new Map<string, Session>();
  readonly consentReceipts = new Map<string, ConsentReceipt>();
  readonly oracleVerdicts: OracleVerdict[] = [];
  readonly unlockedClues = new Set<string>();
  readonly notifications: Notification[] = [];
  readonly events: ChainEvent[] = [];
  readonly analytics = {
    hunts_created: 0,
    hunts_active: 0,
    claims_confirmed: 0,
    rewards_paid: 0,
    checkins: 0,
  };

  recordEvent(type: string, namespace: string, payload: Record<string, unknown>) {
    this.events.push({
      id: randomUUID(),
      type,
      namespace,
      payload,
      created_at: new Date().toISOString(),
    });
    if (this.events.length > 500) this.events.shift();
  }

  notify(did: string, type: string, message: string) {
    this.notifications.push({
      id: randomUUID(),
      did,
      type,
      message,
      created_at: new Date().toISOString(),
    });
    if (this.notifications.length > 500) this.notifications.shift();
  }

  leaderboard(): LeaderboardEntry[] {
    const entries = new Map<string, LeaderboardEntry>();
    for (const claim of this.claims.values()) {
      if (claim.status !== "confirmed") continue;
      const entry = entries.get(claim.winner_did) ?? {
        player_did: claim.winner_did,
        hunts_won: 0,
        total_reward: 0,
        clues_solved: 0,
      };
      entry.hunts_won += 1;
      entry.total_reward += claim.reward_amount;
      entries.set(claim.winner_did, entry);
    }
    for (const verdict of this.oracleVerdicts) {
      if (!verdict.passed) continue;
      const entry = entries.get(verdict.player_did);
      if (entry) entry.clues_solved += 1;
    }
    return [...entries.values()].sort((a, b) => b.total_reward - a.total_reward);
  }
}
