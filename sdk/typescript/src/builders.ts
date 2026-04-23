import type {
  CreateFormCommitmentReceiptArgs,
  CreateMultisigCreditGrantArgs,
  CreateSponsorshipUsageArgs,
  MultisigProof,
  ValidateBuilderCreditsPayloadArgs
} from "./types.js";
import {
  assertHttpUrl,
  assertNonEmptyString,
  assertPositiveAmount,
  assertSha256Digest
} from "./utils.js";

export function createFormCommitmentReceipt({
  formId,
  dataHash,
  encryptedFormUrl,
  commitmentReceipt
}: CreateFormCommitmentReceiptArgs) {
  assertNonEmptyString(formId, "formId");
  assertSha256Digest(dataHash, "dataHash");
  assertHttpUrl(encryptedFormUrl, "encryptedFormUrl");

  if (
    commitmentReceipt !== undefined &&
    (typeof commitmentReceipt !== "object" || commitmentReceipt === null || Array.isArray(commitmentReceipt))
  ) {
    throw new Error("commitmentReceipt must be an object when provided");
  }

  return {
    namespace: "forms.commitment",
    action: "SUBMIT_COMMITMENT_RECEIPT",
    objectId: formId,
    payload: {
      data_hash: dataHash,
      encrypted_form_url: encryptedFormUrl,
      commitment_receipt: commitmentReceipt ?? null
    }
  };
}

export function validateBuilderCreditsPayload({ action, payload }: ValidateBuilderCreditsPayloadArgs): void {
  assertNonEmptyString(action, "action");

  if (action === "MULTISIG_CREDIT_GRANT") {
    assertPositiveAmount(payload);
    if (!Array.isArray(payload.multisig_proofs) || payload.multisig_proofs.length === 0) {
      throw new Error("MULTISIG_CREDIT_GRANT requires payload.multisig_proofs");
    }

    for (const [index, proof] of payload.multisig_proofs.entries()) {
      const item = proof as MultisigProof;
      if (!item || typeof item !== "object") {
        throw new Error(`payload.multisig_proofs[${index}] must be an object`);
      }

      assertNonEmptyString(item.approver, `payload.multisig_proofs[${index}].approver`);
      assertNonEmptyString(item.public_key, `payload.multisig_proofs[${index}].public_key`);
      assertNonEmptyString(item.signature, `payload.multisig_proofs[${index}].signature`);
    }

    return;
  }

  if (action === "SPONSOR_USAGE") {
    assertPositiveAmount(payload);
    assertNonEmptyString(payload.credit_grant_id, "payload.credit_grant_id");
    assertNonEmptyString(payload.sponsorship_id, "payload.sponsorship_id");
    assertNonEmptyString(payload.sponsored_did, "payload.sponsored_did");
  }
}

export function createMultisigCreditGrant({
  builderId,
  amount,
  multisigProofs
}: CreateMultisigCreditGrantArgs) {
  assertNonEmptyString(builderId, "builderId");

  const payload = {
    amount,
    multisig_proofs: multisigProofs
  };

  validateBuilderCreditsPayload({ action: "MULTISIG_CREDIT_GRANT", payload });

  return {
    namespace: "builder.credits",
    action: "MULTISIG_CREDIT_GRANT",
    objectId: builderId,
    payload
  };
}

export function createSponsorshipUsage({
  builderId,
  amount,
  creditGrantId,
  sponsorshipId,
  sponsoredDid
}: CreateSponsorshipUsageArgs) {
  assertNonEmptyString(builderId, "builderId");

  const payload = {
    amount,
    credit_grant_id: creditGrantId,
    sponsorship_id: sponsorshipId,
    sponsored_did: sponsoredDid
  };

  validateBuilderCreditsPayload({ action: "SPONSOR_USAGE", payload });

  return {
    namespace: "builder.credits",
    action: "SPONSOR_USAGE",
    objectId: builderId,
    payload
  };
}
