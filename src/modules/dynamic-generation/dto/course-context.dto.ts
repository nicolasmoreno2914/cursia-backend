import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PrevCourseDto {
  @IsString()
  @MaxLength(255)
  nombre: string;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  caps: string[];
}

/**
 * Contexto global mínimo del curso que necesitan los prompts (spec §3.5),
 * congelado al iniciar un run en `generation_run_contexts` (inmutable). Con el
 * ValidationPipe global (whitelist + forbidNonWhitelisted) cualquier campo
 * desconocido — también dentro de `prevCourse` — es 400.
 */
export class CourseContextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sector: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  pais: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ciudad?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  contexto: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nivel: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tono: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  obj?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PrevCourseDto)
  prevCourse?: PrevCourseDto;
}
