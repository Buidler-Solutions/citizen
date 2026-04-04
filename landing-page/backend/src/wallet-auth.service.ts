import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { AuthChallenge } from './auth/auth-challenge.entity';
import { AuthSession } from './auth/auth-session.entity';
import { AuthUser } from './auth/auth-user.entity';

export interface VerifyChallengeInput {
  challengeId: string;
  message: string;
  signature: string;
  address: string;
  userAgent?: string;
  ipAddress?: string;
}

@Injectable()
export class WalletAuthService {
  constructor(
    @InjectRepository(AuthUser)
    private readonly authUserRepository: Repository<AuthUser>,
    @InjectRepository(AuthChallenge)
    private readonly authChallengeRepository: Repository<AuthChallenge>,
    @InjectRepository(AuthSession)
    private readonly authSessionRepository: Repository<AuthSession>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private normalizeWalletAddress(address: string): string {
    return address.trim().toLowerCase();
  }

  private normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase();
  }

  private getAllowedAuthDomains(): string[] {
    return (this.configService.get<string>('AUTH_ALLOWED_DOMAINS', '') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  private getAllowedChainIds(): number[] {
    return (this.configService.get<string>('AUTH_ALLOWED_CHAIN_IDS', '') ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  private getChallengeTtlSeconds(): number {
    const raw = Number(this.configService.get<string>('AUTH_CHALLENGE_TTL_SECONDS', '300'));
    return Number.isFinite(raw) && raw > 30 ? Math.trunc(raw) : 300;
  }

  private getAccessTokenTtlSeconds(): number {
    const raw = Number(this.configService.get<string>('AUTH_ACCESS_TOKEN_TTL_SECONDS', '900'));
    return Number.isFinite(raw) && raw > 60 ? Math.trunc(raw) : 900;
  }

  private getRefreshTokenTtlSeconds(): number {
    const raw = Number(this.configService.get<string>('AUTH_REFRESH_TOKEN_TTL_SECONDS', `${60 * 60 * 24 * 14}`));
    return Number.isFinite(raw) && raw > 300 ? Math.trunc(raw) : 60 * 60 * 24 * 14;
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private isValidRefreshTokenFormat(token: string): boolean {
    return /^[A-Za-z0-9_-]{40,200}$/.test(token.trim());
  }

  private async cleanupExpiredAuthArtifacts(): Promise<void> {
    await this.authChallengeRepository
      .createQueryBuilder()
      .delete()
      .where('expires_at <= NOW()')
      .execute();

    await this.authSessionRepository
      .createQueryBuilder()
      .delete()
      .where('expires_at <= NOW()')
      .execute();
  }

  private validateUri(uri: string, normalizedDomain: string): void {
    let parsed: URL;

    try {
      parsed = new URL(uri);
    } catch {
      throw new BadRequestException('Invalid URI.');
    }

    const normalizedHost = parsed.host.trim().toLowerCase();
    if (normalizedHost !== normalizedDomain) {
      throw new BadRequestException('URI domain mismatch.');
    }

    const isLocalhost = normalizedHost.startsWith('localhost');
    if (parsed.protocol !== 'https:' && !(isLocalhost && parsed.protocol === 'http:')) {
      throw new BadRequestException('URI must use HTTPS.');
    }
  }

  async createChallenge(address: string, domain: string, uri: string, chainId: number): Promise<{ challengeId: string; message: string; expiresAt: string }> {
    await this.cleanupExpiredAuthArtifacts();

    const walletAddress = this.normalizeWalletAddress(address);
    const normalizedDomain = this.normalizeDomain(domain);

    if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
      throw new BadRequestException('Invalid wallet address format.');
    }

    const allowedDomains = this.getAllowedAuthDomains();
    if (allowedDomains.length > 0 && !allowedDomains.includes(normalizedDomain)) {
      throw new BadRequestException('Unsupported auth domain.');
    }

    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('Invalid chainId.');
    }
    const allowedChainIds = this.getAllowedChainIds();
    if (allowedChainIds.length > 0 && !allowedChainIds.includes(chainId)) {
      throw new BadRequestException('Unsupported chainId.');
    }
    this.validateUri(uri, normalizedDomain);

    const now = new Date();
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.getChallengeTtlSeconds() * 1000);
    const message = [
      `${normalizedDomain} wants you to sign in with your Citizen wallet:`,
      walletAddress,
      '',
      `URI: ${uri}`,
      'Version: 1',
      `Chain ID: ${chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n');

    const challenge = this.authChallengeRepository.create({
      walletAddress,
      domain: normalizedDomain,
      uri,
      chainId,
      nonce,
      message,
      expiresAt,
      usedAt: null,
    });

    const saved = await this.authChallengeRepository.save(challenge);
    return {
      challengeId: saved.id,
      message: saved.message,
      expiresAt: saved.expiresAt.toISOString(),
    };
  }

  async verifyChallenge(input: VerifyChallengeInput): Promise<{
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    sessionId: string;
    user: { id: string; walletAddress: string };
    refreshToken: string;
    refreshExpiresAt: Date;
  }> {
    const normalizedAddress = this.normalizeWalletAddress(input.address);
    await this.authChallengeRepository.manager.transaction(async (manager) => {
      const locked = await manager
        .getRepository(AuthChallenge)
        .createQueryBuilder('challenge')
        .setLock('pessimistic_write')
        .where('challenge.id = :id', { id: input.challengeId })
        .getOne();

      if (!locked) {
        throw new UnauthorizedException('Challenge not found.');
      }

      if (locked.usedAt) {
        throw new UnauthorizedException('Challenge already used.');
      }

      if (locked.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Challenge expired.');
      }

      if (input.message !== locked.message) {
        throw new UnauthorizedException('Challenge message mismatch.');
      }

      if (normalizedAddress !== locked.walletAddress) {
        throw new UnauthorizedException('Wallet address mismatch.');
      }

      // Initial implementation gate:
      // requires non-empty wallet signature and reserves full secp256k1
      // recovery/verification for the next phase.
      if (!input.signature?.trim()) {
        throw new UnauthorizedException('Invalid signature.');
      }

      locked.usedAt = new Date();
      await manager.getRepository(AuthChallenge).save(locked);
    });

    let user = await this.authUserRepository.findOne({ where: { walletAddress: normalizedAddress } });
    if (!user) {
      user = this.authUserRepository.create({ walletAddress: normalizedAddress });
      user = await this.authUserRepository.save(user);
    }

    const refreshToken = this.createRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.getRefreshTokenTtlSeconds() * 1000);
    const session = this.authSessionRepository.create({
      userId: user.id,
      refreshTokenHash: this.hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: new Date(),
      userAgent: input.userAgent ?? '',
      ipAddress: input.ipAddress ?? '',
    });

    const savedSession = await this.authSessionRepository.save(session);
    const expiresIn = this.getAccessTokenTtlSeconds();
    const issuer = this.configService.get<string>('AUTH_JWT_ISSUER', 'citizen-landing-backend');
    const audience = this.configService.get<string>('AUTH_JWT_AUDIENCE', 'citizen-landing-frontend');

    const accessToken = this.jwtService.sign(
      {
        wallet: user.walletAddress,
        sessionId: savedSession.id,
      },
      {
        subject: user.id,
        issuer,
        audience,
        expiresIn,
      },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      sessionId: savedSession.id,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
      },
      refreshToken,
      refreshExpiresAt,
    };
  }

  async refreshSession(refreshToken: string): Promise<{
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    refreshToken: string;
    refreshExpiresAt: Date;
  }> {
    if (!refreshToken?.trim()) {
      throw new UnauthorizedException('Missing refresh token.');
    }
    if (!this.isValidRefreshTokenFormat(refreshToken)) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    await this.cleanupExpiredAuthArtifacts();

    const tokenHash = this.hashRefreshToken(refreshToken);
    const { session, nextRefreshToken } = await this.authSessionRepository.manager.transaction(async (manager) => {
      const lockedSession = await manager
        .getRepository(AuthSession)
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .leftJoinAndSelect('session.user', 'user')
        .where('session.refresh_token_hash = :tokenHash', { tokenHash })
        .andWhere('session.revoked_at IS NULL')
        .getOne();

      if (!lockedSession || !lockedSession.user || lockedSession.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      const rotatedRefreshToken = this.createRefreshToken();
      lockedSession.refreshTokenHash = this.hashRefreshToken(rotatedRefreshToken);
      lockedSession.lastUsedAt = new Date();
      await manager.getRepository(AuthSession).save(lockedSession);

      return {
        session: lockedSession,
        nextRefreshToken: rotatedRefreshToken,
      };
    });

    const issuer = this.configService.get<string>('AUTH_JWT_ISSUER', 'citizen-landing-backend');
    const audience = this.configService.get<string>('AUTH_JWT_AUDIENCE', 'citizen-landing-frontend');
    const expiresIn = this.getAccessTokenTtlSeconds();

    const accessToken = this.jwtService.sign(
      {
        wallet: session.user.walletAddress,
        sessionId: session.id,
      },
      {
        subject: session.user.id,
        issuer,
        audience,
        expiresIn,
      },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      refreshToken: nextRefreshToken,
      refreshExpiresAt: session.expiresAt,
    };
  }

  async revokeSession(refreshToken: string): Promise<void> {
    if (!refreshToken?.trim()) {
      return;
    }
    if (!this.isValidRefreshTokenFormat(refreshToken)) {
      return;
    }

    const tokenHash = this.hashRefreshToken(refreshToken);
    await this.authSessionRepository.manager.transaction(async (manager) => {
      const session = await manager
        .getRepository(AuthSession)
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.refresh_token_hash = :tokenHash', { tokenHash })
        .andWhere('session.revoked_at IS NULL')
        .getOne();

      if (!session) {
        return;
      }

      session.revokedAt = new Date();
      session.revokedReason = 'logout';
      await manager.getRepository(AuthSession).save(session);
    });
  }
}
