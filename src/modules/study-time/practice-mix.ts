/**
 * T3 (r57) · Proporción de capítulos audiovisuales (contenido) y de práctica — configuración genérica y validada.
 *
 * El distribuidor ya crea capítulos de práctica (sin video, presentación ni audiolibro). Lo que faltaba era decir
 * CUÁNTOS y DÓNDE de forma explícita, por formato o a mano, para formas como «4 × 4 = 16 capítulos (9 audiovisuales
 * + 7 de práctica)» o «4 × 5 = 20 (9 + 11)», donde los capítulos de contenido por módulo NO son parejos.
 *
 * Dos maneras (en `learningPlan.composition.practiceMix` del perfil pedagógico; opt-in, ausente = lo de siempre):
 *   A) total por módulo: `{ modules, chaptersPerModule, practiceTotal | audiovisualTotal }`: cada módulo tiene
 *      `chaptersPerModule` capítulos EN TOTAL (contenido + práctica).
 *   B) sobre un formato S/M/L: `{ format, practicePerModule | practiceTotal }`: la forma de contenidos del formato
 *      (módulos × capítulos de contenido) más los capítulos de práctica (el formato no los cuenta).
 *
 * Reparto (regla `mix.front_loaded_content`, determinista): los capítulos de contenido sobrantes van a los PRIMEROS
 * módulos (presentan el oficio) y la práctica sobrante a los ÚLTIMOS (integran el curso). Cada módulo conserva al
 * menos un capítulo de contenido. El resultado se traduce en restricciones del distribuidor (práctica exacta por
 * módulo, forma fija): el mismo motor de siempre crea las prácticas, su Actividad y sus horas.
 */
import type { DistributorRequirementConstraints } from '../academic-context/requirements/requirement-authority';
import { COURSE_FORMATS, CourseFormatCode, isCourseFormatCode } from '../prebrief/course-formats';

export const PRACTICE_MIX_VERSION = 1 as const;
/** Mismo tope de capítulos por módulo que la entrada de forma (context-design.ts SHAPE_INPUT_MAX). */
export const PRACTICE_MIX_LIMITS = Object.freeze({ modules: 50, chaptersPerModule: 30 });

export interface PracticeMixSpec {
  format?: CourseFormatCode;
  modules?: number;
  chaptersPerModule?: number;
  practiceTotal?: number;
  audiovisualTotal?: number;
  practicePerModule?: number;
}

export interface PracticeMixPlan {
  version: typeof PRACTICE_MIX_VERSION;
  ruleId: 'mix.front_loaded_content';
  /** 'total' = A (capítulos por módulo en total) · 'format' = B (práctica sobre la forma del formato). */
  mode: 'total' | 'format';
  spec: PracticeMixSpec;
  modules: { content: number; practice: number }[];
  contentTotal: number;
  practiceTotal: number;
  chaptersTotal: number;
}

export class PracticeMixError extends Error {
  readonly code = 'PRACTICE_MIX_INVALID';
  constructor(message: string) {
    super(`PRACTICE_MIX_INVALID: ${message}`);
    this.name = 'PracticeMixError';
  }
}

const KEYS = ['format', 'modules', 'chaptersPerModule', 'practiceTotal', 'audiovisualTotal', 'practicePerModule'] as const;
const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Errores de validación de la especificación (lista vacía = válida). La usa la validación del perfil. */
export function practiceMixSpecErrors(spec: unknown): string[] {
  const errs: string[] = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['practiceMix debe ser un objeto'];
  const s = spec as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!(KEYS as readonly string[]).includes(k)) errs.push(`campo desconocido «${k}»`);
  const has = (k: string) => s[k] !== undefined;
  if (has('format') && !isCourseFormatCode(s.format)) errs.push(`formato desconocido ${JSON.stringify(s.format)} (S, M o L)`);
  if (has('modules') && !int(s.modules, 1, PRACTICE_MIX_LIMITS.modules)) errs.push(`modules debe ser un entero entre 1 y ${PRACTICE_MIX_LIMITS.modules}`);
  if (has('chaptersPerModule') && !int(s.chaptersPerModule, 1, PRACTICE_MIX_LIMITS.chaptersPerModule)) errs.push(`chaptersPerModule debe ser un entero entre 1 y ${PRACTICE_MIX_LIMITS.chaptersPerModule}`);
  for (const k of ['practiceTotal', 'audiovisualTotal']) if (has(k) && !int(s[k], 0, PRACTICE_MIX_LIMITS.modules * PRACTICE_MIX_LIMITS.chaptersPerModule)) errs.push(`${k} debe ser un entero ≥ 0`);
  if (has('practicePerModule') && !int(s.practicePerModule, 0, PRACTICE_MIX_LIMITS.chaptersPerModule)) errs.push('practicePerModule debe ser un entero ≥ 0');
  if (errs.length) return errs;
  if (has('format')) {
    if (has('modules') || has('chaptersPerModule')) errs.push('con un formato, la forma la fija el formato (sin modules ni chaptersPerModule)');
    if (has('audiovisualTotal')) errs.push('con un formato, los capítulos audiovisuales son los del formato (sin audiovisualTotal)');
    if (has('practicePerModule') === has('practiceTotal')) errs.push('con un formato, indica practicePerModule o practiceTotal (uno solo)');
  } else {
    if (!has('modules') || !has('chaptersPerModule')) errs.push('sin formato, indica modules y chaptersPerModule (capítulos por módulo en total)');
    if (has('practicePerModule')) errs.push('sin formato, indica practiceTotal o audiovisualTotal (no practicePerModule)');
    if (has('practiceTotal') === has('audiovisualTotal')) errs.push('sin formato, indica practiceTotal o audiovisualTotal (uno solo)');
  }
  return errs;
}

/** Especificación normalizada (claves en orden fijo). Lanza si es inválida. */
export function normalizePracticeMixSpec(spec: unknown): PracticeMixSpec {
  const errs = practiceMixSpecErrors(spec);
  if (errs.length) throw new PracticeMixError(errs.join('; '));
  const s = spec as PracticeMixSpec;
  const out: PracticeMixSpec = {};
  for (const k of KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/** Spread determinista: `total` en `n` partes; el resto a las primeras (`first`) o a las últimas. */
function spread(total: number, n: number, first: boolean): number[] {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + ((first ? i < rest : i >= n - rest) ? 1 : 0));
}

export function planPracticeMix(spec: unknown): PracticeMixPlan {
  const s = normalizePracticeMixSpec(spec);
  if (s.format) {
    const f = COURSE_FORMATS[s.format];
    const practice = s.practicePerModule !== undefined ? Array.from({ length: f.modules }, () => s.practicePerModule as number) : spread(s.practiceTotal as number, f.modules, false);
    if (practice.some((p) => f.chaptersPerModule + p > PRACTICE_MIX_LIMITS.chaptersPerModule)) throw new PracticeMixError(`más de ${PRACTICE_MIX_LIMITS.chaptersPerModule} capítulos en un módulo`);
    const modules = practice.map((p) => ({ content: f.chaptersPerModule, practice: p }));
    return finish('format', s, modules);
  }
  const M = s.modules as number;
  const N = s.chaptersPerModule as number;
  const total = M * N;
  const content = s.audiovisualTotal !== undefined ? s.audiovisualTotal : total - (s.practiceTotal as number);
  if (content < M) throw new PracticeMixError(`cada módulo necesita al menos un capítulo audiovisual: ${content} para ${M} módulos (${total} capítulos en total)`);
  if (content > total) throw new PracticeMixError(`${content} capítulos audiovisuales no caben en ${M} × ${N} = ${total}`);
  const c = spread(content, M, true);
  return finish('total', s, c.map((x) => ({ content: x, practice: N - x })));
}

function finish(mode: PracticeMixPlan['mode'], spec: PracticeMixSpec, modules: PracticeMixPlan['modules']): PracticeMixPlan {
  const contentTotal = modules.reduce((n, m) => n + m.content, 0);
  const practiceTotal = modules.reduce((n, m) => n + m.practice, 0);
  return { version: PRACTICE_MIX_VERSION, ruleId: 'mix.front_loaded_content', mode, spec, modules, contentTotal, practiceTotal, chaptersTotal: contentTotal + practiceTotal };
}

/** Forma de CONTENIDOS que debe tener la estructura para aplicar la mezcla (capítulos de contenido por módulo). */
export function practiceMixContentShape(plan: PracticeMixPlan): number[] {
  return plan.modules.map((m) => m.content);
}

export interface PracticeMixFit {
  ok: boolean;
  contentShape: number[];
  expectedContentShape: number[];
  differences: string[];
}

/** ¿La estructura tiene la forma de contenidos de la mezcla? (las prácticas existentes no cuentan: las ajusta el distribuidor). */
export function practiceMixFit(plan: PracticeMixPlan, modules: { chapters: { kind?: string }[] }[]): PracticeMixFit {
  const contentShape = modules.map((m) => m.chapters.filter((c) => (c.kind || 'content') !== 'practice').length);
  const expected = practiceMixContentShape(plan);
  const differences: string[] = [];
  if (contentShape.length !== expected.length) differences.push(`La mezcla pide ${expected.length} módulos y la estructura tiene ${contentShape.length}.`);
  else contentShape.forEach((n, i) => { if (n !== expected[i]) differences.push(`Módulo ${i + 1}: la mezcla pide ${expected[i]} capítulo(s) audiovisual(es) y la estructura tiene ${n}.`); });
  return { ok: differences.length === 0, contentShape, expectedContentShape: expected, differences };
}

/** Restricciones del distribuidor que cumplen la mezcla (práctica exacta por módulo; forma de contenidos fija). */
export function practiceMixConstraints(plan: PracticeMixPlan): DistributorRequirementConstraints {
  const uniformTotal = plan.modules.every((m) => m.content + m.practice === plan.modules[0].content + plan.modules[0].practice);
  const n = plan.modules[0].content + plan.modules[0].practice;
  return {
    noContentAdditions: true,
    practiceByModule: plan.modules.map((m) => m.practice),
    practiceTotal: { min: plan.practiceTotal, max: plan.practiceTotal },
    ...(uniformTotal ? { chaptersPerModule: { min: n, max: n } } : {}),
    sources: {},
  };
}

export type PracticeMixStatus = 'applied' | 'structure_mismatch' | 'document_wins';

export interface PracticeMixEvaluation {
  status: PracticeMixStatus;
  ruleId: 'mix.applied' | 'mix.structure_mismatch' | 'mix.document_wins';
  plan: PracticeMixPlan;
  fit: PracticeMixFit;
  /** Restricciones con las que se llama al distribuidor (las del documento si la mezcla no se aplica). */
  constraints: DistributorRequirementConstraints | null;
  notes: string[];
}

/**
 * Mezcla + requisitos del documento → restricciones efectivas. El documento manda: si fija capítulos o prácticas, la
 * mezcla no se aplica (se informa). Si la estructura no tiene la forma de contenidos de la mezcla, tampoco (Cursia no
 * quita ni agrega capítulos de contenido por su cuenta): se informa qué cambiar.
 */
export function evaluatePracticeMix(spec: unknown, modules: { chapters: { kind?: string }[] }[], document: DistributorRequirementConstraints | null): PracticeMixEvaluation {
  const plan = planPracticeMix(spec);
  const fit = practiceMixFit(plan, modules);
  const doc = document ?? null;
  if (doc && (doc.practicePerModule || doc.practiceTotal || doc.chaptersPerModule || doc.contentChaptersPerModule || doc.practiceByModule)) {
    return { status: 'document_wins', ruleId: 'mix.document_wins', plan, fit, constraints: doc, notes: ['El documento fija los capítulos o las prácticas por módulo: manda sobre la mezcla de práctica configurada.'] };
  }
  if (!fit.ok) {
    return { status: 'structure_mismatch', ruleId: 'mix.structure_mismatch', plan, fit, constraints: doc, notes: [`La estructura no tiene la forma de la mezcla (${fit.expectedContentShape.join(' + ')} capítulos audiovisuales por módulo): no se aplica.`, ...fit.differences] };
  }
  const mix = practiceMixConstraints(plan);
  const merged: DistributorRequirementConstraints = doc ? { ...doc, ...mix, sources: { ...doc.sources } } : mix;
  return {
    status: 'applied', ruleId: 'mix.applied', plan, fit, constraints: merged,
    notes: [`Mezcla de práctica: ${plan.contentTotal} capítulos audiovisuales + ${plan.practiceTotal} de práctica (${plan.modules.map((m) => `${m.content}+${m.practice}`).join(' · ')}).`],
  };
}
