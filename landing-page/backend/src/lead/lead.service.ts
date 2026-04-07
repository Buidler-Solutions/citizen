import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { unlink } from 'fs/promises';
import { KeyObject, createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadInterest } from './lead.entity';
import { FormSettings } from './form-settings.entity';
import { UpdateFormSettingsDto } from './dto/update-form-settings.dto';
import { AsciinemaRecording } from './asciinema-recording.entity';
import { OnboardingNotificationService } from '../mail/onboarding-notification.service';

const DEFAULT_CAMPAIGN_CARDS = [
  {
    weight: 1,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    weight: 2,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
    weight: 3,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'What we are solving',
    body: 'We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies.',
  },
];


const DEFAULT_RELAY_MAX_ATTEMPTS = 3;
const DEFAULT_RELAY_RETRY_BACKOFF_MS = 250;
const MAX_RELAY_RETRY_BACKOFF_MS = 5000;
const DEFAULT_RUNTIME_NAMESPACE = 'forms.commitment';
const DEFAULT_RUNTIME_ACTION = 'SUBMIT_ONBOARDING_INTEREST';
const DEFAULT_RUNTIME_AUTHOR = 'forms.commitment';
const ED25519_SPKI_DER_PREFIX_HEX = '302a300506032b6570032100';
const X25519_SPKI_DER_PREFIX_HEX = '302a300506032b656e032100';
const X25519_PKCS8_DER_PREFIX_HEX = '302e020100300506032b656e04220420';
type RuntimePrivacyMode = 'none' | 'passphrase' | 'hybrid';
type RuntimeEntryPrivacyFields = {
  privacy_flag: boolean;
  privacy_mode: RuntimePrivacyMode;
  payload_commitment?: string;
  ciphertext_hex?: string;
  nonce_hex?: string;
  consent_receipt?: Record<string, unknown>;
  authorized_readers?: string[];
  key_wrapped_secrets?: Array<Record<string, string>>;
};
type RuntimePrivacyResolution = {
  entryPrivacy: RuntimeEntryPrivacyFields;
  hybridAuthorX25519PublicKeyHex?: string;
};

const DEFAULT_ROLE_OPTIONS = [
  {
    id: 'validator',
    label: 'Validator',
    prompt: 'I want to stress test the system as a Validator focused on...',
    thankYouNote: 'Thank you for applying to run a Citizen Validator node. We have added you to the validator waitlist. Our team will review your submission and send onboarding updates, eligibility checks, and timeline details to your email.',
    weight: 1,
  },
  {
    id: 'builder',
    label: 'Builder',
    prompt: 'I want to build civic applications as a Builder for...',
    thankYouNote: 'Thank you for joining as a Builder. You are now on our builder waitlist. We will share product updates, API access details, and onboarding milestones by email as new slots open.',
    weight: 2,
  },
  {
    id: 'observer',
    label: 'Observer',
    prompt: 'I want to run audits as an Observer to improve...',
    thankYouNote: 'Thank you for registering as an Observer. We have added you to the observer waitlist. You will receive updates by email about review status, audit participation windows, and next steps.',
    weight: 3,
  },
];

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);
  private relaySubmissionTelemetry = {
    totalRelaySubmissions: 0,
    failedRelaySubmissions: 0,
  };

  constructor(
    @InjectRepository(LeadInterest)
    private readonly leadRepository: Repository<LeadInterest>,
    @InjectRepository(FormSettings)
    private readonly formSettingsRepository: Repository<FormSettings>,
    @InjectRepository(AsciinemaRecording)
    private readonly asciinemaRecordingRepository: Repository<AsciinemaRecording>,
    private readonly onboardingNotificationService: OnboardingNotificationService,
  ) {}

  async create(payload: CreateLeadDto): Promise<LeadInterest> {
    const normalizedEmail = payload.email.trim().toLowerCase();
    const existingLead = await this.leadRepository
      .createQueryBuilder('lead')
      .where('LOWER(lead.email) = :email', { email: normalizedEmail })
      .getOne();

    if (existingLead) {
      throw new ConflictException('A submission already exists for this email address.');
    }

    const formSettings = await this.getFormSettings();
    const normalizedRole = this.normalizeRole(payload.role, formSettings);
    this.assertWalletSignedPayload(payload, normalizedRole);

    await this.relaySignedSubmissionToCitizenNetwork(payload, normalizedRole);

    const lead = this.leadRepository.create({
      ...payload,
      email: normalizedEmail,
      role: normalizedRole,
      missionNeed: payload.missionNeed.trim(),
      walletAlgorithm: payload.walletAlgorithm.toLowerCase(),
    });

    const savedLead = await this.leadRepository.save(lead);
    await this.onboardingNotificationService.sendLeadSubmissionNotifications(savedLead, formSettings);
    return savedLead;
  }

  getSignedSubmissionContract(): {
    submitModel: 'frontend_signed_backend_relay';
    relayMode: 'database_only' | 'database_plus_network_relay' | 'invalid_relay_configuration';
    consent: {
      backendPersistence: string;
      networkRelay: string;
    };
  } {
    const relayUrlRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL?.trim();
    const relayMode = this.resolveRelayMode(relayUrlRaw);

    return {
      submitModel: 'frontend_signed_backend_relay',
      relayMode,
      consent: {
        backendPersistence: 'The onboarding payload and wallet signature metadata are persisted by the onboarding backend.',
        networkRelay: relayMode === 'database_plus_network_relay'
          ? 'Signed commitment metadata is relayed to the configured Citizen endpoint.'
          : relayMode === 'invalid_relay_configuration'
            ? 'Relay is currently blocked because CITIZEN_SIGNED_SUBMISSION_RELAY_URL is invalid; submissions fail closed until corrected.'
            : 'No Citizen relay endpoint is configured; onboarding data remains in backend custody only.',
      },
    };
  }

  private canonicalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeValue(item));
    }
    if (value && typeof value === 'object') {
      const orderedEntries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, this.canonicalizeValue(entryValue)] as const);
      return Object.fromEntries(orderedEntries);
    }
    return value;
  }

  private canonicalJson(value: unknown): string {
    return JSON.stringify(this.canonicalizeValue(value));
  }

  private assertWalletSignedPayload(payload: CreateLeadDto, normalizedRole: string): void {
    const expectedPayload = {
      schema_version: '1.0.0',
      namespace: 'onboarding.interest',
      action: 'SUBMIT_ONBOARDING_INTEREST',
      object_id: payload.email.trim().toLowerCase(),
      payload: {
        fullName: payload.fullName.trim(),
        institution: payload.institution.trim(),
        email: payload.email.trim(),
        country: payload.country.trim(),
        role: normalizedRole,
        missionNeed: payload.missionNeed.trim(),
      },
      submitted_at: undefined,
    };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload.walletSigningPayload) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('walletSigningPayload must be valid JSON.');
    }

    if (typeof parsed.submitted_at !== 'string' || parsed.submitted_at.trim().length < 10) {
      throw new BadRequestException('walletSigningPayload must include submitted_at timestamp.');
    }

    const canonical = this.canonicalJson({
      ...expectedPayload,
      submitted_at: parsed.submitted_at,
    });

    if (canonical !== payload.walletSigningPayload) {
      throw new BadRequestException('walletSigningPayload does not match expected canonical onboarding payload.');
    }

    const computedHash = `sha256:${createHash('sha256').update(payload.walletSigningPayload).digest('hex')}`;
    if (computedHash.toLowerCase() !== payload.walletPayloadHash.toLowerCase()) {
      throw new BadRequestException('walletPayloadHash does not match walletSigningPayload.');
    }

    const expectedDid = `did:key:ed25519:${payload.walletVerifyingKey.toLowerCase()}`;
    if (payload.walletSignerDid.toLowerCase() !== expectedDid) {
      throw new BadRequestException('walletSignerDid does not match walletVerifyingKey.');
    }

    const signatureScope = payload.walletSignatureScope === 'canonical_payload_v1'
      ? 'canonical_payload_v1'
      : 'payload_hash_v1';
    const signatureMessage = signatureScope === 'canonical_payload_v1'
      ? payload.walletSigningPayload
      : payload.walletPayloadHash;

    if (!this.verifyWalletSignature(payload.walletVerifyingKey, signatureMessage, payload.walletSignature)) {
      throw new BadRequestException(`walletSignature verification failed for ${signatureScope}.`);
    }
  }

  private verifyWalletSignature(verifyingKeyHex: string, signingPayload: string, signatureHex: string): boolean {
    try {
      const publicKeyRaw = Buffer.from(verifyingKeyHex, 'hex');
      if (publicKeyRaw.length !== 32) {
        return false;
      }
      const signature = Buffer.from(signatureHex, 'hex');
      if (signature.length !== 64) {
        return false;
      }

      // RFC8410 Ed25519 SubjectPublicKeyInfo prefix for 32-byte raw key.
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const publicKeyDer = Buffer.concat([spkiPrefix, publicKeyRaw]);
      const keyObject = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });

      return verify(
        null,
        Buffer.from(signingPayload, 'utf8'),
        keyObject,
        signature,
      );
    } catch {
      return false;
    }
  }

  private async relaySignedSubmissionToCitizenNetwork(
    payload: CreateLeadDto,
    normalizedRole: string,
  ): Promise<void> {
    const relayUrl = this.getValidatedRelayUrl();
    if (!relayUrl) {
      return;
    }

    const signatureScope = payload.walletSignatureScope === 'canonical_payload_v1'
      ? 'canonical_payload_v1'
      : 'payload_hash_v1';
    const relayTraceId = randomUUID();
    const relayDeduplicationKey = createHash('sha256')
      .update(`${payload.walletPayloadHash}:${payload.email.trim().toLowerCase()}`)
      .digest('hex');

    this.assertRelayMetadata(payload);

    const relayPayload = this.buildRelayPayload(payload, normalizedRole, signatureScope, relayTraceId, relayDeduplicationKey);

    const retryPolicy = this.getRelayRetryPolicy();

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await fetch(relayUrl.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-trace-id': relayTraceId,
            'x-idempotency-key': relayDeduplicationKey,
          },
          body: JSON.stringify(relayPayload),
        });
        const latencyMs = Date.now() - startedAt;

        if (response.ok) {
          this.recordRelaySubmissionOutcome('success');
          this.logger.log(
            `Relay accepted signed onboarding payload trace_id=${relayTraceId} `
            + `status=${response.status} latency_ms=${latencyMs} payload_hash=${payload.walletPayloadHash} `
            + `attempt=${attempt} deduplication_key=${relayDeduplicationKey}`,
          );
          return;
        }

        const retryableStatus = response.status >= 500 || response.status === 429;
        const finalAttempt = attempt >= retryPolicy.maxAttempts;

        this.logger.warn(
          `Relay rejected signed onboarding payload trace_id=${relayTraceId} `
          + `status=${response.status} latency_ms=${latencyMs} payload_hash=${payload.walletPayloadHash} `
          + `attempt=${attempt} retryable=${retryableStatus} deduplication_key=${relayDeduplicationKey}`,
        );

        if (!retryableStatus || finalAttempt) {
          this.recordRelaySubmissionOutcome('failure');
          const relayErrorDetail = await this.extractRelayErrorDetail(response);
          const relayFailureMessage = relayErrorDetail
            ? `Citizen network relay rejected signed onboarding payload (trace_id=${relayTraceId}, status=${response.status}, detail=${relayErrorDetail}).`
            : `Citizen network relay rejected signed onboarding payload (trace_id=${relayTraceId}, status=${response.status}).`;
          throw new BadRequestException(
            relayFailureMessage,
          );
        }
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const finalAttempt = attempt >= retryPolicy.maxAttempts;

        if (error instanceof BadRequestException) {
          throw error;
        }

        this.logger.warn(
          `Relay request failed trace_id=${relayTraceId} payload_hash=${payload.walletPayloadHash} `
          + `attempt=${attempt} latency_ms=${latencyMs} error=${this.toErrorMessage(error)} `
          + `deduplication_key=${relayDeduplicationKey}`,
        );

        if (finalAttempt) {
          this.recordRelaySubmissionOutcome('failure');
          throw new ServiceUnavailableException(
            `Citizen network relay unavailable for signed onboarding payload (trace_id=${relayTraceId}).`,
          );
        }
      }

      const backoffMs = Math.min(
        retryPolicy.retryBackoffMs * 2 ** (attempt - 1),
        MAX_RELAY_RETRY_BACKOFF_MS,
      );
      await this.delay(backoffMs);
    }
  }

  private buildRelayPayload(
    payload: CreateLeadDto,
    normalizedRole: string,
    signatureScope: 'canonical_payload_v1' | 'payload_hash_v1',
    relayTraceId: string,
    relayDeduplicationKey: string,
  ): Record<string, unknown> {
    const relayFormatRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT?.trim().toLowerCase();
    const relayFormat = relayFormatRaw === 'runtime_envelope' ? 'runtime_envelope' : 'metadata';

    if (relayFormat === 'runtime_envelope') {
      return this.buildRuntimeEnvelopeRelayPayload(payload, normalizedRole, signatureScope, relayTraceId, relayDeduplicationKey);
    }

    return {
      namespace: 'onboarding.interest',
      action: 'SUBMIT_ONBOARDING_INTEREST',
      object_id: payload.email.trim().toLowerCase(),
      trace_id: relayTraceId,
      deduplication_key: relayDeduplicationKey,
      metadata: {
        role: normalizedRole,
        country: payload.country.trim(),
        submitted_at: new Date().toISOString(),
        signed_payload_hash: payload.walletPayloadHash,
      },
      wallet_signature: {
        signer: payload.walletSignerDid,
        verifying_key: payload.walletVerifyingKey,
        signature: payload.walletSignature,
        payload_hash: payload.walletPayloadHash,
        algorithm: payload.walletAlgorithm.toLowerCase(),
        signature_scope: signatureScope,
      },
      data_custody: {
        on_chain_commitment: {
          payload_hash: payload.walletPayloadHash,
          signer: payload.walletSignerDid,
          verifying_key: payload.walletVerifyingKey,
          signature_scope: signatureScope,
        },
        off_chain_record: {
          system: 'landing-page-backend',
          table: 'interest_submissions',
          contains_pii: true,
          fields: ['fullName', 'institution', 'email', 'country', 'role', 'missionNeed'],
        },
      },
    };
  }

  private buildRuntimeEnvelopeRelayPayload(
    payload: CreateLeadDto,
    normalizedRole: string,
    signatureScope: 'canonical_payload_v1' | 'payload_hash_v1',
    relayTraceId: string,
    relayDeduplicationKey: string,
  ): Record<string, unknown> {
    const runtimeNamespace = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE?.trim() || DEFAULT_RUNTIME_NAMESPACE;
    const runtimeAction = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION?.trim() || DEFAULT_RUNTIME_ACTION;
    const runtimeAuthor = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR?.trim() || DEFAULT_RUNTIME_AUTHOR;
    const objectId = payload.email.trim().toLowerCase();
    const entryId = randomUUID();
    const nowIso = new Date().toISOString();
    const timestamp = Math.floor(Date.now() / 1000);
    const signedOnboardingPayload = JSON.parse(payload.walletSigningPayload) as Record<string, unknown>;
    const runtimeSigningPrivateKeyPemRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM?.trim();
    const runtimePrivacy = this.resolveRuntimePrivacySettings(
      payload,
      payload.walletSignerDid,
      payload.walletPayloadHash,
      signedOnboardingPayload,
      entryId,
    );

    if (!runtimeSigningPrivateKeyPemRaw) {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM is required when CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT=runtime_envelope.',
      );
    }

    const runtimeSigningPrivateKeyPem = this.normalizePemValue(runtimeSigningPrivateKeyPemRaw);
    const runtimePrivateKey = this.parseRuntimeSigningPrivateKey(runtimeSigningPrivateKeyPem);
    const runtimeAuthorPublicKeyHex = this.exportEd25519PublicKeyHex(runtimePrivateKey);

    const runtimeEntryPayload = {
      data_hash: payload.walletPayloadHash,
      encrypted_form_url: `interest_submissions://${objectId}`,
      relay_trace_id: relayTraceId,
      deduplication_key: relayDeduplicationKey,
      wallet_signer: payload.walletSignerDid,
      role: normalizedRole,
      country: payload.country.trim(),
      signed_submission_commitment: payload.walletPayloadHash,
      payload_wallet_signature: {
        signer: payload.walletSignerDid,
        verifying_key: payload.walletVerifyingKey,
        signature: payload.walletSignature,
        payload_hash: payload.walletPayloadHash,
        algorithm: payload.walletAlgorithm.toLowerCase(),
        signature_scope: signatureScope,
      },
      author_public_key: runtimeAuthorPublicKeyHex,
    };

    if (runtimePrivacy.entryPrivacy.privacy_mode !== 'hybrid') {
      Object.assign(runtimeEntryPayload, {
        signed_submission: signedOnboardingPayload,
      });
    }
    if (runtimePrivacy.hybridAuthorX25519PublicKeyHex) {
      Object.assign(runtimeEntryPayload, {
        hybrid_author_x25519_public_key: runtimePrivacy.hybridAuthorX25519PublicKeyHex,
      });
    }
    if (payload.walletReaderDid?.trim() && payload.walletReaderX25519PublicKey?.trim()) {
      Object.assign(runtimeEntryPayload, {
        wallet_reader: {
          did: payload.walletReaderDid.trim(),
          x25519_public_key: payload.walletReaderX25519PublicKey.trim(),
        },
      });
    }

    const signingPayload = this.canonicalJson({
      entry_id: entryId,
      namespace: runtimeNamespace,
      action: runtimeAction,
      object_id: objectId,
      payload: runtimeEntryPayload,
      author: runtimeAuthor,
      timestamp,
    });

    const runtimeSignature = sign(null, Buffer.from(signingPayload, 'utf8'), runtimePrivateKey).toString('hex');

    return {
      envelope_id: randomUUID(),
      signer: runtimeAuthor,
      signature: runtimeSignature,
      submitted_at: nowIso,
      payload: {
        entry_id: entryId,
        namespace: runtimeNamespace,
        action: runtimeAction,
        object_id: objectId,
        payload: runtimeEntryPayload,
        ...runtimePrivacy.entryPrivacy,
        author: runtimeAuthor,
        signature: runtimeSignature,
        timestamp,
      },
    };
  }

  private resolveRuntimePrivacyMode(): RuntimePrivacyMode {
    const runtimePrivacyModeRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE?.trim().toLowerCase();
    const runtimePrivacyMode = runtimePrivacyModeRaw ?? 'none';

    if (runtimePrivacyMode !== 'none' && runtimePrivacyMode !== 'passphrase' && runtimePrivacyMode !== 'hybrid') {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE must be one of: none, passphrase, hybrid.',
      );
    }

    const runtimePrivacyFlagRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG?.trim().toLowerCase();
    if (runtimePrivacyFlagRaw) {
      if (runtimePrivacyFlagRaw !== 'true' && runtimePrivacyFlagRaw !== 'false') {
        throw new BadRequestException(
          'CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG must be true or false when provided.',
        );
      }
      const runtimePrivacyFlag = runtimePrivacyFlagRaw === 'true';
      if (runtimePrivacyFlag !== (runtimePrivacyMode !== 'none')) {
        throw new BadRequestException(
          'CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG must match CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE.',
        );
      }
    }

    return runtimePrivacyMode;
  }

  private resolveRuntimePrivacySettings(
    payload: CreateLeadDto,
    subjectDid: string,
    payloadCommitment: string,
    signedOnboardingPayload: Record<string, unknown>,
    entryId: string,
  ): RuntimePrivacyResolution {
    const runtimePrivacyMode = this.resolveRuntimePrivacyMode();

    if (runtimePrivacyMode === 'none') {
      return {
        entryPrivacy: {
          privacy_flag: false,
          privacy_mode: 'none',
        },
      };
    }

    if (runtimePrivacyMode === 'passphrase') {
      throw new BadRequestException(
        'Runtime onboarding relay does not support privacy_mode=passphrase. Use privacy_mode=hybrid for onboarding encrypted metadata relay.',
      );
    }

    const authorizedReadersRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS?.trim() ?? '';
    const configuredAuthorizedReaders = authorizedReadersRaw
      .split(',')
      .map((reader) => reader.trim())
      .filter(Boolean);
    const walletReaderDid = payload.walletReaderDid?.trim();
    const authorizedReaders = Array.from(new Set([
      ...configuredAuthorizedReaders,
      ...(walletReaderDid ? [walletReaderDid] : []),
    ]));

    if (authorizedReaders.length === 0) {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS is required when CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE=hybrid.',
      );
    }

    const authorX25519KeyPair = this.resolveHybridAuthorX25519KeyPair();
    const readerPublicKeysRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON?.trim();
    const walletReaderKeyRaw = payload.walletReaderX25519PublicKey?.trim();
    const hasWalletReaderKey = Boolean(walletReaderDid && walletReaderKeyRaw);

    const authorPrivateKey = authorX25519KeyPair.privateKey;
    const authorPublicKeyHex = authorX25519KeyPair.publicKeyHex;
    let readerPublicKeys: Record<string, string> = {};
    if (readerPublicKeysRaw) {
      try {
        readerPublicKeys = this.parseReaderX25519PublicKeys(readerPublicKeysRaw);
      } catch (error) {
        if (!hasWalletReaderKey) {
          throw error;
        }
        this.logger.warn(
          `Invalid CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON. `
          + `Proceeding with wallet-provided reader key only. reason=${this.toErrorMessage(error)}`,
        );
      }
    } else if (!hasWalletReaderKey) {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON is required when no wallet reader key is provided.',
      );
    }

    if (walletReaderDid && walletReaderKeyRaw) {
      const normalizedWalletReaderKey = this.resolveReaderX25519PublicKey(walletReaderKeyRaw);
      if (!normalizedWalletReaderKey) {
        throw new BadRequestException('walletReaderX25519PublicKey must be a valid X25519 public key.');
      }
      readerPublicKeys[walletReaderDid] = normalizedWalletReaderKey;
    }
    const effectiveAuthorizedReaders = authorizedReaders.filter((readerId) => Boolean(readerPublicKeys[readerId]));
    if (effectiveAuthorizedReaders.length === 0) {
      throw new BadRequestException(
        'No valid hybrid authorized readers could be resolved. Provide X25519 public keys via env JSON or wallet reader metadata.',
      );
    }
    const plaintext = Buffer.from(this.canonicalJson(signedOnboardingPayload), 'utf8');
    const dek = randomBytes(32);
    const payloadNonce = randomBytes(12);
    const payloadCipher = createCipheriv('chacha20-poly1305', dek, payloadNonce, { authTagLength: 16 });
    const payloadCiphertext = Buffer.concat([payloadCipher.update(plaintext), payloadCipher.final(), payloadCipher.getAuthTag()]);
    const wrapAlgorithm = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_WRAP_ALGORITHM?.trim()
      || 'x25519-chacha20poly1305';

    const keyWrappedSecrets = effectiveAuthorizedReaders.map((readerId) => {
      const readerPublicKeyHex = readerPublicKeys[readerId];
      return {
        reader_id: readerId,
        wrapped_dek: this.wrapDekForReader({
          dek,
          authorPrivateKey,
          readerPublicKeyHex,
          wrapContext: `${entryId}:${readerId}`,
        }),
        wrap_algorithm: wrapAlgorithm,
      };
    });

    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = Number.parseInt(
      process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_CONSENT_TTL_SECONDS?.trim() ?? '31536000',
      10,
    );
    const normalizedTtlSeconds = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 31536000;
    const policyRef = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_POLICY_REF?.trim()
      || 'policy:onboarding:hybrid:v1';

    return {
      entryPrivacy: {
        privacy_flag: true,
        privacy_mode: 'hybrid',
        payload_commitment: payloadCommitment,
        ciphertext_hex: payloadCiphertext.toString('hex'),
        nonce_hex: payloadNonce.toString('hex'),
        authorized_readers: effectiveAuthorizedReaders,
        key_wrapped_secrets: keyWrappedSecrets,
        consent_receipt: {
          subject_did: subjectDid,
          data_hash: payloadCommitment,
          policy_ref: policyRef,
          granted_at: now,
          expires_at: now + normalizedTtlSeconds,
          authorized_readers: effectiveAuthorizedReaders,
          field_reader_acls: {},
        },
      },
      hybridAuthorX25519PublicKeyHex: authorPublicKeyHex,
    };
  }

  private resolveHybridAuthorX25519KeyPair(): { privateKey: KeyObject; publicKeyHex: string } {
    const configured = process.env.CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX?.trim();
    if (configured) {
      try {
        const privateKey = this.parseX25519PrivateKey(configured);
        return {
          privateKey,
          publicKeyHex: this.exportX25519PublicKeyHex(privateKey),
        };
      } catch (error) {
        this.logger.warn(
          `Invalid CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX. `
          + `Falling back to ephemeral per-entry X25519 keypair. reason=${this.toErrorMessage(error)}`,
        );
      }
    }

    const { privateKey } = generateKeyPairSync('x25519');
    return {
      privateKey,
      publicKeyHex: this.exportX25519PublicKeyHex(privateKey),
    };
  }

  private parseReaderX25519PublicKeys(rawValue: string): Record<string, string> {
    try {
      const parsed = JSON.parse(rawValue) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).map(([readerId, value]) => {
          const normalized = this.resolveReaderX25519PublicKey(value);
          if (!normalized) {
            throw new BadRequestException(
              `Invalid X25519 reader public key for ${readerId}. `
              + 'Provide x25519 public key (hex/0x/did:key/PEM), '
              + 'or provide object with signer_0x plus x25519_public_key.',
            );
          }
          return [readerId, normalized];
        }),
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_READER_X25519_PUBLIC_KEYS_JSON must be a valid JSON object.',
      );
    }
  }

  private resolveReaderX25519PublicKey(value: unknown): string | null {
    if (typeof value === 'string') {
      const normalized = this.normalizeX25519PublicKeyHex(value);
      if (normalized) {
        return normalized;
      }
      return this.deriveX25519PublicKeyFromPrivateHex(value);
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const objectValue = value as Record<string, unknown>;
    const publicKeyCandidate = objectValue.x25519_public_key
      ?? objectValue.x25519PublicKey
      ?? objectValue.encryption_public_key
      ?? objectValue.encryptionPublicKey;
    if (typeof publicKeyCandidate === 'string') {
      const normalized = this.normalizeX25519PublicKeyHex(publicKeyCandidate);
      if (normalized) {
        return normalized;
      }
    }

    const privateKeyCandidate = objectValue.x25519_private_key
      ?? objectValue.x25519PrivateKey
      ?? objectValue.encryption_private_key
      ?? objectValue.encryptionPrivateKey;
    if (typeof privateKeyCandidate === 'string') {
      return this.deriveX25519PublicKeyFromPrivateHex(privateKeyCandidate);
    }

    return null;
  }

  private parseX25519PrivateKey(privateKeyValue: string): KeyObject {
    const normalizedHex = privateKeyValue.trim().replace(/^0x/i, '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(normalizedHex)) {
      const der = Buffer.concat([
        Buffer.from(X25519_PKCS8_DER_PREFIX_HEX, 'hex'),
        Buffer.from(normalizedHex, 'hex'),
      ]);
      return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }

    try {
      const pem = this.normalizePemValue(privateKeyValue);
      const privateKey = createPrivateKey({ key: pem, format: 'pem' });
      const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
      const x25519Prefix = Buffer.from(X25519_SPKI_DER_PREFIX_HEX, 'hex');
      if (publicDer.subarray(0, x25519Prefix.length).equals(x25519Prefix)) {
        return privateKey;
      }
    } catch {
      // fallthrough to final validation error
    }

    throw new BadRequestException(
      'CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHOR_X25519_PRIVATE_KEY_HEX must be 32-byte hex (optionally prefixed with 0x) or a valid X25519 PEM private key.',
    );
  }

  private exportX25519PublicKeyHex(privateKey: KeyObject): string {
    const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    const spkiPrefix = Buffer.from(X25519_SPKI_DER_PREFIX_HEX, 'hex');
    const rawPublicKey = publicDer.subarray(spkiPrefix.length);
    if (rawPublicKey.length !== 32) {
      throw new BadRequestException('Derived X25519 public key length is invalid.');
    }
    return rawPublicKey.toString('hex');
  }

  private createX25519PublicKeyFromHex(publicKeyHex: string): KeyObject {
    const normalized = this.normalizeX25519PublicKeyHex(publicKeyHex);
    if (!normalized) {
      throw new BadRequestException('X25519 reader public key must be 32-byte hex.');
    }
    const der = Buffer.concat([
      Buffer.from(X25519_SPKI_DER_PREFIX_HEX, 'hex'),
      Buffer.from(normalized, 'hex'),
    ]);
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  }

  private normalizeX25519PublicKeyHex(publicKeyValue: string): string | null {
    const normalized = publicKeyValue.trim();
    const didSegments = normalized.split(':');
    const didTail = didSegments[didSegments.length - 1] ?? '';
    const candidates = [
      normalized,
      normalized.replace(/^0x/i, ''),
      didTail,
      didTail.replace(/^0x/i, ''),
    ];
    for (const candidate of candidates) {
      if (/^[a-f0-9]{64}$/i.test(candidate)) {
        return candidate.toLowerCase();
      }
    }

    if (normalized.includes('BEGIN PUBLIC KEY')) {
      try {
        const pem = this.normalizePemValue(normalized);
        const publicDer = createPublicKey({ key: pem, format: 'pem' }).export({ format: 'der', type: 'spki' }) as Buffer;
        const spkiPrefix = Buffer.from(X25519_SPKI_DER_PREFIX_HEX, 'hex');
        const rawPublicKey = publicDer.subarray(spkiPrefix.length);
        if (publicDer.subarray(0, spkiPrefix.length).equals(spkiPrefix) && rawPublicKey.length === 32) {
          return rawPublicKey.toString('hex');
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  private deriveX25519PublicKeyFromPrivateHex(privateKeyValue: string): string | null {
    const normalized = privateKeyValue.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      return null;
    }
    try {
      const privateKey = this.parseX25519PrivateKey(normalized);
      return this.exportX25519PublicKeyHex(privateKey);
    } catch {
      return null;
    }
  }

  private wrapDekForReader(params: {
    dek: Buffer;
    authorPrivateKey: KeyObject;
    readerPublicKeyHex: string;
    wrapContext: string;
  }): string {
    const readerPublicKey = this.createX25519PublicKeyFromHex(params.readerPublicKeyHex);
    const sharedSecret = diffieHellman({
      privateKey: params.authorPrivateKey,
      publicKey: readerPublicKey,
    });
    const wrapKey = createHash('sha256').update(sharedSecret).digest();
    const nonceInput = Buffer.concat([
      sharedSecret,
      params.dek,
      Buffer.from(params.wrapContext, 'utf8'),
    ]);
    const nonce = createHash('sha256').update(nonceInput).digest().subarray(0, 12);
    const cipher = createCipheriv('chacha20-poly1305', wrapKey, nonce, { authTagLength: 16 });
    const wrappedCiphertext = Buffer.concat([
      cipher.update(params.dek),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return Buffer.concat([nonce, wrappedCiphertext]).toString('hex');
  }

  private parseRuntimeSigningPrivateKey(privateKeyPem: string) {
    try {
      return createPrivateKey({
        key: privateKeyPem,
        format: 'pem',
      });
    } catch {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM must be a valid PEM-encoded Ed25519 private key.',
      );
    }
  }

  private normalizePemValue(privateKeyPem: string): string {
    const maybeQuotedPem = privateKeyPem.trim();
    const unquotedPem = maybeQuotedPem.length > 1
      && ((maybeQuotedPem.startsWith('"') && maybeQuotedPem.endsWith('"'))
        || (maybeQuotedPem.startsWith('\'') && maybeQuotedPem.endsWith('\'')))
      ? maybeQuotedPem.slice(1, -1)
      : maybeQuotedPem;

    return unquotedPem.replace(/\\n/g, '\n');
  }

  private exportEd25519PublicKeyHex(privateKey: KeyObject): string {
    try {
      const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
      const spkiPrefix = Buffer.from(ED25519_SPKI_DER_PREFIX_HEX, 'hex');
      const rawPublicKey = publicKeyDer.subarray(spkiPrefix.length);
      if (rawPublicKey.length !== 32) {
        throw new Error('invalid key length');
      }
      return rawPublicKey.toString('hex');
    } catch {
      throw new BadRequestException(
        'CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM must be a valid Ed25519 keypair.',
      );
    }
  }

  private getRelayRetryPolicy(): { maxAttempts: number; retryBackoffMs: number } {
    const maxAttemptsRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_MAX_ATTEMPTS;
    const retryBackoffRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_RETRY_BACKOFF_MS;

    const maxAttempts = Number.parseInt(maxAttemptsRaw ?? `${DEFAULT_RELAY_MAX_ATTEMPTS}`, 10);
    const retryBackoffMs = Number.parseInt(retryBackoffRaw ?? `${DEFAULT_RELAY_RETRY_BACKOFF_MS}`, 10);

    return {
      maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_RELAY_MAX_ATTEMPTS,
      retryBackoffMs: Number.isFinite(retryBackoffMs) && retryBackoffMs >= 0
        ? retryBackoffMs
        : DEFAULT_RELAY_RETRY_BACKOFF_MS,
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private async extractRelayErrorDetail(response: Response): Promise<string | null> {
    try {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const json = await response.json() as Record<string, unknown>;
        const detail = json.detail ?? json.error ?? json.message;
        if (typeof detail === 'string' && detail.trim().length > 0) {
          return detail.trim().slice(0, 320);
        }
        return JSON.stringify(json).slice(0, 320);
      }

      const text = (await response.text()).trim();
      if (!text) {
        return null;
      }
      return text.slice(0, 320);
    } catch {
      return null;
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private assertRelayMetadata(payload: CreateLeadDto): void {
    const computedPayloadHash = `sha256:${createHash('sha256').update(payload.walletSigningPayload).digest('hex')}`;

    if (computedPayloadHash.toLowerCase() !== payload.walletPayloadHash.toLowerCase()) {
      throw new BadRequestException('walletPayloadHash does not match walletSigningPayload for relay metadata.');
    }

    const expectedDid = `did:key:ed25519:${payload.walletVerifyingKey.toLowerCase()}`;
    if (payload.walletSignerDid.toLowerCase() !== expectedDid) {
      throw new BadRequestException('walletSignerDid does not match walletVerifyingKey for relay metadata.');
    }
  }

  private getValidatedRelayUrl(): URL | null {
    const relayUrlRaw = process.env.CITIZEN_SIGNED_SUBMISSION_RELAY_URL?.trim();
    if (!relayUrlRaw) {
      return null;
    }

    let relayUrl: URL;
    try {
      relayUrl = new URL(relayUrlRaw);
    } catch {
      throw new BadRequestException('CITIZEN_SIGNED_SUBMISSION_RELAY_URL must be a valid absolute URL.');
    }

    if (!['http:', 'https:'].includes(relayUrl.protocol)) {
      throw new BadRequestException('CITIZEN_SIGNED_SUBMISSION_RELAY_URL must use http or https.');
    }

    if (!relayUrl.hostname) {
      throw new BadRequestException('CITIZEN_SIGNED_SUBMISSION_RELAY_URL must include a hostname.');
    }

    relayUrl.hash = '';
    return relayUrl;
  }

  private resolveRelayMode(relayUrlRaw?: string): 'database_only' | 'database_plus_network_relay' | 'invalid_relay_configuration' {
    if (!relayUrlRaw) {
      return 'database_only';
    }

    try {
      const relayUrl = new URL(relayUrlRaw);
      if (!['http:', 'https:'].includes(relayUrl.protocol) || !relayUrl.hostname) {
        return 'invalid_relay_configuration';
      }
      return 'database_plus_network_relay';
    } catch {
      return 'invalid_relay_configuration';
    }
  }

  private normalizeRole(role: string, formSettings: FormSettings): string {
    const normalizedRole = role.trim().toLowerCase();
    const validRoles = new Set(formSettings.roles.map((item) => item.id));

    if (!validRoles.has(normalizedRole)) {
      throw new BadRequestException('Selected onboarding role is not supported.');
    }

    return normalizedRole;
  }

  async stats() {
    const total = await this.leadRepository.count();
    const relay = this.getRelaySubmissionTelemetrySnapshot();
    return {
      totalInterestSubmissions: total,
      relaySubmissionTelemetry: relay,
    };
  }

  private getRelaySubmissionTelemetrySnapshot(): {
    totalRelaySubmissions: number;
    failedRelaySubmissions: number;
    relayDirectSubmitFailureRate: number | null;
  } {
    const { totalRelaySubmissions, failedRelaySubmissions } = this.relaySubmissionTelemetry;
    const relayDirectSubmitFailureRate = totalRelaySubmissions > 0
      ? Number((failedRelaySubmissions / totalRelaySubmissions).toFixed(4))
      : null;
    return {
      totalRelaySubmissions,
      failedRelaySubmissions,
      relayDirectSubmitFailureRate,
    };
  }

  private recordRelaySubmissionOutcome(outcome: 'success' | 'failure'): void {
    this.relaySubmissionTelemetry.totalRelaySubmissions += 1;
    if (outcome === 'failure') {
      this.relaySubmissionTelemetry.failedRelaySubmissions += 1;
    }
  }

  async submissions(): Promise<LeadInterest[]> {
    return this.leadRepository.find({
      order: {
        createdAt: 'DESC',
      },
      take: 100,
    });
  }

  async deleteSubmission(id: string): Promise<{ deleted: true }> {
    const result = await this.leadRepository.delete({ id });

    if (!result.affected) {
      throw new NotFoundException('Submission not found.');
    }

    return { deleted: true };
  }

  private normalizeCampaignCards(campaignCards: FormSettings['campaignCards']): FormSettings['campaignCards'] {
    return campaignCards
      .map((card, index) => {
        const rawWeight = typeof card.weight === 'number' ? card.weight : index + 1;
        return {
          ...card,
          eyebrow: (card.eyebrow ?? 'citizen-protocol-v0.1.0').trim(),
          title: card.title.trim(),
          body: card.body.trim(),
          weight: Math.max(1, Math.trunc(rawWeight)),
        };
      })
      .filter((card) => card.eyebrow && card.title && card.body)
      .sort((a, b) => a.weight - b.weight)
      .map((card, index) => ({ ...card, weight: index + 1 }));
  }

  private normalizeRoleOptions(roleOptions: FormSettings['roles']): FormSettings['roles'] {
    const normalizedRoles = roleOptions
      .map((role, index) => {
        const normalizedId = role.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        const rawWeight = typeof role.weight === 'number' ? role.weight : index + 1;
        return {
          ...role,
          id: normalizedId || `role-${index + 1}`,
          label: role.label.trim(),
          prompt: role.prompt.trim(),
          thankYouNote: role.thankYouNote.trim(),
          weight: Math.max(1, Math.trunc(rawWeight)),
        };
      })
      .filter((role) => role.label && role.prompt && role.thankYouNote)
      .sort((a, b) => a.weight - b.weight);

    const uniqueIds = new Set<string>();
    return normalizedRoles.map((role, index) => {
      let id = role.id;
      while (uniqueIds.has(id)) {
        id = `${role.id}-${index + 1}`;
      }
      uniqueIds.add(id);
      return { ...role, id, weight: index + 1 };
    });
  }

  private normalizeBrandText(value: string | undefined): string {
    const trimmed = (value ?? '').trim();
    return trimmed || 'Citizen';
  }

  private normalizeShortcode(value: string | undefined): string {
    const raw = (value ?? '').trim().toLowerCase();
    const token = raw
      .replace(/^\[asciinema:/, '')
      .replace(/\]$/, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

    return token || 'onboarding-demo';
  }

  async getFormSettings(): Promise<FormSettings> {
    const existing = await this.formSettingsRepository.findOne({ where: { id: 'default' } });

    if (existing) {
      let needsSave = false;

      existing.siteLogoUrl = (existing.siteLogoUrl ?? '').trim();
      existing.siteLogoAlt = this.normalizeBrandText(existing.siteLogoAlt);
      existing.siteName = this.normalizeBrandText(existing.siteName);

      if (!Array.isArray(existing.campaignCards) || existing.campaignCards.length === 0) {
        existing.campaignCards = DEFAULT_CAMPAIGN_CARDS;
        needsSave = true;
      } else {
        existing.campaignCards = this.normalizeCampaignCards(existing.campaignCards);
      }

      if (!Array.isArray(existing.roles) || existing.roles.length === 0) {
        existing.roles = DEFAULT_ROLE_OPTIONS;
        needsSave = true;
      } else {
        existing.roles = this.normalizeRoleOptions(existing.roles);
      }

      return needsSave ? this.formSettingsRepository.save(existing) : existing;
    }

    const created = this.formSettingsRepository.create({
      id: 'default',
      siteLogoUrl: '',
      siteLogoAlt: 'Citizen',
      siteName: 'Citizen',
      campaignCards: DEFAULT_CAMPAIGN_CARDS,
      roles: DEFAULT_ROLE_OPTIONS,
    });
    return this.formSettingsRepository.save(created);
  }

  async getAsciinemaRecordings(): Promise<AsciinemaRecording[]> {
    return this.asciinemaRecordingRepository.find({
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  async getAsciinemaShortcodeMap(): Promise<Record<string, string>> {
    const recordings = await this.getAsciinemaRecordings();
    return recordings.reduce<Record<string, string>>((accumulator, recording) => {
      accumulator[recording.shortcode] = recording.castUrl;
      return accumulator;
    }, {});
  }

  async uploadAsciinemaRecording(castUrl: string, shortcode: string, filename: string, label?: string): Promise<AsciinemaRecording> {
    const normalizedShortcode = this.normalizeShortcode(shortcode);
    const normalizedUrl = castUrl.trim();

    if (!normalizedUrl) {
      throw new BadRequestException('Cast URL is required.');
    }

    const existing = await this.asciinemaRecordingRepository.findOne({
      where: {
        shortcode: normalizedShortcode,
      },
    });

    if (existing) {
      existing.castUrl = normalizedUrl;
      existing.filename = filename;
      existing.label = label?.trim() ?? existing.label;
      return this.asciinemaRecordingRepository.save(existing);
    }

    const recording = this.asciinemaRecordingRepository.create({
      shortcode: normalizedShortcode,
      castUrl: normalizedUrl,
      filename,
      label: label?.trim() ?? '',
    });

    return this.asciinemaRecordingRepository.save(recording);
  }

  async deleteAsciinemaRecording(id: string): Promise<{ deleted: true }> {
    const result = await this.asciinemaRecordingRepository.delete({ id });

    if (!result.affected) {
      throw new NotFoundException('Recording not found.');
    }

    return { deleted: true };
  }

  async updateFormSettings(payload: UpdateFormSettingsDto): Promise<FormSettings> {
    const current = await this.getFormSettings();

    if (payload.title !== undefined) {
      current.title = payload.title.trim();
    }

    if (payload.subtitle !== undefined) {
      current.subtitle = payload.subtitle.trim();
    }

    if (payload.siteLogoUrl !== undefined) {
      current.siteLogoUrl = payload.siteLogoUrl.trim();
    }

    if (payload.siteLogoAlt !== undefined) {
      current.siteLogoAlt = this.normalizeBrandText(payload.siteLogoAlt);
    }

    if (payload.siteName !== undefined) {
      current.siteName = this.normalizeBrandText(payload.siteName);
    }

    if (payload.campaignCards !== undefined) {
      current.campaignCards = this.normalizeCampaignCards(payload.campaignCards);
    }

    if (payload.roles !== undefined) {
      current.roles = this.normalizeRoleOptions(payload.roles);
    }

    return this.formSettingsRepository.save(current);
  }

  async uploadSiteLogo(siteLogoUrl: string, siteLogoAlt?: string): Promise<FormSettings> {
    const current = await this.getFormSettings();
    const previousSiteLogoUrl = current.siteLogoUrl;

    current.siteLogoUrl = siteLogoUrl.trim();

    if (siteLogoAlt !== undefined) {
      current.siteLogoAlt = this.normalizeBrandText(siteLogoAlt);
    }

    const saved = await this.formSettingsRepository.save(current);

    if (previousSiteLogoUrl && previousSiteLogoUrl !== saved.siteLogoUrl && previousSiteLogoUrl.startsWith('/uploads/site-branding/')) {
      const previousPath = previousSiteLogoUrl.replace(/^\//, '');
      await unlink(previousPath).catch(() => undefined);
    }

    return saved;
  }
}
