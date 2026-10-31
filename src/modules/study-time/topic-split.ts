// r80 · Capítulos reales: los subtemas que el documento YA enumera en un contenido («Saludos, presentaciones, alfabeto,
// números, información personal y verbo to be») se reparten en capítulos diferenciados cuando el curso necesita más
// capítulos de contenido para su carga horaria. Reemplaza a la «Profundización N: <módulo>» genérica (mismo objetivo en
// todos, sin tema propio): un capítulo nuevo solo existe si el documento trae un subtema que lo justifique.
//
// Función pura y determinista: no llama a proveedores ni inventa texto. Cada título nuevo sale de las palabras del
// documento (los subtemas, en su orden) y cada capítulo dice de qué contenido viene (trazabilidad). Si el texto no es una
// enumeración clara (prosa, una sola idea, ítems largos), no se divide nada.
import { STRUCTURE_TITLE_MAX } from '../course-structure/structure-titles';

export const TOPIC_SPLIT_VERSION = 1 as const;

export const TOPIC_SPLIT_RULES = Object.freeze({
  version: TOPIC_SPLIT_VERSION,
  /** Un ítem de más palabras ya no es un subtema enumerado sino prosa: el texto no se divide. */
  maxItemWords: 9,
  /** Cada capítulo nuevo lleva al menos 2 subtemas; con un número impar, UNO de los capítulos (el primero) lleva uno solo. */
  minItemsPerPart: 2,
});

/**
 * Formas del idioma que se enseña (cursos de lengua extranjera): «like, love, don’t like y can» es UN subtema (las formas
 * para expresar gustos), no cuatro. Lista corta y versionada de palabras funcionales del inglés.
 */
const LANGUAGE_FORMS = new Set([
  'be', 'to', 'is', 'are', 'am', 'was', 'were', 'there', 'like', 'likes', 'love', 'loves', 'hate', 'hates', 'can', "can't", 'cannot',
  'do', 'does', "don't", "doesn't", 'did', 'have', 'has', 'got', 'will', 'would', 'going', 'want', 'need', 'must', 'should', 'may',
  'might', 'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'much', 'many', 'how', 'what', 'where', 'when', 'who',
  'why', 'which', 'not', 'it', 'he', 'she', 'we', 'they', 'you', 'i', 'my', 'your', 'his', 'her', 'our', 'their',
]);

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const normQuote = (s: string) => s.replace(/[’‘`´]/g, "'");

/** Ítem que es una forma del idioma enseñado («like», «don’t like», «there is / there are»). */
function isLanguageForm(item: string): boolean {
  const ws = words(normQuote(item).toLowerCase()).filter((w) => w !== '/');
  if (!ws.length || ws.length > 4) return false;
  return ws.every((w) => /^[a-z']+$/.test(w)) && ws.some((w) => LANGUAGE_FORMS.has(w));
}

/** Separa por un separador que no esté dentro de paréntesis. */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0) {
      const m = sep.exec(text.slice(i));
      if (m && m.index === 0) {
        out.push(cur);
        cur = '';
        i += m[0].length - 1;
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Marcadores de lista («- », «• », «1. », «2) ») y conjunción suelta de la coma de Oxford («, y trabajo en equipo»); un
// número que es parte del tema («7 herramientas de calidad») se conserva.
const cleanItem = (s: string) => s.replace(/^\s*(?:[-–•·*]+\s*|\d+[.)]\s+)/, '').replace(/^(?:y|e)\s+(?=\S)/i, '').replace(/[.;:]+$/, '').trim();

/**
 * Subtemas que enumera un texto del documento, en su orden. [] si no es una enumeración clara (menos de 2 subtemas,
 * un ítem demasiado largo o prosa). «A, B, C y D» → [A, B, C, D]; también listas con «;» o con viñetas.
 */
export function subtopicsOf(text: string | null | undefined): string[] {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!raw) return [];
  const lines = String(text ?? '').split(/\n+/).map(cleanItem).filter(Boolean);
  let items: string[];
  if (lines.length >= 2) items = lines;
  else if (/;\s/.test(raw)) items = splitTop(raw, /^;\s*/).map(cleanItem);
  else {
    items = splitTop(raw, /^,\s+/).map(cleanItem);
    if (items.length < 2) return [];
    // Gramática de la enumeración en español: solo el ÚLTIMO ítem lleva la conjunción («…, C y D»).
    const last = items.pop() as string;
    const tail = splitTop(last, /^\s+(?:y|e)\s+/i);
    items.push(...(tail.length === 2 ? tail : [last]));
  }
  items = items.map(cleanItem).filter(Boolean);
  // «actividades de tiempo libre y like»: la forma del idioma que sigue a la conjunción es otro subtema.
  items = items.flatMap((it) => {
    const m = /^(.+?)\s+(?:y|e)\s+(.+)$/i.exec(it);
    return m && isLanguageForm(m[2]) && !isLanguageForm(m[1]) ? [m[1].trim(), m[2].trim()] : [it];
  });
  // Formas del idioma consecutivas = un solo subtema («like, love, don’t like y can»).
  const merged: string[] = [];
  for (let i = 0; i < items.length; ) {
    if (isLanguageForm(items[i]) && i + 1 < items.length && isLanguageForm(items[i + 1])) {
      let j = i;
      while (j < items.length && isLanguageForm(items[j])) j++;
      merged.push(joinList(items.slice(i, j)));
      i = j;
    } else merged.push(items[i++]);
  }
  if (merged.length < 2) return [];
  if (merged.some((it) => words(it).length > TOPIC_SPLIT_RULES.maxItemWords || it.length < 2)) return [];
  return merged;
}

/** «A», «A y B», «A, B y C» (con «e» delante de i- / hi-). */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const last = items[items.length - 1];
  const conj = /^(h?i)(?![aeoué])/i.test(last) ? 'e' : 'y';
  return `${items.slice(0, -1).join(', ')} ${conj} ${last}`;
}

const capFirst = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('es') + s.slice(1) : s);

/** Cuántos capítulos admite un contenido con n subtemas (al menos 2 subtemas por capítulo; uno puede llevar uno). */
export function maxPartsFor(n: number, cap = Infinity): number {
  if (n < 2) return 1;
  return Math.max(1, Math.min(cap, Math.ceil(n / TOPIC_SPLIT_RULES.minItemsPerPart)));
}

/**
 * Reparte los subtemas en k grupos CONSECUTIVOS (se conserva el orden del documento = la progresión) lo más parejos
 * posible; los grupos más chicos van primero (los primeros temas suelen ser los más simples).
 */
export function partitionSubtopics(items: string[], k: number): string[][] {
  const n = items.length;
  const parts = Math.max(1, Math.min(k, n));
  const base = Math.floor(n / parts);
  const extra = n % parts;
  const out: string[][] = [];
  let i = 0;
  for (let g = 0; g < parts; g++) {
    const size = base + (g >= parts - extra ? 1 : 0);
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Título de un capítulo con estos subtemas (texto del documento; si no cabe, los primeros que caben y «y otros temas»). */
export function partTitle(group: string[]): string {
  const full = capFirst(joinList(group));
  if (full.length <= STRUCTURE_TITLE_MAX) return full;
  for (let k = group.length - 1; k >= 1; k--) {
    const t = capFirst(`${group.slice(0, k).join(', ')} y otros temas`);
    if (t.length <= STRUCTURE_TITLE_MAX) return t;
  }
  const w = words(capFirst(group[0]));
  let t = '';
  for (const x of w) { if ((t ? `${t} ${x}` : x).length > STRUCTURE_TITLE_MAX) break; t = t ? `${t} ${x}` : x; }
  return t || capFirst(group[0]).slice(0, STRUCTURE_TITLE_MAX);
}

/** Descripción de un capítulo dividido: sus subtemas y de qué contenido del documento vienen. */
export function partDescription(group: string[], sourceText: string): string {
  return `Subtemas: ${joinList(group)}. Del contenido del documento «${sourceText.replace(/\s+/g, ' ').trim().replace(/\.$/, '')}».`;
}

/**
 * Subtemas de un capítulo existente: los de su descripción si la descripción es el texto completo del contenido (el título
 * se recorta a 80 caracteres), si no los del título. Un capítulo ya dividido por Cursia (descripción «Subtemas: …») usa los
 * suyos. [] = no se puede dividir.
 */
export function chapterSubtopics(ch: { title: string; description?: string | null }): { items: string[]; source: string } {
  const title = String(ch.title ?? '').trim();
  const desc = String(ch.description ?? '').trim();
  const own = /^Subtemas: (.+?)\. Del contenido del documento «/.exec(desc);
  if (own) return { items: subtopicsOf(own[1]), source: desc };
  const fromTitle = subtopicsOf(title);
  const fromDesc = subtopicsOf(desc);
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // La descripción continúa el título (mismo comienzo) y trae más subtemas: es el contenido completo.
  if (desc.length > title.length && fromDesc.length >= fromTitle.length && norm(desc).startsWith(norm(title).split(' ').slice(0, 3).join(' '))) return { items: fromDesc, source: desc };
  return fromTitle.length ? { items: fromTitle, source: title } : { items: [], source: title };
}
