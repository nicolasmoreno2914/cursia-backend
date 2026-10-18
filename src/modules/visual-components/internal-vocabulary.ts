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
  gender: Gender;
  num: Num;
  /** texto que, si aparece en el contenido del curso, convierte el término en vocabulario del dominio. */
  domainProbe: RegExp;
}

const term = (id: string, label: string, gender: Gender, num: Num, extra?: string): InternalVocabularyRule => {
  const body = extra ?? id;
  return {
    id,
    re: new RegExp(`\\b${body}\\b`, 'gi'),
    label,
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
  term('worked_example', 'ejemplo resuelto', 'm', 's', 'worked[_ ]examples?'),
  term('case_scenario', 'caso', 'm', 's', 'case[_ ]scenarios?'),
  term('concept_cards', 'conceptos clave', 'm', 'p'),
  term('reveal_cards', 'tarjetas para descubrir', 'f', 'p'),
  term('process_steps', 'procedimiento paso a paso', 'm', 's'),
  term('myth_reality', 'contraste entre mitos y realidades', 'm', 's'),
  term('summary_visual', 'síntesis', 'f', 's'),
  term('self_check', 'autoevaluación', 'f', 's'),
  term('learning_objectives', 'objetivos de aprendizaje', 'm', 'p'),
  term('bridge_to_next', 'cierre', 'm', 's'),
  term('video_primer', 'guía previa', 'f', 's'),
  term('guided_practice', 'ejercicios guiados', 'm', 'p'),
  term('application_activity', 'actividad de aplicación', 'f', 's'),
  term('deepening', 'profundización', 'f', 's'),
  term('workshopSolution', 'solución del taller', 'f', 's'),
  term('correctionGuide', 'guía de corrección', 'f', 's'),
  term('teacherNotes', 'notas para el docente', 'f', 'p'),
  term('answerLines', 'espacio de respuesta', 'm', 's'),
  term('exerciseId', 'ejercicio', 'm', 's'),
  // «Texto fuente» = rótulo del prompt para el capítulo; para el lector es el Libro Guía.
  {
    id: 'texto_fuente',
    re: /\btextos? fuentes?\b/gi,
    label: 'Libro Guía',
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
export function repairInternalVocabulary(text: string, exempt: readonly string[] = []): { text: string; fixes: string[] } {
  let s = String(text ?? '');
  const fixes: string[] = [];
  for (const r of INTERNAL_VOCABULARY_RULES) {
    if (exempt.includes(r.id)) continue;
    const re = new RegExp(`\\b${ARTICLE_RE}(${r.re.source.replace(/^\\b/, '').replace(/\\b$/, '')})\\b`, 'gi');
    s = s.replace(re, (_m, art: string | undefined, word: string) => {
      fixes.push(r.id);
      const label = !art && word[0] !== word[0].toLowerCase() ? r.label[0].toUpperCase() + r.label.slice(1) : r.label;
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
 */
export function repairInternalVocabularyDeep<T>(value: T, exempt: readonly string[] = []): { value: T; fixes: string[] } {
  const fixes: string[] = [];
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if ((key !== null && STRUCTURAL_KEYS.has(key)) || !/\s/.test(v)) return v;
      const r = repairInternalVocabulary(v, exempt);
      if (r.fixes.length) fixes.push(...r.fixes);
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object' && !(v instanceof Buffer) && !(v instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) out[k] = walk((v as Record<string, unknown>)[k], k);
      return out;
    }
    return v;
  };
  return { value: walk(value, null) as T, fixes };
}
