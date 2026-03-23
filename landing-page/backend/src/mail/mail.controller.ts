import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { EmailTemplateService } from './email-template.service';
import { MailService } from './mail.service';
import { OnboardingUpdateDto } from './dto/onboarding-update.dto';
import { SmtpSettingsService } from './smtp-settings.service';
import { TestSmtpSettingsDto } from './dto/test-smtp-settings.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { UpdateSmtpSettingsDto } from './dto/update-smtp-settings.dto';
import { OnboardingNotificationService } from './onboarding-notification.service';

@Controller('admin/email')
@UseGuards(JwtAuthGuard)
export class MailController {
  constructor(
    private readonly smtpSettingsService: SmtpSettingsService,
    private readonly emailTemplateService: EmailTemplateService,
    private readonly mailService: MailService,
    private readonly onboardingNotificationService: OnboardingNotificationService,
  ) {}

  @Get('smtp-settings')
  async getSmtpSettings() {
    const stored = await this.smtpSettingsService.getStoredSettings();
    const resolved = await this.smtpSettingsService.resolveSettings(true);
    return {
      ...stored,
      password: stored.password ? '********' : '',
      resolvedSource: resolved.source,
    };
  }

  @Put('smtp-settings')
  updateSmtpSettings(@Body() payload: UpdateSmtpSettingsDto) {
    return this.smtpSettingsService.updateSettings(payload);
  }

  @Post('smtp-settings/test')
  async testSmtpSettings(@Body() payload: TestSmtpSettingsDto) {
    const result = await this.mailService.sendMail({
      to: payload.to,
      subject: 'Citizen onboarding SMTP test',
      html: '<p>This is a test email from the Citizen onboarding admin console.</p>',
    });

    return { ok: true, ...result };
  }

  @Get('templates')
  listTemplates() {
    return this.emailTemplateService.listTemplates();
  }

  @Get('templates/:type')
  getTemplate(@Param('type') type: string) {
    return this.emailTemplateService.getTemplate(type);
  }

  @Put('templates/:type')
  updateTemplate(@Param('type') type: string, @Body() payload: UpdateEmailTemplateDto) {
    return this.emailTemplateService.upsertTemplate(type, payload);
  }

  @Post('templates/:type/reset')
  resetTemplate(@Param('type') type: string) {
    return this.emailTemplateService.resetTemplate(type);
  }

  @Get('onboarding-updates/audience')
  previewAudience(@Query('role') role?: string, @Query('search') search?: string) {
    return this.onboardingNotificationService.previewOnboardingUpdate({
      audienceMode: role?.trim() ? 'role' : 'all',
      role,
      search,
      messageHtml: '<p>Audience preview</p>',
      includeAdminDashboardLink: false,
    });
  }

  @Post('onboarding-updates/preview')
  previewOnboardingUpdate(@Body() payload: OnboardingUpdateDto) {
    return this.onboardingNotificationService.previewOnboardingUpdate(payload);
  }

  @Post('onboarding-updates/send')
  sendOnboardingUpdate(@Body() payload: OnboardingUpdateDto) {
    return this.onboardingNotificationService.sendOnboardingUpdate(payload);
  }
}
