import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ContentWorkerDryRunSummary,
  ProductionJobsService,
} from '../modules/production-jobs/production-jobs.service';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

async function bootstrap() {
  const logger = new Logger('ContentWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService = app.get(ProductionJobsService);
  const workerId =
    process.env.CONTENT_WORKER_ID ||
    `content-worker-${process.pid}`;
  const pollMs = readPositiveInt('CONTENT_WORKER_POLL_MS', 3000);
  const concurrency = readPositiveInt('CONTENT_WORKER_CONCURRENCY', 1);
  const leaseSeconds = readPositiveInt('CONTENT_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs = readPositiveInt('CONTENT_WORKER_HEARTBEAT_MS', 15000);
  const dryRun = String(process.env.CONTENT_WORKER_DRY_RUN || '').toLowerCase() === 'true';

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
    `Content worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`,
  );

  async function handleJob(jobId: string): Promise<void> {
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
      const markedRunning = await jobsService.markContentWorkerRunning(jobId, workerId);
      if (!markedRunning) {
        logger.warn(`Job ${jobId} is no longer owned by ${workerId} before start`);
        return;
      }

      logger.log(`Job ${jobId} marked as running`);
      await sendHeartbeat();
      if (leaseLost) return;

      if (!dryRun) {
        throw new Error(
          'Content generation not implemented yet in worker skeleton. Set CONTENT_WORKER_DRY_RUN=true for QA.',
        );
      }

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

      logger.log(`Dry-run completed for job ${jobId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (leaseLost) {
        logger.warn(`Job ${jobId} ended after lease loss: ${message}`);
        return;
      }

      const retryable = dryRun;
      await jobsService.failContentWorkerJob(jobId, workerId, message, retryable);
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

      const promise = handleJob(claimed.id)
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
