import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateSmtpSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(180)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  password?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(220)
  fromAddress?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(220)
  replyTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  defaultBcc?: string;

  @IsOptional()
  @IsBoolean()
  rejectUnauthorized?: boolean;
}
