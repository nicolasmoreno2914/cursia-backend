import { IsString, IsNotEmpty, IsOptional, MaxLength, IsBoolean, IsInt, Min } from 'class-validator';

export class CreateChapterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  objective?: string;

  @IsBoolean()
  @IsOptional()
  videoEnabled?: boolean;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
