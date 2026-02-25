import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadInterest } from './lead.entity';
import { FormSettings } from './form-settings.entity';
import { UpdateFormSettingsDto } from './dto/update-form-settings.dto';

const DEFAULT_CAMPAIGN_CARDS = [
  {
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
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
    const lead = this.leadRepository.create(payload);
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

  async getFormSettings(): Promise<FormSettings> {
    const existing = await this.formSettingsRepository.findOne({ where: { id: 'default' } });

    if (existing) {
      if (!Array.isArray(existing.campaignCards) || existing.campaignCards.length === 0) {
        existing.campaignCards = DEFAULT_CAMPAIGN_CARDS;
        return this.formSettingsRepository.save(existing);
      }
      return existing;
    }

    const created = this.formSettingsRepository.create({ id: 'default', campaignCards: DEFAULT_CAMPAIGN_CARDS });
    return this.formSettingsRepository.save(created);
  }

  async updateFormSettings(payload: UpdateFormSettingsDto): Promise<FormSettings> {
    const settings = await this.getFormSettings();
    const updated = this.formSettingsRepository.merge(settings, payload);
    return this.formSettingsRepository.save(updated);
  }
}
