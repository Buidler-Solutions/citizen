import { Body, Controller, Get, Post } from '@nestjs/common';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadService } from './lead.service';

@Controller('interest')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Post()
  create(@Body() payload: CreateLeadDto) {
    return this.leadService.create(payload);
  }

  @Get('stats')
  stats() {
    return this.leadService.stats();
  }
}
