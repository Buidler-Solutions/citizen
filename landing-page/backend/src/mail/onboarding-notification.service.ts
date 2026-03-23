import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { FormSettings } from "../lead/form-settings.entity";
import { LeadInterest } from "../lead/lead.entity";
import { OnboardingUser } from "../user/onboarding-user.entity";
import { EmailTemplateService } from "./email-template.service";
import {
  LeadNotification,
  LeadNotificationStatus,
} from "./lead-notification.entity";
import { MailService } from "./mail.service";
import { OnboardingUpdateDto } from "./dto/onboarding-update.dto";

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
    @InjectRepository(LeadNotification)
    private readonly leadNotificationRepository: Repository<LeadNotification>,
    private readonly emailTemplateService: EmailTemplateService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  async sendLeadSubmissionNotifications(
    lead: LeadInterest,
    formSettings: FormSettings,
  ): Promise<void> {
    const role = formSettings.roles.find((item) => item.id === lead.role);
    const roleLabel = role?.label ?? this.humanizeRole(lead.role);
    const thankYouNote =
      role?.thankYouNote ??
      "Thank you for your interest in Citizen. We will send onboarding updates by email.";
    const siteName = formSettings.siteName?.trim() || "Citizen";
    const supportEmail = this.configService
      .get<string>("ONBOARDING_SUPPORT_EMAIL", "")
      .trim()
      .toLowerCase();
    const adminDashboardLink = this.configService
      .get<string>(
        "ONBOARDING_ADMIN_DASHBOARD_URL",
        "http://localhost:3000/admin/dashboard",
      )
      .trim();
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

    await this.sendApplicantConfirmation(lead, sharedVariables);
    await this.sendAdminNotification(lead, sharedVariables, supportEmail);
  }

  async sendForgotPasswordEmail(
    user: OnboardingUser,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    if (!user.email) {
      return;
    }

    const siteName =
      (await this.getFormSettings()).siteName?.trim() || "Citizen";
    const supportEmail = this.configService
      .get<string>("ONBOARDING_SUPPORT_EMAIL", "")
      .trim()
      .toLowerCase();
    const resetBaseUrl = this.configService
      .get<string>(
        "ONBOARDING_RESET_PASSWORD_URL",
        "http://localhost:3000/admin/reset-password",
      )
      .trim();
    const resetLink = `${resetBaseUrl}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

    try {
      const template = await this.emailTemplateService.render(
        "forgotPassword",
        {
          full_name: user.fullName || user.username,
          username: user.username,
          reset_link: resetLink,
          reset_expires_at: expiresAt.toISOString(),
          expires_in: this.describeResetExpiry(expiresAt),
          site_name: siteName,
          support_email: supportEmail || "the onboarding team",
        },
      );

      const delivery = await this.mailService.sendMail({
        to: user.email,
        subject: template.subject,
        html: template.html,
      });

      await this.recordNotification({
        leadId: null,
        templateType: "forgotPassword",
        recipientEmail: user.email,
        recipientName: user.fullName || user.username,
        subjectSnapshot: template.subject,
        status: this.deliveryStatus(delivery),
        channel: delivery.mode,
        audienceMode: "single-user",
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await this.recordNotification({
        leadId: null,
        templateType: "forgotPassword",
        recipientEmail: user.email,
        recipientName: user.fullName || user.username,
        subjectSnapshot: "Reset your onboarding password",
        status: "failed",
        channel: "smtp",
        audienceMode: "single-user",
        errorMessage: message,
      });
      this.logger.warn(
        `Failed to send forgot-password email to ${user.email}: ${message}`,
      );
    }
  }

  async sendOnboardingUserWelcomeEmail(
    user: Pick<OnboardingUser, "username" | "email" | "fullName">,
  ): Promise<void> {
    if (!user.email) {
      return;
    }

    const siteName =
      (await this.getFormSettings()).siteName?.trim() || "Citizen";
    const loginLink = this.configService
      .get<string>(
        "ONBOARDING_ADMIN_LOGIN_URL",
        "http://localhost:3000/admin/login",
      )
      .trim();

    try {
      const template = await this.emailTemplateService.render(
        "onboardingUserWelcome",
        {
          full_name: user.fullName || user.username,
          username: user.username,
          temporary_password_notice:
            "Use the password shared by your onboarding administrator, then rotate it through the reset-password flow if needed.",
          login_link: loginLink,
          site_name: siteName,
        },
      );

      const delivery = await this.mailService.sendMail({
        to: user.email,
        subject: template.subject,
        html: template.html,
      });

      await this.recordNotification({
        leadId: null,
        templateType: "onboardingUserWelcome",
        recipientEmail: user.email,
        recipientName: user.fullName || user.username,
        subjectSnapshot: template.subject,
        status: this.deliveryStatus(delivery),
        channel: delivery.mode,
        audienceMode: "single-user",
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await this.recordNotification({
        leadId: null,
        templateType: "onboardingUserWelcome",
        recipientEmail: user.email,
        recipientName: user.fullName || user.username,
        subjectSnapshot: "Your onboarding console account is ready",
        status: "failed",
        channel: "smtp",
        audienceMode: "single-user",
        errorMessage: message,
      });
      this.logger.warn(
        `Failed to send onboarding welcome email to ${user.email}: ${message}`,
      );
    }
  }

  async previewOnboardingUpdate(payload: OnboardingUpdateDto) {
    const formSettings = await this.getFormSettings();
    const recipients = await this.resolveAudience(payload);
    const previewRecipient = recipients[0];
    const supportEmail = this.configService
      .get<string>("ONBOARDING_SUPPORT_EMAIL", "")
      .trim()
      .toLowerCase();
    const adminDashboardLink =
      payload.includeAdminDashboardLink === false
        ? ""
        : this.configService
            .get<string>(
              "ONBOARDING_ADMIN_DASHBOARD_URL",
              "http://localhost:3000/admin/dashboard",
            )
            .trim();

    const rendered = previewRecipient
      ? await this.emailTemplateService.render(
          "onboardingStatusUpdate",
          this.buildOnboardingUpdateVariables({
            recipient: previewRecipient,
            formSettings,
            supportEmail,
            adminDashboardLink,
            payload,
          }),
        )
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
    const supportEmail = this.configService
      .get<string>("ONBOARDING_SUPPORT_EMAIL", "")
      .trim()
      .toLowerCase();
    const adminDashboardLink =
      payload.includeAdminDashboardLink === false
        ? ""
        : this.configService
            .get<string>(
              "ONBOARDING_ADMIN_DASHBOARD_URL",
              "http://localhost:3000/admin/dashboard",
            )
            .trim();

    let sent = 0;
    let logged = 0;
    let failed = 0;

    for (const recipient of recipients) {
      const fallbackSubject =
        payload.customSubject?.trim() ||
        `${formSettings.siteName?.trim() || "Citizen"} onboarding update`;
      try {
        const template = await this.emailTemplateService.render(
          "onboardingStatusUpdate",
          this.buildOnboardingUpdateVariables({
            recipient,
            formSettings,
            supportEmail,
            adminDashboardLink,
            payload,
          }),
        );

        const subject = payload.customSubject?.trim() || template.subject;
        const delivery = await this.mailService.sendMail({
          to: recipient.email,
          subject,
          html: template.html,
        });

        const status = this.deliveryStatus(delivery);
        if (status === "sent") {
          sent += 1;
        }
        if (status === "logged") {
          logged += 1;
        }

        await this.recordNotification({
          leadId: recipient.id,
          templateType: "onboardingStatusUpdate",
          recipientEmail: recipient.email,
          recipientName: recipient.fullName,
          subjectSnapshot: subject,
          status,
          channel: delivery.mode,
          audienceMode: payload.audienceMode,
          errorMessage: null,
        });
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error ? error.message : "unknown error";
        await this.recordNotification({
          leadId: recipient.id,
          templateType: "onboardingStatusUpdate",
          recipientEmail: recipient.email,
          recipientName: recipient.fullName,
          subjectSnapshot: fallbackSubject,
          status: "failed",
          channel: "smtp",
          audienceMode: payload.audienceMode,
          errorMessage: message,
        });
        this.logger.warn(
          `Failed to send onboarding update to ${recipient.email}: ${message}`,
        );
      }
    }

    return {
      ok: true,
      totalRecipients: recipients.length,
      sent,
      logged,
      failed,
    };
  }

  async listNotificationHistory(limit = 25) {
    const safeLimit = Math.min(
      Math.max(Number.isFinite(limit) ? limit : 25, 1),
      100,
    );
    const records = await this.leadNotificationRepository.find({
      order: { createdAt: "DESC" },
      take: safeLimit,
    });

    return records.map((record) => ({
      id: record.id,
      leadId: record.leadId,
      templateType: record.templateType,
      recipientEmail: record.recipientEmail,
      recipientName: record.recipientName,
      subjectSnapshot: record.subjectSnapshot,
      status: record.status,
      channel: record.channel,
      audienceMode: record.audienceMode,
      errorMessage: record.errorMessage,
      sentAt: record.sentAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    }));
  }

  private async sendApplicantConfirmation(
    lead: LeadInterest,
    variables: Record<string, string>,
  ): Promise<void> {
    try {
      const template = await this.emailTemplateService.render(
        "onboardingSubmissionConfirmation",
        variables,
      );
      const delivery = await this.mailService.sendMail({
        to: lead.email,
        subject: template.subject,
        html: template.html,
      });

      await this.recordNotification({
        leadId: lead.id,
        templateType: "onboardingSubmissionConfirmation",
        recipientEmail: lead.email,
        recipientName: lead.fullName,
        subjectSnapshot: template.subject,
        status: this.deliveryStatus(delivery),
        channel: delivery.mode,
        audienceMode: "single-lead",
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await this.recordNotification({
        leadId: lead.id,
        templateType: "onboardingSubmissionConfirmation",
        recipientEmail: lead.email,
        recipientName: lead.fullName,
        subjectSnapshot: "We received your onboarding request",
        status: "failed",
        channel: "smtp",
        audienceMode: "single-lead",
        errorMessage: message,
      });
      this.logger.warn(
        `Failed to send onboarding confirmation to ${lead.email}: ${message}`,
      );
    }
  }

  private async sendAdminNotification(
    lead: LeadInterest,
    variables: Record<string, string>,
    supportEmail: string,
  ): Promise<void> {
    const recipients = this.getAdminRecipients(supportEmail);
    if (recipients.length === 0) {
      return;
    }

    try {
      const template = await this.emailTemplateService.render(
        "onboardingSubmissionAdminNotification",
        variables,
      );
      const delivery = await this.mailService.sendMail({
        to: recipients,
        subject: template.subject,
        html: template.html,
      });

      await Promise.all(
        recipients.map((recipientEmail) =>
          this.recordNotification({
            leadId: lead.id,
            templateType: "onboardingSubmissionAdminNotification",
            recipientEmail,
            recipientName: "Citizen admin",
            subjectSnapshot: template.subject,
            status: this.deliveryStatus(delivery),
            channel: delivery.mode,
            audienceMode: "admin-notification",
            errorMessage: null,
          }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await Promise.all(
        recipients.map((recipientEmail) =>
          this.recordNotification({
            leadId: lead.id,
            templateType: "onboardingSubmissionAdminNotification",
            recipientEmail,
            recipientName: "Citizen admin",
            subjectSnapshot: `New onboarding submission: ${lead.fullName}`,
            status: "failed",
            channel: "smtp",
            audienceMode: "admin-notification",
            errorMessage: message,
          }),
        ),
      );
      this.logger.warn(
        `Failed to send onboarding admin notification: ${message}`,
      );
    }
  }

  private buildOnboardingUpdateVariables(input: {
    recipient: UpdateRecipientPreview;
    formSettings: FormSettings;
    supportEmail: string;
    adminDashboardLink: string;
    payload: OnboardingUpdateDto;
  }): Record<string, string> {
    const updateBody = this.normalizeUpdateBody(
      input.payload.updateBody,
      input.payload.messageHtml,
      input.adminDashboardLink,
    );
    return {
      full_name: input.recipient.fullName,
      email: input.recipient.email,
      role_label: this.labelForRole(input.recipient.role, input.formSettings),
      institution: input.recipient.institution,
      update_title:
        input.payload.updateTitle?.trim() || "Application status update",
      update_body: updateBody,
      next_step:
        input.payload.nextStep?.trim() ||
        "We will share the next checkpoint by email.",
      cta_link: input.payload.ctaLink?.trim() || input.adminDashboardLink,
      support_email: input.supportEmail || "the onboarding team",
      site_name: input.formSettings.siteName?.trim() || "Citizen",
    };
  }

  private normalizeUpdateBody(
    updateBody?: string,
    legacyMessageHtml?: string,
    adminDashboardLink?: string,
  ): string {
    const body = updateBody?.trim() || legacyMessageHtml?.trim();
    if (body) {
      return body;
    }

    if (adminDashboardLink) {
      return `<p>We are reviewing the next onboarding cohort now. Track your next step here: <a href="${adminDashboardLink}">${adminDashboardLink}</a>.</p>`;
    }

    return "<p>We are reviewing the next onboarding cohort and will share the next milestone soon.</p>";
  }

  private describeResetExpiry(expiresAt: Date): string {
    const remainingMinutes = Math.max(
      1,
      Math.round((expiresAt.getTime() - Date.now()) / 60_000),
    );
    return remainingMinutes === 1 ? "1 minute" : `${remainingMinutes} minutes`;
  }

  private deliveryStatus(delivery: {
    delivered: boolean;
    mode: "smtp" | "logged";
  }): LeadNotificationStatus {
    if (delivery.mode === "logged") {
      return "logged";
    }

    return delivery.delivered ? "sent" : "failed";
  }

  private async recordNotification(input: {
    leadId: string | null;
    templateType: string;
    recipientEmail: string;
    recipientName: string;
    subjectSnapshot: string;
    status: LeadNotificationStatus;
    channel: string;
    audienceMode: string;
    errorMessage: string | null;
  }): Promise<void> {
    try {
      const record = this.leadNotificationRepository.create({
        leadId: input.leadId,
        templateType: input.templateType,
        recipientEmail: input.recipientEmail.trim().toLowerCase(),
        recipientName: input.recipientName.trim(),
        subjectSnapshot: input.subjectSnapshot.trim(),
        status: input.status,
        channel: input.channel,
        audienceMode: input.audienceMode,
        errorMessage: input.errorMessage,
        sentAt: input.status === "failed" ? null : new Date(),
      });
      await this.leadNotificationRepository.save(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.warn(
        `Failed to record notification audit entry for ${input.recipientEmail}: ${message}`,
      );
    }
  }

  private getAdminRecipients(supportEmail: string): string[] {
    const configured = this.configService.get<string>(
      "ONBOARDING_NOTIFICATION_EMAILS",
      "",
    );
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
    const existing = await this.formSettingsRepository.findOne({
      where: { id: "default" },
    });
    return (
      existing ??
      this.formSettingsRepository.create({
        id: "default",
        siteName: "Citizen",
        title: "Build Public Truth with Citizen",
        subtitle: "Validator · Builder · Observer onboarding",
        siteLogoUrl: "",
        siteLogoAlt: "Citizen",
        campaignCards: [],
        roles: [],
      })
    );
  }

  private async resolveAudience(
    payload: OnboardingUpdateDto,
  ): Promise<UpdateRecipientPreview[]> {
    const query = this.leadRepository
      .createQueryBuilder("lead")
      .orderBy("lead.createdAt", "DESC");

    if (payload.audienceMode === "role" && payload.role?.trim()) {
      query.andWhere("LOWER(lead.role) = :role", {
        role: payload.role.trim().toLowerCase(),
      });
    }

    if (payload.audienceMode === "selected") {
      const leadIds = (payload.leadIds ?? []).filter(Boolean);
      if (leadIds.length === 0) {
        return [];
      }
      query.andWhere("lead.id IN (:...leadIds)", { leadIds });
    }

    if (payload.search?.trim()) {
      query.andWhere(
        "(LOWER(lead.fullName) LIKE :query OR LOWER(lead.email) LIKE :query OR LOWER(lead.institution) LIKE :query)",
        {
          query: `%${payload.search.trim().toLowerCase()}%`,
        },
      );
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
    return (
      formSettings.roles.find((item) => item.id === role)?.label ??
      this.humanizeRole(role)
    );
  }

  private humanizeRole(role: string): string {
    return (
      role
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ") || "Applicant"
    );
  }
}
