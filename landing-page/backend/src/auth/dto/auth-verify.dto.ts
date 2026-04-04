import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AuthVerifyDto {
  @IsString()
  @MaxLength(64)
  challengeId!: string;

  @IsString()
  message!: string;

  @IsString()
  signature!: string;

  @IsString()
  @MaxLength(180)
  address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheme?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  publicKey?: string;
}
