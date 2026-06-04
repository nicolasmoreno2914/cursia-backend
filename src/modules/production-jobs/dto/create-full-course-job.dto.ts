import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateFullCourseJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsObject()
  courseData?: Record<string, any>;

  @IsOptional()
  @IsObject()
  options?: {
    generateContent?: boolean;
    generateAudio?: boolean;
    generateVideos?: boolean;
    uploadToYoutube?: boolean;
    generatePackage?: boolean;
    audiobookOptional?: boolean;
    maxVideoChapters?: number;
  };

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
