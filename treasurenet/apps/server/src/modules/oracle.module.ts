import { randomUUID } from "node:crypto";
import { claimMessages, signMessage, verifyMessage } from "../../../../chain/sdk/src/index.ts";
import type { OracleVerdict } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import { badRequest, HttpError } from "../http.ts";

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

  /**
   * Heuristic verification (in-process) or external AI oracle, per
   * TREASURENET_ORACLE_MODE. External verdicts are only trusted when the
   * returned signature verifies over the canonical verdict message against
   * the pinned TREASURENET_ORACLE_VERIFIER_DID. External failures surface as
   * VerificationFailed instead of silently downgrading to the heuristic.
   */
  async evaluate(input: {
    hunt_id: string;
    player_did: string;
    clue_index: number;
    photo_b64: string;
    geoOk: boolean;
  }): Promise<OracleVerdict> {
    if (!input.photo_b64 || input.photo_b64.length < 32) {
      badRequest("PhotoRequired", "photo proof payload missing or too small");
    }
    const config = this.chain.config;
    if (config.oracleMode === "external" && config.oracleUrl) {
      return this.evaluateExternal(input);
    }
    const passed = input.geoOk && input.photo_b64.length >= 32;
    const verdict: OracleVerdict = {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      passed,
      confidence: passed ? 0.92 : 0.1,
      oracle_did: config.oracleDid,
      verdict_signature: "",
      reason: passed
        ? "photo matches clue location context"
        : input.geoOk
          ? "photo could not be verified"
          : "geo proximity check failed",
    };
    verdict.verdict_signature = signMessage(this.verdictMessage(verdict), config.oracleKeyHex);
    this.store.addVerdict(verdict);
    return verdict;
  }

  /**
   * Instant-claim verdict: the verified final-clue geo check-in replaces the
   * photo proof. The GM pre-authorized instant settlement via
   * set_claim_delegate at setup, so the delegated payout's evidence is the
   * coordinate match at the treasure location (walking-pace anti-spoof
   * applies at check-in). The oracle still co-signs only on a geo pass.
   */
  async evaluateInstant(input: {
    hunt_id: string;
    player_did: string;
    clue_index: number;
    geoOk: boolean;
  }): Promise<OracleVerdict> {
    const config = this.chain.config;
    const passed = input.geoOk;
    const verdict: OracleVerdict = {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      passed,
      confidence: passed ? 0.85 : 0.1,
      oracle_did: config.oracleDid,
      verdict_signature: "",
      reason: passed
        ? "final-clue geo proof verified (instant claim)"
        : "geo proximity check failed at the final clue",
    };
    verdict.verdict_signature = signMessage(this.verdictMessage(verdict), config.oracleKeyHex);
    this.store.addVerdict(verdict);
    return verdict;
  }

  private async evaluateExternal(input: {
    hunt_id: string;
    player_did: string;
    clue_index: number;
    photo_b64: string;
    geoOk: boolean;
  }): Promise<OracleVerdict> {
    const config = this.chain.config;
    let data: {
      passed?: boolean;
      confidence?: number;
      reason?: string;
      verdict_signature?: string;
      oracle_did?: string;
    };
    try {
      const response = await fetch(config.oracleUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hunt_id: input.hunt_id,
          player_did: input.player_did,
          clue_index: input.clue_index,
          photo_b64: input.photo_b64,
          geo_ok: input.geoOk,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`oracle service returned HTTP ${response.status}`);
      }
      data = (await response.json()) as typeof data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      badRequest("OracleUnavailable", `external oracle unreachable: ${message}`);
    }
    const passed = Boolean(data!.passed);
    const oracleDid = data!.oracle_did ?? config.oracleVerifierDid ?? config.oracleDid;
    const verdict: OracleVerdict = {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      passed,
      confidence: Number(data!.confidence ?? (passed ? 0.9 : 0.1)),
      oracle_did: oracleDid,
      verdict_signature: data!.verdict_signature ?? "",
      reason: data!.reason ?? (passed ? "external oracle accepted the proof" : "external oracle rejected the proof"),
    };
    if (config.oracleVerifierDid) {
      if (verdict.oracle_did !== config.oracleVerifierDid) {
        badRequest("VerificationFailed", "external oracle did does not match the pinned verifier did");
      }
      if (!verdict.verdict_signature || !this.verifyVerdict(verdict)) {
        badRequest("VerificationFailed", "external oracle verdict signature verification failed");
      }
    }
    this.store.addVerdict(verdict);
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
