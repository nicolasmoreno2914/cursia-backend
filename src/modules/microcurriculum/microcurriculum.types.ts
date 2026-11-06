/**
 * r81 · «Crear microcurrículo» — tipos y límites (spec: validation/r81-microcurriculo/spec.md §1–§2).
 *
 * El docente responde un cuestionario de 7 pasos (`MicrocurriculumAnswers`); la IA devuelve, con una herramienta
 * forzada, el cuerpo del documento y el backend lo completa (identificación literal, horas totales, procedencia) hasta
 * `MicrocurriculumV1`. Un validador determinista (V1–V8) produce `MicrocurriculumIssue[]` visibles: nunca éxito
 * silencioso. Puro: sin DB, sin red, sin reloj.
 */

export const MICROCURRICULUM_VERSION = 1 as const;

export const INSTITUTION_TYPES = ['universidad', 'tecnica', 'etdh', 'colegio', 'corporativa', 'otro'] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];
/** r101 · Largo máximo del «¿Cuál?» cuando el tipo de institución es `otro`. */
export const INSTITUTION_OTHER_MAX = 80;

/**
 * r101 · Texto libre del tipo «Otro» («¿Cuál?»): sin caracteres de control, espacios colapsados, recortado a 80.
 * undefined si queda vacío o no es texto. Es DATO del docente: el prompt lo inserta citado (JSON), nunca como instrucción.
 */
export function cleanInstitutionOther(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, INSTITUTION_OTHER_MAX).trim();
  return s ? s : undefined;
}
export const MODALITIES = ['presencial', 'virtual', 'mixta'] as const;
export type Modality = (typeof MODALITIES)[number];
export const TIME_MODES = ['total', 'credits', 'weekly'] as const;
export type TimeMode = (typeof TIME_MODES)[number];
/** Estrategias didácticas del paso 6 (palabras literales del spec §1; el frontend las envía tal cual). */
export const STRATEGIES = ['proyectos', 'casos', 'talleres', 'magistral', 'aula invertida', 'ABP', 'laboratorio', 'salidas de campo'] as const;
export const REGEN_SECTIONS = ['outcomes', 'units', 'evaluation'] as const;
export type RegenSection = (typeof REGEN_SECTIONS)[number];
export const BLOOM = ['recordar', 'comprender', 'aplicar', 'analizar', 'evaluar', 'crear'] as const;
export type BloomEs = (typeof BLOOM)[number];
export const HOUR_KINDS = ['contact', 'practice', 'autonomous'] as const;
export type HourKind = (typeof HOUR_KINDS)[number];

/** Límites de entrada (spec §1) y de cardinalidad del documento (spec §2.1). */
export const MC_LIMITS = Object.freeze({
  text: 2000,
  listItems: 40,
  hoursMin: 1,
  hoursMax: 1000,
  /** Un crédito académico = 48 horas de trabajo del estudiante. */
  hoursPerCredit: 48,
  unitCountMin: 1,
  unitCountMax: 12,
  defaultUnitsMin: 3,
  defaultUnitsMax: 6,
  specificObjectivesMin: 2,
  specificObjectivesMax: 6,
  outcomesMin: 4,
  outcomesMax: 8,
  competenciesMax: 10,
  contentsPerUnitMax: 15,
  evaluationMin: 1,
  evaluationMax: 20,
  resourcesMax: 40,
  bibliographyMax: 40,
  /** Tolerancia de horas (V1) por total y por tipo. */
  hoursTolerance: 0.5,
  /** Granularidad del reparto automático de horas. */
  hoursStep: 0.5,
});

export interface MicrocurriculumAnswers {
  identification?: {
    courseName?: string;
    institutionType?: InstitutionType;
    /** r101 · Solo con `institutionType: 'otro'` (obligatorio entonces): «¿Cuál?», ≤ 80 caracteres. */
    institutionTypeOther?: string;
    program?: string;
    term?: string;
    modality?: Modality;
    code?: string;
    area?: string;
  };
  learners?: { profile?: string; priorKnowledge?: string; context?: string; specialNeeds?: string };
  purpose?: { need?: string; expectedAbilities?: string; competencies?: string };
  time?: {
    mode?: TimeMode;
    totalHours?: number;
    credits?: number;
    weeks?: number;
    hoursPerWeek?: number;
    split?: { contact?: number; practice?: number; autonomous?: number };
    calendar?: string;
  };
  contents?: { requiredTopics?: string[]; excludedTopics?: string[]; unitCount?: number };
  methodology?: { strategies?: string[]; institutionalEvaluation?: string; resources?: string };
  references?: { bibliography?: string[]; author?: string; notes?: string };
}

export interface McIdentification {
  courseName: string;
  institutionType: InstitutionType;
  /** r101 · Presente solo con `institutionType: 'otro'` (los demás tipos no llevan la clave: documentos idénticos). */
  institutionTypeOther?: string;
  program: string | null;
  term: string | null;
  modality: Modality | null;
  code: string | null;
  area: string | null;
}

export interface McOutcome {
  id: string;
  text: string;
  verb: string;
  bloom: BloomEs;
  condition: string;
  criterion: string;
}

export interface McCompetency { id: string; text: string }

export interface McHours { contact: number; practice: number; autonomous: number }

export interface McUnit {
  id: string;
  title: string;
  contents: string[];
  outcomeIds: string[];
  hours: McHours;
  weeks: { from: number; to: number } | null;
  strategy: string;
  mainActivity: string;
}

export interface McEvaluation {
  name: string;
  percent: number;
  outcomeIds: string[];
  week: number | null;
  evidence: string;
}

export type McOrigin = 'docente' | 'cursia';
/** Bibliografía: la del docente (literal) o sugerida por Cursia (sin ISBN/URL inventados; «verificar disponibilidad»). */
export interface McBibliography { text: string; origin: 'docente' | 'sugerida' }

/** Campos de primer nivel con procedencia (chip «Propuesto por Cursia» en la revisión). */
export const PROVENANCE_FIELDS = [
  'identification', 'description', 'justification', 'learnerProfile', 'priorKnowledge', 'generalObjective', 'specificObjectives',
  'outcomes', 'competencies', 'units', 'methodology', 'evaluation', 'resources', 'bibliography',
] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

export interface MicrocurriculumV1 {
  version: 1;
  identification: McIdentification;
  description: string;
  justification: string;
  learnerProfile: string;
  priorKnowledge: string;
  generalObjective: string;
  specificObjectives: string[];
  outcomes: McOutcome[];
  competencies: McCompetency[];
  units: McUnit[];
  totalHours: number;
  methodology: { text: string; strategies: string[] };
  evaluation: McEvaluation[];
  resources: string[];
  bibliography: McBibliography[];
  provenance: Record<ProvenanceField, McOrigin>;
  /** Reparaciones aritméticas aplicadas (registradas, nunca silenciosas). */
  repairs: string[];
}

export type IssueCode = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8';
export interface MicrocurriculumIssue {
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

/** Terminología por tipo de institución (D4: un solo formato con la terminología de cada contexto). */
export interface McTerminology {
  institutionLabel: string;
  outcomesLabel: string;
  outcomeSingular: string;
  learner: string;
  learnersPlural: string;
  course: string;
}

export const TERMINOLOGY: Readonly<Record<InstitutionType, McTerminology>> = Object.freeze({
  universidad: { institutionLabel: 'Universidad', outcomesLabel: 'Resultados de aprendizaje', outcomeSingular: 'resultado de aprendizaje', learner: 'estudiante', learnersPlural: 'estudiantes', course: 'asignatura' },
  tecnica: { institutionLabel: 'Institución técnica / tecnológica', outcomesLabel: 'Resultados de aprendizaje', outcomeSingular: 'resultado de aprendizaje', learner: 'estudiante', learnersPlural: 'estudiantes', course: 'asignatura' },
  etdh: { institutionLabel: 'SENA / Educación para el trabajo (ETDH)', outcomesLabel: 'Resultados de aprendizaje', outcomeSingular: 'resultado de aprendizaje', learner: 'aprendiz', learnersPlural: 'aprendices', course: 'programa de formación' },
  colegio: { institutionLabel: 'Colegio', outcomesLabel: 'Desempeños', outcomeSingular: 'desempeño', learner: 'estudiante', learnersPlural: 'estudiantes', course: 'asignatura' },
  corporativa: { institutionLabel: 'Formación corporativa', outcomesLabel: 'Resultados de aprendizaje', outcomeSingular: 'resultado de aprendizaje', learner: 'participante', learnersPlural: 'participantes', course: 'programa de formación' },
  /** r101 · El rótulo real es el «¿Cuál?» del docente (terminologyForIdentification); este es el respaldo. */
  otro: { institutionLabel: 'Otra institución', outcomesLabel: 'Resultados de aprendizaje', outcomeSingular: 'resultado de aprendizaje', learner: 'participante', learnersPlural: 'participantes', course: 'curso' },
});

export function terminologyFor(type: InstitutionType | null | undefined): McTerminology {
  return TERMINOLOGY[(type && (INSTITUTION_TYPES as readonly string[]).includes(type) ? type : 'universidad') as InstitutionType];
}

/**
 * r101 · Terminología a partir de la identificación (respuestas o documento): igual a terminologyFor(tipo), salvo `otro`,
 * cuyo institutionLabel es el «¿Cuál?» del docente (limpio) o «Otra institución» si falta.
 */
export function terminologyForIdentification(id: { institutionType?: InstitutionType | null; institutionTypeOther?: string | null } | null | undefined): McTerminology {
  const t = terminologyFor(id?.institutionType);
  if (id?.institutionType !== 'otro') return t;
  return { ...t, institutionLabel: cleanInstitutionOther(id.institutionTypeOther) || t.institutionLabel };
}

/** Las competencias son obligatorias si el docente las dio o el tipo de institución trabaja por competencias (colegio, corporativa y otro: solo si el docente las dio). */
export function competenciesRequired(answers: MicrocurriculumAnswers): boolean {
  const t = answers.identification?.institutionType;
  return !!(answers.purpose?.competencies && answers.purpose.competencies.trim()) || t === 'etdh' || t === 'tecnica' || t === 'universidad';
}

export const BLOOM_LABEL: Readonly<Record<BloomEs, string>> = Object.freeze({
  recordar: 'Recordar', comprender: 'Comprender', aplicar: 'Aplicar', analizar: 'Analizar', evaluar: 'Evaluar', crear: 'Crear',
});

export const MODALITY_LABEL: Readonly<Record<Modality, string>> = Object.freeze({ presencial: 'Presencial', virtual: 'Virtual', mixta: 'Mixta' });
