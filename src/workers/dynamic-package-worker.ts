import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MissingSchemaBackoff, holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { GenerationManifestsService, ManifestDto } from '../modules/generation-manifests/generation-manifests.service';
import { CourseBlueprintsService } from '../modules/course-blueprints/course-blueprints.service';
import { buildPackagingPlan } from '../modules/dynamic-packaging/packaging-plan';
import { loadArtifactText, loadRunVideoDelivery, parseDynamicVideo, resolveRunArtifacts } from '../modules/dynamic-packaging/artifact-resolver';
import { staleArtifactWarnings } from '../modules/dynamic-packaging/packaging-warnings';
import type { VideoDeliveryStrategy } from '../modules/dynamic-generation/dynamic-video-delivery';
import { packageReuseHash, resolveDynamicMoodleVersion, sortedArtifactIds } from '../modules/dynamic-packaging/packaging-reuse-key';
import { reportVideoDeliveryConfigAtStartup } from '../modules/dynamic-generation/dynamic-video-delivery';
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

// I1 (review-it2): serialización por runId SIN fijar conexiones del pool.
// Antes (M9) cada job tomaba una conexión dedicada con pg_advisory_lock
// durante TODO el build; con el pool de 5 (database.module.ts extra.max) y
// sin tope de concurrencia, 5 jobs agotaban el pool y todo lo demás (queries
// del build, failJob, claimNext, heartbeat) moría por timeout. Ahora:
//  - la exclusión por run se decide al RECLAMAR (claimNext): no se reclama un
//    job si otro job dynamic_package del mismo runId está 'running' con lease
//    vigente; la lease/heartbeat ya existente es el "lock" por run;
//  - el claim se serializa entre workers con un advisory lock de
//    TRANSACCIÓN (pg_advisory_xact_lock), que dura solo lo que dura el claim;
//  - el loop tiene un tope de concurrencia validado
//    (DYNAMIC_PACKAGE_WORKER_CONCURRENCY, default 1, máx. MAX_CONCURRENCY);
//  - el heartbeat nunca lanza: tras HEARTBEAT_MAX_CONSECUTIVE_FAILURES fallos
//    seguidos se trata como lease perdida.
// Gap que sigue documentado: PackagingService.requestPackage puede crear dos
// jobs para el mismo runId en una carrera; ahora se ejecutan uno tras otro
// y el segundo reusa el .mbz del primero (restore-first).

/** Clave fija del advisory lock (de transacción) que serializa los claims de dynamic_package entre workers. */
const CLAIM_LOCK_KEY = 'cursia:dynamic_package:claim';

export const CONCURRENCY_ENV = 'DYNAMIC_PACKAGE_WORKER_CONCURRENCY';
/** Pool de TypeORM = 5 (database.module.ts); se dejan 2 conexiones libres para claim/heartbeat/failJob. */
export const MAX_CONCURRENCY = 3;
/** Heartbeats fallidos (excepción, p.ej. timeout del pool) seguidos antes de tratar la lease como perdida. */
export const HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;

export function resolveDynamicPackageWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[CONCURRENCY_ENV] ?? '').trim();
  if (raw === '') return 1;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new Error(`${CONCURRENCY_ENV} inválido: "${raw}". Debe ser un entero entre 1 y ${MAX_CONCURRENCY} (o sin definir = 1).`);
  }
  return n;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  moodleVersion: string,
): Promise<{ id: string } | null> {
  const list = await artifacts.findAll(ownerId, { courseId, type: 'dynamic_mbz' });
  const match = list.find((a) => {
    const meta = a.metadata as Record<string, any> | null;
    // I3: la clave ya incluye la versión (salvo el default, byte-idéntico);
    // además se exige que la versión registrada coincida — sin campo (.mbz
    // anteriores a M11) = 4.1, el default del builder.
    return meta?.runId === runId
      && meta?.sourceIdsHash === sourceIdsHash
      && meta?.builderVersion === DYNAMIC_MBZ_BUILDER_VERSION
      && (meta?.moodleVersion ?? '4.1') === moodleVersion;
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
  // rulesVersion 2: un item puede resolver a varios roles (content v2 =
  // dynamic_content_md + dynamic_context_package_json) — se elige por type.
  const artifactOfType = (key: string, type: ResolvedArtifact['type']): ResolvedArtifact => {
    const a = artifactsFor(key).find((x) => x.type === type);
    if (!a) throw new Error(`falta el artifact ${type} del item "${key}" (integridad rota tras resolveRunArtifacts)`);
    return a;
  };
  const moduleIntroMd = new Map<string, string>();
  let courseIntroMd: string | undefined;
  if (plan.rulesVersion === 2) {
    courseIntroMd = await deps.loadText(deps.artifacts, ownerId, artifactOfType(plan.courseIntroItemKey as string, 'dynamic_course_intro_md'));
    for (const m of plan.modules) {
      moduleIntroMd.set(m.moduleId, await deps.loadText(deps.artifacts, ownerId, artifactOfType(m.moduleIntroItemKey as string, 'dynamic_module_intro_md')));
    }
  }

  for (const m of plan.modules) {
    for (const c of m.chapters) {
      contentMd.set(c.chapterId, await deps.loadText(deps.artifacts, ownerId, artifactOfType(c.contentItemKey, 'dynamic_content_md')));

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

  return plan.rulesVersion === 2
    ? { contentMd, scorm, examGift, videos, courseIntroMd, moduleIntroMd }
    : { contentMd, scorm, examGift, videos };
}

/** Ciclo de vida completo de UN job `dynamic_package` reclamado. Exportado para tests. */
export async function processItem(deps: DynamicPackageWorkerDeps, job: PackageJobRow): Promise<void> {
  const { logger } = deps;
  let leaseLost = false;
  let heartbeatInFlight = false;
  let heartbeatFailures = 0;
  // I1: el heartbeat NUNCA lanza (antes, un timeout del pool era una unhandled
  // rejection que tumbaba el proceso en Node ≥15). Un fallo aislado se tolera;
  // HEARTBEAT_MAX_CONSECUTIVE_FAILURES seguidos = lease perdida (otro worker
  // la re-reclamará al vencer). Sin solapar heartbeats si uno se cuelga.
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight || leaseLost) return;
    heartbeatInFlight = true;
    void (async () => {
      try {
        const ok = await heartbeatJob(deps.dataSource, job.id, deps.workerId, deps.leaseSeconds);
        heartbeatFailures = 0;
        if (!ok) {
          leaseLost = true;
          logger.warn(`Job ${job.id}: heartbeat rechazado — lease perdida, abortando`);
        }
      } catch (err) {
        heartbeatFailures++;
        if (heartbeatFailures >= HEARTBEAT_MAX_CONSECUTIVE_FAILURES) {
          leaseLost = true;
          logger.error(
            `Job ${job.id}: heartbeat falló ${heartbeatFailures} veces seguidas (${errMessage(err)}) — se trata como lease perdida, abortando`,
          );
        } else {
          logger.warn(`Job ${job.id}: heartbeat falló (${heartbeatFailures}/${HEARTBEAT_MAX_CONSECUTIVE_FAILURES}): ${errMessage(err)}`);
        }
      } finally {
        heartbeatInFlight = false;
      }
    })();
  }, deps.heartbeatMs);

  try {
    // I3: versión de Moodle validada ANTES de cualquier trabajo — un valor
    // desconocido falla este job ruidoso (nunca un .mbz 4.1 mal etiquetado).
    const moodle = resolveDynamicMoodleVersion();
    const { runId, manifestId, blueprintNumber } = job.input_payload;
    // El Manifest CONGELADO del job (por id, verificado contra el Blueprint y
    // el dueño), no el "actual" de DYNAMIC_MANIFEST_RULES_VERSION: un run v1
    // se sigue empaquetando aunque la config pase a v2 (y viceversa).
    const manifest: ManifestDto = await deps.manifests.getById(job.course_id, job.owner_id, blueprintNumber, manifestId);
    if (manifest.id !== manifestId) {
      throw new Error(`el Manifest del Blueprint v${blueprintNumber} (#${manifest.id}) no coincide con el del job (#${manifestId})`);
    }

    const byItem = await deps.resolveArtifacts({ query: deps.dataSource.query.bind(deps.dataSource) }, runId, manifest.manifest);
    const ids = sortedArtifactIds(byItem);
    const sourceIdsHash = packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, moodle.resolved);
    // Fase 8: los artifacts 'stale' (STALE_NO_AUTO) se empaquetan con aviso visible.
    const warnings = staleArtifactWarnings(byItem);
    const warningsSummary = warnings.length > 0 ? { warnings } : {};
    if (leaseLost) return;

    // Restore-first: mismo runId + mismo set de artifacts de origen + misma versión -> reusar.
    const existing = await findExistingDynamicMbz(deps.artifacts, job.owner_id, artifactCourseId(job), runId, sourceIdsHash, moodle.resolved);
    if (existing) {
      logger.log(`Job ${job.id}: dynamic_mbz ya existe (${existing.id}) para runId=${runId} — reutilizando sin reconstruir`);
      const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
        artifactId: existing.id,
        sourceArtifactIds: ids,
        sourceIdsHash,
        builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
        reused: true,
        ...warningsSummary,
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

    // Sin env se pasa undefined (el builder aplica su default: mismo .mbz que antes).
    const buffer = await deps.buildMbz({ plan, contents, moodleVersion: moodle.requested });
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
      // M9: el path incluye la clave de reuse (contenido) -> inmutable por
      // construcción; upsert:false nunca pisa un objeto existente.
      upsert: false,
      // I2 (review-it2): si un intento previo subió el objeto y murió antes de
      // insertar el row, el reintento adopta el objeto verificado en vez de
      // fallar para siempre con "already exists".
      adoptExistingOnConflict: true,
      metadata: {
        runId,
        manifestId: manifest.id,
        sourceArtifactIds: ids,
        sourceIdsHash,
        builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
        moodleVersion: moodle.resolved,
      },
    });
    if (leaseLost) return;

    const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
      artifactId: artifact.id,
      sourceArtifactIds: ids,
      sourceIdsHash,
      builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
      reused: false,
      ...warningsSummary,
    });
    if (!ok) {
      logger.warn(`Job ${job.id}: el .mbz se generó y el artifact ${artifact.id} se subió, pero completeJob devolvió false (lease perdida)`);
    }
  } catch (err) {
    const message = errMessage(err);
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

/**
 * Reclama el próximo job `dynamic_package`. Exportado (además de usarse en
 * `bootstrap`) para poder probarlo directo desde tests/harnesses.
 *
 * I1: nunca reclama un job si OTRO job dynamic_package del mismo runId está
 * 'running' con lease vigente (exclusión por run sin fijar conexiones). El
 * claim entero corre bajo un advisory lock de transacción para que dos
 * workers no reclamen a la vez dos jobs del mismo run (la subconsulta sola no
 * alcanza en READ COMMITTED).
 *
 * M7: si la query falla, un fallo del rollback/release se loguea aparte y se
 * propaga el error ORIGINAL (nunca lo enmascara la limpieza).
 */
export async function claimNext(
  dataSource: DataSource,
  workerId: string,
  leaseSeconds: number,
  logger: Pick<Logger, 'warn'> = new Logger('DynamicPackageWorker'),
): Promise<PackageJobRow | null> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  let claimedId: string | null = null;
  try {
    try {
      await queryRunner.startTransaction();
      await queryRunner.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [CLAIM_LOCK_KEY]);
      // También reclama jobs 'running' cuya lease venció (crash o reload del
      // worker, I3 integral-review) — mismo patrón de lease/heartbeat que
      // 'queued'/'retrying'; el heartbeat del worker original (si sigue vivo)
      // fallará porque worker_id ya no coincide tras este UPDATE.
      const candidates = await queryRunner.query(
        `select j.id from public.production_jobs j
          where j.execution_mode = 'dynamic_package'
            and j.worker_status in ('queued', 'retrying', 'running')
            and (j.next_retry_at is null or j.next_retry_at <= now())
            and (j.lease_until is null or j.lease_until < now())
            and not exists (
              select 1 from public.production_jobs p2
               where p2.execution_mode = 'dynamic_package'
                 and p2.worker_status = 'running'
                 and p2.lease_until > now()
                 and p2.id <> j.id
                 and p2.input_payload->>'runId' = j.input_payload->>'runId'
            )
          order by j.created_at asc limit 1 for update of j skip locked`,
      );
      if (Array.isArray(candidates) && candidates.length > 0) {
        claimedId = candidates[0].id;
        await queryRunner.query(
          `update public.production_jobs
              set worker_status = 'running', status = 'running', current_step = 'package',
                  worker_id = $1, lease_until = now() + ($2 * interval '1 second'),
                  attempt_count = coalesce(attempt_count, 0) + 1, started_at = coalesce(started_at, now()), updated_at = now()
            where id = $3`,
          [workerId, leaseSeconds, claimedId],
        );
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      try {
        if (queryRunner.isTransactionActive !== false) await queryRunner.rollbackTransaction();
      } catch (rollbackError) {
        logger.warn(`claimNext: rollback falló tras un error (se propaga el original): ${errMessage(rollbackError)}`);
      }
      throw error;
    }
  } finally {
    try {
      await queryRunner.release();
    } catch (releaseError) {
      logger.warn(`claimNext: release del queryRunner falló: ${errMessage(releaseError)}`);
    }
  }
  if (!claimedId) return null;
  const [row] = await dataSource.query(`select * from public.production_jobs where id = $1`, [claimedId]);
  return row as PackageJobRow;
}

export interface PackageWorkerLoopOptions {
  concurrency: number;
  pollMs: number;
  /** Espera tras un error de claim (p.ej. timeout del pool) antes de reintentar. */
  claimErrorBackoffMs?: number;
  isStopping: () => boolean;
  /** Set de jobs activos (compartido con el handler de shutdown). */
  activeJobs?: Set<Promise<void>>;
  /** M5: estado "esquema V2 ausente" (tests pueden inyectar uno con otro intervalo). */
  schemaBackoff?: MissingSchemaBackoff;
}

/**
 * Loop del worker con tope de concurrencia (I1). Un error de claim (pool
 * agotado, DB caída) se loguea y se reintenta con backoff — nunca sale del
 * loop ni tumba el proceso. Al detenerse espera a los jobs activos.
 * Exportado para harnesses.
 */
export async function runPackageWorkerLoop(deps: DynamicPackageWorkerDeps, opts: PackageWorkerLoopOptions): Promise<void> {
  const { logger } = deps;
  const active = opts.activeJobs ?? new Set<Promise<void>>();
  const backoffMs = opts.claimErrorBackoffMs ?? Math.max(opts.pollMs, 1000);
  // M5: esquema V2 ausente (42P01) → un error claro y re-chequeo lento, no un error cada poll.
  const schema = opts.schemaBackoff ?? new MissingSchemaBackoff(logger, 'dynamic-package-worker');
  while (!opts.isStopping()) {
    let waitMs = opts.pollMs;
    while (!opts.isStopping() && active.size < opts.concurrency) {
      let job: PackageJobRow | null;
      try {
        job = await claimNext(deps.dataSource, deps.workerId, deps.leaseSeconds, logger);
      } catch (err) {
        const schemaWait = schema.onClaimError(err);
        if (schemaWait !== null) {
          waitMs = schemaWait;
          break;
        }
        logger.error(`claimNext falló (reintento en ${backoffMs}ms): ${errMessage(err)}`);
        waitMs = backoffMs;
        break;
      }
      schema.onClaimOk();
      if (!job) break;
      logger.log(`Job reclamado: ${job.id} (run ${job.input_payload?.runId})`);
      const claimed = job;
      const promise: Promise<void> = processItem(deps, claimed)
        .catch((err) => logger.error(`Error no manejado en job ${claimed.id}: ${errMessage(err)}`))
        .finally(() => { active.delete(promise); });
      active.add(promise);
    }
    if (opts.isStopping()) break;
    // Despierta antes si termina un job (hay cupo para reclamar otro).
    await Promise.race([sleep(waitMs), ...Array.from(active)]);
  }
  await Promise.allSettled(Array.from(active));
}

async function bootstrap() {
  const logger = new Logger('DynamicPackageWorker');
  // G4: con DYNAMIC_COURSE_STRUCTURE apagado, inactivo sin tocar la DB.
  if (holdIdleIfDynamicDisabled(logger, 'dynamic-package-worker')) return;
  // Config propia de este worker: inválida → no arranca (no afecta a otros procesos).
  const concurrency = resolveDynamicPackageWorkerConcurrency();
  // I3: una versión de Moodle inválida no detiene el worker (los jobs fallan
  // ruidosos, uno por uno, con el mensaje de config) pero se avisa ya.
  try {
    resolveDynamicMoodleVersion();
  } catch (err) {
    logger.error(`${errMessage(err)} Todos los jobs dynamic_package van a fallar hasta corregirlo.`);
  }
  // M6: DYNAMIC_VIDEO_DELIVERY inválido → error claro en el log de arranque.
  reportVideoDeliveryConfigAtStartup(logger);

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

  logger.log(
    `dynamic-package-worker iniciado (workerId=${deps.workerId}, pollMs=${pollMs}, leaseSeconds=${deps.leaseSeconds}, concurrency=${concurrency})`,
  );

  await runPackageWorkerLoop(deps, { concurrency, pollMs, isStopping: () => shuttingDown, activeJobs });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    const logger = new Logger('DynamicPackageWorker');
    logger.error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
