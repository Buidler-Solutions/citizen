import { Body, Controller, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ForgotPasswordDto } from './auth/dto/forgot-password.dto';
import { ResetPasswordDto } from './auth/dto/reset-password.dto';
import { OnboardingNotificationService } from './mail/onboarding-notification.service';
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
    private readonly onboardingNotificationService: OnboardingNotificationService,
  ) {}

  @Post('token')
  async token(@Body() body: TokenRequest) {
    const user = await this.userService.validateCredentials(body?.username ?? '', body?.password ?? '');
    const sub = body.subject?.trim() || user.username;
    const accessToken = this.jwtService.sign({ sub, role: user.role, username: user.username, email: user.email });

    return {
      accessToken,
      tokenType: 'Bearer',
      user: {
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  @Post('forgot-password')
  async forgotPassword(@Body() payload: ForgotPasswordDto) {
    const reset = await this.userService.createPasswordReset(payload.identifier);

    if (reset) {
      await this.onboardingNotificationService.sendForgotPasswordEmail(reset.user, reset.token, reset.expiresAt);
    }

    return {
      ok: true,
      message: 'If the account exists and has a recovery email, a reset link has been sent.',
    };
  }

  @Post('reset-password')
  async resetPassword(@Body() payload: ResetPasswordDto) {
    const user = await this.userService.resetPassword(payload.email, payload.token, payload.password);

    return {
      ok: true,
      message: 'Password reset successfully.',
      user: {
        username: user.username,
        email: user.email,
        role: user.role,
      },
    };
  }
}
