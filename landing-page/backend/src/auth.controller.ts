import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthChallengeDto } from './auth/dto/auth-challenge.dto';
import { ForgotPasswordDto } from './auth/dto/forgot-password.dto';
import { ResetPasswordDto } from './auth/dto/reset-password.dto';
import { AuthVerifyDto } from './auth/dto/auth-verify.dto';
import { OnboardingNotificationService } from './mail/onboarding-notification.service';
import { UserService } from './user/user.service';
import { WalletAuthService } from './wallet-auth.service';

interface TokenRequest {
  username: string;
  password: string;
  subject?: string;
}

const REFRESH_COOKIE_NAME = 'ctzn_refresh_token';


const parseCookieValue = (cookieHeader: string | string[] | undefined, cookieName: string): string | undefined => {
  const normalizedHeader = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;

  if (!normalizedHeader) {
    return undefined;
  }

  return normalizedHeader
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly onboardingNotificationService: OnboardingNotificationService,
    private readonly walletAuthService: WalletAuthService,
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

  @Post('challenge')
  async challenge(
    @Body() payload: AuthChallengeDto,
    @Req() request: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ) {
    const forwarded = request.headers['x-forwarded-for'];
    const firstForwardedIp = Array.isArray(forwarded)
      ? String(forwarded[0] ?? '')
      : String(forwarded ?? '').split(',')[0]?.trim();
    const ipAddress = firstForwardedIp || request.ip || '';
    return this.walletAuthService.createChallenge(
      payload.address,
      payload.domain,
      payload.uri,
      payload.chainId,
      ipAddress,
    );
  }

  @Post('verify')
  async verify(
    @Body() payload: AuthVerifyDto,
    @Req() request: { headers: Record<string, string | string[] | undefined>; ip?: string },
    @Res({ passthrough: true }) response: { cookie: (...args: unknown[]) => void },
  ) {
    const authResult = await this.walletAuthService.verifyChallenge({
      challengeId: payload.challengeId,
      message: payload.message,
      signature: payload.signature,
      address: payload.address,
      userAgent: String(request.headers['user-agent'] ?? ''),
      ipAddress: request.ip ?? '',
    });

    response.cookie(REFRESH_COOKIE_NAME, authResult.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
      expires: authResult.refreshExpiresAt,
    });

    return {
      accessToken: authResult.accessToken,
      tokenType: authResult.tokenType,
      expiresIn: authResult.expiresIn,
      sessionId: authResult.sessionId,
      user: authResult.user,
    };
  }

  @Post('refresh')
  async refresh(
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) response: { cookie: (...args: unknown[]) => void },
  ) {
    const refreshToken = parseCookieValue(request.headers.cookie, REFRESH_COOKIE_NAME);
    const authResult = await this.walletAuthService.refreshSession(refreshToken ?? '');
    response.cookie(REFRESH_COOKIE_NAME, authResult.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
      expires: authResult.refreshExpiresAt,
    });

    return {
      accessToken: authResult.accessToken,
      tokenType: authResult.tokenType,
      expiresIn: authResult.expiresIn,
    };
  }

  @Post('logout')
  async logout(
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) response: { clearCookie: (...args: unknown[]) => void },
  ) {
    const refreshToken = parseCookieValue(request.headers.cookie, REFRESH_COOKIE_NAME);
    await this.walletAuthService.revokeSession(refreshToken ?? '');

    response.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
    });

    return { ok: true };
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
