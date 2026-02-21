import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

interface TokenRequest {
  adminKey: string;
  subject?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('token')
  token(@Body() body: TokenRequest) {
    const expectedAdminKey = this.configService.get<string>('JWT_ADMIN_KEY', 'change-me-admin-key');

    if (!body?.adminKey || body.adminKey !== expectedAdminKey) {
      throw new ForbiddenException('Invalid admin key');
    }

    const sub = body.subject?.trim() || 'landing-admin';
    const accessToken = this.jwtService.sign({ sub, role: 'admin' });

    return { accessToken, tokenType: 'Bearer' };
  }
}
