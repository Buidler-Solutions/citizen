import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailTemplate } from './email-template.entity';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';

export interface TemplateDefinition {
  type: string;
  subject: string;
  html: string;
  placeholders: string[];
}

export interface RenderedTemplate {
  type: string;
  subject: string;
  html: string;
  placeholders: string[];
  source: 'default' | 'database';
}

const TEMPLATE_DEFINITIONS: Record<string, TemplateDefinition> = {
  forgotPassword: {
    type: 'forgotPassword',
    subject: 'Reset your {{site_name}} onboarding password',
    html: `
      <p>Hello {{full_name}},</p>
      <p>We received a request to reset the password for your {{site_name}} onboarding account.</p>
      <p><a href="{{reset_link}}">Reset your password</a></p>
      <p>This link expires at {{reset_expires_at}}.</p>
      <p>If you did not request this change, you can ignore this message.</p>
      <p>Need help? Contact {{support_email}}.</p>
    `,
    placeholders: ['full_name', 'reset_link', 'reset_expires_at', 'site_name', 'support_email'],
  },
  onboardingSubmissionConfirmation: {
    type: 'onboardingSubmissionConfirmation',
    subject: 'We received your {{role_label}} onboarding request',
    html: `
      <p>Hello {{full_name}},</p>
      <p>Thank you for your interest in Citizen as a {{role_label}} participant.</p>
      <p>{{thank_you_note}}</p>
      <p><strong>Institution:</strong> {{institution}}<br />
      <strong>Country:</strong> {{country}}<br />
      <strong>Mission need:</strong> {{mission_need}}</p>
      <p>We will follow up at {{email}} with onboarding updates.</p>
      <p>— {{site_name}}</p>
    `,
    placeholders: ['full_name', 'email', 'institution', 'country', 'mission_need', 'role_label', 'thank_you_note', 'site_name', 'support_email'],
  },
  onboardingSubmissionAdminNotification: {
    type: 'onboardingSubmissionAdminNotification',
    subject: 'New onboarding submission: {{full_name}} ({{role_label}})',
    html: `
      <p>A new onboarding interest submission was received.</p>
      <p><strong>Name:</strong> {{full_name}}<br />
      <strong>Email:</strong> {{email}}<br />
      <strong>Institution:</strong> {{institution}}<br />
      <strong>Country:</strong> {{country}}<br />
      <strong>Role:</strong> {{role_label}}<br />
      <strong>Submitted at:</strong> {{submitted_at}}</p>
      <p><strong>Mission need:</strong><br />{{mission_need}}</p>
      <p>Review in the admin dashboard: {{admin_dashboard_link}}</p>
      <p>— {{site_name}}</p>
    `,
    placeholders: ['full_name', 'email', 'institution', 'country', 'mission_need', 'role_label', 'submitted_at', 'admin_dashboard_link', 'site_name'],
  },
  onboardingStatusUpdate: {
    type: 'onboardingStatusUpdate',
    subject: '{{site_name}} onboarding update for {{role_label}} applicants',
    html: `
      <p>Hello {{full_name}},</p>
      <p>We have an onboarding update for your {{role_label}} application.</p>
      <div>{{update_message}}</div>
      <p>If you have questions, contact {{support_email}}.</p>
      <p>{{admin_dashboard_link}}</p>
      <p>— {{site_name}}</p>
    `,
    placeholders: ['full_name', 'role_label', 'institution', 'update_message', 'support_email', 'site_name', 'admin_dashboard_link'],
  },
  onboardingUserWelcome: {
    type: 'onboardingUserWelcome',
    subject: 'Your {{site_name}} onboarding console account is ready',
    html: `
      <p>Hello {{full_name}},</p>
      <p>Your onboarding console account is active.</p>
      <p>Username: <strong>{{username}}</strong></p>
      <p>You can sign in at {{admin_login_link}} and request a password reset any time.</p>
      <p>— {{site_name}}</p>
    `,
    placeholders: ['full_name', 'username', 'admin_login_link', 'site_name'],
  },
};

@Injectable()
export class EmailTemplateService {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templateRepository: Repository<EmailTemplate>,
  ) {}

  listTemplates(): TemplateDefinition[] {
    return Object.values(TEMPLATE_DEFINITIONS);
  }

  async getTemplate(type: string): Promise<RenderedTemplate> {
    const definition = TEMPLATE_DEFINITIONS[type];
    const stored = await this.templateRepository.findOne({ where: { type } });

    if (!definition && !stored) {
      throw new Error(`Unknown email template type: ${type}`);
    }

    return {
      type,
      subject: stored?.subject ?? definition.subject,
      html: stored?.html ?? definition.html,
      placeholders: definition?.placeholders ?? [],
      source: stored ? 'database' : 'default',
    };
  }

  async upsertTemplate(type: string, payload: UpdateEmailTemplateDto): Promise<RenderedTemplate> {
    const definition = TEMPLATE_DEFINITIONS[type];

    if (!definition) {
      throw new Error(`Unknown email template type: ${type}`);
    }

    const existing = await this.templateRepository.findOne({ where: { type } });
    const template = this.templateRepository.create({
      ...(existing ?? {}),
      type,
      subject: payload.subject.trim(),
      html: payload.html.trim(),
    });

    await this.templateRepository.save(template);
    return this.getTemplate(type);
  }

  async resetTemplate(type: string): Promise<RenderedTemplate> {
    await this.templateRepository.delete({ type });
    return this.getTemplate(type);
  }

  async render(type: string, variables: Record<string, string>): Promise<RenderedTemplate> {
    const template = await this.getTemplate(type);
    return {
      ...template,
      subject: this.interpolate(template.subject, variables),
      html: this.interpolate(template.html, variables),
    };
  }

  private interpolate(value: string, variables: Record<string, string>): string {
    return value.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_match, key: string) => variables[key] ?? '');
  }
}
