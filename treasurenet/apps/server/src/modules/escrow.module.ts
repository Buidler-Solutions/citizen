import { randomUUID } from "node:crypto";
import {
  assetMessages,
  claimMessages,
  verifyMessage,
  ModuleError,
} from "../../../../chain/sdk/src/index.ts";
import type { ClaimRecord, ClaimRequest } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import type { GameModule } from "./game.module.ts";
import type { OracleModule } from "./oracle.module.ts";
import { badRequest, notFound } from "../http.ts";

/**
 * Escrow module — claim assembly and payout finality. Replaces the Stellar
 * require_auth flows: the winner's claim request carries the GM signature,
 * the oracle adds its co-signature after photo verification, and the pair
 * forms the 2-of-2 multisig envelope executed against both the escrow and
 * hunt modules. Every state change records its finality receipt.
 */

export class EscrowModule {
  private readonly chain: ChainModule;
  private readonly store: Store;
  private readonly game: GameModule;
  private readonly oracle: OracleModule;

  constructor(chain: ChainModule, store: Store, game: GameModule, oracle: OracleModule) {
    this.chain = chain;
    this.store = store;
    this.game = game;
    this.oracle = oracle;
  }

  async status(escrowId: string) {
    return this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "get_status",
      escrow_id: escrowId,
    });
  }

  async reward(escrowId: string) {
    return this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "get_reward",
      escrow_id: escrowId,
    });
  }

  /**
   * Player claim request (mobile app flow): photo proof from the final clue
   * location is stored pending Game Master review. The GM approves from the
   * web console by signing both claim messages over the request's player DID.
   */
  requestClaim(input: {
    hunt_id: string;
    player_did: string;
    photo_b64: string;
    latitude: number;
    longitude: number;
    geo: { checkProximity: (a: number, b: number, c: number, d: number, r: number) => { withinRadius: boolean; distanceMeters: number } };
  }): ClaimRequest {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    const finalClue = hunt!.clues[hunt!.clues.length - 1];
    if (!this.game.hasUnlocked(input.hunt_id, input.player_did, finalClue.index)) {
      badRequest("ClueLocked", "final clue not unlocked; complete the clue chain first");
    }
    if (!this.game.isParticipant(input.hunt_id, input.player_did)) {
      badRequest("NotParticipant", `player ${input.player_did} has not joined hunt ${input.hunt_id}`);
    }
    if (hunt!.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt!.status}`);
    }
    if (this.pendingFor(hunt!.hunt_id, input.player_did)) {
      badRequest("ClaimAlreadyRequested", "a pending claim request already exists for this hunt and player");
    }
    if (!input.photo_b64) badRequest("MissingFields", "photo_b64 is required");
    const geoCheck = input.geo.checkProximity(
      input.latitude,
      input.longitude,
      finalClue.latitude,
      finalClue.longitude,
      finalClue.radius_meters
    );
    if (!geoCheck.withinRadius) {
      badRequest("NotAtLocation", `player is ${geoCheck.distanceMeters}m from the final clue`);
    }
    const request: ClaimRequest = {
      request_id: randomUUID(),
      hunt_id: hunt!.hunt_id,
      escrow_id: hunt!.escrow_id,
      player_did: input.player_did,
      photo_b64: input.photo_b64,
      latitude: input.latitude,
      longitude: input.longitude,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.store.claimRequests.set(request.request_id, request);
    void this.store.upsertClaimRequest(request);
    this.store.recordEvent("claim.requested", "game.claims", {
      request_id: request.request_id,
      hunt_id: request.hunt_id,
      player_did: request.player_did,
    });
    this.store.notify(
      hunt!.gm_did,
      "claim.requested",
      `Player ${request.player_did} requests the ${hunt!.title} reward. Approve from the console.`
    );
    return request;
  }

  pendingClaims(): ClaimRequest[] {
    return [...this.store.claimRequests.values()]
      .filter((request) => request.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  denyClaim(requestId: string) {
    const request = this.store.claimRequests.get(requestId);
    if (!request) notFound("ClaimRequestNotFound", `claim request ${requestId} does not exist`);
    if (request!.status !== "pending") {
      badRequest("ClaimRequestNotPending", `claim request ${requestId} is ${request!.status}`);
    }
    request!.status = "denied";
    const hunt = this.store.hunts.get(request!.hunt_id);
    this.store.notify(
      request!.player_did,
      "claim.denied",
      `Your claim request for ${hunt?.title ?? request!.hunt_id} was denied by the Game Master.`
    );
    this.store.recordEvent("claim.denied", "game.claims", { request_id: requestId, hunt_id: request!.hunt_id });
    return { request_id: requestId, status: "denied" as const };
  }

  private pendingFor(huntId: string, playerDid: string): ClaimRequest | undefined {
    return this.pendingClaims().find(
      (request) => request.hunt_id === huntId && request.player_did === playerDid
    );
  }

  /**
   * Full claim flow: geo + photo oracle verdict, 2-of-2 multisig envelope,
   * escrow + hunt state transitions, payout receipt. When request_id is set
   * the player fields resolve from the approved mobile claim request.
   */
  async claim(input: {
    hunt_id: string;
    player_did?: string;
    request_id?: string;
    gm_signature: string;
    escrow_gm_signature: string;
    asset_gm_signature?: string;
    photo_b64?: string;
    latitude?: number;
    longitude?: number;
    geo: { checkProximity: (a: number, b: number, c: number, d: number, r: number) => { withinRadius: boolean } };
  }): Promise<ClaimRecord> {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    let playerDid = input.player_did;
    let photoB64 = input.photo_b64;
    let latitude = input.latitude;
    let longitude = input.longitude;
    let request: ClaimRequest | undefined;
    if (input.request_id) {
      request = this.store.claimRequests.get(input.request_id);
      if (!request) notFound("ClaimRequestNotFound", `claim request ${input.request_id} does not exist`);
      if (request!.status !== "pending") {
        badRequest("ClaimRequestNotPending", `claim request ${input.request_id} is ${request!.status}`);
      }
      if (request!.hunt_id !== input.hunt_id) {
        badRequest("ClaimRequestMismatch", "claim request belongs to a different hunt");
      }
      playerDid = request!.player_did;
      photoB64 = request!.photo_b64;
      latitude = request!.latitude;
      longitude = request!.longitude;
    }
    if (!playerDid) badRequest("MissingFields", "player_did or request_id is required");
    if (!photoB64) badRequest("MissingFields", "photo_b64 is required");
    const finalClue = hunt!.clues[hunt!.clues.length - 1];
    if (!this.game.hasUnlocked(input.hunt_id, playerDid!, finalClue.index)) {
      badRequest("ClueLocked", "final clue not unlocked; complete the clue chain first");
    }
    if (hunt!.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt!.status}`);
    }

    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    const huntClaimMessage = claimMessages.hunt(input.hunt_id, playerDid!);
    const escrowClaimMessage = claimMessages.escrow(hunt!.escrow_id, playerDid!);
    if (!verifyMessage(huntClaimMessage, input.gm_signature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "game master claim signature verification failed");
    }
    if (!verifyMessage(escrowClaimMessage, input.escrow_gm_signature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "escrow claim signature verification failed");
    }
    // Asset-custody hunts pay the winner from the reward vault: the GM
    // co-signs the vault transfer (the oracle co-signature is added here).
    const assetCustody = hunt!.reward_token === this.chain.config.rewardAssetId;
    const payoutRef = `claim-${input.hunt_id}`;
    const vaultPayoutMessage = assetMessages.vaultTransfer(
      hunt!.escrow_id,
      playerDid!,
      hunt!.reward_amount,
      payoutRef
    );
    if (assetCustody && !verifyMessage(vaultPayoutMessage, input.asset_gm_signature ?? "", gmPublicKeyHex)) {
      badRequest("InvalidSignature", "reward vault payout signature verification failed");
    }

    const geoCheck = input.geo.checkProximity(
      latitude!,
      longitude!,
      finalClue.latitude,
      finalClue.longitude,
      finalClue.radius_meters
    );
    const verdict = await this.oracle.evaluate({
      hunt_id: input.hunt_id,
      player_did: playerDid!,
      clue_index: finalClue.index,
      photo_b64: photoB64!,
      geoOk: geoCheck.withinRadius,
    });
    if (!verdict.passed) {
      badRequest("VerificationFailed", verdict.reason);
    }

    const oracleHuntSig = this.oracle.coSignClaim("hunt", input.hunt_id, playerDid!, verdict);
    const oracleEscrowSig = this.oracle.coSignClaim("escrow", hunt!.escrow_id, playerDid!, verdict);

    const claimId = randomUUID();
    const record: ClaimRecord = {
      claim_id: claimId,
      hunt_id: input.hunt_id,
      escrow_id: hunt!.escrow_id,
      winner_did: playerDid!,
      reward_amount: hunt!.reward_amount,
      reward_token: hunt!.reward_token,
      gm_signature: input.gm_signature,
      oracle_signature: oracleHuntSig,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    try {
      // Settle the reward BEFORE completing the hunt/escrow on-chain: an
      // under-funded or missing vault must fail the claim while the hunt is
      // still active (retryable after the vault is topped up), not strand a
      // winner behind a Completed hunt with no payout retry path.
      if (assetCustody) {
        await this.chain.vaultPayout(
          hunt!.escrow_id,
          playerDid!,
          hunt!.reward_amount,
          payoutRef,
          hunt!.gm_did,
          input.asset_gm_signature!
        );
      } else {
        await this.chain.distributeReward(playerDid!, hunt!.reward_amount, hunt!.hunt_id);
      }
      const huntResult = await this.chain.adapter.execute("treasure-hunt.v1", {
        operation: "claim",
        hunt_id: input.hunt_id,
        winner_did: playerDid!,
        cosigner_dids: `${hunt!.gm_did},${this.chain.config.oracleDid}`,
        signatures: `${input.gm_signature},${oracleHuntSig}`,
      });
      const escrowResult = await this.chain.adapter.execute("treasure-escrow.v1", {
        operation: "claim",
        escrow_id: hunt!.escrow_id,
        winner_did: playerDid!,
        cosigner_dids: `${hunt!.gm_did},${this.chain.config.oracleDid}`,
        signatures: `${input.escrow_gm_signature},${oracleEscrowSig}`,
      });

      const blockHeight =
        (escrowResult.output.receipt_block as number | undefined) ??
        (huntResult.output.receipt_block as number | undefined);
      // Node mode: module executes finalize via block height + module state,
      // not ledger receipts, so reference the sealed block deterministically.
      const receiptId = (escrowResult.meta as { receipt_id?: string }).receipt_id
        ?? (huntResult.meta as { receipt_id?: string }).receipt_id
        ?? (this.chain.nodeClient ? `node:${blockHeight ?? 0}:${hunt!.escrow_id}` : undefined);
      record.status = "confirmed";
      record.receipt_id = receiptId;
      record.block_height = blockHeight;

      hunt!.status = "completed";
      hunt!.winner_did = playerDid!;
      hunt!.receipt_id = receiptId;
      if (request) request.status = "approved";
      this.store.upsertHunt(hunt!);
      if (request) this.store.upsertClaimRequest(request);
      this.store.upsertClaim(record);
      this.store.analytics.claims_confirmed += 1;
      this.store.analytics.rewards_paid += hunt!.reward_amount;
      this.store.recordEvent("claim.confirmed", "game.claims", {
        claim_id: claimId,
        hunt_id: input.hunt_id,
        winner_did: playerDid!,
        receipt_id: receiptId,
      });
      this.store.notify(
        playerDid!,
        "claim.confirmed",
        `Reward of ${hunt!.reward_amount} ${hunt!.reward_token} paid. Receipt ${receiptId ?? "pending"}.`
      );
    } catch (error) {
      record.status = "failed";
      this.store.claims.set(claimId, record);
      this.store.upsertClaim(record);
      if (error instanceof ModuleError) {
        badRequest(error.code, error.message);
      }
      throw error;
    }
    return record;
  }

  /**
   * Instant settlement for auto-claim hunts: the final-clue unlock at the
   * treasure coordinates triggers payout immediately. The service DID signs
   * both claim envelopes as the GM's delegate (set_claim_delegate at hunt
   * setup), the oracle co-signs the geo verdict, and the reward moves before
   * the on-chain completion writes — the same failure-ordering invariant as
   * the manual claim path.
   */
  async settleInstantClaim(input: {
    hunt_id: string;
    winner_did: string;
    latitude: number;
    longitude: number;
    geo: { checkProximity: (a: number, b: number, c: number, d: number, r: number) => { withinRadius: boolean; distanceMeters: number } };
  }): Promise<ClaimRecord> {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    if (!hunt.auto_claim) {
      badRequest("AutoClaimDisabled", `hunt ${input.hunt_id} settles via GM-approved claims`);
    }
    if (hunt.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt.status}`);
    }
    if (!this.game.isParticipant(input.hunt_id, input.winner_did)) {
      badRequest("NotParticipant", `player ${input.winner_did} has not joined hunt ${input.hunt_id}`);
    }
    const finalClue = hunt!.clues[hunt!.clues.length - 1];
    if (!this.game.hasUnlocked(input.hunt_id, input.winner_did, finalClue.index)) {
      badRequest("ClueLocked", "final clue not unlocked; complete the clue chain first");
    }
    const geoCheck = input.geo.checkProximity(
      input.latitude,
      input.longitude,
      finalClue.latitude,
      finalClue.longitude,
      finalClue.radius_meters
    );
    if (!geoCheck.withinRadius) {
      badRequest("NotAtLocation", `player is ${geoCheck.distanceMeters}m from the final clue`);
    }
    const verdict = await this.oracle.evaluateInstant({
      hunt_id: input.hunt_id,
      player_did: input.winner_did,
      clue_index: finalClue.index,
      geoOk: geoCheck.withinRadius,
    });
    if (!verdict.passed) {
      badRequest("VerificationFailed", verdict.reason);
    }

    const serviceDid = this.chain.config.serviceDid;
    const serviceHuntSig = this.chain.serviceSignature(claimMessages.hunt(input.hunt_id, input.winner_did));
    const serviceEscrowSig = this.chain.serviceSignature(claimMessages.escrow(hunt!.escrow_id, input.winner_did));
    const oracleHuntSig = this.oracle.coSignClaim("hunt", input.hunt_id, input.winner_did, verdict);
    const oracleEscrowSig = this.oracle.coSignClaim("escrow", hunt!.escrow_id, input.winner_did, verdict);

    const claimId = randomUUID();
    const record: ClaimRecord = {
      claim_id: claimId,
      hunt_id: input.hunt_id,
      escrow_id: hunt!.escrow_id,
      winner_did: input.winner_did,
      reward_amount: hunt!.reward_amount,
      reward_token: hunt!.reward_token,
      gm_signature: serviceHuntSig,
      oracle_signature: oracleHuntSig,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    try {
      // Reward first (same invariant as the manual claim): an under-funded
      // vault must fail while the hunt is still active and retryable.
      const assetCustody = hunt!.reward_token === this.chain.config.rewardAssetId;
      if (assetCustody) {
        await this.chain.vaultPayoutDelegated(
          hunt!.escrow_id,
          input.winner_did,
          hunt!.reward_amount,
          `claim-${input.hunt_id}`
        );
      } else {
        await this.chain.distributeReward(input.winner_did, hunt!.reward_amount, input.hunt_id);
      }
      const huntResult = await this.chain.adapter.execute("treasure-hunt.v1", {
        operation: "claim",
        hunt_id: input.hunt_id,
        winner_did: input.winner_did,
        cosigner_dids: `${serviceDid},${this.chain.config.oracleDid}`,
        signatures: `${serviceHuntSig},${oracleHuntSig}`,
      });
      const escrowResult = await this.chain.adapter.execute("treasure-escrow.v1", {
        operation: "claim",
        escrow_id: hunt!.escrow_id,
        winner_did: input.winner_did,
        cosigner_dids: `${serviceDid},${this.chain.config.oracleDid}`,
        signatures: `${serviceEscrowSig},${oracleEscrowSig}`,
      });

      const blockHeight =
        (escrowResult.output.receipt_block as number | undefined) ??
        (huntResult.output.receipt_block as number | undefined);
      const receiptId = (escrowResult.meta as { receipt_id?: string }).receipt_id
        ?? (huntResult.meta as { receipt_id?: string }).receipt_id
        ?? (this.chain.nodeClient ? `node:${blockHeight ?? 0}:${hunt!.escrow_id}` : undefined);
      record.status = "confirmed";
      record.receipt_id = receiptId;
      record.block_height = blockHeight;

      hunt!.status = "completed";
      hunt!.winner_did = input.winner_did;
      hunt!.receipt_id = receiptId;
      this.store.upsertHunt(hunt!);
      this.store.upsertClaim(record);
      this.store.analytics.claims_confirmed += 1;
      this.store.analytics.rewards_paid += hunt!.reward_amount;
      this.store.recordEvent("claim.instant", "game.claims", {
        claim_id: claimId,
        hunt_id: input.hunt_id,
        winner_did: input.winner_did,
        receipt_id: receiptId,
      });
      this.store.notify(
        input.winner_did,
        "claim.instant",
        `Treasure found! Reward of ${hunt!.reward_amount} ${hunt!.reward_token} paid instantly. Receipt ${receiptId ?? "pending"}.`
      );
      this.store.notify(
        hunt!.gm_did,
        "hunt.completed",
        `${hunt!.title} was won by ${input.winner_did}; the delegated payout settled instantly.`
      );
    } catch (error) {
      record.status = "failed";
      this.store.claims.set(claimId, record);
      this.store.upsertClaim(record);
      if (error instanceof ModuleError) {
        badRequest(error.code, error.message);
      }
      throw error;
    }
    return record;
  }

  /**
   * Owner-signed refund after expiry. Both refund messages are verified:
   * `refund:<escrow_id>` for the escrow module and
   * `refund:<hunt_id>:<gm_did>` for the hunt module, mirroring the dual
   * claim signatures (the two modules sign different canonical strings).
   * The scheduler signs the same pair when a GM refund key is configured.
   */
  async refund(
    huntId: string,
    gmSignature: string,
    escrowGmSignature?: string,
    assetGmSignature?: string
  ): Promise<ClaimRecord | { refunded: true; hunt_id: string }> {
    const hunt = this.store.hunts.get(huntId);
    if (!hunt) notFound("HuntNotFound", `hunt ${huntId} does not exist`);
    const escrowMessage = claimMessages.refundEscrow(hunt!.escrow_id);
    const huntMessage = claimMessages.refundHunt(huntId, hunt!.gm_did);
    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    if (!verifyMessage(escrowMessage, escrowGmSignature ?? gmSignature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "escrow refund signature verification failed");
    }
    if (!verifyMessage(huntMessage, gmSignature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "hunt refund signature verification failed");
    }
    // Asset-custody hunts return the vaulted reward to the GM (fallback
    // owner path after the deadline block).
    const assetCustody = hunt!.reward_token === this.chain.config.rewardAssetId;
    const refundRef = `refund-${huntId}`;
    const vaultRefundMessage = assetMessages.vaultTransfer(
      hunt!.escrow_id,
      hunt!.gm_did,
      hunt!.reward_amount,
      refundRef
    );
    if (assetCustody && !verifyMessage(vaultRefundMessage, assetGmSignature ?? "", gmPublicKeyHex)) {
      badRequest("InvalidSignature", "reward vault refund signature verification failed");
    }
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "refund",
      escrow_id: hunt!.escrow_id,
      owner_did: hunt!.gm_did,
      signature: escrowGmSignature ?? gmSignature,
    });
    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation: "refund",
      hunt_id: huntId,
      gm_did: hunt!.gm_did,
      signature: gmSignature,
    });
    if (assetCustody) {
      // The vault reclaim is idempotent after the escrow/hunt refund: an
      // already-reclaimed vault, an empty vault (fund step failed partway),
      // or a never-opened vault all mean there is nothing left to move —
      // swallowing them keeps the refund settling instead of looping the
      // scheduler against an already-refunded escrow (NotActive).
      try {
        await this.chain.vaultRefund(
          hunt!.escrow_id,
          hunt!.gm_did,
          hunt!.reward_amount,
          refundRef,
          assetGmSignature!
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          code !== "ReplayedSubmission" &&
          code !== "InsufficientVaultFunds" &&
          code !== "VaultNotFound"
        ) {
          throw error;
        }
      }
    }
    hunt!.status = "refunded";
    this.store.upsertHunt(hunt!);
    this.store.recordEvent("hunt.refunded", "game.escrow", { hunt_id: huntId });
    this.store.notify(hunt!.gm_did, "hunt.refunded", `Hunt ${hunt!.title} refunded after expiry.`);
    return { refunded: true, hunt_id: huntId };
  }

  listClaims(): ClaimRecord[] {
    return [...this.store.claims.values()];
  }
}
