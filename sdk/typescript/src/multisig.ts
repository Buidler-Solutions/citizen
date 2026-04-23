import type { CitizenSigner, EnvelopeRecord, EntryRecord, WrapEnvelopeMultiArgs } from "./types.js";
import { assertMultisigPolicy, createUuid } from "./utils.js";
import { canonicalizeJson } from "./utils.js";

function getEnvelopeSignaturePreimage(
  payload: EntryRecord,
  signatureScope: "canonical_payload_v1" | "canonical_payload_v2"
): string {
  if (signatureScope !== "canonical_payload_v1" && signatureScope !== "canonical_payload_v2") {
    throw new Error("multisig signatureScope must be canonical_payload_v1 or canonical_payload_v2");
  }

  const { signature: _signature, ...signingPayloadBase } = payload;
  const signingPayload: EntryRecord = {
    ...signingPayloadBase
  };

  if (signatureScope === "canonical_payload_v2") {
    const replayProtection = (payload.payload as { replay_protection?: { request_id?: string; expires_at?: number } })?.replay_protection;
    const requestId = replayProtection?.request_id;
    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      throw new Error("canonical_payload_v2 requires payload.replay_protection.request_id");
    }
    if (replayProtection?.expires_at !== undefined && !Number.isInteger(replayProtection.expires_at)) {
      throw new Error("payload.replay_protection.expires_at must be a unix timestamp integer");
    }

    (signingPayload.payload as Record<string, unknown>).replay_protection =
      replayProtection?.expires_at !== undefined
        ? { request_id: requestId.trim(), expires_at: replayProtection.expires_at }
        : { request_id: requestId.trim() };
  }

  return canonicalizeJson(signingPayload);
}

function listEnvelopeSigners(envelope: EnvelopeRecord): string[] {
  return [envelope.signer, ...(envelope.co_signatures ?? []).map((item) => item.signer)];
}

export async function wrapEnvelopeMulti({
  entry,
  signer,
  coSigners = [],
  multisigPolicy,
  signatureScope = "canonical_payload_v1",
  submittedAt
}: WrapEnvelopeMultiArgs): Promise<EnvelopeRecord> {
  if (!entry || typeof entry !== "object") {
    throw new Error("entry is required");
  }
  if (!signer) {
    throw new Error("signer is required");
  }
  if (!Array.isArray(coSigners)) {
    throw new Error("coSigners must be an array");
  }

  assertMultisigPolicy(multisigPolicy);
  const signingPayload = getEnvelopeSignaturePreimage(entry, signatureScope);

  const signerId = await signer.getSignerId();
  const primarySignature = await signer.sign(signingPayload);
  const coSignatures: Array<{ signer: string; signature: string }> = [];
  const seen = new Set([signerId]);

  for (const coSigner of coSigners) {
    const coSignerId = await coSigner.getSignerId();
    if (seen.has(coSignerId)) {
      throw new Error(`duplicate multisig signer: ${coSignerId}`);
    }
    const signature = await coSigner.sign(signingPayload);
    coSignatures.push({ signer: coSignerId, signature });
    seen.add(coSignerId);
  }

  return {
    envelope_id: createUuid(),
    signer: signerId,
    signature: primarySignature,
    signature_scope: signatureScope,
    co_signatures: coSignatures,
    multisig_policy: multisigPolicy,
    submitted_at: submittedAt ?? new Date().toISOString(),
    payload: entry
  };
}

export async function appendCoSignature({
  envelope,
  signer
}: {
  envelope: EnvelopeRecord;
  signer: CitizenSigner;
}): Promise<EnvelopeRecord> {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("envelope is required");
  }
  if (!signer) {
    throw new Error("signer is required");
  }

  const signatureScope = envelope.signature_scope ?? "canonical_payload_v1";
  const signingPayload = getEnvelopeSignaturePreimage(envelope.payload, signatureScope);
  const signerId = await signer.getSignerId();
  if (listEnvelopeSigners(envelope).includes(signerId)) {
    throw new Error(`signer already present in envelope: ${signerId}`);
  }

  const signature = await signer.sign(signingPayload);
  return {
    ...envelope,
    co_signatures: [...(envelope.co_signatures ?? []), { signer: signerId, signature }]
  };
}

export function finalizeEnvelope({ envelope }: { envelope: EnvelopeRecord }): EnvelopeRecord {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("envelope is required");
  }
  assertMultisigPolicy(envelope.multisig_policy);
  const threshold = envelope.multisig_policy.threshold;
  const signers = listEnvelopeSigners(envelope);

  if (new Set(signers).size !== signers.length) {
    throw new Error("envelope contains duplicate signers");
  }

  if (signers.length < threshold) {
    throw new Error(`envelope has ${signers.length} unique signatures but threshold is ${threshold}`);
  }

  if (envelope.multisig_policy.require_author_signature && !signers.includes(envelope.payload.author)) {
    throw new Error("multisig policy requires payload author to sign");
  }

  return envelope;
}
