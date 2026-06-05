/* ══════════════════════════════════════════════════════════════
   create-event.dto.ts — DTO para POST /api/v1/events
   ══════════════════════════════════════════════════════════════

   Todos los campos son opcionales excepto event_type.
   El user_id SIEMPRE se extrae del JWT (nunca del body).

   IMPORTANTE: todos los campos deben tener decoradores de class-validator
   para que ValidationPipe(whitelist:true) no los descarte.
   ══════════════════════════════════════════════════════════════ */

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsObject,
  Min,
  MaxLength,
  IsIn,
} from 'class-validator';

export class CreateEventDto {
  /** Tipo de evento (requerido). Ej: 'ia_generate_full_course', 'export_mbz'. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  event_type: string;

  /** ¿El evento terminó con error? */
  @IsOptional()
  @IsBoolean()
  failed?: boolean;

  /** Mensaje de error si failed = true. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  error_message?: string;

  /** Tokens de entrada consumidos (Claude / OpenAI). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  tokens_input?: number;

  /** Tokens de salida consumidos. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  tokens_output?: number;

  /** Modelo IA usado. Ej: 'claude-sonnet-4-6'. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ai_model?: string;

  /** Proveedor IA. Ej: 'anthropic', 'openai'. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ai_provider?: string;

  /** ID del job de Video Engine. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  video_job_id?: string;

  /** ID del batch de Video Engine. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  video_batch_id?: string;

  /** Número de videos en el batch. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  video_count?: number;

  /** ID del curso relacionado. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  course_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  job_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  parent_job_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  organization_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  component?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsIn(['real', 'mock', 'dry_run', 'mixed', 'unknown'])
  mode?: string;

  @IsOptional()
  @IsIn(['real', 'estimated', 'mock_zero', 'unknown'])
  cost_type?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  real_cost_usd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  cost_source?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  units?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit_type?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unit_price_usd?: number;

  /** Duración de la operación en milisegundos. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration_ms?: number;

  /** Metadatos adicionales (JSON libre). */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
