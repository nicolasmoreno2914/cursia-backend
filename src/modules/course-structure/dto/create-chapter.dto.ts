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

  // V2.1 (R3): toggle "Actividad" del capítulo; ausente → default de la DB (true).
  @IsBoolean()
  @IsOptional()
  activityEnabled?: boolean;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
