import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Tipos que el ejecutor del navegador puede reclamar: video solo por el worker
 * del backend (spec §3.9, D1). rulesVersion 2 agrega course_plan, course_intro
 * y module_intro (el ejecutor v2 los manda junto con content/scorm/exam en un
 * solo claim; debe coincidir con BROWSER_CLAIMABLE_TYPES del scheduler).
 */
export const BROWSER_ITEM_TYPES = [
  'content', 'scorm', 'exam', 'course_plan', 'course_intro', 'module_intro',
  // V2.1 rulesVersion 3 (R4): items LLM del navegador. presentation/audio_* son del worker.
  'experience', 'video_interactions', 'activity', 'final_exam',
  // Fase 2: Actividad de Aplicación (actividad + solucionario, texto LLM del navegador).
  'application_activity',
] as const;
export type BrowserItemType = (typeof BROWSER_ITEM_TYPES)[number];

/** Lease del navegador: 15 s .. 15 min (default 120 s en el controlador). */
export const BROWSER_MIN_LEASE_SECONDS = 15;
export const BROWSER_MAX_LEASE_SECONDS = 900;

class ExecutorBaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  executorId: string;
}

export class ClaimItemDto extends ExecutorBaseDto {
  @IsUUID()
  runId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BROWSER_ITEM_TYPES.length)
  @IsIn(BROWSER_ITEM_TYPES as unknown as string[], { each: true })
  types: BrowserItemType[];

  @IsOptional()
  @IsInt()
  @Min(BROWSER_MIN_LEASE_SECONDS)
  @Max(BROWSER_MAX_LEASE_SECONDS)
  leaseSeconds?: number;
}

/** REL lease de ejecución: liberación explícita por el titular. */
export class ReleaseRunLeaseDto extends ExecutorBaseDto {}

export class HeartbeatItemDto extends ExecutorBaseDto {
  @IsOptional()
  @IsInt()
  @Min(BROWSER_MIN_LEASE_SECONDS)
  @Max(BROWSER_MAX_LEASE_SECONDS)
  leaseSeconds?: number;
}

export class CompleteItemDto extends ExecutorBaseDto {
  /** Ids de artifacts ya subidos por la API de artifacts (R13); vacío → {ok:false,'no_artifacts'}. */
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  artifactIds: string[];

  @IsOptional()
  @IsObject()
  summary?: Record<string, any>;
}

export class FailItemDto extends ExecutorBaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  error: string;

  @IsBoolean()
  retryable: boolean;

  /**
   * BANKOPT (1e): artifact `dynamic_exam_bank_draft_json` con las preguntas válidas de un banco de examen
   * incompleto (solo exam/final_exam retryable; el servidor verifica dueño, tipo e itemRunId y si no
   * corresponde lo ignora). `null` explícito = borrar el borrador anterior (falla de reglas del banco sin
   * faltante); ausente = conservarlo (fail transitorio). Ver exam-bank-draft.ts.
   */
  @IsOptional()
  @IsUUID('all')
  examBankDraftArtifactId?: string;

  /**
   * REL R1: código estable del fallo (p.ej. `EXAM_BANK_INCOMPLETE`, `content_empty`). Opcional y
   * compatible hacia atrás (un ejecutor viejo no lo manda; uno nuevo contra un backend viejo recibe 400
   * por forbidNonWhitelisted y reintenta sin él). El servidor lo usa SOLO para clasificar
   * (reliability/failure-classifier.ts: un código conocido gana sobre el texto); nunca cambia la
   * transición del item. Formato de código: letra + [A-Za-z0-9_], ≤ 64.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  errorCode?: string;
}

/**
 * I4/R23: body opcional de retryItem. `resubmitVideo: true` autoriza a
 * retryItem a archivar external/externalSubmitStartedAt y someter un video
 * NUEVO — solo válido para items type='video' en 'failed' con último error
 * 'videogen_failed' o 'ambiguous_video_submission' (RunsService valida esto;
 * el DTO solo transporta el flag bajo whitelist).
 */
export class RetryItemDto {
  @IsOptional()
  @IsBoolean()
  resubmitVideo?: boolean;

  /**
   * V2.1 F2 fix round 1: decisión humana explícita para un item de Gamma
   * (`presentation`) en 'failed' con `gamma_submit_ambiguous` o
   * `gamma_generation_failed`: archiva el generationId/marcador y pide una
   * generación NUEVA (pasa por el gate de presupuesto como todo retry pagado).
   */
  @IsOptional()
  @IsBoolean()
  resubmitProvider?: boolean;
}
