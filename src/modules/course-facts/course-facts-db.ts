import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { BRIEF_KEY, CourseFacts, PEDAGOGY_DERIVATION_KEY, parseBrief, parsePedagogyDerivation, resolveCourseFacts } from './course-facts';

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
  });
}
