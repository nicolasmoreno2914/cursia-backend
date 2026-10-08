import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { BRIEF_KEY, CourseFacts, PEDAGOGY_DERIVATION_KEY, parseBrief, parsePedagogyDerivation, resolveCourseFacts } from './course-facts';
import { suggestProfileFromContext } from '../academic-context/context-design';
import { DESIGN_HOURS_KEY, parseProposedHours } from '../course-design/design-pins';

type Q = { query(sql: string, params?: any[]): Promise<any> };

/** LOOP 8.1 · «Lo que sabemos del curso» leído de la base (sin ownership: el llamador ya lo verificó). */
export async function loadCourseFacts(q: Q, courseId: number, courseRow?: any): Promise<CourseFacts> {
  const course = courseRow || (await q.query(`select id, title, institution_id, metadata from public.courses where id = $1`, [courseId]))[0];
  const meta = (course && course.metadata) || {};
  // Bases sin las migraciones de perfiles (entornos viejos): sin contexto ni perfil, como siempre.
  // Prebrief (review BE-2 I3): solo una base SIN las tablas cuenta como «sin datos»; cualquier otro error se propaga (un
  // error transitorio no puede cambiar lo que «sabemos del curso» ni invalidar una aprobación).
  const missingTable = (err: any) => { if (err && err.code === '42P01') return null; throw err; };
  const academic = await loadCurrentAcademicContext(q, courseId).catch(missingTable);
  const pedagogy = await loadCurrentPedagogicalProfile(q, courseId).catch(missingTable);
  return resolveCourseFacts({
    courseTitle: course ? course.title : null,
    institutionId: course ? course.institution_id ?? null : null,
    brief: parseBrief(meta[BRIEF_KEY]),
    academic: academic ? { version: academic.version, context: academic.context } : null,
    pedagogy: pedagogy ? { version: pedagogy.version, profile: pedagogy.profile } : null,
    derivation: parsePedagogyDerivation(meta[PEDAGOGY_DERIVATION_KEY]),
    suggested: academic ? suggestProfileFromContext(academic.context, null).profile : null,
    proposedHours: parseProposedHours(meta[DESIGN_HOURS_KEY]),
  });
}

/**
 * LOOP 8.1 (review L81 I3 / R2-I1) · Estudiante del Blueprint, FIJO para ese Blueprint:
 *   1. el que congeló el snapshot (course.applicationContext.learner: cursos con Actividades de Aplicación — es
 *      exactamente lo que reciben esas actividades);
 *   2. si no hay, el del perfil pedagógico vigente al confirmar (la última versión creada hasta locked_at: las
 *      versiones son inmutables, así que el resultado no cambia después) — cursos sin Actividades de Aplicación.
 * null sin perfil. Leer del Blueprint (no del perfil vivo) hace que reanudar dé siempre el mismo contexto.
 */
export async function loadFrozenLearner(q: Q, courseId: number, blueprintId: number): Promise<Record<string, unknown> | null> {
  const [bp] = await q.query(
    `select coalesce(
              b.snapshot_json -> 'course' -> 'applicationContext' -> 'learner',
              (select p.data -> 'learner' from public.course_profiles p
                where p.course_id = b.course_id and p.kind = 'pedagogy' and p.created_at <= b.locked_at
                order by p.version desc limit 1)
            ) as learner
       from public.course_blueprints b where b.id = $1 and b.course_id = $2`,
    [blueprintId, courseId],
  );
  const v = bp ? (typeof bp.learner === 'string' ? JSON.parse(bp.learner) : bp.learner) : null;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
