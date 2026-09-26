// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — guiones de audio de un run rulesVersion 3.
//
//  - Bienvenida (`audio_welcome`): el texto `welcome` del JSON de course_intro
//    (validado por R11a). Determinístico, sin LLM.
//  - Audiolibro (`audiobook_chapter:<ch>`): guion narrativo de UN capítulo,
//    estilo clase hablada, con los mismos prompts y umbrales del legacy
//    probado (audio-worker.ts: ~480 palabras, mínimo 350 medido con conteo
//    real, UNA continuación acotada si queda corto). Diferencia: si tras la
//    continuación sigue corto, falla fuerte (nunca se narra un capítulo
//    recortado en silencio — CLAUDE.md, historial #2/#9).
// Puro salvo el `llm` inyectado.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIOBOOK_WORDS_PER_CHAPTER = 480;
export const AUDIOBOOK_MIN_WORDS_PER_CHAPTER = 350;
export const AUDIOBOOK_EXCERPT_CHARS = 2200;
/** Modelo del guion: el mismo que fuerza el frontend (`_generateAudiobookNarrativeScript`) y el prior del estimador. */
export const AUDIOBOOK_SCRIPT_MODEL_DEFAULT = 'claude-sonnet-4-6';
export const AUDIOBOOK_SCRIPT_MODEL_ENV = 'DYNAMIC_AUDIOBOOK_SCRIPT_MODEL';
/** Tope del TTS por llamada (mismo margen que el legacy: TTS_MAX_CHARS 3900 < 4096 de OpenAI). */
export const TTS_MAX_CHARS = 3900;

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
  sector?: string | null;
  nivel?: string | null;
  contentMarkdown: string;
}

export interface ScriptPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

/** Prompt del bloque narrado de UN capítulo (texto del legacy generateChapterNarrationBlock). */
export function chapterNarrationPrompt(i: ChapterScriptInput): ScriptPrompt {
  const sectorLine = i.sector ? ` orientado a ${i.sector}` : '';
  const nivelLine = i.nivel ? `, nivel ${i.nivel}` : '';
  const excerpt = cleanAudioText(i.contentMarkdown).slice(0, AUDIOBOOK_EXCERPT_CHARS);
  const system =
    'Eres un narrador experto en educación. Escribe un bloque narrado de audiolibro para UN ' +
    'capítulo de un curso de formación, estilo clase hablada.\n\n' +
    'REGLAS:\n' +
    `- Entre ${AUDIOBOOK_MIN_WORDS_PER_CHAPTER} y ${AUDIOBOOK_WORDS_PER_CHAPTER + 120} palabras.\n` +
    '- NO leas el contenido literalmente — resume, explica y conecta las ideas principales, con ejemplos prácticos y cotidianos.\n' +
    '- Tono natural, conversacional y educativo, como una clase narrada en voz alta.\n' +
    '- Empieza con una frase de transición hacia este capítulo.\n' +
    '- No inventes datos técnicos, estadísticas o citas que no estén en el extracto de referencia.\n' +
    '- Texto plano, sin markdown, sin títulos, sin listas, sin asteriscos.\n' +
    '- Responde SOLO con el bloque narrado, sin preámbulos ni explicaciones.';
  const user =
    `Capítulo ${i.chapterNumber} — ${i.chapterTitle} del curso "${i.courseTitle}"${sectorLine}${nivelLine}.\n\n` +
    `Extracto de referencia:\n${excerpt}\n\n` +
    `Escribe el bloque narrado de este capítulo (${AUDIOBOOK_MIN_WORDS_PER_CHAPTER}-${AUDIOBOOK_WORDS_PER_CHAPTER + 120} palabras).`;
  return { system, user, maxTokens: 1500 };
}

/** Prompt de la continuación acotada (texto del legacy continueChapterNarrationBlock). */
export function chapterContinuationPrompt(existingText: string, chapterTitle: string, wordsNeeded: number): ScriptPrompt {
  const system =
    'Eres un narrador experto en educación. Vas a CONTINUAR (no repetir ni resumir) un bloque ' +
    'narrado de audiolibro que quedó corto. Sigue de forma natural desde donde se detuvo, mismo ' +
    'tono y estilo, desarrollando con más ejemplos concretos, matices o aplicaciones prácticas.\n\n' +
    'REGLAS:\n' +
    `- Añade aproximadamente ${wordsNeeded} palabras más.\n` +
    '- NO repitas ni resumas lo ya escrito — continúa la idea.\n' +
    '- Mismo tono conversacional, estilo clase hablada.\n' +
    '- Texto plano, sin markdown.\n' +
    '- Responde SOLO con el texto de continuación, sin preámbulos.';
  const user =
    `Capítulo: ${chapterTitle}.\n\n` +
    `Texto ya escrito (continúa desde aquí, NO lo repitas):\n"""\n${existingText.slice(-700)}\n"""\n\n` +
    `Continúa añadiendo aproximadamente ${wordsNeeded} palabras más.`;
  return { system, user, maxTokens: 900 };
}

export type ScriptCallRole = 'main' | 'continuation';

/** Llamada LLM inyectada: devuelve el texto (la medición al ledger la hace el caller). */
export type ScriptLlm = (prompt: ScriptPrompt, role: ScriptCallRole) => Promise<{ text: string; messageId: string }>;

export interface ChapterScriptResult {
  script: string;
  words: number;
  messageIds: string[];
  continued: boolean;
}

/**
 * Guion de un capítulo: 1 llamada; si queda por debajo del mínimo, UNA
 * continuación acotada; si sigue corto → AUDIOBOOK_SCRIPT_TOO_SHORT (reintentable:
 * el item vuelve a pedirse, cada llamada queda medida en el ledger).
 */
export async function generateChapterScript(input: ChapterScriptInput, llm: ScriptLlm): Promise<ChapterScriptResult> {
  if (!cleanAudioText(input.contentMarkdown)) {
    throw new AudioScriptError('AUDIOBOOK_CONTENT_EMPTY', `el capítulo ${input.chapterNumber} no tiene contenido para narrar`, false);
  }
  const main = await llm(chapterNarrationPrompt(input), 'main');
  const messageIds = [main.messageId];
  let block = cleanAudioText(main.text);
  let continued = false;
  if (wordCount(block) < AUDIOBOOK_MIN_WORDS_PER_CHAPTER) {
    const needed = Math.max(60, AUDIOBOOK_WORDS_PER_CHAPTER - wordCount(block));
    const cont = await llm(chapterContinuationPrompt(block, input.chapterTitle, needed), 'continuation');
    messageIds.push(cont.messageId);
    continued = true;
    block = `${block} ${cleanAudioText(cont.text)}`.replace(/\s+/g, ' ').trim();
  }
  const words = wordCount(block);
  if (words < AUDIOBOOK_MIN_WORDS_PER_CHAPTER) {
    throw new AudioScriptError(
      'AUDIOBOOK_SCRIPT_TOO_SHORT',
      `el guion del capítulo ${input.chapterNumber} quedó con ${words} palabras (mínimo ${AUDIOBOOK_MIN_WORDS_PER_CHAPTER}) tras una continuación`,
      true,
    );
  }
  return { script: block, words, messageIds, continued };
}
