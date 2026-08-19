import { claimMessages, verifyMessage } from "../../../../chain/sdk/src/index.ts";
import { expiryToBlock, type Hunt, type HuntClue } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import { badRequest, notFound, unauthorized } from "../http.ts";

/**
 * Game module — hunt lifecycle plus the player clue flow. Mirrors the
 * original TreasureNet game service backed by the treasure-hunt contract:
 * hunts are created/funded/activated by Game Masters; players check in at
 * GPS checkpoints; the final claim triggers the escrow payout.
 */

export class GameModule {
  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  private async requireRole(did: string, role: string) {
    try {
      await this.chain.adapter.execute("player-registry.v1", {
        operation: "has_role",
        did,
        role,
      });
    } catch {
      unauthorized("InsufficientRole", `${did} does not hold the ${role} role`);
    }
  }

  private verifyGmSignature(hunt: Hunt, message: string, signature: string) {
    const publicKeyHex = hunt.gm_did.split(":").pop() ?? "";
    if (!verifyMessage(message, signature, publicKeyHex)) {
      unauthorized("InvalidSignature", "game master signature verification failed");
    }
  }

  private getHunt(huntId: string): Hunt {
    const hunt = this.store.hunts.get(huntId);
    if (!hunt) notFound("HuntNotFound", `hunt ${huntId} does not exist`);
    return hunt!;
  }

  async createHunt(input: {
    gm_did: string;
    gm_signature: string;
    hunt_id?: string;
    title: string;
    reward_amount: number;
    reward_token?: string;
    expires_at: string;
    clues: HuntClue[];
  }): Promise<Hunt> {
    await this.requireRole(input.gm_did, "gamemaster");
    if (!input.title || input.reward_amount <= 0 || !input.expires_at) {
      badRequest("InvalidHunt", "title, positive reward_amount, and expires_at are required");
    }
    if (!Array.isArray(input.clues) || input.clues.length === 0) {
      badRequest("InvalidClues", "at least one clue with an encrypted manifest is required");
    }
    for (const clue of input.clues) {
      if (!clue.manifest_id) {
        badRequest("InvalidClues", "every clue requires an encrypted file manifest_id");
      }
    }
    const huntId = input.hunt_id ?? `hunt-${randomHuntId()}`;
    if (this.store.hunts.has(huntId)) {
      badRequest("HuntExists", `hunt ${huntId} already exists`);
    }

    const expiresBlock = expiryToBlock(input.expires_at, this.chain.currentBlock());
    const escrowId = `esc-${huntId}`;

    // Escrow init is service-sponsored (namespace writer); funding happens
    // in a separate, GM-signed step exactly like the Stellar contract.
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "init",
      escrow_id: escrowId,
      owner_did: input.gm_did,
      claimer_did: "",
      amount: String(input.reward_amount),
      token: input.reward_token ?? "CTZN",
      deadline_block: String(expiresBlock),
    });

    const createMessage = claimMessages.createHunt(huntId, input.gm_did);
    const publicKeyHex = input.gm_did.split(":").pop() ?? "";
    if (!verifyMessage(createMessage, input.gm_signature, publicKeyHex)) {
      unauthorized("InvalidSignature", "hunt creation signature verification failed");
    }

    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation: "create_hunt",
      hunt_id: huntId,
      gm_did: input.gm_did,
      signature: input.gm_signature,
      reward_amount: String(input.reward_amount),
      reward_token: input.reward_token ?? "CTZN",
      expires_block: String(expiresBlock),
      escrow_id: escrowId,
    });

    const hunt: Hunt = {
      hunt_id: huntId,
      gm_did: input.gm_did,
      title: input.title,
      status: "created",
      reward_amount: input.reward_amount,
      reward_token: input.reward_token ?? "CTZN",
      escrow_id: escrowId,
      expires_at: input.expires_at,
      expires_block: expiresBlock,
      clues: [...input.clues].sort((a, b) => a.index - b.index),
      created_at: new Date().toISOString(),
    };
    this.store.hunts.set(huntId, hunt);
    this.store.analytics.hunts_created += 1;
    this.store.recordEvent("hunt.created", "game.hunts", { hunt_id: huntId });
    return hunt;
  }

  async fundHunt(
    huntId: string,
    gmSignature: string,
    escrowSignature: string,
    amount?: number
  ): Promise<Hunt> {
    const hunt = this.getHunt(huntId);
    this.verifyGmSignature(hunt, claimMessages.fundHunt(huntId, hunt.gm_did), gmSignature);
    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation: "fund_hunt",
      hunt_id: huntId,
      funder_did: hunt.gm_did,
      signature: gmSignature,
      amount: String(amount ?? hunt.reward_amount),
    });
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "fund",
      escrow_id: hunt.escrow_id,
      funder_did: hunt.gm_did,
      signature: escrowSignature,
    });
    hunt.status = "funded";
    this.store.recordEvent("hunt.funded", "game.hunts", { hunt_id: huntId });
    return hunt;
  }

  private async lifecycle(huntId: string, operation: string, gmSignature: string): Promise<Hunt> {
    const hunt = this.getHunt(huntId);
    const message = claimMessages[operation as "activate" | "pause" | "resume" | "cancel"](
      huntId,
      hunt.gm_did
    );
    this.verifyGmSignature(hunt, message, gmSignature);
    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation,
      hunt_id: huntId,
      gm_did: hunt.gm_did,
      signature: gmSignature,
    });
    hunt.status =
      operation === "activate" ? "active"
      : operation === "pause" ? "paused"
      : operation === "resume" ? "active"
      : "cancelled";
    if (hunt.status === "active") this.store.analytics.hunts_active += 1;
    this.store.recordEvent(`hunt.${operation}`, "game.hunts", { hunt_id: huntId });
    return hunt;
  }

  activate(huntId: string, gmSignature: string) {
    return this.lifecycle(huntId, "activate", gmSignature);
  }

  pause(huntId: string, gmSignature: string) {
    return this.lifecycle(huntId, "pause", gmSignature);
  }

  resume(huntId: string, gmSignature: string) {
    return this.lifecycle(huntId, "resume", gmSignature);
  }

  cancel(huntId: string, gmSignature: string) {
    return this.lifecycle(huntId, "cancel", gmSignature);
  }

  list(): Hunt[] {
    return [...this.store.hunts.values()];
  }

  get(huntId: string): Hunt {
    return this.getHunt(huntId);
  }

  /** Player check-in at a clue checkpoint: geo gate, then clue manifest unlock. */
  async checkIn(input: {
    hunt_id: string;
    player_did: string;
    clue_index: number;
    latitude: number;
    longitude: number;
    accuracy_meters?: number;
    geo: { checkProximity: (a: number, b: number, c: number, d: number, r: number) => { withinRadius: boolean; distanceMeters: number } };
  }) {
    const hunt = this.getHunt(input.hunt_id);
    if (hunt.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt.status}, not active`);
    }
    const clue = hunt.clues.find((c) => c.index === input.clue_index);
    if (!clue) notFound("ClueNotFound", `clue ${input.clue_index} not in hunt`);
    const check = input.geo.checkProximity(
      input.latitude,
      input.longitude,
      clue!.latitude,
      clue!.longitude,
      clue!.radius_meters
    );
    this.store.analytics.checkins += 1;
    if (!check.withinRadius) {
      badRequest("NotAtLocation", `player is ${check.distanceMeters}m away (radius ${clue!.radius_meters}m)`);
    }
    const key = `${input.hunt_id}:${input.player_did}:${input.clue_index}`;
    this.store.unlockedClues.add(key);
    this.store.recordEvent("clue.unlocked", "game.hunts", {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
    });
    return {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      unlocked: true,
      manifest_id: clue!.manifest_id,
      is_final_clue: input.clue_index === hunt.clues[hunt.clues.length - 1].index,
      distance_meters: check.distanceMeters,
    };
  }

  hasUnlocked(huntId: string, playerDid: string, clueIndex: number): boolean {
    return this.store.unlockedClues.has(`${huntId}:${playerDid}:${clueIndex}`);
  }
}

function randomHuntId(): string {
  return Math.random().toString(36).slice(2, 10);
}
