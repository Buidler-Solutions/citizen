import { IsString, Matches, MaxLength } from 'class-validator';

export class AuthVerifyDto {
  @IsString()
  @MaxLength(64)
  challengeId!: string;

  @IsString()
  message!: string;

  @IsString()
  signature!: string;

  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  address!: string;
}
