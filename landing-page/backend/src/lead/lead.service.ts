import { ConflictException, Injectable } from '@nestjs/common';
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

  async getFormSettings(): Promise<FormSettings> {
    const existing = await this.formSettingsRepository.findOne({ where: { id: 'default' } });

    if (existing) {
      if (!Array.isArray(existing.campaignCards) || existing.campaignCards.length === 0) {
        existing.campaignCards = DEFAULT_CAMPAIGN_CARDS;
        return this.formSettingsRepository.save(existing);
      }

      existing.campaignCards = this.normalizeCampaignCards(existing.campaignCards);
      return existing;
    }

    const created = this.formSettingsRepository.create({ id: 'default', campaignCards: DEFAULT_CAMPAIGN_CARDS });
    return this.formSettingsRepository.save(created);
  }

  async updateFormSettings(payload: UpdateFormSettingsDto): Promise<FormSettings> {
    const settings = await this.getFormSettings();
    const sanitizedPayload = {
      ...payload,
      campaignCards: payload.campaignCards
        ? this.normalizeCampaignCards(payload.campaignCards)
        : payload.campaignCards,
    };
    const updated = this.formSettingsRepository.merge(settings, sanitizedPayload);
    return this.formSettingsRepository.save(updated);
  }
}
