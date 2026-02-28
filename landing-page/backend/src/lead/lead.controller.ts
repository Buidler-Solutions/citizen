import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { extname } from 'path';
import { diskStorage } from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
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
  @Post('form-settings/asciinema-upload')
  @UseInterceptors(FileInterceptor('castFile', {
    storage: diskStorage({
      destination: 'uploads/casts',
      filename: (_request: unknown, file: { originalname: string }, callback: (error: Error | null, filename: string) => void) => {
        const extension = extname(file.originalname) || '.cast';
        const safeExtension = extension.toLowerCase() === '.cast' ? '.cast' : '.json';
        callback(null, `onboarding-${Date.now()}${safeExtension}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_request: unknown, file: { originalname: string }, callback: (error: Error | null, acceptFile: boolean) => void) => {
      if (!file.originalname.toLowerCase().endsWith('.cast') && !file.originalname.toLowerCase().endsWith('.json')) {
        callback(new BadRequestException('Only .cast/.json files are supported.'), false);
        return;
      }
      callback(null, true);
    },
  }))
  uploadAsciinemaCast(@UploadedFile() castFile?: { filename: string }) {
    if (!castFile) {
      throw new BadRequestException('Missing castFile upload.');
    }

    return this.leadService.setAsciinemaCastUrl(`/uploads/casts/${castFile.filename}`);
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
