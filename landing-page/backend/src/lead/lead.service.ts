import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadInterest } from './lead.entity';

@Injectable()
export class LeadService {
  constructor(
    @InjectRepository(LeadInterest)
    private readonly leadRepository: Repository<LeadInterest>,
  ) {}

  async create(payload: CreateLeadDto): Promise<LeadInterest> {
    const lead = this.leadRepository.create(payload);
    return this.leadRepository.save(lead);
  }

  async stats() {
    const total = await this.leadRepository.count();
    return { totalInterestSubmissions: total };
  }
}
