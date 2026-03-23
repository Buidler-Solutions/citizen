import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "../auth.module";
import { MailModule } from "../mail/mail.module";
import { OnboardingUser } from "./onboarding-user.entity";
import { UserController } from "./user.controller";

@Module({
  imports: [TypeOrmModule.forFeature([OnboardingUser]), AuthModule, MailModule],
  controllers: [UserController],
})
export class UserModule {}
