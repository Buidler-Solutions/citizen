import { describe, expect, it } from 'vitest';
import {
  createDappSigningRequestEnvelope,
  DAPP_SIGNING_METHOD,
  signingScopePayloadV2FromEnvelope,
  signingPreimageFromEnvelope,
} from './dappSigningRequest';

describe('createDappSigningRequestEnvelope', () => {
  it('creates a canonical envelope for ctzn_signCitizenTx requests', async () => {
    const envelope = await createDappSigningRequestEnvelope({
      origin: 'https://demo.citizen.local',
      tabUrl: 'https://demo.citizen.local/forms/apply',
      payload: {
        metadata: { version: 1, app: 'demo' },
        namespace: 'citizen.kyc',
        operation: 'submit',
      },
      now: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(envelope.method).toBe(DAPP_SIGNING_METHOD);
    expect(envelope.requestId).toHaveLength(36);
    expect(envelope.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(envelope.expiresAt).toBe('2026-01-02T03:09:05.000Z');
    expect(envelope.canonicalPayload).toBe('{"metadata":{"app":"demo","version":1},"namespace":"citizen.kyc","operation":"submit"}');
    expect(envelope.payloadHash).toMatch(/^sha256:/);
    expect(envelope.riskFlags).toEqual([]);
    expect(signingScopePayloadV2FromEnvelope(envelope)).toEqual({
      scope: 'citizen_dapp_signing_v2',
      requestId: envelope.requestId,
      origin: 'https://demo.citizen.local',
      tabUrl: 'https://demo.citizen.local/forms/apply',
      method: 'ctzn_signCitizenTx',
      payloadHash: envelope.payloadHash,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
    });
    expect(signingPreimageFromEnvelope(envelope)).toBe(
      `{"createdAt":"2026-01-02T03:04:05.000Z","expiresAt":"2026-01-02T03:09:05.000Z","method":"ctzn_signCitizenTx","origin":"https://demo.citizen.local","payloadHash":"${envelope.payloadHash}","requestId":"${envelope.requestId}","scope":"citizen_dapp_signing_v2","tabUrl":"https://demo.citizen.local/forms/apply"}`,
    );
  });

  it('flags unknown origins and unsupported fields', async () => {
    const envelope = await createDappSigningRequestEnvelope({
      origin: 'chrome-extension://abc',
      payload: {
        namespace: 'citizen.kyc',
        operation: 'submit',
        customField: true,
      },
    });

    expect(envelope.riskFlags).toContain('unknown_origin');
    expect(envelope.riskFlags).toContain('unsupported_fields');
  });
});
