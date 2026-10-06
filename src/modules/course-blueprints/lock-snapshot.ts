import { academicBlueprintContext, loadCurrentAcademicContext } from '../academic-context/academic-db';
import { lockPedagogyInput } from '../pedagogy/pedagogical-blueprint';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { profileApplicationContext, profileTargetHours } from '../pedagogy/pedagogy-profile';
import {
  BlueprintSnapshotV2,
  BlueprintValidationError,
  RawChapterRowV2,
  RawModuleRow,
  buildBlueprintSnapshotV2,
  validateBlueprintInputV2,
} from './blueprint-snapshot';

/** Lo mínimo que necesita (DataSource o QueryRunner de TypeORM). */
export interface LockQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<any>;
}

export interface LockCourseRow {
  id: number;
  title: string;
  final_exam_enabled: boolean;
  activity_engine: string;
  review_cards_enabled: boolean | null;
}

/** Filas de la estructura viva, con las mismas columnas que lee el lock. */
export async function loadLockRows(q: LockQueryExecutor, courseId: number): Promise<{ modules: RawModuleRow[]; chapters: RawChapterRowV2[] }> {
  const modules: RawModuleRow[] = await q.query(
    `select id, position, title, objective, description, exam_enabled from public.course_modules where course_id = $1`,
    [courseId],
  );
  const chapters: RawChapterRowV2[] = await q.query(
    `select id, module_id, position, title, objective, description, video_enabled, activity_enabled,
            to_jsonb(course_chapters) ->> 'chapter_kind' as chapter_kind,
            to_jsonb(course_chapters) ->> 'application_minutes' as application_minutes,
            to_jsonb(course_chapters) -> 'outcome_ids' as outcome_ids
       from public.course_chapters where course_id = $1`,
    [courseId],
  );
  return { modules, chapters };
}

/**
 * El Blueprint v2 que el lock congelaría HOY con estas filas: perfil pedagógico vigente (o `profileOverride`, vista
 * previa sin guardar), horas objetivo, contexto de las Actividades de Aplicación y contexto académico. Única fuente
 * de esa composición: la usan el lock y la vista previa del impacto de los cambios (Fase 5), así lo que se previsualiza
 * es exactamente lo que se confirmaría.
 */
export async function assembleLockSnapshotV2(
  q: LockQueryExecutor,
  course: LockCourseRow,
  rows: { modules: RawModuleRow[]; chapters: RawChapterRowV2[] },
  opts: { profileOverride?: unknown } = {},
): Promise<{ snapshot: BlueprintSnapshotV2 | null; errors: BlueprintValidationError[]; profile: unknown }> {
  const stored = opts.profileOverride === undefined ? await loadCurrentPedagogicalProfile(q, course.id) : null;
  const profile = opts.profileOverride !== undefined ? opts.profileOverride : stored ? stored.profile : null;
  const academic = await loadCurrentAcademicContext(q, course.id);
  const courseRef = {
    id: course.id,
    title: course.title,
    finalExam: course.final_exam_enabled,
    activityEngine: course.activity_engine as 'h5p' | 'scorm',
    // EV6 H5P v2: NULL (curso anterior / columna sin migrar) = apagado; solo true entra al snapshot.
    reviewCards: course.review_cards_enabled === true,
    // Sin objetivo de horas: la clave no entra al snapshot (sha de siempre).
    targetHours: profileTargetHours(profile),
    // Fase 2: estudiante + resultados de aprendizaje congelados (solo entran si hay Actividades de Aplicación).
    applicationContext: profileApplicationContext(profile),
    // Fase 3: contexto académico vigente → sus resultados y competencias se congelan en el Blueprint.
    academicContext: academic ? academicBlueprintContext(academic.context, academic.sha256) : null,
  };
  const errors = validateBlueprintInputV2(courseRef, rows.modules, rows.chapters);
  if (errors.length) return { snapshot: null, errors, profile };
  const plain = buildBlueprintSnapshotV2(courseRef, rows.modules, rows.chapters);
  const pedagogy = lockPedagogyInput(plain, profile);
  return { snapshot: pedagogy ? buildBlueprintSnapshotV2(courseRef, rows.modules, rows.chapters, pedagogy) : plain, errors: [], profile };
}
