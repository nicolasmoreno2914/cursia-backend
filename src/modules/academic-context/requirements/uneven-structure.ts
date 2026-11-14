/**
 * r109 M3c · Estructura DESIGUAL en el lector de requisitos: «4 módulos con 4, 7, 4 y 5 capítulos», «Módulo 1: 4 capítulos /
 * Módulo 2: 7 capítulos…» o una línea por módulo con su título («Movilidad segura: 4 capítulos»). Funciones puras, sin
 * proveedores (USD 0). Producen la forma por módulo (p. ej. [4, 7, 4, 5]) y, si vienen, los títulos de los módulos.
 *
 * Solo RECONOCE: no decide qué es obligatorio (eso lo hace el lector: un documento necesita un verbo, la caja del docente
 * es una declaración). Las formas N × M («4 módulos × 5 capítulos») no pasan por aquí: las sigue leyendo el lector de siempre.
 */

import { parseHoursTail } from './module-hours-reader';

export interface UnevenFound {
  /** Capítulos de cada módulo, en orden. */
  shape: number[];
  /** Título de cada módulo (null = el texto no lo da). Siempre el mismo largo que `shape`. */
  titles: (string | null)[];
  /** Cuántos módulos dijo el texto («4 módulos»), si lo dijo. */
  declaredModules: number | null;
  pattern: 'list' | 'items';
  /** Entre un módulo y el siguiente hay cifras (p. ej. «(6 h)»): horas por módulo (r109 M4: se leen en `moduleHours`). */
  moduleExtras?: boolean;
  /** r109 M4 · horas de cada módulo si el texto las da junto al módulo («4 capítulos, 7 h»); null = no las da. Mismo largo que `shape`. */
  moduleHours?: (number | null)[];
  /** r109 M4 · segmento de cada módulo (para citar la línea de sus horas); solo con `moduleHours`. */
  itemSegments?: number[];
}

export interface UnevenSpan {
  segment: number;
  start: number;
  end: number;
}

/**
 * Lo que el lector reconoce (dos cifras). Los topes reales de Cursia (SHAPE_INPUT_MAX: 50 módulos, 30 capítulos por módulo)
 * NO se aplican aquí: una forma fuera de ellos se lee igual y la verificación la marca como conflicto crítico explícito
 * («un módulo admite hasta 30 capítulos»), en vez de quedar como una línea «no entendida».
 */
const MAX_MODULES = 99;
const MAX_CHAPTERS = 99;

const NOUN_CAP = 'cap[ií]tulos?';
/** «4 capítulos por módulo», «5 capítulos de contenido»: es una cantidad por módulo, no el módulo de una lista. */
const NOT_PER = '(?!\\s*(?:por|de|en|para|cada)\\s+(?:cada\\s+)?(?:m[oó]dulos?|unidad(?:es)?|contenido|pr[aá]ctica|uno\\b|una\\b))';
/** Palabras que delatan una oración («El curso tendrá como máximo…»), no el título de un módulo. */
const SENTENCE_WORD = /\b(?:m[ií]nimo|m[aá]ximo|tendr[aá]n?|deber[aá]n?|debe[n]?|cada|curso|asignatura|exactamente|aproximadamente|al menos|hasta|entre|total|tiene[n]?|contar[aá]n?|incluye[n]?|ser[aá]n?|estar[aá]n?|por m[oó]dulo)\b/i;
/** Cifras que acompañan a un módulo («4 capítulos (6 h)», «4 capítulos, 6 horas»): horas por módulo (M4), no del curso. */
const ITEM_TAIL = '(?<par>\\s*\\([^)]*\\))?(?<ht>\\s*[,\\-–—]\\s*\\d{1,3}\\s*(?:h|horas)\\b)?';
const LIST = '(\\d{1,2}(?:\\s*(?:,|;|\\/|\\by\\b|\\be\\b)\\s*\\d{1,2}){1,})';

/** Lista de números → arreglo («4, 7, 4 y 5», «4 / 7 / 4 / 5»). */
function numbersOf(list: string): number[] {
  return (list.match(/\d{1,2}/g) || []).map(Number);
}

const okCounts = (xs: number[]) => xs.length >= 2 && xs.length <= MAX_MODULES && xs.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTERS);

/** «Módulo 3», «Unidad 2», «el módulo»: no es un título real. */
function cleanTitle(raw: string): string | null {
  let t = raw.replace(/\s+/g, ' ').replace(/^(?:[:\-–—·•*]|\b(?:con|de|y|e)\b(?=\s+[A-ZÁÉÍÓÚÑ]))+\s*/i, '').replace(/[\s:\-–—·•*]+$/, '').trim();
  t = t.replace(/^\d{1,2}\s*[.)]\s*/, '').trim();
  if (t.length < 2 || t.length > 120) return null;
  if (/^(?:el |la )?(?:m[oó]dulo|unidad|tema|bloque)s?(?:\s+\d{1,2})?$/i.test(t)) return null;
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(t)) return null;
  return t;
}

/**
 * Busca la forma desigual en UN texto (un renglón o párrafo). Devuelve lo que entendió y los tramos que ocupó (para que el
 * lector no los lea otra vez como «capítulos» sueltos). null si no hay una forma con al menos 2 módulos.
 */
export function findUnevenIn(text: string, titled = true): { found: UnevenFound; spans: { start: number; end: number }[] } | null {
  // Espacios normalizados (la regex de módulos se solapa con `\s*`: con tramos largos de espacios sería cuadrática). Los
  // tramos devueltos son del texto normalizado; el lector ya recibe los segmentos con los espacios colapsados.
  text = text.replace(/\s+/g, ' ');
  // 1. «N módulos con 4, 7, 4 y 5 capítulos» / «N módulos (4/7/4/5 capítulos)» / «capítulos por módulo: 4, 7, 4, 5».
  const lead = new RegExp(`(\\d{1,2})\\s*m[oó]dulos?\\s*(?:\\(|:|,|con|de|=|→|-|–)?\\s*${LIST}\\s*${NOUN_CAP}`, 'iu').exec(text);
  // r109 M3c (ronda 1, P1-1): la lista tras «capítulos» solo es una forma si dice «por módulo». «Los capítulos 3, 4 y 5 del
  // texto», «capítulos 2 y 3 del libro» o «Capítulos 1, 2 y 7» son referencias (lecturas, bibliografía), nunca estructura.
  const per = new RegExp(`${NOUN_CAP}\\s*por\\s+(?:cada\\s+)?m[oó]dulo\\s*(?:\\(|:|=|→|-|–)?\\s*${LIST}(?!\\s*(?:del?|de la|de los|en el|en la)\\s)`, 'iu').exec(text);
  const declared = /(\d{1,2})\s*m[oó]dulos?\b/i.exec(text);
  const listHit = lead ? { counts: numbersOf(lead[2]), start: lead.index, end: lead.index + lead[0].length, declared: Number(lead[1]) } : per
    ? { counts: numbersOf(per[1]), start: per.index, end: per.index + per[0].length, declared: declared ? Number(declared[1]) : null }
    : null;
  // Un DOCUMENTO solo declara la lista si «N módulos» coincide con lo listado (la caja del docente avisa la diferencia).
  const listOk = listHit && okCounts(listHit.counts) && (titled || listHit.declared === null || listHit.declared === listHit.counts.length);
  if (listHit && listOk) {
    // Una forma «4 módulos» + capítulos en la misma frase: se ocupa también el «N módulos» suelto de la frase (no se lee aparte).
    const spans = [{ start: listHit.start, end: listHit.end }];
    if (!lead && declared && (declared.index + declared[0].length <= listHit.start || declared.index >= listHit.end)) spans.push({ start: declared.index, end: declared.index + declared[0].length });
    return { found: { shape: listHit.counts, titles: listHit.counts.map(() => null), declaredModules: listHit.declared, pattern: 'list' }, spans };
  }

  // 2. Un módulo por tramo: «Módulo 1: 4 capítulos / Módulo 2: 7 capítulos», «Movilidad segura: 4 capítulos», «Normas – 7 capítulos».
  const re = new RegExp(
    `(?:^|[,;:|\\/.]|\\s[yYeE]\\s)\\s*(?<pfx>(?:m[oó]dulo|unidad)\\s*\\d{1,2}\\s*[:\\-–—.)]?\\s*)?(?<title>[^,;:|\\/.\\d\\n]{0,90}?)\\s*[:\\-–—(]?\\s*(?<n>\\d{1,2})\\s*${NOUN_CAP}${NOT_PER}${ITEM_TAIL}`,
    'giu',
  );
  const items: { title: string | null; chapters: number; start: number; end: number; extras: boolean; hoursTail: number; prefixed: boolean; hours: number | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const g = m.groups as { pfx?: string; title: string; n: string; par?: string; ht?: string };
    const n = Number(g.n);
    if (re.lastIndex === m.index) re.lastIndex++;
    // Una oración («El curso tendrá como máximo 3 capítulos») no es el módulo de una lista.
    if (!(n >= 1 && n <= MAX_CHAPTERS) || SENTENCE_WORD.test(g.title)) return null;
    // El tramo del módulo empieza donde empieza su título (o su número), no en el delimitador.
    const body = m[0].replace(/^(?:[,;:|\/.]|\s[yYeE]\s)?\s*/, '');
    const start = m.index + (m[0].length - body.length);
    items.push({ title: cleanTitle(g.title), chapters: n, start, end: m.index + m[0].length, extras: /\d/.test(`${g.par || ''}${g.ht || ''}`), hoursTail: (g.ht || '').length, prefixed: !!g.pfx, hours: parseHoursTail(g.ht) ?? parseHoursTail(g.par) });
  }
  if (items.length < 2 || items.length > MAX_MODULES) return null;
  // Un documento solo declara módulos con «Módulo N:»; los títulos sueltos («Introducción: 2 capítulos») son de la caja del docente.
  if (!titled && items.some((i) => !i.prefixed)) return null;
  // «…, 28 horas» tras el ÚLTIMO módulo son las horas del curso, no de ese módulo: no se ocupan (un paréntesis sí).
  // r109 M4: salvo que TODOS los demás módulos traigan sus horas: entonces las del último también son de su módulo.
  const last = items[items.length - 1];
  const othersAllHours = items.slice(0, -1).every((i) => i.hours !== null);
  if (last.hoursTail && !(othersAllHours && last.hours !== null)) { last.end -= last.hoursTail; last.extras = false; last.hours = null; }
  // «N módulos:» al frente de la lista se ocupa también (no se lee aparte como «N módulos»).
  const spans = items.map((i) => ({ start: i.start, end: i.end }));
  // Cifras entre un módulo y el siguiente («… 4 capítulos (6 h), Normas 7 capítulos»): se apartan, no son horas del curso.
  let moduleExtras = items.some((i) => i.extras);
  for (let i = 0; i + 1 < items.length; i++) {
    const gap = text.slice(items[i].end, items[i + 1].start);
    if (/\d/.test(gap)) {
      moduleExtras = true;
      spans.push({ start: items[i].end, end: items[i + 1].start });
      if (items[i].hours === null) items[i].hours = parseHoursTail(gap);
    }
  }
  const first = items[0].start;
  const head = new RegExp(`(\\d{1,2})\\s*m[oó]dulos?\\s*[:,\\-–—]?\\s*$`, 'iu').exec(text.slice(0, first));
  let declaredModules: number | null = null;
  if (head) { spans.unshift({ start: head.index, end: head.index + head[0].length }); declaredModules = Number(head[1]); }
  else if (declared && declared.index < first) declaredModules = Number(declared[1]);
  const anyHours = items.some((i) => i.hours !== null);
  return { found: { shape: items.map((i) => i.chapters), titles: items.map((i) => i.title), declaredModules, pattern: 'items', ...(moduleExtras ? { moduleExtras: true } : {}), ...(anyHours ? { moduleHours: items.map((i) => i.hours) } : {}) }, spans };
}

/**
 * Los tramos de varios renglones (uno por módulo) se unen si son consecutivos: «Movilidad segura: 4 capítulos» /
 * «Normas de tránsito – 7 capítulos» en renglones seguidos son UNA forma. `texts` = el texto de cada segmento, en orden.
 */
export interface UnevenGroup {
  found: UnevenFound;
  /** Segmentos que la forma ocupa (índices en `texts`) y los tramos de cada uno. */
  spans: UnevenSpan[];
  firstSegment: number;
}

export function findUnevenStructure(texts: string[], titled = true): UnevenGroup | null {
  texts = texts.map((t) => t.replace(/\s+/g, ' '));
  // a) Una sola frase con toda la forma.
  for (let i = 0; i < texts.length; i++) {
    const hit = findUnevenIn(texts[i], titled);
    if (hit && (hit.found.pattern === 'list' || hit.found.shape.length >= 2)) {
      return { found: hit.found.moduleHours ? { ...hit.found, itemSegments: hit.found.moduleHours.map(() => i) } : hit.found, spans: hit.spans.map((s) => ({ segment: i, ...s })), firstSegment: i };
    }
  }
  // b) Un módulo por renglón, renglones seguidos (cada uno con UN módulo).
  const singles: { i: number; title: string | null; n: number; span: { start: number; end: number }; extras: boolean; prefixed: boolean; hours: number | null; hoursTail: number }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const re = new RegExp(`^\\s*(?:[-*•·]\\s*|\\d{1,2}\\s*[.)]\\s*)?(?:(?<pfx>m[oó]dulo|unidad)\\s*\\d{1,2}\\s*[:\\-–—.)]?\\s*)?(?<title>[^\\d:|\\n]{0,90}?)\\s*[:\\-–—(|]?\\s*(?<n>\\d{1,2})\\s*${NOUN_CAP}${NOT_PER}${ITEM_TAIL}\\s*\\)?\\s*[.;,]?\\s*$`, 'iu');
    const m = re.exec(t);
    const g = m && (m.groups as { pfx?: string; title: string; n: string; par?: string; ht?: string });
    if (g && Number(g.n) >= 1 && Number(g.n) <= MAX_CHAPTERS && !SENTENCE_WORD.test(g.title) && (titled || g.pfx)) singles.push({ i, title: cleanTitle(g.title), n: Number(g.n), span: { start: 0, end: t.length }, extras: /\d/.test(`${g.par || ''}${g.ht || ''}`), prefixed: !!g.pfx, hours: parseHoursTail(g.ht) ?? parseHoursTail(g.par), hoursTail: (g.ht || '').length });
  }
  // La racha más larga de renglones consecutivos.
  let best: typeof singles = [];
  let run: typeof singles = [];
  for (const s of singles) {
    if (run.length && s.i === run[run.length - 1].i + 1) run.push(s); else run = [s];
    if (run.length > best.length) best = [...run];
  }
  if (best.length >= 2 && best.length <= MAX_MODULES) {
    let declaredModules: number | null = null;
    const before = best[0].i > 0 ? /^\s*(\d{1,2})\s*m[oó]dulos?\b[^\d]{0,30}$/i.exec(texts[best[0].i - 1]) : null;
    // r109 M4: las horas del último renglón son del curso (no del módulo) si algún otro módulo no trae las suyas.
    const lastS = best[best.length - 1];
    const allOthers = best.slice(0, -1).every((s) => s.hours !== null);
    if (lastS.hoursTail && lastS.hours !== null && !allOthers) {
      const at = texts[lastS.i].lastIndexOf((texts[lastS.i].match(/[,\-–—]\s*\d{1,3}\s*(?:h|horas)\b[^,\-–—]*$/i) || [''])[0]);
      if (at > 0) { lastS.span = { start: 0, end: at }; lastS.hours = null; lastS.extras = false; }
    }
    const spans: UnevenSpan[] = best.map((s) => ({ segment: s.i, ...s.span }));
    if (before) { declaredModules = Number(before[1]); spans.unshift({ segment: best[0].i - 1, start: 0, end: texts[best[0].i - 1].length }); }
    const anyHours = best.some((s) => s.hours !== null);
    return { found: { shape: best.map((s) => s.n), titles: best.map((s) => s.title), declaredModules, pattern: 'items', ...(best.some((s) => s.extras) ? { moduleExtras: true } : {}), ...(anyHours ? { moduleHours: best.map((s) => s.hours), itemSegments: best.map((s) => s.i) } : {}) }, spans, firstSegment: spans[0].segment };
  }
  return null;
}

/** Quita los tramos ocupados de un texto (los reemplaza por un espacio) y limpia lo que queda. */
export function blankSpans(text: string, spans: { start: number; end: number }[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of sorted) out = `${out.slice(0, s.start)} ${out.slice(s.end)}`;
  return out.replace(/\s+/g, ' ').replace(/^[\s.,;:\-–—]+/, '').trim();
}
