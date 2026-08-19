import { randomUUID } from "node:crypto";
import { claimMessages, verifyMessage, ModuleError } from "../../../../chain/sdk/src/index.ts";
import type { ClaimRecord } from "../../../../packages/shared/src/index.ts";
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
   * Full claim flow: geo + photo oracle verdict, 2-of-2 multisig envelope,
   * escrow + hunt state transitions, payout receipt.
   */
  async claim(input: {
    hunt_id: string;
    player_did: string;
    gm_signature: string;
    escrow_gm_signature: string;
    photo_b64: string;
    latitude: number;
    longitude: number;
    geo: { checkProximity: (a: number, b: number, c: number, d: number, r: number) => { withinRadius: boolean } };
  }): Promise<ClaimRecord> {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    const finalClue = hunt!.clues[hunt!.clues.length - 1];
    if (!this.game.hasUnlocked(input.hunt_id, input.player_did, finalClue.index)) {
      badRequest("ClueLocked", "final clue not unlocked; complete the clue chain first");
    }
    if (hunt!.status !== "active") {
      badRequest("HuntNotActive", `hunt ${input.hunt_id} is ${hunt!.status}`);
    }

    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    const huntClaimMessage = claimMessages.hunt(input.hunt_id, input.player_did);
    const escrowClaimMessage = claimMessages.escrow(hunt!.escrow_id, input.player_did);
    if (!verifyMessage(huntClaimMessage, input.gm_signature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "game master claim signature verification failed");
    }
    if (!verifyMessage(escrowClaimMessage, input.escrow_gm_signature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "escrow claim signature verification failed");
    }

    const geoCheck = input.geo.checkProximity(
      input.latitude,
      input.longitude,
      finalClue.latitude,
      finalClue.longitude,
      finalClue.radius_meters
    );
    const verdict = this.oracle.evaluate({
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: finalClue.index,
      photo_b64: input.photo_b64,
      geoOk: geoCheck.withinRadius,
    });
    if (!verdict.passed) {
      badRequest("VerificationFailed", verdict.reason);
    }

    const oracleHuntSig = this.oracle.coSignClaim("hunt", input.hunt_id, input.player_did, verdict);
    const oracleEscrowSig = this.oracle.coSignClaim("escrow", hunt!.escrow_id, input.player_did, verdict);

    const claimId = randomUUID();
    const record: ClaimRecord = {
      claim_id: claimId,
      hunt_id: input.hunt_id,
      escrow_id: hunt!.escrow_id,
      winner_did: input.player_did,
      reward_amount: hunt!.reward_amount,
      reward_token: hunt!.reward_token,
      gm_signature: input.gm_signature,
      oracle_signature: oracleHuntSig,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    try {
      const huntResult = await this.chain.adapter.execute("treasure-hunt.v1", {
        operation: "claim",
        hunt_id: input.hunt_id,
        winner_did: input.player_did,
        cosigner_dids: `${hunt!.gm_did},${this.chain.config.oracleDid}`,
        signatures: `${input.gm_signature},${oracleHuntSig}`,
      });
      const escrowResult = await this.chain.adapter.execute("treasure-escrow.v1", {
        operation: "claim",
        escrow_id: hunt!.escrow_id,
        winner_did: input.player_did,
        cosigner_dids: `${hunt!.gm_did},${this.chain.config.oracleDid}`,
        signatures: `${input.escrow_gm_signature},${oracleEscrowSig}`,
      });

      const receiptId = (escrowResult.meta as { receipt_id?: string }).receipt_id
        ?? (huntResult.meta as { receipt_id?: string }).receipt_id;
      record.status = "confirmed";
      record.receipt_id = receiptId;
      record.block_height =
        (escrowResult.output.receipt_block as number | undefined) ??
        (huntResult.output.receipt_block as number | undefined);

      hunt!.status = "completed";
      hunt!.winner_did = input.player_did;
      hunt!.receipt_id = receiptId;
      this.store.claims.set(claimId, record);
      this.store.analytics.claims_confirmed += 1;
      this.store.analytics.rewards_paid += hunt!.reward_amount;
      this.store.recordEvent("claim.confirmed", "game.claims", {
        claim_id: claimId,
        hunt_id: input.hunt_id,
        winner_did: input.player_did,
        receipt_id: receiptId,
      });
      this.store.notify(
        input.player_did,
        "claim.confirmed",
        `Reward of ${hunt!.reward_amount} ${hunt!.reward_token} paid. Receipt ${receiptId ?? "pending"}.`
      );
    } catch (error) {
      record.status = "failed";
      this.store.claims.set(claimId, record);
      if (error instanceof ModuleError) {
        badRequest(error.code, error.message);
      }
      throw error;
    }
    return record;
  }

  /** Owner-signed refund after expiry (scheduler or manual). */
  async refund(huntId: string, gmSignature: string): Promise<ClaimRecord | { refunded: true; hunt_id: string }> {
    const hunt = this.store.hunts.get(huntId);
    if (!hunt) notFound("HuntNotFound", `hunt ${huntId} does not exist`);
    const escrowMessage = claimMessages.refundEscrow(hunt!.escrow_id);
    const huntMessage = claimMessages.refundHunt(huntId, hunt!.gm_did);
    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    if (!verifyMessage(escrowMessage, gmSignature, gmPublicKeyHex)) {
      badRequest("InvalidSignature", "refund signature verification failed");
    }
    await this.chain.adapter.execute("treasure-escrow.v1", {
      operation: "refund",
      escrow_id: hunt!.escrow_id,
      owner_did: hunt!.gm_did,
      signature: gmSignature,
    });
    await this.chain.adapter.execute("treasure-hunt.v1", {
      operation: "refund",
      hunt_id: huntId,
      gm_did: hunt!.gm_did,
      signature: gmSignature,
    });
    hunt!.status = "refunded";
    this.store.recordEvent("hunt.refunded", "game.escrow", { hunt_id: huntId });
    return { refunded: true, hunt_id: huntId };
  }

  listClaims(): ClaimRecord[] {
    return [...this.store.claims.values()];
  }
}
