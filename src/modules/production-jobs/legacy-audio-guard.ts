import { ConflictException } from '@nestjs/common';

// ─────────────────────────────────────────────────────────────────────────────
// Decisión del owner (pre-aceptación V2): un curso con
// structure_version='dynamic' (V2) NUNCA genera audio legacy (bienvenida /
// audiolibro con OpenAI TTS). Toda ruta backend que pueda producirlo lo
// rechaza con 409 `v2_course_legacy_audio_disabled:` ANTES de gastar nada o
// crear artifacts/jobs. Cursos legacy (y cuentas sin V2) no cambian: la única
// diferencia es una lectura extra de `courses` que no devuelve filas.
// ─────────────────────────────────────────────────────────────────────────────

export const V2_COURSE_LEGACY_AUDIO_DISABLED = 'v2_course_legacy_audio_disabled';

export function v2CourseLegacyAudioDisabledMessage(): string {
  return (
    `${V2_COURSE_LEGACY_AUDIO_DISABLED}: este curso usa la estructura dinámica (V2) y no admite el audio ` +
    'legacy (audio de bienvenida ni audiolibro con OpenAI TTS). No se creó ningún job ni se generó audio.'
  );
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<any[]>;

/**
 * `rawCourseId` llega como en los jobs legacy: id numérico de `courses` o el
 * UUID del frontend (`courses.metadata->>'courseId'`). Solo un string de
 * dígitos se trata como id numérico (un UUID que empieza con dígitos NO: con
 * parseInt "7f3a…" sería 7 y apuntaría a otro curso). Se limita a los cursos
 * del mismo owner.
 */
export async function isDynamicCourseFor(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<boolean> {
  if (rawCourseId === null || rawCourseId === undefined) return false;
  const raw = String(rawCourseId).trim();
  if (!raw || !ownerId) return false;
  const numericId = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  const rows = await query(
    `select 1 as found from public.courses
      where owner_id = $1 and structure_version = 'dynamic'
        and ((($2)::bigint is not null and id = ($2)::bigint) or metadata->>'courseId' = $3)
      limit 1`,
    [ownerId, numericId, raw],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** 409 `v2_course_legacy_audio_disabled:` si el curso es V2 (dynamic). */
export async function assertLegacyAudioAllowed(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<void> {
  if (await isDynamicCourseFor(query, ownerId, rawCourseId)) {
    throw new ConflictException(v2CourseLegacyAudioDisabledMessage());
  }
}

/**
 * Worker de audio: devuelve el mensaje `v2_course_legacy_audio_disabled:` si
 * el curso del job es V2 (por `frontendCourseId` o `courseId`); `null` si es
 * legacy. Sin efectos: el caller decide cómo fallar el job.
 */
export async function isLegacyAudioBlockedForJob(
  job: { ownerId: string; frontendCourseId?: string | null; courseId?: number | string | null },
  jobsService: { assertLegacyAudioAllowedForCourse(ownerId: string, rawCourseId: unknown): Promise<void> },
): Promise<string | null> {
  for (const id of [job.frontendCourseId, job.courseId]) {
    if (id === null || id === undefined || id === '') continue;
    try {
      await jobsService.assertLegacyAudioAllowedForCourse(job.ownerId, id);
    } catch (err) {
      if (err instanceof ConflictException) return v2CourseLegacyAudioDisabledMessage();
      throw err;
    }
  }
  return null;
}
