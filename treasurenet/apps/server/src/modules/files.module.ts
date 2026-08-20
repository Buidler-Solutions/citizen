import { createHash, randomUUID } from "node:crypto";
import {
  buildSignedEntry,
  canonicalJson,
  verifyMessage,
} from "../../../../chain/sdk/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import type { ConsentModule } from "./consent.module.ts";
import type { GameModule } from "./game.module.ts";
import { badRequest, HttpError, notFound } from "../http.ts";

/**
 * Encrypted clue file store (gaps 3 + 12).
 *
 * Clue content is encrypted client-side in the GM console (AES-GCM-256,
 * per-clue key) before it ever reaches this backend; the chain and object
 * store only ever see ciphertext plus commitments. This module mirrors the
 * citizen node's off-chain encrypted file API (intent -> upload -> commit ->
 * consent-gated read -> revocation) in mock mode and drives the real node
 * endpoints in node mode, so both surfaces behave identically.
 *
 * Key transport: the per-clue AES key travels deterministically wrapped
 * (manifest-bound wrap, see MIGRATION_NOTES) through the same consent-gated
 * read channel. That protects plaintext at rest everywhere (server store,
 * object store, chain) but is not end-to-end against a fully malicious
 * backend; true E2E needs per-player X25519 key registration (follow-up).
 */

const CONSENT_TTL_SECS = 90 * 86_400;
const POLICY_REF = "treasurenet:clue-delivery:v1";

export interface ClueFileManifest {
  manifest_id: string;
  hunt_id: string;
  clue_index: number;
  object_id: string;
  namespace: string;
  author_did: string;
  mime_type: string;
  file_size_bytes: number;
  encryption_mode: string;
  file_ref: string;
  ciphertext_hash: string;
  payload_commitment: string;
  iv_b64: string;
  key_wrapped_b64?: string;
  committed_at: number;
  readers: string[];
  intent_id?: string;
}

function forbidden(code: string, message: string): never {
  throw new HttpError(403, code, message);
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export class FilesModule {
  private readonly chain: ChainModule;
  private readonly store: Store;
  private readonly consent: ConsentModule;
  private readonly game: GameModule;

  constructor(chain: ChainModule, store: Store, consent: ConsentModule, game: GameModule) {
    this.chain = chain;
    this.store = store;
    this.consent = consent;
    this.game = game;
  }

  private clueKey(huntId: string, clueIndex: number): string {
    return `${huntId}:${clueIndex}`;
  }

  /** GM-side upload of a client-side encrypted clue. */
  async uploadClue(input: {
    hunt_id: string;
    clue_index: number;
    ciphertext_b64: string;
    iv_b64: string;
    gm_did: string;
    gm_signature: string;
  }): Promise<{ manifest_id: string; object_id: string }> {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    const clue = hunt!.clues.find((c) => c.index === input.clue_index);
    if (!clue) badRequest("ClueNotFound", `clue ${input.clue_index} does not exist on this hunt`);
    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    const message = `clue-upload:${input.hunt_id}:${input.clue_index}`;
    if (!verifyMessage(message, input.gm_signature ?? "", gmPublicKeyHex)) {
      badRequest("InvalidSignature", "game master clue-upload signature verification failed");
    }
    const ciphertext = Buffer.from(input.ciphertext_b64 ?? "", "base64");
    if (ciphertext.length === 0) {
      badRequest("MissingFields", "ciphertext_b64 is required");
    }

    const objectId = `${input.hunt_id}#${input.clue_index}`;
    const ciphertextHash = `sha256:${sha256Hex(ciphertext)}`;
    const payloadCommitment = `sha256:${sha256Hex(
      `${input.hunt_id}\n${input.clue_index}\n${ciphertextHash}`
    )}`;
    const now = Math.floor(Date.now() / 1000);

    let manifestId: string;
    let fileRef: string;
    let manifestIntentId: string | undefined;

    if (this.chain.nodeClient) {
      const client = this.chain.nodeClient;
      const consentEntry = buildSignedEntry(
        {
          namespace: "consent.receipt",
          action: "CONSENT_GRANTED",
          object_id: objectId,
          payload: {
            data_hash: ciphertextHash,
            policy_ref: POLICY_REF,
            purposes: ["clue-delivery"],
            granted_at: now,
            expires_at: now + CONSENT_TTL_SECS,
          },
          author: this.chain.config.serviceDid,
        },
        this.chain.config.serviceKeyHex
      );
      const consentSubmit = await client.submitEntry(consentEntry);
      if (consentSubmit.status >= 300) {
        throw new Error(`on-chain consent receipt rejected: HTTP ${consentSubmit.status}`);
      }

      const intent = await client.createFileIntent({
        namespace: this.chain.config.filesNamespace,
        object_id: objectId,
        author_did: this.chain.config.serviceDid,
        mime_type: "application/octet-stream",
        file_size_bytes: ciphertext.length,
        encryption_mode: "aes-gcm-256",
        consent_receipt: {
          subject_did: objectId,
          data_hash: ciphertextHash,
          policy_ref: POLICY_REF,
          granted_at: now,
          expires_at: now + CONSENT_TTL_SECS,
          authorized_readers: [],
        },
      });
      await client.uploadCiphertext(intent.upload.upload_url, new Uint8Array(ciphertext));

      const manifest = {
        namespace: this.chain.config.filesNamespace,
        object_id: objectId,
        author_did: this.chain.config.serviceDid,
        mime_type: "application/octet-stream",
        file_size_bytes: ciphertext.length,
        encryption_mode: "aes-gcm-256",
        file_ref: intent.upload.object_ref,
        ciphertext_hash: ciphertextHash,
        payload_commitment: payloadCommitment,
      };
      manifestId = `sha256:${sha256Hex(canonicalJson(manifest))}`;
      fileRef = intent.upload.object_ref;
      manifestIntentId = intent.intent_id;

      const envelopePayload = buildSignedEntry(
        {
          namespace: this.chain.config.filesNamespace,
          action: "ENCRYPTED_FILE_COMMIT",
          object_id: objectId,
          payload: { manifest_id: manifestId, hunt_id: input.hunt_id, clue_index: input.clue_index },
          author: this.chain.config.serviceDid,
        },
        this.chain.config.serviceKeyHex
      );
      await client.commitFile(
        {
          intent_id: intent.intent_id,
          manifest,
          envelope: {
            envelope_id: randomUUID(),
            signer: envelopePayload.author,
            signature: envelopePayload.signature,
            signature_scope: "canonical_payload_v1",
            co_signatures: [],
            submitted_at: new Date().toISOString(),
            payload: envelopePayload,
          },
        },
        `clue-${manifestId}`
      );
    } else {
      manifestId = `sha256:${sha256Hex(
        canonicalJson({
          namespace: this.chain.config.filesNamespace,
          object_id: objectId,
          author_did: this.chain.config.serviceDid,
          mime_type: "application/octet-stream",
          file_size_bytes: ciphertext.length,
          encryption_mode: "aes-gcm-256",
          file_ref: `blob://local/${this.chain.config.filesNamespace}/${encodeURIComponent(objectId)}`,
          ciphertext_hash: ciphertextHash,
          payload_commitment: payloadCommitment,
        })
      )}`;
      fileRef = `blob://local/${this.chain.config.filesNamespace}/${encodeURIComponent(objectId)}`;
    }

    const manifestRecord: ClueFileManifest = {
      manifest_id: manifestId,
      hunt_id: input.hunt_id,
      clue_index: input.clue_index,
      object_id: objectId,
      namespace: this.chain.config.filesNamespace,
      author_did: this.chain.config.serviceDid,
      mime_type: "application/octet-stream",
      file_size_bytes: ciphertext.length,
      encryption_mode: "aes-gcm-256",
      file_ref: fileRef,
      ciphertext_hash: ciphertextHash,
      payload_commitment: payloadCommitment,
      iv_b64: input.iv_b64 ?? "",
      committed_at: now,
      readers: [],
      intent_id: manifestIntentId,
    };
    this.store.fileManifests.set(this.clueKey(input.hunt_id, input.clue_index), manifestRecord);
    this.store.fileBlobs.set(manifestId, input.ciphertext_b64!);
    this.store.recordEvent("clue.uploaded", this.chain.config.filesNamespace, {
      hunt_id: input.hunt_id,
      clue_index: input.clue_index,
      manifest_id: manifestId,
      ciphertext_hash: ciphertextHash,
    });
    return { manifest_id: manifestId, object_id: objectId };
  }

  /** Attach the transport-wrapped clue key after the manifest id is known. */
  attachKey(input: {
    hunt_id: string;
    clue_index: number;
    key_wrapped_b64: string;
    gm_signature: string;
  }): { ok: true } {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    const manifest = this.store.fileManifests.get(this.clueKey(input.hunt_id, input.clue_index));
    if (!manifest) notFound("ManifestNotFound", "upload the encrypted clue first");
    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    if (
      !verifyMessage(
        `clue-key:${manifest.manifest_id}`,
        input.gm_signature ?? "",
        gmPublicKeyHex
      )
    ) {
      badRequest("InvalidSignature", "game master clue-key signature verification failed");
    }
    manifest.key_wrapped_b64 = input.key_wrapped_b64;
    this.store.recordEvent("clue.key_attached", manifest.namespace, {
      hunt_id: input.hunt_id,
      clue_index: input.clue_index,
      manifest_id: manifest.manifest_id,
    });
    return { ok: true };
  }

  /** Player-side gated read: consent + unlocked clue + not revoked. */
  async readClue(input: {
    hunt_id: string;
    clue_index: number;
    player_did: string;
  }): Promise<{
    manifest_id: string;
    ciphertext_b64: string;
    iv_b64: string;
    key_wrapped_b64?: string;
    ciphertext_hash: string;
  }> {
    const manifest = this.store.fileManifests.get(this.clueKey(input.hunt_id, input.clue_index));
    if (!manifest) notFound("ManifestNotFound", "no encrypted clue uploaded for this clue");
    this.consent.requireValid(input.player_did, "location");
    if (!this.game.hasUnlocked(input.hunt_id, input.player_did, input.clue_index)) {
      this.store.recordEvent("clue.read_denied_locked", manifest.namespace, {
        hunt_id: input.hunt_id,
        clue_index: input.clue_index,
        reader_did: input.player_did,
        manifest_id: manifest.manifest_id,
      });
      forbidden("ClueLocked", "check in at the clue location before reading its content");
    }
    if (this.store.fileRevocations.has(`${manifest.manifest_id}:${input.player_did}`)) {
      this.store.recordEvent("clue.read_denied_revoked", manifest.namespace, {
        hunt_id: input.hunt_id,
        clue_index: input.clue_index,
        reader_did: input.player_did,
        manifest_id: manifest.manifest_id,
      });
      forbidden("ReaderRevoked", "clue read access was revoked for this reader");
    }

    let ciphertextB64 = this.store.fileBlobs.get(manifest.manifest_id);
    if (this.chain.nodeClient) {
      const client = this.chain.nodeClient;
      const now = Math.floor(Date.now() / 1000);
      await client.readFile({
        manifest_id: manifest.manifest_id,
        reader_did: input.player_did,
        consent_receipt: {
          subject_did: manifest.object_id,
          data_hash: manifest.ciphertext_hash,
          policy_ref: POLICY_REF,
          granted_at: manifest.committed_at,
          expires_at: manifest.committed_at + CONSENT_TTL_SECS,
          authorized_readers: [],
        },
      });
      const downloadPath = `/api/v1/files/local/${encodeURIComponent(
        manifest.namespace
      )}/${encodeURIComponent(manifest.object_id)}/${manifest.intent_id}`;
      const download = await client.downloadCiphertext(downloadPath);
      ciphertextB64 = download.ciphertext_b64;
    }
    if (!ciphertextB64) notFound("CiphertextMissing", "ciphertext not found for manifest");

    if (!manifest.readers.includes(input.player_did)) {
      manifest.readers.push(input.player_did);
    }
    this.store.recordEvent("clue.read", manifest.namespace, {
      hunt_id: input.hunt_id,
      clue_index: input.clue_index,
      reader_did: input.player_did,
      manifest_id: manifest.manifest_id,
    });
    return {
      manifest_id: manifest.manifest_id,
      ciphertext_b64: ciphertextB64!,
      iv_b64: manifest.iv_b64,
      key_wrapped_b64: manifest.key_wrapped_b64,
      ciphertext_hash: manifest.ciphertext_hash,
    };
  }

  /** GM-side reader revocation (cheat detection path). */
  async revokeReader(input: {
    hunt_id: string;
    clue_index: number;
    reader_did: string;
    gm_signature: string;
  }): Promise<{ revoked: true }> {
    const hunt = this.store.hunts.get(input.hunt_id);
    if (!hunt) notFound("HuntNotFound", `hunt ${input.hunt_id} does not exist`);
    const manifest = this.store.fileManifests.get(this.clueKey(input.hunt_id, input.clue_index));
    if (!manifest) notFound("ManifestNotFound", "no encrypted clue uploaded for this clue");
    const gmPublicKeyHex = hunt!.gm_did.split(":").pop() ?? "";
    const message = `clue-revoke:${input.hunt_id}:${input.clue_index}:${input.reader_did}`;
    if (!verifyMessage(message, input.gm_signature ?? "", gmPublicKeyHex)) {
      badRequest("InvalidSignature", "game master revoke signature verification failed");
    }

    if (this.chain.nodeClient) {
      const envelopePayload = buildSignedEntry(
        {
          namespace: this.chain.config.filesNamespace,
          action: "ENCRYPTED_FILE_REVOKE",
          object_id: manifest.object_id,
          payload: {
            manifest_id: manifest.manifest_id,
            reader_did: input.reader_did,
            hunt_id: input.hunt_id,
            clue_index: input.clue_index,
          },
          author: this.chain.config.serviceDid,
        },
        this.chain.config.serviceKeyHex
      );
      await this.chain.nodeClient.revokeFileReader({
        manifest_id: manifest.manifest_id,
        reader_did: input.reader_did,
        envelope: {
          envelope_id: randomUUID(),
          signer: envelopePayload.author,
          signature: envelopePayload.signature,
          signature_scope: "canonical_payload_v1",
          co_signatures: [],
          submitted_at: new Date().toISOString(),
          payload: envelopePayload,
        },
      });
    }
    this.store.fileRevocations.add(`${manifest.manifest_id}:${input.reader_did}`);
    manifest.readers = manifest.readers.filter((did) => did !== input.reader_did);
    this.store.recordEvent("clue.revoked", manifest.namespace, {
      hunt_id: input.hunt_id,
      clue_index: input.clue_index,
      reader_did: input.reader_did,
      manifest_id: manifest.manifest_id,
    });
    return { revoked: true };
  }

  /** Node-mode: merge citizen node file-access alerts into the admin feed. */
  async nodeAlerts(): Promise<Array<Record<string, unknown>>> {
    if (!this.chain.nodeClient) return [];
    try {
      return await this.chain.nodeClient.fileAlerts();
    } catch {
      return [];
    }
  }
}
