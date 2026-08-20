import { randomUUID } from "node:crypto";
import type {
  AuthChallenge,
  ClaimRecord,
  ClaimRequest,
  ConsentReceipt,
  Hunt,
  LeaderboardEntry,
  OracleVerdict,
} from "../../../packages/shared/src/index.ts";
import type { PersistenceModule } from "./modules/persistence.module.ts";

/**
 * In-memory projections. The chain remains the source of truth; this store
 * mirrors what the original TreasureNet Postgres/Redis stack held, and the
 * indexer module keeps it in sync with chain writes. When a PersistenceModule
 * is attached, every mutation write-throughs to Postgres and events fan out
 * to Redis streams + the notification webhook.
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

export interface Org {
  org_id: string;
  name: string;
  owner_did: string;
  created_at: string;
  members: Array<{ did: string; role: string }>;
}

export class Store {
  readonly hunts = new Map<string, Hunt>();
  readonly claims = new Map<string, ClaimRecord>();
  readonly claimRequests = new Map<string, ClaimRequest>();
  readonly challenges = new Map<string, AuthChallenge>();
  readonly sessions = new Map<string, Session>();
  readonly consentReceipts = new Map<string, ConsentReceipt>();
  readonly oracleVerdicts: OracleVerdict[] = [];
  readonly unlockedClues = new Set<string>();
  readonly notifications: Notification[] = [];
  readonly events: ChainEvent[] = [];
  readonly orgs = new Map<string, Org>();
  readonly roles = new Map<string, string>();
  readonly analytics = {
    hunts_created: 0,
    hunts_active: 0,
    claims_confirmed: 0,
    rewards_paid: 0,
    checkins: 0,
  };

  private persistence?: PersistenceModule;

  attach(persistence: PersistenceModule) {
    this.persistence = persistence;
  }

  recordEvent(type: string, namespace: string, payload: Record<string, unknown>) {
    const event: ChainEvent = {
      id: randomUUID(),
      type,
      namespace,
      payload,
      created_at: new Date().toISOString(),
    };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    void this.persistence?.saveEvent(event);
    void this.persistence?.publishEvent(event);
  }

  notify(did: string, type: string, message: string) {
    const notification: Notification = {
      id: randomUUID(),
      did,
      type,
      message,
      created_at: new Date().toISOString(),
    };
    this.notifications.push(notification);
    if (this.notifications.length > 500) this.notifications.shift();
    void this.persistence?.saveNotification(notification);
    void this.persistence?.deliverNotification(notification);
  }

  // ── write-through upserts (mutate memory + Postgres projection) ──

  upsertHunt(hunt: Hunt) {
    this.hunts.set(hunt.hunt_id, hunt);
    void this.persistence?.saveHunt(hunt);
  }

  upsertClaim(record: ClaimRecord) {
    this.claims.set(record.claim_id, record);
    void this.persistence?.saveClaim(record);
  }

  upsertClaimRequest(request: ClaimRequest) {
    this.claimRequests.set(request.request_id, request);
    void this.persistence?.saveClaimRequest(request);
  }

  upsertRole(did: string, role: string) {
    this.roles.set(did, role);
    void this.persistence?.saveRole(did, role as never);
  }

  touchWallet(did: string) {
    void this.persistence?.touchWallet(did);
  }

  addVerdict(verdict: OracleVerdict) {
    this.oracleVerdicts.push(verdict);
    void this.persistence?.saveVerdict(verdict);
  }

  setConsent(receipt: ConsentReceipt) {
    this.consentReceipts.set(receipt.subject_did, receipt);
    void this.persistence?.saveConsent(receipt);
  }

  unlockClue(key: string) {
    this.unlockedClues.add(key);
    const [huntId, did, clueIndex] = key.split(":");
    void this.persistence?.saveUnlockedClue(huntId, did, Number(clueIndex));
  }

  upsertOrg(org: Org) {
    this.orgs.set(org.org_id, org);
    void this.persistence?.saveOrg(org);
  }

  upsertOrgMember(orgId: string, did: string, role: string) {
    const org = this.orgs.get(orgId);
    if (org) {
      org.members = [
        ...org.members.filter((member) => member.did !== did),
        { did, role },
      ];
    }
    void this.persistence?.saveOrgMember({ org_id: orgId, did, role });
  }

  removeOrgMember(orgId: string, did: string) {
    const org = this.orgs.get(orgId);
    if (org) {
      org.members = org.members.filter((member) => member.did !== did);
    }
    void this.persistence?.removeOrgMember(orgId, did);
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
