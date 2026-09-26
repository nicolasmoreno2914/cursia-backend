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
