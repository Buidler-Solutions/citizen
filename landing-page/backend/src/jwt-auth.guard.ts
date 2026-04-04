import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, IsNull } from 'typeorm';
import { AuthSession } from './auth/auth-session.entity';

interface JwtClaims {
  sub?: string;
  sessionId?: string;
  [key: string]: unknown;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length).trim();

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const issuer = this.configService.get<string>('AUTH_JWT_ISSUER', 'citizen-landing-backend');
      const audience = this.configService.get<string>('AUTH_JWT_AUDIENCE', 'citizen-landing-frontend');
      const claims = await this.jwtService.verifyAsync<JwtClaims>(token, {
        issuer,
        audience,
      });

      if (claims.sessionId) {
        const session = await this.dataSource.getRepository(AuthSession).findOne({
          where: {
            id: claims.sessionId,
            revokedAt: IsNull(),
          },
        });

        if (!session || session.expiresAt.getTime() <= Date.now()) {
          throw new UnauthorizedException('Session revoked or expired');
        }
      }

      request.user = claims;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
