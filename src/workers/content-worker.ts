import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import {
  ContentGenerationProgressEvent,
  ContentGenerationService,
  GeneratedCourseContentResult,
} from '../modules/content-generation/content-generation.service';
import {
  ContentWorkerDryRunSummary,
  ContentWorkerProgressSummary,
  ProductionJobsService,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { EventsService } from '../events/events.service';

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

function buildEffectiveCourseId(job: ProductionJob): string {
  if (job.frontendCourseId) return String(job.frontendCourseId);
  if (job.courseId !== null && job.courseId !== undefined) return String(job.courseId);
  return 'unknown-course';
}

function validateContentSnapshot(snapshot: Record<string, any>): void {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Content snapshot must be an object');
  }
  if (snapshot.type !== 'content_snapshot') {
    throw new Error('Content snapshot type must be content_snapshot');
  }
  if (!snapshot.D || typeof snapshot.D !== 'object') {
    throw new Error('Content snapshot must include D object');
  }
  if (!snapshot.F || typeof snapshot.F !== 'object' || Array.isArray(snapshot.F)) {
    throw new Error('Content snapshot must include F object');
  }
  if (Object.keys(snapshot.F).length === 0) {
    throw new Error('Content snapshot F must contain generated files');
  }
}

function buildContentSnapshot(
  job: ProductionJob,
  generated: GeneratedCourseContentResult,
): Record<string, any> {
  const effectiveCourseId = buildEffectiveCourseId(job);
  const generatedAt = new Date().toISOString();
  const serializedBody = JSON.stringify({ D: generated.D, F: generated.F });
  const bytes = Buffer.byteLength(serializedBody);

  return {
    schemaVersion: '1.0',
    type: 'content_snapshot',
    generatedAt,
    course: {
      id: effectiveCourseId,
      backendCourseId: job.courseId ?? null,
      frontendCourseId: job.frontendCourseId ?? null,
      nombre: generated.D?.nombre ?? generated.D?.courseName ?? 'Curso Cursia',
      sector: generated.D?.sector ?? null,
      nivel: generated.D?.nivel ?? null,
      horas: generated.D?.horas ?? null,
    },
    D: generated.D,
    F: generated.F,
    production: {
      jobId: job.id,
      status: 'completed',
      currentStep: 'content',
      progress: 100,
      startedAt: job.startedAt?.toISOString?.() ?? null,
      contentCompletedAt: generatedAt,
      executionMode: job.executionMode,
      workerStatus: 'completed',
    },
    mediaReferences: {},
    h5pSummary: { count: 0, caps: [] },
    metadata: {
      reason: 'backend_content_completed',
      courseName: generated.D?.nombre ?? 'Curso Cursia',
      generatedAt,
      fileCount: Object.keys(generated.F || {}).length,
      sizeEstimate: {
        bytes,
        human: `${(bytes / 1024).toFixed(1)} KB`,
      },
      jobId: job.id,
      currentStep: 'content',
      source: 'content_worker',
      backendCourseId: job.courseId ?? null,
      frontendCourseId: job.frontendCourseId ?? null,
    },
  };
}

async function uploadContentSnapshotWithRetry(
  artifactsService: ArtifactsService,
  job: ProductionJob,
  snapshot: Record<string, any>,
  logger: Logger,
): Promise<Artifact> {
  const effectiveCourseId = buildEffectiveCourseId(job);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `content_snapshot_backend_content_${timestamp}.json`;
  const storagePath = `${job.ownerId}/${effectiveCourseId}/content/${filename}`;
  const metadata = snapshot.metadata ?? {};

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await artifactsService.uploadJsonArtifact({
        ownerId: job.ownerId,
        courseId: effectiveCourseId,
        jobId: job.id,
        type: 'content_snapshot',
        filename,
        storagePath,
        payload: snapshot,
        mimeType: 'application/json',
        metadata,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`Content snapshot upload attempt ${attempt} failed for job ${job.id}: ${lastError.message}`);
      if (attempt < 2) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError ?? new Error('Content snapshot upload failed');
}

async function bootstrap() {
  const logger = new Logger('ContentWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService = app.get(ProductionJobsService);
  const contentGenerationService = app.get(ContentGenerationService);
  const artifactsService = app.get(ArtifactsService);
  const eventsService = app.get(EventsService);
  const workerId =
    process.env.CONTENT_WORKER_ID ||
    `content-worker-${process.pid}`;
  const pollMs = readPositiveInt('CONTENT_WORKER_POLL_MS', 3000);
  const concurrency = readPositiveInt('CONTENT_WORKER_CONCURRENCY', 1);
  const leaseSeconds = readPositiveInt('CONTENT_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs = readPositiveInt('CONTENT_WORKER_HEARTBEAT_MS', 15000);
  const dryRun = isTrueEnv('CONTENT_WORKER_DRY_RUN');
  const realContentEnabled = isTrueEnv('CONTENT_WORKER_ENABLE_REAL_CONTENT');

  let shuttingDown = false;
  let idlePolls = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s) to finish`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Content worker stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(
    `Content worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun}, realContentEnabled=${realContentEnabled})`,
  );

  async function handleJob(job: ProductionJob): Promise<void> {
    const jobId = job.id;
    let leaseLost = false;
    let heartbeatCount = 0;
    let consecutiveHeartbeatFailures = 0;
    let finalized = false;
    const courseId = buildEffectiveCourseId(job);
    const parentJobId = job.inputPayload?.metadata?.parentJobId ?? null;
    const trackEvent = async (
      eventType: string,
      extra: Record<string, any> = {},
    ) => eventsService.trackBackendEvent({
      userId: job.ownerId,
      userEmail: null,
      eventType,
      courseId,
      jobId,
      parentJobId,
      component: 'content',
      provider: extra.provider ?? 'internal',
      model: extra.model ?? 'template_v1',
      mode: extra.mode ?? (dryRun ? 'dry_run' : 'real'),
      costType: extra.costType ?? (dryRun ? 'mock_zero' : 'unknown'),
      costSource: extra.costSource ?? (dryRun ? 'mock_zero' : 'not_tracked'),
      estimatedCostUsd: extra.estimatedCostUsd,
      realCostUsd: extra.realCostUsd,
      units: extra.units,
      unitType: extra.unitType,
      unitPriceUsd: extra.unitPriceUsd,
      durationMs: extra.durationMs,
      failed: extra.failed ?? false,
      errorMessage: extra.errorMessage ?? null,
      metadata: {
        executionMode: job.executionMode,
        workerId,
        ...extra.metadata,
      },
    });

    const sendHeartbeat = async () => {
      if (finalized || leaseLost) return;
      try {
        const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
        if (!ok) {
          leaseLost = true;
          logger.warn(`Lease lost for job ${jobId}; stopping processing`);
          return;
        }
        consecutiveHeartbeatFailures = 0;
        heartbeatCount += 1;
        logger.log(`Heartbeat ${heartbeatCount} for job ${jobId}`);
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        logger.warn(
          `Heartbeat failed (${consecutiveHeartbeatFailures}/5) for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (consecutiveHeartbeatFailures >= 5) {
          leaseLost = true;
          logger.error(`Heartbeat failed 5 consecutive times for job ${jobId}; declaring lease lost`);
        }
      }
    };

    const heartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, heartbeatMs);

    try {
      const markedRunning = await jobsService.markContentWorkerRunning(jobId, workerId);
      if (!markedRunning) {
        logger.warn(`Job ${jobId} is no longer owned by ${workerId} before start`);
        return;
      }

      logger.log(`Job ${jobId} marked as running`);
      await trackEvent('content_generation_started', {
        metadata: {
          dryRun,
          realContentEnabled,
        },
      });
      await sendHeartbeat();
      if (leaseLost) return;

      if (dryRun) {
        const waitMs = 2000 + Math.floor(Math.random() * 3000);
        logger.log(`Job ${jobId} running in dry-run mode for ${waitMs}ms`);
        await sleep(waitMs);

        if (leaseLost) {
          logger.warn(`Skipping completion for job ${jobId} because lease was lost`);
          return;
        }

        const summary: ContentWorkerDryRunSummary = {
          phase: 'dry_run',
          done: 1,
          total: 1,
          filesGenerated: 0,
          message: 'Content worker dry-run completed',
        };

        finalized = true;
        const completed = await jobsService.completeContentWorkerDryRun(jobId, workerId, summary);
        if (!completed) {
          logger.warn(`Job ${jobId} could not be completed because worker ownership changed`);
          return;
        }

        await trackEvent('content_generation_completed', {
          mode: 'dry_run',
          costType: 'mock_zero',
          units: 1,
          unitType: 'per_operation',
          estimatedCostUsd: 0,
          durationMs: waitMs,
          metadata: {
            dryRun: true,
            phase: 'dry_run',
          },
        });
        logger.log(`Dry-run completed for job ${jobId}`);
        return;
      }

      if (!realContentEnabled) {
        throw new Error(
          'Real content generation is disabled. Set CONTENT_WORKER_ENABLE_REAL_CONTENT=true and CONTENT_WORKER_DRY_RUN=false to run it.',
        );
      }

      logger.log(`Starting real content generation for job ${jobId}`);

      let lastPersistedAt = 0;
      let lastProgressSignature = '';
      let lastPersistedPhase = '';
      const aggregatedProgressMap: Record<string, { done: number; total: number }> = {};

      const flushProgress = async (
        progress: ContentWorkerProgressSummary,
        force = false,
      ) => {
        const now = Date.now();
        const signature = `${progress.phase}:${progress.done}/${progress.total}:${progress.file ?? ''}`;
        if (!force && signature === lastProgressSignature && now - lastPersistedAt < 2000) {
          return;
        }
        if (!force && progress.phase === lastPersistedPhase && now - lastPersistedAt < 2000) {
          return;
        }

        const updated = await jobsService.updateContentWorkerProgress(jobId, workerId, {
          ...progress,
          progressMap: { ...aggregatedProgressMap },
        });

        if (updated) {
          lastPersistedAt = now;
          lastProgressSignature = signature;
          lastPersistedPhase = progress.phase;
        }
      };

      const generated = await contentGenerationService.generateCourseContent(
        job.inputPayload as any,
        {
          onProgress: async (event: ContentGenerationProgressEvent) => {
            // Abortar inmediatamente si el lease fue revocado (job cancelado)
            if (leaseLost) {
              throw new Error(`Job ${jobId} cancelled — aborting content generation`);
            }
            aggregatedProgressMap[event.phase] = { done: event.done, total: event.total };
            const totalFilesGenerated = Object.values(aggregatedProgressMap).reduce(
              (sum, item) => sum + (item.done || 0),
              0,
            );
            logger.log(
              `Progress for job ${jobId}: ${event.phase} ${event.done}/${event.total} ${event.file}`,
            );

            await flushProgress(
              {
                phase: event.phase,
                done: event.done,
                total: event.total,
                file: event.file,
                message: event.message,
                filesGenerated: totalFilesGenerated,
              },
              event.done === event.total,
            );
          },
        },
      );

      if (leaseLost) {
        logger.warn(`Skipping completion for job ${jobId} because lease was lost after generation`);
        return;
      }

      await sendHeartbeat();
      if (leaseLost) {
        logger.warn(`Skipping content snapshot upload for job ${jobId} because the job was cancelled`);
        return;
      }

      const snapshot = buildContentSnapshot(job, generated);
      validateContentSnapshot(snapshot);

      const artifact = await uploadContentSnapshotWithRetry(
        artifactsService,
        job,
        snapshot,
        logger,
      );

      const finalSummary = {
        ...(generated.summary ?? {}),
        phase: 'completed',
        done: Object.keys(generated.F || {}).length,
        total: Object.keys(generated.F || {}).length,
        filesGenerated: Object.keys(generated.F || {}).length,
        fileCount: Object.keys(generated.F || {}).length,
        lastFile: generated.summary?.lastFile ?? null,
        contentSnapshotArtifactId: artifact.id,
        artifactIds: {
          contentSnapshot: artifact.id,
        },
      };

      await jobsService.updateContentWorkerProgress(jobId, workerId, {
        phase: 'upload',
        done: finalSummary.filesGenerated,
        total: finalSummary.total,
        file: artifact.filename,
        message: 'Content snapshot uploaded',
        filesGenerated: finalSummary.filesGenerated,
        progressMap: generated.summary?.progressMap ?? aggregatedProgressMap,
      });

      await sendHeartbeat();
      if (leaseLost) {
        logger.warn(`Skipping content completion for job ${jobId} because the job was cancelled`);
        return;
      }

      finalized = true;
      const completed = await jobsService.completeContentWorkerJob(
        jobId,
        workerId,
        finalSummary,
        artifact.id,
        'Content worker completed and snapshot uploaded',
      );
      if (!completed) {
        logger.warn(`Job ${jobId} could not be completed because worker ownership changed`);
        return;
      }

      const genMode    = generated.summary?.mode ?? 'template';
      const tokInput   = (generated.summary as any)?.tokensInput  ?? 0;
      const tokOutput  = (generated.summary as any)?.tokensOutput ?? 0;
      const hasClaude  = genMode === 'claude' && (tokInput > 0 || tokOutput > 0);

      await trackEvent('content_generation_completed', {
        mode:          hasClaude ? 'real' : 'template',
        provider:      hasClaude ? 'anthropic' : 'internal',
        model:         hasClaude ? (process.env.CONTENT_MODEL ?? 'claude-sonnet-4-5') : 'template_v1',
        component:     'content',
        costType:      hasClaude ? 'estimated' : 'mock_zero',
        costSource:    hasClaude ? 'configured_rate' : 'mock_zero',
        tokensInput:   hasClaude ? tokInput  : undefined,
        tokensOutput:  hasClaude ? tokOutput : undefined,
        durationMs:    generated.summary?.durationMs ?? null,
        metadata: {
          artifactId:     artifact.id,
          fileCount:      finalSummary.fileCount ?? 0,
          generationMode: genMode,
          progressMap:    generated.summary?.progressMap ?? aggregatedProgressMap,
        },
      });
      logger.log(`Real content generation completed for job ${jobId} with artifact ${artifact.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (leaseLost) {
        logger.warn(`Job ${jobId} ended after lease loss: ${message}`);
        return;
      }

      const retryable = !dryRun && realContentEnabled;
      await jobsService.failContentWorkerJob(jobId, workerId, message, retryable);
      await trackEvent('content_generation_failed', {
        failed: true,
        errorMessage: message,
        mode: dryRun ? 'dry_run' : 'real',
        costType: dryRun ? 'mock_zero' : 'unknown',
        metadata: {
          retryable,
        },
      });
      logger.error(`Job ${jobId} failed${retryable ? ' (retryable)' : ''}: ${message}`);
    } finally {
      finalized = true;
      clearInterval(heartbeatTimer);
    }
  }

  while (!shuttingDown) {
    while (!shuttingDown && activeJobs.size < concurrency) {
      const claimed = await jobsService.claimNextBackendContentJob(workerId, leaseSeconds);
      if (!claimed) break;

      idlePolls = 0;
      logger.log(`Claimed job ${claimed.id}`);

      const promise = handleJob(claimed)
        .catch((error) => {
          logger.error(
            `Unhandled worker error for job ${claimed.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          activeJobs.delete(promise);
        });

      activeJobs.add(promise);
    }

    if (activeJobs.size === 0) {
      idlePolls += 1;
      if (idlePolls === 1 || idlePolls % 10 === 0) {
        logger.log('No backend_content jobs found');
      }
    }

    await sleep(activeJobs.size >= concurrency ? 500 : pollMs);
  }
}

bootstrap().catch((error) => {
  const logger = new Logger('ContentWorker');
  logger.error(
    `Fatal content worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
