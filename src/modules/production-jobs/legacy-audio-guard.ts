import { ConflictException, NotFoundException } from '@nestjs/common';
import { numericCourseId } from '../authz/schema-probe';

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

// ─────────────────────────────────────────────────────────────────────────────
// r75 B1 (H8a): el `course_id` del body de un job legacy no se validaba. Con el id NUMÉRICO de un curso ajeno (p. ej.
// uno dinámico), isDynamicCourseFor (que solo mira los cursos del mismo owner) devolvía false: se saltaba el 409 R68 y
// el job quedaba apuntando al curso de otro usuario (los workers leen `courses` por ese id). Ahora un id numérico que
// existe y es de OTRO dueño → 404 `course_not_found` (no revela que existe). Un id numérico que no existe se acepta
// como hoy (ids locales del V1). Un UUID del frontend no da acceso a nada ajeno (todas sus lecturas filtran por owner;
// ver authz/resource-resolver.ts), así que no se rechaza.
// ─────────────────────────────────────────────────────────────────────────────
export const COURSE_NOT_FOUND = 'course_not_found';

export async function assertCourseRefNotForeign(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<void> {
  const id = numericCourseId(rawCourseId);
  if (id === null) return;
  const rows = await query(`select owner_id::text as owner_id from public.courses where id = $1`, [id]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && String(row.owner_id ?? '') !== String(ownerId ?? '')) {
    throw new NotFoundException({ code: COURSE_NOT_FOUND, message: `Course #${id} not found` });
  }
}

/** 409 `v2_course_legacy_audio_disabled:` si el curso es V2 (dynamic). */
export async function assertLegacyAudioAllowed(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<void> {
  await assertCourseRefNotForeign(query, ownerId, rawCourseId); // r75 H8a
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
    // r75 H8a: job viejo con el id numérico de un curso ajeno → se bloquea (nunca se lee el curso de otro dueño).
    if (err instanceof NotFoundException) return `${COURSE_NOT_FOUND}: el curso del job no es del dueño del job; no se generó audio.`;
    throw err;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// R68 (piloto, 2026-10-07): un curso V2 (dynamic) se genera SOLO por el flujo V2 (runs sobre un Blueprint con el
// diseño verificado, ver GenerationDesignGate). Los jobs legacy de generación (contenido, videos, H5P, Gamma, paquete
// y el job maestro) lo rechazan con 409 `v2_course_legacy_generation_disabled:` antes de crear nada: el frontend
// antiguo o una llamada directa no pueden saltarse Verificación. Misma regla de identidad que el audio (I1).
// ─────────────────────────────────────────────────────────────────────────────
export const V2_COURSE_LEGACY_GENERATION_DISABLED = 'v2_course_legacy_generation_disabled';

export async function assertLegacyGenerationAllowed(query: QueryFn, ownerId: string, rawCourseId: unknown): Promise<void> {
  await assertCourseRefNotForeign(query, ownerId, rawCourseId); // r75 H8a
  if (await isDynamicCourseFor(query, ownerId, rawCourseId)) {
    throw new ConflictException(
      `${V2_COURSE_LEGACY_GENERATION_DISABLED}: este curso usa la estructura dinámica (V2) y solo se genera desde «Revisar y generar», ` +
        'con el diseño verificado. No se creó ningún job ni se generó contenido.',
    );
  }
}
