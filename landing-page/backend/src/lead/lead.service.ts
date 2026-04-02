import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { unlink } from 'fs/promises';
import { createHash, createPublicKey, randomUUID, verify } from 'crypto';
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

    const relayPayload = {
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
          throw new BadRequestException(
            `Citizen network relay rejected signed onboarding payload (trace_id=${relayTraceId}, status=${response.status}).`,
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
    return { totalInterestSubmissions: total };
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
