import { randomUUID } from "node:crypto";
import { verifyMessage } from "../../../../chain/sdk/src/index.ts";
import type { Store, Session } from "../store.ts";
import { unauthorized, badRequest } from "../http.ts";

/**
 * Auth module — challenge-response login. The player's Ed25519 key never
 * leaves the device: the server issues a nonce, the client signs
 * `treasurenet-login:<nonce>`, the server verifies against the DID's
 * public key (extracted from the did:key:ed25519:<pubhex> DID).
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  challenge(did: string) {
    if (!did.startsWith("did:key:ed25519:")) {
      badRequest("InvalidDid", "expected did:key:ed25519:<public_key_hex>");
    }
    const nonce = randomUUID();
    const challenge = {
      nonce,
      issued_at: Date.now(),
      expires_at: Date.now() + CHALLENGE_TTL_MS,
      message: `treasurenet-login:${nonce}`,
    };
    this.store.challenges.set(did, challenge);
    return { did, ...challenge };
  }

  verify(did: string, signature: string): Session {
    const challenge = this.store.challenges.get(did);
    if (!challenge || challenge.expires_at < Date.now()) {
      unauthorized("ChallengeExpired", "request a new auth challenge");
    }
    const publicKeyHex = did.split(":").pop() ?? "";
    if (!verifyMessage(challenge.message, signature, publicKeyHex)) {
      unauthorized("InvalidSignature", "challenge-response signature verification failed");
    }
    this.store.challenges.delete(did);
    const session: Session = {
      token: randomUUID(),
      did,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.store.sessions.set(session.token, session);
    return session;
  }

  session(token: string | undefined): Session {
    if (!token) unauthorized("MissingToken", "Authorization: Bearer <token> required");
    const session = this.store.sessions.get(token!);
    if (!session || session.expiresAt < Date.now()) {
      unauthorized("InvalidToken", "session expired or unknown");
    }
    return session!;
  }

  bearer(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
    const header = request.headers["authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
  }
}
