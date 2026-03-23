import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmtpSettingsService } from './smtp-settings.service';

interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  bcc?: string | string[];
}

interface MailTransporter {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporterCache = new Map<string, MailTransporter>();
  private nodemailerFactoryPromise: Promise<((config: Record<string, unknown>) => MailTransporter) | null> | null = null;

  constructor(
    private readonly smtpSettingsService: SmtpSettingsService,
    private readonly configService: ConfigService,
  ) {}

  async sendMail(input: SendMailInput): Promise<{ delivered: boolean; mode: 'smtp' | 'logged' }> {
    const smtp = await this.smtpSettingsService.resolveSettings();
    const recipients = this.toList(input.to);
    const bcc = this.uniqueEmails([...smtp.defaultBcc, ...this.toList(input.bcc)]);

    if (!smtp.host) {
      this.logger.warn(`SMTP not configured; logging email to ${recipients.join(', ')} with subject "${input.subject}".`);
      return { delivered: false, mode: 'logged' };
    }

    const transporter = await this.getTransporter(smtp);

    if (!transporter) {
      const isStrict = this.configService.get<string>('NODE_ENV', 'development') === 'production';
      if (isStrict) {
        throw new Error('SMTP transport is configured but nodemailer is not installed.');
      }

      this.logger.warn(`nodemailer is unavailable; logging email to ${recipients.join(', ')} with subject "${input.subject}".`);
      return { delivered: false, mode: 'logged' };
    }

    await transporter.sendMail({
      from: smtp.fromAddress,
      to: recipients.join(', '),
      bcc: bcc.length > 0 ? bcc.join(', ') : undefined,
      replyTo: input.replyTo || smtp.replyTo || undefined,
      subject: input.subject,
      html: input.html,
    });

    return { delivered: true, mode: 'smtp' };
  }

  private async getTransporter(smtp: Awaited<ReturnType<SmtpSettingsService['resolveSettings']>>): Promise<MailTransporter | null> {
    const signature = JSON.stringify({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      password: smtp.password,
      rejectUnauthorized: smtp.rejectUnauthorized,
    });

    const cached = this.transporterCache.get(signature);
    if (cached) {
      return cached;
    }

    const createTransport = await this.loadNodemailerFactory();
    if (!createTransport) {
      return null;
    }

    const transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
      tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    });

    this.transporterCache.set(signature, transporter);
    return transporter;
  }

  private async loadNodemailerFactory(): Promise<((config: Record<string, unknown>) => MailTransporter) | null> {
    if (!this.nodemailerFactoryPromise) {
      const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<Record<string, unknown>>;
      this.nodemailerFactoryPromise = dynamicImport('nodemailer')
        .then((module) => {
          const factory = (module.default as { createTransport?: (config: Record<string, unknown>) => MailTransporter } | undefined)?.createTransport
            ?? (module.createTransport as ((config: Record<string, unknown>) => MailTransporter) | undefined);
          return typeof factory === 'function' ? factory : null;
        })
        .catch(() => null);
    }

    return this.nodemailerFactoryPromise;
  }

  private toList(value?: string | string[]): string[] {
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  }

  private uniqueEmails(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  }
}
