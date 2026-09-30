/**
 * R2 — Visual Components: texto plano → HTML inline seguro.
 *
 * - Escapa TODO (& < > " ').
 * - `**énfasis**` → <strong>, emparejado sobre el CAMPO COMPLETO (igual que valida
 *   validate.ts): un énfasis que cruza un salto de línea se cierra al final de la línea y se
 *   reabre en la siguiente, sin dejar `**` literales ni correr los tramos. Un `**` sin
 *   pareja (el validador lo rechaza) queda literal.
 * - Doble salto de línea → párrafos; salto simple → <br>.
 * - Cada tramo de texto va dentro de `<span class="nolink">` (exactamente esa clase y sin
 *   <span> internos): los filtros de Moodle (activitynames, glossary, urltolink, emoticon,
 *   displayh5p…) no tocan su contenido. Verificado con format_text() real (fix round 1, I6).
 * - Palabras muy largas reciben guiones suaves (&shy;) deterministas: bajo forceclean=1
 *   Moodle elimina overflow-wrap/word-break y <wbr> (§X.1), y el &shy; es lo único que
 *   evita el desborde horizontal a 390 px. Umbrales altos para no tocar palabras normales.
 */

export interface HyphenOpts {
  /** Longitud mínima (code points) de una palabra para recibir guiones suaves. */
  minLen: number;
  /** Un guion suave cada N code points. */
  every: number;
}

/** Cuerpo (18 px, columna ≥ ~290 px a 390): solo palabras que realmente no caben. */
export const HYPHEN_DEFAULT: HyphenOpts = { minLen: 22, every: 10 };
/** Títulos (hasta 28 px en la base). */
export const HYPHEN_HEADING: HyphenOpts = { minLen: 16, every: 8 };
/** Celdas de tabla (tablas de ≤ 2 columnas + rótulo). */
export const HYPHEN_TABLE: HyphenOpts = { minLen: 12, every: 6 };

const SHY = '\u00AD';
const OPEN = '\uE000';
const CLOSE = '\uE001';
/** Caracteres invisibles/de formato y de uso privado: nunca llegan al HTML. */
export const INVISIBLE_CHARS_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uE000-\uF8FF]/g;

export const NOLINK_OPEN = '<span class="nolink">';
export const NOLINK_CLOSE = '</span>';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VOWEL_RE = /[aeiouáéíóúüAEIOUÁÉÍÓÚÜ]/;
const LETTER_RE = /\p{L}/u;
/** Grupos consonánticos que no se separan (van juntos al inicio de la sílaba). */
const ONSET_CLUSTERS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'kl', 'kr', 'pl', 'pr', 'tr', 'ch', 'll', 'rr', 'qu', 'gu']);

/**
 * EV5 — posiciones donde un guion suave cae entre sílabas del español (aproximación segura):
 * V·CV (antes de una consonante entre vocales) y VC·CV (entre dos consonantes, salvo grupos
 * inseparables: «ha·bla», «o·tro»). Nunca entre vocales ni fuera de letras.
 */
function syllableBreaks(cps: string[]): Set<number> {
  const out = new Set<number>();
  const isV = (c: string | undefined) => !!c && VOWEL_RE.test(c);
  const isC = (c: string | undefined) => !!c && LETTER_RE.test(c) && !VOWEL_RE.test(c);
  for (let i = 1; i < cps.length - 1; i++) {
    const a = cps[i - 1];
    const b = cps[i];
    const c = cps[i + 1];
    if (isV(a) && isC(b) && isV(c)) out.add(i); // ca·sa
    if (/[aeoáéíóú]/i.test(a) && /[aeoáéíóú]/i.test(b)) out.add(i); // hiato: electro·en·cefalo, pa·ís
    if (isC(a) && isC(b) && isV(c) && isV(cps[i - 2]) && !ONSET_CLUSTERS.has((a + b).toLowerCase())) out.add(i); // can·to
    // o·tro, elec·tro, ins·truc: el grupo inseparable abre la sílaba aunque antes haya otra consonante.
    if (isC(a) && isC(b) && isV(c) && i - 1 >= 2 && LETTER_RE.test(cps[i - 2] ?? '') && ONSET_CLUSTERS.has((a + b).toLowerCase())) out.add(i - 1);
  }
  return out;
}

function hyphenateWord(word: string, h: HyphenOpts): string {
  const cps = Array.from(word);
  if (cps.length < h.minLen) return word;
  const breaks = syllableBreaks(cps);
  const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
  const cuts = new Set<number>();
  // Cada tramo mide ≤ `every` (la garantía anti-desborde de siempre): el corte se busca HACIA ATRÁS
  // desde prev+every, primero en una frontera de sílaba y si no, entre dos letras (nunca junto a
  // «-», «/» o «:»); sin nada de eso, el corte fijo.
  let prev = 0;
  while (cps.length - (prev + h.every) >= 3) {
    const hi = prev + h.every;
    const lo = Math.max(prev + 2, hi - 3);
    let pick = -1;
    for (let c = hi; c >= lo && pick < 0; c--) if (breaks.has(c)) pick = c;
    for (let c = hi; c >= lo && pick < 0; c--) if (isWordChar(cps[c - 1]) && isWordChar(cps[c])) pick = c;
    if (pick < 0) pick = hi;
    cuts.add(pick);
    prev = pick;
  }
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    if (cuts.has(i)) out += SHY;
    out += cps[i];
  }
  return out;
}

/** Escapa + guiones suaves. Las palabras se miden sin los marcadores de énfasis. */
function escapeRun(text: string, h: HyphenOpts): string {
  const hy = text.replace(/[^\s\uE000\uE001]+/g, (w) => hyphenateWord(w, h));
  return escapeHtml(hy).split(SHY).join('&shy;');
}

/**
 * EV5 — `*énfasis*` de un solo asterisco (markdown que el LLM a veces usa) no debe llegar literal:
 * se quita el par de asteriscos y queda el texto. No toca `**…**` ni asteriscos sueltos («5 * 3»).
 */
function stripSingleStars(text: string): string {
  return text.replace(/(^|[^*\p{L}\p{N}])\*(?=[\p{L}\p{N}])([^*\n]*?[\p{L}\p{N}.!?])\*(?![*\p{L}\p{N}])/gu, '$1$2');
}

/** Sustituye los pares `**` por marcadores internos (emparejados en todo el campo). */
function markEmphasis(text: string): string {
  const parts = stripSingleStars(text.replace(INVISIBLE_CHARS_RE, '')).split('**');
  const unbalanced = parts.length % 2 === 0;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) {
      if (unbalanced && i === parts.length - 2) out += '**';
      else out += i % 2 === 0 ? OPEN : CLOSE;
    }
  }
  return out;
}

/**
 * Una línea (con marcadores de énfasis) → HTML. `state.bold` viene de la línea anterior:
 * un énfasis abierto se reabre al inicio y se cierra al final de cada línea.
 * Cada tramo entre marcadores se hifeniza por su cuenta.
 */
function renderLine(line: string, state: { bold: boolean }, h: HyphenOpts): string {
  let out = state.bold ? '<strong>' : '';
  for (const seg of line.split(/([\uE000\uE001])/)) {
    if (seg === OPEN) {
      if (!state.bold) out += '<strong>';
      state.bold = true;
    } else if (seg === CLOSE) {
      if (state.bold) out += '</strong>';
      state.bold = false;
    } else if (seg) {
      out += escapeRun(seg, h);
    }
  }
  if (state.bold) out += '</strong>';
  return out.split('<strong></strong>').join('');
}

/**
 * Campo de texto → lista de párrafos, cada uno como HTML inline (líneas unidas con <br>)
 * envuelto en `<span class="nolink">`. El estado del énfasis cruza líneas y párrafos.
 */
export function richParagraphs(text: string, h: HyphenOpts = HYPHEN_DEFAULT): string[] {
  const marked = markEmphasis(String(text));
  const state = { bold: false };
  const out: string[] = [];
  for (const para of marked.split(/\r?\n[ \t]*\r?\n/)) {
    const lines = para
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const html = lines.map((l) => renderLine(l, state, h)).filter((x) => x.length > 0);
    // un párrafo que solo tenía marcadores no produce salida, pero sí actualizó el estado
    if (html.length) out.push(NOLINK_OPEN + html.join('<br>') + NOLINK_CLOSE);
  }
  return out.length ? out : [NOLINK_OPEN + NOLINK_CLOSE];
}

/** Texto de una sola pieza (títulos, ítems): mismos reglas; los saltos de línea pasan a <br>. */
export function inlineHtml(text: string, h: HyphenOpts = HYPHEN_DEFAULT): string {
  const ps = richParagraphs(text, h).map((p) => p.slice(NOLINK_OPEN.length, p.length - NOLINK_CLOSE.length));
  return NOLINK_OPEN + ps.join('<br>') + NOLINK_CLOSE;
}

/** Texto fijo del renderer (rótulos): escapado y protegido de filtros, sin énfasis ni guiones. */
export function labelHtml(text: string): string {
  return NOLINK_OPEN + escapeHtml(text) + NOLINK_CLOSE;
}

/** Vista de texto para lints: sin `**`, sin invisibles, espacios normalizados. */
export function lintView(text: string): string {
  return String(text).replace(INVISIBLE_CHARS_RE, '').split('**').join('').replace(/\s+/g, ' ').trim();
}
