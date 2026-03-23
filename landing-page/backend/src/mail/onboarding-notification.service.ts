import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FormSettings } from '../lead/form-settings.entity';
import { LeadInterest } from '../lead/lead.entity';
import { EmailTemplateService } from './email-template.service';
import { MailService } from './mail.service';

@Injectable()
export class OnboardingNotificationService {
  private readonly logger = new Logger(OnboardingNotificationService.name);

  constructor(
    private readonly emailTemplateService: EmailTemplateService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  async sendLeadSubmissionNotifications(lead: LeadInterest, formSettings: FormSettings): Promise<void> {
    const role = formSettings.roles.find((item) => item.id === lead.role);
    const roleLabel = role?.label ?? this.humanizeRole(lead.role);
    const thankYouNote = role?.thankYouNote ?? 'Thank you for your interest in Citizen. We will send onboarding updates by email.';
    const siteName = formSettings.siteName?.trim() || 'Citizen';
    const supportEmail = this.configService.get<string>('ONBOARDING_SUPPORT_EMAIL', '').trim().toLowerCase();
    const adminDashboardLink = this.configService.get<string>('ONBOARDING_ADMIN_DASHBOARD_URL', 'http://localhost:3000/admin/dashboard').trim();
    const sharedVariables = {
      full_name: lead.fullName,
      email: lead.email,
      institution: lead.institution,
      country: lead.country,
      mission_need: lead.missionNeed,
      role_label: roleLabel,
      thank_you_note: thankYouNote,
      site_name: siteName,
      support_email: supportEmail,
      submitted_at: lead.createdAt.toISOString(),
      admin_dashboard_link: adminDashboardLink,
    };

    await this.sendApplicantConfirmation(lead.email, sharedVariables);
    await this.sendAdminNotification(sharedVariables, supportEmail);
  }

  private async sendApplicantConfirmation(recipient: string, variables: Record<string, string>): Promise<void> {
    try {
      const template = await this.emailTemplateService.render('onboardingSubmissionConfirmation', variables);
      await this.mailService.sendMail({
        to: recipient,
        subject: template.subject,
        html: template.html,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send onboarding confirmation to ${recipient}: ${message}`);
    }
  }

  private async sendAdminNotification(variables: Record<string, string>, supportEmail: string): Promise<void> {
    const recipients = this.getAdminRecipients(supportEmail);
    if (recipients.length === 0) {
      return;
    }

    try {
      const template = await this.emailTemplateService.render('onboardingSubmissionAdminNotification', variables);
      await this.mailService.sendMail({
        to: recipients,
        subject: template.subject,
        html: template.html,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send onboarding admin notification: ${message}`);
    }
  }

  private getAdminRecipients(supportEmail: string): string[] {
    const configured = this.configService.get<string>('ONBOARDING_NOTIFICATION_EMAILS', '');
    const recipients = configured
      .split(/[;,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    if (supportEmail) {
      recipients.push(supportEmail);
    }

    return [...new Set(recipients)];
  }

  private humanizeRole(role: string): string {
    return role
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ') || 'Applicant';
  }
}
