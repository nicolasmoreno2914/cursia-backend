import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { BRIEF_KEY, CourseFacts, PEDAGOGY_DERIVATION_KEY, parseBrief, parsePedagogyDerivation, resolveCourseFacts } from './course-facts';
import { suggestProfileFromContext } from '../academic-context/context-design';

type Q = { query(sql: string, params?: any[]): Promise<any> };

/** LOOP 8.1 · «Lo que sabemos del curso» leído de la base (sin ownership: el llamador ya lo verificó). */
export async function loadCourseFacts(q: Q, courseId: number, courseRow?: any): Promise<CourseFacts> {
  const course = courseRow || (await q.query(`select id, title, institution_id, metadata from public.courses where id = $1`, [courseId]))[0];
  const meta = (course && course.metadata) || {};
  // Bases sin las migraciones de perfiles (entornos viejos): sin contexto ni perfil, como siempre.
  const academic = await loadCurrentAcademicContext(q, courseId).catch(() => null);
  const pedagogy = await loadCurrentPedagogicalProfile(q, courseId).catch(() => null);
  return resolveCourseFacts({
    courseTitle: course ? course.title : null,
    institutionId: course ? course.institution_id ?? null : null,
    brief: parseBrief(meta[BRIEF_KEY]),
    academic: academic ? { version: academic.version, context: academic.context } : null,
    pedagogy: pedagogy ? { version: pedagogy.version, profile: pedagogy.profile } : null,
    derivation: parsePedagogyDerivation(meta[PEDAGOGY_DERIVATION_KEY]),
    suggested: academic ? suggestProfileFromContext(academic.context, null).profile : null,
  });
}

/**
 * LOOP 8.1 (review L81 I3) · Estudiante que congeló el Blueprint (course.applicationContext.learner: entra al snapshot
 * cuando el curso tiene Actividades de Aplicación). null si no hay. Es lo que reciben esas actividades al generar.
 */
export async function loadFrozenLearner(q: Q, courseId: number, blueprintId: number): Promise<Record<string, unknown> | null> {
  const [bp] = await q.query(
    `select snapshot_json -> 'course' -> 'applicationContext' -> 'learner' as learner from public.course_blueprints where id = $1 and course_id = $2`,
    [blueprintId, courseId],
  );
  const v = bp ? (typeof bp.learner === 'string' ? JSON.parse(bp.learner) : bp.learner) : null;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
