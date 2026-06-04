import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateH5PJobDto {
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

  @IsOptional()
  @IsString()
  videoStateSnapshotArtifactId?: string | null;

  @IsOptional()
  @IsArray()
  youtubeUploads?: Array<Record<string, any>>;

  @IsOptional()
  @IsObject()
  courseData?: Record<string, any>;

  @IsOptional()
  @IsObject()
  options?: {
    restoreFirst?: boolean;
    requireYoutubeUrls?: boolean;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
