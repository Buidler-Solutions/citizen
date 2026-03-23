import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from "class-validator";

const AUDIENCE_MODES = ["all", "role", "selected"] as const;

type AudienceMode = (typeof AUDIENCE_MODES)[number];

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

  @ValidateIf((value: OnboardingUpdateDto) => value.audienceMode === "selected")
  @IsArray()
  @IsString({ each: true })
  leadIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  customSubject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  updateTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  updateBody?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  nextStep?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(500)
  ctaLink?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  messageHtml?: string;

  @IsOptional()
  @IsBoolean()
  includeAdminDashboardLink?: boolean;
}
