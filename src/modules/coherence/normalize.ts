/**
 * Fase 7 — normalización determinística de textos cortos (sin embeddings).
 *
 * `norm(s)`: minúsculas, sin acentos ni puntuación, sin stopwords en español
 * y con un stemming liviano de plurales (`-es` / `-s`). La similaridad se
 * reporta con dos métricas: Jaccard de tokens normalizados y Jaccard de
 * trigramas de caracteres (spec Fase 7 §2).
 *
 * Cambiar cualquier cosa de este archivo cambia los findings: hay que subir
 * `NORMALIZE_VERSION` y el ruleset (`coherence-rules@N`).
 */

export const NORMALIZE_VERSION = 1;

export const SPANISH_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'al', 'algo', 'algun', 'alguna', 'algunas', 'alguno', 'algunos', 'ante', 'antes', 'asi',
  'aun', 'bajo', 'cada', 'como', 'con', 'contra', 'cual', 'cuales', 'cuando', 'de', 'del',
  'desde', 'donde', 'durante', 'e', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era',
  'es', 'esa', 'esas', 'ese', 'eso', 'esos', 'esta', 'estan', 'estas', 'este', 'esto', 'estos',
  'fue', 'ha', 'han', 'hacia', 'hasta', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas',
  'mediante', 'muy', 'ni', 'no', 'nos', 'o', 'otra', 'otras', 'otro', 'otros', 'para', 'pero',
  'por', 'que', 'se', 'segun', 'ser', 'si', 'sin', 'sobre', 'son', 'su', 'sus', 'tal', 'tambien',
  'tan', 'tras', 'u', 'un', 'una', 'unas', 'uno', 'unos', 'y', 'ya',
]);

/** Minúsculas + sin diacríticos (NFD) + todo lo no alfanumérico → espacio. */
export function stripToAscii(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Stemming liviano de plurales:
 *  - `-ces` → `-z` (luces → luz)
 *  - `-es` tras consonante r/l/n/d/j (motores → motor, redes → red)
 *  - `-s` final (bombas → bomba, clases → clase), salvo `-ss`, `-is`, `-us`
 * Palabras de 3 letras o menos no se tocan.
 */
export function stemPlural(w: string): string {
  if (w.length <= 3) return w;
  if (w.length > 4 && w.endsWith('ces')) return w.slice(0, -3) + 'z';
  if (w.length > 4 && w.endsWith('es') && 'rlndj'.includes(w[w.length - 3])) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('is') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

/** Tokens normalizados (con repetidos, en orden de aparición). */
export function normTokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of stripToAscii(s).split(' ')) {
    if (!raw || SPANISH_STOPWORDS.has(raw)) continue;
    out.push(stemPlural(raw));
  }
  return out;
}

/** Forma normalizada canónica de un texto: tokens unidos por un espacio. */
export function norm(s: string): string {
  return normTokens(s).join(' ');
}

export function tokenSet(s: string): Set<string> {
  return new Set(normTokens(s));
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function tokenJaccard(a: string, b: string): number {
  return jaccard(tokenSet(a), tokenSet(b));
}

/**
 * Coeficiente de contención (overlap): |A∩B| / min(|A|,|B|) sobre tokens
 * normalizados. 0 si alguno de los dos no tiene tokens.
 */
export function tokenContainment(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  const min = Math.min(sa.size, sb.size);
  if (min === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / min;
}

/** Trigramas de caracteres del texto normalizado, con un espacio de borde. */
export function trigrams(s: string): Set<string> {
  const n = norm(s);
  const out = new Set<string>();
  if (!n) return out;
  const padded = ` ${n} `;
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function trigramJaccard(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** Redondeo estable para evidencia (evita ruido de coma flotante en los ids). */
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
