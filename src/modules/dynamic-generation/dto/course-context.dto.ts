import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Modo de video del run (R17, Fase 5A Task 4): 'mock' (default) nunca llama a Videogen; 'real' sí. Fijo por run. */
export const RUN_VIDEO_MODES = ['mock', 'real'] as const;
export type RunVideoMode = (typeof RUN_VIDEO_MODES)[number];

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

  /**
   * R18: legacy `ctx()` (02-run.js:19) también lee `D.comp` (competencia a
   * desarrollar) y la inyecta en TODOS los prompts — omitirla degradaba el
   * contexto en silencio (spec §3.5 la había dejado fuera por descuido).
   * Mismo tratamiento que `obj`: opcional, se normaliza/descarta si viene
   * vacía (run-hash.ts CONTEXT_STRING_FIELDS) — contextos ya congelados sin
   * `comp` no cambian su hash.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PrevCourseDto)
  prevCourse?: PrevCourseDto;

  /**
   * R17: modo de video del run, fijado SOLO al crear (default 'mock' si se
   * omite); nunca se actualiza después, ni siquiera al reabrir. No forma
   * parte del contexto congelado (normalizeCourseContext lo ignora: solo
   * copia CONTEXT_STRING_FIELDS + prevCourse) — vive en
   * production_jobs.input_payload.videoMode.
   */
  @IsOptional()
  @IsIn(RUN_VIDEO_MODES as unknown as string[])
  videoMode?: RunVideoMode;

  /**
   * R19 (Fase 5A Task 6a): ids de plantilla SCORM v2 activos, congelados al
   * iniciar el run — resueltos en el navegador vía
   * `sv2ResolveActiveTemplateIds(SEL.scormTemplates, SCORM_V2_TEMPLATES)`
   * ANTES de llamar a este endpoint (freeze point único, condición 1: el
   * ejecutor nunca relee `SEL`). SÍ forma parte del contexto congelado
   * (normalizeCourseContext lo copia, orden preservado, vacío → ausente) —
   * dos runs con distinta selección de plantillas son contextos distintos.
   * Ausente → el ejecutor usa el catálogo completo por defecto (mismo
   * fallback que `sv2ResolveActiveTemplateIds(undefined, ...)`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  scormTemplateIds?: string[];
}
