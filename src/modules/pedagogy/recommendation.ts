import { PedagogicalApproachDefinition, PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import { MAX_LIST_ITEMS, MAX_TEXT_LENGTH, PEDAGOGY_PROFILE_VERSION, PedagogicalProfile } from './pedagogy-profile';
import {
  AGE_GROUPS,
  ASSESSMENT_METHODS,
  AgeGroup,
  AssessmentMethod,
  EDUCATION_LEVELS,
  EXPERIENCE_LEVELS,
  EXPERIENCE_TYPES,
  EducationLevel,
  ExperienceLevel,
  ExperienceType,
  LEARNING_MODES,
  LearningMode,
  PRIORITY_ANSWERS,
  PRIOR_KNOWLEDGE_LEVELS,
  PriorKnowledgeLevel,
  PriorityAnswer,
  isOneOf,
  round2,
} from './vocabulary';

/**
 * Motor pedagógico V1 — «NO ESTOY SEGURO — AYÚDAME A ELEGIR».
 *
 * Seis preguntas fijas → recomendación ordenada con porcentaje y razones +
 * un perfil pedagógico sugerido (borrador). NUNCA genera un curso ni llama a
 * ningún proveedor: es puntaje determinístico sobre la `affinity` de cada
 * enfoque del registro (un enfoque nuevo trae su propia afinidad y entra en la
 * recomendación sin tocar este archivo).
 */

// ── Las 6 preguntas (fuente única: la UI las pide al backend) ───────────────

export interface WizardOption {
  id: string;
  label: string;
}

export interface WizardQuestion {
  id: 'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'q6';
  title: string;
  help: string;
  kind: 'learner' | 'outcomes' | 'multi' | 'priority';
  options?: WizardOption[];
  fields?: { id: string; label: string; kind: 'text' | 'select' | 'list'; options?: WizardOption[] }[];
}

const L = (id: string, label: string): WizardOption => ({ id, label });

export const WIZARD_QUESTIONS: readonly WizardQuestion[] = Object.freeze([
  {
    id: 'q1', kind: 'learner', title: '¿Quiénes son los estudiantes?',
    help: 'Edad, nivel educativo, perfil, conocimientos previos y experiencia.',
    fields: [
      { id: 'description', label: 'Perfil (quiénes son, a qué se dedican)', kind: 'text' },
      { id: 'ageGroup', label: 'Edad', kind: 'select', options: [L('children', 'Niños'), L('teens', 'Adolescentes'), L('adults', 'Adultos'), L('mixed', 'Grupo mixto')] },
      { id: 'educationLevel', label: 'Nivel educativo', kind: 'select', options: [L('basic', 'Básica'), L('secondary', 'Media / secundaria'), L('technical', 'Técnica / tecnológica'), L('university', 'Universitaria'), L('professional', 'Profesionales en ejercicio')] },
      { id: 'priorKnowledge', label: 'Conocimientos previos del tema', kind: 'select', options: [L('none', 'Ninguno'), L('basic', 'Básicos'), L('intermediate', 'Intermedios'), L('advanced', 'Avanzados')] },
      { id: 'experience', label: 'Experiencia práctica en el tema', kind: 'select', options: [L('none', 'Ninguna'), L('some', 'Algo de experiencia'), L('extensive', 'Mucha experiencia')] },
    ],
  },
  {
    id: 'q2', kind: 'outcomes', title: '¿Qué quieres que logren al finalizar el curso?',
    help: 'Qué deben saber, saber hacer y qué competencias deben desarrollar.',
    fields: [
      { id: 'know', label: 'Qué deben saber', kind: 'list' },
      { id: 'do', label: 'Qué deben saber hacer', kind: 'list' },
      { id: 'competencies', label: 'Qué competencias deben desarrollar', kind: 'list' },
    ],
  },
  {
    id: 'q3', kind: 'multi', title: '¿Cómo quieres que aprendan principalmente?', help: 'Puedes elegir varias.',
    options: [
      L('concepts', 'Comprendiendo conceptos y teorías'), L('problems', 'Resolviendo problemas o casos'), L('projects', 'Desarrollando proyectos'),
      L('practice', 'Practicando y experimentando'), L('inquiry', 'Investigando y descubriendo'), L('collaborative', 'Trabajando colaborativamente'),
      L('real_application', 'Aplicando lo aprendido a situaciones reales'), L('combination', 'Combinación'),
    ],
  },
  {
    id: 'q4', kind: 'multi', title: '¿Qué tipo de experiencia quieres que tenga el estudiante?', help: 'Puedes elegir varias.',
    options: [
      L('autonomous', 'Principalmente autónoma'), L('teacher_guided', 'Guiada por el docente'), L('interactive_collaborative', 'Basada en interacción y colaboración'),
      L('practice_experimentation', 'Basada en práctica y experimentación'), L('challenges', 'Basada en retos o problemas'), L('combination', 'Combinación'),
    ],
  },
  {
    id: 'q5', kind: 'multi', title: '¿Cómo quieres comprobar que aprendió?', help: 'Puedes elegir varias.',
    options: [
      L('quizzes', 'Pruebas o cuestionarios'), L('practical_exercises', 'Ejercicios prácticos'), L('cases', 'Casos o problemas'), L('projects', 'Proyectos'),
      L('products_evidence', 'Productos o evidencias'), L('self_reflection', 'Autoevaluación y reflexión'), L('peer', 'Evaluación entre compañeros'), L('combination', 'Combinación'),
    ],
  },
  {
    id: 'q6', kind: 'priority', title: '¿Hay alguna metodología, enfoque o principio pedagógico que quieras priorizar?', help: 'Si respondes «Sí», elige los enfoques o escribe el principio.',
    options: [L('yes', 'Sí'), L('no', 'No'), L('unsure', 'No estoy seguro')],
  },
]);

// ── Respuestas ───────────────────────────────────────────────────────────────

export interface WizardAnswers {
  q1: { description: string | null; ageGroup: AgeGroup | null; educationLevel: EducationLevel | null; priorKnowledge: PriorKnowledgeLevel | null; experience: ExperienceLevel | null };
  q2: { know: string[]; do: string[]; competencies: string[] };
  q3: LearningMode[];
  q4: ExperienceType[];
  q5: AssessmentMethod[];
  q6: { answer: PriorityAnswer | null; approaches: string[]; principles: string[] };
}

export interface WizardValidationError {
  path: string;
  code: string;
  message: string;
}

/** Normaliza respuestas parciales (todo campo ausente = sin respuesta) y valida opciones. */
export function normalizeWizardAnswers(
  input: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): { answers: WizardAnswers; errors: WizardValidationError[] } {
  const errors: WizardValidationError[] = [];
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message });
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, any>;
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) err('', 'INVALID_TYPE', 'Las respuestas deben ser un objeto');
  for (const k of Object.keys(o)) if (!['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].includes(k)) err(k, 'UNKNOWN_FIELD', `Pregunta desconocida "${k}"`);

  const text = (v: unknown, path: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') { err(path, 'INVALID_TEXT', `${path} debe ser texto`); return null; }
    const t = v.replace(/\s+/g, ' ').trim();
    if (t.length > MAX_TEXT_LENGTH) err(path, 'TEXT_TOO_LONG', `${path} supera ${MAX_TEXT_LENGTH} caracteres`);
    return t || null;
  };
  const list = (v: unknown, path: string): string[] => {
    if (v === undefined || v === null || v === '') return [];
    // Se acepta un texto con saltos de línea (lo que escribe la UI) o un array.
    const arr = typeof v === 'string' ? v.split(/\n+/) : Array.isArray(v) ? v : (err(path, 'INVALID_TYPE', `${path} debe ser una lista`), []);
    const out = arr.map((x: unknown, i: number) => text(x, `${path}[${i}]`)).filter((x: string | null): x is string => !!x);
    if (out.length > MAX_LIST_ITEMS) err(path, 'TOO_MANY_ITEMS', `${path}: como máximo ${MAX_LIST_ITEMS} elementos`);
    return out;
  };
  const one = <T extends string>(v: unknown, allowed: readonly T[], path: string): T | null => {
    if (v === undefined || v === null || v === '') return null;
    if (!isOneOf(allowed, v)) { err(path, 'INVALID_OPTION', `${path}: opción desconocida ${JSON.stringify(v)}`); return null; }
    return v;
  };
  const many = <T extends string>(v: unknown, allowed: readonly T[], path: string): T[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { err(path, 'INVALID_TYPE', `${path} debe ser una lista de opciones`); return []; }
    const bad = v.filter((x) => !isOneOf(allowed, x));
    for (const b of bad) err(path, 'INVALID_OPTION', `${path}: opción desconocida ${JSON.stringify(b)}`);
    return allowed.filter((x) => v.includes(x));
  };

  // Review M2: q1/q2/q6 presentes pero sin forma de objeto fallan fuerte (como q3–q5), nunca se ignoran.
  const asObj = (k: 'q1' | 'q2' | 'q6'): Record<string, any> => {
    const v = o[k];
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) { err(k, 'INVALID_TYPE', `${k} debe ser un objeto`); return {}; }
    return v;
  };
  const q1 = asObj('q1');
  const q2 = asObj('q2');
  const q6 = asObj('q6');
  if (q6.approaches !== undefined && q6.approaches !== null && (!Array.isArray(q6.approaches) || q6.approaches.some((x: unknown) => typeof x !== 'string'))) {
    err('q6.approaches', 'INVALID_TYPE', 'q6.approaches debe ser una lista de ids de enfoque');
  }
  const q6Approaches: string[] = Array.isArray(q6.approaches) ? q6.approaches.filter((x: unknown) => typeof x === 'string') : [];
  for (const a of q6Approaches) if (!registry.has(a)) err('q6.approaches', 'UNKNOWN_APPROACH', `Enfoque desconocido: ${JSON.stringify(a)}`);
  const answers: WizardAnswers = {
    q1: {
      description: text(q1.description, 'q1.description'),
      ageGroup: one(q1.ageGroup, AGE_GROUPS, 'q1.ageGroup'),
      educationLevel: one(q1.educationLevel, EDUCATION_LEVELS, 'q1.educationLevel'),
      priorKnowledge: one(q1.priorKnowledge, PRIOR_KNOWLEDGE_LEVELS, 'q1.priorKnowledge'),
      experience: one(q1.experience, EXPERIENCE_LEVELS, 'q1.experience'),
    },
    q2: { know: list(q2.know, 'q2.know'), do: list(q2.do, 'q2.do'), competencies: list(q2.competencies, 'q2.competencies') },
    q3: many(o.q3, LEARNING_MODES, 'q3'),
    q4: many(o.q4, EXPERIENCE_TYPES, 'q4'),
    q5: many(o.q5, ASSESSMENT_METHODS, 'q5'),
    q6: {
      answer: one(q6.answer, PRIORITY_ANSWERS, 'q6.answer'),
      approaches: registry.ids().filter((id) => q6Approaches.includes(id)),
      principles: list(q6.principles, 'q6.principles'),
    },
  };
  if (answers.q6.answer !== 'yes' && (answers.q6.approaches.length > 0 || answers.q6.principles.length > 0)) {
    err('q6', 'PRIORITY_WITHOUT_YES', 'Para priorizar un enfoque o principio, responde «Sí» en la pregunta 6');
  }
  return { answers, errors };
}

// ── Puntaje ──────────────────────────────────────────────────────────────────

/** Peso de cada pregunta en el puntaje (suman 1). La 6 suma un refuerzo aparte. */
export const QUESTION_WEIGHTS = Object.freeze({ q1: 0.1, q2: 0.15, q3: 0.3, q4: 0.2, q5: 0.25 });
/**
 * P6 «Sí» + enfoques elegidos: el docente decidió. Esos enfoques van PRIMERO en el ranking (entre
 * ellos, por puntaje) y su puntaje sube PRIORITY_BOOST (tope 100); el resto conserva su orden.
 */
export const PRIORITY_BOOST = 0.25;
/** Afinidad neutra cuando una pregunta no se respondió (o se respondió «Combinación» sola). */
export const NEUTRAL_AFFINITY = 0.5;

export interface RecommendationReason {
  question: string;
  text: string;
  contribution: number;
}

export interface ApproachRecommendation {
  approach: string;
  label: string;
  summary: string;
  score: number; // 0..100 — encaje con las respuestas (P1–P5) + refuerzo de P6
  /** P6 «Sí»: el docente lo eligió; va primero aunque otro enfoque encaje más con el resto de respuestas. */
  prioritized: boolean;
  reasons: RecommendationReason[];
}

export interface PedagogyRecommendation {
  ranking: ApproachRecommendation[];
  confidence: 'alta' | 'media' | 'baja';
  answered: number;
  notes: string[];
  suggestedProfile: PedagogicalProfile;
}

/** Etiqueta de una opción. En P1 los ids se repiten entre campos («basic», «none»): se busca DENTRO del campo. */
const optionLabel = (q: string, id: string, field?: string): string => {
  const question = WIZARD_QUESTIONS.find((x) => x.id === q);
  if (field) return question?.fields?.find((f) => f.id === field)?.options?.find((o) => o.id === id)?.label ?? id;
  return question?.options?.find((o) => o.id === id)?.label ?? id;
};

function meanAffinity<T extends string>(chosen: readonly T[], map: Partial<Record<T, number>>): { value: number; best: T | null } {
  const real = chosen.filter((c) => c !== ('combination' as T));
  if (real.length === 0) return { value: NEUTRAL_AFFINITY, best: null };
  let sum = 0;
  let best: T | null = null;
  for (const c of real) {
    const v = map[c] ?? 0;
    sum += v;
    if (best === null || v > (map[best] ?? 0)) best = c;
  }
  return { value: sum / real.length, best };
}

function scoreApproach(a: PedagogicalApproachDefinition, ans: WizardAnswers): { score: number; reasons: RecommendationReason[] } {
  const reasons: RecommendationReason[] = [];
  let score = 0;

  // P1 — estudiante: promedio de las afinidades respondidas.
  const q1Parts: { v: number; text: string }[] = [];
  if (ans.q1.priorKnowledge) q1Parts.push({ v: a.affinity.priorKnowledge[ans.q1.priorKnowledge] ?? 0, text: `Conocimientos previos: ${optionLabel('q1', ans.q1.priorKnowledge, 'priorKnowledge').toLowerCase()}` });
  if (ans.q1.experience) q1Parts.push({ v: a.affinity.experience[ans.q1.experience] ?? 0, text: `Experiencia práctica: ${optionLabel('q1', ans.q1.experience, 'experience').toLowerCase()}` });
  if (ans.q1.ageGroup) q1Parts.push({ v: a.affinity.ageGroups[ans.q1.ageGroup] ?? 0, text: `Edad: ${optionLabel('q1', ans.q1.ageGroup, 'ageGroup').toLowerCase()}` });
  const q1v = q1Parts.length ? q1Parts.reduce((s, p) => s + p.v, 0) / q1Parts.length : NEUTRAL_AFFINITY;
  score += QUESTION_WEIGHTS.q1 * q1v;
  const q1best = [...q1Parts].sort((x, y) => y.v - x.v)[0];
  if (q1best && q1best.v >= 0.7) reasons.push({ question: 'q1', text: q1best.text, contribution: round2(QUESTION_WEIGHTS.q1 * q1v) });

  // P2 — resultados: balance saber / saber hacer / competencias (por cantidad de resultados escritos).
  const nK = ans.q2.know.length, nD = ans.q2.do.length, nC = ans.q2.competencies.length;
  const total = nK + nD + nC;
  const q2v = total === 0 ? NEUTRAL_AFFINITY : (nK * a.affinity.outcomes.know + nD * a.affinity.outcomes.do + nC * a.affinity.outcomes.competencies) / total;
  score += QUESTION_WEIGHTS.q2 * q2v;
  if (total > 0 && q2v >= 0.7) {
    const dominant = nD >= nK && nD >= nC ? 'saber hacer' : nC >= nK ? 'desarrollar competencias' : 'saber';
    reasons.push({ question: 'q2', text: `Los resultados esperados se centran en «${dominant}»`, contribution: round2(QUESTION_WEIGHTS.q2 * q2v) });
  }

  // P3–P5 — opciones múltiples.
  const multi: { q: 'q3' | 'q4' | 'q5'; chosen: readonly string[]; map: Record<string, number> }[] = [
    { q: 'q3', chosen: ans.q3, map: a.affinity.learningModes as Record<string, number> },
    { q: 'q4', chosen: ans.q4, map: a.affinity.experienceTypes as Record<string, number> },
    { q: 'q5', chosen: ans.q5, map: a.affinity.assessmentMethods as Record<string, number> },
  ];
  for (const m of multi) {
    const r = meanAffinity(m.chosen, m.map);
    score += QUESTION_WEIGHTS[m.q] * r.value;
    if (r.best && (m.map[r.best] ?? 0) >= 0.7) {
      reasons.push({ question: m.q, text: `Elegiste «${optionLabel(m.q, r.best)}»`, contribution: round2(QUESTION_WEIGHTS[m.q] * r.value) });
    }
  }

  // P6 — prioridad explícita.
  if (ans.q6.answer === 'yes' && ans.q6.approaches.includes(a.id)) {
    score += PRIORITY_BOOST;
    reasons.push({ question: 'q6', text: 'Lo marcaste como enfoque a priorizar', contribution: PRIORITY_BOOST });
  }
  reasons.sort((x, y) => y.contribution - x.contribution || x.question.localeCompare(y.question));
  return { score: Math.min(1, score), reasons: reasons.slice(0, 3) };
}

export function recommendApproaches(
  input: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): PedagogyRecommendation {
  const { answers, errors } = normalizeWizardAnswers(input, registry);
  if (errors.length > 0) {
    throw new Error(`WIZARD_INVALID: ${errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const prioritized = (id: string) => (answers.q6.answer === 'yes' && answers.q6.approaches.includes(id) ? 1 : 0);
  const ranking: ApproachRecommendation[] = registry
    .list()
    .map((a, idx) => {
      const r = scoreApproach(a, answers);
      return { a, idx, ...r };
    })
    .sort((x, y) => prioritized(y.a.id) - prioritized(x.a.id) || Math.round(y.score * 100) - Math.round(x.score * 100) || x.idx - y.idx)
    .map(({ a, score, reasons }) => ({
      approach: a.id,
      label: a.label,
      summary: a.summary,
      score: Math.round(score * 100),
      prioritized: prioritized(a.id) === 1,
      reasons: reasons.length ? reasons : [{ question: '-', text: 'Encaje general con tus respuestas', contribution: 0 }],
    }));

  const answered = [
    answers.q1.priorKnowledge || answers.q1.experience || answers.q1.ageGroup || answers.q1.educationLevel || answers.q1.description,
    answers.q2.know.length + answers.q2.do.length + answers.q2.competencies.length > 0,
    answers.q3.length > 0,
    answers.q4.length > 0,
    answers.q5.length > 0,
    answers.q6.answer !== null,
  ].filter(Boolean).length;
  const gap = ranking.length > 1 ? ranking[0].score - ranking[1].score : 100;
  const confidence: PedagogyRecommendation['confidence'] = answered >= 5 && gap >= 8 ? 'alta' : answered >= 3 ? 'media' : 'baja';

  const notes: string[] = [];
  if (answered < 3) notes.push('Respondiste pocas preguntas: la recomendación es orientativa. Completa más respuestas para afinarla.');
  if (answers.q3.includes('collaborative') || answers.q4.includes('interactive_collaborative') || answers.q5.includes('peer')) {
    notes.push('La colaboración y la evaluación entre compañeros dependen del docente en Moodle (foro y talleres): Cursia las sugiere, no las automatiza.');
  }
  if (answers.q3.includes('projects') || answers.q5.includes('projects')) {
    // Desde los datos de cada enfoque (afinidad con «proyectos»), nunca por nombre.
    const best = registry
      .list()
      .map((a) => ({ a, v: Math.max(a.affinity.learningModes.projects ?? 0, a.affinity.assessmentMethods.projects ?? 0) }))
      .sort((x, y) => y.v - x.v)
      .slice(0, 2)
      .map((x) => x.a.label.toLowerCase());
    notes.push(`Cursia no genera proyectos completos: los estructura como problemas y evidencias por capítulo (mejor encaje: ${best.join(' o ')}).`);
  }

  // Perfil sugerido: el primero como principal; secundarios a ≤ 12 puntos del primero y ≥ 55 %.
  const top = ranking[0];
  // Review M3: los otros enfoques priorizados en P6 siempre entran como secundarios (decisión del docente);
  // después, los que encajan casi igual que el primero (≥ 55 % y a ≤ 12 puntos).
  const secondaries = [
    ...ranking.slice(1).filter((r) => r.prioritized),
    ...ranking.slice(1).filter((r) => !r.prioritized && r.score >= 55 && top.score - r.score <= 12),
  ].slice(0, 2).map((r) => r.approach);
  const suggestedProfile: PedagogicalProfile = {
    pedagogyProfileVersion: PEDAGOGY_PROFILE_VERSION,
    primaryApproach: top.approach,
    secondaryApproaches: secondaries,
    learner: { ...answers.q1 },
    learningOutcomes: { know: [...answers.q2.know], do: [...answers.q2.do], competencies: [...answers.q2.competencies] },
    learningModes: answers.q3.filter((x) => x !== 'combination'),
    experienceTypes: answers.q4.filter((x) => x !== 'combination'),
    assessmentMethods: answers.q5.filter((x) => x !== 'combination'),
    principles: [...answers.q6.principles],
    origin: 'wizard',
  };
  return { ranking, confidence, answered, notes, suggestedProfile };
}
