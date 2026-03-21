import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Buffer } from 'buffer';
import { Repository } from 'typeorm';
import { CreateOnboardingUserDto } from './dto/create-onboarding-user.dto';
import { OnboardingUser } from './onboarding-user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(OnboardingUser)
    private readonly userRepository: Repository<OnboardingUser>,
    private readonly configService: ConfigService,
  ) {}

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derivedKey}`;
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

      if (!this.verifyPassword(password, existing.passwordHash)) {
        existing.passwordHash = this.hashPassword(password);
        needsSave = true;
      }

      return needsSave ? this.userRepository.save(existing) : existing;
    }

    const superAdmin = this.userRepository.create({
      username,
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

  async listUsers(): Promise<Array<Pick<OnboardingUser, 'id' | 'username' | 'fullName' | 'role' | 'isActive' | 'createdAt'>>> {
    await this.ensureSuperAdmin();

    const users = await this.userRepository.find({
      order: {
        role: 'ASC',
        createdAt: 'ASC',
      },
    });

    return users.map(({ id, username, fullName, role, isActive, createdAt }) => ({
      id,
      username,
      fullName,
      role,
      isActive,
      createdAt,
    }));
  }

  async createUser(payload: CreateOnboardingUserDto): Promise<Pick<OnboardingUser, 'id' | 'username' | 'fullName' | 'role' | 'isActive' | 'createdAt'>> {
    await this.ensureSuperAdmin();
    const username = this.normalizeUsername(payload.username);
    const existing = await this.userRepository.findOne({ where: { username } });

    if (existing) {
      throw new ConflictException('A user with that username already exists.');
    }

    const user = this.userRepository.create({
      username,
      passwordHash: this.hashPassword(payload.password),
      fullName: payload.fullName?.trim() ?? '',
      role: payload.role,
      isActive: true,
    });

    const saved = await this.userRepository.save(user);
    const { id, fullName, role, isActive, createdAt } = saved;
    return { id, username: saved.username, fullName, role, isActive, createdAt };
  }
}
