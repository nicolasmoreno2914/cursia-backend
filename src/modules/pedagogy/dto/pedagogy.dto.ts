import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';

/** POST /pedagogy/recommend — respuestas (parciales) de «No estoy seguro»; las valida recommendation.ts. */
export class RecommendPedagogyDto {
  @IsObject()
  answers: Record<string, unknown>;
}

/** POST /pedagogy/dry-run — estructura propuesta (o snapshot v2) + perfil; los valida dry-run.ts. */
export class InlineDryRunDto {
  @IsObject()
  structure: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown> | null;

  @IsOptional()
  @IsIn([0, 1, 2])
  activityTypeRules?: 0 | 1 | 2;

  @IsOptional()
  @IsBoolean()
  applyStructureAdjustments?: boolean;
}

/**
 * POST /courses/:courseId/pedagogy/dry-run — la estructura VIVA del curso. `profile` (opcional)
 * reemplaza al perfil guardado para previsualizar sin guardar; sin él se usa el vigente.
 */
export class CourseDryRunDto {
  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown> | null;

  @IsOptional()
  @IsIn([0, 1, 2])
  activityTypeRules?: 0 | 1 | 2;

  @IsOptional()
  @IsBoolean()
  applyStructureAdjustments?: boolean;
}
