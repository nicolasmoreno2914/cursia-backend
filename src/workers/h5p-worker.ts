import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import {
  H5PWorkerProgressSummary,
  ProductionJobsService,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanText(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\-\+\*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string, maxLen = 140): string {
  const clean = cleanText(text);
  if (!clean) return '';
  const sentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  return sentence.slice(0, maxLen).trim();
}

function buildEffectiveCourseId(job: ProductionJob): string {
  if (job.frontendCourseId) return String(job.frontendCourseId);
  if (job.courseId !== null && job.courseId !== undefined) return String(job.courseId);
  return 'unknown-course';
}

async function findExistingH5PArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type: 'h5p_snapshot' });
    if (!list?.length) return null;
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    if (candidate.sizeBytes !== null && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

async function downloadArtifactJson(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Record<string, any> | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url = urlRes.url;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`[H5PWorker] Artifact ${artifactId} HTTP ${res.status}`);
      return null;
    }
    return res.json() as Promise<Record<string, any>>;
  } catch (e) {
    logger.warn(`[H5PWorker] Artifact ${artifactId} error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

type Question = {
  question: string;
  answers: Array<{ text: string; correct: boolean }>;
  timestamp?: number;
};

type ChapterInfo = {
  n: number;
  title: string;
  excerpt: string;
};

type YoutubeUploadLike = {
  cap?: number;
  chapter?: number;
  title?: string;
  youtubeUrl?: string | null;
  youtube_url?: string | null;
  status?: string | null;
};

function buildChapters(contentSnapshot: Record<string, any>, inputCourseData: Record<string, any>): ChapterInfo[] {
  const D = (contentSnapshot.D ?? {}) as Record<string, any>;
  const F = (contentSnapshot.F ?? {}) as Record<string, string>;
  const sourceCaps = Array.isArray(D.caps) ? D.caps : Array.isArray(inputCourseData.caps) ? inputCourseData.caps : [];
  const chapters: ChapterInfo[] = [];

  for (let i = 0; i < sourceCaps.length; i += 1) {
    const cap = sourceCaps[i];
    const capNum = Number(cap?.n ?? i + 1);
    const title = String(cap?.t ?? cap?.title ?? cap?.name ?? `Capítulo ${capNum}`);
    const excerpt = String(F[`libro_cap${capNum}.md`] ?? F[`cap${capNum}_base.html`] ?? '');
    chapters.push({ n: capNum, title, excerpt });
  }

  if (chapters.length === 0) {
    for (const [filename, content] of Object.entries(F)) {
      const match = filename.match(/^libro_cap(\d+)\.md$/);
      if (!match) continue;
      const capNum = Number(match[1]);
      chapters.push({ n: capNum, title: `Capítulo ${capNum}`, excerpt: String(content) });
    }
    chapters.sort((a, b) => a.n - b.n);
  }

  return chapters;
}

function buildDistractors(chapters: ChapterInfo[], capNum: number): string[] {
  const distractors = chapters
    .filter((c) => c.n !== capNum)
    .map((c) => c.title)
    .filter(Boolean)
    .slice(0, 3);

  while (distractors.length < 3) {
    distractors.push(`Aplicación general del curso ${distractors.length + 1}`);
  }
  return distractors;
}

function buildQuestionsForChapter(chapter: ChapterInfo, chapters: ChapterInfo[]): Question[] {
  const distractors = buildDistractors(chapters, chapter.n);
  const answers1 = [
    { text: chapter.title, correct: true },
    ...distractors.map((text) => ({ text, correct: false })),
  ];

  const excerptSentence = firstSentence(chapter.excerpt, 110);
  const genericCorrect = `Relacionar ${chapter.title.toLowerCase()} con una situación práctica.`;
  const genericWrong = [
    'Memorizar términos sin contexto.',
    'Saltar directamente a la evaluación final.',
    'Ignorar los ejemplos del capítulo.',
  ];
  const questions: Question[] = [
    {
      question: `¿Qué tema se trabaja principalmente en el capítulo "${chapter.title}"?`,
      answers: answers1,
      timestamp: 45,
    },
    {
      question: `¿Qué acción ayuda mejor a reforzar lo aprendido en este capítulo?`,
      answers: [
        { text: genericCorrect, correct: true },
        ...genericWrong.map((text) => ({ text, correct: false })),
      ],
      timestamp: 105,
    },
  ];

  if (excerptSentence) {
    const alt1 = firstSentence(chapters.find((c) => c.n !== chapter.n)?.excerpt || '', 110) || 'Una introducción general del curso.';
    const alt2 = 'Una descripción del examen final del curso.';
    const alt3 = 'Una instrucción para omitir la práctica del capítulo.';
    questions.push({
      question: `¿Cuál de estas ideas resume mejor este capítulo?`,
      answers: [
        { text: excerptSentence, correct: true },
        { text: alt1, correct: false },
        { text: alt2, correct: false },
        { text: alt3, correct: false },
      ],
      timestamp: 165,
    });
  }

  return questions;
}

function hvpUuid(): string {
  return randomUUID();
}

function buildHvpJson(youtubeUrl: string, questions: Question[], capName: string): Record<string, any> {
  const interactions = questions.slice(0, 8).map((q, idx) => {
    const ts = q.timestamp && q.timestamp > 0 ? q.timestamp : (idx + 1) * 60;
    return {
      x: 5, y: 5, width: 90, height: 90,
      duration: { from: ts, to: ts + 10 },
      pause: true,
      displayType: 'poster',
      adaptivitySettings: { requireCompletion: false, seekTo: 0, type: 'timeframe' },
      ref: '',
      label: `<p>${esc(q.question)}</p>\n`,
      action: {
        library: 'H5P.MultiChoice 1.16',
        params: {
          media: { type: { params: {} } },
          answers: q.answers.map((a) => ({
            correct: !!a.correct,
            tipsAndFeedback: {
              tip: '',
              chosenFeedback: a.correct ? '<div>✓ Correcto</div>' : '<div>Incorrecto</div>',
              notChosenFeedback: '',
            },
            text: `<div>${esc(a.text)}</div>`,
          })),
          UI: {
            checkAnswerButton: 'Verificar',
            submitAnswerButton: 'Enviar',
            showSolutionButton: 'Ver solución',
            tryAgainButton: 'Intentar de nuevo',
            tipsLabel: 'Mostrar pista',
          },
          behaviour: {
            enableRetry: true,
            enableSolutionsButton: true,
            enableCheckButton: true,
            type: 'auto',
            singlePoint: false,
            randomAnswers: true,
            showSolutionsRequiresInput: true,
            confirmCheckDialog: false,
            confirmRetryDialog: false,
            autoCheck: false,
            passPercentage: 100,
            showScorePoints: true,
          },
          question: `<p>${esc(q.question)}</p>`,
        },
        subContentId: hvpUuid(),
        metadata: { contentType: 'Multiple Choice', license: 'U', title: 'Untitled Multiple Choice' },
      },
    };
  });

  return {
    interactiveVideo: {
      video: {
        files: [{ path: youtubeUrl, mime: 'video/YouTube', copyright: { license: 'U' }, aspectRatio: '16:9' }],
        startScreenOptions: { title: capName, hideStartTitle: true },
        textTracks: { videoTrack: [{ label: 'Subtítulos', kind: 'captions', srcLang: 'es' }] },
      },
      assets: {
        interactions,
        bookmarks: [],
        endscreens: [{ time: 9999, label: '4.91, Quiz' }],
      },
      summary: {
        task: {
          library: 'H5P.Summary 1.10',
          params: {
            intro: 'Elige la afirmación correcta.',
            summaries: [{ summary: [`El capítulo "${capName}" resume las ideas clave del módulo.`], tip: '' }],
            overallFeedback: [{ from: 0, to: 100 }],
            solvedLabel: 'Progreso:',
            scoreLabel: 'Respuestas incorrectas:',
            resultLabel: 'Tu resultado',
            labelCorrect: 'Correcto.',
            labelIncorrect: 'Incorrecto. Inténtalo de nuevo.',
            alternativeIncorrectLabel: 'Incorrecto',
            labelCorrectAnswers: 'Respuestas correctas.',
            tipButtonLabel: 'Mostrar pista',
            scoreBarLabel: 'Has respondido @count preguntas.',
          },
          subContentId: hvpUuid(),
          metadata: { contentType: 'Summary', license: 'U', title: 'Untitled Summary' },
        },
        displayAt: 3,
      },
    },
    override: {
      autoInstallFullscreen: false,
      showBookmarksmenuOnLoad: false,
      showRewind10: false,
      preventSkipping: false,
      deactivateSound: false,
    },
    l10n: {
      interaction: 'Interacción',
      play: 'Reproducir',
      pause: 'Pausa',
      mute: 'Silenciar',
      unmute: 'Activar sonido',
      quality: 'Calidad',
      captions: 'Subtítulos',
      close: 'Cerrar',
      fullscreen: 'Pantalla completa',
      exitFullscreen: 'Salir de pantalla completa',
      summary: 'Abrir resumen',
      bookmarks: 'Marcadores',
      endscreen: 'Cuestionario final',
      defaultAdaptivitySeekLabel: 'Continuar',
      continueWithVideo: 'Continuar con el video',
      playbackRate: 'Velocidad',
      rewind10: 'Retroceder 10s',
      navDisabled: 'Navegación desactivada',
      sndDisabled: 'Sonido desactivado',
      requiresCompletionWarning: 'Responde todas las preguntas antes de continuar.',
      back: 'Atrás',
      hours: 'Horas',
      minutes: 'Minutos',
      seconds: 'Segundos',
      currentTime: 'Tiempo actual:',
      totalTime: 'Tiempo total:',
      singleInteractionAnnouncement: 'Interacción aparecida:',
      multipleInteractionsAnnouncement: 'Varias interacciones aparecidas.',
    },
  };
}

function normalizeYoutubeUploads(candidate: any): YoutubeUploadLike[] {
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item) => item && typeof item === 'object');
}

function extractYoutubeUploadsFromVideoSnapshot(snapshot: Record<string, any> | null): YoutubeUploadLike[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  return normalizeYoutubeUploads(snapshot.youtube?.uploads);
}

function buildYoutubeMap(uploads: YoutubeUploadLike[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const upload of uploads) {
    const cap = Number(upload.cap ?? upload.chapter ?? 0);
    const url = String(upload.youtubeUrl ?? upload.youtube_url ?? '').trim();
    const status = String(upload.status ?? '').trim();
    if (!cap || !url) continue;
    if (status && !['uploaded', 'completed'].includes(status)) continue;
    map.set(cap, url);
  }
  return map;
}

async function handleJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  logger: Logger,
): Promise<void> {
  const jobId = job.id;
  const payload = (job.inputPayload ?? {}) as Record<string, any>;
  const courseId = buildEffectiveCourseId(job);
  const courseTitle = String(payload.courseTitle ?? payload.courseData?.nombre ?? 'Curso Cursia');
  const options = (payload.options ?? {}) as Record<string, any>;

  let leaseLost = false;
  let finalized = false;

  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) {
        leaseLost = true;
        logger.warn(`[H5PWorker] Lease lost for job ${jobId}`);
      }
    } catch {
      leaseLost = true;
    }
  };
  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateProgress = async (
    phase: H5PWorkerProgressSummary['phase'],
    message: string,
    extra?: Partial<H5PWorkerProgressSummary>,
  ) => {
    if (leaseLost) return;
    await jobsService.updateH5PWorkerProgress(jobId, workerId, {
      phase,
      message,
      ...extra,
    }).catch(() => {});
  };

  try {
    const marked = await jobsService.markH5PWorkerRunning(jobId, workerId);
    if (!marked) return;

    await sendHeartbeat();
    if (leaseLost) return;

    if (options.restoreFirst !== false) {
      await updateProgress('checking_existing_h5p', 'Verificando actividades existentes…');
      const existing = await findExistingH5PArtifact(artifactsService, job.ownerId, courseId);
      if (existing) {
        finalized = true;
        await jobsService.completeH5PWorkerJob(jobId, workerId, {
          h5pSnapshotArtifactId: existing.id,
          artifactIds: { h5pSnapshot: existing.id },
          h5pSnapshot: {
            status: 'skipped_existing',
            artifactId: existing.id,
            activityCount: Number(existing.metadata?.activityCount ?? existing.metadata?.hvpCount ?? 0),
            humanMessage: 'Actividades listas.',
          },
          activities: [],
          chaptersWithActivities: [],
          chaptersSkipped: [],
        });
        return;
      }
    }

    await updateProgress('reading_course_content', 'Leyendo contenido del curso…');
    const contentSnapshotId = String(payload.contentSnapshotArtifactId ?? '').trim();
    if (!contentSnapshotId) {
      throw new Error('Falta la copia del contenido para crear actividades');
    }
    const contentSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, contentSnapshotId, logger);
    if (!contentSnapshot?.D || !contentSnapshot?.F) {
      throw new Error('No se pudo leer el contenido del curso');
    }

    await sendHeartbeat();
    if (leaseLost) return;

    await updateProgress('reading_video_urls', 'Verificando videos disponibles…');
    let uploads = normalizeYoutubeUploads(payload.youtubeUploads);

    const videoStateSnapshotId = String(payload.videoStateSnapshotArtifactId ?? '').trim();
    if (uploads.length === 0 && videoStateSnapshotId) {
      const videoSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, videoStateSnapshotId, logger);
      uploads = extractYoutubeUploadsFromVideoSnapshot(videoSnapshot);
    }

    if (uploads.length === 0) {
      const latestVideoJob = await jobsService.findLatestChildJobForCourse(job.ownerId, courseId, 'backend_videos');
      uploads = normalizeYoutubeUploads(latestVideoJob?.outputSummary?.youtubeUploads);
      if (uploads.length === 0) {
        const artifact = await artifactsService.findAll(job.ownerId, { courseId, type: 'video_state_snapshot' })
          .then((items) => items?.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())?.[0] ?? null)
          .catch(() => null);
        if (artifact?.id) {
          const videoSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, artifact.id, logger);
          uploads = extractYoutubeUploadsFromVideoSnapshot(videoSnapshot);
        }
      }
    }

    const youtubeMap = buildYoutubeMap(uploads);
    const chapters = buildChapters(contentSnapshot, payload.courseData ?? {});
    if (chapters.length === 0) {
      throw new Error('No se encontraron capítulos para crear actividades');
    }

    await sendHeartbeat();
    if (leaseLost) return;

    await updateProgress('creating_activities', 'Creando actividades…');
    const mediaHvp: Record<number, any> = {};
    const activityStatuses: Array<Record<string, any>> = [];
    const chaptersWithActivities: number[] = [];
    const chaptersSkipped: number[] = [];

    for (const chapter of chapters) {
      const youtubeUrl = youtubeMap.get(chapter.n) ?? '';
      if (!youtubeUrl) {
        chaptersSkipped.push(chapter.n);
        activityStatuses.push({
          chapter: chapter.n,
          title: chapter.title,
          status: 'skipped_missing_video',
          youtubeUrl: null,
          activityType: 'interactive_video',
          errorCode: 'missing_youtube_url',
          errorMessage: 'Faltan algunos videos para crear actividades',
        });
        continue;
      }

      const questions = buildQuestionsForChapter(chapter, chapters);
      mediaHvp[chapter.n] = {
        hvpJson: buildHvpJson(youtubeUrl, questions, chapter.title),
        capName: chapter.title,
        youtubeUrl,
        h5p_status: 'created',
        transcript_source: 'backend_h5p',
        generated_by: 'backend_h5p',
        generated_at: new Date().toISOString(),
      };
      chaptersWithActivities.push(chapter.n);
      activityStatuses.push({
        chapter: chapter.n,
        title: chapter.title,
        status: 'created',
        youtubeUrl,
        activityType: 'interactive_video',
        errorCode: null,
        errorMessage: null,
      });
    }

    const activityCount = Object.keys(mediaHvp).length;
    if (activityCount === 0 && options.requireYoutubeUrls !== false) {
      throw new Error('Faltan algunos videos para crear actividades');
    }

    await sendHeartbeat();
    if (leaseLost) return;

    await updateProgress('uploading_h5p_snapshot', 'Guardando actividades…', {
      activityCount,
      chaptersWithActivities,
      chaptersSkipped,
      activities: activityStatuses,
    });

    await sendHeartbeat();
    if (leaseLost) return;

    const generatedAt = new Date().toISOString();
    const snapshot = {
      type: 'h5p_snapshot',
      schemaVersion: '1.0',
      generatedAt,
      course: {
        id: courseId,
        name: courseTitle,
      },
      MEDIA_HVP: mediaHvp,
      metadata: {
        source: 'backend_h5p',
        reason: 'backend_generation',
        hvpCount: activityCount,
        courseName: courseTitle,
        generatedAt,
      },
    };

    const timestamp = generatedAt.replace(/[:.]/g, '-');
    const filename = `h5p_snapshot_backend_${timestamp}.json`;
    const storagePath = `${job.ownerId}/${courseId}/h5p/${filename}`;
    const artifact = await artifactsService.uploadJsonArtifact({
      ownerId: job.ownerId,
      courseId,
      jobId,
      type: 'h5p_snapshot',
      filename,
      storagePath,
      payload: snapshot,
      mimeType: 'application/json',
      metadata: {
        generatedBy: 'backend_h5p',
        activityCount,
        chaptersWithActivities,
        chaptersSkipped,
        createdAt: generatedAt,
        courseName: courseTitle,
      },
    });

    if (leaseLost) return;

    const status = chaptersSkipped.length > 0 ? 'partial' : 'completed';
    finalized = true;
    await jobsService.completeH5PWorkerJob(jobId, workerId, {
      h5pSnapshotArtifactId: artifact.id,
      artifactIds: { h5pSnapshot: artifact.id },
      h5pSnapshot: {
        status,
        artifactId: artifact.id,
        activityCount,
        chaptersWithActivities,
        chaptersSkipped,
        humanMessage: status === 'partial'
          ? 'Actividades listas con algunas omisiones.'
          : 'Actividades listas.',
      },
      activities: activityStatuses,
      chaptersWithActivities,
      chaptersSkipped,
      activityCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!leaseLost) {
      await jobsService.failH5PWorkerJob(jobId, workerId, message, true);
      logger.error(`[H5PWorker] Job ${jobId} failed: ${message}`);
    }
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

async function bootstrap() {
  const logger = new Logger('H5PWorker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  const jobsService = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const workerId = process.env.H5P_WORKER_ID || `h5p-worker-${process.pid}`;
  const pollMs = readPositiveInt('H5P_WORKER_POLL_MS', 5000);
  const concurrency = readPositiveInt('H5P_WORKER_CONCURRENCY', 1);
  const leaseSeconds = readPositiveInt('H5P_WORKER_LEASE_SECONDS', 120);
  const heartbeatMs = readPositiveInt('H5P_WORKER_HEARTBEAT_MS', 15000);

  let shuttingDown = false;
  let idlePolls = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('H5P worker stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`H5P worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency})`);

  while (!shuttingDown) {
    while (!shuttingDown && activeJobs.size < concurrency) {
      const claimed = await jobsService.claimNextBackendH5PJob(workerId, leaseSeconds);
      if (!claimed) break;

      idlePolls = 0;
      const promise = handleJob(
        claimed,
        jobsService,
        artifactsService,
        workerId,
        leaseSeconds,
        heartbeatMs,
        logger,
      ).finally(() => {
        activeJobs.delete(promise);
      });
      activeJobs.add(promise);
    }

    if (shuttingDown) break;
    if (activeJobs.size === 0) {
      idlePolls += 1;
      if (idlePolls % 12 === 0) logger.log(`Idle polling… (${idlePolls})`);
    }
    await sleep(pollMs);
  }
}

void bootstrap();
