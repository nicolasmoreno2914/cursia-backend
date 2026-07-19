/**
 * full-course-worker.ts
 *
 * Orquestador backend para generación completa de curso.
 * Coordina jobs hijos: backend_content → backend_audio → backend_videos → h5p → backend_package.
 *
 * Principios:
 *   • Restore-first: antes de crear un job hijo, verifica si el resultado ya existe.
 *   • No duplica: si el job hijo ya está activo, lo espera; si ya completó, pasa al siguiente.
 *   • Sobrevive reloads: el usuario puede cerrar la pestaña.
 *   • Maneja YouTube: blocked_auth y blocked_quota propagan al job maestro.
 *   • Audiobook opcional: si falla el audiobook, el curso continúa.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { ProductionJobsService } from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { EventsService } from '../events/events.service';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isTrueEnv(envKey: string): boolean {
  return String(process.env[envKey] || '').toLowerCase() === 'true';
}

function buildCourseId(job: ProductionJob): string {
  return job.frontendCourseId || String(job.courseId ?? 'unknown');
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact helpers
// ─────────────────────────────────────────────────────────────────────────────

async function findLatestArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
  type: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type });
    if (!list?.length) return null;
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    // Reject empty artifacts
    if (candidate.sizeBytes !== null && candidate.sizeBytes !== undefined && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Child job helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES  = new Set(['queued', 'running', 'retrying']);
const DONE_STATUSES    = new Set(['completed']);
const BLOCKED_STATUSES = new Set(['failed_recoverable', 'needs_reconnect', 'blocked_quota']);
const FAILED_STATUSES  = new Set(['failed', 'failed_retryable']);

interface ChildJobResult {
  ok: boolean;
  status: string;
  outputSummary: Record<string, any>;
  error?: string;
}

/**
 * Finds or creates a child job of the given executionMode.
 * Returns the job ID to wait on.
 * If an existing completed job exists, returns its ID directly.
 * If an existing active job exists, returns its ID to wait on.
 * If no suitable job exists, creates a new one.
 */
async function ensureChildJob(
  executionMode: string,
  parentJob: ProductionJob,
  courseId: string,
  payload: Record<string, any>,
  jobsService: ProductionJobsService,
  logger: Logger,
): Promise<string | null> {
  const ownerId = parentJob.ownerId;

  // Find most recent job of this type for this course
  const existing = await jobsService.findLatestChildJobForCourse(ownerId, courseId, executionMode);

  if (existing) {
    const ws = existing.workerStatus || existing.status || '';
    if (DONE_STATUSES.has(ws)) {
      logger.log(`[FullCourseWorker] ${executionMode} already completed (job ${existing.id}) — skipping`);
      return existing.id;
    }
    if (ACTIVE_STATUSES.has(ws)) {
      logger.log(`[FullCourseWorker] ${executionMode} already active (job ${existing.id}, status=${ws}) — waiting`);
      return existing.id;
    }
    // Blocked or failed — need a fresh job
    logger.log(`[FullCourseWorker] ${executionMode} job ${existing.id} is ${ws} — creating fresh job`);
  }

  // Create a new child job
  try {
    const input = parentJob.inputPayload ?? {};
    const opts  = (input.options ?? {}) as Record<string, any>;
    let res: { jobId: string } | null = null;

    if (executionMode === 'backend_content') {
      const r = await jobsService.createContentJob(ownerId, {
        courseId,
        courseData: payload.courseData ?? input.courseData ?? {},
        contentConfig: { maxRetriesPerFile: 3 },
        options: opts,
        metadata: { source: 'full_course_worker', parentJobId: parentJob.id },
      } as any);
      res = r;
    } else if (executionMode === 'backend_audio') {
      const r = await jobsService.createAudioJob(ownerId, {
        courseId,
        courseData: payload.courseData ?? input.courseData ?? {},
        contentSnapshotArtifactId: payload.contentSnapshotArtifactId ?? null,
        bookExcerpts: payload.bookExcerpts ?? {},
        options: { audiobookOptional: opts.audiobookOptional !== false, ...opts },
        metadata: { source: 'full_course_worker', parentJobId: parentJob.id },
      } as any);
      res = r;
    } else if (executionMode === 'backend_videos') {
      const r = await jobsService.createVideoJob(ownerId, {
        courseId,
        courseData: payload.courseData ?? input.courseData ?? {},
        videoConfig: { maxChapters: opts.maxVideoChapters ?? 9 },
        contentSnapshotArtifactId: payload.contentSnapshotArtifactId ?? null,
        options: opts,
        metadata: { source: 'full_course_worker', parentJobId: parentJob.id },
      } as any);
      res = r;
    } else if (executionMode === 'backend_h5p') {
      const r = await jobsService.createH5PJob(ownerId, {
        courseId,
        courseTitle: payload.courseTitle ?? input.courseData?.nombre ?? null,
        courseData: payload.courseData ?? input.courseData ?? {},
        contentSnapshotArtifactId: payload.contentSnapshotArtifactId ?? null,
        videoStateSnapshotArtifactId: payload.videoStateSnapshotArtifactId ?? null,
        youtubeUploads: payload.youtubeUploads ?? [],
        options: {
          restoreFirst: true,
          requireYoutubeUrls: true,
        },
        metadata: { source: 'full_course_worker', parentJobId: parentJob.id },
      } as any);
      res = r;
    } else if (executionMode === 'backend_package') {
      const r = await jobsService.createPackageJob(ownerId, {
        courseId,
        contentSnapshotArtifactId:  payload.contentSnapshotArtifactId ?? null,
        h5pSnapshotArtifactId:      payload.h5pSnapshotArtifactId ?? null,
        audioWelcomeArtifactId:     payload.audioWelcomeArtifactId ?? null,
        audiobookArtifactId:        payload.audiobookArtifactId ?? null,
        options: opts,
        metadata: { source: 'full_course_worker', parentJobId: parentJob.id },
      } as any);
      res = r;
    }

    if (res?.jobId) {
      logger.log(`[FullCourseWorker] Created ${executionMode} job ${res.jobId} for course ${courseId}`);
      return res.jobId;
    }
    logger.warn(`[FullCourseWorker] Failed to create ${executionMode} job — no jobId returned`);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If active job conflict thrown → find and return it
    if (msg.includes('already active') || msg.includes('already queued')) {
      const retried = await jobsService.findLatestChildJobForCourse(ownerId, courseId, executionMode);
      if (retried) return retried.id;
    }
    logger.warn(`[FullCourseWorker] Error creating ${executionMode} job: ${msg}`);
    return null;
  }
}

/**
 * Polls a child job until it reaches a terminal state.
 * Heartbeats the parent job during the wait.
 * Returns the result with the job status and outputSummary.
 */
async function waitForChildJob(
  childJobId: string,
  jobsService: ProductionJobsService,
  heartbeatFn: () => Promise<void>,
  logger: Logger,
  pollMs = 30_000,
  maxWaitMs = 4 * 60 * 60 * 1000, // 4 hours max
): Promise<ChildJobResult> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    await heartbeatFn();
    if ((await jobsService.isJobCancelled(childJobId)) === true) {
      return { ok: false, status: 'cancelled', outputSummary: {}, error: `Child job ${childJobId} cancelled` };
    }

    const job = await jobsService.findJobByIdInternal(childJobId);
    if (!job) {
      return { ok: false, status: 'not_found', outputSummary: {}, error: `Child job ${childJobId} not found` };
    }

    const ws = job.workerStatus || job.status || '';

    if (DONE_STATUSES.has(ws)) {
      return { ok: true, status: ws, outputSummary: job.outputSummary ?? {} };
    }

    if (FAILED_STATUSES.has(ws)) {
      return { ok: false, status: ws, outputSummary: job.outputSummary ?? {}, error: job.errorMessage ?? 'job failed' };
    }

    if (ws === 'cancelled' || ws === 'cancelling') {
      return { ok: false, status: 'cancelled', outputSummary: job.outputSummary ?? {}, error: job.errorMessage ?? 'job cancelled' };
    }

    if (BLOCKED_STATUSES.has(ws)) {
      // Detect YouTube block reason from outputSummary
      const phase = (job.outputSummary ?? {}).phase as string | undefined;
      const blockStatus = phase === 'blocked_auth'  ? 'blocked_auth'
                        : phase === 'blocked_quota' ? 'blocked_quota'
                        : ws;
      return { ok: false, status: blockStatus, outputSummary: job.outputSummary ?? {}, error: job.errorMessage ?? ws };
    }

    // Still running/queued/retrying — continue waiting
    logger.log(`[FullCourseWorker] Waiting for child job ${childJobId} (${ws})...`);
  }

  return { ok: false, status: 'timeout', outputSummary: {}, error: `Child job ${childJobId} timed out after ${maxWaitMs / 60000} min` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core job handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleFullCourseJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  eventsService: EventsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  logger: Logger,
): Promise<void> {
  const jobId    = job.id;
  const input    = (job.inputPayload ?? {}) as Record<string, any>;
  const courseId = buildCourseId(job);
  const ownerId  = job.ownerId;
  const opts     = (input.options ?? {}) as Record<string, any>;
  const parentJobId = input?.metadata?.parentJobId ?? null;

  let leaseLost = false;
  let finalized = false;

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) { leaseLost = true; logger.warn(`[FullCourseWorker] Lease lost for job ${jobId}`); }
    } catch { leaseLost = true; }
  };
  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateStep = (step: string, message: string, partialSummary?: Record<string, any>) =>
    jobsService.updateFullCourseStep(jobId, workerId, step, message, partialSummary).catch(() => {});
  const trackEvent = async (eventType: string, extra: Record<string, any> = {}) =>
    eventsService.trackBackendEvent({
      userId: ownerId,
      eventType,
      courseId,
      jobId,
      parentJobId,
      component: 'orchestration',
      provider: 'internal',
      model: 'full-course-worker',
      mode: extra.mode ?? 'mixed',
      costType: extra.costType ?? 'unknown',
      estimatedCostUsd: extra.estimatedCostUsd,
      costSource: extra.costSource ?? 'not_tracked',
      units: extra.units,
      unitType: extra.unitType,
      failed: extra.failed ?? false,
      errorMessage: extra.errorMessage ?? null,
      metadata: {
        workerId,
        ...extra.metadata,
      },
    });

  try {
    await trackEvent('full_course_generation_started', {
      units: 1,
      unitType: 'per_operation',
      mode: 'mixed',
    });
    // ── 0. Check if mbz_final already exists (restore-first) ─────────────────
    await updateStep('checking_existing', 'Verificando trabajo previo…');

    const existingMbz = await findLatestArtifact(artifactsService, ownerId, courseId, 'mbz_final');
    if (existingMbz) {
      logger.log(`[FullCourseWorker] mbz_final already exists (${existingMbz.id}) — completing job`);
      finalized = true;
      await jobsService.completeFullCourseJob(jobId, workerId, {
        mbzFinalArtifactId: existingMbz.id,
        restoredFromCache: true,
        userMessage: 'Curso listo.',
      });
      return;
    }
    if (leaseLost) return;

    // ── 1. Content ────────────────────────────────────────────────────────────
    await updateStep('content', 'Creando contenido del curso…');

    // Check if content_snapshot artifact already exists
    let contentSnapshotArtifactId: string | null = null;
    const existingContentArt = await findLatestArtifact(artifactsService, ownerId, courseId, 'content_snapshot');
    if (existingContentArt) {
      contentSnapshotArtifactId = existingContentArt.id;
      logger.log(`[FullCourseWorker] content_snapshot already exists (${contentSnapshotArtifactId})`);
      await updateStep('content', 'Contenido encontrado ✓', { steps: { content: { status: 'restored', artifactId: contentSnapshotArtifactId } } });
    } else {
      await sendHeartbeat();
      if (leaseLost) return;
      const contentJobId = await ensureChildJob('backend_content', job, courseId, {}, jobsService, logger);
      if (!contentJobId) throw new Error('No se pudo crear el job de contenido');
      if (leaseLost) return;

      const contentResult = await waitForChildJob(contentJobId, jobsService, sendHeartbeat, logger);
      if (leaseLost) return;

      if (!contentResult.ok) {
        if (contentResult.status === 'cancelled') return;
        throw new Error(`Generación de contenido falló: ${contentResult.error}`);
      }

      contentSnapshotArtifactId =
        contentResult.outputSummary.contentSnapshotArtifactId
        ?? (contentResult.outputSummary.artifactIds as Record<string,any> | undefined)?.contentSnapshot
        ?? null;

      // If not in summary, re-check artifact list
      if (!contentSnapshotArtifactId) {
        const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'content_snapshot');
        contentSnapshotArtifactId = art?.id ?? null;
      }

      if (!contentSnapshotArtifactId) {
        throw new Error('Contenido generado pero no se encontró el artifact');
      }

      await updateStep('content', 'Contenido listo ✓', {
        steps: { content: { status: 'completed', artifactId: contentSnapshotArtifactId } },
      });
    }

    if (leaseLost) return;

    // ── 2. Audio ──────────────────────────────────────────────────────────────
    let audioWelcomeArtifactId: string | null = null;
    let audiobookArtifactId:    string | null = null;
    let videoStateSnapshotArtifactId: string | null = null;
    let h5pSnapshotArtifactId: string | null = null;

    if (opts.generateAudio !== false) {
      await updateStep('audio', 'Creando audios…');

      // Restore-first: check existing audio artifacts
      const existingWelcome  = await findLatestArtifact(artifactsService, ownerId, courseId, 'audio_welcome');
      const existingAudiobook = await findLatestArtifact(artifactsService, ownerId, courseId, 'audiobook');

      if (existingWelcome) {
        audioWelcomeArtifactId = existingWelcome.id;
        logger.log(`[FullCourseWorker] audio_welcome already exists (${audioWelcomeArtifactId})`);
      }
      if (existingAudiobook) {
        audiobookArtifactId = existingAudiobook.id;
        logger.log(`[FullCourseWorker] audiobook already exists (${audiobookArtifactId})`);
      }

      if (!audioWelcomeArtifactId) {
        await sendHeartbeat();
        if (leaseLost) return;
        const audioJobId = await ensureChildJob('backend_audio', job, courseId, {
          contentSnapshotArtifactId,
        }, jobsService, logger);

        if (audioJobId) {
          if (leaseLost) return;
          const audioResult = await waitForChildJob(audioJobId, jobsService, sendHeartbeat, logger);
          if (leaseLost) return;

          if (audioResult.ok) {
            // Extract artifact IDs from outputSummary
            const ws = (audioResult.outputSummary.welcomeAudio ?? {}) as Record<string,any>;
            const ab = (audioResult.outputSummary.audiobook ?? {}) as Record<string,any>;
            audioWelcomeArtifactId = ws.artifactId ?? null;
            audiobookArtifactId    = ab.artifactId ?? null;

            // Re-check artifacts if not found in summary
            if (!audioWelcomeArtifactId) {
              const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'audio_welcome');
              audioWelcomeArtifactId = art?.id ?? null;
            }
            if (!audiobookArtifactId) {
              const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'audiobook');
              audiobookArtifactId = art?.id ?? null;
            }
          } else if (opts.audiobookOptional !== false) {
            // Audio failed but is optional — continue (no audiobook, no welcome audio)
            logger.warn(`[FullCourseWorker] Audio job failed but optional: ${audioResult.error}`);
            if (audioResult.status === 'cancelled') return;
          } else {
            // Audio welcome is required — fail the job
            if (audioResult.status === 'cancelled') return;
            throw new Error(`Generación de audio falló: ${audioResult.error}`);
          }
        }
      }

      const audioSummary: Record<string,any> = {
        audioWelcomeArtifactId,
        audiobookArtifactId,
      };
      await updateStep('audio', audioWelcomeArtifactId ? 'Audio listo ✓' : 'Sin audio de bienvenida', {
        steps: { audio: audioSummary },
      });
    }

    if (leaseLost) return;

    // ── 3. Videos + YouTube ───────────────────────────────────────────────────
    if (opts.generateVideos !== false && opts.uploadToYoutube !== false) {
      await updateStep('video', 'Generando y subiendo videos…');

      const existingVideoArt = await findLatestArtifact(artifactsService, ownerId, courseId, 'video_state_snapshot');
      if (existingVideoArt) {
        videoStateSnapshotArtifactId = existingVideoArt.id;
        logger.log(`[FullCourseWorker] video_state_snapshot already exists — skipping video step`);
        await updateStep('video', 'Videos encontrados ✓', {
          steps: { video: { status: 'restored', artifactId: videoStateSnapshotArtifactId } },
        });
      } else {
        await sendHeartbeat();
        if (leaseLost) return;
        const videoJobId = await ensureChildJob('backend_videos', job, courseId, {}, jobsService, logger);

        if (videoJobId) {
          if (leaseLost) return;
          const videoResult = await waitForChildJob(
            videoJobId, jobsService, sendHeartbeat, logger,
            30_000,
            8 * 60 * 60 * 1000, // videos can take up to 8 hours
          );
          if (leaseLost) return;

          if (videoResult.status === 'blocked_auth') {
            finalized = true;
            await jobsService.blockFullCourseJobAuth(jobId, workerId, videoJobId);
            return;
          }
          if (videoResult.status === 'blocked_quota') {
            finalized = true;
            await jobsService.blockFullCourseJobQuota(jobId, workerId, videoJobId);
            return;
          }
          if (!videoResult.ok) {
            if (videoResult.status === 'cancelled') return;
            // Video failed but not blocking — log and continue (videos are optional for package)
            logger.warn(`[FullCourseWorker] Video job failed (non-blocking): ${videoResult.error}`);
          } else {
            videoStateSnapshotArtifactId =
              videoResult.outputSummary.videoStateSnapshotArtifactId
              ?? (videoResult.outputSummary.artifactIds as Record<string, any> | undefined)?.videoStateSnapshot
              ?? null;
            if (!videoStateSnapshotArtifactId) {
              const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'video_state_snapshot');
              videoStateSnapshotArtifactId = art?.id ?? null;
            }
            await updateStep('video', 'Videos listos ✓', {
              steps: { video: { status: 'completed', artifactId: videoStateSnapshotArtifactId } },
            });
          }
        }
      }
    }

    if (leaseLost) return;

    // ── 4. H5P ───────────────────────────────────────────────────────────────
    await updateStep('h5p', 'Creando actividades…');

    const h5pArtifact = await findLatestArtifact(artifactsService, ownerId, courseId, 'h5p_snapshot');
    h5pSnapshotArtifactId = h5pArtifact?.id ?? null;
    if (h5pSnapshotArtifactId) {
      logger.log(`[FullCourseWorker] h5p_snapshot exists (${h5pSnapshotArtifactId})`);
      await updateStep('h5p', 'Actividades listas ✓', {
        steps: { h5p: { status: 'restored', artifactId: h5pSnapshotArtifactId } },
      });
    } else if (opts.generateVideos === false || opts.uploadToYoutube === false) {
      logger.log('[FullCourseWorker] H5P skipped because videos/YouTube are disabled by options');
      await updateStep('h5p', 'Actividades omitidas en esta preparación', {
        steps: { h5p: { status: 'skipped' } },
      });
    } else {
      await sendHeartbeat();
      if (leaseLost) return;
      const latestVideoJob = await jobsService.findLatestChildJobForCourse(ownerId, courseId, 'backend_videos');
      const youtubeUploads = Array.isArray(latestVideoJob?.outputSummary?.youtubeUploads)
        ? latestVideoJob?.outputSummary?.youtubeUploads
        : [];

      const h5pJobId = await ensureChildJob('backend_h5p', job, courseId, {
        courseTitle: input.courseData?.nombre ?? null,
        courseData: input.courseData ?? {},
        contentSnapshotArtifactId,
        videoStateSnapshotArtifactId,
        youtubeUploads,
      }, jobsService, logger);

      if (!h5pJobId) throw new Error('No se pudo crear el job de actividades interactivas');
      if (leaseLost) return;

      const h5pResult = await waitForChildJob(h5pJobId, jobsService, sendHeartbeat, logger);
      if (leaseLost) return;

      if (!h5pResult.ok) {
        if (h5pResult.status === 'cancelled') return;
        throw new Error(`Preparación de actividades falló: ${h5pResult.error}`);
      }

      h5pSnapshotArtifactId =
        h5pResult.outputSummary.h5pSnapshotArtifactId
        ?? (h5pResult.outputSummary.h5pSnapshot as Record<string, any> | undefined)?.artifactId
        ?? (h5pResult.outputSummary.artifactIds as Record<string, any> | undefined)?.h5pSnapshot
        ?? null;

      if (!h5pSnapshotArtifactId) {
        const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'h5p_snapshot');
        h5pSnapshotArtifactId = art?.id ?? null;
      }

      if (!h5pSnapshotArtifactId) {
        throw new Error('Las actividades se generaron, pero no se encontró su copia guardada');
      }

      const h5pStatus = (h5pResult.outputSummary.h5pSnapshot as Record<string, any> | undefined)?.status ?? 'completed';
      const h5pMessage = h5pStatus === 'partial'
        ? 'Actividades listas con algunas omisiones'
        : 'Actividades listas ✓';

      await updateStep('h5p', h5pMessage, {
        h5pSnapshotArtifactId,
        steps: { h5p: { status: h5pStatus, artifactId: h5pSnapshotArtifactId } },
      });
    }

    if (leaseLost) return;

    // ── 5. Package ────────────────────────────────────────────────────────────
    await updateStep('package', 'Preparando paquete Moodle…');

    if (!contentSnapshotArtifactId) {
      throw new Error('No hay contenido para empaquetar — el paso de contenido no completó correctamente');
    }

    const packageJobId = await ensureChildJob('backend_package', job, courseId, {
      contentSnapshotArtifactId,
      h5pSnapshotArtifactId,
      audioWelcomeArtifactId,
      audiobookArtifactId,
    }, jobsService, logger);

    if (!packageJobId) throw new Error('No se pudo crear el job de empaquetado');
    if (leaseLost) return;

    const packageResult = await waitForChildJob(packageJobId, jobsService, sendHeartbeat, logger);
    if (leaseLost) return;

    if (!packageResult.ok) {
      if (packageResult.status === 'cancelled') return;
      throw new Error(`Empaquetado falló: ${packageResult.error}`);
    }

    // Extract mbzFinalArtifactId from package job outputSummary
    let mbzFinalArtifactId: string | null =
      (packageResult.outputSummary.mbzFinal as Record<string,any> | undefined)?.artifactId
      ?? null;

    // Re-check if not in summary
    if (!mbzFinalArtifactId) {
      const art = await findLatestArtifact(artifactsService, ownerId, courseId, 'mbz_final');
      mbzFinalArtifactId = art?.id ?? null;
    }

    if (!mbzFinalArtifactId) {
      throw new Error('Paquete generado pero no se encontró el artifact mbz_final');
    }

    // ── Complete ──────────────────────────────────────────────────────────────
    finalized = true;
    await jobsService.completeFullCourseJob(jobId, workerId, {
      mbzFinalArtifactId,
      contentSnapshotArtifactId,
      audioWelcomeArtifactId,
      audiobookArtifactId,
      h5pSnapshotArtifactId,
      userMessage: 'Curso listo.',
    });
    await trackEvent('full_course_generation_completed', {
      units: 1,
      unitType: 'per_operation',
      mode: 'mixed',
      metadata: {
        mbzFinalArtifactId,
        contentSnapshotArtifactId,
        audioWelcomeArtifactId,
        audiobookArtifactId,
        h5pSnapshotArtifactId,
      },
    });

    logger.log(`[FullCourseWorker] Job ${jobId} completed — mbzFinal=${mbzFinalArtifactId}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) {
      logger.warn(`[FullCourseWorker] Job ${jobId} ended after lease loss: ${message}`);
      return;
    }
    logger.error(`[FullCourseWorker] Job ${jobId} failed: ${message}`);
    await jobsService.failFullCourseJob(jobId, workerId, message, true);
    await trackEvent('full_course_generation_failed', {
      units: 1,
      unitType: 'per_operation',
      mode: 'mixed',
      failed: true,
      errorMessage: message,
    });
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('FullCourseWorker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  const jobsService      = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const eventsService    = app.get(EventsService);

  const workerId     = process.env.FULL_COURSE_WORKER_ID     || `full-course-worker-${process.pid}`;
  const pollMs       = readPositiveInt('FULL_COURSE_WORKER_POLL_MS',       15_000);
  const leaseSeconds = readPositiveInt('FULL_COURSE_WORKER_LEASE_SECONDS', 3_600);  // 1 hour — extended via heartbeat
  const heartbeatMs  = readPositiveInt('FULL_COURSE_WORKER_HEARTBEAT_MS',  60_000); // heartbeat every 60s
  const dryRun       = isTrueEnv('FULL_COURSE_WORKER_DRY_RUN');

  let shuttingDown = false;
  let idlePolls    = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Full course worker stopped');
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`Full course worker started (workerId=${workerId}, pollMs=${pollMs}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`);

  while (!shuttingDown) {
    const claimed = await jobsService.claimNextFullCourseJob(workerId, leaseSeconds);

    if (!claimed) {
      idlePolls++;
      if (idlePolls === 1 || idlePolls % 12 === 0) logger.log('No course_full_generation jobs found');
      await sleep(pollMs);
      continue;
    }

    idlePolls = 0;
    logger.log(`Claimed full course job ${claimed.id} for course ${buildCourseId(claimed)}`);

    if (dryRun) {
      logger.log(`[FullCourseWorker] Dry-run: simulating job ${claimed.id}`);
      await sleep(3000);
      await jobsService.completeFullCourseJob(claimed.id, workerId, {
        mbzFinalArtifactId: null,
        dryRun: true,
        userMessage: 'Curso listo (simulación).',
      });
      await eventsService.trackBackendEvent({
        userId: claimed.ownerId,
        eventType: 'full_course_generation_completed',
        courseId: buildCourseId(claimed),
        jobId: claimed.id,
        parentJobId: claimed.inputPayload?.metadata?.parentJobId ?? null,
        component: 'orchestration',
        provider: 'internal',
        model: 'full-course-worker',
        mode: 'dry_run',
        costType: 'mock_zero',
        estimatedCostUsd: 0,
        costSource: 'mock_zero',
        units: 1,
        unitType: 'per_operation',
        metadata: { workerId, dryRun: true },
      });
      logger.log(`[FullCourseWorker] Dry-run completed for job ${claimed.id}`);
      continue;
    }

    const promise = handleFullCourseJob(
      claimed, jobsService, artifactsService, eventsService,
      workerId, leaseSeconds, heartbeatMs, logger,
    )
      .catch(error => {
        logger.error(`Unhandled full course worker error for job ${claimed.id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { activeJobs.delete(promise); });

    activeJobs.add(promise);
    await sleep(500);
  }
}

bootstrap().catch(error => {
  const logger = new Logger('FullCourseWorker');
  logger.error(`Fatal full course worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
