import { Type } from 'class-transformer';
import { Allow, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { QUALITY_LIMITS } from '../quality/types';

/**
 * r107 B8 · `POST …/sessions/:id/quality`. Sin `confirmEstimateUsd`/`capUsd`: arranca (o devuelve) la parte determinista
 * gratis y el ESTIMADO por capítulo de la revisión con IA, sin llamar a nada. Con ellos: aprueba revisar con IA el
 * alcance elegido (`chapters`: `'all'` o los números) con ese tope; el servidor valida el alcance.
 */
export class QualityRunDto {
  @IsOptional()
  @Allow()
  chapters?: 'all' | number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  confirmEstimateUsd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1000)
  capUsd?: number;
}

/**
 * r107 B8 · `POST …/sessions/:id/questions`. Con `text`: registra la pregunta y recupera su evidencia (sin IA). Con
 * `questionId` + `confirmEstimateUsd` + `capUsd`: aprueba responderla con IA dentro de ese tope.
 */
export class AskQuestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(QUALITY_LIMITS.questionMaxChars)
  text?: string;

  @IsOptional()
  @IsUUID('all')
  questionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  confirmEstimateUsd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1000)
  capUsd?: number;
}
