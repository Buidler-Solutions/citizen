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
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(420)
  body!: string;
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
  @MinLength(5)
  @MaxLength(1200)
  validatorPrompt?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(1200)
  builderPrompt?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(1200)
  observerPrompt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CampaignCardDto)
  campaignCards?: CampaignCardDto[];
}
