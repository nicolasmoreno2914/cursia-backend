/**
 * r109 M4 · Horas POR MÓDULO en el lector de requisitos. Funciones puras, sin proveedores (USD 0).
 *
 *   «Módulo 2: 12 horas»                       → módulo 2, 12 h
 *   «El módulo 2 tendrá 12 horas»              → módulo 2, 12 h   (también en documentos: lleva verbo)
 *   «12 horas para el módulo 2»                → módulo 2, 12 h
 *   «Movilidad segura: 4 capítulos, 7 h»       → (lo lee uneven-structure con parseHoursTail)
 *   «Normas de tránsito – 7 capítulos – 12 horas»
 *
 * NUNCA son horas de un módulo: las horas de componente («20 horas de clase», «horas autónomas», semanales…), los rangos
 * («12–14 h») ni las referencias. Esas siguen el camino de siempre (IgnoredReason `component_hours`).
 */

/** Horas que NO son el total de trabajo del estudiante (la misma lista que usa el lector; el texto va sin acentos). */
export const RE_COMPONENT_HOURS = /\b(clase|clases|acompanamiento|presencial\w*|teoric\w*|practic\w*|autonom\w*|independiente|semanal\w*|por semana|a la semana|sincronic\w*|cada semana|encuentro|tutoria\w*|limite|despues|antes|dedicacion semanal|had|hti|ht|hp)\b/;

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const NUM = '(\\d{1,3}(?:[.,]\\d)?)';
const UNIT = '(?:h|hrs?|horas?)\\b';
const MODULE = 'm[oó]dulo';

export interface ModuleHoursHit {
  /** Módulo (1-based). */
  index: number;
  hours: number;
  start: number;
  end: number;
  /** Con verbo («tendrá 12 horas»): vale también en un documento. Sin verbo («Módulo 2: 12 h»): solo en la caja del docente. */
  withVerb: boolean;
  /** Es un patrón de módulo, pero la cifra no sirve (menos de 0,5 h o más de 500): se aparta con su motivo, no se lee como horas del curso. */
  invalid?: boolean;
}

const toNum = (s: string) => Number(s.replace(',', '.'));
/** Horas válidas de un módulo (entre 0,5 y 500). */
const okHours = (h: number) => Number.isFinite(h) && h >= 0.5 && h <= 500;

/**
 * ¿Son horas de un componente («de clase», «de trabajo autónomo», «presenciales», «cada semana») y no del módulo? Se mira la ORACIÓN
 * completa del hallazgo (no solo la palabra que sigue al número): «Módulo 2: 12 horas de trabajo autónomo» no es del módulo.
 */
function componentIn(text: string, start: number, end: number): boolean {
  let a = start;
  while (a > 0 && !/[.;\n]/.test(text[a - 1])) a--;
  let b = end;
  while (b < text.length && !(/[.;]/.test(text[b]) && !/\d/.test(text[b + 1] || ''))) b++;
  return RE_COMPONENT_HOURS.test(strip(text.slice(a, b)));
}

/**
 * Busca «Módulo N: H horas» y sus variantes en UN texto. `declarative` (la caja del docente) admite además la forma sin verbo
 * («Módulo 2: 12 horas», «Módulo 2 – 12 h», «12 horas para el módulo 2»); un documento solo la forma con verbo.
 */
export function findModuleHoursIn(text: string, declarative: boolean): ModuleHoursHit[] {
  const t = text.replace(/\s+/g, ' ');
  const hits: ModuleHoursHit[] = [];
  const taken = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);
  const add = (h: ModuleHoursHit) => {
    if (!(h.index >= 1 && h.index <= 99) || taken(h.start, h.end) || componentIn(t, h.start, h.end)) return;
    if (!okHours(h.hours)) { hits.push({ ...h, invalid: true }); return; }
    // Un rango («12–14 h», «12 a 14 horas») no es una cifra de módulo.
    if (/^\s*(?:-|–|—|a|al|hasta|y)\s*\d/i.test(t.slice(h.end - 0, h.end + 8)) ) return;
    hits.push(h);
  };
  // Con verbo.
  const verb = new RegExp(`(?:\\bel\\s+)?\\b${MODULE}\\s*(\\d{1,2})\\s*(?:tiene|tendr[aá]|durar[aá]|dura|ser[aá]\\s+de|es\\s+de|constar[aá]\\s+de|contar[aá]\\s+con|comprende|comprender[aá])\\s*(?:un\\s+total\\s+de\\s+)?${NUM}\\s*${UNIT}`, 'giu');
  let m: RegExpExecArray | null;
  while ((m = verb.exec(t))) add({ index: Number(m[1]), hours: toNum(m[2]), start: m.index, end: m.index + m[0].length, withVerb: true });
  if (!declarative) return hits.sort((a, b) => a.start - b.start);
  // Sin verbo (solo la caja).
  const plain = new RegExp(`\\b${MODULE}\\s*(\\d{1,2})\\s*(?:[:=]|[-–—]|\\(|con|de)\\s*${NUM}\\s*${UNIT}\\s*\\)?`, 'giu');
  while ((m = plain.exec(t))) add({ index: Number(m[1]), hours: toNum(m[2]), start: m.index, end: m.index + m[0].length, withVerb: false });
  const rev = new RegExp(`\\b${NUM}\\s*${UNIT}\\s*(?:para|en|del?|al)\\s+(?:el\\s+)?${MODULE}\\s*(\\d{1,2})\\b`, 'giu');
  while ((m = rev.exec(t))) add({ index: Number(m[2]), hours: toNum(m[1]), start: m.index, end: m.index + m[0].length, withVerb: false });
  return hits.sort((a, b) => a.start - b.start);
}

/** «6 h» / «12 horas» / «7,5 h» dentro de un trozo (cola de un módulo): su valor, o null si no hay o es de un componente. */
export function parseHoursTail(piece: string | undefined | null): number | null {
  if (!piece) return null;
  const p = piece.replace(/\s+/g, ' ');
  const m = new RegExp(`${NUM}\\s*${UNIT}`, 'iu').exec(p);
  if (!m) return null;
  if (/\d\s*(?:-|–|—|a|al|hasta)\s*\d/i.test(p.slice(m.index, m.index + m[0].length + 8))) return null;
  if (RE_COMPONENT_HOURS.test(strip(p))) return null;
  const h = toNum(m[1]);
  return okHours(h) ? h : null;
}

/** Quita los tramos (de atrás hacia adelante) y deja un espacio. */
export function blankHitSpans(text: string, hits: { start: number; end: number }[]): string {
  let out = text.replace(/\s+/g, ' ');
  for (const h of [...hits].sort((a, b) => b.start - a.start)) out = `${out.slice(0, h.start)} ${out.slice(h.end)}`;
  return out.replace(/\s+/g, ' ').replace(/^[\s.,;:\-–—]+/, '').trim();
}
