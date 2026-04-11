import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

  @IsOptional()
  @IsString()
  @MaxLength(220)
  attachmentName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  attachmentMimeType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  attachmentSha256?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280000)
  attachmentBase64?: string;

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
  @MaxLength(300000)
  walletSigningPayload!: string;

  @IsString()
  @Matches(/^ed25519$/i)
  walletAlgorithm!: string;
  @IsOptional()
  @IsIn(['payload_hash_v1', 'canonical_payload_v1'])
  walletSignatureScope?: 'payload_hash_v1' | 'canonical_payload_v1';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  walletReaderDid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  walletReaderX25519PublicKey?: string;
}
