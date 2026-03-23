import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth.module';
import { EmailTemplate } from './email-template.entity';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { OnboardingNotificationService } from './onboarding-notification.service';
import { SmtpSettings } from './smtp-settings.entity';
import { SmtpSettingsService } from './smtp-settings.service';
import { EmailTemplateService } from './email-template.service';

@Module({
  imports: [TypeOrmModule.forFeature([SmtpSettings, EmailTemplate]), AuthModule],
  controllers: [MailController],
  providers: [SmtpSettingsService, EmailTemplateService, MailService, OnboardingNotificationService],
  exports: [SmtpSettingsService, EmailTemplateService, MailService, OnboardingNotificationService],
})
export class MailModule {}
