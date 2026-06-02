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
  VideogenBatchStatus,
  isJobCompleted,
  isJobFailed,
} from '../video-engine/videogen.service';

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
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

function buildVideogenPayload(job: ProductionJob, logger: Logger): VideogenVideoPayload[] {
  const payload    = (job.inputPayload ?? {}) as Record<string, any>;
  const courseData = (payload.courseData ?? {}) as Record<string, any>;
  const timestamp  = Date.now();
  const videos: VideogenVideoPayload[] = [];

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

  if (videos.length === 0 && Array.isArray(courseData.caps)) {
    const caps = courseData.caps as Array<any>;
    for (let i = 0; i < caps.length; i++) {
      const cap   = caps[i];
      const title = cap?.t ?? cap?.title ?? cap?.n ?? `Capítulo ${i + 1}`;
      videos.push({
        title: String(title),
        content_txt: String(title) + '. ' + (courseData.nombre ?? 'Curso Cursia') + '.',
        chapter_number: i + 1,
        client_reference_id: `cursia_capitulo_${i + 1}_${timestamp}`,
      });
    }
  }

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
    cap:              j.chapter_number || idx + 1,
    title:            titles.get(j.job_id) ?? `Capítulo ${j.chapter_number || idx + 1}`,
    jobId:            j.job_id,
    status:           j.status,
    clientReferenceId: j.client_reference_id ?? null,
    downloadUrl:      j.download_url ?? null,
    error:            j.error ?? null,
    progress:         j.progress ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Videogen — in-memory state
// ─────────────────────────────────────────────────────────────────────────────

interface MockBatchState {
  pollCount:   number;
  jobIds:      string[];
  chapternums: number[];
  clientRefs:  Array<string | null>;
}

const mockState = new Map<string, MockBatchState>();

function mockBatchCreate(videos: VideogenVideoPayload[]): VideogenBatchResult {
  const ts      = Date.now();
  const batchId = `mock_batch_${ts}`;
  const jobs: VideogenBatchJob[] = videos.map(v => ({
    job_id:              `mock_job_cap${v.chapter_number}_${ts}`,
    chapter_number:      v.chapter_number,
    status:              'queued',
    client_reference_id: v.client_reference_id,
    download_url:        null,
    error:               null,
    progress:            null,
  }));
  mockState.set(batchId, {
    pollCount:   0,
    jobIds:      jobs.map(j => j.job_id),
    chapternums: jobs.map(j => j.chapter_number),
    clientRefs:  jobs.map(j => j.client_reference_id ?? null),
  });
  return { batch_id: batchId, jobs };
}

// Rehydrate mock state for re-claimed jobs (lease expired between sessions)
function rehydrateMockState(batchId: string, videogenJobs: any[]): void {
  mockState.set(batchId, {
    pollCount:   0,
    jobIds:      videogenJobs.map((j: any) => String(j.jobId ?? '')),
    chapternums: videogenJobs.map((j: any) => Number(j.cap ?? 0)),
    clientRefs:  videogenJobs.map((j: any) => j.clientReferenceId ?? null),
  });
}

function mockGetBatchStatus(
  batchId:          string,
  scenario:         string,
  mockTimeoutPolls: number,
  logger:           Logger,
): VideogenBatchStatus {
  const state = mockState.get(batchId);
  if (!state) {
    throw new Error(`Mock: no state for batch ${batchId} — did re-hydration run?`);
  }

  state.pollCount += 1;
  const { pollCount, jobIds, chapternums, clientRefs } = state;

  logger.log(`Mock poll #${pollCount} for batch ${batchId} [scenario=${scenario}]`);

  const makeJobs = (statusFn: (idx: number) => Partial<VideogenBatchJob>): VideogenBatchJob[] =>
    jobIds.map((id, idx) => ({
      job_id:              id,
      chapter_number:      chapternums[idx] ?? idx + 1,
      status:              'queued',
      client_reference_id: clientRefs[idx] ?? null,
      download_url:        null,
      error:               null,
      progress:            null,
      ...statusFn(idx),
    } as VideogenBatchJob));

  switch (scenario) {
    case 'success':
      if (pollCount >= 3) {
        return {
          batch_id: batchId,
          jobs: makeJobs((idx) => ({
            status:       'completed',
            progress:     100,
            download_url: `https://mock-cdn.cursia.local/videos/cap${chapternums[idx]}_${jobIds[idx]}.mp4`,
          })),
        };
      }
      return {
        batch_id: batchId,
        jobs: makeJobs(() => ({ status: 'processing', progress: pollCount === 2 ? 85 : 30 })),
      };

    case 'partial_failure':
      if (pollCount >= 3) {
        return {
          batch_id: batchId,
          jobs: makeJobs((idx) =>
            idx === 0
              ? { status: 'completed', progress: 100, download_url: `https://mock-cdn.cursia.local/videos/cap${chapternums[idx]}_${jobIds[idx]}.mp4` }
              : { status: 'failed', error: `Mock partial failure: rendering error on cap ${chapternums[idx]}` },
          ),
        };
      }
      return {
        batch_id: batchId,
        jobs: makeJobs(() => ({ status: 'processing', progress: pollCount === 2 ? 85 : 30 })),
      };

    case 'all_failed':
      if (pollCount >= 2) {
        return {
          batch_id: batchId,
          jobs: makeJobs((idx) => ({
            status: 'failed',
            error:  `Mock total failure: rendering crashed on cap ${chapternums[idx]}`,
          })),
        };
      }
      return {
        batch_id: batchId,
        jobs: makeJobs(() => ({ status: 'processing', progress: 30 })),
      };

    case 'timeout':
      if (pollCount >= mockTimeoutPolls) {
        throw new Error(
          `Mock timeout: batch ${batchId} exceeded ${mockTimeoutPolls} polls without completing (scenario=timeout)`,
        );
      }
      return {
        batch_id: batchId,
        jobs: makeJobs(() => ({ status: 'processing', progress: Math.min(30 + pollCount * 10, 90) })),
      };

    default:
      return {
        batch_id: batchId,
        jobs: makeJobs(() => ({ status: 'processing', progress: 50 })),
      };
  }
}

// Needed for return type of mockBatchCreate
interface VideogenBatchResult {
  batch_id?: string | null;
  jobs: VideogenBatchJob[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const jobsService     = app.get(ProductionJobsService);
  const videogenService = app.get(VideogenService);

  const workerId           = process.env.VIDEO_WORKER_ID || `video-worker-${process.pid}`;
  const pollMs             = readPositiveInt('VIDEO_WORKER_POLL_MS', 3000);
  const concurrency        = readPositiveInt('VIDEO_WORKER_CONCURRENCY', 1);
  const leaseSeconds       = readPositiveInt('VIDEO_WORKER_LEASE_SECONDS', 60);
  const heartbeatMs        = readPositiveInt('VIDEO_WORKER_HEARTBEAT_MS', 15000);
  const videogenPollMs     = readPositiveInt('VIDEO_WORKER_VIDEOGEN_POLL_MS', 15000);
  const maxPollMinutes     = readPositiveInt('VIDEO_WORKER_MAX_POLL_MINUTES', 60);
  const dryRun             = isTrueEnv('VIDEO_WORKER_DRY_RUN');
  const realVideogenEnabled= isTrueEnv('VIDEO_WORKER_ENABLE_REAL_VIDEOGEN');
  const workerEnabled      = isTrueEnv('VIDEO_WORKER_ENABLED');

  // Mock mode
  const mockVideogen    = isTrueEnv('VIDEO_WORKER_MOCK_VIDEOGEN');
  const mockScenario    = (process.env.VIDEO_WORKER_MOCK_SCENARIO ?? 'success').trim();
  const mockPollDelayMs = readPositiveInt('VIDEO_WORKER_MOCK_POLL_DELAY_MS', 800);
  const mockTimeoutPolls= readPositiveInt('VIDEO_WORKER_MOCK_TIMEOUT_POLLS', 5);

  // Effective poll delay: fast for mock, real for production
  const effectivePollDelayMs = mockVideogen ? mockPollDelayMs : videogenPollMs;

  if (!workerEnabled) {
    logger.warn('VIDEO_WORKER_ENABLED is not true — exiting');
    await app.close();
    process.exit(0);
  }

  let shuttingDown = false;
  let idlePolls    = 0;
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

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(
    `Video worker started (workerId=${workerId}, pollMs=${pollMs}, concurrency=${concurrency}, ` +
    `leaseSeconds=${leaseSeconds}, dryRun=${dryRun}, realVideogenEnabled=${realVideogenEnabled}, ` +
    `videogenPollMs=${videogenPollMs}, maxPollMinutes=${maxPollMinutes}, ` +
    `mockVideogen=${mockVideogen}, mockScenario=${mockScenario})`,
  );

  if (mockVideogen) {
    logger.log(
      `[MOCK MODE] Videogen calls are SIMULATED. scenario=${mockScenario}, ` +
      `pollDelayMs=${mockPollDelayMs}, timeoutPolls=${mockTimeoutPolls}`,
    );
  }

  // ── Polling loop ────────────────────────────────────────────────────────────

  async function pollUntilDone(
    job:          ProductionJob,
    batchId:      string,
    titleMap:     Map<string, string>,
    leaseLostRef: { value: boolean },
  ): Promise<void> {
    const jobId        = job.id;
    const maxPollMs    = maxPollMinutes * 60 * 1000;
    const pollStartAt  = Date.now();

    logger.log(`Starting ${mockVideogen ? 'MOCK ' : ''}Videogen polling for job ${jobId}, batch ${batchId}`);

    while (!leaseLostRef.value && !shuttingDown) {
      if (Date.now() - pollStartAt > maxPollMs) {
        throw new Error(`Videogen polling timeout: exceeded ${maxPollMinutes} minutes for batch ${batchId}`);
      }

      // Get batch status — real or mock
      const batchStatus: VideogenBatchStatus = mockVideogen
        ? mockGetBatchStatus(batchId, mockScenario, mockTimeoutPolls, logger)
        : await videogenService.getBatchStatus(batchId);

      const jobs      = batchStatus.jobs;
      const completed = jobs.filter(j => isJobCompleted(j.status));
      const failed    = jobs.filter(j => isJobFailed(j.status));
      const pending   = jobs.filter(j => !isJobCompleted(j.status) && !isJobFailed(j.status));
      const total     = jobs.length;

      logger.log(
        `Poll result for job ${jobId}: total=${total}, completed=${completed.length}, ` +
        `failed=${failed.length}, pending=${pending.length}`,
      );

      const entries = jobs.map((j, idx) => batchJobToEntry(j, idx, titleMap));

      if (pending.length === 0) {
        // All settled
        if (failed.length === 0) {
          // ── Full success ───────────────────────────────────────────────────
          const finalSummary: VideoWorkerVideogenCompletedSummary = {
            phase:        'videogen_completed',
            batchId,
            total,
            completed:    completed.length,
            failed:       0,
            videogenJobs: entries,
            completedAt:  new Date().toISOString(),
          };
          const ok = await jobsService.completeVideoWorkerVideogen(jobId, workerId, finalSummary);
          if (!ok) {
            logger.warn(`Job ${jobId} could not be marked complete — ownership changed`);
          } else {
            logger.log(`Job ${jobId} completed: all ${total} videos ready${mockVideogen ? ' [MOCK]' : ''}`);
          }
        } else {
          // ── Partial or total failure ──────────────────────────────────────
          const errorDetails = failed
            .map(j => `cap${j.chapter_number}(${j.job_id}): ${j.error ?? 'unknown'}`)
            .join(', ');
          const errorMsg = failed.length === total
            ? `Videogen all videos failed: ${errorDetails}`
            : `Videogen partial failure: ${completed.length}/${total} completed, ${failed.length} failed. ${errorDetails}`;

          await jobsService.failVideoWorkerJob(jobId, workerId, errorMsg);
          logger.error(`Job ${jobId} ${failed.length === total ? 'total' : 'partial'} failure: ${errorMsg}`);
        }
        return;
      }

      // Still processing — persist polling state
      const pollingSummary: VideoWorkerPollingSummary = {
        phase:        'polling',
        batchId,
        total,
        completed:    completed.length,
        failed:       failed.length,
        pending:      pending.length,
        videogenJobs: entries,
        lastPolledAt: new Date().toISOString(),
      };

      const updated = await jobsService.markVideoWorkerPolling(jobId, workerId, pollingSummary);
      if (!updated) {
        logger.warn(`Job ${jobId} polling update failed — ownership may have changed`);
        return;
      }

      logger.log(`Job ${jobId} polling: ${completed.length}/${total} done, waiting ${effectivePollDelayMs}ms`);
      await sleep(effectivePollDelayMs);
    }
  }

  // ── Main job handler ────────────────────────────────────────────────────────

  async function handleJob(job: ProductionJob): Promise<void> {
    const jobId         = job.id;
    let leaseLost       = false;
    let heartbeatCount  = 0;
    let finalized       = false;
    const leaseLostRef  = { value: false };

    const sendHeartbeat = async () => {
      if (finalized || leaseLost) return;
      try {
        const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
        if (!ok) {
          leaseLost = leaseLostRef.value = true;
          logger.warn(`Lease lost for job ${jobId}; stopping processing`);
          return;
        }
        heartbeatCount += 1;
        logger.log(`Heartbeat ${heartbeatCount} for job ${jobId}`);
      } catch (error) {
        leaseLost = leaseLostRef.value = true;
        logger.error(`Heartbeat failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
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

      // ── Dry-run ─────────────────────────────────────────────────────────────
      if (dryRun) {
        const waitMs = 2000 + Math.floor(Math.random() * 3000);
        logger.log(`Job ${jobId} running in dry-run mode for ${waitMs}ms`);
        await sleep(waitMs);

        if (leaseLost) { logger.warn(`Skipping completion for job ${jobId} — lease lost`); return; }

        const summary: VideoWorkerDryRunSummary = {
          phase:         'dry_run',
          done:          1,
          total:         1,
          message:       'Video worker dry-run completed',
        };
        finalized = true;
        const ok = await jobsService.completeVideoWorkerDryRun(jobId, workerId, summary);
        if (!ok) logger.warn(`Job ${jobId} could not be completed — worker ownership changed`);
        else logger.log(`Dry-run completed for job ${jobId}`);
        return;
      }

      if (!realVideogenEnabled) {
        throw new Error('Set VIDEO_WORKER_ENABLE_REAL_VIDEOGEN=true and VIDEO_WORKER_DRY_RUN=false.');
      }

      // ── Detect phase: submit or resume polling ──────────────────────────────
      const currentSummary = (job.outputSummary ?? {}) as Record<string, any>;
      const currentPhase   = currentSummary?.phase as string | undefined;
      let batchId: string | null = currentSummary?.batchId ?? null;

      const titleMap = new Map<string, string>();
      if (Array.isArray(currentSummary?.videogenJobs)) {
        for (const vj of currentSummary.videogenJobs as any[]) {
          if (vj?.jobId && vj?.title) titleMap.set(vj.jobId, vj.title);
        }
      }

      if (currentPhase === 'submitted' || currentPhase === 'polling') {
        // Re-claimed job — skip submit, resume polling
        if (!batchId) throw new Error(`Job ${jobId} in phase=${currentPhase} has no batchId`);

        logger.log(`Job ${jobId} re-claimed in phase=${currentPhase}, batchId=${batchId} — entering polling`);

        // Re-hydrate mock state so it can pick up where it left off
        if (mockVideogen && Array.isArray(currentSummary?.videogenJobs)) {
          rehydrateMockState(batchId, currentSummary.videogenJobs as any[]);
          logger.log(`[MOCK] Re-hydrated batch ${batchId} with ${currentSummary.videogenJobs.length} jobs`);
        }
      } else {
        // ── Submit phase ──────────────────────────────────────────────────────
        const videos = buildVideogenPayload(job, logger);
        logger.log(`${mockVideogen ? '[MOCK] ' : ''}Submitting ${videos.length} videos for job ${jobId}`);

        const batchResult: VideogenBatchResult = mockVideogen
          ? mockBatchCreate(videos)
          : await videogenService.batchCreate(videos);

        batchId = batchResult.batch_id ?? null;
        logger.log(
          `${mockVideogen ? '[MOCK] ' : ''}Batch submitted for job ${jobId}: ` +
          `batch_id=${batchId ?? 'n/a'}, jobs=${batchResult.jobs.length}`,
        );

        if (leaseLost) { logger.warn(`Skipping submit persistence for job ${jobId} — lease lost`); return; }
        if (!batchId)  { throw new Error(`Videogen returned no batch_id for job ${jobId}`); }

        batchResult.jobs.forEach((j, idx) => {
          titleMap.set(j.job_id, videos[idx]?.title ?? `Capítulo ${j.chapter_number || idx + 1}`);
        });

        const submitSummary: VideoWorkerSubmitSummary = {
          phase:       'submitted',
          submittedAt: new Date().toISOString(),
          total:       batchResult.jobs.length,
          batchId,
          videogenJobs: batchResult.jobs.map((j, idx) => ({
            cap:               j.chapter_number || idx + 1,
            title:             titleMap.get(j.job_id) ?? `Capítulo ${j.chapter_number || idx + 1}`,
            jobId:             j.job_id,
            status:            j.status,
            clientReferenceId: j.client_reference_id ?? null,
            downloadUrl:       null,
            error:             null,
          })),
        };

        const saved = await jobsService.markVideoWorkerSubmitted(jobId, workerId, submitSummary);
        if (!saved) {
          logger.warn(`Job ${jobId} could not be marked submitted — worker ownership changed`);
          finalized = true;
          return;
        }

        logger.log(`Job ${jobId} submitted. Entering polling...`);
      }

      // ── Polling phase ──────────────────────────────────────────────────────
      await pollUntilDone(job, batchId!, titleMap, leaseLostRef);
      finalized = true;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (leaseLost) { logger.warn(`Job ${jobId} ended after lease loss: ${message}`); return; }
      await jobsService.failVideoWorkerJob(jobId, workerId, message);
      logger.error(`Job ${jobId} failed: ${message}`);
    } finally {
      finalized = true;
      clearInterval(heartbeatTimer);
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  while (!shuttingDown) {
    while (!shuttingDown && activeJobs.size < concurrency) {
      let claimed = await jobsService.claimNextBackendVideoJob(workerId, leaseSeconds);
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
        .finally(() => { activeJobs.delete(promise); });

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
