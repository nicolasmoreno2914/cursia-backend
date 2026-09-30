/**
 * Chapter/Module Title Normalization (V2.1).
 *
 * Un título de módulo o capítulo es un nombre académico breve (≤ 80). El
 * detalle (temas, alcance) va en `description`. Cuando llega un título largo
 * que mezcla ambos —típicamente un nombre y su descripción pegados (un salto
 * de línea colapsado: "…productos agrícolas Principios y técnicas…")— se
 * separa en `title` + `description` SIN truncar ni agregar «…»: el título es
 * el nombre completo y la descripción conserva el resto. Si no hay una
 * separación clara, NO se inventa un título: null → el caller responde
 * CHAPTER_TITLE_TOO_LONG / MODULE_TITLE_TOO_LONG.
 *
 * Puro: sin DB, sin reloj, sin random. Mismo código lo usan la API, el lock
 * del Blueprint y el script de migración de cursos existentes.
 */

export const STRUCTURE_TITLE_MAX = 80;
/** Título (≤ 1000 de entrada) + descripción previa (≤ 1000) nunca superan esto: no se trunca nada. */
export const STRUCTURE_DESCRIPTION_MAX = 2000;
export const CHAPTER_TITLE_TOO_LONG = 'CHAPTER_TITLE_TOO_LONG';
export const MODULE_TITLE_TOO_LONG = 'MODULE_TITLE_TOO_LONG';
export const STRUCTURE_DESCRIPTION_TOO_LONG = 'STRUCTURE_DESCRIPTION_TOO_LONG';

export interface StructureTitleSplit {
  title: string;
  /** Detalle separado del título, completo (null si no había nada que separar). */
  description: string | null;
  /** true si el título cambió (espacios colapsados, prefijo quitado o separado). */
  changed: boolean;
}

const MIN_TITLE_LEN = 8;
const UPPER = 'A-ZÁÉÍÓÚÜÑ';
const LOWER = 'a-záéíóúüñ';
/** "Módulo 1: …", "Capítulo 3 — …", "Unidad II. …": la numeración la pone el editor; no es el título. */
// Número arábigo o romano en MAYÚSCULAS (1–4 letras): "Tema civil: …" NO es un prefijo.
const STRUCTURAL_PREFIX_RE = /^\s*([Mm][oó]dulo|[Cc]ap[ií]tulo|[Uu]nidad|[Tt]ema|[Pp]arte|[Ll]ecci[oó]n|[Ss]esi[oó]n|[Ss]emana|[Bb]loque|M[OÓ]DULO|CAP[IÍ]TULO|UNIDAD|TEMA|PARTE)\s+([0-9]+|[IVXLC]{1,4})\s*[:.\-–—)]\s*/;
/** Un título nunca termina en una palabra funcional ("…Normas de"). */
const FUNCTION_WORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'o', 'u', 'en', 'para', 'con', 'por', 'a', 'al',
  'sobre', 'entre', 'desde', 'hasta', 'sin', 'según', 'un', 'una', 'unos', 'unas', 'que', 'como', 'su', 'sus']);
/** Abreviaturas tras las que ". " NO es fin de oración. */
const ABBREVIATIONS = new Set(['sr', 'sra', 'srta', 'dr', 'dra', 'ing', 'lic', 'prof', 'p', 'ej', 'etc', 'núm', 'num', 'no', 'nro', 'pág', 'pag',
  'aprox', 'vs', 'fig', 'cap', 'art', 'inc', 'ltda', 'cía', 'cia', 'av', 'min', 'máx', 'max', 'mín', 'depto', 'dpto', 'ud', 'uds', 'ee', 'uu']);

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cleanHead(s: string): string {
  return collapse(s).replace(/[\s:;,.\-–—|·(]+$/u, '').trim();
}

/** Mayúscula inicial solo si empieza con una palabra normal (nunca toca "p. ej.", siglas, números). */
function capitalize(s: string): string {
  if (!s) return s;
  const first = s.split(' ')[0];
  if (/[.]/.test(first) || !new RegExp(`^[${LOWER}]`, 'u').test(first)) return s;
  return s.charAt(0).toLocaleUpperCase('es') + s.slice(1);
}

function wordCount(s: string): number {
  return s.split(' ').filter(Boolean).length;
}

/**
 * Candidatos de corte [fin del título, inicio del resto], en orden de preferencia:
 * 1) separadores explícitos (salto de línea, " — ", " – ", " - ", ": ", ". ",
 *    " | ", "; "), el PRIMERO que deje un título válido — salvo ". " tras una
 *    abreviatura, una sigla/palabra ≤ 3 letras o un número, y " - " entre dígitos;
 * 2) frontera de oración sin puntuación (salto de línea colapsado:
 *    "…productos agrícolas Principios y técnicas…"): el ÚLTIMO que todavía
 *    deje un título ≤ max — así un nombre propio dentro del título
 *    ("Excel Avanzado", "Colombia") no lo corta antes de tiempo.
 */
function explicitCandidates(raw: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const nl = raw.search(/\r?\n/);
  if (nl > 0) out.push([nl, nl]);
  const sepRe = /\s[—–-]\s|:\s|\.\s|\s\|\s|;\s/g;
  for (let m = sepRe.exec(raw); m; m = sepRe.exec(raw)) {
    const before = raw.slice(0, m.index);
    const after = raw.slice(m.index + m[0].length);
    if (m[0] === '. ') {
      const tok = (before.match(/([\p{L}\p{N}]+)$/u) || [''])[0];
      if (!tok || tok.length <= 3 || /^\p{N}+$/u.test(tok) || ABBREVIATIONS.has(tok.toLowerCase())) continue;
    }
    if (/[—–-]/.test(m[0]) && /\p{N}$/u.test(before) && /^\p{N}/u.test(after)) continue;
    out.push([m.index, m.index + m[0].length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function caseBoundaryCandidates(raw: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const caseRe = new RegExp(`([${LOWER}0-9)])\\s+(?=[${UPPER}][${LOWER}])`, 'gu');
  for (let m = caseRe.exec(raw); m; m = caseRe.exec(raw)) out.push([m.index + m[1].length, m.index + m[0].length]);
  return out.sort((a, b) => b[0] - a[0]); // del último al primero
}

function acceptableHead(head: string, max: number): boolean {
  if (head.length < MIN_TITLE_LEN || head.length > max || wordCount(head) < 2) return false;
  if (STRUCTURAL_PREFIX_RE.test(head + ': ') && wordCount(head) <= 2) return false; // "Capítulo 3"
  const last = head.split(' ').pop()!.toLowerCase();
  return !FUNCTION_WORDS.has(last);
}

function trySplit(original: string, headEnd: number, restStart: number, max: number): StructureTitleSplit | null {
  const head = cleanHead(original.slice(0, headEnd));
  if (!acceptableHead(head, max)) return null;
  const rest = collapse(original.slice(restStart)).replace(/^[\s:;,\-–—|·]+/u, '');
  return { title: head, description: rest ? capitalize(rest) : null, changed: true };
}

/**
 * Normaliza un título de módulo/capítulo. ≤ max → igual (espacios colapsados).
 * Si no: quita un prefijo estructural ("Capítulo 3: ") y, si sigue largo,
 * separa en título (≥ 2 palabras, MIN_TITLE_LEN..max, sin terminar en palabra
 * funcional) + descripción COMPLETA. null si no hay un corte natural (nunca
 * trunca ni agrega «…»).
 */
export function normalizeStructureTitle(raw: string, max: number = STRUCTURE_TITLE_MAX): StructureTitleSplit | null {
  const original = String(raw ?? '');
  const flat = collapse(original);
  if (flat.length <= max) return { title: flat, description: null, changed: flat !== original };
  const unprefixed = original.replace(STRUCTURAL_PREFIX_RE, '');
  if (unprefixed !== original) {
    const again = normalizeStructureTitle(unprefixed, max);
    return again ? { ...again, changed: true } : null;
  }
  for (const [h, r] of explicitCandidates(original)) {
    const s = trySplit(original, h, r, max);
    if (s) return s;
  }
  for (const [h, r] of caseBoundaryCandidates(original)) {
    const s = trySplit(original, h, r, max);
    if (s) return s;
  }
  return null;
}

/** Alias con el nombre del requerimiento (capítulos). */
export const normalizeChapterTitle = normalizeStructureTitle;

/**
 * Descripción resultante SIN perder texto: si no había, la separada del título;
 * si había y la separada no está ya incluida, se agrega al final. Nunca trunca:
 * el caller rechaza (API) o deja sin resolver (migración) si supera el máximo.
 */
export function mergeDescription(existing: string | null | undefined, split: string | null): string | null {
  const e = collapse(String(existing ?? ''));
  const sp = collapse(String(split ?? ''));
  if (!e) return sp || null;
  if (!sp || e.includes(sp)) return e;
  return `${e} ${sp}`;
}

/**
 * EV5 — título para MOSTRAR en el paquete (Moodle, H5P, labels): nunca > STRUCTURE_TITLE_MAX.
 * Cursos creados antes de Title Normalization (o importados) pueden traer «Título + descripción»
 * cortado a 255 a mitad de palabra; al empaquetar se usa el título normalizado. Sin corte natural,
 * se corta en el último límite de palabra ≤ max sin dejar una palabra funcional ni puntuación al
 * final (nunca «…» ni media palabra). Títulos ≤ max: solo espacios colapsados (idéntico al actual).
 */
const DISPLAY_TITLE_MIN_SPLIT = 32;
export function displayStructureTitle(raw: string, max: number = STRUCTURE_TITLE_MAX): string {
  const n = normalizeStructureTitle(raw, max);
  // Un título separado muy corto («Introducción a Excel» de un título de 120) cambia el sentido:
  // en ese caso se prefiere el corte por palabra, que conserva más del nombre.
  if (n && n.title.length <= max && (!n.changed || n.description === null || n.title.length >= DISPLAY_TITLE_MIN_SPLIT)) return n.title;
  const words = collapse(String(raw ?? '')).split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  let parts = cleanHead(out || collapse(String(raw ?? '')).slice(0, max)).split(' ');
  while (parts.length > 2 && FUNCTION_WORDS.has(parts[parts.length - 1].toLowerCase())) parts = parts.slice(0, -1);
  return cleanHead(parts.join(' '));
}
