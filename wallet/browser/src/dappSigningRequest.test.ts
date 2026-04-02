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
    expect(envelope.policyChecks).toEqual([]);
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

  it('adds policy violation risk when namespace/operation checks fail', async () => {
    const envelope = await createDappSigningRequestEnvelope({
      origin: 'https://demo.citizen.local',
      payload: {
        namespace: 'INVALID_NAMESPACE',
      },
    });

    expect(envelope.riskFlags).toContain('policy_violation');
    expect(envelope.policyChecks.map((check) => check.code)).toEqual([
      'invalid_namespace',
      'missing_operation',
    ]);
  });

  it('runs policy checks when payload is provided as canonical JSON string', async () => {
    const envelope = await createDappSigningRequestEnvelope({
      origin: 'https://demo.citizen.local',
      payload: '{"namespace":"builder.credits","operation":"grant"}',
    });

    expect(envelope.riskFlags).toContain('policy_violation');
    expect(envelope.policyChecks.map((check) => check.code)).toContain('builder_credit_payload_missing');
  });

  it('produces identical canonical payload and hash for equivalent object key ordering', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const [a, b] = await Promise.all([
      createDappSigningRequestEnvelope({
        origin: 'https://demo.citizen.local',
        payload: {
          operation: 'submit',
          namespace: 'citizen.kyc',
          metadata: { z: 2, a: 1 },
        },
        now,
      }),
      createDappSigningRequestEnvelope({
        origin: 'https://demo.citizen.local',
        payload: {
          metadata: { a: 1, z: 2 },
          namespace: 'citizen.kyc',
          operation: 'submit',
        },
        now,
      }),
    ]);

    expect(a.canonicalPayload).toBe(b.canonicalPayload);
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('flags large payloads and stale requests', async () => {
    const largePayload = {
      namespace: 'citizen.kyc',
      operation: 'submit',
      metadata: {
        note: 'x'.repeat(70_000),
      },
    };
    const staleEnvelope = await createDappSigningRequestEnvelope({
      origin: 'https://demo.citizen.local',
      payload: largePayload,
      now: new Date('2026-01-02T03:04:05.000Z'),
      ttlMs: 0,
    });

    expect(staleEnvelope.riskFlags).toContain('large_payload');
    expect(staleEnvelope.riskFlags).toContain('stale_request');
    expect(staleEnvelope.createdAt).toBe(staleEnvelope.expiresAt);
  });
});
