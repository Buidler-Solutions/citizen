import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadService } from './lead.service';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { UpdateFormSettingsDto } from './dto/update-form-settings.dto';

@Controller('interest')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Post()
  create(@Body() payload: CreateLeadDto) {
    return this.leadService.create(payload);
  }

  @Get('form-settings')
  getFormSettings() {
    return this.leadService.getFormSettings();
  }

  @UseGuards(JwtAuthGuard)
  @Put('form-settings')
  updateFormSettings(@Body() payload: UpdateFormSettingsDto) {
    return this.leadService.updateFormSettings(payload);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  stats() {
    return this.leadService.stats();
  }

  @UseGuards(JwtAuthGuard)
  @Get('submissions')
  submissions() {
    return this.leadService.submissions();
  }

  @UseGuards(JwtAuthGuard)
  @Delete('submissions/:id')
  deleteSubmission(@Param('id') id: string) {
    return this.leadService.deleteSubmission(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('submissions/:id/delete')
  deleteSubmissionFallback(@Param('id') id: string) {
    return this.leadService.deleteSubmission(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('submissions/:id')
  deleteSubmissionLegacy(@Param('id') id: string) {
    return this.leadService.deleteSubmission(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('submissions/delete')
  deleteSubmissionByBody(@Body() payload: { id: string }) {
    return this.leadService.deleteSubmission(payload.id);
  }
}
