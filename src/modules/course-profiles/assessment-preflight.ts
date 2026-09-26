import { ConflictException } from '@nestjs/common';
import {
  ResolvedAssessment,
  assessmentItemCountsFromManifest,
  resolveAssessment,
} from '../../package/assessment/resolve-assessment';
import { AssessmentProfile, defaultAssessmentProfile, normalizeAssessmentProfile } from './course-profiles';

/**
 * Cursia V2.1 — F1 (review I3): el perfil de evaluación vigente se valida
 * contra el Manifest AL ARRANCAR un run v3, antes de cualquier escritura o
 * gasto. Si no se puede aplicar (pesos para otro estado de `finalExam`,
 * intentos que Moodle no puede imponer, perfil ilegible) → 409
 * `assessment_profile_invalid`, nunca un paquete que falla después de
 * generar todo. Las categorías vacías ya NO son un error: `resolveAssessment`
 * con `itemCounts` redistribuye su peso (o deja el curso sin nota).
 */

export const ASSESSMENT_PROFILE_INVALID = 'assessment_profile_invalid';

interface PreflightManifest {
  items: ReadonlyArray<{ type: string }>;
  features?: { finalExam?: boolean; activityEngine?: 'h5p' | 'scorm' } | null;
}

export type AssessmentPreflightResult =
  | { ok: true; resolved: ResolvedAssessment }
  | { ok: false; reason: string };

/**
 * Pura: ¿`profile` se resuelve contra el Manifest (hechos congelados +
 * ítems calificables reales)? Nunca lanza: devuelve el motivo.
 */
export function preflightAssessmentProfile(profile: AssessmentProfile, manifest: PreflightManifest): AssessmentPreflightResult {
  try {
    const resolved = resolveAssessment(profile, {
      hasFinalExam: manifest?.features?.finalExam === true,
      activityEngine: manifest?.features?.activityEngine,
      itemCounts: assessmentItemCountsFromManifest(manifest),
    });
    return { ok: true, resolved };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

interface Q {
  query(sql: string, params?: any[]): Promise<any[]>;
}

/**
 * Lee el perfil de evaluación vigente (última versión) o el default para el
 * `finalExam` CONGELADO del Manifest. Un perfil guardado ilegible se reporta
 * como motivo (no se reemplaza en silencio por el default).
 */
export async function loadAssessmentProfileForManifest(
  q: Q,
  courseId: number,
  finalExam: boolean,
): Promise<{ profile: AssessmentProfile; version: number } | { error: string; version: number }> {
  const [row] = await q.query(
    `select version, data from public.course_profiles where course_id = $1 and kind = 'assessment' order by version desc limit 1`,
    [courseId],
  );
  if (!row) return { profile: defaultAssessmentProfile({ finalExam }), version: 0 };
  try {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return { profile: normalizeAssessmentProfile(data), version: Number(row.version) };
  } catch (err: any) {
    return { error: String(err?.message ?? err), version: Number(row.version) };
  }
}

/**
 * Gate de startRun (solo rulesVersion 3; v1/v2 → no hace nada ni consulta).
 * Lanza `ConflictException({ code: 'assessment_profile_invalid', … })`.
 */
export async function assertAssessmentProfileResolvableForRun(
  q: Q,
  courseId: number,
  manifest: { rulesVersion?: number; manifest: PreflightManifest },
): Promise<void> {
  if (Number(manifest?.rulesVersion) !== 3) return;
  const finalExam = manifest.manifest?.features?.finalExam === true;
  const loaded = await loadAssessmentProfileForManifest(q, courseId, finalExam);
  const reason = 'error' in loaded ? loaded.error : (() => {
    const r = preflightAssessmentProfile(loaded.profile, manifest.manifest);
    return r.ok === true ? null : (r as { ok: false; reason: string }).reason;
  })();
  if (reason === null) return;
  const where = loaded.version > 0 ? `el perfil de evaluación v${loaded.version}` : 'el perfil de evaluación por defecto';
  throw new ConflictException({
    message:
      `${ASSESSMENT_PROFILE_INVALID}: ${where} no se puede aplicar a este curso (${reason}). ` +
      'Corregilo en "Diseño y evaluación" antes de generar; no se gastó nada.',
    code: ASSESSMENT_PROFILE_INVALID,
    profileVersion: loaded.version,
    reason,
  });
}
