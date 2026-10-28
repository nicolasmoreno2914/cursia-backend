// r79.1 · Tipos de Actividad de Aplicación — fuente ÚNICA de los tipos, sus niveles de minutos y dónde van.
//
// Un capítulo con Actividad de Aplicación (application_minutes) puede llevar además un TIPO (application_kind):
//   - case_study          estudio de caso (capítulo de CONTENIDO): caso con anexos, preguntas de análisis graduadas,
//                         decisión con restricciones y justificación;
//   - integrative_project proyecto integrador por etapas (capítulo de PRÁCTICA): etapas ligadas a los capítulos del
//                         módulo, entregable intermedio por etapa, producto final e integración;
//   - formative_feedback  retroalimentación formativa (capítulo de PRÁCTICA, después de una práctica evaluable del
//                         módulo): criterios de revisión, ejemplar comentado, errores frecuentes, plan de mejora,
//                         revisión entre pares (60/90 min) y reflexión.
// Sin tipo = la Actividad de Aplicación de siempre («standard»). El tipo NO cambia los minutos: solo los acepta si son
// uno de SUS niveles (cada nivel tiene su especificación de trabajo; ver course-shell/application-kinds.ts).
//
// Sin dependencias para que el Blueprint, el Manifest y el modelo de tiempo lo importen sin ciclos.
import { APPLICATION_ACTIVITY_TIERS } from './application-tiers';

export const APPLICATION_KINDS = Object.freeze(['case_study', 'integrative_project', 'formative_feedback'] as const);
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];
/** Tipo efectivo (incluye la Actividad de siempre). */
export type ApplicationKindOrStandard = ApplicationKind | 'standard';

export const APPLICATION_KIND_LABEL: Readonly<Record<ApplicationKindOrStandard, string>> = Object.freeze({
  standard: 'Actividad de Aplicación',
  case_study: 'Estudio de caso',
  integrative_project: 'Proyecto integrador',
  formative_feedback: 'Retroalimentación formativa',
});

/** Niveles de minutos de cada tipo (subconjunto de APPLICATION_ACTIVITY_TIERS: la columna y el CHECK no cambian). */
export const APPLICATION_KIND_TIERS: Readonly<Record<ApplicationKind, readonly number[]>> = Object.freeze({
  case_study: Object.freeze([60, 90]),
  integrative_project: Object.freeze([90, 120]),
  formative_feedback: Object.freeze([30, 60, 90, 120]),
});

/** Dónde puede ir cada tipo. */
export const APPLICATION_KIND_CHAPTER: Readonly<Record<ApplicationKind, 'content' | 'practice'>> = Object.freeze({
  case_study: 'content',
  integrative_project: 'practice',
  formative_feedback: 'practice',
});

export function isApplicationKind(v: unknown): v is ApplicationKind {
  return typeof v === 'string' && (APPLICATION_KINDS as readonly string[]).includes(v);
}

/** null = válido; si no, el motivo (texto para el docente / el error del Blueprint). */
export function applicationKindProblem(kind: unknown, minutes: unknown, chapterKind: 'content' | 'practice'): string | null {
  if (kind === undefined || kind === null) return null;
  if (!isApplicationKind(kind)) return `tipo de actividad desconocido ${JSON.stringify(kind)} (permitidos: ${APPLICATION_KINDS.join(', ')})`;
  if (typeof minutes !== 'number' || !(APPLICATION_ACTIVITY_TIERS as readonly number[]).includes(minutes)) return `${APPLICATION_KIND_LABEL[kind]} sin Actividad de Aplicación (application_minutes)`;
  if (!APPLICATION_KIND_TIERS[kind].includes(minutes)) return `${APPLICATION_KIND_LABEL[kind]} de ${minutes} min: sus niveles son ${APPLICATION_KIND_TIERS[kind].join(', ')} min`;
  if (APPLICATION_KIND_CHAPTER[kind] !== chapterKind) return `${APPLICATION_KIND_LABEL[kind]} va en un capítulo de ${APPLICATION_KIND_CHAPTER[kind] === 'content' ? 'contenido' : 'práctica'}`;
  return null;
}
