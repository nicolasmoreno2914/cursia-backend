import { IsString, IsNotEmpty, IsOptional, MaxLength, IsBoolean, IsInt, Min, IsIn, IsArray, ArrayMaxSize, ArrayUnique, Matches } from 'class-validator';

export class CreateChapterDto {
  // Title Normalization: se aceptan hasta 1000 caracteres para poder SEPARAR un título pegado con su
  // descripción; el servicio guarda un título ≤ 80 (o responde CHAPTER/MODULE_TITLE_TOO_LONG).
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  title: string;

  @IsString()
  @IsOptional()
  objective?: string;

  /** Detalle/alcance del módulo o capítulo (lo que antes se metía en el título). */
  @IsString()
  @IsOptional()
  @MaxLength(2000) // = STRUCTURE_DESCRIPTION_MAX (una separación automática puede dejarla > 1000)
  description?: string;

  @IsBoolean()
  @IsOptional()
  videoEnabled?: boolean;

  // V2.1 (R3): toggle "Actividad" del capítulo; ausente → default de la DB (true).
  @IsBoolean()
  @IsOptional()
  activityEnabled?: boolean;

  // Motor de carga horaria: 'practice' = capítulo de práctica (sin video, presentación, audiolibro ni Libro);
  // ausente → 'content' (el de siempre).
  @IsIn(['content', 'practice'])
  @IsOptional()
  kind?: 'content' | 'practice';

  // Fase 2 · Actividades de Aplicación: minutos de la actividad del capítulo (30/60/90/120); null = sin actividad;
  // ausente → sin cambio (al crear: sin actividad).
  @IsIn([30, 60, 90, 120])
  @IsOptional()
  applicationMinutes?: 30 | 60 | 90 | 120 | null;

  // Fase 3 · Contexto académico: resultados de aprendizaje / competencias que el capítulo debe evidenciar (1–8 ids del
  // contexto académico vigente, «RA1», «CO2»…); null o [] = sin vínculos; ausente → sin cambio.
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @Matches(/^(RA|CO)[0-9]{1,3}$/, { each: true })
  @IsOptional()
  outcomeIds?: string[] | null;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
