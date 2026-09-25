import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';
import { RULE_ORDER } from '../coherence-types';
import { LLM_EVIDENCE_MAX_BYTES, LLM_TEXT_MAX_CHARS } from '../llm-merge';

/** `POST /courses/:courseId/coherence/structure`: sin body = estructura VIVA; con `blueprintNumber` = ese Blueprint. */
export class StructureCoherenceDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  blueprintNumber?: number;
}

/** Tope de findings LLM por envío (la entrada del LLM ya es compacta; esto acota el body). */
export const MAX_LLM_FINDINGS = 200;
/** Tope de UUIDs por finding (módulos o capítulos). */
export const MAX_LLM_FINDING_IDS = 50;

/**
 * Fix wave I1: reglas aceptadas en un finding LLM — las ids determinísticas
 * (S1…C7), 'LLM' y un vocabulario cerrado de categorías. Cualquier otra → 400.
 */
export const LLM_FINDING_RULES: readonly string[] = [
  ...RULE_ORDER,
  'LLM',
  'duplication',
  'progression',
  'prerequisite',
  'coverage',
  'consistency',
  'terminology',
  'drift',
  'other',
];
export const LLM_FINDING_SEVERITIES: readonly string[] = ['info', 'warning', 'error'];
export const LLM_SUGGESTED_ACTIONS: readonly string[] = ['review', 'regenerate_chapter'];

/** JSON serializado de `value` ≤ `maxBytes` (UTF-8). */
function MaxSerializedBytes(maxBytes: number, options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'maxSerializedBytes',
      constraints: [maxBytes],
      validator: {
        validate: (value: unknown) => {
          try {
            return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') <= maxBytes;
          } catch {
            return false;
          }
        },
        defaultMessage: () => `$property: el JSON serializado supera ${maxBytes} bytes`,
      },
    },
    options,
  );
}

/** Un finding de la capa LLM (fix wave I1: límites por campo; los UUID se validan en mergeLlmFindings). */
export class LlmFindingDto {
  @IsOptional()
  @IsIn(LLM_FINDING_RULES as string[])
  rule?: string;

  @IsOptional()
  @IsIn(LLM_FINDING_SEVERITIES as string[])
  severity?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LLM_FINDING_IDS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  moduleIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LLM_FINDING_IDS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  chapterIds?: string[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(LLM_TEXT_MAX_CHARS)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(LLM_TEXT_MAX_CHARS)
  suggestion?: string;

  @IsOptional()
  @IsObject()
  @MaxSerializedBytes(LLM_EVIDENCE_MAX_BYTES)
  evidence?: Record<string, unknown>;

  @IsOptional()
  @IsIn(LLM_SUGGESTED_ACTIONS as string[])
  suggestedAction?: string;
}

/**
 * `POST …/runs/:runId/coherence/llm-findings`: resultado de la revisión LLM
 * que corre en el navegador (spec Fase 7 §1). Límites por campo en
 * LlmFindingDto (400); los UUID inexistentes se descartan y cuentan en
 * `mergeLlmFindings`.
 */
export class LlmFindingsDto {
  @IsString()
  @MaxLength(200)
  model: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  promptSha256: string;

  @IsArray()
  @ArrayMaxSize(MAX_LLM_FINDINGS)
  @ValidateNested({ each: true })
  @Type(() => LlmFindingDto)
  findings: LlmFindingDto[];
}
