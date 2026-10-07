import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

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
