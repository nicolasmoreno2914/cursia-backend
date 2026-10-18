/**
 * T1 (r57) — vocabulario INTERNO del generador que nunca debe verlo el estudiante ni el docente.
 *
 * Causa raíz (curso real auditado): los prompts nombran los bloques por su id técnico («worked_example»,
 * «case_scenario»…) y rotulan el capítulo como «Texto fuente»; el modelo a veces copia ese vocabulario en la
 * prosa («la situación ilustrativa del worked_example», «según el texto fuente»). Los lints existentes
 * (RESOURCE_MENTION, QUANTITY_CLAIM) no lo cubrían.
 *
 * Tres capas (genéricas, sin llamadas a IA):
 *   1. prompt (44): prohíbe esos nombres y pide lenguaje natural;
 *   2. reparación DETERMINÍSTICA al empaquetar (`repairInternalVocabularyDeep`): reemplaza cada término por su
 *      nombre pedagógico con el artículo correcto («del worked_example» → «del ejemplo resuelto») y quita
 *      marcas de cita/delimitadores del prompt («[S12]», «<<<CAPITULO»);
 *   3. validador del paquete (`lintInternalVocabulary`, INTERNAL_VOCABULARY): un label/página con un término
 *      interno hace fallar el paquete.
 * Excepción por dominio: si el CONTENIDO del propio curso (el Libro) usa el término (p. ej. un curso de
 * traducción habla de «texto fuente»; uno de pedagogía, de «worked example»), es vocabulario del tema y la
 * regla no aplica a ese curso (`internalVocabularyExemptions`).
 *
 * Review r1:
 *  - I2: el texto que escribió una PERSONA (títulos del curso/módulos/capítulos del Blueprint, título e instrucciones
 *    de un archivo de práctica, textos del perfil, referencias importadas de su documento) nunca se repara ni bloquea:
 *    se pasa como `protectedTexts` (la reparación no lo toca) y el validador lo quita antes de buscar términos.
 *  - I3: `repairInternalVocabularyDeep(…, { noGrowth: true })` nunca alarga un texto (caracteres ni palabras): prueba
 *    el rótulo completo, después el corto (`shortLabel`) y, si los dos alargan, deja el original y lo informa
 *    (`kept`). El builder lo usa solo si la reparación completa empujó un campo más allá de su límite.
 */

type Gender = 'm' | 'f';
type Num = 's' | 'p';

export interface InternalVocabularyRule {
  /** id estable de la regla (aparece en avisos y exenciones). */
  id: string;
  /** término tal como lo emite el modelo (sin artículo). */
  re: RegExp;
  /** reemplazo en lenguaje natural ('' = se elimina). */
  label: string;
  /** Review r1 (I3): reemplazo corto (una palabra, mismo género y número) para un campo al límite de su largo. */
  shortLabel: string;
  gender: Gender;
  num: Num;
  /** texto que, si aparece en el contenido del curso, convierte el término en vocabulario del dominio. */
  domainProbe: RegExp;
}

const term = (id: string, label: string, gender: Gender, num: Num, extra?: string, shortLabel?: string): InternalVocabularyRule => {
  const body = extra ?? id;
  return {
    id,
    re: new RegExp(`\\b${body}\\b`, 'gi'),
    label,
    shortLabel: shortLabel ?? label,
    gender,
    num,
    domainProbe: new RegExp(`\\b${body}\\b`, 'i'),
  };
};

/**
 * Ids técnicos de bloques/movimientos/campos que los prompts usan. Solo identificadores con «_» o palabras
 * inglesas que no son español (nunca palabras corrientes como «hero», «tabs» o «closing»: podrían ser del tema).
 */
export const INTERNAL_VOCABULARY_RULES: readonly InternalVocabularyRule[] = Object.freeze([
  term('worked_example', 'ejemplo resuelto', 'm', 's', 'worked[_ ]examples?', 'ejemplo'),
  term('case_scenario', 'caso', 'm', 's', 'case[_ ]scenarios?'),
  term('concept_cards', 'conceptos clave', 'm', 'p', undefined, 'conceptos'),
  term('reveal_cards', 'tarjetas para descubrir', 'f', 'p', undefined, 'tarjetas'),
  term('process_steps', 'procedimiento paso a paso', 'm', 's', undefined, 'procedimiento'),
  term('myth_reality', 'contraste entre mitos y realidades', 'm', 's', undefined, 'contraste'),
  term('summary_visual', 'síntesis', 'f', 's'),
  term('self_check', 'autoevaluación', 'f', 's', undefined, 'prueba'),
  term('learning_objectives', 'objetivos de aprendizaje', 'm', 'p', undefined, 'objetivos'),
  term('bridge_to_next', 'cierre', 'm', 's'),
  term('video_primer', 'guía previa', 'f', 's', undefined, 'guía'),
  term('guided_practice', 'ejercicios guiados', 'm', 'p', undefined, 'ejercicios'),
  term('application_activity', 'actividad de aplicación', 'f', 's', undefined, 'actividad'),
  term('deepening', 'profundización', 'f', 's', undefined, 'extensión'),
  term('workshopSolution', 'solución del taller', 'f', 's', undefined, 'solución'),
  term('correctionGuide', 'guía de corrección', 'f', 's', undefined, 'pauta'),
  term('teacherNotes', 'notas para el docente', 'f', 'p', undefined, 'notas'),
  term('answerLines', 'espacio de respuesta', 'm', 's', undefined, 'espacio'),
  term('exerciseId', 'ejercicio', 'm', 's'),
  // «Texto fuente» = rótulo del prompt para el capítulo; para el lector es el Libro Guía.
  {
    id: 'texto_fuente',
    re: /\btextos? fuentes?\b/gi,
    label: 'Libro Guía',
    shortLabel: 'Libro',
    gender: 'm',
    num: 's',
    domainProbe: /\btextos? fuentes?\b/i,
  },
]);

/** Marcas del prompt sin lectura natural (siempre se eliminan; no dependen del dominio). */
const PROMPT_MARKERS: ReadonlyArray<{ id: string; re: RegExp }> = Object.freeze([
  // Marcas de evidencia de los bancos/contexto: «[S12]», «[S3, S4]».
  { id: 'citation_tag', re: /\s?\[S\d{1,4}(?:\s*[,;]\s*S?\d{1,4})*\]/g },
  // Delimitadores de bloques del prompt.
  { id: 'prompt_delimiter', re: /\s?(?:<<<[A-ZÁÉÍÓÚÑ_]{3,}|[A-ZÁÉÍÓÚÑ_]{3,}>>>)/g },
]);

const ARTICLE_RE = '(?:(del|al|el|la|los|las|un|una|unos|unas)\\s+)?';

function article(found: string, g: Gender, n: Num): string {
  const lower = found.toLowerCase();
  const indefinite = /^un/.test(lower);
  const prep = lower === 'del' ? 'de' : lower === 'al' ? 'a' : '';
  let art: string;
  if (indefinite) art = n === 'p' ? (g === 'm' ? 'unos' : 'unas') : g === 'm' ? 'un' : 'una';
  else art = n === 'p' ? (g === 'm' ? 'los' : 'las') : g === 'm' ? 'el' : 'la';
  let out = prep ? (art === 'el' ? (prep === 'de' ? 'del' : 'al') : `${prep} ${art}`) : art;
  if (found[0] && found[0] !== found[0].toLowerCase()) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

export interface InternalVocabularyHit {
  rule: string;
  match: string;
}

/** Reglas exentas para un curso: las que su propio contenido (Libro) usa como vocabulario del tema. */
export function internalVocabularyExemptions(domainTexts: Iterable<string>): string[] {
  const all = Array.from(domainTexts, (t) => String(t ?? '')).join('\n');
  return INTERNAL_VOCABULARY_RULES.filter((r) => r.domainProbe.test(all)).map((r) => r.id);
}

/** Hallazgos de vocabulario interno en un texto visible. */
export function lintInternalVocabulary(text: string, exempt: readonly string[] = []): InternalVocabularyHit[] {
  const s = String(text ?? '');
  const out: InternalVocabularyHit[] = [];
  for (const r of INTERNAL_VOCABULARY_RULES) {
    if (exempt.includes(r.id)) continue;
    for (const m of s.matchAll(new RegExp(r.re.source, 'gi'))) out.push({ rule: r.id, match: m[0] });
  }
  for (const p of PROMPT_MARKERS) for (const m of s.matchAll(new RegExp(p.re.source, 'g'))) out.push({ rule: p.id, match: m[0].trim() });
  return out;
}

/** Reparación determinística de UN texto. Devuelve el texto y las reglas aplicadas. */
export function repairInternalVocabulary(text: string, exempt: readonly string[] = [], opts: { short?: boolean } = {}): { text: string; fixes: string[] } {
  let s = String(text ?? '');
  const fixes: string[] = [];
  for (const r of INTERNAL_VOCABULARY_RULES) {
    if (exempt.includes(r.id)) continue;
    const re = new RegExp(`\\b${ARTICLE_RE}(${r.re.source.replace(/^\\b/, '').replace(/\\b$/, '')})\\b`, 'gi');
    const base = opts.short ? r.shortLabel : r.label;
    s = s.replace(re, (_m, art: string | undefined, word: string) => {
      fixes.push(r.id);
      const label = !art && word[0] !== word[0].toLowerCase() ? base[0].toUpperCase() + base.slice(1) : base;
      return art ? `${article(art, r.gender, r.num)} ${label}` : label;
    });
  }
  for (const p of PROMPT_MARKERS) {
    s = s.replace(new RegExp(p.re.source, 'g'), () => {
      fixes.push(p.id);
      return '';
    });
  }
  if (fixes.length) s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1');
  return { text: s, fixes };
}

/** Largo que cuentan los validadores de esquema: caracteres (code points) y palabras. */
function measure(t: string): { chars: number; words: number } {
  const trimmed = t.trim();
  return { chars: Array.from(t).length, words: trimmed ? trimmed.split(/\s+/).length : 0 };
}

/**
 * Review r1 (I2): fragmentos de texto escrito por una persona que contienen un término interno (solo esos importan:
 * el resto no cambia nada). Se parten por línea para que coincidan con el texto visible ya renderizado.
 */
export function protectedVocabularyTexts(texts: Iterable<unknown>, exempt: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const line of t.split(/\r?\n/)) {
      const frag = line.replace(/\s+/g, ' ').trim();
      if (frag.length >= 3 && lintInternalVocabulary(frag, exempt).length) out.add(frag);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function protectedRe(protectedTexts: readonly string[]): RegExp | null {
  if (!protectedTexts.length) return null;
  const esc = protectedTexts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return new RegExp(`(${esc.join('|')})`, 'gi');
}

/** Review r1 (I2): quita del texto visible los fragmentos escritos por una persona (no se juzgan). */
export function stripProtectedVocabularyTexts(text: string, protectedTexts: readonly string[] = []): string {
  const re = protectedRe(protectedTexts);
  return re ? String(text ?? '').replace(re, ' ') : String(text ?? '');
}

/** Repara solo los tramos que NO son texto protegido (escrito por una persona). */
function repairOutsideProtected(text: string, exempt: readonly string[], re: RegExp | null, short: boolean): { text: string; fixes: string[] } {
  if (!re) return repairInternalVocabulary(text, exempt, { short });
  const parts = text.split(re);
  const fixes: string[] = [];
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // tramo protegido (grupo capturado)
    const r = repairInternalVocabulary(part, exempt, { short });
    fixes.push(...r.fixes);
    return r.text;
  });
  return { text: out.join(''), fixes };
}

/**
 * Claves estructurales que nunca se tocan (ids, tipos, rutas, referencias de evidencia que deben citar el
 * contenido tal cual). Un string sin espacios tampoco se toca: es un identificador, no prosa.
 */
const STRUCTURAL_KEYS = new Set([
  'id', 'type', 'kind', 'variant', 'icon', 'chapterId', 'moduleId', 'exerciseId', 'scope', 'level', 'evidence', 'refs', 'ref',
  'library', 'machineName', 'subContentId', 'contentType', 'storagePath', 'sha256', 'url', 'youtubeId', 'promptVersion', 'mimeType',
]);

/**
 * Reparación determinística en profundidad (copia; nunca muta la entrada). `fixes` cuenta cada reemplazo por regla.
 * Review r1: `protectedTexts` (I2) nunca se tocan; `noGrowth` (I3) nunca alarga un texto — rótulo completo, después
 * el corto y, si ambos alargan, el original queda tal cual (`kept`: reglas que quedaron sin reparar).
 */
export function repairInternalVocabularyDeep<T>(
  value: T,
  exempt: readonly string[] = [],
  opts: { protectedTexts?: readonly string[]; noGrowth?: boolean } = {},
): { value: T; fixes: string[]; shortened: string[]; kept: string[] } {
  const fixes: string[] = [];
  const shortened: string[] = [];
  const kept: string[] = [];
  const re = protectedRe(opts.protectedTexts ?? []);
  const fits = (orig: string, next: string): boolean => {
    const a = measure(orig);
    const b = measure(next);
    return b.chars <= a.chars && b.words <= a.words;
  };
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if ((key !== null && STRUCTURAL_KEYS.has(key)) || !/\s/.test(v)) return v;
      const r = repairOutsideProtected(v, exempt, re, false);
      if (!r.fixes.length) return v;
      if (!opts.noGrowth || fits(v, r.text)) {
        fixes.push(...r.fixes);
        return r.text;
      }
      const sh = repairOutsideProtected(v, exempt, re, true);
      if (fits(v, sh.text)) {
        fixes.push(...sh.fixes);
        shortened.push(...sh.fixes);
        return sh.text;
      }
      kept.push(...r.fixes);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object' && !(v instanceof Buffer) && !(v instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) out[k] = walk((v as Record<string, unknown>)[k], k);
      return out;
    }
    return v;
  };
  return { value: walk(value, null) as T, fixes, shortened, kept };
}
