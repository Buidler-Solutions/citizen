import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { LeadService } from './lead.service';
import type { CreateLeadDto } from './dto/create-lead.dto';

type MockLeadRepository = {
  createQueryBuilder: () => {
    where: () => { getOne: () => Promise<null> };
  };
  create: (payload: Record<string, unknown>) => Record<string, unknown>;
  save: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  count: () => Promise<number>;
};

type MockFormSettingsRepository = {
  findOne: () => Promise<Record<string, unknown> | null>;
  create: (payload: Record<string, unknown>) => Record<string, unknown>;
  save: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');


function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value && typeof value === 'object') {
    const orderedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)] as const);
    return Object.fromEntries(orderedEntries);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function createService() {
  const leadRepository: MockLeadRepository = {
    createQueryBuilder: () => ({
      where: () => ({
        getOne: async () => null,
      }),
    }),
    create: (payload) => payload,
    save: async (payload) => ({ id: 'lead-1', ...payload }),
    count: async () => 1,
  };

  const formSettingsRepository: MockFormSettingsRepository = {
    findOne: async () => ({
      id: 'default',
      roles: [
        { id: 'builder', label: 'Builder', prompt: 'Builder prompt', thankYouNote: 'Builder note', weight: 1 },
        { id: 'validator', label: 'Validator', prompt: 'Validator prompt', thankYouNote: 'Validator note', weight: 2 },
        { id: 'observer', label: 'Observer', prompt: 'Observer prompt', thankYouNote: 'Observer note', weight: 3 },
      ],
      campaignCards: [{ eyebrow: 'citizen', title: 'Title', body: 'Body', weight: 1 }],
      siteLogoUrl: '',
      siteLogoAlt: 'Citizen',
      siteName: 'Citizen',
    }),
    create: (payload) => payload,
    save: async (payload) => payload,
  };

  const asciinemaRecordingRepository = {
    find: async () => [],
    findOne: async () => null,
    create: (payload: Record<string, unknown>) => payload,
    save: async (payload: Record<string, unknown>) => payload,
    delete: async () => ({ affected: 1 }),
  };

  const onboardingNotificationService = {
    sendLeadSubmissionNotifications: async () => undefined,
  };

  const service = new LeadService(
    leadRepository as never,
    formSettingsRepository as never,
    asciinemaRecordingRepository as never,
    onboardingNotificationService as never,
  );

  return service;
}

function buildSignedPayload(overrides: Partial<CreateLeadDto> = {}): CreateLeadDto {
  const basePayload = {
    fullName: 'Alex Citizen',
    institution: 'Civic Lab',
    email: 'alex@example.com',
    country: 'United States',
    role: 'builder',
    missionNeed: 'Deterministic approvals and replay-safe signatures.',
    ...overrides,
  };

  const protocolPayload = {
    schema_version: '1.0.0',
    namespace: 'onboarding.interest',
    action: 'SUBMIT_ONBOARDING_INTEREST',
    object_id: basePayload.email,
    payload: basePayload,
    submitted_at: '2026-04-02T00:00:00.000Z',
  };

  const canonicalSigningPayload = canonicalJson(protocolPayload);
  const walletPayloadHash = `sha256:${createHash('sha256').update(canonicalSigningPayload).digest('hex')}`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const walletVerifyingKey = publicKeyDer.subarray(ed25519SpkiPrefix.length).toString('hex');
  const walletSignature = sign(null, Buffer.from(canonicalSigningPayload, 'utf8'), privateKey).toString('hex');

  return {
    fullName: basePayload.fullName,
    institution: basePayload.institution,
    email: basePayload.email,
    country: basePayload.country,
    role: basePayload.role,
    missionNeed: basePayload.missionNeed,
    walletSignerDid: `did:key:ed25519:${walletVerifyingKey}`,
    walletVerifyingKey,
    walletSignature,
    walletPayloadHash,
    walletSigningPayload: canonicalSigningPayload,
    walletAlgorithm: 'ed25519',
    walletSignatureScope: 'canonical_payload_v1',
    ...overrides,
  };
}

test('create rejects unsigned onboarding payloads before persistence', async () => {
  const service = createService();
  const unsignedPayload = buildSignedPayload({ walletSigningPayload: 'not-json' });

  await assert.rejects(
    service.create(unsignedPayload),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test('create accepts canonical signed onboarding payloads', async () => {
  const service = createService();
  const signedPayload = buildSignedPayload();

  const created = await service.create(signedPayload);

  assert.equal(created.email, signedPayload.email.toLowerCase());
  assert.equal(created.walletPayloadHash, signedPayload.walletPayloadHash);
});

test('stats report relay direct-submit failure rate from relay outcomes', async () => {
  const relayUrl = 'https://citizen-relay.example.test/api/v1/submit';
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;

  let fetchCalls = 0;
  const mockedFetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return {
        ok: true,
        status: 200,
      } as Response;
    }
    return {
      ok: false,
      status: 400,
    } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await service.create(buildSignedPayload({ email: 'relay-success@example.com' }));
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'relay-failure@example.com' })),
      (error: unknown) => error instanceof BadRequestException,
    );

    const stats = await service.stats() as {
      totalInterestSubmissions: number;
      relaySubmissionTelemetry: {
        totalRelaySubmissions: number;
        failedRelaySubmissions: number;
        relayDirectSubmitFailureRate: number | null;
      };
    };

    assert.equal(stats.totalInterestSubmissions, 1);
    assert.deepEqual(stats.relaySubmissionTelemetry, {
      totalRelaySubmissions: 2,
      failedRelaySubmissions: 1,
      relayDirectSubmitFailureRate: 0.5,
    });
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    globalThis.fetch = originalFetch;
  }
});
