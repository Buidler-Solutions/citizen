import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { BadRequestException, HttpException } from '@nestjs/common';
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
const x25519SpkiPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const x25519Pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');


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

function exportX25519PrivateHex(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return der.subarray(x25519Pkcs8Prefix.length).toString('hex');
}

function exportX25519PublicHex(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(x25519SpkiPrefix.length).toString('hex');
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
    fullName: overrides.fullName ?? 'Alex Citizen',
    institution: overrides.institution ?? 'Civic Lab',
    email: overrides.email ?? 'alex@example.com',
    country: overrides.country ?? 'United States',
    role: overrides.role ?? 'builder',
    missionNeed: overrides.missionNeed ?? 'Deterministic approvals and replay-safe signatures.',
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

test('create accepts quoted relay url env values', async () => {
  const relayUrl = 'https://citizen-relay.example.test/api/v1/submit';
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = `"${relayUrl}"`;

  let capturedRelayUrl: string | null = null;
  const mockedFetch = (async (input: RequestInfo | URL) => {
    capturedRelayUrl = typeof input === 'string' ? input : input.toString();
    return {
      ok: true,
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    const contract = service.getSignedSubmissionContract();
    assert.equal(contract.relayMode, 'database_plus_network_relay');

    await service.create(buildSignedPayload({ email: 'quoted-relay-url@example.com' }));
    assert.equal(capturedRelayUrl, relayUrl);
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    globalThis.fetch = originalFetch;
  }
});

test('create can relay onboarding submission as runtime envelope payload', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimeNamespace = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE;
  const originalRuntimeAction = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION;
  const originalRuntimeAuthor = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE = 'forms.commitment';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION = 'SUBMIT_ONBOARDING_INTEREST';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR = 'forms.commitment';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;

  let capturedRequestBody: Record<string, unknown> | null = null;
  const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequestBody = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    const signedPayload = buildSignedPayload({ email: 'runtime-envelope@example.com' });
    await service.create(signedPayload);

    assert.ok(capturedRequestBody);
    const relayBody = capturedRequestBody as Record<string, unknown>;
    const relayEntry = relayBody.payload as Record<string, unknown>;
    assert.equal(relayBody.signer, 'forms.commitment');
    assert.equal(relayEntry.author, 'forms.commitment');
    assert.equal(relayEntry.namespace, 'forms.commitment');
    assert.equal(relayEntry.action, 'SUBMIT_ONBOARDING_INTEREST');
    assert.equal(relayEntry.object_id, `onboarding_submission:${signedPayload.walletPayloadHash.slice('sha256:'.length)}`);
    assert.equal(relayEntry.privacy_flag, false);
    assert.equal(relayEntry.privacy_mode, 'none');
    assert.notEqual(relayBody.signature, signedPayload.walletSignature);
    assert.equal(relayBody.signature, relayEntry.signature);
    assert.match(String(relayEntry.entry_id), /^[0-9a-fA-F-]{36}$/);

    const entryPayload = relayEntry.payload as Record<string, unknown>;
    assert.equal(entryPayload.data_hash, signedPayload.walletPayloadHash);
    assert.equal(
      entryPayload.encrypted_form_url,
      `interest_submissions://onboarding_submission:${signedPayload.walletPayloadHash.slice('sha256:'.length)}`,
    );
    assert.equal(entryPayload.wallet_signer, signedPayload.walletSignerDid);
    assert.equal(
      (entryPayload.payload_wallet_signature as Record<string, unknown>).signer,
      signedPayload.walletSignerDid,
    );
    assert.match(String(entryPayload.author_public_key), /^[0-9a-f]{64}$/);
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE = originalRuntimeNamespace;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION = originalRuntimeAction;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR = originalRuntimeAuthor;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    globalThis.fetch = originalFetch;
  }
});

test('create can relay onboarding submission as hybrid privacy runtime envelope payload', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalHybridPolicyRef = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_POLICY_REF;
  const originalHybridTtl = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_CONSENT_TTL_SECONDS;
  const originalFetch = globalThis.fetch;
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerOpsPublicKey } = generateKeyPairSync('x25519');
  const { publicKey: readerAuditPublicKey } = generateKeyPairSync('x25519');
  const { publicKey: walletReaderPublicKey } = generateKeyPairSync('x25519');

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops,did:reader:audit';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerOpsPublicKey),
    'did:reader:audit': exportX25519PublicHex(readerAuditPublicKey),
  });
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_POLICY_REF = 'policy:onboarding:hybrid:test';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_CONSENT_TTL_SECONDS = '3600';

  let capturedRequestBody: Record<string, unknown> | null = null;
  const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequestBody = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    const signedPayload = buildSignedPayload({
      email: 'runtime-hybrid@example.com',
      walletReaderDid: 'did:key:x25519:wallet-reader',
      walletReaderX25519PublicKey: exportX25519PublicHex(walletReaderPublicKey),
    });
    await service.create(signedPayload);

    assert.ok(capturedRequestBody);
    const relayEntry = (capturedRequestBody as Record<string, unknown>).payload as Record<string, unknown>;
    assert.equal(relayEntry.privacy_flag, true);
    assert.equal(relayEntry.privacy_mode, 'hybrid');
    assert.equal(relayEntry.payload_commitment, signedPayload.walletPayloadHash);
    assert.match(String(relayEntry.ciphertext_hex), /^[0-9a-f]+$/);
    assert.match(String(relayEntry.nonce_hex), /^[0-9a-f]+$/);
    assert.deepEqual(relayEntry.authorized_readers, ['did:reader:ops', 'did:reader:audit', 'did:key:x25519:wallet-reader']);

    const keyWrappedSecrets = relayEntry.key_wrapped_secrets as Array<Record<string, unknown>>;
    assert.equal(keyWrappedSecrets.length, 3);
    assert.equal(keyWrappedSecrets[0].reader_id, 'did:reader:ops');
    assert.equal(keyWrappedSecrets[1].reader_id, 'did:reader:audit');
    assert.equal(keyWrappedSecrets[2].reader_id, 'did:key:x25519:wallet-reader');
    assert.equal(keyWrappedSecrets[0].wrap_algorithm, 'x25519-chacha20poly1305');

    const consentReceipt = relayEntry.consent_receipt as Record<string, unknown>;
    assert.equal(consentReceipt.subject_did, signedPayload.walletSignerDid);
    assert.equal(consentReceipt.data_hash, signedPayload.walletPayloadHash);
    assert.equal(consentReceipt.policy_ref, 'policy:onboarding:hybrid:test');
    assert.deepEqual(consentReceipt.authorized_readers, ['did:reader:ops', 'did:reader:audit', 'did:key:x25519:wallet-reader']);

    const entryPayload = relayEntry.payload as Record<string, unknown>;
    assert.equal(entryPayload.signed_submission_commitment, signedPayload.walletPayloadHash);
    assert.equal(entryPayload.signed_submission, undefined);
    assert.equal(entryPayload.country, undefined);
    assert.match(String(entryPayload.hybrid_author_x25519_public_key), /^[0-9a-f]{64}$/);
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_POLICY_REF = originalHybridPolicyRef;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_CONSENT_TTL_SECONDS = originalHybridTtl;
    globalThis.fetch = originalFetch;
  }
});

test('runtime envelope signature matches ledger submission verification payload shape', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerOpsPublicKey } = generateKeyPairSync('x25519');

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerOpsPublicKey),
  });

  let capturedRequestBody: Record<string, unknown> | null = null;
  const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequestBody = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await service.create(buildSignedPayload({ email: 'runtime-signature-shape@example.com' }));

    assert.ok(capturedRequestBody);
    const relayEntry = (capturedRequestBody as Record<string, unknown>).payload as Record<string, unknown>;
    const entryPayload = relayEntry.payload as Record<string, unknown>;
    const authorPublicKeyHex = String(entryPayload.author_public_key);
    const entrySignatureHex = String(relayEntry.signature);
    const authorPublicKeyDer = Buffer.concat([
      ed25519SpkiPrefix,
      Buffer.from(authorPublicKeyHex, 'hex'),
    ]);
    const authorPublicKey = createPublicKey({
      key: authorPublicKeyDer,
      format: 'der',
      type: 'spki',
    });

    const ledgerCanonicalPayload = canonicalJson({
      entry_id: relayEntry.entry_id,
      namespace: relayEntry.namespace,
      action: relayEntry.action,
      object_id: relayEntry.object_id,
      payload: relayEntry.payload,
      author: relayEntry.author,
      timestamp: relayEntry.timestamp,
    });

    const verified = verify(
      null,
      Buffer.from(ledgerCanonicalPayload, 'utf8'),
      authorPublicKey,
      Buffer.from(entrySignatureHex, 'hex'),
    );
    assert.equal(verified, true);
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts runtime relay key when PEM newlines are escaped', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const escapedRuntimePrivateKeyPem = runtimePrivateKeyPem.replace(/\n/g, '\\n');
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = escapedRuntimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'none';

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-escaped-key@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts hybrid author X25519 private key as PEM', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const hybridAuthorPrivateKeyPem = hybridAuthorPrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = hybridAuthorPrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerPublicKey),
  });

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-author-pem@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts quoted hybrid author X25519 private key hex from env files', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = `"${exportX25519PrivateHex(hybridAuthorPrivateKey)}"`;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerPublicKey),
  });

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-author-quoted-hex@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create falls back to ephemeral hybrid author X25519 key when configured key is invalid', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = 'not-a-valid-key';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerPublicKey),
  });

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-author-ephemeral@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts reader public key in did:key:x25519:<hex> format', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const readerPublicHex = exportX25519PublicHex(readerPublicKey);
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': `did:key:x25519:${readerPublicHex}`,
  });

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-reader-did-format@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts reader key object with signer_0x and x25519_public_key', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const readerPublicHex = exportX25519PublicHex(readerPublicKey);
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = JSON.stringify({
    'did:reader:ops': {
      signer_0x: '0x1234567890abcdef1234567890abcdef12345678',
      x25519_public_key: `0x${readerPublicHex}`,
    },
  });

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-reader-object@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create accepts quoted reader key JSON object from env files', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: readerPublicKey } = generateKeyPairSync('x25519');
  const readerJson = JSON.stringify({
    'did:reader:ops': exportX25519PublicHex(readerPublicKey),
  });
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = `'${readerJson}'`;

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({ email: 'runtime-hybrid-reader-quoted-json@example.com' })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create succeeds with wallet reader key even when env reader JSON is invalid', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { privateKey: hybridAuthorPrivateKey } = generateKeyPairSync('x25519');
  const { publicKey: walletReaderPublicKey } = generateKeyPairSync('x25519');
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;
  const originalHybridAuthorX25519 = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX;
  const originalHybridReaderKeys = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = 'did:reader:ops';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = exportX25519PrivateHex(hybridAuthorPrivateKey);
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = 'not-json';

  const mockedFetch = (async () => ({
    ok: true,
    status: 200,
  } as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.doesNotReject(service.create(buildSignedPayload({
      email: 'runtime-hybrid-wallet-reader-fallback@example.com',
      walletReaderDid: 'did:key:x25519:wallet-reader-fallback',
      walletReaderX25519PublicKey: exportX25519PublicHex(walletReaderPublicKey),
    })));
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX = originalHybridAuthorX25519;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON = originalHybridReaderKeys;
    globalThis.fetch = originalFetch;
  }
});

test('create fails closed when runtime envelope relay key is missing', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  delete process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;

  try {
    const service = createService();
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'runtime-missing-key@example.com' })),
      (error: unknown) => error instanceof BadRequestException,
    );
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
  }
});

test('create fails closed when runtime onboarding passphrase privacy mode is selected', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'passphrase';

  try {
    const service = createService();
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'runtime-privacy-mode@example.com' })),
      (error: unknown) => error instanceof BadRequestException
        && error.message.includes('does not support privacy_mode=passphrase'),
    );
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
  }
});

test('create fails closed when runtime hybrid privacy mode has no authorized readers', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalHybridReaders = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'hybrid';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = '';

  try {
    const service = createService();
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'runtime-hybrid-missing-readers@example.com' })),
      (error: unknown) => error instanceof BadRequestException
        && error.message.includes('HYBRID_AUTHORIZED_READERS is required'),
    );
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS = originalHybridReaders;
  }
});

test('create fails closed when runtime privacy flag conflicts with privacy mode', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const { privateKey: runtimePrivateKey } = generateKeyPairSync('ed25519');
  const runtimePrivateKeyPem = runtimePrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalRelayFormat = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT;
  const originalRuntimePrivateKey = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM;
  const originalRuntimePrivacyMode = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE;
  const originalRuntimePrivacyFlag = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;
  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = 'runtime_envelope';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = runtimePrivateKeyPem;
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = 'none';
  process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG = 'true';

  try {
    const service = createService();
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'runtime-privacy-flag@example.com' })),
      (error: unknown) => error instanceof BadRequestException
        && error.message.includes('must match'),
    );
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT = originalRelayFormat;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM = originalRuntimePrivateKey;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE = originalRuntimePrivacyMode;
    process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG = originalRuntimePrivacyFlag;
  }
});

test('create includes relay error detail in rejection message', async () => {
  const relayUrl = 'http://127.0.0.1:8081/api/v1/envelopes/submit';
  const originalRelayUrl = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL;
  const originalFetch = globalThis.fetch;

  process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = relayUrl;

  const mockedFetch = (async () => ({
    ok: false,
    status: 422,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => ({ error: 'author forms.commitment is not permitted for namespace onboarding.interest' }),
    text: async () => '',
  } as unknown as Response)) as unknown as typeof fetch;
  globalThis.fetch = mockedFetch;

  try {
    const service = createService();
    await assert.rejects(
      service.create(buildSignedPayload({ email: 'relay-error-detail@example.com' })),
      (error: unknown) => {
        if (!(error instanceof HttpException)) {
          return false;
        }
        const message = error.message;
        return message.includes('status=422')
          && message.includes('detail=author forms.commitment is not permitted for namespace onboarding.interest');
      },
    );
  } finally {
    process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL = originalRelayUrl;
    globalThis.fetch = originalFetch;
  }
});
