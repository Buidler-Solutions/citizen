import { IsString, MaxLength } from 'class-validator';

export class UpdateEmailTemplateDto {
  @IsString()
  @MaxLength(220)
  subject!: string;

  @IsString()
  @MaxLength(20000)
  html!: string;
}
