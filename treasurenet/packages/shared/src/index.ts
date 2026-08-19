/**
 * Shared domain types for TreasureNet Citizen Edition, mirrored from the
 * original Stellar-based TreasureNet packages/shared, with Citizen chain
 * identifiers (DIDs, module ids, receipt ids) replacing Stellar keys.
 */

export type Role = "player" | "gamemaster" | "auditor";

export const ROLES: Role[] = ["player", "gamemaster", "auditor"];

export interface WalletIdentity {
  did: string;
  created_at: string;
  auth_challenge?: AuthChallenge;
}

export interface AuthChallenge {
  nonce: string;
  issued_at: number;
  expires_at: number;
  message: string;
}

export interface HuntClue {
  index: number;
  /** Encrypted file store manifest id for the clue payload. */
  manifest_id: string;
  /** GPS coordinates of the clue checkpoint (never stored in plaintext on-chain). */
  latitude: number;
  longitude: number;
  radius_meters: number;
}

export interface Hunt {
  hunt_id: string;
  gm_did: string;
  title: string;
  status:
    | "created"
    | "funded"
    | "active"
    | "paused"
    | "completed"
    | "expired"
    | "refunded"
    | "cancelled";
  reward_amount: number;
  reward_token: string;
  escrow_id: string;
  expires_at: string;
  /** Chain link: block deadline derived from expires_at by the chain adapter. */
  expires_block: number;
  clues: HuntClue[];
  created_at: string;
  winner_did?: string;
  receipt_id?: string;
}

export interface GeoProof {
  hunt_id: string;
  player_did: string;
  clue_index: number;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  captured_at: string;
}

export interface OracleVerdict {
  hunt_id: string;
  player_did: string;
  clue_index: number;
  passed: boolean;
  confidence: number;
  oracle_did: string;
  verdict_signature: string;
  reason: string;
}

export interface ClaimRecord {
  claim_id: string;
  hunt_id: string;
  escrow_id: string;
  winner_did: string;
  reward_amount: number;
  reward_token: string;
  gm_signature: string;
  oracle_signature: string;
  receipt_id?: string;
  block_height?: number;
  status: "pending" | "confirmed" | "failed";
  created_at: string;
}

/**
 * Player-initiated claim request (mobile app flow): the player submits photo
 * proof from the final clue location; the Game Master reviews and approves it
 * from the web console, producing the two GM claim signatures. The request
 * carries the photo and geo proof so the approving GM never needs the
 * player's session; the signatures remain bound to the player's DID.
 */
export interface ClaimRequest {
  request_id: string;
  hunt_id: string;
  escrow_id: string;
  player_did: string;
  photo_b64: string;
  latitude: number;
  longitude: number;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

export interface ConsentReceipt {
  subject_did: string;
  purposes: ("location" | "photo")[];
  granted_at: string;
  expires_at: string;
  receipt_id: string;
}

export interface LeaderboardEntry {
  player_did: string;
  hunts_won: number;
  total_reward: number;
  clues_solved: number;
}

export interface ApiError {
  error: string;
  code: string;
  detail?: unknown;
}

export const BLOCKS_PER_HOUR = 3600;

/** Convert a wall-clock expiry timestamp to an approximate chain block deadline. */
export function expiryToBlock(expiresAt: string, currentBlock: number, now = Date.now()): number {
  const target = new Date(expiresAt).getTime();
  const hoursRemaining = Math.max((target - now) / 3_600_000, 0);
  return currentBlock + Math.ceil(hoursRemaining * BLOCKS_PER_HOUR);
}
