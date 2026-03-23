import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OnboardingUserRole } from '../onboarding-user.entity';

export class CreateOnboardingUserDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  username!: string;

  @IsEmail()
  @MaxLength(180)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  fullName?: string;

  @IsIn(['admin', 'user'])
  role!: Exclude<OnboardingUserRole, 'super_admin'>;
}
