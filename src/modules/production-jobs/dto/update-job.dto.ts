import { IsOptional, IsString, IsNumber, IsObject, IsDateString } from 'class-validator';

export class UpdateJobDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  current_step?: string;

  @IsOptional()
  @IsNumber()
  progress?: number;

  @IsOptional()
  @IsDateString()
  started_at?: string;

  @IsOptional()
  @IsDateString()
  finished_at?: string;

  @IsOptional()
  @IsString()
  error_message?: string;

  @IsOptional()
  @IsString()
  error_step?: string;

  @IsOptional()
  @IsObject()
  result?: Record<string, any>;
}
