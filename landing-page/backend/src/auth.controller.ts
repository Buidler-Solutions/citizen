import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

interface TokenRequest {
  username: string;
  password: string;
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
    const expectedUsername = this.configService.get<string>('ADMIN_USERNAME', 'admin');
    const expectedPassword = this.configService.get<string>('ADMIN_PASSWORD', 'change-me-admin-password');

    if (
      !body?.username
      || !body?.password
      || body.username !== expectedUsername
      || body.password !== expectedPassword
    ) {
      throw new ForbiddenException('Invalid admin username or password');
    }

    const sub = body.subject?.trim() || body.username.trim() || 'admin';
    const accessToken = this.jwtService.sign({ sub, role: 'admin' });

    return { accessToken, tokenType: 'Bearer' };
  }
}
