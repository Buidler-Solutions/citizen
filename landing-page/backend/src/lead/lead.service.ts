import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadInterest } from './lead.entity';
import { FormSettings } from './form-settings.entity';
import { UpdateFormSettingsDto } from './dto/update-form-settings.dto';

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
      return existing;
    }

    const created = this.formSettingsRepository.create({ id: 'default' });
    return this.formSettingsRepository.save(created);
  }

  async updateFormSettings(payload: UpdateFormSettingsDto): Promise<FormSettings> {
    const settings = await this.getFormSettings();
    const updated = this.formSettingsRepository.merge(settings, payload);
    return this.formSettingsRepository.save(updated);
  }
}
