import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
} from 'class-validator';

export class CreateCourseVersionDto {
  @IsString()
  @IsOptional()
  @IsIn(['draft', 'ready', 'exported'])
  status?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsObject()
  @IsOptional()
  snapshotJson?: Record<string, any>;
}
