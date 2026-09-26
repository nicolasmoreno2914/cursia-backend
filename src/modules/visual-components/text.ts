/**
 * R2 — Visual Components: texto plano → HTML inline seguro.
 *
 * - Escapa TODO (& < > " ').
 * - `**énfasis**` → <strong>. Un `**` sin pareja queda literal.
 * - Doble salto de línea → párrafos; salto simple → <br>.
 * - Palabras largas reciben guiones suaves (&shy;) deterministas: bajo forceclean=1
 *   Moodle elimina overflow-wrap/word-break y <wbr> (probado, §X.1), y el &shy; es lo
 *   único que sobrevive para evitar desborde horizontal a 390 px. Solo se ve un guion
 *   si el navegador realmente corta la palabra.
 */

export interface HyphenOpts {
  /** Longitud mínima (code points) de una palabra para recibir guiones suaves. */
  minLen: number;
  /** Un guion suave cada N code points. */
  every: number;
}

export const HYPHEN_DEFAULT: HyphenOpts = { minLen: 14, every: 7 };
/** Celdas de tabla: columnas angostas en móvil sin CSS. */
export const HYPHEN_TABLE: HyphenOpts = { minLen: 8, every: 5 };

const SHY = '\u00AD';

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

function hyphenate(text: string, h: HyphenOpts): string {
  return text.replace(/[^\s]+/g, (w) => hyphenateWord(w, h));
}

/** Escapa + guiones suaves (sin énfasis). Para atributos/labels usar escapeHtml a secas. */
function escapeRun(text: string, h: HyphenOpts): string {
  return escapeHtml(hyphenate(text, h)).split(SHY).join('&shy;');
}

/** Una línea de texto con `**énfasis**` → HTML inline. */
export function inlineHtml(text: string, h: HyphenOpts = HYPHEN_DEFAULT): string {
  const parts = String(text).split('**');
  // Un número par de partes significa un `**` sin cerrar: el último se deja literal.
  const unbalanced = parts.length % 2 === 0;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const isLastUnbalanced = unbalanced && i === parts.length - 1;
    if (isLastUnbalanced) {
      out += escapeRun('**' + parts[i], h);
    } else if (i % 2 === 1) {
      out += `<strong>${escapeRun(parts[i], h)}</strong>`;
    } else {
      out += escapeRun(parts[i], h);
    }
  }
  return out;
}

/** Texto (posiblemente con saltos de línea) → HTML inline con <br> entre líneas. */
export function multilineInlineHtml(text: string, h: HyphenOpts = HYPHEN_DEFAULT): string {
  return String(text)
    .split(/\r?\n/)
    .map((line) => inlineHtml(line.trim(), h))
    .join('<br>');
}

/** Divide en párrafos por línea en blanco (se descartan vacíos). */
export function splitParagraphs(text: string): string[] {
  const ps = String(text)
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return ps.length ? ps : [String(text).trim()];
}
