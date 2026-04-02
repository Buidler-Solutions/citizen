import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateLeadDto {
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  fullName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(180)
  institution!: string;

  @IsEmail()
  @MaxLength(180)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  country!: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @MaxLength(80)
  role!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  missionNeed!: string;

  @IsString()
  @Matches(/^did:key:ed25519:[a-f0-9]{64}$/i)
  walletSignerDid!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  walletVerifyingKey!: string;

  @IsString()
  @Matches(/^[a-f0-9]+$/i)
  @MaxLength(512)
  walletSignature!: string;

  @IsString()
  @Matches(/^sha256:[a-f0-9]{64}$/i)
  walletPayloadHash!: string;

  @IsString()
  @MaxLength(5000)
  walletSigningPayload!: string;

  @IsString()
  @Matches(/^ed25519$/i)
  walletAlgorithm!: string;
}
