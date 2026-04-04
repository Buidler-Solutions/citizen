import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthChallenge } from './auth/auth-challenge.entity';
import { AuthSession } from './auth/auth-session.entity';
import { AuthUser } from './auth/auth-user.entity';
import { AuthController } from './auth.controller';
import { PasswordReset } from './auth/password-reset.entity';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MailModule } from './mail/mail.module';
import { OnboardingUser } from './user/onboarding-user.entity';
import { UserService } from './user/user.service';
import { WalletAuthService } from './wallet-auth.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([OnboardingUser, PasswordReset, AuthUser, AuthChallenge, AuthSession]),
    forwardRef(() => MailModule),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'change-me-in-production'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '1d'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [JwtAuthGuard, UserService, WalletAuthService],
  exports: [JwtAuthGuard, JwtModule, UserService, WalletAuthService],
})
export class AuthModule {}
