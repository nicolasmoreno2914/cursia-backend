import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { AcademicBlueprintOutcome } from './blueprint-academic';
import { sortOutcomeIds } from './blueprint-academic';

/**
 * Fase 3 · Loop 3.5 — resultados de aprendizaje que cada item del Manifest debe evidenciar, leídos del Blueprint
 * CONGELADO (course.academicContext + chapter.outcomeIds), y su bloque para el prompt del generador. Lo arma el
 * backend dentro del brief pedagógico del claim (fuente única del texto): el ejecutor del navegador no cambia.
 *
 *   capítulo (content, experience, activity, video_interactions, application_activity) → sus vínculos; un capítulo de
 *     práctica sin vínculos propios integra los de los capítulos de contenido de su módulo
 *   module_intro / exam (módulo) → unión de los vínculos de sus capítulos
 *   course_plan / course_intro / final_exam → todos los vínculos del curso
 *   presentation / video (proveedores) / audio → nada (su texto sale del contenido, que ya los trabaja)
 *
 * Puro y determinista. Sin contexto académico o sin vínculos → [] (el brief queda exactamente como antes).
 */

export const ALIGNMENT_PROMPT_MARKER = 'RESULTADOS DE APRENDIZAJE QUE ESTE RECURSO DEBE EVIDENCIAR';
/** Tope de resultados listados en un prompt (los demás se resumen en una línea). */
export const ALIGNMENT_MAX_OUTCOMES = 8;
export const ALIGNMENT_TEXT_MAX = 200;

export interface AlignmentItemRef {
  type: string;
  moduleId?: string | null;
  chapterId: string | null;
}

export interface ItemOutcome {
  id: string;
  text: string;
  /** 'competency' para CO…; nivel de Bloom (o null) para RA…. */
  level: string | null;
  domain: 'know' | 'do' | 'competency';
}

const CHAPTER_TYPES = new Set(['content', 'experience', 'activity', 'video_interactions', 'application_activity']);

function chapterLinks(snapshot: BlueprintSnapshotV2, chapterId: string): string[] {
  for (const m of snapshot.modules) {
    const c = m.chapters.find((x) => x.id === chapterId);
    if (!c) continue;
    if (c.outcomeIds?.length) return c.outcomeIds;
    if (c.kind === 'practice') {
      return sortOutcomeIds([...new Set(m.chapters.filter((x) => x.kind !== 'practice').flatMap((x) => x.outcomeIds ?? []))]);
    }
    return [];
  }
  return [];
}

/** Ids de los resultados que el item debe evidenciar (orden RA → CO, por número). */
export function itemOutcomeIds(snapshot: BlueprintSnapshotV2, item: AlignmentItemRef): string[] {
  if (!snapshot.course.academicContext) return [];
  if (CHAPTER_TYPES.has(item.type) && item.chapterId) return chapterLinks(snapshot, item.chapterId);
  if ((item.type === 'exam' || item.type === 'module_intro') && item.moduleId) {
    const m = snapshot.modules.find((x) => x.id === item.moduleId);
    return m ? sortOutcomeIds([...new Set(m.chapters.flatMap((c) => c.outcomeIds ?? []))]) : [];
  }
  if (item.type === 'course_plan' || item.type === 'course_intro' || item.type === 'final_exam') {
    return sortOutcomeIds([...new Set(snapshot.modules.flatMap((m) => m.chapters.flatMap((c) => c.outcomeIds ?? [])))]);
  }
  return [];
}

export function itemOutcomes(snapshot: BlueprintSnapshotV2, item: AlignmentItemRef): ItemOutcome[] {
  const ctx = snapshot.course.academicContext;
  if (!ctx) return [];
  const byId = new Map<string, ItemOutcome>([
    ...ctx.outcomes.map((o: AcademicBlueprintOutcome) => [o.id, { id: o.id, text: o.text, level: o.level, domain: o.domain }] as [string, ItemOutcome]),
    ...ctx.competencies.map((c) => [c.id, { id: c.id, text: c.text, level: null, domain: 'competency' }] as [string, ItemOutcome]),
  ]);
  return itemOutcomeIds(snapshot, item).map((id) => byId.get(id)).filter((x): x is ItemOutcome => !!x);
}

const LEVEL_TEXT: Record<string, string> = {
  remember: 'recordar', understand: 'comprender', apply: 'aplicar', analyze: 'analizar', evaluate: 'evaluar', create: 'crear',
};
const DOMAIN_TEXT: Record<ItemOutcome['domain'], string> = { know: 'saber', do: 'saber hacer', competency: 'competencia' };

/** Qué hace cada generador con los resultados (dentro de las reglas del pedido). */
const GENERATOR_INSTRUCTION: Record<string, string> = {
  course_plan: 'El plan de conceptos debe cubrir todos estos resultados; ningún resultado queda sin conceptos que lo preparen.',
  course_intro: 'Presenta estos resultados como lo que el estudiante logrará en el curso, con sus palabras (sin copiar los códigos).',
  module_intro: 'Presenta estos resultados como lo que el estudiante logrará en el módulo, con sus palabras (sin copiar los códigos).',
  content: 'Desarrolla los conceptos, procedimientos y ejemplos que el estudiante necesita para lograr estos resultados; cada sección debe aportar a alguno.',
  experience: 'Las preguntas y actividades de la experiencia deben apuntar a estos resultados.',
  video_interactions: 'Las preguntas del video deben comprobar estos resultados.',
  activity: 'La actividad debe producir evidencia observable de estos resultados; para los de saber hacer, el estudiante debe aplicar o decidir, no solo recordar.',
  branching_scenario: 'Las decisiones del escenario deben exigir los desempeños de estos resultados.',
  scorm_activity: 'Las salas deben exigir los desempeños de estos resultados.',
  application_activity: 'La actividad de aplicación y su producto deben evidenciar estos resultados, y sus criterios de evaluación deben referirse a ellos.',
  exam: 'Cubre cada resultado con al menos una pregunta; para los de saber hacer (aplicar, analizar, evaluar, crear) usa situaciones o casos que exijan aplicarlo, no solo definiciones.',
  final_exam: 'Cubre cada resultado con al menos una pregunta; para los de saber hacer (aplicar, analizar, evaluar, crear) usa situaciones o casos que exijan aplicarlo, no solo definiciones.',
};

/** ¿El generador recibe el bloque? (proveedores y audio no). */
export function generatorTakesAlignment(gen: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENERATOR_INSTRUCTION, gen);
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/**
 * Bloque del prompt (sin el encabezado pedagógico: lo agrega el brief). `maxChars` acota el bloque completo: si no
 * entra, se listan menos resultados y una línea dice cuántos faltan (nunca se corta a mitad de línea).
 */
export function renderAlignmentBlock(gen: string, outcomes: ItemOutcome[], maxChars = 2000): string {
  if (!outcomes.length || !generatorTakesAlignment(gen)) return '';
  const lines = outcomes.map((o) => `- ${o.id} (${DOMAIN_TEXT[o.domain]}${o.level && LEVEL_TEXT[o.level] ? ` · ${LEVEL_TEXT[o.level]}` : ''}): ${clip(o.text, ALIGNMENT_TEXT_MAX)}`);
  const head = `── ${ALIGNMENT_PROMPT_MARKER} ──`;
  const instr = GENERATOR_INSTRUCTION[gen];
  for (let n = Math.min(lines.length, ALIGNMENT_MAX_OUTCOMES); n >= 1; n--) {
    const rest = outcomes.length - n;
    const text = [head, ...lines.slice(0, n), ...(rest > 0 ? [`- (y ${rest} resultado(s) más del curso)`] : []), instr].join('\n');
    if (text.length <= maxChars) return text;
  }
  return '';
}
