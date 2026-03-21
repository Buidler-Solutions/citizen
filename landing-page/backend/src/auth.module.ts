import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OnboardingUser } from './user/onboarding-user.entity';
import { UserService } from './user/user.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([OnboardingUser]),
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
  providers: [JwtAuthGuard, UserService],
  exports: [JwtAuthGuard, JwtModule, UserService],
})
export class AuthModule {}
