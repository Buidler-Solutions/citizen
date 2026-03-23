import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

const AUDIENCE_MODES = ['all', 'role', 'selected'] as const;

type AudienceMode = typeof AUDIENCE_MODES[number];

export class OnboardingUpdateDto {
  @IsIn(AUDIENCE_MODES)
  audienceMode!: AudienceMode;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ValidateIf((value: OnboardingUpdateDto) => value.audienceMode === 'selected')
  @IsArray()
  @IsString({ each: true })
  leadIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  customSubject?: string;

  @IsString()
  messageHtml!: string;

  @IsOptional()
  @IsBoolean()
  includeAdminDashboardLink?: boolean;
}
