import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
