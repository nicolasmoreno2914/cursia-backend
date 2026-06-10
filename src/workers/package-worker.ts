import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { ProductionJobsService } from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { MbzBuilderService, HvpEntry, MbzBuildResult } from '../package/mbz-builder.service';
import { EventsService } from '../events/events.service';
import * as JSZip from 'jszip';

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

// ─────────────────────────────────────────────────────────────────────────────
// Artifact download helpers
// ─────────────────────────────────────────────────────────────────────────────

async function downloadArtifactJson(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Record<string, any> | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url    = urlRes.url;
    if (!url) { logger.warn(`[PackageWorker] No URL for artifact ${artifactId}`); return null; }
    const res = await fetch(url);
    if (!res.ok) { logger.warn(`[PackageWorker] Artifact ${artifactId} download HTTP ${res.status}`); return null; }
    return res.json() as Promise<Record<string, any>>;
  } catch (e) {
    logger.warn(`[PackageWorker] Artifact ${artifactId} download error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function downloadArtifactBuffer(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Buffer | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url    = urlRes.url;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    logger.warn(`[PackageWorker] Buffer artifact ${artifactId} error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function findExistingMbzFinalArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type: 'mbz_final' });
    if (!list?.length) return null;
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    if (candidate.sizeBytes !== null && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MBZ deep validation
// ─────────────────────────────────────────────────────────────────────────────

/** Thresholds for a standard Cursia course (3 modules, 9 chapters). */
const MBZ_THRESHOLDS = {
  /** Minimum size in bytes for a plausible MBZ. */
  minSizeBytes: 50_000,
  /** Hard-fail if fewer than this many SCORM activities (out of 9 expected). */
  minScorm: 5,
  /** Hard-fail if fewer than this many quiz activities (out of 4 expected). */
  minQuiz: 2,
  /** Hard-fail if fewer than this many total activities. */
  minActivities: 15,
  /** Hard-fail if fewer than this many sections. */
  minSections: 4,
  /** Warning if SCORM count is below this (complete set). */
  warnScorm: 9,
  /** Warning if quiz count is below this. */
  warnQuiz: 4,
};

interface MbzActivityCounts {
  sections:        number;
  h5p:             number;
  scorm:           number;
  quiz:            number;
  label:           number;
  page:            number;
  forum:           number;
  totalActivities: number;
  totalFiles:      number;
}

interface MbzValidationResult {
  status:   'passed' | 'warning' | 'failed';
  errors:   string[];
  warnings: string[];
  counts:   MbzActivityCounts;
}

async function validateFinalMoodlePackage(
  buffer: Buffer,
  buildResult: MbzBuildResult,
  logger: Logger,
): Promise<MbzValidationResult> {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const counts: MbzActivityCounts = {
    sections: 0, h5p: 0, scorm: 0, quiz: 0, label: 0, page: 0, forum: 0,
    totalActivities: 0, totalFiles: 0,
  };

  // 1. Basic structural checks
  if (!buildResult.hasMoodleBackupXml) {
    errors.push('moodle_backup.xml no encontrado en el paquete');
  }
  if (buildResult.sizeBytes < MBZ_THRESHOLDS.minSizeBytes) {
    errors.push(`Paquete demasiado pequeño: ${Math.round(buildResult.sizeBytes / 1024)} KB (mínimo ${Math.round(MBZ_THRESHOLDS.minSizeBytes / 1024)} KB)`);
  }

  // 2. Parse ZIP to count activities and validate inner structure
  try {
    const zip = await JSZip.loadAsync(buffer);

    counts.totalFiles = Object.keys(zip.files).filter(k => !zip.files[k].dir).length;

    // Verify files.xml exists
    if (!zip.files['files.xml']) {
      warnings.push('files.xml no encontrado en el paquete');
    }

    // Parse moodle_backup.xml for structural counts
    const backupFile = zip.files['moodle_backup.xml'];
    if (backupFile) {
      const xmlText = await backupFile.async('text');

      // Count sections via <section id="…"> entries
      counts.sections = (xmlText.match(/<section id="/g) || []).length;

      // Count each activity type via <modulename>…</modulename> occurrences
      const modMatches = xmlText.match(/<modulename>([^<]+)<\/modulename>/g) || [];
      for (const m of modMatches) {
        const name = m.replace(/<\/?modulename>/g, '').toLowerCase().trim();
        counts.totalActivities++;
        if      (name === 'hvp')   counts.h5p++;
        else if (name === 'scorm') counts.scorm++;
        else if (name === 'quiz')  counts.quiz++;
        else if (name === 'label') counts.label++;
        else if (name === 'page')  counts.page++;
        else if (name === 'forum') counts.forum++;
      }
    } else {
      // backupFile missing — already recorded above
      errors.push('moodle_backup.xml ausente en el ZIP al inspeccionar estructura interna');
    }

  } catch (e) {
    errors.push(`No se pudo abrir el ZIP como paquete Moodle válido: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Structural quality thresholds
  if (counts.sections < MBZ_THRESHOLDS.minSections) {
    errors.push(`Secciones insuficientes: ${counts.sections} encontradas (mínimo ${MBZ_THRESHOLDS.minSections})`);
  }

  if (counts.scorm < MBZ_THRESHOLDS.minScorm) {
    errors.push(`SCORMs insuficientes: ${counts.scorm} encontrados (mínimo ${MBZ_THRESHOLDS.minScorm}, esperados 9)`);
  } else if (counts.scorm < MBZ_THRESHOLDS.warnScorm) {
    warnings.push(`SCORMs incompletos: ${counts.scorm}/9 encontrados`);
  }

  if (counts.quiz < MBZ_THRESHOLDS.minQuiz) {
    errors.push(`Quizzes insuficientes: ${counts.quiz} encontrados (mínimo ${MBZ_THRESHOLDS.minQuiz}, esperados 4)`);
  } else if (counts.quiz < MBZ_THRESHOLDS.warnQuiz) {
    warnings.push(`Quizzes incompletos: ${counts.quiz}/4 encontrados`);
  }

  if (counts.h5p === 0) {
    warnings.push('No se encontraron actividades H5P — videos interactivos no incluidos en este paquete');
  }

  if (counts.totalActivities < MBZ_THRESHOLDS.minActivities) {
    errors.push(`Actividades totales insuficientes: ${counts.totalActivities} encontradas (mínimo ${MBZ_THRESHOLDS.minActivities})`);
  }

  const status: 'passed' | 'warning' | 'failed' =
    errors.length > 0   ? 'failed'  :
    warnings.length > 0 ? 'warning' :
    'passed';

  logger.log(
    `[PackageWorker] MBZ validation → ${status} | ` +
    `sections=${counts.sections} scorm=${counts.scorm} quiz=${counts.quiz} h5p=${counts.h5p} ` +
    `labels=${counts.label} pages=${counts.page} totalAct=${counts.totalActivities} totalFiles=${counts.totalFiles}` +
    (errors.length   ? ` | errors: ${errors.join('; ')}`   : '') +
    (warnings.length ? ` | warnings: ${warnings.join('; ')}` : ''),
  );

  return { status, errors, warnings, counts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core job handler
// ─────────────────────────────────────────────────────────────────────────────

async function handlePackageJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  mbzBuilder: MbzBuilderService,
  eventsService: EventsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  logger: Logger,
): Promise<void> {
  const jobId    = job.id;
  const payload  = (job.inputPayload ?? {}) as Record<string, any>;
  const rawCourseId = job.frontendCourseId || String(job.courseId ?? 'unknown');
  const options  = (payload.options ?? {}) as Record<string, any>;
  const parentJobId = payload?.metadata?.parentJobId ?? null;

  let leaseLost = false;
  let finalized = false;

  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) { leaseLost = true; logger.warn(`[PackageWorker] Lease lost for job ${jobId}`); }
    } catch { leaseLost = true; }
  };

  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateProgress = async (phase: string, message: string) => {
    if (leaseLost) return;
    await jobsService.updatePackageWorkerProgress(jobId, workerId, phase, message).catch(() => {});
  };

  const trackEvent = async (eventType: string, extra: Record<string, any> = {}) =>
    eventsService.trackBackendEvent({
      userId: job.ownerId,
      eventType,
      courseId: rawCourseId,
      jobId,
      parentJobId,
      component: 'package',
      provider: 'internal',
      model: 'mbz_builder_v1',
      mode: 'real',
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
    const marked = await jobsService.markPackageWorkerRunning(jobId, workerId);
    if (!marked) { logger.warn(`[PackageWorker] Job ${jobId} no longer owned by ${workerId}`); return; }
    await trackEvent('package_generation_started', {
      units: 1,
      unitType: 'per_operation',
    });

    await sendHeartbeat();
    if (leaseLost) return;

    // ── Step 1: Restore-first — check existing mbz_final ────────────────────
    await updateProgress('checking_existing_package', 'Verificando paquete existente…');

    const existingMbz = await findExistingMbzFinalArtifact(artifactsService, job.ownerId, rawCourseId);
    if (existingMbz) {
      logger.log(`[PackageWorker] mbz_final artifact already exists (${existingMbz.id}) — marking completed`);
      finalized = true;
      await jobsService.completePackageWorkerJob(jobId, workerId, {
        mbzFinal: {
          status:     'skipped_existing',
          artifactId: existingMbz.id,
          sizeBytes:  existingMbz.sizeBytes,
          filename:   existingMbz.filename,
          humanMessage: 'Paquete Moodle ya guardado.',
        },
      });
      return;
    }

    // ── Step 2: Download required artifacts ──────────────────────────────────
    await updateProgress('preparing_package', 'Descargando datos del curso…');

    const contentSnapshotId   = payload.contentSnapshotArtifactId as string;
    const h5pSnapshotId       = payload.h5pSnapshotArtifactId    as string | null ?? null;
    const audioWelcomeId      = payload.audioWelcomeArtifactId   as string | null ?? null;
    const audiobookId         = payload.audiobookArtifactId       as string | null ?? null;

    if (!contentSnapshotId) {
      throw new Error('contentSnapshotArtifactId is required but missing from job payload');
    }

    const contentSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, contentSnapshotId, logger);
    if (!contentSnapshot) throw new Error('No se pudo descargar el contenido del curso');

    const D = contentSnapshot.D as Record<string, any> ?? {};
    const F = contentSnapshot.F as Record<string, string> ?? {};
    if (!Object.keys(F).length) throw new Error('El contenido del curso está vacío — regenera el contenido');

    await sendHeartbeat();
    if (leaseLost) return;

    // H5P data (optional)
    let hvpData: Record<number, HvpEntry> | undefined;
    if (h5pSnapshotId) {
      const h5pSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, h5pSnapshotId, logger);
      if (h5pSnapshot?.MEDIA_HVP && typeof h5pSnapshot.MEDIA_HVP === 'object') {
        hvpData = {} as Record<number, HvpEntry>;
        for (const [k, v] of Object.entries(h5pSnapshot.MEDIA_HVP as Record<string, any>)) {
          const capN = parseInt(k);
          if (!isNaN(capN) && v && typeof v === 'object') {
            hvpData[capN] = v as HvpEntry;
          }
        }
        logger.log(`[PackageWorker] H5P data loaded: ${Object.keys(hvpData).length} caps`);
      }
    }

    // Audio buffers (optional)
    let audioWelcome: Buffer | null = null;
    let audiobook:    Buffer | null = null;
    if (audioWelcomeId) {
      audioWelcome = await downloadArtifactBuffer(artifactsService, job.ownerId, audioWelcomeId, logger);
      if (audioWelcome) logger.log(`[PackageWorker] Welcome audio: ${audioWelcome.length} bytes`);
    }
    if (audiobookId) {
      audiobook = await downloadArtifactBuffer(artifactsService, job.ownerId, audiobookId, logger);
      if (audiobook) logger.log(`[PackageWorker] Audiobook: ${audiobook.length} bytes`);
    }

    await sendHeartbeat();
    if (leaseLost) return;

    // ── Step 3: Build MBZ ────────────────────────────────────────────────────
    await updateProgress('preparing_package', 'Preparando paquete Moodle…');
    logger.log(`[PackageWorker] Building MBZ for job ${jobId}: F=${Object.keys(F).length} files, hvp=${Object.keys(hvpData ?? {}).length} caps`);

    const buildResult = await mbzBuilder.buildMbz({
      courseData:    D,
      courseFiles:   F,
      audioWelcome,
      audiobook,
      hvpData,
      moodleVersion: options.moodleVersion ?? '4.1',
    });

    if (leaseLost) return;

    // ── Step 4: Validate (basic + deep) ─────────────────────────────────────
    await updateProgress('validating_package', 'Validando paquete Moodle…');

    if (!buildResult.buffer?.length) {
      throw new Error('El paquete generado está vacío — no se pudo construir el ZIP Moodle');
    }

    logger.log(`[PackageWorker] MBZ built: ${buildResult.filename}, ${buildResult.sizeBytes} bytes, ${buildResult.activityCount} activities`);

    // Deep quality validation — counts SCORM, quizzes, sections, H5P
    const validation = await validateFinalMoodlePackage(buildResult.buffer, buildResult, logger);

    if (validation.status === 'failed') {
      const errSummary = validation.errors.join(' | ');
      throw new Error(`Paquete Moodle no pasa criterios mínimos de calidad: ${errSummary}`);
    }

    if (validation.status === 'warning') {
      logger.warn(`[PackageWorker] MBZ validation warnings for job ${jobId}: ${validation.warnings.join(' | ')}`);
    }

    // ── Step 5: Upload mbz_final artifact ────────────────────────────────────
    await updateProgress('uploading_package', 'Guardando paquete Moodle…');
    await sendHeartbeat();
    if (leaseLost) {
      logger.warn(`[PackageWorker] Skipping mbz_final upload for job ${jobId} because the job was cancelled`);
      return;
    }

    const courseName = String(D.nombre ?? 'curso').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const filename   = `${courseName}_final_${timestamp}.mbz`;
    const storagePath = `${job.ownerId}/${rawCourseId}/package/${filename}`;

    const artifact = await artifactsService.uploadBufferArtifact({
      ownerId:    job.ownerId,
      courseId:   rawCourseId,
      jobId:      jobId,
      type:       'mbz_final',
      filename,
      storagePath,
      buffer:     buildResult.buffer,
      mimeType:   'application/vnd.moodle.backup',
      metadata: {
        completionLevel:    'complete',
        validationOk:       validation.status !== 'failed',
        // ── Fase 3: validation gate ──────────────────────────────
        validationStatus:   validation.status,        // 'passed' | 'warning' | 'failed'
        validationErrors:   validation.errors,
        validationWarnings: validation.warnings,
        counts:             validation.counts,
        // ────────────────────────────────────────────────────────
        generatedBy:        'backend_package',
        workerVersion:      '2.0',
        activityCount:      buildResult.activityCount,
        hasH5P:             Object.keys(hvpData ?? {}).length > 0,
        hasWelcomeAudio:    !!audioWelcome,
        hasAudiobook:       !!audiobook,
        courseName:         D.nombre ?? null,
        filename:           buildResult.filename,
        generatedAt:        new Date().toISOString(),
      },
      storageBucket:   'cursia-artifacts',
      storageProvider: 'supabase',
    });

    if (leaseLost) return;

    await sendHeartbeat();
    if (leaseLost) return;

    finalized = true;
    const completed = await jobsService.completePackageWorkerJob(jobId, workerId, {
      mbzFinal: {
        status:            'completed',
        artifactId:        artifact.id,
        sizeBytes:         buildResult.sizeBytes,
        filename:          buildResult.filename,
        activityCount:     buildResult.activityCount,
        validationStatus:  validation.status,
        validationWarnings: validation.warnings,
        humanMessage:      validation.status === 'warning'
          ? `Paquete Moodle listo con advertencias: ${validation.warnings[0] ?? ''}`
          : 'Paquete Moodle listo.',
      },
    });

    if (!completed) logger.warn(`[PackageWorker] Job ${jobId} could not be completed — ownership changed`);
    else {
      await trackEvent('package_generation_completed', {
        units: buildResult.sizeBytes,
        unitType: 'bytes',
        metadata: {
          artifactId: artifact.id,
          sizeBytes: buildResult.sizeBytes,
          activityCount: buildResult.activityCount,
          hasH5P: Object.keys(hvpData ?? {}).length > 0,
          hasWelcomeAudio: !!audioWelcome,
          hasAudiobook: !!audiobook,
        },
      });
      logger.log(`[PackageWorker] Job ${jobId} completed. artifact=${artifact.id}`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) { logger.warn(`[PackageWorker] Job ${jobId} ended after lease loss: ${message}`); return; }
    await jobsService.failPackageWorkerJob(jobId, workerId, message, true);
    await trackEvent('package_generation_failed', {
      failed: true,
      errorMessage: message,
      units: 1,
      unitType: 'per_operation',
    });
    logger.error(`[PackageWorker] Job ${jobId} failed: ${message}`);
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('PackageWorker');
  const app    = await NestFactory.createApplicationContext(AppModule, { logger: ['log','warn','error'] });

  const jobsService      = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const mbzBuilder       = app.get(MbzBuilderService);
  const eventsService    = app.get(EventsService);

  const workerId     = process.env.PACKAGE_WORKER_ID     || `package-worker-${process.pid}`;
  const pollMs       = readPositiveInt('PACKAGE_WORKER_POLL_MS',       10000);
  const leaseSeconds = readPositiveInt('PACKAGE_WORKER_LEASE_SECONDS', 300);
  const heartbeatMs  = readPositiveInt('PACKAGE_WORKER_HEARTBEAT_MS',  30000);
  const dryRun       = isTrueEnv('PACKAGE_WORKER_DRY_RUN');

  let shuttingDown = false;
  let idlePolls    = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Package worker stopped');
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`Package worker started (workerId=${workerId}, pollMs=${pollMs}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`);

  while (!shuttingDown) {
    const claimed = await jobsService.claimNextBackendPackageJob(workerId, leaseSeconds);

    if (!claimed) {
      idlePolls++;
      if (idlePolls === 1 || idlePolls % 6 === 0) logger.log('No backend_package jobs found');
      await sleep(pollMs);
      continue;
    }

    idlePolls = 0;
    logger.log(`Claimed package job ${claimed.id}`);

    if (dryRun) {
      logger.log(`[PackageWorker] Dry-run: simulating job ${claimed.id}`);
      await sleep(3000);
      await jobsService.completePackageWorkerJob(claimed.id, workerId, {
        mbzFinal: { status:'completed', humanMessage:'Paquete Moodle listo (dry-run).' },
      });
      await eventsService.trackBackendEvent({
        userId: claimed.ownerId,
        eventType: 'package_generation_completed',
        courseId: claimed.frontendCourseId || String(claimed.courseId ?? 'unknown'),
        jobId: claimed.id,
        parentJobId: claimed.inputPayload?.metadata?.parentJobId ?? null,
        component: 'package',
        provider: 'internal',
        model: 'mbz_builder_v1',
        mode: 'dry_run',
        costType: 'mock_zero',
        estimatedCostUsd: 0,
        costSource: 'mock_zero',
        units: 1,
        unitType: 'per_operation',
        metadata: { workerId, dryRun: true },
      });
      logger.log(`[PackageWorker] Dry-run completed for job ${claimed.id}`);
      continue;
    }

    const promise = handlePackageJob(
      claimed, jobsService, artifactsService, mbzBuilder, eventsService,
      workerId, leaseSeconds, heartbeatMs, logger,
    )
      .catch(error => {
        logger.error(`Unhandled package worker error for job ${claimed.id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { activeJobs.delete(promise); });

    activeJobs.add(promise);
    await sleep(500);
  }
}

bootstrap().catch(error => {
  const logger = new Logger('PackageWorker');
  logger.error(`Fatal package worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
