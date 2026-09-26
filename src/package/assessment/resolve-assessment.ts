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
  /**
   * Nota aprobatoria del curso (`gradepass` del course item) = `passingGrade`
   * base. 0 en un curso sin nota (`withoutGrades`).
   */
  courseGradepass: number;
  kinds: Record<AssessableType, ResolvedKind>;
  /**
   * Orden fijo: practice, moduleExams, finalExam (solo con examen final). Suma
   * 100. Con `itemCounts` (F1/I3) solo quedan las categorías con ítems
   * calificables; vacío si el curso no tiene nota.
   */
  categories: ResolvedCategory[];
  courseCompletion: ResolvedCourseCompletion;
  /**
   * F1 (I3): presentes SOLO si se resolvió con `facts.itemCounts`.
   * - `weightsNormalized`: alguna categoría con peso > 0 no tenía ítems y su
   *   peso se repartió (proporcional, resto mayor) entre las no vacías.
   * - `originalWeights`: los pesos del perfil, tal cual, de las categorías
   *   aplicables al curso.
   * - `emptyCategories`: categorías aplicables sin ítems calificables (se
   *   omiten del gradebook).
   * - `withoutGrades`: ninguna categoría tiene ítems → curso sin nota
   *   (sin categorías ponderadas; completion por vista de los recursos
   *   obligatorios, ver el builder v3).
   */
  weightsNormalized?: boolean;
  originalWeights?: Partial<Record<AssessmentCategoryKey, number>>;
  emptyCategories?: AssessmentCategoryKey[];
  withoutGrades?: boolean;
}

export interface AssessmentFacts {
  hasFinalExam: boolean;
  /**
   * Motor del item `activity` (Blueprint v2). Opcional: si se da y es 'h5p',
   * se exige `attempts.activity = 0` porque `mod_h5pactivity` no tiene límite
   * de intentos (ver `resolveAssessment`).
   */
  activityEngine?: 'h5p' | 'scorm';
  /**
   * F1 (I3): cantidad de ítems calificables por categoría (del Manifest
   * congelado, ver `assessmentItemCountsFromManifest`). Si se da, las
   * categorías vacías se omiten y su peso se redistribuye (ver
   * `normalizeCategoryWeights`); si ninguna tiene ítems, el curso queda sin
   * nota. Sin `itemCounts` el comportamiento es el de R6 (sin normalizar).
   */
  itemCounts?: Partial<Record<AssessmentCategoryKey, number>>;
}

/** Orden fijo de las categorías (también desempata el resto mayor). */
export const ASSESSMENT_CATEGORY_ORDER: readonly AssessmentCategoryKey[] = Object.freeze(['practice', 'moduleExams', 'finalExam']);

/**
 * F1 (I3): ítems calificables por categoría a partir de los tipos de item de
 * un Manifest (v3): `video` + `activity` → practice, `exam` → moduleExams,
 * `final_exam` → finalExam. Pura.
 */
export function assessmentItemCountsFromManifest(manifest: { items: ReadonlyArray<{ type: string }> }): Record<AssessmentCategoryKey, number> {
  if (!manifest || !Array.isArray(manifest.items)) {
    throw new Error('ASSESSMENT_INVALID_FACTS: el Manifest no tiene items');
  }
  const count = (t: string) => manifest.items.filter((i) => i && i.type === t).length;
  return {
    practice: count('video') + count('activity'),
    moduleExams: count('exam'),
    finalExam: count('final_exam'),
  };
}

/**
 * F1 (I3): reparte 100 entre `keys` en proporción a `weights` (enteros ≥ 0),
 * con el método del resto mayor: piso de cada cuota exacta y los puntos que
 * faltan van a los restos más grandes; empate → orden fijo de categorías.
 * Si todos los pesos son 0, reparte en partes iguales. Determinística; la
 * suma es siempre exactamente 100.
 */
export function normalizeCategoryWeights(
  weights: Partial<Record<AssessmentCategoryKey, number>>,
  keys: readonly AssessmentCategoryKey[],
): Record<AssessmentCategoryKey, number> {
  if (keys.length === 0) throw new Error('ASSESSMENT_INVALID_FACTS: no hay categorías para normalizar');
  const ordered = ASSESSMENT_CATEGORY_ORDER.filter((k) => keys.includes(k));
  if (ordered.length !== keys.length) throw new Error(`ASSESSMENT_INVALID_FACTS: categorías desconocidas o repetidas (${keys.join(', ')})`);
  for (const k of ordered) {
    const w = weights[k];
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0) {
      throw new Error(`ASSESSMENT_INVALID_FACTS: peso de ${k} inválido (${String(w)})`);
    }
  }
  const total = ordered.reduce((a, k) => a + (weights[k] as number), 0);
  const base = (k: AssessmentCategoryKey) => (total === 0 ? 1 : (weights[k] as number));
  const denom = total === 0 ? ordered.length : total;
  const out = {} as Record<AssessmentCategoryKey, number>;
  const rems: Array<{ k: AssessmentCategoryKey; rem: number; idx: number }> = [];
  let assigned = 0;
  ordered.forEach((k, idx) => {
    const num = base(k) * 100;
    out[k] = Math.floor(num / denom);
    assigned += out[k];
    rems.push({ k, rem: num % denom, idx });
  });
  rems.sort((a, b) => b.rem - a.rem || a.idx - b.idx);
  for (let i = 0; i < 100 - assigned; i++) out[rems[i % rems.length].k] += 1;
  return out;
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
  const profileCategories: ResolvedCategory[] = keys.map((key) => ({
    key,
    fullname: ASSESSMENT_CATEGORY_NAMES[key],
    weight: w[key],
  }));
  // Doble control (el validador ya lo exige): nunca emitir pesos que no sumen 100.
  const sum = profileCategories.reduce((a, c) => a + c.weight, 0);
  if (sum !== 100) throw new Error(`ASSESSMENT_WEIGHTS_SUM_NOT_100: suman ${sum}`);

  const courseCompletion: ResolvedCourseCompletion = {
    requireAllChapterActivities: profile.courseCompletion.requireAllChapterActivities,
    requireExams: profile.courseCompletion.requireExams,
    requireCourseGradePass: profile.courseCompletion.requireCourseGradePass,
    courseGradepass: profile.passingGrade,
    aggregation: 'all',
  };
  const base = {
    assessmentProfileVersion: profile.assessmentProfileVersion,
    hasFinalExam: facts.hasFinalExam,
    courseGradepass: profile.passingGrade,
    kinds,
  };
  if (facts.itemCounts === undefined) {
    return { ...base, categories: profileCategories, courseCompletion };
  }

  // ── F1 (I3): normalización contra los ítems reales ──
  const counts = facts.itemCounts;
  if (!counts || typeof counts !== 'object') throw new Error('ASSESSMENT_INVALID_FACTS: itemCounts debe ser un objeto');
  for (const k of keys) {
    const n = counts[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`ASSESSMENT_INVALID_FACTS: itemCounts.${k} debe ser un entero ≥ 0 (recibido ${String(n)})`);
    }
  }
  if (facts.hasFinalExam && counts.finalExam !== 1) {
    throw new Error(`ASSESSMENT_INVALID_FACTS: hasFinalExam=true exige itemCounts.finalExam=1 (recibido ${String(counts.finalExam)})`);
  }
  if (!facts.hasFinalExam && (counts.finalExam ?? 0) !== 0) {
    throw new Error(`ASSESSMENT_INVALID_FACTS: hasFinalExam=false pero itemCounts.finalExam=${String(counts.finalExam)}`);
  }
  const originalWeights: Partial<Record<AssessmentCategoryKey, number>> = {};
  for (const c of profileCategories) originalWeights[c.key] = c.weight;
  const populated = keys.filter((k) => (counts[k] as number) > 0);
  const emptyCategories = keys.filter((k) => (counts[k] as number) === 0);

  if (populated.length === 0) {
    // Curso sin nota: sin categorías ponderadas, sin nota aprobatoria del
    // curso ni criterio de nota; la completion la dan las vistas (builder).
    return {
      ...base,
      courseGradepass: 0,
      categories: [],
      courseCompletion: { ...courseCompletion, requireCourseGradePass: false, courseGradepass: 0 },
      weightsNormalized: false,
      originalWeights,
      emptyCategories,
      withoutGrades: true,
    };
  }
  const weightsNormalized = emptyCategories.some((k) => (originalWeights[k] as number) > 0);
  const weights = weightsNormalized
    ? normalizeCategoryWeights(originalWeights, populated)
    : (originalWeights as Record<AssessmentCategoryKey, number>);
  const categories: ResolvedCategory[] = populated.map((key) => ({
    key,
    fullname: ASSESSMENT_CATEGORY_NAMES[key],
    weight: weights[key],
  }));
  const sum2 = categories.reduce((a, c) => a + c.weight, 0);
  if (sum2 !== 100) throw new Error(`ASSESSMENT_WEIGHTS_SUM_NOT_100: tras normalizar suman ${sum2}`);
  return {
    ...base,
    categories,
    courseCompletion,
    weightsNormalized,
    originalWeights,
    emptyCategories,
    withoutGrades: false,
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
