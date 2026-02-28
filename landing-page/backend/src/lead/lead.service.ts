import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadInterest } from './lead.entity';
import { FormSettings } from './form-settings.entity';
import { UpdateFormSettingsDto } from './dto/update-form-settings.dto';

const DEFAULT_CAMPAIGN_CARDS = [
  {
    weight: 1,
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    weight: 2,
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
    weight: 3,
    title: 'What we are solving',
    body: 'We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies.',
  },
];


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
  constructor(
    @InjectRepository(LeadInterest)
    private readonly leadRepository: Repository<LeadInterest>,
    @InjectRepository(FormSettings)
    private readonly formSettingsRepository: Repository<FormSettings>,
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

    const lead = this.leadRepository.create({
      ...payload,
      email: normalizedEmail,
    });

    return this.leadRepository.save(lead);
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
          weight: Math.max(1, Math.trunc(rawWeight)),
        };
      })
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

      if (typeof existing.asciinemaCastUrl !== 'string') {
        existing.asciinemaCastUrl = '';
        needsSave = true;
      }

      const normalizedShortcode = this.normalizeShortcode(existing.asciinemaShortcode);
      if (existing.asciinemaShortcode !== normalizedShortcode) {
        existing.asciinemaShortcode = normalizedShortcode;
        needsSave = true;
      }

      return needsSave ? this.formSettingsRepository.save(existing) : existing;
    }

    const created = this.formSettingsRepository.create({
      id: 'default',
      campaignCards: DEFAULT_CAMPAIGN_CARDS,
      roles: DEFAULT_ROLE_OPTIONS,
      asciinemaCastUrl: '',
      asciinemaShortcode: 'onboarding-demo',
    });
    return this.formSettingsRepository.save(created);
  }


  async setAsciinemaCastUrl(asciinemaCastUrl: string): Promise<FormSettings> {
    const settings = await this.getFormSettings();
    settings.asciinemaCastUrl = asciinemaCastUrl.trim();
    settings.asciinemaShortcode = this.normalizeShortcode(settings.asciinemaShortcode);
    return this.formSettingsRepository.save(settings);
  }

  async updateFormSettings(payload: UpdateFormSettingsDto): Promise<FormSettings> {
    const settings = await this.getFormSettings();
    const sanitizedPayload = {
      ...payload,
      campaignCards: payload.campaignCards
        ? this.normalizeCampaignCards(payload.campaignCards)
        : payload.campaignCards,
      roles: payload.roles
        ? this.normalizeRoleOptions(payload.roles)
        : payload.roles,
      asciinemaShortcode: payload.asciinemaShortcode
        ? this.normalizeShortcode(payload.asciinemaShortcode)
        : payload.asciinemaShortcode,
    };
    const updated = this.formSettingsRepository.merge(settings, sanitizedPayload);
    return this.formSettingsRepository.save(updated);
  }
}
