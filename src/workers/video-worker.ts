import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ProductionJobsService,
  VideoWorkerDryRunSummary,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';

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

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService = app.get(ProductionJobsService);
  const workerId = process.env.VIDEO_WORKER_ID || `video-worker-${process.pid}`;
  const pollMs = readPositiveInt('VIDEO_WORKER_POLL_MS', 3000);
  const concurrency = readPositiveInt('VIDEO_WORKER_CONCURRENCY', 1);
  const leaseSeconds = readPositiveInt('VIDEO_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs = readPositiveInt('VIDEO_WORKER_HEARTBEAT_MS', 15000);
  const dryRun = isTrueEnv('VIDEO_WORKER_DRY_RUN');
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
    `Video worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`,
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

      throw new Error(
        'Real video generation is not yet implemented. Set VIDEO_WORKER_DRY_RUN=true to test.',
      );
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
