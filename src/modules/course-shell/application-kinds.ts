// r79.1 · Especificación de las Actividades de Aplicación por TIPO y NIVEL (fuente única).
//
//   1. Qué exige cada nivel (cantidades mínimas y máximas de cada elemento, pisos de minutos por sección): lo validan el
//      servidor al completar el item, el ejecutor (espejo en 45-dynamic-generation-executor.js) y el empaque.
//   2. Modelo de trabajo (minutos típicos por elemento) → trabajo ESPECIFICADO de cada nivel (con las cantidades MÍNIMAS
//      del nivel: lo que el generador está obligado a producir). «Más minutos exigen más trabajo real» (§11.3, §12.1):
//      un nivel es seleccionable por el optimizador solo si su densidad de trabajo (trabajo / minutos) no cae más de un
//      10 % respecto del nivel anterior del mismo tipo (CANDADO, `applicationTierLock`). Determinista y verificable.
//   3. Esquemas de los tres tipos nuevos (estudio de caso, proyecto integrador, retroalimentación formativa) como DATOS
//      (APPLICATION_KIND_SCHEMAS) + un intérprete pequeño. El ejecutor del navegador tiene una copia exacta de los datos
//      y del intérprete (paridad: check-r79-1-activity-kinds.js y el harness del frontend test-90).
//   4. Vínculo con los resultados de aprendizaje: `applicationOutcomeRefs` (los resultados que el capítulo trabaja; los
//      mismos en el claim y en la validación del servidor). Cada actividad de un tipo nuevo los cita por id.
import type { ApplicationKind, ApplicationKindOrStandard } from '../study-time/application-kind-tiers';
import { APPLICATION_KINDS, APPLICATION_KIND_LABEL, APPLICATION_KIND_TIERS } from '../study-time/application-kind-tiers';

export type Range = readonly [number, number];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Actividad de siempre («standard»): cantidades por nivel y versión del esquema
// ─────────────────────────────────────────────────────────────────────────────
export interface StandardTierSpec {
  exercises: Range;
  examples: Range; // máximo; el mínimo 1 también lo exigen los géneros con ejemplo obligatorio
  workshopInstructions: Range;
  /** Hitos del taller con producto intermedio ([0, 0] = no lleva). */
  workshopMilestones: Range;
  selfCheck: Range;
  criteria: Range;
  /** Pisos de minutos por sección (minutesBySection). */
  floors: Readonly<Record<string, number>>;
}

/** v1 (documentos generados antes de r79.1): lo de siempre. El nivel de 120 apenas pedía más que el de 90. */
export const STANDARD_SPEC_V1: Readonly<Record<number, StandardTierSpec>> = Object.freeze({
  30: { exercises: [6, 7], examples: [0, 1], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
  60: { exercises: [6, 8], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
  90: { exercises: [8, 10], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
  120: { exercises: [9, 10], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
});

/**
 * v2 (r79.1): 30/60/90 igual que v1; 120 REFORZADO: 10–12 ejercicios, al menos 1 ejemplo resuelto, taller con 3–8
 * consignas y 2–3 HITOS con producto intermedio, 5–8 ítems de autoevaluación, EXACTAMENTE 4 criterios, y pisos de
 * minutos (taller ≥ 35, ejercicios ≥ 40). Así los 120 min tienen el trabajo que los justifica (§12.1).
 */
export const STANDARD_SPEC_V2: Readonly<Record<number, StandardTierSpec>> = Object.freeze({
  30: STANDARD_SPEC_V1[30],
  60: STANDARD_SPEC_V1[60],
  90: STANDARD_SPEC_V1[90],
  120: { exercises: [10, 12], examples: [1, 2], workshopInstructions: [3, 8], workshopMilestones: [2, 3], selfCheck: [5, 8], criteria: [4, 4], floors: { workshop: 35, exercises: 40 } },
});

export function standardSpecFor(schemaVersion: number, minutes: number): StandardTierSpec | undefined {
  return (schemaVersion === 1 ? STANDARD_SPEC_V1 : STANDARD_SPEC_V2)[minutes];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tipos nuevos: cantidades por nivel
// ─────────────────────────────────────────────────────────────────────────────
/** Cantidades y pisos por nivel de cada tipo (claves = las que usa el esquema con `{ tier: 'clave' }`). */
export const APPLICATION_KIND_COUNTS: Readonly<Record<ApplicationKind, Readonly<Record<number, Readonly<Record<string, Range>> & { floors?: never }>>>> = Object.freeze({
  case_study: {
    60: { narrative: [900, 3200], exhibits: [1, 2], questions: [4, 5], constraints: [2, 3], alternatives: [1, 3], keyPoints: [2, 5], selfCheck: [4, 6], criteria: [3, 4], outcomeLinks: [1, 3], discussion: [2, 4] },
    90: { narrative: [1400, 4500], exhibits: [2, 3], questions: [6, 7], constraints: [3, 4], alternatives: [2, 3], keyPoints: [2, 5], selfCheck: [5, 8], criteria: [4, 4], outcomeLinks: [1, 3], discussion: [3, 5] },
  },
  integrative_project: {
    90: { stages: [3, 3], stageTasks: [2, 4], integration: [2, 4], selfCheck: [5, 8], criteria: [4, 4], outcomeLinks: [1, 4], stageErrors: [1, 4], checkpoints: [1, 3] },
    120: { stages: [4, 4], stageTasks: [2, 5], integration: [3, 5], selfCheck: [5, 8], criteria: [4, 5], outcomeLinks: [1, 4], stageErrors: [1, 4], checkpoints: [1, 3] },
  },
  formative_feedback: {
    30: { reviewCriteria: [3, 3], reviewQuestions: [1, 2], commonErrors: [2, 3], revisionSteps: [2, 3], peerReview: [0, 0], peerInstructions: [0, 0], reflection: [2, 3], selfCheck: [3, 5], criteria: [3, 3], outcomeLinks: [1, 3], errorGuide: [1, 3] },
    60: { reviewCriteria: [4, 4], reviewQuestions: [2, 3], commonErrors: [4, 6], revisionSteps: [4, 6], peerReview: [1, 1], peerInstructions: [3, 5], reflection: [3, 4], selfCheck: [5, 8], criteria: [3, 4], outcomeLinks: [1, 3], errorGuide: [2, 6] },
    90: { reviewCriteria: [6, 6], reviewQuestions: [2, 3], commonErrors: [6, 8], revisionSteps: [7, 9], peerReview: [1, 1], peerInstructions: [5, 6], reflection: [5, 6], selfCheck: [6, 8], criteria: [4, 4], outcomeLinks: [1, 3], errorGuide: [3, 8] },
    120: { reviewCriteria: [8, 8], reviewQuestions: [2, 3], commonErrors: [8, 10], revisionSteps: [9, 12], peerReview: [1, 1], peerInstructions: [6, 8], reflection: [6, 8], selfCheck: [6, 8], criteria: [4, 4], outcomeLinks: [1, 3], errorGuide: [4, 10] },
  },
} as any);

/** Pisos de minutos por sección (minutesBySection) de cada tipo y nivel. */
export const APPLICATION_KIND_FLOORS: Readonly<Record<ApplicationKind, Readonly<Record<number, Readonly<Record<string, number>>>>>> = Object.freeze({
  case_study: { 60: { reading: 10, analysis: 20, decision: 12 }, 90: { reading: 15, analysis: 30, decision: 20 } },
  integrative_project: { 90: { stages: 60, integration: 10 }, 120: { stages: 80, integration: 15 } },
  formative_feedback: { 30: { review: 8, revision: 8 }, 60: { review: 12, revision: 15, peerReview: 10 }, 90: { review: 18, revision: 25, peerReview: 15 }, 120: { review: 24, revision: 35, peerReview: 20 } },
});

/** Secciones de minutesBySection de cada tipo (las de peerReview solo cuando el nivel la exige). */
export const APPLICATION_KIND_SECTIONS: Readonly<Record<ApplicationKindOrStandard, readonly string[]>> = Object.freeze({
  standard: ['examples', 'exercises', 'workshop', 'selfCheck'],
  case_study: ['reading', 'analysis', 'decision', 'selfCheck'],
  integrative_project: ['stages', 'integration', 'selfCheck'],
  formative_feedback: ['study', 'review', 'revision', 'peerReview', 'reflection'],
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Modelo de trabajo y candado de proporcionalidad (§12.1)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Minutos TÍPICOS de trabajo del estudiante por elemento especificado (estudiante típico de Cursia: lectura de estudio a
 * 150 palabras/min ≈ 1 000 caracteres en 1,5 min, ×2 cuando hay que anotar datos de un caso; un ejercicio graduado con
 * respuesta escrita ≈ 5 min; una pregunta de análisis de un caso con justificación ≈ 6 min). Versionado: cambiar un valor
 * cambia el candado y lo prueba el check.
 */
export const WORK_MODEL_VERSION = 1 as const;
export const WORK_MINUTES = Object.freeze({
  // Actividad de siempre
  exercise: 5,
  workedExample: 5,
  workshopInstruction: 4,
  workshopMilestone: 8,
  selfCheckItem: 0.5,
  criterion: 1,
  // Estudio de caso
  caseNarrativePer1000Chars: 3,
  exhibit: 4,
  analysisQuestion: 6,
  decisionConstraint: 2,
  decisionTask: 10,
  // Proyecto integrador
  stageTask: 6,
  stageDeliverable: 6,
  integrationInstruction: 4,
  integrationProduct: 6,
  // Retroalimentación formativa
  reviewCriterion: 2.5,
  reviewQuestion: 0.5,
  commonError: 1.5,
  exemplarPair: 5,
  revisionStep: 2.5,
  resubmission: 4,
  peerInstruction: 2,
  peerReviewExchange: 10,
  reflectionPrompt: 1.5,
});
/** Densidad mínima de un nivel respecto del anterior del mismo tipo (−10 % de tolerancia). */
export const PROPORTIONALITY_FACTOR = 0.9;

const lo = (r: Range | undefined) => (r ? r[0] : 0);

/** Trabajo ESPECIFICADO (minutos típicos) con las cantidades MÍNIMAS del nivel. */
export function specifiedWorkMinutes(kind: ApplicationKindOrStandard, minutes: number, schemaVersion = 2): number {
  const W = WORK_MINUTES;
  if (kind === 'standard') {
    const s = standardSpecFor(schemaVersion, minutes);
    if (!s) throw new Error(`APPLICATION_SPEC: nivel ${minutes} sin especificación (standard v${schemaVersion})`);
    return r2(lo(s.exercises) * W.exercise + lo(s.examples) * W.workedExample + lo(s.workshopInstructions) * W.workshopInstruction
      + lo(s.workshopMilestones) * W.workshopMilestone + lo(s.selfCheck) * W.selfCheckItem + lo(s.criteria) * W.criterion);
  }
  const c = (APPLICATION_KIND_COUNTS[kind] as any)[minutes] as Record<string, Range> | undefined;
  if (!c) throw new Error(`APPLICATION_SPEC: ${kind} sin nivel ${minutes}`);
  const common = lo(c.selfCheck) * W.selfCheckItem + lo(c.criteria) * W.criterion;
  if (kind === 'case_study') {
    return r2((lo(c.narrative) / 1000) * W.caseNarrativePer1000Chars + lo(c.exhibits) * W.exhibit + lo(c.questions) * W.analysisQuestion
      + lo(c.constraints) * W.decisionConstraint + W.decisionTask + common);
  }
  if (kind === 'integrative_project') {
    return r2(lo(c.stages) * (lo(c.stageTasks) * W.stageTask + W.stageDeliverable) + lo(c.integration) * W.integrationInstruction + W.integrationProduct + common);
  }
  return r2(lo(c.reviewCriteria) * (W.reviewCriterion + lo(c.reviewQuestions) * W.reviewQuestion) + lo(c.commonErrors) * W.commonError + W.exemplarPair
    + lo(c.revisionSteps) * W.revisionStep + W.resubmission + lo(c.peerReview) * (W.peerReviewExchange + lo(c.peerInstructions) * W.peerInstruction)
    + lo(c.reflection) * W.reflectionPrompt + common);
}

export interface TierLockRow {
  kind: ApplicationKindOrStandard;
  minutes: number;
  workMinutes: number;
  /** trabajo / minutos. */
  density: number;
  /** Nivel anterior del mismo tipo (null en el primero). */
  previous: number | null;
  /** densidad / densidad del anterior (null en el primero). */
  ratio: number | null;
  proportional: boolean;
  /** El candado aplica a este nivel (lo decide el owner: §12.1 para el de 120 de siempre; todos los de los tipos nuevos). */
  enforced: boolean;
  /** Seleccionable por el optimizador = proporcional o el candado no aplica. */
  selectable: boolean;
}

/** Niveles con candado (§12.1: el de 120 min de la Actividad de siempre y TODOS los niveles de los tipos nuevos). */
export const TIER_LOCK_ENFORCED: Readonly<Record<ApplicationKindOrStandard, readonly number[]>> = Object.freeze({
  standard: Object.freeze([120]),
  case_study: APPLICATION_KIND_TIERS.case_study,
  integrative_project: APPLICATION_KIND_TIERS.integrative_project,
  formative_feedback: APPLICATION_KIND_TIERS.formative_feedback,
});

/**
 * El candado: por tipo, cada nivel frente al anterior. `work` permite probar otra especificación (el check prueba que con
 * la de v1 el nivel de 120 NO pasa y el optimizador no lo elige).
 */
export function applicationTierLock(work: (kind: ApplicationKindOrStandard, minutes: number) => number = (k, m) => specifiedWorkMinutes(k, m)): TierLockRow[] {
  const out: TierLockRow[] = [];
  const kinds: ApplicationKindOrStandard[] = ['standard', ...APPLICATION_KINDS];
  for (const kind of kinds) {
    const tiers = kind === 'standard' ? [30, 60, 90, 120] : [...APPLICATION_KIND_TIERS[kind]];
    let prev: { minutes: number; density: number } | null = null;
    for (const m of tiers) {
      const w = work(kind, m);
      const density = r4(w / m);
      const ratio = prev ? r4(density / prev.density) : null;
      const proportional = ratio === null || ratio >= PROPORTIONALITY_FACTOR - 1e-9;
      const enforced = TIER_LOCK_ENFORCED[kind].includes(m);
      out.push({ kind, minutes: m, workMinutes: w, density, previous: prev ? prev.minutes : null, ratio, proportional, enforced, selectable: proportional || !enforced });
      prev = { minutes: m, density };
    }
  }
  return out;
}

let lockCache: TierLockRow[] | null = null;
/** ¿El optimizador puede elegir este nivel? (con la especificación vigente). */
export function isTierSelectable(kind: ApplicationKindOrStandard, minutes: number, lock?: readonly TierLockRow[] | null): boolean {
  const rows = lock ?? (lockCache ??= applicationTierLock());
  const r = rows.find((x) => x.kind === kind && x.minutes === minutes);
  return !r || r.selectable;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b. Costo: unidades de salida por tipo y nivel (FinOps, llm.application_activity)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Salida del generador (actividad + solucionario) en «ejercicios equivalentes» (un ejercicio con su respuesta y su
 * explicación ≈ 1 unidad; el prior de llm.application_activity es el del nivel de 60, 7 unidades). Prior derivado de la
 * especificación (cantidades medias de cada nivel), NO medido: reemplazar con el ledger cuando haya corridas reales.
 *   - standard: 30/60/90 = 6/7/9 (los de siempre); 120 = 11 (10–12 ejercicios + 2–3 hitos con producto).
 *   - case_study: el relato (≈ 2–3 unidades), anexos, 4–7 preguntas con su análisis esperado y puntos clave, la decisión
 *     con alternativas y la guía de discusión → 60 = 10, 90 = 13.
 *   - integrative_project: 3–4 etapas (tareas + entregable + guía de la etapa con errores y preguntas de control ≈ 2,5
 *     unidades c/u) + integración + ejemplo de producto final → 90 = 10, 120 = 13.
 *   - formative_feedback: criterios de revisión con su banco de retroalimentación, ejemplar comentado, errores
 *     frecuentes con diagnóstico, plan de mejora (y revisión entre pares) → 30 = 6, 60 = 8, 90 = 10, 120 = 12.
 */
export const APPLICATION_OUTPUT_UNITS: Readonly<Record<ApplicationKindOrStandard, Readonly<Record<number, number>>>> = Object.freeze({
  standard: { 30: 6, 60: 7, 90: 9, 120: 11 },
  case_study: { 60: 10, 90: 13 },
  integrative_project: { 90: 10, 120: 13 },
  formative_feedback: { 30: 6, 60: 8, 90: 10, 120: 12 },
});
export function applicationOutputUnits(kind: string | null, minutes: number): number | null {
  const k = (kind && kind !== 'standard' && (APPLICATION_KINDS as readonly string[]).includes(kind) ? kind : 'standard') as ApplicationKindOrStandard;
  return APPLICATION_OUTPUT_UNITS[k][minutes] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Esquemas de los tipos nuevos (DATOS) + intérprete
// ─────────────────────────────────────────────────────────────────────────────
type Count = number | { tier: string };
export type FieldSpec =
  | { k: 'text'; min: number | { tier: string }; max: number | { tier: string } }
  | { k: 'int'; min: number; max: number }
  | { k: 'enum'; values: readonly string[] }
  | { k: 'obj'; fields: Readonly<Record<string, FieldSpec>>; optional?: readonly string[] }
  | { k: 'list'; of: FieldSpec; min: Count; max: Count; ids?: { key: string; prefix: string }; unique?: string; order?: { key: string; values: readonly string[] } }
  | { k: 'texts'; min: Count; max: Count; itemMin: number; itemMax: number };

export interface KindRule {
  r: 'weights100' | 'minutesBudget' | 'sumEquals' | 'covers' | 'outcomeRefs' | 'mustInclude' | 'presence';
  [k: string]: unknown;
}
export interface KindSchema {
  student: FieldSpec & { k: 'obj' };
  solution: FieldSpec & { k: 'obj' };
  rules: readonly KindRule[];
}

const T = (min: number, max: number): FieldSpec => ({ k: 'text', min, max });
const TX = (min: Count, max: Count, itemMin = 8, itemMax = 600): FieldSpec => ({ k: 'texts', min, max, itemMin, itemMax });
const COMMON_STUDENT: Readonly<Record<string, FieldSpec>> = Object.freeze({
  title: T(4, 160),
  objective: T(20, 1200),
  outcomeLinks: { k: 'list', min: { tier: 'outcomeLinks' }, max: { tier: 'outcomeLinks' }, unique: 'outcomeId', of: { k: 'obj', fields: { outcomeId: T(1, 40), evidence: T(15, 600) } } },
  deliverable: { k: 'obj', fields: { description: T(15, 1200), format: T(3, 160), extent: T(2, 160) } },
  selfCheck: TX({ tier: 'selfCheck' }, { tier: 'selfCheck' }, 8, 1200),
  criteria: { k: 'list', min: { tier: 'criteria' }, max: { tier: 'criteria' }, unique: 'name', of: { k: 'obj', fields: { name: T(3, 160), description: T(10, 1200), weight: { k: 'int', min: 5, max: 70 } } } },
});
const CORRECTION_GUIDE: FieldSpec = { k: 'list', min: 1, max: 8, of: { k: 'obj', fields: { criterion: T(3, 160), achieved: T(10, 1200), developing: T(10, 1200), insufficient: T(10, 1200) } } };
const TEACHER_NOTES = TX(1, 6, 10, 1200);

export const CASE_QUESTION_LEVELS = Object.freeze(['comprender', 'analizar', 'evaluar', 'proponer'] as const);
export const CASE_EXHIBIT_KINDS = Object.freeze(['table', 'data', 'document', 'testimony'] as const);

export const APPLICATION_KIND_SCHEMAS: Readonly<Record<ApplicationKind, KindSchema>> = Object.freeze({
  case_study: {
    student: {
      k: 'obj',
      fields: {
        ...COMMON_STUDENT,
        case: {
          k: 'obj',
          fields: {
            title: T(4, 160),
            organization: T(3, 160),
            narrative: { k: 'text', min: { tier: 'narrative' }, max: { tier: 'narrative' } },
            exhibits: { k: 'list', min: { tier: 'exhibits' }, max: { tier: 'exhibits' }, of: { k: 'obj', fields: { title: T(4, 160), kind: { k: 'enum', values: CASE_EXHIBIT_KINDS }, content: T(40, 1600) } } },
          },
        },
        questions: {
          k: 'list', min: { tier: 'questions' }, max: { tier: 'questions' }, ids: { key: 'id', prefix: 'Q' }, order: { key: 'level', values: CASE_QUESTION_LEVELS },
          of: { k: 'obj', fields: { id: T(2, 4), prompt: T(15, 1200), level: { k: 'enum', values: CASE_QUESTION_LEVELS }, answerLines: { k: 'int', min: 2, max: 15 } } },
        },
        decision: { k: 'obj', fields: { prompt: T(30, 1200), constraints: TX({ tier: 'constraints' }, { tier: 'constraints' }, 8, 600) } },
        minutesBySection: { k: 'obj', fields: { reading: { k: 'int', min: 0, max: 120 }, analysis: { k: 'int', min: 0, max: 120 }, decision: { k: 'int', min: 0, max: 120 }, selfCheck: { k: 'int', min: 0, max: 120 } } },
      },
    },
    solution: {
      k: 'obj',
      fields: {
        questionGuides: { k: 'list', min: 1, max: 12, of: { k: 'obj', fields: { questionId: T(2, 4), expectedAnalysis: T(40, 2400), keyPoints: TX({ tier: 'keyPoints' }, { tier: 'keyPoints' }, 5, 600) } } },
        decisionDiscussion: { k: 'obj', fields: { recommended: T(30, 2400), alternatives: TX({ tier: 'alternatives' }, { tier: 'alternatives' }, 15, 1200), justification: T(40, 2400) } },
        discussionQuestions: TX({ tier: 'discussion' }, { tier: 'discussion' }, 10, 600),
        correctionGuide: CORRECTION_GUIDE,
        teacherNotes: TEACHER_NOTES,
      },
    },
    rules: [
      { r: 'weights100', path: 'activity.criteria' },
      { r: 'minutesBudget', path: 'activity.minutesBySection' },
      { r: 'mustInclude', path: 'activity.questions', key: 'level', values: ['analizar', 'evaluar'] },
      { r: 'covers', path: 'solution.questionGuides', key: 'questionId', of: 'activity.questions', ofKey: 'id' },
      { r: 'covers', path: 'solution.correctionGuide', key: 'criterion', of: 'activity.criteria', ofKey: 'name' },
      { r: 'outcomeRefs', path: 'activity.outcomeLinks' },
    ],
  },
  integrative_project: {
    student: {
      k: 'obj',
      fields: {
        ...COMMON_STUDENT,
        brief: { k: 'obj', fields: { situation: T(120, 2400), finalProduct: T(30, 1200) } },
        stages: {
          k: 'list', min: { tier: 'stages' }, max: { tier: 'stages' }, ids: { key: 'id', prefix: 'S' },
          of: { k: 'obj', fields: { id: T(2, 4), title: T(4, 160), purpose: T(20, 1200), linkedChapter: T(3, 160), tasks: TX({ tier: 'stageTasks' }, { tier: 'stageTasks' }, 10, 600), intermediateDeliverable: T(15, 600), minutes: { k: 'int', min: 10, max: 45 } } },
        },
        integration: { k: 'obj', fields: { instructions: TX({ tier: 'integration' }, { tier: 'integration' }, 10, 600), presentation: T(20, 600) } },
        minutesBySection: { k: 'obj', fields: { stages: { k: 'int', min: 0, max: 200 }, integration: { k: 'int', min: 0, max: 120 }, selfCheck: { k: 'int', min: 0, max: 120 } } },
      },
    },
    solution: {
      k: 'obj',
      fields: {
        stageGuides: { k: 'list', min: 1, max: 6, of: { k: 'obj', fields: { stageId: T(2, 4), expectedOutput: T(40, 2400), commonErrors: TX({ tier: 'stageErrors' }, { tier: 'stageErrors' }, 10, 600), checkpointQuestions: TX({ tier: 'checkpoints' }, { tier: 'checkpoints' }, 10, 600) } } },
        finalProductExemplar: T(200, 4800),
        correctionGuide: CORRECTION_GUIDE,
        teacherNotes: TEACHER_NOTES,
      },
    },
    rules: [
      { r: 'weights100', path: 'activity.criteria' },
      { r: 'minutesBudget', path: 'activity.minutesBySection' },
      { r: 'sumEquals', path: 'activity.stages', key: 'minutes', equals: 'activity.minutesBySection.stages' },
      { r: 'covers', path: 'solution.stageGuides', key: 'stageId', of: 'activity.stages', ofKey: 'id' },
      { r: 'covers', path: 'solution.correctionGuide', key: 'criterion', of: 'activity.criteria', ofKey: 'name' },
      // Integra: cita al menos 2 resultados distintos del capítulo (o todos, si el capítulo trabaja uno solo).
      { r: 'outcomeRefs', path: 'activity.outcomeLinks', minDistinct: 2 },
    ],
  },
  formative_feedback: {
    student: {
      k: 'obj',
      optional: ['peerReview'],
      fields: {
        ...COMMON_STUDENT,
        target: { k: 'obj', fields: { product: T(20, 1200), sourceActivity: T(3, 300) } },
        reviewCriteria: {
          k: 'list', min: { tier: 'reviewCriteria' }, max: { tier: 'reviewCriteria' }, ids: { key: 'id', prefix: 'R' }, unique: 'name',
          of: { k: 'obj', fields: { id: T(2, 4), name: T(3, 160), lookFor: T(20, 1200), questions: TX({ tier: 'reviewQuestions' }, { tier: 'reviewQuestions' }, 10, 600) } },
        },
        exemplar: { k: 'obj', fields: { strong: T(80, 2400), weak: T(80, 2400), commentary: T(60, 2400) } },
        commonErrors: { k: 'list', min: { tier: 'commonErrors' }, max: { tier: 'commonErrors' }, of: { k: 'obj', fields: { error: T(10, 600), howToSpot: T(10, 600), howToFix: T(10, 600) } } },
        revision: { k: 'obj', fields: { steps: TX({ tier: 'revisionSteps' }, { tier: 'revisionSteps' }, 10, 600), resubmission: T(20, 600) } },
        peerReview: { k: 'obj', fields: { instructions: TX({ tier: 'peerInstructions' }, { tier: 'peerInstructions' }, 10, 600), protocol: T(20, 1200) } },
        reflection: TX({ tier: 'reflection' }, { tier: 'reflection' }, 10, 600),
        minutesBySection: {
          k: 'obj', optional: ['peerReview'],
          fields: { study: { k: 'int', min: 0, max: 120 }, review: { k: 'int', min: 0, max: 120 }, revision: { k: 'int', min: 0, max: 120 }, peerReview: { k: 'int', min: 0, max: 120 }, reflection: { k: 'int', min: 0, max: 120 } },
        },
      },
    },
    solution: {
      k: 'obj',
      fields: {
        feedbackBank: {
          k: 'list', min: 1, max: 8,
          of: { k: 'obj', fields: { criterion: T(3, 160), achieved: T(10, 1200), developing: T(10, 1200), insufficient: T(10, 1200), feedbackComment: T(20, 1200), nextStep: T(10, 600) } },
        },
        errorGuide: { k: 'list', min: { tier: 'errorGuide' }, max: { tier: 'errorGuide' }, of: { k: 'obj', fields: { error: T(10, 600), diagnosis: T(10, 1200) } } },
        correctionGuide: CORRECTION_GUIDE,
        teacherNotes: TEACHER_NOTES,
      },
    },
    rules: [
      { r: 'weights100', path: 'activity.criteria' },
      { r: 'presence', path: 'activity.peerReview', tier: 'peerReview', section: 'peerReview' },
      { r: 'minutesBudget', path: 'activity.minutesBySection' },
      { r: 'covers', path: 'solution.feedbackBank', key: 'criterion', of: 'activity.reviewCriteria', ofKey: 'name' },
      { r: 'covers', path: 'solution.correctionGuide', key: 'criterion', of: 'activity.criteria', ofKey: 'name' },
      { r: 'outcomeRefs', path: 'activity.outcomeLinks' },
    ],
  },
} as Record<ApplicationKind, KindSchema>);

/** Marcas de solucionario (igual que la Actividad de siempre): nunca en la parte del estudiante. */
export const KIND_SOLUTION_MARKERS_RE = /Solucionario|Gu[ií]a de correcci[oó]n|Respuesta:|Soluci[oó]n esperada/i;
export const KIND_MINUTES_TOLERANCE = 0.2;

export interface KindValidationError { path: string; code: string; message: string }
export interface KindValidationContext {
  kind: ApplicationKind;
  minutes: number;
  /** Ids de los resultados que el capítulo trabaja (applicationOutcomeRefs). Vacío = no se verifican los ids. */
  outcomeIds?: readonly string[];
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => strings(x, out));
  return out;
}
function at(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? (o as Record<string, unknown>)[k] : undefined), root);
}

/** Intérprete del esquema (mismo algoritmo en el ejecutor del navegador: dynValidateKindPart). */
export function validateKindValue(spec: FieldSpec, v: unknown, path: string, counts: Readonly<Record<string, Range>>, errors: KindValidationError[]): void {
  const err = (code: string, message: string, p = path): void => { errors.push({ path: p, code, message }); };
  const num = (c: Count, side: 0 | 1): number => (typeof c === 'number' ? c : (counts[c.tier] ?? [0, 0])[side]);
  switch (spec.k) {
    case 'text': {
      const min = typeof spec.min === 'number' ? spec.min : num(spec.min, 0);
      const max = typeof spec.max === 'number' ? spec.max : num(spec.max, 1);
      if (typeof v !== 'string' || v.trim().length < min) return err('APPLICATION_TEXT', `${path} debe ser un texto de al menos ${min} caracteres`);
      if (v.length > max) err('APPLICATION_TEXT_TOO_LONG', `${path} supera ${max} caracteres (${v.length})`);
      return;
    }
    case 'int':
      if (!Number.isInteger(v) || (v as number) < spec.min || (v as number) > spec.max) err('APPLICATION_INT', `${path} debe ser un entero de ${spec.min} a ${spec.max}`);
      return;
    case 'enum':
      if (typeof v !== 'string' || !spec.values.includes(v)) err('APPLICATION_ENUM', `${path} debe ser uno de ${spec.values.join(', ')}`);
      return;
    case 'texts': {
      const min = num(spec.min, 0);
      const max = num(spec.max, 1);
      if (!Array.isArray(v)) return err('APPLICATION_LIST', `${path} debe ser una lista`);
      if (v.length < min || v.length > max) err('APPLICATION_COUNT', `${path} debe tener entre ${min} y ${max} elementos (tiene ${v.length})`);
      v.forEach((x, i) => validateKindValue({ k: 'text', min: spec.itemMin, max: spec.itemMax }, x, `${path}[${i}]`, counts, errors));
      return;
    }
    case 'list': {
      const min = num(spec.min, 0);
      const max = num(spec.max, 1);
      if (!Array.isArray(v)) return err('APPLICATION_LIST', `${path} debe ser una lista`);
      if (v.length < min || v.length > max) err('APPLICATION_COUNT', `${path} debe tener entre ${min} y ${max} elementos (tiene ${v.length})`);
      const seen = new Set<string>();
      let last = -1;
      v.forEach((x, i) => {
        const p = `${path}[${i}]`;
        validateKindValue(spec.of, x, p, counts, errors);
        if (!isObj(x)) return;
        if (spec.ids && x[spec.ids.key] !== `${spec.ids.prefix}${i + 1}`) err('APPLICATION_ID', `${p}.${spec.ids.key} debe ser "${spec.ids.prefix}${i + 1}" (en orden)`, `${p}.${spec.ids.key}`);
        if (spec.unique) {
          const u = String(x[spec.unique] ?? '').trim();
          if (u && seen.has(u)) err('APPLICATION_DUPLICATE', `${spec.unique} repetido: ${u}`, `${p}.${spec.unique}`);
          seen.add(u);
        }
        if (spec.order) {
          const d = spec.order.values.indexOf(x[spec.order.key]);
          if (d >= 0 && d < last) err('APPLICATION_ORDER', `${path}: «${spec.order.key}» va de menor a mayor (${spec.order.values.join(' → ')})`, `${p}.${spec.order.key}`);
          if (d >= 0) last = Math.max(last, d);
        }
      });
      return;
    }
    case 'obj': {
      if (!isObj(v)) return err('APPLICATION_SHAPE', `falta ${path} (objeto)`);
      for (const k of Object.keys(v)) if (!(k in spec.fields)) err('APPLICATION_SHAPE', `campo desconocido: ${path}.${k}`, `${path}.${k}`);
      for (const [k, f] of Object.entries(spec.fields)) {
        if (v[k] === undefined && spec.optional?.includes(k)) continue;
        validateKindValue(f, v[k], `${path}.${k}`, counts, errors);
      }
      return;
    }
  }
}

/** Valida un documento de un tipo nuevo completo (estudiante + solucionario). Vacío = válido. */
export function validateApplicationKindDoc(doc: Record<string, any>, ctx: KindValidationContext): KindValidationError[] {
  const schema = APPLICATION_KIND_SCHEMAS[ctx.kind];
  const counts = (APPLICATION_KIND_COUNTS[ctx.kind] as any)[ctx.minutes] as Record<string, Range> | undefined;
  if (!schema || !counts) throw new Error(`V3_VALIDATION_CONTEXT: ${String(ctx.kind)} sin nivel ${ctx.minutes} (niveles ${APPLICATION_KIND_TIERS[ctx.kind]?.join(', ')})`);
  const errors: KindValidationError[] = [];
  validateKindPart(ctx, doc.activity, 'student', errors);
  validateKindPart(ctx, doc.solution, 'solution', errors, doc.activity);
  return errors;
}

/** Una parte (`student` = la actividad; `solution` = el solucionario, que necesita la actividad para las coberturas). */
export function validateKindPart(ctx: KindValidationContext, part: unknown, which: 'student' | 'solution', errors: KindValidationError[], activity?: unknown): void {
  const schema = APPLICATION_KIND_SCHEMAS[ctx.kind];
  const counts = (APPLICATION_KIND_COUNTS[ctx.kind] as any)[ctx.minutes] as Record<string, Range>;
  const path = which === 'student' ? '$.activity' : '$.solution';
  validateKindValue(which === 'student' ? schema.student : schema.solution, part, path, counts, errors);
  if (which === 'student' && isObj(part)) {
    const marker = strings(part).find((x) => KIND_SOLUTION_MARKERS_RE.test(x));
    if (marker !== undefined) errors.push({ path, code: 'APPLICATION_SOLUTION_MARKER', message: `la actividad del estudiante no puede contener marcas de solucionario («Respuesta:», «Solución esperada», «Guía de corrección», «Solucionario»): «${marker.slice(0, 80)}»` });
  }
  const root = { activity: which === 'student' ? part : activity, solution: which === 'solution' ? part : undefined } as Record<string, unknown>;
  for (const rule of schema.rules) {
    const target = String(rule.path);
    if (!target.startsWith(which === 'student' ? 'activity' : 'solution')) continue;
    applyKindRule(rule, root, ctx, counts, errors);
  }
}

function applyKindRule(rule: KindRule, root: Record<string, unknown>, ctx: KindValidationContext, counts: Record<string, Range>, errors: KindValidationError[]): void {
  const p = `$.${rule.path}`;
  const v = at(root, String(rule.path));
  switch (rule.r) {
    case 'weights100': {
      if (!Array.isArray(v) || !v.length) return;
      const ws = v.map((c) => (isObj(c) ? c.weight : null));
      if (ws.every((w) => Number.isInteger(w))) {
        const sum = (ws as number[]).reduce((a, b) => a + b, 0);
        if (sum !== 100) errors.push({ path: p, code: 'APPLICATION_CRITERIA_WEIGHTS', message: `los pesos de los criterios deben sumar 100 (suman ${sum})` });
      }
      return;
    }
    case 'presence': {
      const want = (counts[String(rule.tier)] ?? [0, 0])[0] > 0;
      const has = v !== undefined;
      if (want && !has) errors.push({ path: p, code: 'APPLICATION_SHAPE', message: `${p} es obligatorio en el nivel de ${ctx.minutes} min` });
      if (!want && has) errors.push({ path: p, code: 'APPLICATION_SHAPE', message: `${p} no corresponde al nivel de ${ctx.minutes} min` });
      const mbs = at(root, 'activity.minutesBySection');
      const sec = String(rule.section);
      if (isObj(mbs)) {
        if (want && mbs[sec] === undefined) errors.push({ path: `$.activity.minutesBySection.${sec}`, code: 'APPLICATION_SECTION_MINUTES', message: `falta minutesBySection.${sec}` });
        if (!want && mbs[sec] !== undefined) errors.push({ path: `$.activity.minutesBySection.${sec}`, code: 'APPLICATION_SECTION_MINUTES', message: `minutesBySection.${sec} no corresponde al nivel de ${ctx.minutes} min` });
      }
      return;
    }
    case 'minutesBudget': {
      if (!isObj(v)) return;
      const vals = Object.values(v);
      if (!vals.every((x) => Number.isInteger(x))) return;
      const total = (vals as number[]).reduce((a, b) => a + b, 0);
      if (Math.abs(total - ctx.minutes) > ctx.minutes * KIND_MINUTES_TOLERANCE) {
        errors.push({ path: p, code: 'APPLICATION_MINUTES_BUDGET', message: `las secciones suman ${total} min; el nivel es ${ctx.minutes} min (±${Math.round(KIND_MINUTES_TOLERANCE * 100)} %)` });
      }
      const floors = APPLICATION_KIND_FLOORS[ctx.kind][ctx.minutes] ?? {};
      for (const [sec, f] of Object.entries(floors)) {
        if (typeof v[sec] === 'number' && v[sec] < f) errors.push({ path: `${p}.${sec}`, code: 'APPLICATION_SECTION_FLOOR', message: `${sec}: ${v[sec]} min; el nivel de ${ctx.minutes} min exige al menos ${f} min de trabajo en esta sección` });
      }
      return;
    }
    case 'sumEquals': {
      if (!Array.isArray(v)) return;
      const want = at(root, String(rule.equals));
      const xs = v.map((x) => (isObj(x) ? x[String(rule.key)] : null));
      if (!xs.every((x) => Number.isInteger(x)) || !Number.isInteger(want)) return;
      const sum = (xs as number[]).reduce((a, b) => a + b, 0);
      if (sum !== want) errors.push({ path: p, code: 'APPLICATION_STAGE_MINUTES', message: `las etapas suman ${sum} min y minutesBySection.${String(rule.equals).split('.').pop()} dice ${String(want)}` });
      return;
    }
    case 'mustInclude': {
      if (!Array.isArray(v)) return;
      const have = new Set(v.map((x) => (isObj(x) ? x[String(rule.key)] : null)));
      const miss = (rule.values as string[]).filter((x) => !have.has(x));
      if (miss.length) errors.push({ path: p, code: 'APPLICATION_LEVELS', message: `${p} debe incluir al menos una pregunta de nivel ${miss.join(' y ')}` });
      return;
    }
    case 'covers': {
      const of = at(root, String(rule.of));
      if (!Array.isArray(v) || !Array.isArray(of)) return;
      const want = of.map((x) => (isObj(x) ? String(x[String(rule.ofKey)] ?? '').trim() : ''));
      if (v.length !== want.length) errors.push({ path: p, code: 'APPLICATION_SOLUTION_COVERAGE', message: `${p} debe tener EXACTAMENTE ${want.length} elementos (uno por cada ${String(rule.of).split('.').pop()}, en orden; tiene ${v.length})` });
      v.forEach((x, i) => {
        const got = isObj(x) ? String(x[String(rule.key)] ?? '').trim() : '';
        if (i < want.length && got !== want[i]) errors.push({ path: `${p}[${i}].${String(rule.key)}`, code: 'APPLICATION_SOLUTION_COVERAGE', message: `${p}[${i}].${String(rule.key)} debe ser «${want[i]}» (mismo orden)` });
      });
      return;
    }
    case 'outcomeRefs': {
      if (!Array.isArray(v)) return;
      const allowed = ctx.outcomeIds ?? [];
      if (!allowed.length) return;
      const want = Math.min(Number(rule.minDistinct ?? 1), allowed.length);
      const distinct = new Set(v.map((x) => (isObj(x) ? x.outcomeId : null)).filter((x) => typeof x === 'string' && allowed.includes(x as string)));
      if (distinct.size < want) errors.push({ path: p, code: 'APPLICATION_OUTCOME_COVERAGE', message: `${p} debe citar al menos ${want} resultados distintos del capítulo (${allowed.join(', ')})` });
      v.forEach((x, i) => {
        const id = isObj(x) ? x.outcomeId : undefined;
        if (typeof id === 'string' && !allowed.includes(id)) errors.push({ path: `${p}[${i}].outcomeId`, code: 'APPLICATION_OUTCOME_REF', message: `${p}[${i}].outcomeId «${id}» no es un resultado de este capítulo (${allowed.join(', ')})` });
      });
      return;
    }
  }
}

/** Métricas del output_summary (no bloquean). */
export function applicationKindSummary(doc: any): Record<string, unknown> {
  const a = doc?.activity ?? {};
  const kind = doc?.kind;
  const base = { kind, minutes: doc?.minutes ?? null, title: typeof a.title === 'string' ? a.title.slice(0, 160) : null, criteriaCount: Array.isArray(a.criteria) ? a.criteria.length : 0, outcomeIds: Array.isArray(a.outcomeLinks) ? a.outcomeLinks.map((x: any) => x?.outcomeId).filter((x: unknown) => typeof x === 'string') : [] };
  if (kind === 'case_study') return { ...base, questionCount: Array.isArray(a.questions) ? a.questions.length : 0, exhibitCount: Array.isArray(a.case?.exhibits) ? a.case.exhibits.length : 0, workshopTitle: typeof a.case?.title === 'string' ? a.case.title.slice(0, 160) : null };
  if (kind === 'integrative_project') return { ...base, stageCount: Array.isArray(a.stages) ? a.stages.length : 0 };
  return { ...base, reviewCriteriaCount: Array.isArray(a.reviewCriteria) ? a.reviewCriteria.length : 0, peerReview: !!a.peerReview };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Resultados de aprendizaje que trabaja el capítulo (claim + validación del servidor)
// ─────────────────────────────────────────────────────────────────────────────
export interface OutcomeRef { id: string; text: string }

/**
 * Resultados del capítulo, deterministas: los vínculos del capítulo al contexto académico (en práctica, la unión de los
 * del módulo); si no hay, los del perfil (saber hacer y competencias, ids LO-D1…/LO-C1…); si tampoco, el objetivo del
 * capítulo (id OBJ). Lo usan el claim (el generador cita estos ids) y el servidor (los valida).
 */
export function applicationOutcomeRefs(snapshot: any, chapterId: string): OutcomeRef[] {
  const mods: any[] = Array.isArray(snapshot?.modules) ? snapshot.modules : [];
  const mod = mods.find((m) => Array.isArray(m.chapters) && m.chapters.some((c: any) => c.id === chapterId));
  const ch = mod ? mod.chapters.find((c: any) => c.id === chapterId) : null;
  if (!ch) return [];
  const ac = snapshot?.course?.academicContext;
  const textOf = new Map<string, string>();
  if (ac) {
    for (const o of ac.outcomes ?? []) textOf.set(o.id, o.text);
    for (const o of ac.competencies ?? []) textOf.set(o.id, o.text);
  }
  const ids = new Set<string>();
  const add = (c: any) => { for (const x of Array.isArray(c?.outcomeIds) ? c.outcomeIds : []) if (textOf.has(x)) ids.add(x); };
  if (ch.kind === 'practice') for (const c of mod.chapters) { if (c.kind !== 'practice') add(c); }
  else add(ch);
  if (ids.size) return [...ids].sort().map((id) => ({ id, text: textOf.get(id)! }));
  const lo = snapshot?.course?.applicationContext?.learningOutcomes;
  const out: OutcomeRef[] = [];
  (Array.isArray(lo?.do) ? lo.do : []).forEach((t: unknown, i: number) => { if (typeof t === 'string' && t.trim()) out.push({ id: `LO-D${i + 1}`, text: t.trim() }); });
  (Array.isArray(lo?.competencies) ? lo.competencies : []).forEach((t: unknown, i: number) => { if (typeof t === 'string' && t.trim()) out.push({ id: `LO-C${i + 1}`, text: t.trim() }); });
  if (out.length) return out.slice(0, 8);
  const obj = typeof ch.objective === 'string' && ch.objective.trim() ? ch.objective.trim() : String(ch.title ?? '').trim();
  return [{ id: 'OBJ', text: obj }];
}

/**
 * r79.1 · Lo que el claim de un item application_activity agrega para su generador: el tipo («standard» o uno nuevo), los
 * resultados del capítulo y la especificación del nivel. Para los tipos nuevos, el ESQUEMA y las cantidades viajan en el
 * claim: el ejecutor valida con los mismos datos que el servidor (que igual re-valida, y es autoritativo).
 */
export function applicationClaimSpec(kind: string | null, minutes: number, snapshot: any, chapterId: string): Record<string, unknown> {
  const outcomes = applicationOutcomeRefs(snapshot, chapterId);
  if (!kind || kind === 'standard') return { kind: 'standard', outcomes, standardSpec: STANDARD_SPEC_V2[minutes] ?? null };
  const k = kind as ApplicationKind;
  // Lo que el generador necesita del módulo (del Blueprint congelado): los capítulos de contenido en los que se apoyan las
  // etapas del proyecto, y las Actividades de Aplicación anteriores del módulo que la retroalimentación revisa.
  const mods: any[] = Array.isArray(snapshot?.modules) ? snapshot.modules : [];
  const mod = mods.find((m) => Array.isArray(m.chapters) && m.chapters.some((c: any) => c.id === chapterId));
  const ordered = mod ? [...mod.chapters].sort((a: any, b: any) => a.position - b.position) : [];
  const at = ordered.findIndex((c: any) => c.id === chapterId);
  const moduleChapters = ordered.filter((c: any) => c.kind !== 'practice').map((c: any) => String(c.title));
  const reviewTargets = ordered.slice(0, Math.max(0, at)).filter((c: any) => typeof c.applicationMinutes === 'number')
    .map((c: any) => ({ chapterTitle: String(c.title), kindLabel: APPLICATION_KIND_LABEL[(c.applicationKind ?? 'standard') as ApplicationKindOrStandard] }));
  return {
    kind: k,
    outcomes,
    ...(k === 'integrative_project' ? { moduleChapters } : {}),
    ...(k === 'formative_feedback' ? { reviewTargets } : {}),
    kindSpec: {
      label: APPLICATION_KIND_LABEL[k],
      schema: APPLICATION_KIND_SCHEMAS[k],
      counts: (APPLICATION_KIND_COUNTS[k] as any)[minutes] ?? null,
      floors: APPLICATION_KIND_FLOORS[k][minutes] ?? {},
      sections: APPLICATION_KIND_SECTIONS[k],
      tolerance: KIND_MINUTES_TOLERANCE,
    },
  };
}

/** Etiqueta visible del tipo (con «Actividad de Aplicación» para la de siempre). */
export function applicationKindLabel(kind: unknown): string {
  return APPLICATION_KIND_LABEL[(typeof kind === 'string' && kind in APPLICATION_KIND_LABEL ? kind : 'standard') as ApplicationKindOrStandard];
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
