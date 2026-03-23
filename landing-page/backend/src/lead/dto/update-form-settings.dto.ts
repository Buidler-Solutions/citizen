import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  Min,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CampaignCardDto {
  @IsInt()
  @Min(1)
  weight!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  eyebrow!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(420)
  body!: string;
}

export class RoleOptionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  id!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1200)
  prompt!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(1600)
  thankYouNote!: string;

  @IsInt()
  @Min(1)
  weight!: number;
}

export class UpdateFormSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(220)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(260)
  subtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  siteLogoUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  siteLogoAlt?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  siteName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CampaignCardDto)
  campaignCards?: CampaignCardDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RoleOptionDto)
  roles?: RoleOptionDto[];
}
