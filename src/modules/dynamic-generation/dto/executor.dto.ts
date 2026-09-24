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

/** Tipos que el ejecutor del navegador puede reclamar: video solo por el worker del backend (spec §3.9, D1). */
export const BROWSER_ITEM_TYPES = ['content', 'scorm', 'exam'] as const;
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
