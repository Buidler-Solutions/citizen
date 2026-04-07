import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class AuthChallengeDto {
  @IsString()
  @MaxLength(180)
  address!: string;

  @IsString()
  @MaxLength(160)
  domain!: string;

  @IsString()
  @MaxLength(255)
  uri!: string;

  @IsInt()
  @Min(1)
  chainId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheme?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  publicKey?: string;
}
