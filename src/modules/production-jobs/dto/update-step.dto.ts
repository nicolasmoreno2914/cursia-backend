import { IsOptional, IsString, IsNumber, IsDateString } from 'class-validator';

export class UpdateStepDto {
  @IsOptional()
  @IsString()
  status?: string;

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
  error?: string;

  @IsOptional()
  @IsString()
  detail?: string;
}
