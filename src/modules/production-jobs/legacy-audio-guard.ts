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
 *
 * I1 (integral-review): se bloquea SOLO si el curso sobre el que se actúa es
 * V2 en sí mismo:
 * - id numérico → decide ESA fila (dynamic → bloquea; legacy → no);
 * - UUID del frontend → bloquea solo si resuelve a un curso dynamic Y el
 *   owner NO tiene ninguna fila no-dynamic (legacy) con ese mismo UUID. Abrir
 *   «Estructura» sobre un curso legacy crea un gemelo V2 con el mismo UUID;
 *   el curso legacy sigue teniendo audio legacy (p. ej. si V2 se apaga).
 */
export async function isDynamicCourseFor(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<boolean> {
  if (rawCourseId === null || rawCourseId === undefined) return false;
  const raw = String(rawCourseId).trim();
  if (!raw || !ownerId) return false;
  const numericId = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  const rows = await query(
    `select 1 as found from public.courses d
      where d.owner_id = $1 and d.structure_version = 'dynamic'
        and (
          (($2)::bigint is not null and d.id = ($2)::bigint)
          or (($2)::bigint is null and d.metadata->>'courseId' = $3
              and not exists (
                select 1 from public.courses l
                 where l.owner_id = $1 and l.metadata->>'courseId' = $3
                   and l.structure_version is distinct from 'dynamic'))
        )
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
 * el curso del job es V2; `null` si es legacy. MISMA regla que las rutas (I1):
 * se evalúa el id CRUDO con el que se creó el job (`frontendCourseId` guarda
 * el `courseId` recibido tal cual); `courseId` numérico solo si no hay otro
 * (en jobs legacy puede ser un parseInt() espurio de un UUID). Nunca se falla
 * un job legacy porque exista un gemelo V2. Sin efectos: el caller decide.
 */
export async function isLegacyAudioBlockedForJob(
  job: { ownerId: string; frontendCourseId?: string | null; courseId?: number | string | null },
  jobsService: { assertLegacyAudioAllowedForCourse(ownerId: string, rawCourseId: unknown): Promise<void> },
): Promise<string | null> {
  const raw =
    job.frontendCourseId !== null && job.frontendCourseId !== undefined && job.frontendCourseId !== ''
      ? job.frontendCourseId
      : job.courseId;
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    await jobsService.assertLegacyAudioAllowedForCourse(job.ownerId, raw);
  } catch (err) {
    if (err instanceof ConflictException) return v2CourseLegacyAudioDisabledMessage();
    throw err;
  }
  return null;
}
