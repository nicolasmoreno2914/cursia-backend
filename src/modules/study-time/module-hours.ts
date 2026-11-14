// r109 M4 · Horas por módulo. Sin dependencias: lo importan el distribuidor, el perfil pedagógico y el lector de requisitos.
//
// El docente puede decir «el módulo 2 tiene 12 h». Se guarda como un arreglo alineado con los módulos
// (`moduleTargetHours: (number | null)[]`, null = sin horas propias: ese módulo se reparte lo que queda del total).
// Las horas de un módulo son las suyas: apertura + capítulos (contenido, actividades, práctica y aplicación) + examen del
// módulo. Los recursos del curso (bienvenida, marco, foro, examen final) no son de ningún módulo.

import { TARGET_HOURS_MAX } from './target-hours';

/** Las horas de un módulo se guardan en múltiplos de media hora, de 1 a 500. */
export const MODULE_HOURS_STEP = 0.5;
export const MODULE_HOURS_MIN = 1;
export const MODULE_HOURS_MAX = TARGET_HOURS_MAX;
/** Cada módulo debe quedar dentro de ±10 % de sus horas (o decir por qué no puede). */
export const MODULE_HOURS_TOLERANCE_PCT = 0.1;

export function isValidModuleHours(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MODULE_HOURS_MIN && v <= MODULE_HOURS_MAX && Number.isInteger(v * 2);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(r1(n)).replace('.', ',');
export const formatHours = fmt;

export interface ModuleHoursNormalized {
  /** Alineado con los módulos (`moduleCount` posiciones); null = sin horas propias. */
  hours: (number | null)[];
  /** Avisos para el docente (redondeos, horas de módulos que no existen, valores que no se pudieron usar). */
  notes: string[];
}

/**
 * Horas por módulo → arreglo canónico de `moduleCount` posiciones. Lo que no es un número válido se ignora (null); un valor
 * que no es múltiplo de 0,5 se REDONDEA a 0,5 h con aviso; las horas de módulos que no existen se descartan con aviso.
 */
export function normalizeModuleHours(raw: unknown, moduleCount: number): ModuleHoursNormalized {
  const notes: string[] = [];
  const src = Array.isArray(raw) ? raw : [];
  const hours: (number | null)[] = [];
  for (let i = 0; i < moduleCount; i++) {
    const v = src[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) { hours.push(null); continue; }
    let h = Math.round(v * 2) / 2;
    if (h !== v) notes.push(`Las horas del módulo ${i + 1} (${fmt(v)} h) se redondearon a ${fmt(h)} h: las horas se guardan de media en media hora.`);
    if (h < MODULE_HOURS_MIN) { notes.push(`El módulo ${i + 1} no puede tener menos de ${MODULE_HOURS_MIN} h: se usó ${MODULE_HOURS_MIN} h.`); h = MODULE_HOURS_MIN; }
    if (h > MODULE_HOURS_MAX) { notes.push(`El módulo ${i + 1} no puede tener más de ${MODULE_HOURS_MAX} h: se usó ${MODULE_HOURS_MAX} h.`); h = MODULE_HOURS_MAX; }
    hours.push(h);
  }
  for (let i = moduleCount; i < src.length; i++) {
    if (typeof src[i] === 'number' && Number.isFinite(src[i]) && (src[i] as number) > 0) notes.push(`Hay horas para el módulo ${i + 1} (${fmt(src[i] as number)} h), pero el curso solo tiene ${moduleCount} ${moduleCount === 1 ? 'módulo' : 'módulos'}: no se usaron.`);
  }
  return { hours, notes };
}

/** ¿Hay al menos un módulo con horas propias? */
export function hasModuleHours(h: unknown): boolean {
  return Array.isArray(h) && h.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

export interface ModuleHoursPlan {
  /** Horas fijadas por módulo (alineadas; null = sin horas propias). */
  fixed: (number | null)[];
  /** Total del curso con el que se repartió (el pedido, o la suma de las fijadas si la pasaban). */
  total: number;
  requestedTotal: number;
  totalAdjusted: boolean;
  /** Lo que queda para los módulos sin horas propias (0 si no hay ninguno). */
  remainder: number;
  /** Avisos visibles (redondeos, total que pasa a ser la suma, módulos sin horas que se quedan sin margen). */
  warnings: string[];
}

/**
 * Reparte el total del curso: los módulos con horas propias las conservan y los demás (null) se reparten el resto.
 *  - Si la suma de las fijadas pasa del total, el total pasa a ser la suma (con aviso).
 *  - Si quedan módulos sin horas y el resto es menor que 1 h, esos módulos reciben 1 h (el mínimo que Cursia diseña) y el
 *    total pasa a ser la suma con ese mínimo (con aviso).
 */
export function planModuleHours(moduleHours: unknown, total: number, moduleCount: number): ModuleHoursPlan {
  const n = normalizeModuleHours(moduleHours, moduleCount);
  const fixed = n.hours;
  const warnings = [...n.notes];
  const sum = fixed.reduce<number>((a, h) => a + (h ?? 0), 0);
  const nulls = fixed.filter((h) => h === null).length;
  let eff = total;
  let totalAdjusted = false;
  if (sum > total) {
    eff = sum;
    totalAdjusted = true;
    warnings.push(`Las horas de los módulos suman ${fmt(sum)} h, más que las ${fmt(total)} h del curso: el total pasa a ser ${fmt(sum)} h.`);
  }
  let remainder = nulls ? eff - sum : 0;
  if (nulls && remainder < MODULE_HOURS_MIN) {
    remainder = MODULE_HOURS_MIN;
    eff = sum + remainder;
    totalAdjusted = true;
    warnings.push(`Con las horas de los demás módulos no queda tiempo para ${nulls === 1 ? 'el módulo sin horas' : 'los módulos sin horas'}: se les dejó el mínimo de ${MODULE_HOURS_MIN} h y el total pasa a ser ${fmt(eff)} h.`);
  }
  return { fixed, total: eff, requestedTotal: total, totalAdjusted, remainder, warnings };
}

/** Estado de un módulo (los mismos que el del curso). */
export type ModuleHoursStatus = 'within_tolerance' | 'above_tolerance' | 'minimum_exceeds_target' | 'cannot_reach_target';

export interface ModuleHoursEntry {
  moduleId: string;
  title: string;
  index: number;
  /** 'fixed': el módulo tiene horas propias; 'remainder': se reparte lo que queda del total. */
  source: 'fixed' | 'remainder';
  /** Horas pedidas (null en un módulo de 'remainder': su meta es la del grupo). */
  targetHours: number | null;
  /** Horas del diseño propuesto para este módulo. */
  estimatedHours: number;
  deltaHours: number | null;
  /** ±10 % de sus horas (null en 'remainder'). */
  toleranceHours: number | null;
  status: ModuleHoursStatus;
  chapters: number;
  /** Por qué no llega (solo si `status` no es 'within_tolerance'), con el módulo y las horas. */
  explanation?: string;
}

export interface ModuleHoursResult {
  version: 1;
  requestedTotalHours: number;
  /** El total con el que se diseñó (la suma de los módulos si pasaban del total). */
  totalHours: number;
  totalAdjusted: boolean;
  /** Horas de los recursos del curso (bienvenida, marco, foro, examen final): no son de ningún módulo. */
  courseOverheadHours: number;
  /** Horas que se repartieron entre los módulos sin horas propias (0 si todos tienen). */
  remainderHours: number;
  toleranceFraction: number;
  modules: ModuleHoursEntry[];
  /** Avisos visibles (redondeos, total que cambia, módulos sin margen) y la explicación de cada módulo que no llega. */
  warnings: string[];
}

/** Horas de cada módulo que pidió el docente, alineadas (para la huella de la propuesta y el resumen). */
export function moduleHoursOf(r: ModuleHoursResult | undefined | null): (number | null)[] | null {
  return r ? r.modules.map((m) => m.targetHours) : null;
}
