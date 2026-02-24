import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}
