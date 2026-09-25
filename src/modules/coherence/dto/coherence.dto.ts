import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/** `POST /courses/:courseId/coherence/structure`: sin body = estructura VIVA; con `blueprintNumber` = ese Blueprint. */
export class StructureCoherenceDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  blueprintNumber?: number;
}

/** Tope de findings LLM por envío (la entrada del LLM ya es compacta; esto acota el body). */
export const MAX_LLM_FINDINGS = 200;

/**
 * `POST …/runs/:runId/coherence/llm-findings`: resultado de la revisión LLM
 * que corre en el navegador (spec Fase 7 §1). Cada finding se valida y se
 * filtra en `mergeLlmFindings` (UUIDs inventados → descartados y contados).
 */
export class LlmFindingsDto {
  @IsString()
  @MaxLength(200)
  model: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  promptSha256: string;

  // Cada elemento se valida en mergeLlmFindings (no-objeto/malformado →
  // droppedMalformed; UUID inexistente → droppedInvalidIds): nunca rompe el envío.
  @IsArray()
  @ArrayMaxSize(MAX_LLM_FINDINGS)
  findings: unknown[];
}
