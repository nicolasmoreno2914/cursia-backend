import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ProductionJobsService,
  VideoWorkerDryRunSummary,
  VideoWorkerSubmitSummary,
  VideoWorkerPollingSummary,
  VideoWorkerVideogenCompletedSummary,
  VideogenJobEntry,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import {
  VideogenService,
  VideogenVideoPayload,
  VideogenBatchJob,
  isJobCompleted,
  isJobFailed,
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
  const videos: VideogenVideoPayload[] = [];

  // Extract from courseData.mods[].caps
  const mods: Array<Record<string, any>> = Array.isArray(courseData.mods) ? courseData.mods : [];
  if (mods.length > 0) {
    let capIndex = 1;
    for (const mod of mods) {
      const caps: any[] = Array.isArray(mod.caps) ? mod.caps : [];
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

  // Final fallback: 2 mock chapters for QA
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

function batchJobToEntry(j: VideogenBatchJob, idx: number, titles: Map<string, string>): VideogenJobEntry {
  return {
    cap: j.chapter_number || idx + 1,
    title: titles.get(j.job_id) ?? `Capítulo ${j.chapter_number || idx + 1}`,
    jobId: j.job_id,
    status: j.status,
    clientReferenceId: j.client_reference_id ?? null,
    downloadUrl: j.download_url ?? null,
    error: j.error ?? null,
    progress: j.progress ?? null,
  };
}

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService = app.get(ProductionJobsService);
  const videogenService = app.get(VideogenService);
  const workerId = process.env.VIDEO_WORKER_ID || `video-worker-${process.pid}`;
  const pollMs              = readPositiveInt('VIDEO_WORKER_POLL_MS', 3000);
  const concurrency         = readPositiveInt('VIDEO_WORKER_CONCURRENCY', 1);
  const leaseSeconds        = readPositiveInt('VIDEO_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs         = readPositiveInt('VIDEO_WORKER_HEARTBEAT_MS', 15000);
  const videogenPollMs      = readPositiveInt('VIDEO_WORKER_VIDEOGEN_POLL_MS', 15000);
  const maxPollMinutes      = readPositiveInt('VIDEO_WORKER_MAX_POLL_MINUTES', 60);
  const dryRun              = isTrueEnv('VIDEO_WORKER_DRY_RUN');
  const realVideogenEnabled = isTrueEnv('VIDEO_WORKER_ENABLE_REAL_VIDEOGEN');
  const workerEnabled       = isTrueEnv('VIDEO_WORKER_ENABLED');

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
    `Video worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, ` +
    `leaseSeconds=${leaseSeconds}, dryRun=${dryRun}, realVideogenEnabled=${realVideogenEnabled}, ` +
    `videogenPollMs=${videogenPollMs}, maxPollMinutes=${maxPollMinutes})`,
  );

  // ── Polling loop against Videogen ─────────────────────────────────────────

  async function pollUntilDone(
    job: ProductionJob,
    batchId: string,
    titleMap: Map<string, string>,
    leaseLostRef: { value: boolean },
    heartbeatRef: { count: number },
  ): Promise<void> {
    const jobId = job.id;
    const maxPollMs = maxPollMinutes * 60 * 1000;
    const pollStartAt = Date.now();

    logger.log(`Starting Videogen polling for job ${jobId}, batch ${batchId}`);

    while (!leaseLostRef.value && !shuttingDown) {
      // Timeout guard
      if (Date.now() - pollStartAt > maxPollMs) {
        throw new Error(
          `Videogen polling timeout: exceeded ${maxPollMinutes} minutes for batch ${batchId}`,
        );
      }

      // Poll batch status
      const batchStatus = await videogenService.getBatchStatus(batchId);
      const jobs = batchStatus.jobs;

      const completed = jobs.filter(j => isJobCompleted(j.status));
      const failed    = jobs.filter(j => isJobFailed(j.status));
      const pending   = jobs.filter(j => !isJobCompleted(j.status) && !isJobFailed(j.status));
      const total     = jobs.length;

      logger.log(
        `Poll result for job ${jobId}: total=${total}, completed=${completed.length}, ` +
        `failed=${failed.length}, pending=${pending.length}`,
      );

      const entries = jobs.map((j, idx) => batchJobToEntry(j, idx, titleMap));

      // All done (completed or failed)
      const allSettled = pending.length === 0;

      if (allSettled) {
        if (failed.length === 0) {
          // All completed successfully
          const finalSummary: VideoWorkerVideogenCompletedSummary = {
            phase: 'videogen_completed',
            batchId,
            total,
            completed: completed.length,
            failed: 0,
            videogenJobs: entries,
            completedAt: new Date().toISOString(),
          };
          const ok = await jobsService.completeVideoWorkerVideogen(jobId, workerId, finalSummary);
          if (!ok) {
            logger.warn(`Job ${jobId} could not be marked complete — ownership changed`);
          } else {
            logger.log(`Job ${jobId} completed: all ${total} videos ready from Videogen`);
          }
          return;
        } else {
          // Some failed
          const errorDetails = failed
            .map(j => `cap${j.chapter_number}(${j.job_id}): ${j.error ?? 'unknown'}`)
            .join(', ');

          const partialSummary: VideoWorkerVideogenCompletedSummary = {
            phase: 'videogen_completed',
            batchId,
            total,
            completed: completed.length,
            failed: failed.length,
            videogenJobs: entries,
            completedAt: new Date().toISOString(),
          };

          if (completed.length > 0) {
            // Partial success → failed_recoverable
            const errorMsg = `Videogen partial failure: ${completed.length}/${total} completed, ${failed.length} failed. ${errorDetails}`;
            await jobsService.failVideoWorkerJob(jobId, workerId, errorMsg);
            logger.error(`Job ${jobId} partial failure: ${errorMsg}`);
          } else {
            // Total failure
            const errorMsg = `Videogen all videos failed: ${errorDetails}`;
            await jobsService.failVideoWorkerJob(jobId, workerId, errorMsg);
            logger.error(`Job ${jobId} total failure: ${errorMsg}`);
          }
          return;
        }
      }

      // Still processing — update DB and wait
      const pollingSummary: VideoWorkerPollingSummary = {
        phase: 'polling',
        batchId,
        total,
        completed: completed.length,
        failed: failed.length,
        pending: pending.length,
        videogenJobs: entries,
        lastPolledAt: new Date().toISOString(),
      };

      const updated = await jobsService.markVideoWorkerPolling(jobId, workerId, pollingSummary);
      if (!updated) {
        logger.warn(`Job ${jobId} polling update failed — ownership may have changed`);
        return;
      }

      logger.log(
        `Job ${jobId} polling: ${completed.length}/${total} done, waiting ${videogenPollMs}ms`,
      );
      await sleep(videogenPollMs);
    }
  }

  // ── Main job handler ───────────────────────────────────────────────────────

  async function handleJob(job: ProductionJob): Promise<void> {
    const jobId = job.id;
    let leaseLost = false;
    let heartbeatCount = 0;
    let finalized = false;
    const leaseLostRef = { value: false };

    const sendHeartbeat = async () => {
      if (finalized || leaseLost) return;
      try {
        const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
        if (!ok) {
          leaseLost = true;
          leaseLostRef.value = true;
          logger.warn(`Lease lost for job ${jobId}; stopping processing`);
          return;
        }
        heartbeatCount += 1;
        logger.log(`Heartbeat ${heartbeatCount} for job ${jobId}`);
      } catch (error) {
        leaseLost = true;
        leaseLostRef.value = true;
        logger.error(
          `Heartbeat failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

    try {
      const markedRunning = await jobsService.markVideoWorkerRunning(jobId, workerId);
      if (!markedRunning) {
        logger.warn(`Job ${jobId} is no longer owned by ${workerId} before start`);
        return;
      }

      logger.log(`Job ${jobId} marked as running`);
      await sendHeartbeat();
      if (leaseLost) return;

      // ── dry-run ────────────────────────────────────────────────────────────
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
        } else {
          logger.log(`Dry-run completed for job ${jobId}`);
        }
        return;
      }

      if (!realVideogenEnabled) {
        throw new Error(
          'Real Videogen submit is disabled. Set VIDEO_WORKER_ENABLE_REAL_VIDEOGEN=true and VIDEO_WORKER_DRY_RUN=false.',
        );
      }

      // ── Detect phase: submit or polling ───────────────────────────────────
      const currentSummary = (job.outputSummary ?? {}) as Record<string, any>;
      const currentPhase = currentSummary?.phase as string | undefined;
      let batchId: string | null = currentSummary?.batchId ?? null;

      // Build title map from existing videogenJobs for display
      const titleMap = new Map<string, string>();
      if (Array.isArray(currentSummary?.videogenJobs)) {
        for (const vj of currentSummary.videogenJobs as any[]) {
          if (vj?.jobId && vj?.title) titleMap.set(vj.jobId, vj.title);
        }
      }

      if (currentPhase === 'submitted' || currentPhase === 'polling') {
        // Re-claimed after lease expiry — skip submit, go straight to polling
        if (!batchId) {
          throw new Error(`Job ${jobId} is in phase=${currentPhase} but has no batchId in output_summary`);
        }
        logger.log(`Job ${jobId} re-claimed in phase=${currentPhase}, batchId=${batchId} — entering polling`);
      } else {
        // ── Submit phase ─────────────────────────────────────────────────────
        const videos = buildVideogenPayload(job, logger);
        logger.log(`Submitting ${videos.length} videos to Videogen for job ${jobId}`);

        const batchResult = await videogenService.batchCreate(videos);
        batchId = batchResult.batch_id ?? null;

        logger.log(
          `Videogen batch submitted for job ${jobId}: batch_id=${batchId ?? 'n/a'}, jobs=${batchResult.jobs.length}`,
        );

        if (leaseLost) {
          logger.warn(`Skipping submit persistence for job ${jobId} because lease was lost`);
          return;
        }

        if (!batchId) {
          throw new Error(`Videogen returned no batch_id for job ${jobId}`);
        }

        // Build title map from submitted jobs
        batchResult.jobs.forEach((j, idx) => {
          titleMap.set(j.job_id, videos[idx]?.title ?? `Capítulo ${j.chapter_number || idx + 1}`);
        });

        const submitSummary: VideoWorkerSubmitSummary = {
          phase: 'submitted',
          submittedAt: new Date().toISOString(),
          total: batchResult.jobs.length,
          batchId,
          videogenJobs: batchResult.jobs.map((j, idx) => ({
            cap: j.chapter_number || idx + 1,
            title: titleMap.get(j.job_id) ?? `Capítulo ${j.chapter_number || idx + 1}`,
            jobId: j.job_id,
            status: j.status,
            clientReferenceId: j.client_reference_id ?? null,
            downloadUrl: null,
            error: null,
          })),
        };

        const saved = await jobsService.markVideoWorkerSubmitted(jobId, workerId, submitSummary);
        if (!saved) {
          logger.warn(`Job ${jobId} could not be marked submitted because worker ownership changed`);
          finalized = true;
          return;
        }

        logger.log(`Job ${jobId} submitted to Videogen. Now entering polling...`);
      }

      // ── Polling phase ─────────────────────────────────────────────────────
      await pollUntilDone(job, batchId!, titleMap, leaseLostRef, { count: heartbeatCount });

      finalized = true;

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

  // ── Main loop ──────────────────────────────────────────────────────────────

  while (!shuttingDown) {
    while (!shuttingDown && activeJobs.size < concurrency) {
      // First: try queued/retrying jobs (submit path)
      let claimed = await jobsService.claimNextBackendVideoJob(workerId, leaseSeconds);

      // Second: try orphaned running jobs (polling path)
      if (!claimed) {
        claimed = await jobsService.claimNextBackendVideoPollingJob(workerId, leaseSeconds);
      }

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
