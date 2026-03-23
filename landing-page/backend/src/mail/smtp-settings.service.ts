import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmtpSettings } from './smtp-settings.entity';
import { UpdateSmtpSettingsDto } from './dto/update-smtp-settings.dto';

export interface ResolvedSmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  replyTo: string;
  defaultBcc: string[];
  rejectUnauthorized: boolean;
  source: 'database' | 'environment' | 'default';
}

@Injectable()
export class SmtpSettingsService {
  private cache: { expiresAt: number; value: ResolvedSmtpSettings } | null = null;

  constructor(
    @InjectRepository(SmtpSettings)
    private readonly smtpSettingsRepository: Repository<SmtpSettings>,
    private readonly configService: ConfigService,
  ) {}

  async getStoredSettings(): Promise<SmtpSettings> {
    const existing = await this.smtpSettingsRepository.findOne({ where: { id: 'default' } });
    if (existing) return existing;

    const created = this.smtpSettingsRepository.create({
      id: 'default',
      host: '',
      port: 587,
      secure: false,
      username: '',
      password: '',
      fromAddress: '',
      replyTo: '',
      defaultBcc: '',
      rejectUnauthorized: true,
    });

    return this.smtpSettingsRepository.save(created);
  }

  async updateSettings(payload: UpdateSmtpSettingsDto): Promise<SmtpSettings> {
    const current = await this.getStoredSettings();
    Object.assign(current, {
      ...payload,
      host: payload.host !== undefined ? payload.host.trim() : current.host,
      username: payload.username !== undefined ? payload.username.trim() : current.username,
      password: payload.password !== undefined ? payload.password.trim() : current.password,
      fromAddress: payload.fromAddress !== undefined ? payload.fromAddress.trim().toLowerCase() : current.fromAddress,
      replyTo: payload.replyTo !== undefined ? payload.replyTo.trim().toLowerCase() : current.replyTo,
      defaultBcc: payload.defaultBcc !== undefined ? payload.defaultBcc.trim().toLowerCase() : current.defaultBcc,
    });

    this.cache = null;
    return this.smtpSettingsRepository.save(current);
  }

  async resolveSettings(forceRefresh = false): Promise<ResolvedSmtpSettings> {
    if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const stored = await this.getStoredSettings();
    const dbCandidate = this.toResolvedSettings(stored, 'database');
    const envCandidate = this.fromEnvironment();
    const fallback = this.defaultLocalFallback();

    const resolved = dbCandidate.host && dbCandidate.fromAddress
      ? dbCandidate
      : envCandidate.host && envCandidate.fromAddress
        ? envCandidate
        : fallback;

    this.cache = { expiresAt: Date.now() + 30_000, value: resolved };
    return resolved;
  }

  private toResolvedSettings(settings: Pick<SmtpSettings, 'host' | 'port' | 'secure' | 'username' | 'password' | 'fromAddress' | 'replyTo' | 'defaultBcc' | 'rejectUnauthorized'>, source: ResolvedSmtpSettings['source']): ResolvedSmtpSettings {
    return {
      host: settings.host?.trim() ?? '',
      port: Number(settings.port ?? 587),
      secure: Boolean(settings.secure),
      username: settings.username?.trim() ?? '',
      password: settings.password?.trim() ?? '',
      fromAddress: settings.fromAddress?.trim().toLowerCase() ?? '',
      replyTo: settings.replyTo?.trim().toLowerCase() ?? '',
      defaultBcc: this.parseEmails(settings.defaultBcc ?? ''),
      rejectUnauthorized: settings.rejectUnauthorized ?? true,
      source,
    };
  }

  private fromEnvironment(): ResolvedSmtpSettings {
    return {
      host: this.configService.get<string>('SMTP_HOST', '').trim(),
      port: Number(this.configService.get<number>('SMTP_PORT', 587)),
      secure: this.parseBoolean(this.configService.get<string>('SMTP_SECURE', 'false')),
      username: this.configService.get<string>('SMTP_USERNAME', '').trim(),
      password: this.configService.get<string>('SMTP_PASSWORD', '').trim(),
      fromAddress: this.configService.get<string>('SMTP_FROM_ADDRESS', '').trim().toLowerCase(),
      replyTo: this.configService.get<string>('SMTP_REPLY_TO', '').trim().toLowerCase(),
      defaultBcc: this.parseEmails(this.configService.get<string>('SMTP_DEFAULT_BCC', '')),
      rejectUnauthorized: this.parseBoolean(this.configService.get<string>('SMTP_REJECT_UNAUTHORIZED', 'true')),
      source: 'environment',
    };
  }

  private defaultLocalFallback(): ResolvedSmtpSettings {
    return {
      host: '',
      port: 1025,
      secure: false,
      username: '',
      password: '',
      fromAddress: this.configService.get<string>('LOCAL_FROM_ADDRESS', 'no-reply@localhost.test').trim().toLowerCase(),
      replyTo: '',
      defaultBcc: [],
      rejectUnauthorized: false,
      source: 'default',
    };
  }

  private parseEmails(value: string): string[] {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }

  private parseBoolean(value: string): boolean {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
}
