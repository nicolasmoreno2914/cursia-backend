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

function hyphenateWord(word: string, h: HyphenOpts): string {
  const cps = Array.from(word);
  if (cps.length < h.minLen) return word;
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    out += cps[i];
    const pos = i + 1;
    // no cortar dejando menos de 3 caracteres al final
    if (pos % h.every === 0 && cps.length - pos >= 3) out += SHY;
  }
  return out;
}

/** Escapa + guiones suaves. Las palabras se miden sin los marcadores de énfasis. */
function escapeRun(text: string, h: HyphenOpts): string {
  const hy = text.replace(/[^\s\uE000\uE001]+/g, (w) => hyphenateWord(w, h));
  return escapeHtml(hy).split(SHY).join('&shy;');
}

/** Sustituye los pares `**` por marcadores internos (emparejados en todo el campo). */
function markEmphasis(text: string): string {
  const parts = text.replace(INVISIBLE_CHARS_RE, '').split('**');
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
