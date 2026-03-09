export type BuilderCreditDraftInput = {
  authorDid: string;
  creditGrantId: string;
  sponsorBuilderId: string;
  sponsoredDid: string;
  sponsorshipId: string;
  usageUnits: string;
  grantUnits: string;
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
  if (!isPositiveInteger(input.usageUnits)) {
    errors.push('usage_units must be a positive integer.');
  }

  const envelope = {
    namespace: 'builder.credits',
    action: 'SPONSOR_USAGE',
    author: input.authorDid,
    payload: {
      credit_grant_id: input.creditGrantId,
      sponsor_builder_id: input.sponsorBuilderId || input.authorDid,
      sponsored_did: input.sponsoredDid,
      sponsorship_id: input.sponsorshipId,
      usage_units: Number(input.usageUnits),
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
  if (!isPositiveInteger(input.grantUnits)) {
    errors.push('grant_units must be a positive integer.');
  }
  if (!isPositiveInteger(input.multisigThreshold)) {
    errors.push('multisig_threshold must be a positive integer.');
  }

  const envelope = {
    namespace: 'builder.credits',
    action: 'MULTISIG_CREDIT_GRANT',
    author: input.authorDid,
    payload: {
      credit_grant_id: input.creditGrantId,
      sponsor_builder_id: input.sponsorBuilderId || input.authorDid,
      grant_scope: input.grantScope,
      grant_units: Number(input.grantUnits),
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
      valid: Boolean((input.sponsorBuilderId || input.authorDid).trim()),
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
      label: 'SPONSOR_USAGE usage_units is a positive integer',
      valid: isPositiveInteger(input.usageUnits),
    },
    {
      label: 'MULTISIG_CREDIT_GRANT grant_units is a positive integer',
      valid: isPositiveInteger(input.grantUnits),
    },
    {
      label: 'MULTISIG_CREDIT_GRANT multisig_threshold is a positive integer',
      valid: isPositiveInteger(input.multisigThreshold),
    },
  ];
}
