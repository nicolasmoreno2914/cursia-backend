import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateGammaJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  courseTitle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string | null;

  @IsString()
  contentSnapshotArtifactId: string;

  /** id de paleta Cursia (navy-teal, ocean, berry, slate, indigo, medianoche) — resuelve el themeId de Gamma. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  paletteId?: string | null;

  @IsOptional()
  @IsObject()
  courseData?: Record<string, any>;

  @IsOptional()
  @IsObject()
  options?: {
    restoreFirst?: boolean;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
