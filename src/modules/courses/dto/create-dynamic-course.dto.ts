import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateDynamicCourseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  frontendCourseId: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  title?: string;
}
