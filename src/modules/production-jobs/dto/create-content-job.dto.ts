import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class ContentConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxRetriesPerFile?: number;
}

class CourseModuleDto {
  @IsString()
  @MaxLength(255)
  n: string;

  @IsArray()
  @IsString({ each: true })
  caps: string[];
}

class CourseDataDto {
  @IsString()
  @MaxLength(255)
  nombre: string;

  @IsOptional()
  @IsString()
  comp?: string;

  @IsOptional()
  @IsString()
  pais?: string;

  @IsOptional()
  @IsString()
  ciudad?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsString()
  mid?: string;

  @IsOptional()
  @IsString()
  lms?: string;

  @IsOptional()
  @IsString()
  nivel?: string;

  @IsOptional()
  @IsString()
  tono?: string;

  @IsOptional()
  @IsString()
  contexto?: string;

  @IsOptional()
  @IsString()
  obj?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  horas?: number;

  @IsOptional()
  @IsObject()
  pal?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CourseModuleDto)
  mods?: CourseModuleDto[];

  @IsOptional()
  @IsArray()
  caps?: any[];

  @IsOptional()
  @IsObject()
  prevCourse?: Record<string, any>;
}

export class CreateContentJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['backend_content'])
  executionMode?: 'backend_content';

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentConfigDto)
  contentConfig?: ContentConfigDto;

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
