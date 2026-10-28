import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** LOOP 8.3 · «Ajustar»: cambios sobre el diseño que se recalcula (nada se guarda). Ausente = lo que ya decidió el curso. */
export class DesignAdjustDto {
  /** Horas de trabajo del estudiante (1–500, pasos de 0,5) o 'auto' (las propone Cursia). */
  @IsOptional()
  targetHours?: number | 'auto';

  @IsOptional() @IsIn(['application', 'balanced', 'depth'])
  emphasis?: 'application' | 'balanced' | 'depth';

  @IsOptional() @IsIn(['auto', 'practice_only', 'none'])
  applicationActivities?: 'auto' | 'practice_only' | 'none';

  @IsOptional() @IsIn(['less', 'recommended', 'more'])
  audiovisual?: 'less' | 'recommended' | 'more';

  /** Loop 9 B (fix I1): ejercicios guiados para completar horas cuando el documento fija la forma ('auto') o nunca ('none'). */
  @IsOptional() @IsIn(['auto', 'none'])
  guidedPractice?: 'auto' | 'none';

  /**
   * r79 · «Presupuesto de producción del curso (USD)» (1–5000; null lo quita). Solo con DYNAMIC_BUDGET_FIT; sin el
   * interruptor se ignora. Es una referencia para diseñar: nunca el «Tope autorizado» de la generación.
   */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(5000)
  productionBudgetUsd?: number | null;

  /** Enfoque principal, o 'recommended' (el que recomienda Cursia). */
  @IsOptional() @IsString() @MaxLength(64)
  approach?: string;
}

export class RecommendDesignDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignAdjustDto)
  adjust?: DesignAdjustDto;

  /** LOOP 8.6C · «Volver al requisito del documento»: la vista previa ignora la decisión registrada de esos campos. */
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['audiovisual', 'applicationActivities'], { each: true })
  clearDecisions?: ('audiovisual' | 'applicationActivities')[];
}

/**
 * LOOP 8.6C · Decisiones del docente que pueden apartarse del documento (las registra «Usar este diseño»). null = ya no
 * hay decisión del docente en ese campo (vuelve a mandar el documento).
 */
export class RequirementDecisionsDto {
  @IsOptional() @IsIn(['less', 'recommended', 'more'])
  audiovisual?: 'less' | 'recommended' | 'more' | null;

  @IsOptional() @IsIn(['auto', 'practice_only', 'none'])
  applicationActivities?: 'auto' | 'practice_only' | 'none' | null;

  /** Review L86C I1: prioridad audiovisual que eligió Cursia para cumplir el documento (null = ninguna). */
  @IsOptional() @IsIn(['less', 'recommended', 'more'])
  cursiaAudiovisual?: 'less' | 'recommended' | 'more' | null;
}


/** Review L83 I-3: horas propuestas por Cursia que «Usar este diseño» guardó (null = las horas no son de Cursia). */
export class HoursOriginDto {
  @IsOptional()
  @IsNumber()
  proposed?: number | null;
}

/** LOOP 8.4 · «Corregir» automático de la verificación. */
export class DesignFixDto {
  /**
   * r71 · autofix = «Cursia optimizó tu curso» (lo que se deduce con evidencia, con su registro); autofix_undo = «Deshacer»
   * (changeIds; sin ellos, todo lo aplicado); link_outcome = el docente vincula UN resultado a UN capítulo (acción en línea
   * de la propuesta); context_field = el docente completa un dato del curso que falta (acción en línea).
   * r72 · accept_proposal { proposalId, chapterId?, text? } = el docente acepta una propuesta de Cursia (ajuste de contenido,
   * competencia faltante); context_field con field 'priorKnowledge' = responde «¿Qué sabe ya el estudiante?».
   */
  @IsIn(['link_outcomes', 'cover_contents', 'autofix', 'autofix_undo', 'link_outcome', 'context_field', 'accept_proposal'])
  action: 'link_outcomes' | 'cover_contents' | 'autofix' | 'autofix_undo' | 'link_outcome' | 'context_field' | 'accept_proposal';

  @IsInt()
  @Min(0)
  expectedCounter: number;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(80, { each: true })
  changeIds?: string[];

  @IsOptional() @IsString() @MaxLength(40)
  outcomeId?: string;

  @IsOptional() @IsString() @MaxLength(40)
  chapterId?: string;

  @IsOptional() @IsIn(['sector', 'pais', 'ciudad', 'tono', 'priorKnowledge'])
  field?: 'sector' | 'pais' | 'ciudad' | 'tono' | 'priorKnowledge';

  @IsOptional() @IsString() @MaxLength(255)
  value?: string;

  @IsOptional() @IsString() @MaxLength(80)
  proposalId?: string;

  @IsOptional() @IsString() @MaxLength(600)
  text?: string;
}

/** Fase 2/3 · POST /courses/:courseId/design/structure-preview — vista previa de una forma (no aplica nada). */
export class StructurePreviewDto {
  @IsInt()
  @Min(1)
  @Max(50)
  modules: number;

  @IsInt()
  @Min(1)
  @Max(30)
  chaptersPerModule: number;

  @IsOptional()
  @IsIn(['S', 'M', 'L'])
  format?: 'S' | 'M' | 'L';
}
