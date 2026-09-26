import {
  ASSESSABLE_TYPES,
  AssessableType,
  AssessmentProfile,
  GradeMethod,
  validateAssessmentProfile,
} from '../../modules/course-profiles/course-profiles';

/**
 * Cursia V2.1 — R6: perfil de evaluación → valores efectivos para Moodle
 * (audit §K, §X.2, §X.3). Lógica PURA: sin DB, sin reloj, sin aleatoriedad.
 *
 * Una sola vía de nota aprobatoria para quiz, H5P y SCORM (§X.4):
 * `gradepass` en el grade_item + `completionpassgrade=1` en el módulo. El
 * paquete nunca decide aprobado/no aprobado; lo decide el gradebook.
 */

export type AssessmentCategoryKey = 'practice' | 'moduleExams' | 'finalExam';

/** Nombres fijos de las categorías del gradebook (§K.5). No se traducen ni se configuran. */
export const ASSESSMENT_CATEGORY_NAMES: Readonly<Record<AssessmentCategoryKey, string>> = Object.freeze({
  practice: 'Práctica de capítulos',
  moduleExams: 'Evaluaciones de módulo',
  finalExam: 'Evaluación final',
});

const KIND_CATEGORY: Readonly<Record<AssessableType, AssessmentCategoryKey>> = Object.freeze({
  activity: 'practice',
  video: 'practice',
  exam: 'moduleExams',
  finalExam: 'finalExam',
});

/** Clave de categoría para un tipo calificable. Lanza con un tipo desconocido. */
export function categoryKeyForItem(kind: AssessableType): AssessmentCategoryKey {
  const k = KIND_CATEGORY[kind];
  if (!k) throw new Error(`ASSESSMENT_UNKNOWN_KIND: ${String(kind)}`);
  return k;
}

/** Nombre (español, fijo) de la categoría del gradebook de un tipo calificable. */
export function categoryForItem(kind: AssessableType): string {
  return ASSESSMENT_CATEGORY_NAMES[categoryKeyForItem(kind)];
}

export interface ResolvedKind {
  /** override ?? passingGrade (0–100). */
  passingGrade: number;
  /** 0 = ilimitados. */
  attempts: number;
  gradeMethod: GradeMethod;
  category: AssessmentCategoryKey;
}

export interface ResolvedCategory {
  key: AssessmentCategoryKey;
  fullname: string;
  weight: number;
}

export interface ResolvedCourseCompletion {
  requireAllChapterActivities: boolean;
  requireExams: boolean;
  requireCourseGradePass: boolean;
  courseGradepass: number;
  aggregation: 'all';
}

export interface ResolvedAssessment {
  assessmentProfileVersion: number;
  hasFinalExam: boolean;
  /** Nota aprobatoria del curso (`gradepass` del course item) = `passingGrade` base. */
  courseGradepass: number;
  kinds: Record<AssessableType, ResolvedKind>;
  /** Orden fijo: practice, moduleExams, finalExam (solo con examen final). Suma 100. */
  categories: ResolvedCategory[];
  courseCompletion: ResolvedCourseCompletion;
}

export interface AssessmentFacts {
  hasFinalExam: boolean;
  /**
   * Motor del item `activity` (Blueprint v2). Opcional: si se da y es 'h5p',
   * se exige `attempts.activity = 0` porque `mod_h5pactivity` no tiene límite
   * de intentos (ver `resolveAssessment`).
   */
  activityEngine?: 'h5p' | 'scorm';
}

/**
 * Perfil + hechos del curso → valores efectivos. Falla fuerte (nunca "arregla"):
 * - `ASSESSMENT_PROFILE_INVALID` si el perfil no valida contra el curso real
 *   (incluye `WEIGHTS_FINAL_EXAM_MISMATCH` y `WEIGHTS_SUM_NOT_100`);
 * - `ASSESSMENT_UNENFORCEABLE` si el perfil pide algo que Moodle no puede
 *   aplicar: un límite de intentos en un ítem que siempre es `h5pactivity`
 *   (el video; la actividad cuando el motor es h5p).
 */
export function resolveAssessment(profile: AssessmentProfile, facts: AssessmentFacts): ResolvedAssessment {
  if (!facts || typeof facts.hasFinalExam !== 'boolean') {
    throw new Error('ASSESSMENT_INVALID_FACTS: facts.hasFinalExam debe ser boolean');
  }
  if (facts.activityEngine !== undefined && facts.activityEngine !== 'h5p' && facts.activityEngine !== 'scorm') {
    throw new Error(`ASSESSMENT_INVALID_FACTS: activityEngine desconocido (${String(facts.activityEngine)})`);
  }
  const errors = validateAssessmentProfile(profile, { finalExam: facts.hasFinalExam });
  if (errors.length > 0) {
    throw new Error(
      `ASSESSMENT_PROFILE_INVALID: ${errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`,
    );
  }

  const unenforceable: string[] = [];
  if (profile.attempts.video !== 0) {
    unenforceable.push(`attempts.video=${profile.attempts.video} (el video es siempre h5pactivity, sin límite de intentos)`);
  }
  if (facts.activityEngine === 'h5p' && profile.attempts.activity !== 0) {
    unenforceable.push(`attempts.activity=${profile.attempts.activity} (activityEngine=h5p no tiene límite de intentos)`);
  }
  if (unenforceable.length > 0) {
    throw new Error(`ASSESSMENT_UNENFORCEABLE: ${unenforceable.join('; ')}`);
  }

  const kinds = {} as Record<AssessableType, ResolvedKind>;
  for (const t of ASSESSABLE_TYPES) {
    const ov = profile.overrides[t];
    kinds[t] = {
      passingGrade: ov === null ? profile.passingGrade : ov,
      attempts: profile.attempts[t],
      gradeMethod: profile.gradeMethod[t],
      category: KIND_CATEGORY[t],
    };
  }

  const keys: AssessmentCategoryKey[] = facts.hasFinalExam
    ? ['practice', 'moduleExams', 'finalExam']
    : ['practice', 'moduleExams'];
  const w = profile.categoryWeights as unknown as Record<string, number>;
  const categories: ResolvedCategory[] = keys.map((key) => ({
    key,
    fullname: ASSESSMENT_CATEGORY_NAMES[key],
    weight: w[key],
  }));
  // Doble control (el validador ya lo exige): nunca emitir pesos que no sumen 100.
  const sum = categories.reduce((a, c) => a + c.weight, 0);
  if (sum !== 100) throw new Error(`ASSESSMENT_WEIGHTS_SUM_NOT_100: suman ${sum}`);

  return {
    assessmentProfileVersion: profile.assessmentProfileVersion,
    hasFinalExam: facts.hasFinalExam,
    courseGradepass: profile.passingGrade,
    kinds,
    categories,
    courseCompletion: {
      requireAllChapterActivities: profile.courseCompletion.requireAllChapterActivities,
      requireExams: profile.courseCompletion.requireExams,
      requireCourseGradePass: profile.courseCompletion.requireCourseGradePass,
      courseGradepass: profile.passingGrade,
      aggregation: 'all',
    },
  };
}

/**
 * Falla fuerte si una categoría con peso > 0 no tiene ningún ítem calificable.
 * Con `aggregateonlygraded=0` una categoría vacía cuenta como 0 y el curso
 * nunca podría llegar a 100 (p.ej. todos los capítulos con actividad y video
 * apagados, pero "Práctica de capítulos" con peso 30). El empaque debe
 * llamarlo con el conteo real de ítems por categoría.
 */
export function assertCategoriesPopulated(
  resolved: ResolvedAssessment,
  itemCounts: Partial<Record<AssessmentCategoryKey, number>>,
): void {
  const empty = resolved.categories
    .filter((c) => c.weight > 0 && !((itemCounts[c.key] ?? 0) > 0))
    .map((c) => `${c.key} (peso ${c.weight})`);
  if (empty.length > 0) {
    throw new Error(`ASSESSMENT_EMPTY_WEIGHTED_CATEGORY: ${empty.join(', ')} sin ítems calificables`);
  }
}

export interface CompletionCandidate {
  moduleId: number;
  modname: 'quiz' | 'scorm' | 'h5pactivity';
  kind: AssessableType;
}

/**
 * Criterios de actividad del curso según la política:
 * - `requireAllChapterActivities` → todos los ítems `activity` y `video`
 *   (todo lo calificable de "Práctica de capítulos");
 * - `requireExams` → todos los `exam` y el `finalExam`.
 * Orden estable: el de `items`.
 */
export function completionCriteriaFor(
  items: CompletionCandidate[],
  policy: ResolvedCourseCompletion,
): Array<{ moduleId: number; modname: CompletionCandidate['modname'] }> {
  const out: Array<{ moduleId: number; modname: CompletionCandidate['modname'] }> = [];
  for (const it of items) {
    const chapter = it.kind === 'activity' || it.kind === 'video';
    const exam = it.kind === 'exam' || it.kind === 'finalExam';
    if (!chapter && !exam) throw new Error(`ASSESSMENT_UNKNOWN_KIND: ${String(it.kind)}`);
    if ((chapter && policy.requireAllChapterActivities) || (exam && policy.requireExams)) {
      out.push({ moduleId: it.moduleId, modname: it.modname });
    }
  }
  return out;
}
