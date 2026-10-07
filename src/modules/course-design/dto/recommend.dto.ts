import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

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

