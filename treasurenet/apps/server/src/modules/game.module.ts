import { assetMessages, claimMessages, verifyMessage } from "../../../../chain/sdk/src/index.ts";
import { expiryToBlock, type Hunt, type HuntAdmission, type HuntClue } from "../../../../packages/shared/src/index.ts";
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
    admission?: HuntAdmission;
    auto_claim?: boolean;
    delegate_gm_signature?: string;
    delegate_escrow_gm_signature?: string;
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
    const admission: HuntAdmission = input.admission ?? { mode: "free", fee_amount: 0 };
    if (admission.mode === "paid" && (!Number.isFinite(admission.fee_amount) || admission.fee_amount <= 0)) {
      badRequest("InvalidAdmission", "paid admission requires a positive fee_amount");
    }
    // Instant settlement needs the GM's claim delegation on both modules at
    // setup: the service DID then signs claim envelopes as the owner side of
    // the 2-of-2 (oracle still co-signs), while refunds stay GM-only.
    const autoClaim =
      input.auto_claim ?? Boolean(input.delegate_gm_signature && input.delegate_escrow_gm_signature);
    if (autoClaim && (!input.delegate_gm_signature || !input.delegate_escrow_gm_signature)) {
      badRequest(
        "MissingFields",
        "auto_claim requires delegate_gm_signature and delegate_escrow_gm_signature over delegate:<id>:<service did>"
      );
    }
    const huntId = input.hunt_id ?? `hunt-${randomHuntId()}`;
    if (this.store.hunts.has(huntId)) {
      badRequest("HuntExists", `hunt ${huntId} already exists`);
    }

    // Node mode: refresh the height hint so short expiries convert to a
    // block still in the future after submission/finalization latency.
    if (this.chain.nodeClient) {
      await this.chain.refreshHeight();
    }
    const expiresBlock = expiryToBlock(input.expires_at, this.chain.currentBlock());
    const escrowId = `esc-${huntId}`;
    // Default reward token is the transferable reward asset: the hunt then
    // settles through citizen-asset vault custody instead of soulbound
    // CTZN mints. Any other token id keeps the legacy escrow-only path.
    const rewardToken = input.reward_token ?? this.chain.config.rewardAssetId;
    const assetCustody = rewardToken === this.chain.config.rewardAssetId;

    // Escrow init is service-sponsored (namespace writer); funding happens
    // in a separate, GM-signed step exactly like the Stellar contract.
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "init",
      escrow_id: escrowId,
      owner_did: input.gm_did,
      // Real escrow module requires a non-empty claimer; hunts mint any
      // verified winner at claim time, so "-" is a placeholder only.
      claimer_did: "-",
      amount: String(input.reward_amount),
      token: rewardToken,
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
      reward_token: rewardToken,
      expires_block: String(expiresBlock),
      escrow_id: escrowId,
    });

    // Reward custody: a timed 2-of-2 vault holds the real token balance
    // backing the escrow. Instant-claim hunts add the service DID as a third
    // approver so delegated payouts (service + oracle) reach the threshold.
    if (assetCustody) {
      await this.chain.openRewardVault(escrowId, input.gm_did, expiresBlock, {
        instantClaim: autoClaim,
      });
    }

    // GM claim delegation for instant settlement (both modules, re-callable
    // to rotate by the GM). Signatures: delegate:<id>:<service did>.
    if (autoClaim) {
      const serviceDid = this.chain.config.serviceDid;
      const gmPublicKeyHex = input.gm_did.split(":").pop() ?? "";
      if (
        !verifyMessage(claimMessages.huntDelegate(huntId, serviceDid), input.delegate_gm_signature!, gmPublicKeyHex)
      ) {
        unauthorized("InvalidSignature", "hunt claim delegate signature verification failed");
      }
      if (
        !verifyMessage(
          claimMessages.escrowDelegate(escrowId, serviceDid),
          input.delegate_escrow_gm_signature!,
          gmPublicKeyHex
        )
      ) {
        unauthorized("InvalidSignature", "escrow claim delegate signature verification failed");
      }
      await this.chain.adapter.execute("treasure-hunt.v1", {
        operation: "set_claim_delegate",
        hunt_id: huntId,
        gm_did: input.gm_did,
        signature: input.delegate_gm_signature,
        delegate_did: serviceDid,
      });
      await this.chain.adapter.execute("treasure-escrow.v1", {
        operation: "set_claim_delegate",
        escrow_id: escrowId,
        gm_did: input.gm_did,
        signature: input.delegate_escrow_gm_signature,
        delegate_did: serviceDid,
      });
    }

    const hunt: Hunt = {
      hunt_id: huntId,
      gm_did: input.gm_did,
      title: input.title,
      status: "created",
      reward_amount: input.reward_amount,
      reward_token: rewardToken,
      escrow_id: escrowId,
      expires_at: input.expires_at,
      expires_block: expiresBlock,
      clues: [...input.clues].sort((a, b) => a.index - b.index),
      admission,
      auto_claim: autoClaim,
      player_count: 0,
      created_at: new Date().toISOString(),
    };
    this.store.upsertHunt(hunt);
    this.store.analytics.hunts_created += 1;
    this.store.recordEvent("hunt.created", "game.hunts", { hunt_id: huntId });
    return hunt;
  }

  async fundHunt(
    huntId: string,
    gmSignature: string,
    escrowSignature: string,
    assetSignature?: string,
    amount?: number
  ): Promise<Hunt> {
    const hunt = this.getHunt(huntId);
    this.verifyGmSignature(hunt, claimMessages.fundHunt(huntId, hunt.gm_did), gmSignature);
    const fundAmount = amount ?? hunt.reward_amount;
    // Asset-custody hunts back the escrow with real tokens: issuers mint the
    // reward to the GM, then the GM deposits it into the hunt vault. The GM
    // signs the deposit transfer before any chain state moves.
    const assetCustody = hunt.reward_token === this.chain.config.rewardAssetId;
    const depositRef = `deposit-${huntId}`;
    const depositMessage = assetMessages.transfer(
      hunt.reward_token,
      hunt.gm_did,
      assetMessages.vaultAccount(hunt.escrow_id),
      fundAmount,
      depositRef
    );
    if (assetCustody && !verifyMessage(depositMessage, assetSignature ?? "", hunt.gm_did.split(":").pop() ?? "")) {
      badRequest("InvalidSignature", "reward vault deposit signature verification failed");
    }
    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation: "fund_hunt",
      hunt_id: huntId,
      funder_did: hunt.gm_did,
      signature: gmSignature,
      amount: String(fundAmount),
    });
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "fund",
      escrow_id: hunt.escrow_id,
      funder_did: hunt.gm_did,
      signature: escrowSignature,
    });
    if (assetCustody) {
      await this.chain.mintRewardToOwner(hunt.gm_did, fundAmount, `fund-${huntId}`);
      await this.chain.adapter.execute(this.chain.config.assetModuleId, {
        operation: "transfer",
        token_id: hunt.reward_token,
        from_did: hunt.gm_did,
        to_did: assetMessages.vaultAccount(hunt.escrow_id),
        amount: String(fundAmount),
        ref: depositRef,
        signature: assetSignature!,
      });
    }
    hunt.status = "funded";
    this.store.upsertHunt(hunt);
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
    this.store.upsertHunt(hunt);
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

  isParticipant(huntId: string, playerDid: string): boolean {
    return this.store.isParticipant(huntId, playerDid);
  }

  players(huntId: string) {
    this.getHunt(huntId);
    const roster = this.store.participantsOf(huntId);
    return {
      hunt_id: huntId,
      player_count: roster.length,
      players: roster.sort((a, b) => a.joined_at.localeCompare(b.joined_at)),
    };
  }

  /**
   * Player admission. Free hunts record the participant; paid hunts require
   * the player's signature over the canonical admission transfer
   * `transfer:<token>:<player>:<gm>:<fee>:join-<hunt_id>` and move the fee
   * on-chain to the GM before the participant is recorded. Joining is only
   * possible while the hunt is active (activation requires a funded escrow,
   * so an unfunded hunt can never admit players).
   */
  async join(input: { hunt_id: string; player_did: string; payment_signature?: string }) {
    const hunt = this.getHunt(input.hunt_id);
    if (hunt.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt.status}; join opens when the GM activates the funded hunt`);
    }
    if (this.store.isParticipant(input.hunt_id, input.player_did)) {
      badRequest("AlreadyJoined", `player ${input.player_did} already joined hunt ${input.hunt_id}`);
    }
    let feePaid = 0;
    if (hunt.admission.mode === "paid") {
      const fee = hunt.admission.fee_amount;
      if (!input.payment_signature) {
        badRequest(
          "PaymentRequired",
          `paid admission: payment_signature over assetMessages.transfer(${hunt.reward_token}, player, gm, ${fee}, join-${input.hunt_id}) is required`
        );
      }
      const message = assetMessages.transfer(
        hunt.reward_token,
        input.player_did,
        hunt.gm_did,
        fee,
        `join-${input.hunt_id}`
      );
      const playerPublicKeyHex = input.player_did.split(":").pop() ?? "";
      if (!verifyMessage(message, input.payment_signature, playerPublicKeyHex)) {
        badRequest("InvalidSignature", "admission payment signature verification failed");
      }
      await this.chain.adapter.execute(this.chain.config.assetModuleId, {
        operation: "transfer",
        token_id: hunt.reward_token,
        from_did: input.player_did,
        to_did: hunt.gm_did,
        amount: String(fee),
        ref: `join-${input.hunt_id}`,
        signature: input.payment_signature,
      });
      feePaid = fee;
    }
    this.store.addParticipant(input.hunt_id, input.player_did, feePaid);
    hunt.player_count = this.store.participantsOf(input.hunt_id).length;
    this.store.upsertHunt(hunt);
    this.store.recordEvent("player.joined", "game.hunts", {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      mode: hunt.admission.mode,
      fee_paid: feePaid,
    });
    this.store.notify(
      hunt.gm_did,
      "player.joined",
      `Player joined ${hunt.title} (${hunt.admission.mode} admission${feePaid ? `, fee ${feePaid} ${hunt.reward_token}` : ""}).`
    );
    return {
      joined: true as const,
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      mode: hunt.admission.mode,
      fee_paid: feePaid,
      player_count: hunt.player_count,
    };
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
    if (!this.store.isParticipant(input.hunt_id, input.player_did)) {
      badRequest("NotParticipant", `join hunt ${input.hunt_id} before checking in`);
    }
    const clue = hunt.clues.find((c) => c.index === input.clue_index);
    if (!clue) notFound("ClueNotFound", `clue ${input.clue_index} not in hunt`);
    // Sequential clue chain: only the next expected clue unlocks (already
    // unlocked clues stay readable for review/idempotent re-checks).
    if (!this.hasUnlocked(input.hunt_id, input.player_did, input.clue_index)) {
      const expected = this.progress(input.hunt_id, input.player_did).next_clue_index;
      if (input.clue_index !== expected) {
        badRequest("OutOfOrderClue", `clue ${input.clue_index} is locked; solve clue ${expected} first`);
      }
    }
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
    this.store.unlockClue(key);
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

  /** Player clue-chain progress for the mobile app resume flow. */
  progress(huntId: string, playerDid: string) {
    const hunt = this.getHunt(huntId);
    const unlocked = hunt.clues
      .filter((clue) => this.hasUnlocked(huntId, playerDid, clue.index))
      .map((clue) => clue.index);
    const next = hunt.clues.find((clue) => !unlocked.includes(clue.index));
    return {
      hunt_id: huntId,
      player_did: playerDid,
      status: hunt.status,
      unlocked_clues: unlocked,
      next_clue_index: next?.index ?? null,
      final_clue_index: hunt.clues[hunt.clues.length - 1].index,
    };
  }
}

function randomHuntId(): string {
  return Math.random().toString(36).slice(2, 10);
}
