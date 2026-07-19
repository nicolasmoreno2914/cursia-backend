import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class VideoConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;
}

class CourseDataDto {
  @IsString()
  @MaxLength(255)
  nombre: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsString()
  nivel?: string;

  @IsOptional()
  @IsObject()
  extra?: Record<string, any>;
}

export class CreateVideoJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['backend_videos'])
  executionMode?: 'backend_videos';

  @IsOptional()
  @IsString()
  contentSnapshotArtifactId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoConfigDto)
  videoConfig?: VideoConfigDto;

  @ValidateNested()
  @Type(() => CourseDataDto)
  courseData: CourseDataDto;

  @IsOptional()
  @IsObject()
  options?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
