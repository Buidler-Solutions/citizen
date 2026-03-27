export type BuilderCreditDraftInput = {
  authorDid: string;
  creditGrantId: string;
  sponsorBuilderId: string;
  sponsoredDid: string;
  sponsorshipId: string;
  sponsorUsageAmount: string;
  grantAmount: string;
  multisigThreshold: string;
  grantScope: string;
};

export type BuilderCreditDraftResult = {
  ok: boolean;
  errors: string[];
  payloadJson: string;
};

export type BuilderCreditChecklistItem = {
  label: string;
  valid: boolean;
};

function isPositiveInteger(value: string) {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  return Number(value) > 0;
}

function resolveBuilderDid(input: BuilderCreditDraftInput) {
  return (input.sponsorBuilderId || input.authorDid).trim();
}

export function createSponsorUsageDraft(input: BuilderCreditDraftInput): BuilderCreditDraftResult {
  const errors: string[] = [];
  if (!input.authorDid.trim()) {
    errors.push('Author DID is required.');
  }
  if (!input.creditGrantId.trim()) {
    errors.push('credit_grant_id is required.');
  }
  if (!input.sponsoredDid.trim()) {
    errors.push('sponsored_did is required.');
  }
  if (!input.sponsorshipId.trim()) {
    errors.push('sponsorship_id is required.');
  }
  if (!isPositiveInteger(input.sponsorUsageAmount)) {
    errors.push('payload.amount must be a positive integer for SPONSOR_USAGE.');
  }

  const builderDid = resolveBuilderDid(input);
  const envelope = {
    namespace: 'builder.credits',
    action: 'SPONSOR_USAGE',
    object_id: builderDid,
    author: builderDid,
    payload: {
      credit_grant_id: input.creditGrantId,
      sponsor_builder_id: builderDid,
      sponsored_did: input.sponsoredDid,
      sponsorship_id: input.sponsorshipId,
      amount: Number(input.sponsorUsageAmount),
    },
  };

  return {
    ok: errors.length === 0,
    errors,
    payloadJson: JSON.stringify(envelope, null, 2),
  };
}

export function createMultisigGrantDraft(input: BuilderCreditDraftInput): BuilderCreditDraftResult {
  const errors: string[] = [];
  if (!input.authorDid.trim()) {
    errors.push('Author DID is required.');
  }
  if (!input.creditGrantId.trim()) {
    errors.push('credit_grant_id is required.');
  }
  if (!input.grantScope.trim()) {
    errors.push('grant_scope is required.');
  }
  if (!isPositiveInteger(input.grantAmount)) {
    errors.push('payload.amount must be a positive integer for MULTISIG_CREDIT_GRANT.');
  }
  if (!isPositiveInteger(input.multisigThreshold)) {
    errors.push('multisig_threshold must be a positive integer.');
  }

  const builderDid = resolveBuilderDid(input);
  const envelope = {
    namespace: 'builder.credits',
    action: 'MULTISIG_CREDIT_GRANT',
    object_id: builderDid,
    author: builderDid,
    payload: {
      credit_grant_id: input.creditGrantId,
      sponsor_builder_id: builderDid,
      grant_scope: input.grantScope,
      amount: Number(input.grantAmount),
      multisig_threshold: Number(input.multisigThreshold),
    },
  };

  return {
    ok: errors.length === 0,
    errors,
    payloadJson: JSON.stringify(envelope, null, 2),
  };
}

export function buildStrictBuilderCreditChecklist(input: BuilderCreditDraftInput): BuilderCreditChecklistItem[] {
  return [
    {
      label: 'payload.credit_grant_id is provided',
      valid: Boolean(input.creditGrantId.trim()),
    },
    {
      label: 'payload.sponsor_builder_id uses explicit DID or signer fallback',
      valid: Boolean(resolveBuilderDid(input)),
    },
    {
      label: 'object_id and author resolve to builder DID',
      valid: Boolean(resolveBuilderDid(input)),
    },
    {
      label: 'SPONSOR_USAGE includes payload.sponsored_did',
      valid: Boolean(input.sponsoredDid.trim()),
    },
    {
      label: 'SPONSOR_USAGE includes payload.sponsorship_id',
      valid: Boolean(input.sponsorshipId.trim()),
    },
    {
      label: 'SPONSOR_USAGE payload.amount is a positive integer',
      valid: isPositiveInteger(input.sponsorUsageAmount),
    },
    {
      label: 'MULTISIG_CREDIT_GRANT payload.amount is a positive integer',
      valid: isPositiveInteger(input.grantAmount),
    },
    {
      label: 'MULTISIG_CREDIT_GRANT multisig_threshold is a positive integer',
      valid: isPositiveInteger(input.multisigThreshold),
    },
  ];
}
