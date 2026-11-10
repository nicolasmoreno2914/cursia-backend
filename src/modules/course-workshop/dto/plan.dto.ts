import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PLAN_LIMITS } from '../plan/types';

/** r107 B5 · `POST …/sessions/:id/requests`: pedido escrito (texto libre). */
export class CreateTextRequestDto {
  @IsString()
  @MaxLength(PLAN_LIMITS.textMaxChars)
  text: string;
}

/** r107 B5 · `POST …/sessions/:id/requests/document`: nombre y tamaño del documento que el navegador va a subir. */
export class CreateDocumentRequestDto {
  @IsString()
  @MaxLength(255)
  filename: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PLAN_LIMITS.documentMaxBytes)
  sizeBytes: number;
}

export class ClarifyAnswerDto {
  @IsString()
  @MaxLength(40)
  questionId: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  optionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PLAN_LIMITS.answerTextMaxChars)
  text?: string;
}

/** r107 B5 · `POST …/requests/:requestId/answers`. */
export class AnswerRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PLAN_LIMITS.questionsMax)
  @ValidateNested({ each: true })
  @Type(() => ClarifyAnswerDto)
  answers: ClarifyAnswerDto[];
}

/** Ronda de decisiones · aprobación de gasto de IA: el estimado que el docente vio y el tope que aprueba (USD). */
export class ConfirmSpendDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  confirmEstimateUsd: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1000)
  capUsd: number;
}

/** `POST …/plans/:planId/generate`: ítems a generar + estimado confirmado + tope. */
export class GenerateItemsDto extends ConfirmSpendDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  itemIds: string[];
}

/** r107 B6 · ítem aprobado: su id + la huella del contenido que el docente revisó (la da GET …/plan). */
export class ApprovedItemDto {
  @IsUUID('all')
  id: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  contentHash: string;
}

/**
 * r107 B6 (fix round 1, P2-2) · `POST …/plans/:planId/apply`: lo que el docente aprueba, ATADO al contenido que vio —
 * la huella del plan (`plan.apply.planHash`), cada ítem con su huella y las confirmaciones de riesgo alto con la suya.
 */
export class ApplyPlanDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  planHash: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApprovedItemDto)
  items: ApprovedItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApprovedItemDto)
  confirm?: ApprovedItemDto[];
}

/** r107 B6 · `POST …/sessions/:id/identification/confirm`: el candidato que el docente confirma como su curso. */
export class ConfirmCandidateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  courseId: number;
}
