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

  @Get('signed-submission-contract')
  getSignedSubmissionContract() {
    return this.leadService.getSignedSubmissionContract();
  }

  @Get('asciinema-recordings/public')
  getAsciinemaPublicMap() {
    return this.leadService.getAsciinemaShortcodeMap();
  }

  @UseGuards(JwtAuthGuard)
  @Get('asciinema-recordings')
  getAsciinemaRecordings() {
    return this.leadService.getAsciinemaRecordings();
  }

  @UseGuards(JwtAuthGuard)
  @Post('site-logo/upload')
  @UseInterceptors(FileInterceptor('logoFile', {
    storage: diskStorage({
      destination: 'uploads/site-branding',
      filename: (_request: unknown, file: { originalname: string }, callback: (error: Error | null, filename: string) => void) => {
        const extension = extname(file.originalname).toLowerCase();
        const safeExtension = ['.png', '.apng', '.jpg', '.jpeg', '.svg', '.webp'].includes(extension) ? extension : '.png';
        callback(null, `site-logo-${Date.now()}${safeExtension}`);
      },
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_request: unknown, file: { mimetype: string; originalname: string }, callback: (error: Error | null, acceptFile: boolean) => void) => {
      const allowedMimeTypes = ['image/png', 'image/apng', 'image/jpeg', 'image/svg+xml', 'image/webp'];
      const extension = extname(file.originalname).toLowerCase();
      const allowedExtensions = ['.png', '.apng', '.jpg', '.jpeg', '.svg', '.webp'];

      if (!allowedMimeTypes.includes(file.mimetype) || !allowedExtensions.includes(extension)) {
        callback(new BadRequestException('Only PNG, APNG, JPG, SVG, and WEBP logo files are supported.'), false);
        return;
      }

      callback(null, true);
    },
  }))
  uploadSiteLogo(
    @UploadedFile() logoFile?: { filename: string },
    @Body() payload?: { altText?: string },
  ) {
    if (!logoFile) {
      throw new BadRequestException('Missing logoFile upload.');
    }

    return this.leadService.uploadSiteLogo(
      `/uploads/site-branding/${logoFile.filename}`,
      payload?.altText,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('asciinema-recordings/upload')
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
  uploadAsciinemaCast(
    @UploadedFile() castFile?: { filename: string },
    @Body() payload?: { shortcode?: string; label?: string },
  ) {
    if (!castFile) {
      throw new BadRequestException('Missing castFile upload.');
    }

    return this.leadService.uploadAsciinemaRecording(
      `/uploads/casts/${castFile.filename}`,
      payload?.shortcode ?? '',
      castFile.filename,
      payload?.label,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('asciinema-recordings/:id')
  deleteAsciinemaRecording(@Param('id') id: string) {
    return this.leadService.deleteAsciinemaRecording(id);
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
