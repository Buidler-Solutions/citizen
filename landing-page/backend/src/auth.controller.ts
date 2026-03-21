import { Body, Controller, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from './user/user.service';

interface TokenRequest {
  username: string;
  password: string;
  subject?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
  ) {}

  @Post('token')
  async token(@Body() body: TokenRequest) {
    const user = await this.userService.validateCredentials(body?.username ?? '', body?.password ?? '');
    const sub = body.subject?.trim() || user.username;
    const accessToken = this.jwtService.sign({ sub, role: user.role, username: user.username });

    return {
      accessToken,
      tokenType: 'Bearer',
      user: {
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }
}
