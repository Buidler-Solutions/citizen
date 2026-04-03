import { describe, expect, it, vi } from 'vitest';
import {
  createDirectSubmitBody,
  fetchCitizenReceipt,
  fetchSubmissionReceipt,
  isAllowlistedApiBaseUrl,
  isAllowlistedDestination,
  submitEnvelopeToCitizenNetwork,
  submitSignedArtifact,
  type SignedEnvelope,
  type SignedSubmissionArtifact,
} from './directSubmitClient';

const artifact: SignedSubmissionArtifact = {
  signerDid: 'did:key:ed25519:abcd1234',
  verifyingKey: 'abcd1234',
  signature: 'deadbeef',
  payloadHash: 'sha256:1234',
  signingPayload: '{"action":"SUBMIT"}',
  signatureScope: 'canonical_payload_v1',
  algorithm: 'ed25519',
  requestId: '11111111-1111-1111-1111-111111111111',
};

const envelope: SignedEnvelope = {
  envelope_id: '11111111-1111-1111-1111-111111111111',
  signer: 'did:key:ed25519:abcd1234',
  signature: 'ed25519:base64sig',
  submitted_at: '2026-04-03T00:00:00.000Z',
  payload: {
    entry_id: '22222222-2222-2222-2222-222222222222',
    namespace: 'onboarding.interest',
    action: 'SUBMIT_ONBOARDING_INTEREST',
    object_id: 'alex@example.com',
    payload: { role: 'builder' },
    author: 'did:key:ed25519:abcd1234',
    timestamp: 1_775_000_000,
    signature: 'ed25519:entrysig',
  },
};

describe('directSubmitClient', () => {
  it('matches only explicitly allowlisted destinations', () => {
    expect(
      isAllowlistedDestination('https://node.citizen.local/v1/submit', [
        'https://node.citizen.local/v1/submit',
      ]),
    ).toBe(true);
    expect(
      isAllowlistedDestination('https://node.citizen.local/v1/other', [
        'https://node.citizen.local/v1/submit',
      ]),
    ).toBe(false);
  });

  it('matches allowlisted Citizen API base URLs', () => {
    expect(
      isAllowlistedApiBaseUrl('https://node.citizen.local:8081', ['https://node.citizen.local:8081']),
    ).toBe(true);
    expect(
      isAllowlistedApiBaseUrl('https://node.citizen.local:8082', ['https://node.citizen.local:8081']),
    ).toBe(false);
  });

  it('builds privacy-minimized direct-submit body fields', () => {
    const body = createDirectSubmitBody(artifact);

    expect(body).toEqual({
      signerDid: artifact.signerDid,
      verifyingKey: artifact.verifyingKey,
      signature: artifact.signature,
      payloadHash: artifact.payloadHash,
      signingPayload: null,
      signatureScope: artifact.signatureScope,
      algorithm: artifact.algorithm,
      requestId: artifact.requestId,
    });

    expect(body).not.toHaveProperty('formPayload');
    expect(body).not.toHaveProperty('fullName');
    expect(body).not.toHaveProperty('email');
  });

  it('includes signing payload only when user consent is provided', () => {
    const body = createDirectSubmitBody(artifact, true);
    expect(body).toMatchObject({
      signingPayload: artifact.signingPayload,
    });
  });

  it('submits signed artifacts with deterministic trace id header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        receipt: {
          receipt_id: 'receipt-1',
          receipt_hash: 'sha256:abcd',
        },
      }),
    } as Response);

    const response = await submitSignedArtifact({
      destinationUrl: 'https://node.citizen.local/v1/submit',
      allowlistedDestinations: ['https://node.citizen.local/v1/submit'],
      signedArtifact: artifact,
      fetchImpl: fetchMock,
    });

    expect(response.status).toBe(202);
    expect(response.receiptId).toBe('receipt-1');
    expect(response.receiptHash).toBe('sha256:abcd');
    expect(response.idempotencyKey.startsWith('sha256:')).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://node.citizen.local/v1/submit');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-citizen-wallet-trace-id']).toBeTypeOf('string');
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe(response.idempotencyKey);
    expect(JSON.parse(String(init.body))).toMatchObject({
      signingPayload: null,
    });
  });

  it('reuses the same idempotency key for duplicate direct-submit attempts with identical signed bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ receipt: { receipt_id: 'receipt-1' } }),
    } as Response);

    const first = await submitSignedArtifact({
      destinationUrl: 'https://node.citizen.local/v1/submit',
      allowlistedDestinations: ['https://node.citizen.local/v1/submit'],
      signedArtifact: artifact,
      fetchImpl: fetchMock,
    });
    const second = await submitSignedArtifact({
      destinationUrl: 'https://node.citizen.local/v1/submit',
      allowlistedDestinations: ['https://node.citizen.local/v1/submit'],
      signedArtifact: artifact,
      fetchImpl: fetchMock,
    });

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders['x-idempotency-key']).toBe(secondHeaders['x-idempotency-key']);
  });

  it('rejects unallowlisted endpoints before any network call', async () => {
    const fetchMock = vi.fn();

    await expect(
      submitSignedArtifact({
        destinationUrl: 'https://unknown.example/submit',
        allowlistedDestinations: ['https://node.citizen.local/v1/submit'],
        signedArtifact: artifact,
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('Destination is not allowlisted');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits a full SignedEnvelope to Citizen API endpoint with explicit consent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        status: 'accepted',
        receipt: {
          receipt_id: 'receipt-7',
          finality: {
            block_hash: 'block-hash-77',
          },
        },
      }),
    } as Response);

    const response = await submitEnvelopeToCitizenNetwork({
      apiBaseUrl: 'http://127.0.0.1:8081',
      allowlistedApiBaseUrls: ['http://127.0.0.1:8081'],
      envelope,
      consentToShareFullPayload: true,
      apiKey: 'builder-ingest-key',
      fetchImpl: fetchMock,
    });

    expect(response.status).toBe(202);
    expect(response.receiptId).toBe('receipt-7');
    expect(response.receiptHash).toBe('block-hash-77');
    expect(response.idempotencyKey.startsWith('network:')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/v1/envelopes/submit');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('builder-ingest-key');
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe(response.idempotencyKey);
  });

  it('blocks full envelope submit without explicit consent', async () => {
    await expect(
      submitEnvelopeToCitizenNetwork({
        apiBaseUrl: 'http://127.0.0.1:8081',
        allowlistedApiBaseUrls: ['http://127.0.0.1:8081'],
        envelope,
        consentToShareFullPayload: false,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('explicit user consent');
  });

  it('looks up receipts only on allowlisted origins', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ receipt: { receipt_id: 'receipt-2' } }),
    } as Response);

    const receipt = await fetchSubmissionReceipt({
      receiptUrl: 'https://node.citizen.local/v1/receipts/receipt-2',
      allowlistedDestinations: ['https://node.citizen.local/v1/receipts/receipt-2'],
      fetchImpl: fetchMock,
    });

    expect(receipt).toEqual({ receipt: { receipt_id: 'receipt-2' } });
  });

  it('fetches deterministic receipt using Citizen runtime route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ receipt: { receipt_id: 'receipt-77', status: 'accepted' } }),
    } as Response);

    const response = await fetchCitizenReceipt({
      apiBaseUrl: 'http://127.0.0.1:8081',
      allowlistedApiBaseUrls: ['http://127.0.0.1:8081'],
      receiptId: 'receipt-77',
      fetchImpl: fetchMock,
    });

    expect(response).toEqual({ receipt: { receipt_id: 'receipt-77', status: 'accepted' } });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8081/api/v1/receipts/receipt-77');
  });
});
