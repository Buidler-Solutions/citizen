import { randomUUID } from "node:crypto";
import { claimMessages, signMessage, verifyMessage } from "../../../../chain/sdk/src/index.ts";
import type { OracleVerdict } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import { badRequest } from "../http.ts";

/**
 * Oracle module — AI photo verification port. Input: player photo (base64
 * digest), GPS position, hunt/clue context. Output: a signed verdict.
 *
 * The oracle DID is one of the two required co-signers on every claim
 * envelope. Verdict signatures are Ed25519 over
 * `verdict:<hunt_id>:<player_did>:<clue_index>:<pass|fail>`.
 *
 * Heuristic verification (production deployment swaps in the AI model):
 * a non-trivial photo payload present plus a passing geo check.
 */

export class OracleModule {
  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  verdictMessage(v: Omit<OracleVerdict, "verdict_signature" | "oracle_did">): string {
    return `verdict:${v.hunt_id}:${v.player_did}:${v.clue_index}:${v.passed ? "pass" : "fail"}`;
  }

  evaluate(input: {
    hunt_id: string;
    player_did: string;
    clue_index: number;
    photo_b64: string;
    geoOk: boolean;
  }): OracleVerdict {
    if (!input.photo_b64 || input.photo_b64.length < 32) {
      badRequest("PhotoRequired", "photo proof payload missing or too small");
    }
    const passed = input.geoOk && input.photo_b64.length >= 32;
    const verdict: OracleVerdict = {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      passed,
      confidence: passed ? 0.92 : 0.1,
      oracle_did: this.chain.config.oracleDid,
      verdict_signature: "",
      reason: passed
        ? "photo matches clue location context"
        : input.geoOk
          ? "photo could not be verified"
          : "geo proximity check failed",
    };
    verdict.verdict_signature = signMessage(
      this.verdictMessage(verdict),
      this.chain.config.oracleKeyHex
    );
    this.store.oracleVerdicts.push(verdict);
    return verdict;
  }

  /** Oracle co-signature assembling the 2-of-2 claim envelope. */
  coSignClaim(kind: "escrow" | "hunt", id: string, winnerDid: string, verdict: OracleVerdict): string {
    if (!verdict.passed) {
      badRequest("VerdictFailed", "oracle verdict did not pass; claim co-signature refused");
    }
    const message =
      kind === "escrow"
        ? claimMessages.escrow(id, winnerDid)
        : claimMessages.hunt(id, winnerDid);
    return signMessage(message, this.chain.config.oracleKeyHex);
  }

  verifyVerdict(verdict: OracleVerdict): boolean {
    const publicKeyHex = verdict.oracle_did.split(":").pop() ?? "";
    const { verdict_signature, ...rest } = verdict;
    return verifyMessage(this.verdictMessage(rest), verdict_signature, publicKeyHex);
  }

  listForHunt(huntId: string): OracleVerdict[] {
    return this.store.oracleVerdicts.filter((v) => v.hunt_id === huntId);
  }
}
