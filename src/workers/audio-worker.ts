import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { TtsService } from '../tts/tts.service';
import {
  ProductionJobsService,
  AudioWorkerProgressSummary,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { EventsService } from '../events/events.service';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isTrueEnv(envKey: string): boolean {
  return String(process.env[envKey] || '').toLowerCase() === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers (mirrors 35-tts-audio.js logic)
// ─────────────────────────────────────────────────────────────────────────────

const TTS_MAX_CHARS = 3900;
const AUDIOBOOK_EXCERPT_CHARS = 2200; // chars de extracto por cap — suficiente material real para no rellenar con paja
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// El guion narrativo se genera POR CAPÍTULO (una llamada corta por capítulo) en vez de una
// sola llamada pidiendo 4000+ palabras de una vez — los modelos cumplen objetivos cortos de
// forma mucho más confiable que objetivos largos en una sola respuesta. Ver
// generateAudiobookScript() más abajo para el diagnóstico completo. Mismo fix aplicado en
// campuscloud-gen/src/js/35-tts-audio.js (frontend) — este worker es la ruta que de verdad
// corre en la generación normal de un curso (P10 — ruta backend), el frontend es fallback.
const AUDIOBOOK_MODEL_OVERRIDE        = 'gpt-4o'; // forzado para el guion narrativo — gpt-4o-mini no cumple objetivos de longitud de forma confiable
const AUDIOBOOK_WORDS_PER_CHAPTER     = 480;  // objetivo por bloque narrado de capítulo (~30 min total en 9 caps + intro/cierre)
const AUDIOBOOK_MIN_WORDS_PER_CHAPTER = 350;  // umbral real (conteo de palabras) — por debajo dispara 1 continuación acotada a ese capítulo
const AUDIOBOOK_INTRO_WORDS           = 140;  // objetivo del bloque de introducción
const AUDIOBOOK_CLOSING_WORDS         = 140;  // objetivo del bloque de cierre

function cleanAudioText(raw: string): string {
  return (raw || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|[^\n]+\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[\*\-\+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/---+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length > maxChars && current.length > 0) {
      parts.push(current.trim());
      current = s;
    } else {
      current = (current + ' ' + s).trim();
    }
  }
  if (current) parts.push(current.trim());
  return parts.length ? parts : [text.slice(0, maxChars)];
}

function buildWelcomeScript(courseData: Record<string, any>): string {
  const nombre = courseData.nombre || 'este curso';
  let obj = (courseData.obj || '').replace(
    /^(el estudiante (podrá|será|tendrá)|aprenderás?( a)?)/i,
    '',
  ).trim();
  const mods: any[] = Array.isArray(courseData.mods) ? courseData.mods : [];
  const caps: any[] = Array.isArray(courseData.caps) ? courseData.caps : [];
  const numMods = mods.length || 3;
  const numCaps = caps.length || 9;
  const modNames = mods.map((m: any) => m.n).filter(Boolean);
  const modLine = modNames.length > 0
    ? modNames.join(', ')
    : `${numMods} módulos y ${numCaps} capítulos`;
  const objLine = obj
    ? obj.charAt(0).toUpperCase() + obj.slice(1)
    : 'desarrollar habilidades prácticas y conocimientos aplicables en tu campo';

  const parts = [
    `Bienvenido al curso ${nombre}.`,
    `En este espacio aprenderás a ${objLine}.`,
    `El curso está organizado en ${modLine}, combinando contenido teórico, ejemplos prácticos y actividades de evaluación.`,
    'Te recomendamos revisar el libro guía, completar las actividades y dedicar tiempo constante al estudio.',
    '¡Esperamos que esta experiencia fortalezca tu formación. Comencemos!',
  ].join(' ').replace(/\s+/g, ' ').trim();

  // Trim to 220 words
  const words = parts.split(/\s+/);
  if (words.length > 220) {
    return words.slice(0, 215).join(' ').trimEnd().replace(/[,;:]$/, '') + '.';
  }
  return parts;
}

function wordCount(text: string): number {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

interface ChatCallResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

async function callOpenAiChat(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  apiKey: string,
  model: string = AUDIOBOOK_MODEL_OVERRIDE,
): Promise<ChatCallResult> {
  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI chat completions HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data?.choices?.[0]?.message?.content?.trim() ?? '';

  return {
    text,
    promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
    completionTokens: Number(data?.usage?.completion_tokens ?? 0),
  };
}

async function generateAudiobookIntroBlock(
  nombre: string, modLine: string, sectorLine: string, nivelLine: string, apiKey: string,
): Promise<ChatCallResult> {
  const system =
    'Eres un narrador experto en educación. Escribe SOLO la introducción de un audiolibro ' +
    'narrativo para un curso de formación, estilo clase hablada — tono natural, conversacional, cercano.\n\n' +
    'REGLAS:\n' +
    `- Entre ${AUDIOBOOK_INTRO_WORDS} y ${AUDIOBOOK_INTRO_WORDS + 40} palabras.\n` +
    '- Da la bienvenida y explica brevemente qué recorrido narrado va a cubrir el audiolibro.\n' +
    '- Texto plano, sin markdown, sin títulos, sin listas.\n' +
    '- Responde SOLO con el texto de la introducción, sin preámbulos ni explicaciones.';
  const user =
    `Curso: "${nombre}"${sectorLine}${nivelLine}. Organizado en: ${modLine}.\n\n` +
    `Escribe la introducción del audiolibro (${AUDIOBOOK_INTRO_WORDS}-${AUDIOBOOK_INTRO_WORDS + 40} palabras).`;
  return callOpenAiChat(system, user, 700, apiKey);
}

async function generateAudiobookClosingBlock(
  nombre: string, apiKey: string,
): Promise<ChatCallResult> {
  const system =
    'Eres un narrador experto en educación. Escribe SOLO el cierre de un audiolibro narrativo ' +
    'para un curso de formación, estilo clase hablada — tono natural, conversacional, cercano.\n\n' +
    'REGLAS:\n' +
    `- Entre ${AUDIOBOOK_CLOSING_WORDS} y ${AUDIOBOOK_CLOSING_WORDS + 40} palabras.\n` +
    '- Conclusiones y una reflexión final que invite a seguir aplicando lo aprendido.\n' +
    '- Texto plano, sin markdown, sin títulos, sin listas.\n' +
    '- Responde SOLO con el texto del cierre, sin preámbulos ni explicaciones.';
  const user = `Curso: "${nombre}". Escribe el cierre del audiolibro (${AUDIOBOOK_CLOSING_WORDS}-${AUDIOBOOK_CLOSING_WORDS + 40} palabras).`;
  return callOpenAiChat(system, user, 700, apiKey);
}

async function generateChapterNarrationBlock(
  capN: number, capName: string, excerpt: string,
  nombre: string, sectorLine: string, nivelLine: string, apiKey: string,
): Promise<ChatCallResult> {
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
    `Capítulo ${capN} — ${capName} del curso "${nombre}"${sectorLine}${nivelLine}.\n\n` +
    `Extracto de referencia:\n${excerpt}\n\n` +
    `Escribe el bloque narrado de este capítulo (${AUDIOBOOK_MIN_WORDS_PER_CHAPTER}-${AUDIOBOOK_WORDS_PER_CHAPTER + 120} palabras).`;
  return callOpenAiChat(system, user, 1500, apiKey);
}

async function continueChapterNarrationBlock(
  existingText: string, capName: string, wordsNeeded: number, apiKey: string,
): Promise<ChatCallResult> {
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
    `Capítulo: ${capName}.\n\n` +
    `Texto ya escrito (continúa desde aquí, NO lo repitas):\n"""\n${existingText.slice(-700)}\n"""\n\n` +
    `Continúa añadiendo aproximadamente ${wordsNeeded} palabras más.`;
  return callOpenAiChat(system, user, 900, apiKey);
}

/**
 * Genera el guion narrativo del audiolibro, estilo clase hablada, ~30 minutos de audio.
 * NO lee el contenido literalmente — lo resume y narra como una clase guiada.
 *
 * Antes esto era UNA sola llamada a gpt-4o-mini pidiendo 4000-4800 palabras de golpe. El
 * único chequeo automático era `script.length < 500` (~80-100 palabras) — pasaba de largo
 * un guion de ~1100-1200 palabras (audiolibros de ~7 minutos en vez de ~30). La causa real:
 * un modelo no cumple de forma confiable "escribe 4000+ palabras" en una sola respuesta — sí
 * cumple de forma confiable "escribe 480 palabras". Por eso ahora se genera un bloque corto
 * por capítulo (+ intro/cierre) con gpt-4o (no -mini), cada uno validado con conteo real de
 * palabras, con 1 continuación acotada por capítulo si hace falta. Mismo fix que
 * campuscloud-gen/src/js/35-tts-audio.js (frontend) — este worker es la ruta que corre por
 * defecto en la generación normal de un curso (ver 31-course-production.js, paso 'audio',
 * P10 — ruta backend); el frontend solo corre como fallback si el job del backend falla al
 * crearse.
 */
async function generateAudiobookScript(
  courseData: Record<string, any>,
  bookExcerpts: Record<string, string>,
  apiKey: string,
  logger: Logger,
): Promise<{ script: string; promptTokens: number; completionTokens: number; model: string }> {
  const nombre = courseData.nombre || 'este curso';
  const sector = courseData.sector || '';
  const nivel  = courseData.nivel  || '';
  const mods: any[] = Array.isArray(courseData.mods) ? courseData.mods : [];
  const caps: any[] = Array.isArray(courseData.caps) ? courseData.caps : [];

  const capContexts: Array<{ capN: number; capName: string; excerpt: string }> = [];
  const maxCap = Object.keys(bookExcerpts).length || caps.length || 9;

  for (let i = 1; i <= Math.min(maxCap, 9); i++) {
    const excerpt = bookExcerpts[`cap${i}`];
    if (!excerpt || excerpt.length < 10) continue;
    const capObj = caps[i - 1] ?? {};
    const capName = capObj.t || `Capítulo ${i}`;
    capContexts.push({ capN: i, capName, excerpt: cleanAudioText(excerpt).slice(0, AUDIOBOOK_EXCERPT_CHARS) });
  }

  if (capContexts.length === 0) {
    throw new Error('Sin extractos de capítulos disponibles para generar el guion del audiolibro');
  }

  const modLine = mods.length > 0
    ? mods.map((m: any) => m.n).filter(Boolean).join(', ')
    : `${capContexts.length} capítulos`;

  const sectorLine = sector ? ` orientado a ${sector}` : '';
  const nivelLine  = nivel  ? `, nivel ${nivel}`        : '';

  logger.log(`[AudioWorker] Generating audiobook script por capítulo via OpenAI chat (${capContexts.length} caps, `
    + `~${AUDIOBOOK_WORDS_PER_CHAPTER} palabras c/u, modelo ${AUDIOBOOK_MODEL_OVERRIDE})`);

  let promptTokens = 0;
  let completionTokens = 0;
  const blocks: string[] = [];

  const introResult = await generateAudiobookIntroBlock(nombre, modLine, sectorLine, nivelLine, apiKey);
  promptTokens += introResult.promptTokens;
  completionTokens += introResult.completionTokens;
  if (introResult.text) blocks.push(introResult.text);

  for (const cc of capContexts) {
    const chapterResult = await generateChapterNarrationBlock(
      cc.capN, cc.capName, cc.excerpt, nombre, sectorLine, nivelLine, apiKey,
    );
    promptTokens += chapterResult.promptTokens;
    completionTokens += chapterResult.completionTokens;
    let block = chapterResult.text;
    const wc = wordCount(block);
    logger.log(`[AudioWorker] Cap ${cc.capN} — ${cc.capName}: ${wc} palabras`);

    if (wc < AUDIOBOOK_MIN_WORDS_PER_CHAPTER) {
      const needed = AUDIOBOOK_WORDS_PER_CHAPTER - wc;
      try {
        const contResult = await continueChapterNarrationBlock(block, cc.capName, needed, apiKey);
        promptTokens += contResult.promptTokens;
        completionTokens += contResult.completionTokens;
        if (contResult.text) {
          block = `${block} ${contResult.text}`.replace(/\s+/g, ' ').trim();
          logger.log(`[AudioWorker] Cap ${cc.capN} tras continuación: ${wordCount(block)} palabras`);
        }
      } catch (e) {
        logger.warn(`[AudioWorker] Continuación falló para cap ${cc.capN}: `
          + `${e instanceof Error ? e.message : String(e)} — se usa el bloque tal cual.`);
      }
    }

    blocks.push(block);
  }

  const closingResult = await generateAudiobookClosingBlock(nombre, apiKey);
  promptTokens += closingResult.promptTokens;
  completionTokens += closingResult.completionTokens;
  if (closingResult.text) blocks.push(closingResult.text);

  const script = blocks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  if (!script || script.length < 500) {
    throw new Error(`Guion del audiolibro demasiado corto (${script.length} chars)`);
  }

  const totalWords = wordCount(script);
  logger.log(`[AudioWorker] Audiobook script completo: ${totalWords} words, ${script.length} chars `
    + `(${capContexts.length} capítulos + intro/cierre)`);

  return {
    script,
    promptTokens,
    completionTokens,
    model: AUDIOBOOK_MODEL_OVERRIDE,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact helpers
// ─────────────────────────────────────────────────────────────────────────────

async function findExistingAudioArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
  type: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type });
    if (!list || list.length === 0) return null;
    // Most recent first
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    // Consider valid if size > 0 or size unknown
    if (candidate.sizeBytes !== null && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

async function uploadMp3Artifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
  jobId: string,
  type: string,
  buffer: Buffer,
  metadata: Record<string, any>,
  logger: Logger,
): Promise<Artifact> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${type}_${timestamp}.mp3`;
  const storagePath = `${ownerId}/${courseId}/media/${filename}`;

  logger.log(`[AudioWorker] Uploading ${type} (${buffer.length} bytes) → ${storagePath}`);

  return artifactsService.uploadBufferArtifact({
    ownerId,
    courseId,
    jobId,
    type,
    filename,
    storagePath,
    buffer,
    mimeType: 'audio/mpeg',
    metadata: {
      ...metadata,
      generatedAt: new Date().toISOString(),
      source: 'audio_worker',
      sizeBytes: buffer.length,
    },
    storageBucket: 'cursia-artifacts',
    storageProvider: 'supabase',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core job handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleAudioJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  ttsService: TtsService,
  eventsService: EventsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  logger: Logger,
): Promise<void> {
  const jobId = job.id;
  const payload = (job.inputPayload ?? {}) as Record<string, any>;
  const courseData: Record<string, any> = payload.courseData ?? {};
  const bookExcerpts: Record<string, string> = payload.bookExcerpts ?? {};
  const options = (payload.options ?? {}) as Record<string, any>;

  const generateWelcome   = options.generateWelcomeAudio !== false;
  const generateAudiobook = options.generateAudiobook    !== false;
  const audiobookOptional = options.audiobookOptional    !== false;
  const voice = options.voice || process.env.OPENAI_TTS_VOICE || 'marin';
  const model = options.model || process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';

  const rawCourseId = job.frontendCourseId || String(job.courseId ?? 'unknown');
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  const parentJobId = job.inputPayload?.metadata?.parentJobId ?? null;

  let leaseLost = false;
  let finalized = false;
  let welcomeCharCount = 0;
  let audiobookTtsChars = 0;
  let audiobookPromptTokens = 0;
  let audiobookCompletionTokens = 0;

  const outputSummary: Record<string, any> = {
    welcomeAudio: { status: 'pending' },
    audiobook:    { status: 'pending' },
  };

  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) {
        leaseLost = true;
        logger.warn(`[AudioWorker] Lease lost for job ${jobId}`);
      }
    } catch {
      leaseLost = true;
    }
  };

  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateProgress = async (summary: AudioWorkerProgressSummary) => {
    if (leaseLost) return;
    await jobsService.updateAudioWorkerProgress(jobId, workerId, {
      ...summary,
      welcomeAudio: outputSummary.welcomeAudio,
      audiobook:    outputSummary.audiobook,
    }).catch(() => {});
  };

  const trackEvent = async (eventType: string, extra: Record<string, any> = {}) =>
    eventsService.trackBackendEvent({
      userId: job.ownerId,
      eventType,
      courseId: rawCourseId,
      jobId,
      parentJobId,
      component: extra.component ?? 'audio',
      provider: extra.provider ?? 'openai_tts',
      service: extra.service ?? undefined,
      model: extra.model ?? model,
      mode: extra.mode ?? 'real',
      costType: extra.costType ?? 'unknown',
      estimatedCostUsd: extra.estimatedCostUsd,
      realCostUsd: extra.realCostUsd,
      costSource: extra.costSource ?? 'not_tracked',
      tokensInput: extra.tokensInput,
      tokensOutput: extra.tokensOutput,
      units: extra.units,
      unitType: extra.unitType,
      unitPriceUsd: extra.unitPriceUsd,
      durationMs: extra.durationMs,
      failed: extra.failed ?? false,
      errorMessage: extra.errorMessage ?? null,
      metadata: {
        workerId,
        generateWelcome,
        generateAudiobook,
        ...extra.metadata,
      },
    });

  try {
    const marked = await jobsService.markAudioWorkerRunning(jobId, workerId);
    if (!marked) {
      logger.warn(`[AudioWorker] Job ${jobId} no longer owned by ${workerId}`);
      return;
    }

    await sendHeartbeat();
    if (leaseLost) return;

    // ── Welcome audio ────────────────────────────────────────────────────────

    if (generateWelcome) {
      await updateProgress({ phase: 'generating_welcome', message: 'Creando audio de bienvenida…' });

      // Check if artifact already exists
      const existingWelcome = await findExistingAudioArtifact(
        artifactsService, job.ownerId, rawCourseId, 'audio_welcome',
      );

      if (existingWelcome) {
        logger.log(`[AudioWorker] audio_welcome artifact already exists (${existingWelcome.id}) — skipping`);
        outputSummary.welcomeAudio = {
          status: 'skipped_existing',
          artifactId: existingWelcome.id,
          sizeBytes: existingWelcome.sizeBytes,
          humanMessage: 'Audio de bienvenida ya guardado.',
        };
      } else {
        await trackEvent('welcome_audio_started', {
          component: 'audio',
          provider: 'openai_tts',
          model,
          mode: 'real',
          costType: 'unknown',
        });
        const script = buildWelcomeScript(courseData);
        let welcomeBuffer: Buffer | null = null;
        let welcomeError = '';
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const result = await ttsService.synthesize({ text: script, voice, model, format: 'mp3' });
            welcomeBuffer = result.audioBuffer;
            welcomeCharCount = result.chars;
            break;
          } catch (e) {
            welcomeError = e instanceof Error ? e.message : String(e);
            logger.warn(`[AudioWorker] Welcome audio attempt ${attempt}/${maxAttempts} failed: ${welcomeError}`);
            if (attempt < maxAttempts) await sleep(3000 * attempt);
          }
        }

        if (welcomeBuffer && welcomeBuffer.length > 0) {
          await sendHeartbeat();
          if (leaseLost) return;
          const artifact = await uploadMp3Artifact(
            artifactsService, job.ownerId, rawCourseId, jobId, 'audio_welcome',
            welcomeBuffer,
            { courseName: courseData.nombre || '', voice, model, charCount: script.length },
            logger,
          );
          outputSummary.welcomeAudio = {
            status: 'completed',
            artifactId: artifact.id,
            sizeBytes: welcomeBuffer.length,
            humanMessage: 'Audio de bienvenida listo.',
          };
          await trackEvent('welcome_audio_completed', {
            component: 'audio',
            provider: 'openai_tts',
            service: 'audio_generation',
            model,
            mode: 'real',
            costType: 'estimated',
            costSource: 'configured_rate',
            units: welcomeCharCount,
            unitType: 'per_1k_characters',
            metadata: {
              artifactId: artifact.id,
              sizeBytes: welcomeBuffer.length,
              voice,
            },
          });
          logger.log(`[AudioWorker] Welcome audio uploaded: artifact ${artifact.id}`);
        } else {
          outputSummary.welcomeAudio = {
            status: 'failed_retryable',
            errorCode: 'tts_failed',
            humanMessage: 'No pudimos crear el audio de bienvenida.',
            retryCount: 3,
          };
          logger.error(`[AudioWorker] Welcome audio failed after ${maxAttempts} attempts: ${welcomeError}`);
          // Welcome audio failure → fail the job so it can be retried
          await trackEvent('audio_failed', {
            component: 'audio',
            provider: 'openai_tts',
            model,
            mode: 'real',
            costType: 'unknown',
            failed: true,
            errorMessage: welcomeError,
            metadata: { phase: 'welcome_audio' },
          });
          finalized = true;
          clearInterval(heartbeatTimer);
          await jobsService.failAudioWorkerJob(jobId, workerId, welcomeError, true);
          return;
        }
      }
    } else {
      outputSummary.welcomeAudio = { status: 'skipped_optional' };
    }

    if (leaseLost) return;
    await sendHeartbeat();
    if (leaseLost) return;

    // ── Audiobook ────────────────────────────────────────────────────────────

    if (generateAudiobook) {
      await updateProgress({ phase: 'generating_audiobook', message: 'Preparando audiolibro…' });

      // Check if artifact already exists
      const existingAudiobook = await findExistingAudioArtifact(
        artifactsService, job.ownerId, rawCourseId, 'audiobook',
      );

      if (existingAudiobook) {
        logger.log(`[AudioWorker] audiobook artifact already exists (${existingAudiobook.id}) — skipping`);
        outputSummary.audiobook = {
          status: 'skipped_existing',
          artifactId: existingAudiobook.id,
          sizeBytes: existingAudiobook.sizeBytes,
          humanMessage: 'Audiolibro ya guardado.',
        };
      } else {
        await trackEvent('audiobook_started', {
          component: 'audiobook',
          provider: 'openai',
          model: 'gpt-4o-mini',
          mode: 'real',
          costType: 'unknown',
        });
        const hasExcerpts = Object.keys(bookExcerpts).length > 0;

        if (!hasExcerpts && !courseData.nombre) {
          logger.warn(`[AudioWorker] No book excerpts available for audiobook — skipping`);
          outputSummary.audiobook = {
            status: audiobookOptional ? 'skipped_optional' : 'failed_retryable',
            humanMessage: 'No pudimos crear el audiolibro, pero tu curso puede continuar.',
          };
        } else {
          let audiobookError = '';
          let audiobookBuffer: Buffer | null = null;

          try {
            // Generate script
            const scriptResult = await generateAudiobookScript(courseData, bookExcerpts, apiKey, logger);
            audiobookPromptTokens = scriptResult.promptTokens;
            audiobookCompletionTokens = scriptResult.completionTokens;
            const script = scriptResult.script;
            const segments = splitText(script, TTS_MAX_CHARS);

            logger.log(`[AudioWorker] Audiobook: ${segments.length} TTS segments`);
            // Registro de costo del guion (OpenAI chat) — independiente del TTS
            await trackEvent('audiobook_script_completed', {
              component: 'audiobook',
              provider: 'openai',
              service: 'chat_completion',
              model: scriptResult.model,
              mode: 'real',
              costType: 'estimated',
              costSource: 'configured_rate',
              tokensInput: audiobookPromptTokens,
              tokensOutput: audiobookCompletionTokens,
              metadata: {
                scriptChars: script.length,
                segments: segments.length,
              },
            });
            await updateProgress({
              phase: 'generating_audiobook',
              message: `Generando audiolibro (${segments.length} segmentos)…`,
            });

            const chunkBuffers: Buffer[] = [];
            const TTS_DELAY_MS = 400;
            let successCount = 0;
            let failedSegments: number[] = [];

            for (let i = 0; i < segments.length; i++) {
              if (leaseLost) break;
              const seg = segments[i];
              let chunkBuffer: Buffer | null = null;
              let chunkError = '';
              const maxChunkAttempts = 3;

              for (let attempt = 1; attempt <= maxChunkAttempts; attempt++) {
                try {
                  const result = await ttsService.synthesize({ text: seg, voice, model, format: 'mp3' });
                  chunkBuffer = result.audioBuffer;
                  audiobookTtsChars += result.chars;
                  break;
                } catch (e) {
                  chunkError = e instanceof Error ? e.message : String(e);
                  if (attempt < maxChunkAttempts) await sleep(5000 * attempt);
                }
              }

              if (chunkBuffer && chunkBuffer.length > 0) {
                chunkBuffers.push(chunkBuffer);
                successCount++;
              } else {
                failedSegments.push(i + 1);
                logger.warn(`[AudioWorker] Segment ${i + 1} failed: ${chunkError}`);
              }

              if (i < segments.length - 1) await sleep(TTS_DELAY_MS);
            }

            if (!leaseLost && successCount === segments.length) {
              audiobookBuffer = Buffer.concat(chunkBuffers);
            } else if (failedSegments.length > 0) {
              audiobookError = `Fallaron ${failedSegments.length}/${segments.length} segmentos`;
            }
          } catch (e) {
            audiobookError = e instanceof Error ? e.message : String(e);
            logger.error(`[AudioWorker] Audiobook generation error: ${audiobookError}`);
          }

          if (leaseLost) return;

          if (audiobookBuffer && audiobookBuffer.length > 0) {
            await sendHeartbeat();
            if (leaseLost) return;
            const caps = Array.isArray(courseData.caps) ? courseData.caps : [];
            const artifact = await uploadMp3Artifact(
              artifactsService, job.ownerId, rawCourseId, jobId, 'audiobook',
              audiobookBuffer,
              {
                courseName:       courseData.nombre || '',
                voice,
                model,
                chunksTotal:      caps.length,
                durationEstimate: Math.ceil(audiobookBuffer.length / 16000 / 60),
              },
              logger,
            );
            outputSummary.audiobook = {
              status: 'completed',
              artifactId: artifact.id,
              sizeBytes: audiobookBuffer.length,
              humanMessage: 'Audiolibro listo.',
            };
            await trackEvent('audiobook_completed', {
              component: 'audiobook',
              provider: 'openai_tts',
              service: 'audio_generation',
              model,
              mode: 'real',
              costType: 'estimated',
              costSource: 'configured_rate',
              units: audiobookTtsChars,
              unitType: 'per_1k_characters',
              metadata: {
                artifactId: artifact.id,
                sizeBytes: audiobookBuffer.length,
                ttsModel: model,
                ttsChars: audiobookTtsChars,
                voice,
              },
            });
            logger.log(`[AudioWorker] Audiobook uploaded: artifact ${artifact.id}`);
          } else {
            outputSummary.audiobook = {
              status: audiobookOptional ? 'skipped_optional' : 'failed_retryable',
              errorCode: 'tts_failed',
              humanMessage: 'No pudimos crear el audiolibro, pero tu curso puede continuar.',
              retryCount: 3,
            };
            await trackEvent('audio_failed', {
              component: 'audiobook',
              provider: 'openai',
              model: 'gpt-4o-mini',
              mode: 'real',
              costType: 'unknown',
              failed: true,
              errorMessage: audiobookError || 'audiobook_failed',
              metadata: {
                phase: 'audiobook',
                optional: audiobookOptional,
              },
            });
            logger.warn(`[AudioWorker] Audiobook failed: ${audiobookError}`);
          }
        }
      }
    } else {
      outputSummary.audiobook = { status: 'skipped_optional' };
    }

    if (leaseLost) return;

    await sendHeartbeat();
    if (leaseLost) return;

    finalized = true;
    const completed = await jobsService.completeAudioWorkerJob(jobId, workerId, outputSummary);
    if (!completed) {
      logger.warn(`[AudioWorker] Job ${jobId} could not be completed — worker ownership changed`);
    } else {
      logger.log(`[AudioWorker] Job ${jobId} completed. welcome=${outputSummary.welcomeAudio?.status} audiobook=${outputSummary.audiobook?.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) {
      logger.warn(`[AudioWorker] Job ${jobId} ended after lease loss: ${message}`);
      return;
    }
    await jobsService.failAudioWorkerJob(jobId, workerId, message, true);
    await trackEvent('audio_failed', {
      component: 'audio',
      provider: 'openai',
      model: 'gpt-4o-mini',
      mode: 'real',
      costType: 'unknown',
      failed: true,
      errorMessage: message,
      metadata: { phase: 'worker' },
    });
    logger.error(`[AudioWorker] Job ${jobId} failed: ${message}`);
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('AudioWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService      = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const ttsService       = app.get(TtsService);
  const eventsService    = app.get(EventsService);

  const workerId     = process.env.AUDIO_WORKER_ID     || `audio-worker-${process.pid}`;
  const pollMs       = readPositiveInt('AUDIO_WORKER_POLL_MS',        5000);
  const leaseSeconds = readPositiveInt('AUDIO_WORKER_LEASE_SECONDS',  120);
  const heartbeatMs  = readPositiveInt('AUDIO_WORKER_HEARTBEAT_MS',   20000);
  const dryRun       = isTrueEnv('AUDIO_WORKER_DRY_RUN');

  let shuttingDown = false;
  let idlePolls    = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s) to finish`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Audio worker stopped');
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(
    `Audio worker started (workerId=${workerId}, pollMs=${pollMs}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`,
  );

  while (!shuttingDown) {
    const claimed = await jobsService.claimNextBackendAudioJob(workerId, leaseSeconds);

    if (!claimed) {
      idlePolls += 1;
      if (idlePolls === 1 || idlePolls % 10 === 0) {
        logger.log('No backend_audio jobs found');
      }
      await sleep(pollMs);
      continue;
    }

    idlePolls = 0;
    logger.log(`Claimed audio job ${claimed.id}`);

    if (dryRun) {
      logger.log(`[AudioWorker] Dry-run: simulating job ${claimed.id}`);
      await sleep(2000);
      await jobsService.completeAudioWorkerJob(claimed.id, workerId, {
        phase: 'completed',
        welcomeAudio: { status: 'completed', humanMessage: 'Audio de bienvenida listo (dry-run).' },
        audiobook:    { status: 'completed', humanMessage: 'Audiolibro listo (dry-run).' },
      });
      await eventsService.trackBackendEvent({
        userId: claimed.ownerId,
        eventType: 'welcome_audio_completed',
        courseId: claimed.frontendCourseId || String(claimed.courseId ?? 'unknown'),
        jobId: claimed.id,
        parentJobId: claimed.inputPayload?.metadata?.parentJobId ?? null,
        component: 'audio',
        provider: 'openai_tts',
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        mode: 'dry_run',
        costType: 'mock_zero',
        estimatedCostUsd: 0,
        costSource: 'mock_zero',
        units: 1,
        unitType: 'per_operation',
        metadata: { workerId, dryRun: true },
      });
      await eventsService.trackBackendEvent({
        userId: claimed.ownerId,
        eventType: 'audiobook_completed',
        courseId: claimed.frontendCourseId || String(claimed.courseId ?? 'unknown'),
        jobId: claimed.id,
        parentJobId: claimed.inputPayload?.metadata?.parentJobId ?? null,
        component: 'audiobook',
        provider: 'openai',
        model: 'gpt-4o-mini',
        mode: 'dry_run',
        costType: 'mock_zero',
        estimatedCostUsd: 0,
        costSource: 'mock_zero',
        units: 1,
        unitType: 'per_operation',
        metadata: { workerId, dryRun: true },
      });
      logger.log(`[AudioWorker] Dry-run completed for job ${claimed.id}`);
      continue;
    }

    const promise = handleAudioJob(
      claimed,
      jobsService,
      artifactsService,
      ttsService,
      eventsService,
      workerId,
      leaseSeconds,
      heartbeatMs,
      logger,
    )
      .catch((error) => {
        logger.error(
          `Unhandled audio worker error for job ${claimed.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        activeJobs.delete(promise);
      });

    activeJobs.add(promise);
    await sleep(activeJobs.size > 0 ? 500 : pollMs);
  }
}

bootstrap().catch((error) => {
  const logger = new Logger('AudioWorker');
  logger.error(
    `Fatal audio worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
