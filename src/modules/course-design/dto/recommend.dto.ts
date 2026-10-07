import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

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
  @IsIn(['link_outcomes'])
  action: 'link_outcomes';

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
