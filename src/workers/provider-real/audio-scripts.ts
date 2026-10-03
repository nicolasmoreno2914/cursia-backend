// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — guiones de audio de un run rulesVersion 3.
//
//  - Bienvenida (`audio_welcome`): el texto `welcome` del JSON de course_intro
//    (validado por R11a). Determinístico, sin LLM.
//  - Audiolibro (`audiobook_chapter:<ch>`), r19 (bloque A): el capítulo se narra
//    COMPLETO. Antes (legacy V1) era un resumen de ~480 palabras escrito desde
//    los primeros 2.200 caracteres (≈13 % del capítulo) → 7–14 min por curso.
//    Ahora: plan de bloques `##` que cubre TODO el Markdown (nunca se recorta),
//    UN guion por bloque adaptado para escuchar (≈90 % de las palabras de la
//    fuente; banda 85–110 %, UNA continuación si queda corto, falla fuerte si
//    sigue fuera), tablas/listas/glosario verbalizados (no se omiten), y
//    segmentos de TTS con clave determinística (`seg-<bloque>-<parte>-<sha>`).
// Puro salvo el `llm` inyectado.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'crypto';
import {
  AUDIOBOOK_MAX_RATIO,
  AUDIOBOOK_MIN_RATIO,
  AUDIOBOOK_TARGET_RATIO,
  AUDIOBOOK_WPM_REF,
} from '../../package/audio/audiobook-policy';

/** Modelo del guion: el mismo que fuerza el frontend (`_generateAudiobookNarrativeScript`) y el prior del estimador. */
export const AUDIOBOOK_SCRIPT_MODEL_DEFAULT = 'claude-sonnet-4-6';
export const AUDIOBOOK_SCRIPT_MODEL_ENV = 'DYNAMIC_AUDIOBOOK_SCRIPT_MODEL';
/** Tope del TTS por llamada (mismo margen que el legacy: TTS_MAX_CHARS 3900 < 4096 de OpenAI). */
export const TTS_MAX_CHARS = 3900;
/** Bloques del plan: se juntan secciones `##` chicas hasta ~250 palabras; una sección > 900 se parte por párrafos (~600). */
export const AUDIOBOOK_CHUNK_MIN_WORDS = 250;
export const AUDIOBOOK_CHUNK_MAX_WORDS = 900;
export const AUDIOBOOK_CHUNK_SPLIT_WORDS = 600;
/** Cola del guion del bloque anterior que va como pista de continuidad. */
export const AUDIOBOOK_PREV_TAIL_CHARS = 500;
/** Anti-bucle: una frase de 12 palabras no puede repetirse más de 2 veces en el capítulo. */
export const AUDIOBOOK_SHINGLE_WORDS = 12;
export const AUDIOBOOK_SHINGLE_MAX_REPEATS = 2;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class AudioScriptError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = 'AudioScriptError';
  }
}

/** Mismo limpiador que el legacy (audio-worker.ts cleanAudioText). */
export function cleanAudioText(raw: string): string {
  return (raw || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|[^\n]+\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[*\-+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/---+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(text: string): number {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

/** Mismo partidor por oraciones que el legacy (splitText); nunca devuelve un trozo vacío. */
export function splitForTts(text: string, maxChars: number = TTS_MAX_CHARS): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxChars) return [t];
  const parts: string[] = [];
  const sentences = t.split(/(?<=[.!?])\s+/);
  let current = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      // Oración gigante (sin puntuación): corte duro por palabras.
      if (current) { parts.push(current); current = ''; }
      let chunk = '';
      for (const w of s.split(/\s+/)) {
        if ((chunk + ' ' + w).trim().length > maxChars && chunk) { parts.push(chunk); chunk = w; } else chunk = (chunk + ' ' + w).trim();
      }
      if (chunk) parts.push(chunk);
      continue;
    }
    if ((current + ' ' + s).trim().length > maxChars && current.length > 0) {
      parts.push(current.trim());
      current = s;
    } else {
      current = (current + ' ' + s).trim();
    }
  }
  if (current) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

/** Texto de la bienvenida desde el JSON validado de course_intro (R11a `CourseIntroV3.welcome`). */
export function welcomeScriptFromCourseIntro(doc: unknown): string {
  const w = (doc as { welcome?: unknown } | null)?.welcome;
  if (typeof w !== 'string' || !w.trim()) {
    throw new AudioScriptError('AUDIO_WELCOME_TEXT_MISSING', 'el course_intro no tiene un texto `welcome` utilizable', false);
  }
  return cleanAudioText(w);
}

export interface ChapterScriptInput {
  courseTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Title Normalization: detalle del capítulo (contexto; el título sigue siendo breve). */
  chapterDescription?: string | null;
  sector?: string | null;
  nivel?: string | null;
  /** R14: país del curso → tuteo (voseo solo en Argentina/Uruguay/Paraguay). */
  pais?: string | null;
  contentMarkdown: string;
}

const AUDIO_VOSEO_COUNTRIES = ['argentina', 'uruguay', 'paraguay'];
/** R14: el guion del audiolibro derivaba al voseo en un curso para Colombia. */
export function audioLocaleRule(pais?: string | null): string {
  const p = String(pais ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (AUDIO_VOSEO_COUNTRIES.includes(p)) return '- Español con el trato habitual del país.\n';
  return '- Español latinoamericano con tuteo (tú: «usas», «puedes», «quieres»); nunca voseo («vos», «usás», «podés», «querés»).\n';
}

/**
 * R14-11: el guion parafraseaba una cifra inventada del capítulo («Hattie: la retroalimentación
 * triplica el aprendizaje» → «la multiplica significativamente»). Va en narración Y continuación.
 */
export const AUDIO_TRUTH_RULE =
  '- No inventes ni exageres datos, estadísticas, estudios ni citas, ni multiplicadores atribuidos a investigación ' +
  '(«duplica», «triplica», «multiplica el aprendizaje»): si el extracto trae una cifra así, no la repitas; ' +
  'habla de la idea sin cuantificarla.\n';

/**
 * R14-13: el guion terminaba anunciando apartados que no narraba ("En el siguiente apartado vamos a
 * ver… los sesgos") y citaba el prompt ("El extracto del curso…"). r19: cada bloque del guion cierra
 * con una idea completa (los cortes entre bloques no coinciden con los anuncios del texto).
 */
export const AUDIO_SCOPE_RULE =
  '- No anuncies apartados, secciones o temas siguientes que no vas a narrar («en el siguiente apartado…»), ' +
  'ni menciones «el extracto», «el texto» o «el material de referencia»; cierra el bloque con una idea completa.\n';

export interface ScriptPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// r19 — plan de bloques del capítulo (cubre TODO el Markdown, nunca recorta)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Limpiador del texto NARRADO del audiolibro (r19 fix round 1, I3). A diferencia de
 * `cleanAudioText` (bienvenida y Gamma, sin cambios), solo quita SINTAXIS Markdown y
 * nunca texto: conserva el código en línea (sin las comillas invertidas), los `<`/`>`
 * que no son etiquetas HTML reales y el texto entre `|` de una tabla mal formada.
 */
export function cleanNarrationText(raw: string): string {
  return (raw || '')
    .replace(/^\s*(```|~~~)[^\n]*$/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s*[*\-+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tabla Markdown → oraciones habladas: el encabezado UNA vez («Criterio; Opción A; Opción B.») y
 * cada fila («costo; bajo; alto.»). Sirve con o sin `|` en los bordes (GFM). Ninguna celda se
 * pierde y no se agregan palabras (fix round 1, M5: antes el encabezado se repetía por fila).
 */
export function verbalizeMarkdownTables(md: string): string {
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const isSep = (l: string) => l.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isOuterRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const hasPipe = (l: string) => l.includes('|') && l.trim().length > 0;
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const gfm = hasPipe(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]);
    if (!gfm && !isOuterRow(lines[i])) { out.push(lines[i]); continue; }
    const block: string[] = [];
    if (gfm) {
      block.push(lines[i], lines[i + 1]);
      i += 2;
      while (i < lines.length && hasPipe(lines[i]) && !isSep(lines[i])) block.push(lines[i++]);
    } else {
      while (i < lines.length && isOuterRow(lines[i])) block.push(lines[i++]);
    }
    i--;
    const rows = block.filter((l) => !isSep(l)).map(cells);
    out.push('');
    for (const r of rows) {
      const parts = r.filter(Boolean);
      if (parts.length) out.push(`${parts.join('; ')}.`);
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * Palabras de la fuente para el control de cobertura INDEPENDIENTE del limpiador (fix round 1, I3):
 * solo se quita sintaxis (marcas de título/lista/énfasis, bordes de tabla, URLs de enlaces,
 * etiquetas HTML reales). Normalizadas a minúsculas sin puntuación en los bordes.
 */
export function rawSourceTokens(md: string): string[] {
  return (md || '')
    .replace(/^\s*(```|~~~)[^\n]*$/gm, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, ' ')
    .replace(/^\s*\d+\.\s+/gm, ' ')
    .split(/[\s|]+/)
    .map(normToken)
    .filter(Boolean);
}

function normToken(t: string): string {
  return t.toLowerCase().normalize('NFC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Palabras del Markdown CRUDO que no aparecen en ningún texto narrado ni en una sección excluida
 * explícitamente (multiconjunto de tokens normalizados). Independiente del limpiador (fix round 1, I3).
 */
export function planCoverageLoss(md: string, narratedTexts: string[], excludedMarkdown: string[]): string[] {
  const have = new Map<string, number>();
  const add = (t: string) => { const k = normToken(t); if (k) have.set(k, (have.get(k) ?? 0) + 1); };
  for (const x of narratedTexts) for (const t of x.split(/\s+/)) add(t);
  for (const b of excludedMarkdown) for (const t of rawSourceTokens(b)) add(t);
  const lost: string[] = [];
  for (const t of rawSourceTokens(md)) {
    const n = have.get(t) ?? 0;
    if (n > 0) have.set(t, n - 1); else lost.push(t);
  }
  return lost;
}

export interface AudiobookSourceSection {
  idx: number;
  /** Títulos `##` que cubre el bloque (vacío = preámbulo del capítulo). */
  title: string;
  text: string;
  words: number;
  sha256: string;
}

export interface AudiobookSectionPlan {
  /** sha256 del Markdown completo del capítulo. */
  sha256: string;
  /** Palabras narrables de todo el capítulo (incluidas las excluidas). */
  sourceWords: number;
  /** Palabras narrables de los bloques que se narran. */
  narratableWords: number;
  sections: AudiobookSourceSection[];
  excluded: Array<{ title: string; words: number; reason: string }>;
  /** Palabras del Markdown crudo (solo sin sintaxis) y cuántas no aparecen en ningún bloque ni excluido. */
  rawWords: number;
  lostWords: number;
}

/**
 * Bibliografía / referencias / enlaces: no se narran (quedan en el plan y en el manifiesto como
 * excluidos, con sus palabras). Fix round 1 (I3): solo el título EXACTO (sin número), nunca un
 * prefijo: «Referencias normativas del sector» es contenido y se narra.
 */
const EXCLUDED_TITLE_RE = /^(bibliograf[ií]a|referencias|referencias bibliogr[aá]ficas|fuentes|fuentes consultadas|webgraf[ií]a|lecturas recomendadas|enlaces|enlaces de inter[eé]s)\.?$/i;
/** Tolerancia del control de cobertura (diferencias de tokenización): más que esto = contenido perdido. */
export const AUDIOBOOK_COVERAGE_TOLERANCE = Object.freeze({ minWords: 5, ratio: 0.01 });

interface RawBlock { title: string; paragraphs: string[]; words: number }

function paragraphsOf(raw: string): string[] {
  return verbalizeMarkdownTables(raw)
    .split(/\n\s*\n/)
    .map((p) => cleanNarrationText(p))
    .filter((p) => p.length > 0);
}

function splitLongParagraph(p: string, maxWords: number): string[] {
  if (wordCount(p) <= maxWords) return [p];
  const out: string[] = [];
  let cur = '';
  for (const s of p.split(/(?<=[.!?])\s+/)) {
    if (cur && wordCount(`${cur} ${s}`) > maxWords) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Plan de bloques del capítulo. Cada línea del Markdown cae en exactamente un
 * bloque `##` (el preámbulo, antes del primer `##`, es el bloque 0); los bloques
 * chicos se juntan hasta ~250 palabras y uno de más de 900 se parte por párrafos.
 * La suma de palabras de los bloques + excluidos es la del capítulo entero
 * (si no, PLAN_COVERAGE: es un bug del plan, nunca un recorte silencioso).
 */
export function planAudiobookSections(markdown: string): AudiobookSectionPlan {
  const md = (markdown || '').replace(/\r\n?/g, '\n');
  const rawBlocks: Array<{ title: string; body: string }> = [];
  let cur = { title: '', body: '' };
  for (const line of md.split('\n')) {
    const h = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      rawBlocks.push(cur);
      cur = { title: cleanNarrationText(h[1]), body: `${line}\n` };
    } else cur.body += `${line}\n`;
  }
  rawBlocks.push(cur);
  const blocks: RawBlock[] = [];
  const excluded: AudiobookSectionPlan['excluded'] = [];
  for (const b of rawBlocks) {
    const paragraphs = paragraphsOf(b.body);
    const words = paragraphs.reduce((a, p) => a + wordCount(p), 0);
    if (!words) continue;
    if (b.title && EXCLUDED_TITLE_RE.test(b.title)) { excluded.push({ title: b.title, words, reason: 'bibliography' }); continue; }
    blocks.push({ title: b.title, paragraphs, words });
  }
  const sourceWords = blocks.reduce((a, b) => a + b.words, 0) + excluded.reduce((a, e) => a + e.words, 0);

  // Agrupar en bloques del guion.
  type Chunk = { titles: string[]; paragraphs: string[]; words: number };
  const chunks: Chunk[] = [];
  let acc: Chunk | null = null;
  const flush = () => { if (acc && acc.words) chunks.push(acc); acc = null; };
  for (const b of blocks) {
    if (b.words > AUDIOBOOK_CHUNK_MAX_WORDS) {
      flush();
      // Partes de ~600 palabras por párrafos (un párrafo gigante se parte por oraciones).
      const paras = b.paragraphs.flatMap((p) => splitLongParagraph(p, AUDIOBOOK_CHUNK_SPLIT_WORDS));
      let part: Chunk = { titles: [b.title], paragraphs: [], words: 0 };
      for (const p of paras) {
        const w = wordCount(p);
        if (part.words && part.words + w > AUDIOBOOK_CHUNK_SPLIT_WORDS) { chunks.push(part); part = { titles: [b.title], paragraphs: [], words: 0 }; }
        part.paragraphs.push(p);
        part.words += w;
      }
      if (part.words) chunks.push(part);
      continue;
    }
    if (acc && acc.words + b.words > AUDIOBOOK_CHUNK_MAX_WORDS) flush();
    if (!acc) acc = { titles: [], paragraphs: [], words: 0 };
    acc.titles.push(b.title);
    acc.paragraphs.push(...b.paragraphs);
    acc.words += b.words;
    if (acc.words >= AUDIOBOOK_CHUNK_MIN_WORDS) flush();
  }
  if (acc && (acc as Chunk).words) {
    const last = chunks[chunks.length - 1];
    const a = acc as Chunk;
    if (last && last.words + a.words <= AUDIOBOOK_CHUNK_MAX_WORDS) {
      last.titles.push(...a.titles);
      last.paragraphs.push(...a.paragraphs);
      last.words += a.words;
    } else chunks.push(a);
  }
  const sections: AudiobookSourceSection[] = chunks.map((c, idx) => {
    const text = c.paragraphs.join('\n\n');
    return { idx, title: [...new Set(c.titles.filter(Boolean))].join(' · '), text, words: wordCount(text), sha256: sha256(text) };
  });
  const narratableWords = sections.reduce((a, x) => a + x.words, 0);
  const covered = narratableWords + excluded.reduce((a, e) => a + e.words, 0);
  if (covered !== sourceWords) {
    throw new AudioScriptError('AUDIOBOOK_PLAN_COVERAGE', `el plan cubre ${covered} de ${sourceWords} palabras del capítulo`, false);
  }
  // Fix round 1 (I3): cobertura contra el Markdown CRUDO (independiente del limpiador): toda palabra
  // de la fuente tiene que estar en un bloque narrado o en una sección excluida explícitamente.
  const raw = rawSourceTokens(md);
  const lost = planCoverageLoss(md, sections.map((x) => x.text), rawBlocks.filter((b) => b.title && EXCLUDED_TITLE_RE.test(b.title)).map((b) => b.body));
  const tol = Math.max(AUDIOBOOK_COVERAGE_TOLERANCE.minWords, Math.ceil(raw.length * AUDIOBOOK_COVERAGE_TOLERANCE.ratio));
  if (lost.length > tol) {
    throw new AudioScriptError(
      'AUDIOBOOK_PLAN_COVERAGE',
      `${lost.length} de ${raw.length} palabras del capítulo no quedaron en ningún bloque (p. ej. «${lost.slice(0, 8).join(' ')}»)`,
      false,
    );
  }
  return { sha256: sha256(md), sourceWords, narratableWords, sections, excluded, rawWords: raw.length, lostWords: lost.length };
}

export function sectionTargetWords(sourceWords: number): { target: number; min: number; max: number } {
  return {
    target: Math.max(1, Math.round(AUDIOBOOK_TARGET_RATIO * sourceWords)),
    min: Math.ceil(AUDIOBOOK_MIN_RATIO * sourceWords),
    max: Math.floor(AUDIOBOOK_MAX_RATIO * sourceWords),
  };
}

function sectionMaxTokens(target: number): number {
  // Fix round 1 (I4): ~1,8 tokens por palabra en español + margen (antes 1,6: un bloque de 900 palabras podía cortarse).
  return Math.min(3000, Math.max(800, Math.ceil(target * 2) + 200));
}

const SECTION_COMMON_RULES = (pais?: string | null) =>
  '- Conserva TODAS las ideas, ejemplos, cifras, pasos, definiciones y casos del bloque, en el mismo orden. Es una adaptación completa, NO un resumen.\n' +
  '- Convierte listas, tablas y glosarios en oraciones habladas («el primer paso es…», «en la comparación…», «un término clave es…»): su contenido se narra, nunca se omite.\n' +
  '- No agregues información, ejemplos, datos ni temas que no estén en el bloque.\n' +
  '- Tono natural, conversacional y educativo, como una clase narrada en voz alta.\n' +
  AUDIO_TRUTH_RULE +
  AUDIO_SCOPE_RULE +
  audioLocaleRule(pais) +
  '- Texto plano, sin markdown, sin títulos, sin listas, sin asteriscos.\n';

/** Prompt del guion de UN bloque del capítulo (fuente COMPLETA del bloque, sin recorte). */
export function sectionNarrationPrompt(i: ChapterScriptInput, section: AudiobookSourceSection, totalSections: number, prevTail: string | null): ScriptPrompt {
  const { target, min, max } = sectionTargetWords(section.words);
  const sectorLine = i.sector ? ` orientado a ${i.sector}` : '';
  const nivelLine = i.nivel ? `, nivel ${i.nivel}` : '';
  const system =
    'Eres un narrador experto en educación. Adaptas para escuchar un bloque del Libro Guía de un curso de formación: ' +
    'es la versión narrada (audiolibro) del texto, estilo clase hablada.\n\n' +
    'REGLAS:\n' +
    `- Extensión: alrededor de ${target} palabras (entre ${min} y ${max}).\n` +
    SECTION_COMMON_RULES(i.pais) +
    (section.idx === 0
      ? '- Es el primer bloque del capítulo: empieza con una frase breve que presente el capítulo.\n'
      : '- No saludes ni vuelvas a presentar el capítulo: sigue con naturalidad desde el bloque anterior, sin repetirlo.\n') +
    '- Responde SOLO con la narración del bloque, sin preámbulos ni explicaciones.';
  const tail = prevTail && prevTail.trim() ? prevTail.trim().slice(-AUDIOBOOK_PREV_TAIL_CHARS) : '';
  const user =
    `Curso "${i.courseTitle}"${sectorLine}${nivelLine}. Capítulo ${i.chapterNumber} — ${i.chapterTitle}.\n` +
    (i.chapterDescription && i.chapterDescription.trim() ? `De qué trata este capítulo: ${i.chapterDescription.trim()}\n` : '') +
    `Bloque ${section.idx + 1} de ${totalSections}${section.title ? `: «${section.title}»` : ''}.\n\n` +
    (tail ? `Final de la narración del bloque anterior (solo para dar continuidad; NO lo repitas):\n"""\n${tail}\n"""\n\n` : '') +
    `Texto del bloque (${section.words} palabras):\n"""\n${section.text}\n"""\n\n` +
    `Escribe la narración de este bloque: alrededor de ${target} palabras (entre ${min} y ${max}).`;
  return { system, user, maxTokens: sectionMaxTokens(target) };
}

/** Continuación del guion de un bloque que quedó corto: narra lo que falte DEL MISMO bloque (nunca relleno). */
export function sectionContinuationPrompt(
  existingText: string,
  section: AudiobookSourceSection,
  chapterTitle: string,
  wordsNeeded: number,
  pais?: string | null,
): ScriptPrompt {
  const system =
    'Eres un narrador experto en educación. Vas a CONTINUAR (no repetir ni resumir) la narración de audiolibro de un ' +
    'bloque que quedó corta: narra las ideas, ejemplos, pasos y datos del bloque que todavía no se narraron, siguiendo ' +
    'de forma natural desde donde se detuvo.\n\n' +
    'REGLAS:\n' +
    `- Añade aproximadamente ${wordsNeeded} palabras más.\n` +
    '- NO repitas ni resumas lo ya narrado.\n' +
    SECTION_COMMON_RULES(pais) +
    '- Responde SOLO con el texto de continuación, sin preámbulos.';
  const user =
    `Capítulo: ${chapterTitle}. Bloque ${section.idx + 1}${section.title ? `: «${section.title}»` : ''}.\n\n` +
    `Texto del bloque:\n"""\n${section.text}\n"""\n\n` +
    `Narración ya escrita (continúa desde aquí, NO la repitas):\n"""\n${existingText.slice(-AUDIOBOOK_PREV_TAIL_CHARS - 200)}\n"""\n\n` +
    `Continúa añadiendo aproximadamente ${wordsNeeded} palabras más.`;
  return { system, user, maxTokens: sectionMaxTokens(wordsNeeded) };
}

export type ScriptCallRole = 'main' | 'continuation';

/** Llamada LLM inyectada: devuelve el texto (la medición al ledger la hace el caller). */
export type ScriptLlm = (prompt: ScriptPrompt, role: ScriptCallRole) => Promise<{ text: string; messageId: string; truncated?: boolean }>;

export interface SectionScriptResult {
  idx: number;
  sourceSha: string;
  sourceWords: number;
  text: string;
  words: number;
  ratio: number;
  continued: boolean;
  messageIds: string[];
}

function ratioOf(words: number, source: number): number {
  return Math.round((words / Math.max(1, source)) * 1000) / 1000;
}

/**
 * Guion de UN bloque: 1 llamada; por debajo del 85 % de la fuente → UNA
 * continuación acotada; sigue corto → AUDIOBOOK_SECTION_TOO_SHORT; por encima
 * del 110 % → AUDIOBOOK_SECTION_PADDED. Ambos reintentables con resultado
 * CONOCIDO (cada llamada queda medida; los bloques ya aceptados no se repagan).
 */
export async function generateSectionScript(
  input: ChapterScriptInput,
  section: AudiobookSourceSection,
  totalSections: number,
  prevTail: string | null,
  llm: ScriptLlm,
): Promise<SectionScriptResult> {
  const { target, min, max } = sectionTargetWords(section.words);
  const main = await llm(sectionNarrationPrompt(input, section, totalSections, prevTail), 'main');
  const messageIds = [main.messageId];
  let text = cleanNarrationText(main.text);
  let continued = false;
  if (wordCount(text) > max) {
    throw new AudioScriptError(
      'AUDIOBOOK_SECTION_PADDED',
      `el guion del bloque ${section.idx + 1} del capítulo ${input.chapterNumber} tiene ${wordCount(text)} palabras para ${section.words} de fuente (máximo ${max}): no se narra relleno`,
      true,
    );
  }
  // Fix round 1 (I4): una salida cortada por max_tokens nunca se acepta tal cual, aunque caiga en la
  // banda: se trata como corta (UNA continuación que la termina).
  if (wordCount(text) < min || main.truncated) {
    const w = wordCount(text);
    const needed = w < target ? Math.max(1, target - w) : Math.max(1, Math.min(max - w, Math.ceil(section.words * 0.05)));
    if (w >= max) {
      throw new AudioScriptError('AUDIOBOOK_SECTION_TRUNCATED', `el guion del bloque ${section.idx + 1} del capítulo ${input.chapterNumber} se cortó por max_tokens sin margen para terminarlo`, true);
    }
    const cont = await llm(sectionContinuationPrompt(text, section, input.chapterTitle, needed, input.pais), 'continuation');
    messageIds.push(cont.messageId);
    continued = true;
    if (cont.truncated) {
      throw new AudioScriptError('AUDIOBOOK_SECTION_TRUNCATED', `la continuación del bloque ${section.idx + 1} del capítulo ${input.chapterNumber} se cortó por max_tokens: no se narra un bloque cortado`, true);
    }
    text = `${text} ${cleanNarrationText(cont.text)}`.replace(/\s+/g, ' ').trim();
  }
  const words = wordCount(text);
  if (words < min) {
    throw new AudioScriptError(
      'AUDIOBOOK_SECTION_TOO_SHORT',
      `el guion del bloque ${section.idx + 1} del capítulo ${input.chapterNumber} quedó con ${words} palabras para ${section.words} de fuente (mínimo ${min}) tras una continuación`,
      true,
    );
  }
  if (words > max) {
    throw new AudioScriptError(
      'AUDIOBOOK_SECTION_PADDED',
      `el guion del bloque ${section.idx + 1} del capítulo ${input.chapterNumber} quedó con ${words} palabras para ${section.words} de fuente (máximo ${max}) tras una continuación`,
      true,
    );
  }
  return { idx: section.idx, sourceSha: section.sha256, sourceWords: section.words, text, words, ratio: ratioOf(words, section.words), continued, messageIds };
}

/** Normalización para comparar narración (minúsculas, sin tildes ni puntuación). */
function normForRepetition(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function countShingles(text: string, out: Map<string, number>): void {
  const w = normForRepetition(text).split(' ').filter(Boolean);
  for (let i = 0; i + AUDIOBOOK_SHINGLE_WORDS <= w.length; i++) {
    const k = w.slice(i, i + AUDIOBOOK_SHINGLE_WORDS).join(' ');
    out.set(k, (out.get(k) ?? 0) + 1);
  }
}

/** Oraciones de ≥ 8 palabras (normalizadas) de un texto, con su cuenta. */
function countSentences(text: string, out: Map<string, number>): void {
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const n = normForRepetition(s);
    if (n.split(' ').length >= 8) out.set(n, (out.get(n) ?? 0) + 1);
  }
}

/**
 * Anti-duplicado / anti-bucle sobre el guion del capítulo: bloques idénticos, una oración
 * repetida DENTRO de un bloque, o una frase de 12 palabras repetida más de 2 veces. Fix round 1
 * (M4): lo que ya se repite en la fuente no cuenta. Devuelve los índices de bloque implicados en
 * orden de posición (vacío = sin repetición): el caller descarta el primero si es uno solo
 * (bucle dentro de un bloque, I2) o todos salvo el primero si son varios.
 */
export function findScriptRepetition(
  sections: Array<{ idx: number; text: string }>,
  sources?: Array<{ idx: number; text: string }> | null,
): { idxs: number[]; detail: string } {
  const srcShingles = new Map<string, number>();
  const srcSentences = new Map<string, number>();
  for (const s of sources ?? []) { countShingles(s.text, srcShingles); countSentences(s.text, srcSentences); }
  const ordered = [...sections].sort((a, b) => a.idx - b.idx);
  const seen = new Map<string, number>();
  for (const s of ordered) {
    const n = normForRepetition(s.text);
    if (seen.has(n)) return { idxs: [seen.get(n) as number, s.idx], detail: `los bloques ${(seen.get(n) as number) + 1} y ${s.idx + 1} son idénticos` };
    seen.set(n, s.idx);
  }
  for (const s of ordered) {
    const sent = new Map<string, number>();
    countSentences(s.text, sent);
    for (const [k, c] of sent) {
      if (c > 1 && c > (srcSentences.get(k) ?? 0)) return { idxs: [s.idx], detail: `el bloque ${s.idx + 1} repite la oración «${k.slice(0, 80)}» ${c} veces` };
    }
  }
  const counts = new Map<string, { n: number; idxs: Set<number> }>();
  for (const s of ordered) {
    const local = new Map<string, number>();
    countShingles(s.text, local);
    for (const [k, c0] of local) {
      const c = counts.get(k) ?? { n: 0, idxs: new Set<number>() };
      c.n += c0;
      c.idxs.add(s.idx);
      counts.set(k, c);
      if (c.n > Math.max(AUDIOBOOK_SHINGLE_MAX_REPEATS, srcShingles.get(k) ?? 0)) {
        return { idxs: [...c.idxs].sort((a, b) => a - b), detail: `la frase «${k}» se repite ${c.n} veces` };
      }
    }
  }
  return { idxs: [], detail: '' };
}

/** Bloques a descartar ante una repetición: el único (bucle interno) o todos salvo el primero por posición. */
export function blocksToDropForRepetition(idxs: number[]): number[] {
  const sorted = [...idxs].sort((a, b) => a - b);
  return sorted.length <= 1 ? sorted : sorted.slice(1);
}

// ─── r19 fix round 1 (I1): completar desde la fuente un capítulo por debajo de su duración objetivo ───

/** Duración mínima del capítulo: 0,85 × palabras de fuente narrables al ritmo de referencia (141 ppm). */
export function chapterTargetSeconds(narratableWords: number): number {
  return (AUDIOBOOK_MIN_RATIO * narratableWords * 60) / AUDIOBOOK_WPM_REF;
}

/** Tope por pasada de una ampliación: +25 % de las palabras de la fuente del bloque. */
export const AUDIOBOOK_EXTENSION_MAX_FRACTION = 0.25;
/** Se pide al menos esto por ampliación (si el bloque tiene margen); un bloque con menos de 3 palabras de margen no se amplía. */
export const AUDIOBOOK_EXTENSION_MIN_WORDS = 10;
export const AUDIOBOOK_EXTENSION_MIN_ROOM = 3;

/**
 * Qué bloques ampliar para cubrir `deficitWords`: primero los de MENOR ratio (los que el LLM más
 * condensó), cada uno hasta el 110 % de su fuente y +25 % por pasada; se corta al cubrir el déficit.
 */
export function planChapterExtension(
  blocks: Array<{ idx: number; sourceWords: number; scriptWords: number }>,
  deficitWords: number,
): Array<{ idx: number; words: number }> {
  const out: Array<{ idx: number; words: number }> = [];
  let left = Math.ceil(deficitWords);
  const sorted = [...blocks].sort((a, b) => a.scriptWords / Math.max(1, a.sourceWords) - b.scriptWords / Math.max(1, b.sourceWords) || a.idx - b.idx);
  for (const b of sorted) {
    if (left <= 0) break;
    const room = Math.min(Math.floor(AUDIOBOOK_MAX_RATIO * b.sourceWords) - b.scriptWords, Math.ceil(AUDIOBOOK_EXTENSION_MAX_FRACTION * b.sourceWords));
    if (room < AUDIOBOOK_EXTENSION_MIN_ROOM) continue;
    const words = Math.min(room, Math.max(left, AUDIOBOOK_EXTENSION_MIN_WORDS));
    out.push({ idx: b.idx, words });
    left -= words;
  }
  return out;
}

/**
 * UNA continuación acotada y fundada en la fuente del bloque (sectionContinuationPrompt: narra lo
 * que falte del bloque). Nunca supera `maxWords`: si el LLM se excede o se corta por max_tokens, se
 * conserva hasta la última oración completa dentro del tope (nunca media oración).
 */
export async function generateSectionExtension(
  input: ChapterScriptInput,
  section: AudiobookSourceSection,
  existingText: string,
  words: number,
  maxWords: number,
  llm: ScriptLlm,
): Promise<{ text: string; words: number; messageIds: string[] }> {
  const r = await llm(sectionContinuationPrompt(existingText, section, input.chapterTitle, words, input.pais), 'continuation');
  let text = cleanNarrationText(r.text);
  if (r.truncated || wordCount(text) > maxWords) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    let kept = '';
    for (const s of sentences) {
      if (!/[.!?]$/.test(s) && r.truncated) break; // la oración cortada nunca entra
      if (wordCount(`${kept} ${s}`) > maxWords) break;
      kept = kept ? `${kept} ${s}` : s;
    }
    text = kept;
  }
  return { text, words: wordCount(text), messageIds: [r.messageId] };
}

export interface AudiobookSegmentPlan {
  /** Clave determinística e idempotente entre intentos: seg-<bloque>-<parte>-<sha256(texto)[:12]>. */
  key: string;
  sectionIdx: number;
  partIdx: number;
  text: string;
  textSha: string;
  words: number;
  chars: number;
}

/**
 * Segmentos del TTS (splitForTts por bloque), en orden de narración. Las ampliaciones de un bloque
 * (fix round 1, I1) van detrás de él con su propia clave `seg-<bloque>-x<n>-<parte>-<sha12>`: los
 * segmentos ya pagados del bloque no cambian de clave y se reutilizan.
 */
export function audiobookSegments(sections: Array<{ idx: number; text: string; extensions?: string[] }>): AudiobookSegmentPlan[] {
  const out: AudiobookSegmentPlan[] = [];
  const push = (keyBase: string, sectionIdx: number, partIdx: number, text: string) => {
    const textSha = sha256(text);
    out.push({ key: `${keyBase}-${textSha.slice(0, 12)}`, sectionIdx, partIdx, text, textSha, words: wordCount(text), chars: text.length });
  };
  for (const s of [...sections].sort((a, b) => a.idx - b.idx)) {
    splitForTts(s.text).forEach((text, partIdx) => push(`seg-${s.idx}-${partIdx}`, s.idx, partIdx, text));
    (s.extensions ?? []).forEach((ext, n) => {
      splitForTts(ext).forEach((text, p) => push(`seg-${s.idx}-x${n}-${p}`, s.idx, 1000 * (n + 1) + p, text));
    });
  }
  return out;
}
