import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Buffer } from 'buffer';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { CreateOnboardingUserDto } from './dto/create-onboarding-user.dto';
import { OnboardingUser } from './onboarding-user.entity';
import { PasswordReset } from '../auth/password-reset.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(OnboardingUser)
    private readonly userRepository: Repository<OnboardingUser>,
    @InjectRepository(PasswordReset)
    private readonly passwordResetRepository: Repository<PasswordReset>,
    private readonly configService: ConfigService,
  ) {}

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derivedKey}`;
  }

  private hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');

    if (!salt || !hash) {
      return false;
    }

    const derivedKey = scryptSync(password, salt, 64);
    const storedKey = Buffer.from(hash, 'hex');

    if (derivedKey.length !== storedKey.length) {
      return false;
    }

    return timingSafeEqual(derivedKey, storedKey);
  }

  async ensureSuperAdmin(): Promise<OnboardingUser> {
    const username = this.normalizeUsername(this.configService.get<string>('ADMIN_USERNAME', 'admin'));
    const password = this.configService.get<string>('ADMIN_PASSWORD', 'change-me-admin-password');
    const email = this.normalizeEmail(
      this.configService.get<string>('ADMIN_EMAIL')
      ?? this.configService.get<string>('ONBOARDING_SUPPORT_EMAIL', ''),
    );

    const existing = await this.userRepository.findOne({ where: { username } });

    if (existing) {
      let needsSave = false;

      if (existing.role !== 'super_admin') {
        existing.role = 'super_admin';
        needsSave = true;
      }

      if (!existing.isActive) {
        existing.isActive = true;
        needsSave = true;
      }

      if (email && existing.email !== email) {
        existing.email = email;
        needsSave = true;
      }

      if (!this.verifyPassword(password, existing.passwordHash)) {
        existing.passwordHash = this.hashPassword(password);
        needsSave = true;
      }

      return needsSave ? this.userRepository.save(existing) : existing;
    }

    const superAdmin = this.userRepository.create({
      username,
      email,
      passwordHash: this.hashPassword(password),
      fullName: 'Super Admin',
      role: 'super_admin',
      isActive: true,
    });

    return this.userRepository.save(superAdmin);
  }

  async validateCredentials(username: string, password: string): Promise<OnboardingUser> {
    await this.ensureSuperAdmin();
    const normalizedUsername = this.normalizeUsername(username);
    const user = await this.userRepository.findOne({ where: { username: normalizedUsername } });

    if (!user || !user.isActive || !this.verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return user;
  }

  async listUsers(): Promise<Array<Pick<OnboardingUser, 'id' | 'username' | 'email' | 'fullName' | 'role' | 'isActive' | 'createdAt'>>> {
    await this.ensureSuperAdmin();

    const users = await this.userRepository.find({
      order: {
        role: 'ASC',
        createdAt: 'ASC',
      },
    });

    return users.map(({ id, username, email, fullName, role, isActive, createdAt }) => ({
      id,
      username,
      email,
      fullName,
      role,
      isActive,
      createdAt,
    }));
  }

  async createUser(payload: CreateOnboardingUserDto): Promise<Pick<OnboardingUser, 'id' | 'username' | 'email' | 'fullName' | 'role' | 'isActive' | 'createdAt'>> {
    await this.ensureSuperAdmin();
    const username = this.normalizeUsername(payload.username);
    const email = this.normalizeEmail(payload.email);
    const existing = await this.userRepository.findOne({ where: [{ username }, { email }] });

    if (existing) {
      throw new ConflictException(existing.username === username
        ? 'A user with that username already exists.'
        : 'A user with that email address already exists.');
    }

    const user = this.userRepository.create({
      username,
      email,
      passwordHash: this.hashPassword(payload.password),
      fullName: payload.fullName?.trim() ?? '',
      role: payload.role,
      isActive: true,
    });

    const saved = await this.userRepository.save(user);
    const { id, fullName, role, isActive, createdAt } = saved;
    return { id, username: saved.username, email: saved.email, fullName, role, isActive, createdAt };
  }

  async createPasswordReset(identifier: string): Promise<{ user: OnboardingUser; token: string; expiresAt: Date } | null> {
    await this.ensureSuperAdmin();
    const normalized = identifier.trim().toLowerCase();

    if (!normalized) {
      return null;
    }

    const user = await this.userRepository.findOne({ where: [{ username: normalized }, { email: normalized }] });

    if (!user || !user.isActive || !user.email) {
      return null;
    }

    const now = new Date();
    await this.passwordResetRepository.update(
      { userId: user.id, usedAt: IsNull(), expiresAt: MoreThan(now) },
      { usedAt: now },
    );

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + this.getResetTtlMinutes() * 60_000);
    const reset = this.passwordResetRepository.create({
      user,
      userId: user.id,
      email: user.email,
      tokenHash: this.hashResetToken(token),
      expiresAt,
      usedAt: null,
    });

    await this.passwordResetRepository.save(reset);
    return { user, token, expiresAt };
  }

  async resetPassword(email: string, token: string, password: string): Promise<OnboardingUser> {
    const normalizedEmail = this.normalizeEmail(email);
    const tokenHash = this.hashResetToken(token.trim());
    const now = new Date();
    const reset = await this.passwordResetRepository.findOne({
      where: {
        email: normalizedEmail,
        tokenHash,
        usedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      relations: ['user'],
      order: { createdAt: 'DESC' },
    });

    if (!reset?.user || !reset.user.isActive) {
      throw new BadRequestException('The reset link is invalid or has expired.');
    }

    reset.user.passwordHash = this.hashPassword(password);
    reset.usedAt = now;

    await this.userRepository.save(reset.user);
    await this.passwordResetRepository.save(reset);
    await this.passwordResetRepository.update(
      { userId: reset.user.id, usedAt: IsNull(), expiresAt: MoreThan(now) },
      { usedAt: now },
    );

    return reset.user;
  }

  private getResetTtlMinutes(): number {
    const raw = Number(this.configService.get<string>('PASSWORD_RESET_TTL_MINUTES', '60'));
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60;
  }
}
