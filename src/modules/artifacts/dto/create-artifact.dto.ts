import { IsOptional, IsString, IsNumber, IsObject } from 'class-validator';

export class CreateArtifactDto {
  @IsOptional()
  @IsString()
  course_id?: string;

  @IsOptional()
  @IsString()
  job_id?: string;

  @IsString()
  type: string;

  @IsString()
  storage_path: string;

  @IsOptional()
  @IsString()
  storage_provider?: string;

  @IsOptional()
  @IsString()
  storage_bucket?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  mime_type?: string;

  @IsOptional()
  @IsNumber()
  size_bytes?: number;

  @IsOptional()
  @IsString()
  checksum_sha256?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
