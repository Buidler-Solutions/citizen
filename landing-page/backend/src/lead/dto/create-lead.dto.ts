import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

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
  @IsNotEmpty()
  @MaxLength(2000)
  missionNeed!: string;
}
