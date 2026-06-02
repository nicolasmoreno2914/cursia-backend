import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ProductionJobsService,
  VideoWorkerDryRunSummary,
  VideoWorkerSubmitSummary,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import {
  VideogenService,
  VideogenVideoPayload,
} from '../video-engine/videogen.service';

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

function buildVideogenPayload(job: ProductionJob, logger: Logger): VideogenVideoPayload[] {
  const payload = (job.inputPayload ?? {}) as Record<string, any>;
  const courseData = (payload.courseData ?? {}) as Record<string, any>;
  const timestamp = Date.now();

  // Try to extract chapters from courseData.mods (array of modules with caps)
  const mods: Array<Record<string, any>> = Array.isArray(courseData.mods) ? courseData.mods : [];
  const videos: VideogenVideoPayload[] = [];

  if (mods.length > 0) {
    let capIndex = 1;
    for (const mod of mods) {
      const caps: string[] = Array.isArray(mod.caps) ? mod.caps : [];
      for (const cap of caps) {
        const title = typeof cap === 'string' ? cap : `Capítulo ${capIndex}`;
        videos.push({
          title,
          content_txt: title + '. ' + (courseData.nombre ?? 'Curso Cursia') + '.',
          chapter_number: capIndex,
          client_reference_id: `cursia_capitulo_${capIndex}_${timestamp}`,
        });
        capIndex += 1;
      }
    }
  }

  // Fallback: direct caps array
  if (videos.length === 0 && Array.isArray(courseData.caps)) {
    const caps = courseData.caps as Array<any>;
    for (let i = 0; i < caps.length; i++) {
      const cap = caps[i];
      const title = cap?.t ?? cap?.title ?? cap?.n ?? `Capítulo ${i + 1}`;
      videos.push({
        title: String(title),
        content_txt: String(title) + '. ' + (courseData.nombre ?? 'Curso Cursia') + '.',
        chapter_number: i + 1,
        client_reference_id: `cursia_capitulo_${i + 1}_${timestamp}`,
      });
    }
  }

  // Final fallback: generate 2 mock chapters for QA
  if (videos.length === 0) {
    logger.warn(`Job ${job.id}: no chapters found in courseData, generating 2 mock chapters for QA`);
    for (let i = 1; i <= 2; i++) {
      videos.push({
        title: `Capítulo ${i} — ${courseData.nombre ?? 'Curso QA'}`,
        content_txt: `Capítulo ${i} del curso ${courseData.nombre ?? 'Curso QA'}.`,
        chapter_number: i,
        client_reference_id: `cursia_qa_cap${i}_${timestamp}`,
      });
    }
  }

  return videos;
}

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService = app.get(ProductionJobsService);
  const videogenService = app.get(VideogenService);
  const workerId = process.env.VIDEO_WORKER_ID || `video-worker-${process.pid}`;
  const pollMs = readPositiveInt('VIDEO_WORKER_POLL_MS', 3000);
  const concurrency = readPositiveInt('VIDEO_WORKER_CONCURRENCY', 1);
  const leaseSeconds = readPositiveInt('VIDEO_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs = readPositiveInt('VIDEO_WORKER_HEARTBEAT_MS', 15000);
  const dryRun = isTrueEnv('VIDEO_WORKER_DRY_RUN');
  const realVideogenEnabled = isTrueEnv('VIDEO_WORKER_ENABLE_REAL_VIDEOGEN');
  const workerEnabled = isTrueEnv('VIDEO_WORKER_ENABLED');

  if (!workerEnabled) {
    logger.warn('VIDEO_WORKER_ENABLED is not true — exiting');
    await app.close();
    process.exit(0);
  }

  let shuttingDown = false;
  let idlePolls = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s) to finish`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Video worker stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(
    `Video worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun}, realVideogenEnabled=${realVideogenEnabled})`,
  );

  async function handleJob(job: ProductionJob): Promise<void> {
    const jobId = job.id;
    let leaseLost = false;
    let heartbeatCount = 0;
    let finalized = false;

    const sendHeartbeat = async () => {
      if (finalized || leaseLost) return;
      try {
        const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
        if (!ok) {
          leaseLost = true;
          logger.warn(`Lease lost for job ${jobId}; stopping processing`);
          return;
        }
        heartbeatCount += 1;
        logger.log(`Heartbeat ${heartbeatCount} for job ${jobId}`);
      } catch (error) {
        leaseLost = true;
        logger.error(
          `Heartbeat failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const heartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, heartbeatMs);

    try {
      const markedRunning = await jobsService.markVideoWorkerRunning(jobId, workerId);
      if (!markedRunning) {
        logger.warn(`Job ${jobId} is no longer owned by ${workerId} before start`);
        return;
      }

      logger.log(`Job ${jobId} marked as running`);
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

        const summary: VideoWorkerDryRunSummary = {
          phase: 'dry_run',
          done: 1,
          total: 1,
          message: 'Video worker dry-run completed',
        };

        finalized = true;
        const completed = await jobsService.completeVideoWorkerDryRun(jobId, workerId, summary);
        if (!completed) {
          logger.warn(`Job ${jobId} could not be completed because worker ownership changed`);
          return;
        }

        logger.log(`Dry-run completed for job ${jobId}`);
        return;
      }

      if (!realVideogenEnabled) {
        throw new Error(
          'Real Videogen submit is disabled. Set VIDEO_WORKER_ENABLE_REAL_VIDEOGEN=true and VIDEO_WORKER_DRY_RUN=false.',
        );
      }

      const videos = buildVideogenPayload(job, logger);
      logger.log(`Submitting ${videos.length} videos to Videogen for job ${jobId}`);

      const batchResult = await videogenService.batchCreate(videos);
      logger.log(
        `Videogen batch submitted for job ${jobId}: batch_id=${batchResult.batch_id ?? 'n/a'}, jobs=${batchResult.jobs.length}`,
      );

      if (leaseLost) {
        logger.warn(`Skipping submit persistence for job ${jobId} because lease was lost`);
        return;
      }

      const submitSummary: VideoWorkerSubmitSummary = {
        phase: 'submitted',
        submittedAt: new Date().toISOString(),
        total: batchResult.jobs.length,
        batchId: batchResult.batch_id ?? null,
        videogenJobs: batchResult.jobs.map((j, idx) => ({
          cap: j.chapter_number || idx + 1,
          title: videos[idx]?.title ?? `Capítulo ${j.chapter_number || idx + 1}`,
          jobId: j.job_id,
          status: j.status,
          clientReferenceId: j.client_reference_id ?? null,
        })),
      };

      const saved = await jobsService.markVideoWorkerSubmitted(jobId, workerId, submitSummary);
      if (!saved) {
        logger.warn(`Job ${jobId} could not be marked submitted because worker ownership changed`);
        finalized = true;
        return;
      }

      // Job stays running — polling not yet implemented
      finalized = true;
      logger.log(`Job ${jobId} marked as submitted to Videogen. Polling not yet implemented.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (leaseLost) {
        logger.warn(`Job ${jobId} ended after lease loss: ${message}`);
        return;
      }

      await jobsService.failVideoWorkerJob(jobId, workerId, message);
      logger.error(`Job ${jobId} failed: ${message}`);
    } finally {
      finalized = true;
      clearInterval(heartbeatTimer);
    }
  }

  while (!shuttingDown) {
    while (!shuttingDown && activeJobs.size < concurrency) {
      const claimed = await jobsService.claimNextBackendVideoJob(workerId, leaseSeconds);
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
        logger.log('No backend_videos jobs found');
      }
    }

    await sleep(activeJobs.size >= concurrency ? 500 : pollMs);
  }
}

bootstrap().catch((error) => {
  const logger = new Logger('VideoWorker');
  logger.error(
    `Fatal video worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
