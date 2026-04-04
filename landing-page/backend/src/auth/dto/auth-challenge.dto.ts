import { IsInt, IsString, Matches, MaxLength, Min } from 'class-validator';

export class AuthChallengeDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/)
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
}
