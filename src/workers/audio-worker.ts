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
const AUDIOBOOK_TARGET_WORDS = 4200;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

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

async function generateAudiobookScript(
  courseData: Record<string, any>,
  bookExcerpts: Record<string, string>,
  apiKey: string,
  logger: Logger,
): Promise<string> {
  const nombre = courseData.nombre || 'este curso';
  const sector = courseData.sector || '';
  const nivel  = courseData.nivel  || '';
  const mods: any[] = Array.isArray(courseData.mods) ? courseData.mods : [];
  const caps: any[] = Array.isArray(courseData.caps) ? courseData.caps : [];

  const capContexts: string[] = [];
  const maxCap = Object.keys(bookExcerpts).length || caps.length || 9;

  for (let i = 1; i <= Math.min(maxCap, 9); i++) {
    const excerpt = bookExcerpts[`cap${i}`];
    if (!excerpt || excerpt.length < 10) continue;
    const capObj = caps[i - 1] ?? {};
    const capName = capObj.t || `Capítulo ${i}`;
    capContexts.push(`Capítulo ${i} — ${capName}:\n${cleanAudioText(excerpt).slice(0, 600)}`);
  }

  if (capContexts.length === 0) {
    throw new Error('Sin extractos de capítulos disponibles para generar el guion del audiolibro');
  }

  const modLine = mods.length > 0
    ? mods.map((m: any) => m.n).filter(Boolean).join(', ')
    : `${capContexts.length} capítulos`;

  const sectorLine = sector ? ` orientado a ${sector}` : '';
  const nivelLine  = nivel  ? `, nivel ${nivel}`        : '';

  const systemPrompt =
    'Eres un narrador experto en educación. Tu tarea es escribir el guion completo de un ' +
    'audiolibro narrativo resumido para un curso de formación.\n\n' +
    'REGLAS OBLIGATORIAS:\n' +
    `- El guion debe tener entre 4000 y 4800 palabras en total.\n` +
    '- NO leas el contenido literalmente. Resume, explica y conecta las ideas principales.\n' +
    '- El tono debe ser natural, conversacional y educativo — como una clase narrada en voz alta.\n' +
    '- Cubre todos los capítulos del curso de forma proporcional.\n' +
    '- ESTRUCTURA DEL GUION:\n' +
    '  1. Introducción general del curso (100–150 palabras)\n' +
    '  2. Un bloque narrativo por capítulo (~350–450 palabras cada uno), comenzando con una frase de transición\n' +
    '  3. Conexiones entre capítulos cuando sea relevante\n' +
    '  4. Ejemplos o aplicaciones prácticas concretas\n' +
    '  5. Cierre con conclusiones y reflexión final (100–150 palabras)\n' +
    '- Usa solo texto plano. Sin markdown, sin títulos, sin listas, sin asteriscos.\n' +
    '- El texto debe sonar natural al ser leído en voz alta.\n' +
    '- No inventes datos técnicos, estadísticas o citas que no estén en el contenido original.\n' +
    '- Responde SOLO con el guion. Sin explicaciones, sin preámbulos.';

  const userPrompt =
    `Escribe el guion narrativo del audiolibro del curso "${nombre}"${sectorLine}${nivelLine}.\n\n` +
    `El curso está organizado en: ${modLine}.\n\n` +
    'A continuación tienes un extracto del contenido de cada capítulo como referencia:\n\n' +
    capContexts.join('\n\n---\n\n') + '\n\n' +
    `Escribe el guion completo de ${AUDIOBOOK_TARGET_WORDS} palabras aproximadamente. ` +
    `Cubre los ${capContexts.length} capítulos. Solo el guion, sin más texto.`;

  logger.log(`[AudioWorker] Generating audiobook script via OpenAI chat (${capContexts.length} caps)`);

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 6500,
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
  };
  const script = data?.choices?.[0]?.message?.content?.trim() ?? '';

  if (!script || script.length < 500) {
    throw new Error(`Guion del audiolibro demasiado corto (${script.length} chars)`);
  }

  const wordCount = script.split(/\s+/).length;
  logger.log(`[AudioWorker] Audiobook script: ${wordCount} words, ${script.length} chars`);

  return script;
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

  let leaseLost = false;
  let finalized = false;

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
        const script = buildWelcomeScript(courseData);
        let welcomeBuffer: Buffer | null = null;
        let welcomeError = '';
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const result = await ttsService.synthesize({ text: script, voice, model, format: 'mp3' });
            welcomeBuffer = result.audioBuffer;
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
            const script = await generateAudiobookScript(courseData, bookExcerpts, apiKey, logger);
            const segments = splitText(script, TTS_MAX_CHARS);

            logger.log(`[AudioWorker] Audiobook: ${segments.length} TTS segments`);
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
            logger.log(`[AudioWorker] Audiobook uploaded: artifact ${artifact.id}`);
          } else {
            outputSummary.audiobook = {
              status: audiobookOptional ? 'skipped_optional' : 'failed_retryable',
              errorCode: 'tts_failed',
              humanMessage: 'No pudimos crear el audiolibro, pero tu curso puede continuar.',
              retryCount: 3,
            };
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
      logger.log(`[AudioWorker] Dry-run completed for job ${claimed.id}`);
      continue;
    }

    const promise = handleAudioJob(
      claimed,
      jobsService,
      artifactsService,
      ttsService,
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
