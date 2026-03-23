import { IsEmail, MaxLength } from 'class-validator';

export class TestSmtpSettingsDto {
  @IsEmail()
  @MaxLength(220)
  to!: string;
}
