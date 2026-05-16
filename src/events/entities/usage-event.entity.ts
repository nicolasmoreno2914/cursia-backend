/* ══════════════════════════════════════════════════════════════
   usage-event.entity.ts — Tabla central de eventos de uso
   ══════════════════════════════════════════════════════════════

   Registra CADA acción cuantificable que genera coste o métricas.
   Inmutable: solo INSERT. Nunca UPDATE ni DELETE sobre registros.
   ══════════════════════════════════════════════════════════════ */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/** Todos los tipos de evento válidos en el sistema Cursia */
export type EventType =
  // IA Generation
  | 'ia_generate_syllabus'
  | 'ia_generate_chapter'
  | 'ia_generate_quiz'
  | 'ia_generate_summary'
  | 'ia_generate_full_course'
  // Video
  | 'video_job_requested'
  | 'video_job_completed'
  | 'video_job_failed'
  | 'video_batch_requested'
  // YouTube
  | 'youtube_connect'
  | 'youtube_disconnect'
  | 'youtube_upload_requested'
  | 'youtube_upload_completed'
  | 'youtube_upload_failed'
  // Exports
  | 'export_mbz'
  | 'export_scorm'
  | 'export_pdf'
  // Courses
  | 'course_created'
  | 'course_published'
  // Cloud Save
  | 'cloud_save'
  // Auth
  | 'auth_signin';

@Entity('usage_events')
@Index(['userId', 'createdAt'])
@Index(['eventType', 'createdAt'])
export class UsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ── Quién ───────────────────────────────────────────────────────────────────
  /** UUID del usuario autenticado (auth.users.id de Supabase). SIEMPRE del JWT. */
  @Index()
  @Column({ name: 'user_id', length: 36 })
  userId: string;

  /** Email del usuario (denormalizado para reports). */
  @Column({ name: 'user_email', length: 255, nullable: true })
  userEmail: string;

  // ── Qué ─────────────────────────────────────────────────────────────────────
  /** Tipo de evento. Enum de cadena para flexibilidad sin migraciones. */
  @Index()
  @Column({ name: 'event_type', length: 60 })
  eventType: string;

  /** ¿El evento terminó con error? */
  @Column({ default: false })
  failed: boolean;

  /** Mensaje de error si failed = true. */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string;

  // ── Tokens IA ───────────────────────────────────────────────────────────────
  /** Tokens de entrada consumidos (modelos LLM). */
  @Column({ name: 'tokens_input', type: 'int', nullable: true })
  tokensInput: number;

  /** Tokens de salida consumidos (modelos LLM). */
  @Column({ name: 'tokens_output', type: 'int', nullable: true })
  tokensOutput: number;

  /** Nombre del modelo IA usado (ej: 'claude-3-5-sonnet-20241022'). */
  @Column({ name: 'ai_model', length: 100, nullable: true })
  aiModel: string;

  /** Proveedor IA (ej: 'anthropic', 'openai'). */
  @Column({ name: 'ai_provider', length: 50, nullable: true })
  aiProvider: string;

  // ── Coste calculado ─────────────────────────────────────────────────────────
  /** Coste estimado en USD, calculado al insertar con cost_rates. null si no hay tarifa. */
  @Column({ name: 'estimated_cost_usd', type: 'numeric', precision: 12, scale: 8, nullable: true })
  estimatedCostUsd: number;

  // ── Video ────────────────────────────────────────────────────────────────────
  /** ID del job de Video Engine IA. */
  @Column({ name: 'video_job_id', length: 100, nullable: true })
  videoJobId: string;

  /** ID del batch de Video Engine IA. */
  @Column({ name: 'video_batch_id', length: 100, nullable: true })
  videoBatchId: string;

  /** Cantidad de videos en el batch. */
  @Column({ name: 'video_count', type: 'int', nullable: true })
  videoCount: number;

  // ── Curso ────────────────────────────────────────────────────────────────────
  /** ID del curso relacionado (si aplica). */
  @Column({ name: 'course_id', type: 'int', nullable: true })
  courseId: number;

  // ── Performance ─────────────────────────────────────────────────────────────
  /** Duración de la operación en milisegundos. */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number;

  // ── Metadatos libres ─────────────────────────────────────────────────────────
  /** JSON con cualquier dato adicional relevante para el evento. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  // ── Timestamp ────────────────────────────────────────────────────────────────
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
