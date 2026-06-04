import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreatePackageJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string | null;

  /** UUID del content_snapshot artifact (para que el worker descargue D y F). */
  @IsString()
  contentSnapshotArtifactId: string;

  /** UUID del h5p_snapshot artifact (para que el worker descargue MEDIA_HVP). */
  @IsOptional()
  @IsString()
  h5pSnapshotArtifactId?: string | null;

  /** UUID del audio_welcome artifact. */
  @IsOptional()
  @IsString()
  audioWelcomeArtifactId?: string | null;

  /** UUID del audiobook artifact. */
  @IsOptional()
  @IsString()
  audiobookArtifactId?: string | null;

  @IsOptional()
  @IsObject()
  options?: {
    moodleVersion?: string;
    validatePackage?: boolean;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
