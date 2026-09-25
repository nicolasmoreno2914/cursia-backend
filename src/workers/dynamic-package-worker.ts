import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { GenerationManifestsService, ManifestDto } from '../modules/generation-manifests/generation-manifests.service';
import { CourseBlueprintsService } from '../modules/course-blueprints/course-blueprints.service';
import { buildPackagingPlan } from '../modules/dynamic-packaging/packaging-plan';
import { loadArtifactText, loadRunVideoDelivery, parseDynamicVideo, resolveRunArtifacts } from '../modules/dynamic-packaging/artifact-resolver';
import type { VideoDeliveryStrategy } from '../modules/dynamic-generation/dynamic-video-delivery';
import { sortedArtifactIds, sourceIdsHash as computeSourceIdsHash } from '../modules/dynamic-packaging/packaging-reuse-key';
import { buildDynamicMbz, DYNAMIC_MBZ_BUILDER_VERSION } from '../package/dynamic-mbz-builder';
import type { DynamicPackageContents, PackagingPlan, ResolvedArtifact } from '../modules/dynamic-packaging/packaging-types';

// ─────────────────────────────────────────────────────────────────────────────
// Fase 5B.1 — B3: dynamic-package-worker. Reclama production_jobs con
// execution_mode='dynamic_package' (sembrados por PackagingService al recibir
// un POST …/runs/:runId/package), resuelve los artifacts del run 5A, arma el
// PackagingPlan, construye el .mbz (buildDynamicMbz, bloque B2) y lo sube
// como artifact `dynamic_mbz`. Restore-first: si ya existe un dynamic_mbz
// para el mismo runId con el MISMO set (ordenado) de artifact ids de origen,
// lo reutiliza sin reconstruir — mismo patrón que package-worker.ts.
//
// No importa ProductionJobsModule ni sus métodos de backend_package: escribe
// el estado del job con SQL propio (mismo patrón que RunsService/
// PackagingService para dynamic_generation/dynamic_package), para no tocar
// el servicio legacy compartido.
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface DynamicPackageWorkerDeps {
  dataSource: DataSource;
  artifacts: ArtifactsService;
  manifests: GenerationManifestsService;
  blueprints: CourseBlueprintsService;
  buildPlan: typeof buildPackagingPlan;
  resolveArtifacts: typeof resolveRunArtifacts;
  loadText: typeof loadArtifactText;
  parseVideo: typeof parseDynamicVideo;
  buildMbz: typeof buildDynamicMbz;
  logger: Logger;
  workerId: string;
  leaseSeconds: number;
  heartbeatMs: number;
}

export interface PackageJobRow {
  id: string;
  owner_id: string;
  course_id: number;
  frontend_course_id: string | null;
  worker_status: string;
  status: string;
  input_payload: { runId: string; manifestId: number; blueprintNumber: number };
  output_summary: Record<string, any>;
  attempt_count: number | null;
  max_attempts: number | null;
}

function artifactCourseId(job: PackageJobRow): string {
  return job.frontend_course_id ?? String(job.course_id);
}

async function findExistingDynamicMbz(
  artifacts: ArtifactsService,
  ownerId: string,
  courseId: string,
  runId: string,
  sourceIdsHash: string,
): Promise<{ id: string } | null> {
  const list = await artifacts.findAll(ownerId, { courseId, type: 'dynamic_mbz' });
  const match = list.find((a) => {
    const meta = a.metadata as Record<string, any> | null;
    return meta?.runId === runId
      && meta?.sourceIdsHash === sourceIdsHash
      && meta?.builderVersion === DYNAMIC_MBZ_BUILDER_VERSION;
  });
  return match ? { id: match.id } : null;
}

async function heartbeatJob(dataSource: DataSource, jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
  const result = await dataSource.query(
    `update public.production_jobs set lease_until = now() + ($3 * interval '1 second'), updated_at = now()
      where id = $1 and worker_id = $2 and worker_status = 'running' returning id`,
    [jobId, workerId, leaseSeconds],
  );
  return Array.isArray(result) && result.length > 0;
}

async function completeJob(dataSource: DataSource, jobId: string, workerId: string, summary: Record<string, any>): Promise<boolean> {
  const result = await dataSource.query(
    `update public.production_jobs
        set status = 'completed', worker_status = 'completed', progress = 100, finished_at = now(),
            lease_until = null, next_retry_at = null, error_message = null,
            output_summary = coalesce(output_summary, '{}'::jsonb) || $3::jsonb, updated_at = now()
      where id = $1 and worker_id = $2 and worker_status = 'running'
      returning id`,
    [jobId, workerId, JSON.stringify(summary)],
  );
  return Array.isArray(result) && result.length > 0;
}

async function failJob(dataSource: DataSource, jobId: string, workerId: string, message: string): Promise<void> {
  await dataSource.query(
    `update public.production_jobs
        set status = 'failed', worker_status = 'failed', finished_at = now(),
            lease_until = null, error_message = $3, updated_at = now()
      where id = $1 and worker_id = $2`,
    [jobId, workerId, message],
  );
}

async function loadContentsForPlan(
  deps: DynamicPackageWorkerDeps,
  ownerId: string,
  plan: PackagingPlan,
  byItem: Map<string, ResolvedArtifact[]>,
  videoDelivery: VideoDeliveryStrategy = 'videogen_direct',
): Promise<DynamicPackageContents> {
  const contentMd = new Map<string, string>();
  const scorm = new Map<string, { html: string; manifestXml: string }>();
  const examGift = new Map<string, string>();
  const videos: DynamicPackageContents['videos'] = new Map();

  const artifactsFor = (key: string): ResolvedArtifact[] => {
    const list = byItem.get(key);
    if (!list?.length) throw new Error(`falta el artifact resuelto para el item "${key}" (integridad rota tras resolveRunArtifacts)`);
    return list;
  };
  const artifactFor = (key: string): ResolvedArtifact => artifactsFor(key)[0];

  for (const m of plan.modules) {
    for (const c of m.chapters) {
      contentMd.set(c.chapterId, await deps.loadText(deps.artifacts, ownerId, artifactFor(c.contentItemKey)));

      // El contrato real del resolver (B1) resuelve un item 'scorm' a DOS
      // artifacts (dynamic_scorm_html + dynamic_scorm_manifest) — se
      // seleccionan por `type` cuando resolveArtifacts los separó así. El
      // placeholder de este bloque (artifact-resolver.ts, hasta que se
      // integre B1) devuelve uno solo con ambos campos como JSON
      // {html, manifestXml} — se soportan las dos formas sin tocar este
      // archivo de nuevo cuando se integre el B1 real.
      const scormArtifacts = artifactsFor(c.scormItemKey);
      const htmlArtifact = scormArtifacts.find((a) => a.type === 'dynamic_scorm_html') ?? scormArtifacts[0];
      const manifestArtifact = scormArtifacts.find((a) => a.type === 'dynamic_scorm_manifest');
      let html = await deps.loadText(deps.artifacts, ownerId, htmlArtifact);
      let manifestXml = manifestArtifact ? await deps.loadText(deps.artifacts, ownerId, manifestArtifact) : '';
      if (!manifestArtifact) {
        try {
          const parsed = JSON.parse(html) as { html?: string; manifestXml?: string };
          if (typeof parsed?.html === 'string') {
            html = parsed.html;
            manifestXml = parsed.manifestXml ?? '';
          }
        } catch {
          /* no era JSON: se usa tal cual como html, manifestXml queda vacío */
        }
      }
      scorm.set(c.chapterId, { html, manifestXml });
      if (c.videoItemKey) {
        const videoText = await deps.loadText(deps.artifacts, ownerId, artifactFor(c.videoItemKey));
        // 5B.2.A: la URL de entrega sale de la estrategia CONGELADA del run.
        videos.set(c.chapterId, deps.parseVideo(JSON.parse(videoText), videoDelivery));
      }
    }
    if (m.examItemKey) {
      examGift.set(m.moduleId, await deps.loadText(deps.artifacts, ownerId, artifactFor(m.examItemKey)));
    }
  }

  return { contentMd, scorm, examGift, videos };
}

/** Ciclo de vida completo de UN job `dynamic_package` reclamado. Exportado para tests. */
export async function processItem(deps: DynamicPackageWorkerDeps, job: PackageJobRow): Promise<void> {
  const { logger } = deps;
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      const ok = await heartbeatJob(deps.dataSource, job.id, deps.workerId, deps.leaseSeconds);
      if (!ok) {
        leaseLost = true;
        logger.warn(`Job ${job.id}: heartbeat rechazado — lease perdida, abortando`);
      }
    })();
  }, deps.heartbeatMs);

  try {
    const { runId, manifestId, blueprintNumber } = job.input_payload;
    const manifest: ManifestDto = await deps.manifests.get(job.course_id, job.owner_id, blueprintNumber);
    if (manifest.id !== manifestId) {
      throw new Error(`el Manifest actual del Blueprint v${blueprintNumber} (#${manifest.id}) no coincide con el del job (#${manifestId})`);
    }

    const byItem = await deps.resolveArtifacts({ query: deps.dataSource.query.bind(deps.dataSource) }, runId, manifest.manifest);
    const ids = sortedArtifactIds(byItem);
    const sourceIdsHash = computeSourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ids);
    if (leaseLost) return;

    // Restore-first: mismo runId + mismo set de artifacts de origen -> reusar.
    const existing = await findExistingDynamicMbz(deps.artifacts, job.owner_id, artifactCourseId(job), runId, sourceIdsHash);
    if (existing) {
      logger.log(`Job ${job.id}: dynamic_mbz ya existe (${existing.id}) para runId=${runId} — reutilizando sin reconstruir`);
      const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
        artifactId: existing.id,
        sourceArtifactIds: ids,
        sourceIdsHash,
        builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
        reused: true,
      });
      if (!ok) logger.warn(`Job ${job.id}: completeJob devolvió false (lease perdida) tras reutilizar ${existing.id}`);
      return;
    }
    if (leaseLost) return;

    const blueprint = await deps.blueprints.getByNumber(job.course_id, job.owner_id, blueprintNumber);
    const plan = deps.buildPlan(manifest.manifest, blueprint.snapshot, { manifestId: manifest.id });
    if (leaseLost) return;

    const videoDelivery = await loadRunVideoDelivery({ query: deps.dataSource.query.bind(deps.dataSource) }, runId);
    const contents = await loadContentsForPlan(deps, job.owner_id, plan, byItem, videoDelivery);
    if (leaseLost) return;

    const buffer = await deps.buildMbz({ plan, contents });
    if (leaseLost) return;

    const storagePath = `${job.owner_id}/dynamic/${artifactCourseId(job)}/${manifest.id}/dynamic_mbz/${runId}/${sourceIdsHash}.mbz`;
    const artifact = await deps.artifacts.uploadBufferArtifact({
      ownerId: job.owner_id,
      courseId: artifactCourseId(job),
      jobId: job.id,
      type: 'dynamic_mbz',
      filename: `${sourceIdsHash}.mbz`,
      storagePath,
      buffer,
      mimeType: 'application/vnd.moodle.backup',
      metadata: { runId, manifestId: manifest.id, sourceArtifactIds: ids, sourceIdsHash, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION },
    });
    if (leaseLost) return;

    const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
      artifactId: artifact.id,
      sourceArtifactIds: ids,
      sourceIdsHash,
      builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
      reused: false,
    });
    if (!ok) {
      logger.warn(`Job ${job.id}: el .mbz se generó y el artifact ${artifact.id} se subió, pero completeJob devolvió false (lease perdida)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (leaseLost) {
      logger.warn(`Job ${job.id}: terminó tras perder la lease — ${message}`);
      return;
    }
    logger.error(`Job ${job.id}: error — ${message}`);
    await failJob(deps.dataSource, job.id, deps.workerId, message);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/** Exportado (además de usarse en `bootstrap`) para poder probarlo directo desde tests/harnesses. */
export async function claimNext(dataSource: DataSource, workerId: string, leaseSeconds: number): Promise<PackageJobRow | null> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    // También reclama jobs 'running' cuya lease venció (crash o reload del
    // worker, I3 integral-review) — mismo patrón de lease/heartbeat que
    // 'queued'/'retrying'; el heartbeat del worker original (si sigue vivo)
    // fallará porque worker_id ya no coincide tras este UPDATE.
    const candidates = await queryRunner.query(
      `select id from public.production_jobs
        where execution_mode = 'dynamic_package'
          and worker_status in ('queued', 'retrying', 'running')
          and (next_retry_at is null or next_retry_at <= now())
          and (lease_until is null or lease_until < now())
        order by created_at asc limit 1 for update skip locked`,
    );
    if (!Array.isArray(candidates) || candidates.length === 0) {
      await queryRunner.commitTransaction();
      return null;
    }
    const jobId = candidates[0].id;
    await queryRunner.query(
      `update public.production_jobs
          set worker_status = 'running', status = 'running', current_step = 'package',
              worker_id = $1, lease_until = now() + ($2 * interval '1 second'),
              attempt_count = coalesce(attempt_count, 0) + 1, started_at = coalesce(started_at, now()), updated_at = now()
        where id = $3`,
      [workerId, leaseSeconds, jobId],
    );
    await queryRunner.commitTransaction();
    const [row] = await dataSource.query(`select * from public.production_jobs where id = $1`, [jobId]);
    return row as PackageJobRow;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function bootstrap() {
  const logger = new Logger('DynamicPackageWorker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  const deps: DynamicPackageWorkerDeps = {
    dataSource: app.get(DataSource),
    artifacts: app.get(ArtifactsService),
    manifests: app.get(GenerationManifestsService),
    blueprints: app.get(CourseBlueprintsService),
    buildPlan: buildPackagingPlan,
    resolveArtifacts: resolveRunArtifacts,
    loadText: loadArtifactText,
    parseVideo: parseDynamicVideo,
    buildMbz: buildDynamicMbz,
    logger,
    workerId: process.env.DYNAMIC_PACKAGE_WORKER_ID || `dynamic-package-worker-${process.pid}`,
    leaseSeconds: readPositiveInt('DYNAMIC_PACKAGE_WORKER_LEASE_SECONDS', 600),
    heartbeatMs: readPositiveInt('DYNAMIC_PACKAGE_WORKER_HEARTBEAT_MS', 30000),
  };
  const pollMs = readPositiveInt('DYNAMIC_PACKAGE_WORKER_POLL_MS', 5000);

  let shuttingDown = false;
  const activeJobs = new Set<Promise<void>>();
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Recibido ${signal}; esperando ${activeJobs.size} job(s) activo(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('dynamic-package-worker detenido');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`dynamic-package-worker iniciado (workerId=${deps.workerId}, pollMs=${pollMs}, leaseSeconds=${deps.leaseSeconds})`);

  while (!shuttingDown) {
    const job = await claimNext(deps.dataSource, deps.workerId, deps.leaseSeconds);
    if (!job) {
      await sleep(pollMs);
      continue;
    }
    logger.log(`Job reclamado: ${job.id} (run ${job.input_payload?.runId})`);
    const promise = processItem(deps, job)
      .catch((err) => logger.error(`Error no manejado en job ${job.id}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { activeJobs.delete(promise); });
    activeJobs.add(promise);
    await sleep(500);
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    const logger = new Logger('DynamicPackageWorker');
    logger.error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
