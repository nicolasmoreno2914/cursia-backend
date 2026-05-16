/* ══════════════════════════════════════════════════════════════
   create-event.dto.ts — DTO para POST /api/v1/events
   ══════════════════════════════════════════════════════════════

   Todos los campos son opcionales excepto event_type.
   El user_id SIEMPRE se extrae del JWT (nunca del body).
   ══════════════════════════════════════════════════════════════ */

export class CreateEventDto {
  /** Tipo de evento (requerido). */
  event_type: string;

  /** ¿El evento terminó con error? */
  failed?: boolean;

  /** Mensaje de error si failed = true. */
  error_message?: string;

  /** Tokens de entrada consumidos. */
  tokens_input?: number;

  /** Tokens de salida consumidos. */
  tokens_output?: number;

  /** Modelo IA usado. */
  ai_model?: string;

  /** Proveedor IA. */
  ai_provider?: string;

  /** ID del job de Video Engine. */
  video_job_id?: string;

  /** ID del batch de Video Engine. */
  video_batch_id?: string;

  /** Número de videos en el batch. */
  video_count?: number;

  /** ID del curso relacionado. */
  course_id?: number;

  /** Duración de la operación en milisegundos. */
  duration_ms?: number;

  /** Metadatos adicionales (JSON libre). */
  metadata?: Record<string, any>;
}
