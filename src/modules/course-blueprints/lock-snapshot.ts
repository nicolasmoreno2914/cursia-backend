import { academicBlueprintContext, loadCurrentAcademicContext } from '../academic-context/academic-db';
import type { AcademicBlueprintContext } from '../academic-context/blueprint-academic';
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
 * LOOP 7 (A1 I2) — FUENTE ÚNICA de los datos del curso que entran a un Blueprint v2 SIN diseño (sin perfil
 * pedagógico, horas objetivo ni contexto de las Actividades de Aplicación: esos los agrega el motor pedagógico o
 * `composeLockSnapshotV2`). La usan el lock, la comparación «estructura viva = Blueprint», el dry-run del curso,
 * «Aplicar diseño» y el impacto de cambios: un campo nuevo del curso se agrega AQUÍ y llega a todos.
 */
export function plainCourseRefV2(course: LockCourseRow, academicContext: AcademicBlueprintContext | null) {
  return {
    id: course.id,
    title: course.title,
    finalExam: course.final_exam_enabled,
    activityEngine: course.activity_engine as 'h5p' | 'scorm',
    // EV6 H5P v2: NULL (curso anterior / columna sin migrar) = apagado; solo true entra al snapshot.
    reviewCards: course.review_cards_enabled === true,
    // Fase 3: contexto académico vigente → sus resultados y competencias se congelan en el Blueprint.
    academicContext,
  };
}

/**
 * LOOP 7 (A1 I2) — FUENTE ÚNICA de la composición del lock (pura): filas + perfil pedagógico + contexto académico →
 * el Blueprint v2 que se congelaría. `assembleLockSnapshotV2` la usa tras leer la base, y la comparación «estructura
 * viva = Blueprint vigente» la usa con las filas que ya leyó (antes era una copia que podía divergir del lock).
 */
export function composeLockSnapshotV2(
  course: LockCourseRow,
  rows: { modules: RawModuleRow[]; chapters: RawChapterRowV2[] },
  profile: unknown,
  academicContext: AcademicBlueprintContext | null,
): { snapshot: BlueprintSnapshotV2 | null; errors: BlueprintValidationError[] } {
  const courseRef = {
    ...plainCourseRefV2(course, academicContext),
    // Sin objetivo de horas: la clave no entra al snapshot (sha de siempre).
    targetHours: profileTargetHours(profile),
    // Fase 2: estudiante + resultados de aprendizaje congelados (solo entran si hay Actividades de Aplicación).
    applicationContext: profileApplicationContext(profile),
  };
  const errors = validateBlueprintInputV2(courseRef, rows.modules, rows.chapters);
  if (errors.length) return { snapshot: null, errors };
  const plain = buildBlueprintSnapshotV2(courseRef, rows.modules, rows.chapters);
  const pedagogy = lockPedagogyInput(plain, profile);
  return { snapshot: pedagogy ? buildBlueprintSnapshotV2(courseRef, rows.modules, rows.chapters, pedagogy) : plain, errors: [] };
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
  const composed = composeLockSnapshotV2(course, rows, profile, academic ? academicBlueprintContext(academic.context, academic.sha256) : null);
  return { ...composed, profile };
}
