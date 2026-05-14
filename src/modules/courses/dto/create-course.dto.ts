import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsIn,
  IsObject,
} from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  subject?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  level?: string;

  @IsString()
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
