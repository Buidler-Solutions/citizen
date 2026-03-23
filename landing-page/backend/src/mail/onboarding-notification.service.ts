import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FormSettings } from '../lead/form-settings.entity';
import { LeadInterest } from '../lead/lead.entity';
import { OnboardingUser } from '../user/onboarding-user.entity';
import { EmailTemplateService } from './email-template.service';
import { MailService } from './mail.service';
import { OnboardingUpdateDto } from './dto/onboarding-update.dto';

export interface UpdateRecipientPreview {
  id: string;
  email: string;
  fullName: string;
  role: string;
  institution: string;
}

@Injectable()
export class OnboardingNotificationService {
  private readonly logger = new Logger(OnboardingNotificationService.name);

  constructor(
    @InjectRepository(LeadInterest)
    private readonly leadRepository: Repository<LeadInterest>,
    @InjectRepository(FormSettings)
    private readonly formSettingsRepository: Repository<FormSettings>,
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

  async sendForgotPasswordEmail(user: OnboardingUser, token: string, expiresAt: Date): Promise<void> {
    if (!user.email) {
      return;
    }

    const siteName = (await this.getFormSettings()).siteName?.trim() || 'Citizen';
    const supportEmail = this.configService.get<string>('ONBOARDING_SUPPORT_EMAIL', '').trim().toLowerCase();
    const resetBaseUrl = this.configService.get<string>('ONBOARDING_RESET_PASSWORD_URL', 'http://localhost:3000/admin/reset-password').trim();
    const resetLink = `${resetBaseUrl}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

    try {
      const template = await this.emailTemplateService.render('forgotPassword', {
        full_name: user.fullName || user.username,
        reset_link: resetLink,
        reset_expires_at: expiresAt.toISOString(),
        site_name: siteName,
        support_email: supportEmail,
      });

      await this.mailService.sendMail({
        to: user.email,
        subject: template.subject,
        html: template.html,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send forgot-password email to ${user.email}: ${message}`);
    }
  }

  async previewOnboardingUpdate(payload: OnboardingUpdateDto) {
    const formSettings = await this.getFormSettings();
    const recipients = await this.resolveAudience(payload);
    const previewRecipient = recipients[0];
    const supportEmail = this.configService.get<string>('ONBOARDING_SUPPORT_EMAIL', '').trim().toLowerCase();
    const adminDashboardLink = payload.includeAdminDashboardLink === false
      ? ''
      : this.configService.get<string>('ONBOARDING_ADMIN_DASHBOARD_URL', 'http://localhost:3000/admin/dashboard').trim();

    const rendered = previewRecipient
      ? await this.emailTemplateService.render('onboardingStatusUpdate', {
        full_name: previewRecipient.fullName,
        role_label: this.labelForRole(previewRecipient.role, formSettings),
        institution: previewRecipient.institution,
        update_message: payload.messageHtml,
        support_email: supportEmail,
        site_name: formSettings.siteName?.trim() || 'Citizen',
        admin_dashboard_link: adminDashboardLink,
      })
      : null;

    return {
      audienceCount: recipients.length,
      recipients,
      preview: rendered
        ? {
            subject: payload.customSubject?.trim() || rendered.subject,
            html: rendered.html,
          }
        : null,
    };
  }

  async sendOnboardingUpdate(payload: OnboardingUpdateDto) {
    const formSettings = await this.getFormSettings();
    const recipients = await this.resolveAudience(payload);
    const supportEmail = this.configService.get<string>('ONBOARDING_SUPPORT_EMAIL', '').trim().toLowerCase();
    const adminDashboardLink = payload.includeAdminDashboardLink === false
      ? ''
      : this.configService.get<string>('ONBOARDING_ADMIN_DASHBOARD_URL', 'http://localhost:3000/admin/dashboard').trim();

    let sent = 0;
    for (const recipient of recipients) {
      try {
        const template = await this.emailTemplateService.render('onboardingStatusUpdate', {
          full_name: recipient.fullName,
          role_label: this.labelForRole(recipient.role, formSettings),
          institution: recipient.institution,
          update_message: payload.messageHtml,
          support_email: supportEmail,
          site_name: formSettings.siteName?.trim() || 'Citizen',
          admin_dashboard_link: adminDashboardLink,
        });

        await this.mailService.sendMail({
          to: recipient.email,
          subject: payload.customSubject?.trim() || template.subject,
          html: template.html,
        });
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Failed to send onboarding update to ${recipient.email}: ${message}`);
      }
    }

    return { ok: true, totalRecipients: recipients.length, sent };
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

  private async getFormSettings(): Promise<FormSettings> {
    const existing = await this.formSettingsRepository.findOne({ where: { id: 'default' } });
    return existing ?? this.formSettingsRepository.create({
      id: 'default',
      siteName: 'Citizen',
      title: 'Build Public Truth with Citizen',
      subtitle: 'Validator · Builder · Observer onboarding',
      siteLogoUrl: '',
      siteLogoAlt: 'Citizen',
      campaignCards: [],
      roles: [],
    });
  }

  private async resolveAudience(payload: OnboardingUpdateDto): Promise<UpdateRecipientPreview[]> {
    const query = this.leadRepository.createQueryBuilder('lead').orderBy('lead.createdAt', 'DESC');

    if (payload.audienceMode === 'role' && payload.role?.trim()) {
      query.andWhere('LOWER(lead.role) = :role', { role: payload.role.trim().toLowerCase() });
    }

    if (payload.audienceMode === 'selected') {
      const leadIds = (payload.leadIds ?? []).filter(Boolean);
      if (leadIds.length === 0) {
        return [];
      }
      query.andWhere('lead.id IN (:...leadIds)', { leadIds });
    }

    if (payload.search?.trim()) {
      query.andWhere('(LOWER(lead.fullName) LIKE :query OR LOWER(lead.email) LIKE :query OR LOWER(lead.institution) LIKE :query)', {
        query: `%${payload.search.trim().toLowerCase()}%`,
      });
    }

    const leads = await query.getMany();
    return leads.map((lead) => ({
      id: lead.id,
      email: lead.email,
      fullName: lead.fullName,
      role: lead.role,
      institution: lead.institution,
    }));
  }

  private labelForRole(role: string, formSettings: FormSettings): string {
    return formSettings.roles.find((item) => item.id === role)?.label ?? this.humanizeRole(role);
  }

  private humanizeRole(role: string): string {
    return role
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ') || 'Applicant';
  }
}
