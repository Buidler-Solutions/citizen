import { describe, expect, it } from 'vitest';
import { createSponsorUsageDraft } from './builderCreditDraft';

describe('createSponsorUsageDraft', () => {
  it('builds strict sponsor usage envelope', () => {
    const result = createSponsorUsageDraft({
      authorDid: 'did:ledger:builder:alpha',
      creditGrantId: 'grant:builder:alpha',
      sponsorBuilderId: 'did:ledger:builder:alpha',
      sponsoredDid: 'did:ledger:app:citizen-blog',
      sponsorshipId: 'sponsor-usage-001',
      usageUnits: '2',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.payloadJson).toContain('"namespace": "builder.credits"');
    expect(result.payloadJson).toContain('"action": "SPONSOR_USAGE"');
    expect(result.payloadJson).toContain('"credit_grant_id": "grant:builder:alpha"');
  });

  it('returns validation errors for incomplete draft input', () => {
    const result = createSponsorUsageDraft({
      authorDid: '',
      creditGrantId: '',
      sponsorBuilderId: '',
      sponsoredDid: '',
      sponsorshipId: '',
      usageUnits: '0',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Author DID is required.');
    expect(result.errors).toContain('credit_grant_id is required.');
    expect(result.errors).toContain('usage_units must be a positive integer.');
  });
});
