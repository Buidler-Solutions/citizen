import { describe, expect, it } from 'vitest';
import {
  buildStrictBuilderCreditChecklist,
  createMultisigGrantDraft,
  createSponsorUsageDraft,
} from './builderCreditDraft';

describe('createSponsorUsageDraft', () => {
  it('builds strict sponsor usage envelope', () => {
    const result = createSponsorUsageDraft({
      authorDid: 'did:ledger:builder:alpha',
      creditGrantId: 'grant:builder:alpha',
      sponsorBuilderId: 'did:ledger:builder:alpha',
      sponsoredDid: 'did:ledger:app:citizen-blog',
      sponsorshipId: 'sponsor-usage-001',
      sponsorUsageAmount: '2',
      grantAmount: '100',
      multisigThreshold: '2',
      grantScope: 'content.article',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.payloadJson).toContain('"namespace": "builder.credits"');
    expect(result.payloadJson).toContain('"action": "SPONSOR_USAGE"');
    expect(result.payloadJson).toContain('"credit_grant_id": "grant:builder:alpha"');
    expect(result.payloadJson).toContain('"object_id": "did:ledger:builder:alpha"');
    expect(result.payloadJson).toContain('"amount": 2');
  });

  it('returns validation errors for incomplete draft input', () => {
    const result = createSponsorUsageDraft({
      authorDid: '',
      creditGrantId: '',
      sponsorBuilderId: '',
      sponsoredDid: '',
      sponsorshipId: '',
      sponsorUsageAmount: '0',
      grantAmount: '0',
      multisigThreshold: '0',
      grantScope: '',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Author DID is required.');
    expect(result.errors).toContain('credit_grant_id is required.');
    expect(result.errors).toContain('payload.amount must be a positive integer for SPONSOR_USAGE.');
  });
});


describe('createMultisigGrantDraft', () => {
  it('builds strict multisig grant envelope', () => {
    const result = createMultisigGrantDraft({
      authorDid: 'did:ledger:builder:alpha',
      creditGrantId: 'grant:builder:alpha',
      sponsorBuilderId: 'did:ledger:builder:alpha',
      sponsoredDid: 'did:ledger:app:citizen-blog',
      sponsorshipId: 'sponsor-usage-001',
      sponsorUsageAmount: '2',
      grantAmount: '100',
      multisigThreshold: '2',
      grantScope: 'content.article',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.payloadJson).toContain('"action": "MULTISIG_CREDIT_GRANT"');
    expect(result.payloadJson).toContain('"grant_scope": "content.article"');
    expect(result.payloadJson).toContain('"multisig_threshold": 2');
    expect(result.payloadJson).toContain('"amount": 100');
  });
});

describe('buildStrictBuilderCreditChecklist', () => {
  it('marks all strict fields as valid for complete templates', () => {
    const checklist = buildStrictBuilderCreditChecklist({
      authorDid: 'did:ledger:builder:alpha',
      creditGrantId: 'grant:builder:alpha',
      sponsorBuilderId: 'did:ledger:builder:alpha',
      sponsoredDid: 'did:ledger:app:citizen-blog',
      sponsorshipId: 'sponsor-usage-001',
      sponsorUsageAmount: '2',
      grantAmount: '100',
      multisigThreshold: '2',
      grantScope: 'content.article',
    });

    expect(checklist.every((item) => item.valid)).toBe(true);
  });
});
