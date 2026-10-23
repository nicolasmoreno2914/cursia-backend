import { bloomLevelOf, isPerformanceLevel } from '../academic-context/bloom';
import { MAX_LIST_ITEMS } from '../pedagogy/pedagogy-profile';
import { PedagogyRecommendation, recommendApproaches } from '../pedagogy/recommendation';
import { TARGET_HOURS_MAX } from '../study-time/target-hours';

/**
 * LOOP 8.3 · «Cursia recomienda» — lo que Cursia decide sin preguntar. Puro: sin DB, sin red, sin proveedores.
 *
 *  - Enfoque pedagógico: el recomendador de siempre (6 preguntas) con respuestas INFERIDAS de lo que ya sabemos — el
 *    estudiante (nivel, previos) y los resultados de aprendizaje (saber / saber hacer por su verbo, Bloom). Nunca se
 *    inventa una preferencia de metodología (P6 queda sin responder).
 *  - Horas: si el curso no tiene meta (ni del docente ni del documento), Cursia propone las de su diseño base
 *    redondeadas a múltiplos de 8 (conveniencia de la recomendación automática); una meta explícita NUNCA se redondea.
 */

export interface InferenceInput {
  learner: { educationLevel?: string | null; priorKnowledge?: string | null; description?: string | null } | null;
  /** Textos de los resultados de aprendizaje (del contexto académico o del perfil). */
  outcomes: string[];
  competencies: string[];
}

export interface InferredAnswers {
  answers: Record<string, unknown>;
  /** Por qué se infirió cada respuesta (se muestra como razón de la recomendación). */
  basis: string[];
  doShare: number | null;
}

/** Respuestas del asistente inferidas de lo que ya sabemos del curso (solo P1–P5; P6 sin respuesta). */
export function inferWizardAnswers(input: InferenceInput): InferredAnswers {
  const basis: string[] = [];
  const learner = input.learner || {};
  const know: string[] = [];
  const doo: string[] = [];
  for (const t of input.outcomes) (isPerformanceLevel(bloomLevelOf(t)) ? doo : know).push(t);
  const total = know.length + doo.length;
  const doShare = total ? doo.length / total : null;
  const answers: Record<string, any> = {
    q1: {
      ...(learner.educationLevel ? { educationLevel: learner.educationLevel } : {}),
      ...(learner.priorKnowledge ? { priorKnowledge: learner.priorKnowledge } : {}),
    },
    // Review 8.6C (documentos reales): el asistente admite como mucho MAX_LIST_ITEMS por lista; un documento con más
    // resultados (p. ej. una propuesta de varios cursos) hacía fallar «Cursia recomienda». La proporción saber/hacer
    // se calcula con TODOS los resultados (arriba); a las respuestas van los primeros de cada lista.
    q2: { know: know.slice(0, MAX_LIST_ITEMS), do: doo.slice(0, MAX_LIST_ITEMS), competencies: input.competencies.slice(0, MAX_LIST_ITEMS) },
  };
  if (doShare === null) return { answers, basis, doShare };
  if (doShare >= 0.6) {
    answers.q3 = ['practice', 'real_application'];
    answers.q4 = ['practice_experimentation', 'challenges'];
    answers.q5 = ['practical_exercises', 'cases'];
    basis.push(`${doo.length} de ${total} resultados piden hacer (aplicar, resolver, elaborar), no solo saber`);
  } else if (doShare <= 0.34) {
    answers.q3 = ['concepts'];
    answers.q4 = ['autonomous'];
    answers.q5 = ['quizzes'];
    basis.push(`${know.length} de ${total} resultados piden comprender o explicar`);
  } else {
    answers.q3 = ['concepts', 'practice'];
    answers.q4 = ['autonomous', 'practice_experimentation'];
    answers.q5 = ['quizzes', 'practical_exercises'];
    basis.push(`los resultados combinan saber (${know.length}) y saber hacer (${doo.length})`);
  }
  return { answers, basis, doShare };
}

export interface ApproachSuggestion {
  approach: string;
  label: string;
  reasons: string[];
  score: number;
  confidence: PedagogyRecommendation['confidence'];
}

/** Enfoque recomendado (el primero del ranking), con razones en lenguaje del docente. null sin resultados. */
export function recommendApproachFromFacts(input: InferenceInput): ApproachSuggestion | null {
  const inf = inferWizardAnswers(input);
  if (inf.doShare === null) return null;
  const rec = recommendApproaches(inf.answers);
  const top = rec.ranking[0];
  if (!top) return null;
  return {
    approach: top.approach,
    label: top.label,
    reasons: [...inf.basis, ...top.reasons.filter((r) => r.question !== 'q3' && r.question !== 'q4' && r.question !== 'q5' && r.question !== '-').map((r) => r.text)].slice(0, 3),
    score: top.score,
    confidence: rec.confidence,
  };
}

/**
 * Horas propuestas por Cursia: las del diseño base (la estructura, sin Actividades de Aplicación) llevadas al múltiplo de
 * 8 siguiente (mínimo 8). Hacia arriba: una meta por debajo de la estructura mínima obligaría a recortar contenido, y
 * Cursia nunca recorta por su cuenta; lo que falta lo completa el diseño con aplicación y práctica.
 */
export function proposeTargetHours(baseHours: number): { value: number; base: number; reason: string } {
  const b = Number.isFinite(baseHours) && baseHours > 0 ? baseHours : 8;
  const value = Math.min(TARGET_HOURS_MAX, Math.max(8, Math.ceil(b / 8) * 8));
  const fmt = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
  return { value, base: Math.round(b * 10) / 10, reason: `Los contenidos del curso suman ≈ ${fmt(b)} h de trabajo del estudiante: Cursia propone ${value} h y completa el resto con aplicación y práctica.` };
}
