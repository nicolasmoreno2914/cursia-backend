import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MissingSchemaBackoff, holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { awaitDrain, drainTimeoutMs } from './worker-drain';
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
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { WorkerLedger, recordPackageBuild } from './finops-worker-hooks';
import { buildDynamicMbzV3, DYNAMIC_MBZ_BUILDER_VERSION_V3 } from '../package/dynamic-mbz-builder-v3';
import { PACKAGE_KINDS, PackageKind, QA_INTERNAL_STORAGE_PREFIX, QA_PACKAGE_FILENAME_PREFIX, summaryLooksPreview } from '../modules/dynamic-packaging/package-freshness';
import { frozenProviderModesOf } from '../modules/dynamic-generation/provider-modes';
import { validateMbzV3 } from '../package/v3/mbz-validator-v3';
import { PackageSizeLimits, packageSizeBudget, packageSizeLimitsFromEnv } from '../package/v3/package-size-budget';
import { buildPackagingPlanV3 } from '../modules/dynamic-packaging/packaging-plan-v3';
import {
  ContentLoadersV3,
  artifactsServiceLoadersV3,
  loadContentsV3,
  prepareV3Package,
  loadPracticeFilesV3,
} from '../modules/dynamic-packaging/packaging-v3';
import { resolveTheme } from '../modules/theme-engine';
import { assessmentItemCountsForPackage, resolveAssessment } from '../package/assessment';
import type { BlueprintSnapshotV2 } from '../modules/course-blueprints/blueprint-snapshot';
import { hoursReportSummary } from '../modules/study-time/hours-ledger';
import { buildPackageQualityReport, courseQualityReportSummary, CourseQualityReport, PackageQualityInput } from '../modules/quality/course-quality-report';
import { PackageObservationResult, buildPackageObservationFindings, observationFailed } from '../modules/quality/package-observation';
import type { ContextSummaryInput, CoursePlanInput } from '../modules/coherence/coherence-types';
import { effectiveOutputRowsSql } from '../modules/dynamic-generation/item-generations';
import type { ResolvedArtifactV3, ResolvedItemV3 } from '../modules/dynamic-packaging/packaging-v3';
import { PACKAGE_REUSE_REJECTED, PACKAGE_REUSE_VERIFY_UNAVAILABLE, chooseDynamicMbzUploadPath, verifyReusableDynamicMbz } from '../modules/dynamic-packaging/package-reuse-verify';
import { sha256Hex } from '../modules/artifacts/artifacts.service';
import { isNonRealLlmMode } from '../modules/artifacts/artifact-type-policy';
import { classifyFailure } from '../modules/reliability/failure-classifier';

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
  /**
   * V2.1 RF-b: ledger de costos — un evento ZERO_BY_DESIGN por build
   * (idempotente por el id del job de paquete). El bootstrap SIEMPRE lo
   * cablea; opcional solo para harnesses previos. Un fallo del ledger se
   * loguea como error y nunca rompe el empaquetado.
   */
  finops?: WorkerLedger | null;
  /**
   * V2.1 R12 (rulesVersion 3). Opcionales para no romper harnesses previos;
   * el bootstrap los cablea y, si faltan, se usan las implementaciones reales.
   */
  buildMbzV3?: typeof buildDynamicMbzV3;
  validateMbzV3?: typeof validateMbzV3;
  /** Cargadores de contenidos v3 por dueño (default: ArtifactsService + fetch). */
  loadersV3?: (ownerId: string) => ContentLoadersV3;
  /** Reloj inyectable (segundos UNIX) para el `ts` del .mbz v3. */
  nowSeconds?: () => number;
  /**
   * T6 (r57): límites de tamaño del .mbz v3 (default: PACKAGE_MBZ_WARN_BYTES / PACKAGE_MBZ_MAX_BYTES del entorno,
   * leídos en cada job; sin variables = solo medir e informar).
   */
  packageSizeLimits?: () => PackageSizeLimits;
  /**
   * r63 (V1): hallazgos de observación del informe de calidad (batería Q1–Q9, alineación, C1–C7). Inyectables para
   * pruebas; por defecto, las implementaciones reales. Nunca cambian el .mbz ni el estado del job.
   */
  buildObservationFindings?: typeof buildPackageObservationFindings;
  loadObservationSidecars?: typeof loadObservationSidecarsV3;
}

export interface PackageJobRow {
  id: string;
  owner_id: string;
  course_id: number;
  frontend_course_id: string | null;
  worker_status: string;
  status: string;
  /** EV6 DoD: `packageKind` solo en paquetes QA (`qa_preview` | `degraded`); ausente = final. */
  input_payload: { runId: string; manifestId: number; blueprintNumber: number; packageKind?: string };
  output_summary: Record<string, any>;
  attempt_count: number | null;
  max_attempts: number | null;
}

function artifactCourseId(job: PackageJobRow): string {
  return job.frontend_course_id ?? String(job.course_id);
}

/**
 * r58 (AU1 R1): de los candidatos que coinciden por metadata, el primero (más nuevo) que pasa la verificación
 * del servidor (ruta canónica + checksum + bytes; v3: validado). Un descarte se loguea y se sigue buscando;
 * sin ninguno → null (el job reconstruye).
 */
async function firstVerifiedCandidate<T extends { id: string; storageBucket?: string | null; storagePath?: string | null; checksumSha256?: string | null; metadata?: any }>(
  artifacts: ArtifactsService,
  candidates: T[],
  expected: { ownerId: string; courseId: string; manifestId: number; runId: string; sourceIdsHash: string; qa: boolean },
  requireValidated: boolean,
  logger?: Pick<Logger, 'warn'>,
): Promise<T | null> {
  for (const c of candidates) {
    const v = await verifyReusableDynamicMbz(artifacts, c, expected, { requireValidated });
    if (v.ok === true) return c;
    // Review r1 (I-1): un fallo transitorio de Storage al verificar NO dispara un rebuild (que antes terminaba
    // pisando los bytes entregados): el job falla con un código clase A y se reintenta.
    // r62 (K4): un fallo transitorio de Storage al descargar el candidato ya no hace fallar el job. Desde 26890be el
    // rebuild nunca pisa un objeto referenciado (`chooseDynamicMbzUploadPath` → `<clave>.<sha16>.mbz`, upload con
    // upsert:false): se descarta el candidato SIN tocarlo y se reconstruye en una ruta nueva (costo 0).
    if ((v as { reason: string }).reason === 'download_failed') {
      logger?.warn(`${PACKAGE_REUSE_VERIFY_UNAVAILABLE}: no se pudo descargar dynamic_mbz ${c.id} del run ${expected.runId} para verificarlo (Storage) — no se reutiliza; se reconstruye en una ruta nueva sin pisar el objeto existente`);
      continue;
    }
    logger?.warn(`${PACKAGE_REUSE_REJECTED}:${(v as { reason: string }).reason} — dynamic_mbz ${c.id} del run ${expected.runId} no se reutiliza (se reconstruye)`);
  }
  return null;
}

async function findExistingDynamicMbz(
  artifacts: ArtifactsService,
  ownerId: string,
  courseId: string,
  runId: string,
  sourceIdsHash: string,
  moodleVersion: string,
  packageKind: PackageKind = 'final',
  manifestId?: number,
  logger?: Pick<Logger, 'warn'>,
): Promise<{ id: string } | null> {
  const list = await artifacts.findAll(ownerId, { courseId, type: 'dynamic_mbz' });
  const candidates = list.filter((a) => {
    const meta = a.metadata as Record<string, any> | null;
    // I3: la clave ya incluye la versión (salvo el default, byte-idéntico);
    // además se exige que la versión registrada coincida — sin campo (.mbz
    // anteriores a M11) = 4.1, el default del builder.
    if (!(meta?.runId === runId
      && meta?.sourceIdsHash === sourceIdsHash
      && meta?.builderVersion === DYNAMIC_MBZ_BUILDER_VERSION
      && (meta?.moodleVersion ?? '4.1') === moodleVersion)) return false;
    // DoD follow-up (R7): solo un .mbz del MISMO tipo (un QA nunca reutiliza el final ni al revés).
    if (packageKind !== 'final') return meta?.packageKind === packageKind;
    return !meta?.packageKind;
  });
  if (!candidates.length) return null;
  const expected = { ownerId, courseId, manifestId: Number(manifestId ?? candidates[0].metadata?.manifestId), runId, sourceIdsHash, qa: packageKind !== 'final' };
  const match = await firstVerifiedCandidate(artifacts, candidates, expected, false, logger);
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

/**
 * r62 (d7): clasificación del fallo de un job de paquete que el worker deja en `output_summary.failure`
 * ({class, code, transient}). `transient` = clase A del clasificador de empaque (Storage, DB, red, carrera de ruta):
 * el empaque automático lo reintenta con espera creciente sin consumir el tope de intentos. Un BLOCKER determinista
 * (`MBZ_V3_VALIDATION_FAILED` y el resto de `package_product`, clase D / product_bug) nunca es transitorio.
 */
export function packageJobFailureRecord(message: string): { class: string; code: string; transient: boolean; at: string } {
  const v = classifyFailure({ source: 'package_worker', error: String(message ?? '') });
  return { class: v.class, code: v.code, transient: v.class === 'A' && !v.unclassified, at: new Date().toISOString() };
}

async function failJob(dataSource: DataSource, jobId: string, workerId: string, message: string): Promise<void> {
  await dataSource.query(
    `update public.production_jobs
        set status = 'failed', worker_status = 'failed', finished_at = now(),
            lease_until = null, error_message = $3, updated_at = now(),
            output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('failure', $4::jsonb)
      where id = $1 and worker_id = $2`,
    [jobId, workerId, message, JSON.stringify(packageJobFailureRecord(message))],
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

    // V2.1 R12: rulesVersion 3 tiene su propio camino (plan, artifacts, perfiles, builder y validador v3).
    if (manifest.manifest?.rulesVersion === 3) {
      await processV3PackageJob(deps, job, manifest, moodle.resolved, moodle.requested, () => leaseLost);
      return;
    }

    // DoD follow-up (R7): v1/v2 también puede armar un paquete QA (solo SUPER_ADMIN con el escape de QA,
    // decidido por PackagingService). Un paquete final: bytes, ruta y resumen de siempre.
    const packageKind: PackageKind = (PACKAGE_KINDS as readonly string[]).includes(String(job.input_payload?.packageKind))
      ? (job.input_payload.packageKind as PackageKind)
      : 'final';
    const qa = packageKind !== 'final';
    const qaSummary = qa ? { packageKind, deliverable: false } : {};
    const byItem = await deps.resolveArtifacts({ query: deps.dataSource.query.bind(deps.dataSource) }, runId, manifest.manifest);
    const ids = sortedArtifactIds(byItem);
    const sourceIdsHash = packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, moodle.resolved);
    // Fase 8: los artifacts 'stale' (STALE_NO_AUTO) se empaquetan con aviso visible.
    const warnings = staleArtifactWarnings(byItem);
    const warningsSummary = warnings.length > 0 ? { warnings } : {};
    if (leaseLost) return;

    // Restore-first: mismo runId + mismo set de artifacts de origen + misma versión -> reusar.
    const existing = await findExistingDynamicMbz(deps.artifacts, job.owner_id, artifactCourseId(job), runId, sourceIdsHash, moodle.resolved, packageKind, manifest.id, logger);
    if (existing) {
      logger.log(`Job ${job.id}: dynamic_mbz ya existe (${existing.id}) para runId=${runId} — reutilizando sin reconstruir`);
      const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
        artifactId: existing.id,
        sourceArtifactIds: ids,
        sourceIdsHash,
        builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
        reused: true,
        ...qaSummary,
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
    const buffer = await deps.buildMbz({ plan, contents, moodleVersion: moodle.requested, ...(qa ? { qaPreviewNotice: true } : {}) });
    if (leaseLost) return;

    // DoD follow-up (R7): un paquete QA va con el prefijo `QA-VISTA-PREVIA-` y bajo `qa-internal/` (fuera de
    // las políticas own-folder del dueño), igual que en v3.
    const mbzFilename = `${qa ? QA_PACKAGE_FILENAME_PREFIX : ''}${sourceIdsHash}.mbz`;
    const canonicalPath = `${qa ? `${QA_INTERNAL_STORAGE_PREFIX}/` : ''}${job.owner_id}/dynamic/${artifactCourseId(job)}/${manifest.id}/dynamic_mbz/${runId}/${mbzFilename}`;
    // Review r1 (I-1): si un artifact ya referencia la ruta canónica (paquete entregado), el rebuild va a una ruta NUEVA.
    const { storagePath, rebuilt } = await chooseDynamicMbzUploadPath(deps.artifacts, canonicalPath, sha256Hex(buffer));
    if (rebuilt) logger.warn(`Job ${job.id}: ${canonicalPath} ya está referenciado por un artifact — el rebuild se sube a ${storagePath} (los bytes entregados quedan intactos)`);
    const artifact = await deps.artifacts.uploadBufferArtifact({
      ownerId: job.owner_id,
      courseId: artifactCourseId(job),
      jobId: job.id,
      type: 'dynamic_mbz',
      filename: mbzFilename,
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
      // r58 (AU1 R1): un objeto preexistente en la ruta canónica solo se adopta con los mismos bytes; review r1 (I-1):
      // solo se reemplaza un objeto HUÉRFANO (sin row); uno referenciado → PACKAGE_OBJECT_CONFLICT (nunca se pisa).
      replaceUnverifiedOnConflict: true,
      metadata: {
        runId,
        manifestId: manifest.id,
        sourceArtifactIds: ids,
        sourceIdsHash,
        builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
        moodleVersion: moodle.resolved,
        ...qaSummary,
      },
    });
    if (leaseLost) return;

    // V2.1 RF-b: packaging = costo directo 0 (ZERO_BY_DESIGN), atribuido al run.
    if (deps.finops) {
      try {
        await recordPackageBuild(deps.finops, { ownerId: job.owner_id, packageJobId: job.id, runId: runId ?? null });
      } catch (err) {
        logger.error(`finops: no se pudo registrar el build del paquete ${job.id} en el ledger — ${errMessage(err)}`);
      }
    }

    const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
      artifactId: artifact.id,
      sourceArtifactIds: ids,
      sourceIdsHash,
      builderVersion: DYNAMIC_MBZ_BUILDER_VERSION,
      reused: false,
      ...qaSummary,
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
 * V2.1 R12 — job de empaquetado de un run rulesVersion 3. Nunca genera: solo
 * consume artifacts ya completados. Orden (fail loud en cada paso):
 *   1. resolver artifacts v3 + guarda de mocks (R-007) + perfiles vigentes →
 *      clave de reuse v3 (tema, nota mínima, builder, renderer, H5P, Moodle);
 *   2. restore-first: mismo run + misma clave → se reutiliza el .mbz;
 *   3. cargar contenidos (fixtures simuladas → medios sintéticos, solo si el
 *      run está congelado en mock para ese proveedor);
 *   4. build v3 + VALIDADOR v3 ANTES de subir (un hallazgo = job fallido);
 *   5. subir, evento ZERO_BY_DESIGN (RF-b) y completar con resumen/avisos.
 * Exportado para tests.
 */
export async function processV3PackageJob(
  deps: DynamicPackageWorkerDeps,
  job: PackageJobRow,
  manifest: ManifestDto,
  moodleVersion: string,
  moodleRequested: string | undefined,
  isLeaseLost: () => boolean,
): Promise<void> {
  const { logger } = deps;
  const { runId, blueprintNumber } = job.input_payload;
  // EV6 DoD (BE-A): tipo de paquete decidido por PackagingService (QA solo para SUPER_ADMIN).
  const packageKind: PackageKind = (PACKAGE_KINDS as readonly string[]).includes(String(job.input_payload?.packageKind))
    ? (job.input_payload.packageKind as PackageKind)
    : 'final';
  const qa = packageKind !== 'final';
  const q = { query: deps.dataSource.query.bind(deps.dataSource) };
  const prepared = await prepareV3Package(q, runId, manifest, job.course_id, moodleVersion);
  const { sourceIdsHash, sourceArtifactIds: ids } = prepared;
  // EV6 DoD: un paquete FINAL nunca lleva componentes de vista previa (videos omitidos o Gamma/TTS
  // simulados). Defensa en el worker (un job viejo o encolado por otro camino): falla fuerte.
  // r58 (AU1 R2): texto generado por un LLM falso o reproducido (llmMode mock/replay) nunca va en un final.
  const nonRealLlm = nonRealLlmItemKeys(prepared.byItem);
  if (!qa) {
    const pm = frozenProviderModesOf(prepared.run?.input_payload);
    const mockProviders = !!pm && (pm.presentation === 'mock' || pm.audio === 'mock');
    if (prepared.pendingVideos.length > 0 || mockProviders || nonRealLlm.length > 0) {
      throw new Error(
        `preview_not_deliverable: el run ${runId} tiene componentes de vista previa ` +
          `(${prepared.pendingVideos.length} video(s) pendiente(s)${mockProviders ? ', Gamma/TTS simulados' : ''}` +
          `${nonRealLlm.length ? `, ${nonRealLlm.length} item(s) con texto de IA simulado/reproducido: ${nonRealLlm.slice(0, 8).join(', ')}` : ''}); ` +
          'un paquete final solo se arma con todos los componentes reales (el paquete QA lo pide un administrador).',
      );
    }
  }
  const baseSummary = {
    sourceArtifactIds: ids,
    sourceIdsHash,
    builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3,
    rulesVersion: 3,
    moodleVersion,
    assessmentProfileVersion: prepared.profiles.assessmentVersion,
    presentationProfileVersion: prepared.profiles.presentationVersion,
    themeSource: prepared.profiles.theme.source,
    themeSha256: prepared.profiles.themeSha256,
    // F1 (I3): weightsNormalized + pesos originales/finales, o curso sin nota.
    assessment: prepared.assessment,
    // EV6 T5: videos de vista previa omitidos del paquete (la UI avisa «videos pendientes»).
    pendingVideos: pendingVideosSummary(manifest, prepared.pendingVideos.map((p) => p.itemKey)),
    // EV6 DoD: solo los paquetes QA lo declaran (el resumen de un final no cambia).
    ...(qa ? { packageKind, deliverable: false } : {}),
    // r58 (AU1 R2): items con texto de IA simulado / reproducido (solo un paquete QA puede tenerlos).
    ...(nonRealLlm.length ? { llmNonRealItems: nonRealLlm } : {}),
  };
  // F1: avisos de perfiles (tema por defecto, pesos normalizados, curso sin nota) — también en un paquete reutilizado.
  const profileWarnings = prepared.profileWarnings.map((w) => ({ code: w.split(':')[0], detail: w }));
  if (isLeaseLost()) return;

  // EV6 T5 (fix round 1, m-2): el aviso de video pendiente de cada capítulo solo se decide al
  // construir; un .mbz reutilizado lo trae en su metadata (mismo sourceIdsHash = mismos textos).
  const pendingWarnings = baseSummary.pendingVideos.map((p) => ({ code: 'pending_video_omitted', detail: `pending_video_omitted:${p.itemKey}` }));
  const existing = await findExistingDynamicMbzV3(deps.artifacts, job.owner_id, artifactCourseId(job), runId, sourceIdsHash, packageKind, manifest.id, logger);
  if (existing) {
    logger.log(`Job ${job.id}: dynamic_mbz v3 ya existe (${existing.id}) para runId=${runId} — reutilizando sin reconstruir`);
    const reusedPending: any[] = Array.isArray(existing.metadata?.pendingVideos) ? existing.metadata.pendingVideos : baseSummary.pendingVideos;
    const reuseWarnings = [...prepared.staleWarnings, ...profileWarnings, ...pendingWarnings];
    const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
      artifactId: existing.id,
      reused: true,
      ...baseSummary,
      pendingVideos: reusedPending,
      pendingVideoNoticeCount: reusedPending.filter((p) => p && p.notice === true).length,
      // EV6 H5P v2: la instrucción de restauración viaja en la metadata del .mbz reutilizado.
      ...(existing.metadata?.restore ? { restore: existing.metadata.restore } : {}),
      ...(existing.metadata?.moodleCompatibility && typeof existing.metadata.moodleCompatibility === 'object' ? { moodleCompatibility: existing.metadata.moodleCompatibility } : {}),
      // r58 (I2): el informe de calidad viaja en la metadata del .mbz reutilizado (mismos textos = mismo informe).
      ...(existing.metadata?.qualityReport && typeof existing.metadata.qualityReport === 'object' ? { qualityReport: existing.metadata.qualityReport } : {}),
      ...(reuseWarnings.length ? { warnings: reuseWarnings } : {}),
    });
    if (!ok) logger.warn(`Job ${job.id}: completeJob devolvió false (lease perdida) tras reutilizar ${existing.id}`);
    return;
  }

  const blueprint = await deps.blueprints.getByNumberAnySchema(job.course_id, job.owner_id, blueprintNumber);
  if (blueprint.schemaVersion !== 2) throw new Error(`el run v3 exige un Blueprint schemaVersion 2 (vino ${blueprint.schemaVersion})`);
  const snapshot = blueprint.snapshot as BlueprintSnapshotV2;
  const pendingVideoChapterIds = prepared.pendingVideos.map((p) => p.chapterId);
  const omittedVideoKeys = prepared.pendingVideos.map((p) => p.itemKey);
  const plan = buildPackagingPlanV3(manifest.manifest, snapshot, { manifestId: manifest.id, omitVideoChapterIds: pendingVideoChapterIds });
  const theme = resolveTheme(prepared.profiles.theme.input);
  const loaders = deps.loadersV3 ? deps.loadersV3(job.owner_id) : artifactsServiceLoadersV3(deps.artifacts, job.owner_id);
  const loaded = await loadContentsV3(loaders, plan, prepared.byItem, prepared.run, { familyId: theme.familyId, mode: theme.mode });
  // T5 (r57): archivos de trabajo SUBIDOS del perfil (los de tabla los genera el builder). Sin ellos, la entrada de siempre.
  const practiceFiles = await loadPracticeFilesV3(q, loaders, job.owner_id, prepared.profiles.assessment);
  if (practiceFiles.size) loaded.contents.practiceFiles = practiceFiles;
  if (isLeaseLost()) return;

  const build = deps.buildMbzV3 ?? buildDynamicMbzV3;
  const built = await build({
    manifest: manifest.manifest,
    blueprint: snapshot,
    manifestId: manifest.id,
    assessmentProfile: prepared.profiles.assessment,
    presentation: prepared.profiles.theme.input,
    contents: loaded.contents,
    ts: (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
    moodleVersion: moodleRequested,
    pendingVideoChapterIds,
    // r19 (L3): logo de la cuenta (o ninguno → Cursia) y nombre de la institución para el Libro Guía en PDF.
    // fix round 3: candidatos en orden (brand_profile → user_settings); el builder usa el primero que valida.
    libroBrand: { logo: prepared.libroBrand?.candidates ?? prepared.libroBrand?.logo ?? null, name: prepared.libroBrand?.name ?? null },
    libroReferences: prepared.libroReferences ?? null,
    // r58 (I3) fix: horas objetivo congeladas en el Blueprint → «Duración estimada: X h (definida por la institución)» en
    // la bienvenida y «Carga horaria declarada» en la Guía del docente. Antes nunca se pasaban (facts.hours = null siempre).
    hours: packageDeclaredHours(snapshot),
    // Review r1 (M-5): «(definida por la institución)» solo si el Blueprint congeló que las horas vienen del documento.
    hoursSource: packageDeclaredHoursSource(snapshot),
    // EV6 DoD: paquete QA → aviso visible en la bienvenida + nombre del curso «[QA — vista previa, no entregable]».
    ...(qa ? { qaPreviewNotice: true } : {}),
  });
  // §Q.8: el validador corre sobre los BYTES del paquete, antes de subir. Un hallazgo = fail loud.
  // G6 M1: la evaluación esperada se resuelve ACÁ, del perfil que cargó el worker (no se confía en la del builder).
  // F1 (I3): con los mismos itemCounts del Manifest que usa el builder.
  const resolved = resolveAssessment(prepared.profiles.assessment, {
    hasFinalExam: manifest.manifest.features?.finalExam === true,
    activityEngine: manifest.manifest.features?.activityEngine,
    itemCounts: assessmentItemCountsForPackage(manifest.manifest, omittedVideoKeys, prepared.profiles.assessment),
  });
  if (JSON.stringify(resolved) !== JSON.stringify(built.expectations.resolved)) {
    throw new Error('MBZ_V3_VALIDATION_FAILED: el builder resolvió una evaluación distinta de la del perfil vigente');
  }
  const validation = await (deps.validateMbzV3 ?? validateMbzV3)(built.mbz, { facts: built.expectations.facts, resolved, examBankPlans: built.expectations.examBankPlans, shellProseByLabel: built.expectations.shellProseByLabel, builderVersion: built.expectations.builderVersion, moodleMinimum: built.expectations.moodleMinimum, internalVocabularyExempt: built.expectations.internalVocabularyExempt, internalVocabularyUserTexts: built.expectations.internalVocabularyUserTexts });
  if (!validation.ok) {
    throw new Error(
      `MBZ_V3_VALIDATION_FAILED: ${validation.issues.length} hallazgo(s): ` +
        validation.issues.slice(0, 8).map((i) => `${i.code} ${i.where}: ${i.message}`).join(' | '),
    );
  }
  // T6 (r57): presupuesto de tamaño ANTES de subir — un paquete sobre el límite configurado falla acá con un código
  // claro (nunca un 413 del almacenamiento después de armarlo); sobre el umbral de aviso, aviso visible.
  const sizeVerdict = await packageSizeBudget(built.mbz, (deps.packageSizeLimits ?? packageSizeLimitsFromEnv)());
  if (sizeVerdict.error) throw new Error(sizeVerdict.error);
  if (isLeaseLost()) return;

  // r58 (I2): informe de calidad del curso (formato común E4) sobre los artifacts ya pagados: avisos del builder, registro de
  // horas y chequeos determinísticos nuevos. Nunca bloquea por sí solo (un BLOCKER real ya falló arriba); un MAJOR requiere
  // resolución humana (visible a administradores en «Curso listo»). Si el informe falla, aviso VISIBLE (nunca en silencio).
  let qualityReport: CourseQualityReport | null = null;
  const qualityReportWarnings: string[] = [];
  // r63 (V1): lo que ya se mide después de generar (Q1–Q9, alineación, C1–C7) entra al informe en MODO OBSERVACIÓN:
  // nunca BLOCKER ni MAJOR, contado aparte (report.observation), sin tocar el .mbz (ya construido y validado arriba), el
  // estado del job ni FinOps. Cualquier falla queda como INFO «no se pudo evaluar X» y el empaque sigue igual.
  let observation: PackageObservationResult;
  try {
    const sidecars = await (deps.loadObservationSidecars ?? loadObservationSidecarsV3)(q, runId, manifest.manifest, prepared.byItem, loaders);
    const artifactTypesByItem: Record<string, string[]> = {};
    for (const [key, it] of prepared.byItem) artifactTypesByItem[key] = it.artifacts.map((a) => a.type);
    observation = (deps.buildObservationFindings ?? buildPackageObservationFindings)({
      manifest: manifest.manifest, blueprint: snapshot, contents: loaded.contents as any, artifactTypesByItem,
      coursePlan: sidecars.coursePlan, contextSummaries: sidecars.contextSummaries, sidecarsError: sidecars.error,
    });
  } catch (err) {
    logger.warn(`Job ${job.id}: hallazgos de observación del informe de calidad no evaluados — ${errMessage(err)}`);
    observation = observationFailed(err);
  }
  try {
    const titles = new Map<string, string>(((prepared.profiles.assessment as any)?.practiceResources ?? []).map((r: any) => [String(r.id), String(r.title ?? '')]));
    const qualityInput: PackageQualityInput = {
      manifest: manifest.manifest as any,
      blueprint: snapshot as any,
      contents: loaded.contents as any,
      packageWarnings: [...built.summary.warnings, ...(built.summary.qualityWarnings ?? [])],
      practiceResources: built.summary.practiceResources ?? null,
      practiceTitles: titles,
      hoursReport: (built.expectations.facts as any).hoursReport ?? null,
      builderVersion: built.summary.builderVersion,
    };
    let full: CourseQualityReport;
    try {
      full = buildPackageQualityReport({ ...qualityInput, extraFindings: observation.findings, observationMeta: observation.meta });
    } catch (obsErr) {
      // r63 (V1): un hallazgo de observación mal formado nunca tumba el informe de siempre.
      logger.warn(`Job ${job.id}: informe con hallazgos de observación falló — ${errMessage(obsErr)}; se arma sin ellos`);
      const failed = observationFailed(obsErr);
      full = buildPackageQualityReport({ ...qualityInput, extraFindings: failed.findings, observationMeta: failed.meta });
    }
    qualityReport = courseQualityReportSummary(full);
  } catch (err) {
    qualityReportWarnings.push(`quality_report_failed:${errMessage(err).slice(0, 160)}`);
    logger.error(`Job ${job.id}: no se pudo armar el informe de calidad — ${errMessage(err)}`);
  }

  // EV6 T5 (fix round 1, m-2): pendientes con el flag `notice` del builder (ruling 3, medible).
  const noticeByKey = new Map(built.summary.pendingVideos.map((p) => [p.itemKey, p.notice === true]));
  const pendingVideos = baseSummary.pendingVideos.map((p) => ({ ...p, notice: noticeByKey.get(p.itemKey) === true }));
  const pendingSummary = { pendingVideos, pendingVideoNoticeCount: pendingVideos.filter((p) => p.notice).length };

  // EV6 DoD: un paquete QA va a OTRA ruta/nombre (`QA-VISTA-PREVIA-…`): nunca adopta ni pisa el .mbz
  // de un paquete anterior con la misma clave (p.ej. uno B1 sin rótulo).
  const mbzFilename = `${qa ? QA_PACKAGE_FILENAME_PREFIX : ''}${sourceIdsHash}.mbz`;
  // Fix round 3 (N2): un paquete QA / degradado va bajo un prefijo INTERNO (primer segmento ≠ uid del
  // dueño): ninguna política de Storage de `authenticated` (own-folder) lo cubre → solo el backend
  // (service role, para un SUPER_ADMIN) lo firma. El paquete final conserva la ruta de siempre.
  const canonicalPath = qa
    ? `${QA_INTERNAL_STORAGE_PREFIX}/${job.owner_id}/dynamic/${artifactCourseId(job)}/${manifest.id}/dynamic_mbz/${runId}/${mbzFilename}`
    : `${job.owner_id}/dynamic/${artifactCourseId(job)}/${manifest.id}/dynamic_mbz/${runId}/${mbzFilename}`;
  // Review r1 (I-1): nunca se sobrescribe un .mbz que un artifact referencia; el rebuild va a `<clave>.<sha16>.mbz`.
  const { storagePath, rebuilt } = await chooseDynamicMbzUploadPath(deps.artifacts, canonicalPath, sha256Hex(built.mbz));
  if (rebuilt) logger.warn(`Job ${job.id}: ${canonicalPath} ya está referenciado por un artifact — el rebuild v3 se sube a ${storagePath} (los bytes entregados quedan intactos)`);
  const artifact = await deps.artifacts.uploadBufferArtifact({
    ownerId: job.owner_id,
    courseId: artifactCourseId(job),
    jobId: job.id,
    type: 'dynamic_mbz',
    filename: mbzFilename,
    storagePath,
    buffer: built.mbz,
    mimeType: 'application/vnd.moodle.backup',
    upsert: false,
    adoptExistingOnConflict: true,
    // r58 (AU1 R1): un objeto preexistente en la ruta canónica solo se adopta con los mismos bytes (validados).
    replaceUnverifiedOnConflict: true,
    // r58 (AU1 R1): sha256 de los bytes que aprobó validateMbzV3 (el reuse lo exige igual al checksum de Storage).
    metadata: { runId, manifestId: manifest.id, ...baseSummary, ...pendingSummary, ...(built.summary.restore ? { restore: built.summary.restore } : {}), ...(built.summary.moodleCompatibility ? { moodleCompatibility: built.summary.moodleCompatibility } : {}), ...(qualityReport ? { qualityReport } : {}), validatedSha256: sha256Hex(built.mbz) },
  });
  if (isLeaseLost()) return;

  if (deps.finops) {
    try {
      await recordPackageBuild(deps.finops, { ownerId: job.owner_id, packageJobId: job.id, runId: runId ?? null });
    } catch (err) {
      logger.error(`finops: no se pudo registrar el build del paquete ${job.id} en el ledger — ${errMessage(err)}`);
    }
  }
  // r19 (L3): los avisos del logo los calcula prepare (también para un paquete reutilizado) y el builder; sin duplicados.
  const profileDetails = new Set(profileWarnings.map((w) => w.detail));
  const warnings = [
    ...prepared.staleWarnings,
    ...profileWarnings,
    ...[...loaded.warnings, ...built.summary.warnings].filter((w) => !profileDetails.has(w)).map((w) => ({ code: w.split(':')[0], detail: w })),
    ...sizeVerdict.warnings.map((w) => ({ code: w.split(':')[0], detail: w })),
    ...qualityReportWarnings.map((w) => ({ code: w.split(':')[0], detail: w })),
  ];
  const ok = await completeJob(deps.dataSource, job.id, deps.workerId, {
    artifactId: artifact.id,
    reused: false,
    ...baseSummary,
    ...pendingSummary,
    planSha256: built.summary.planSha256,
    counts: built.summary.counts,
    h5pPackages: built.summary.h5pPackages,
    // r19 (L): Libro Guía en PDF (archivo, páginas, logo usado como marca de agua).
    ...(built.summary.libro ? { libro: built.summary.libro } : {}),
    // Instrucción de restauración del paquete (r55: requisito del sitio = pack H5P v3; jobs ≤ 3.13.0: administrador o gestor).
    ...(built.summary.restore ? { restore: built.summary.restore } : {}),
    // r60: Moodle mínimo en el que el curso funciona (H5P core API / tokens), aparte del formato del backup.
    ...(built.summary.moodleCompatibility ? { moodleCompatibility: built.summary.moodleCompatibility } : {}),
    mockProviderItems: loaded.mockProviderItems,
    validation: validation.stats,
    // T6 (r57): tamaño del paquete subido y lo más pesado (siempre; los límites solo si están configurados).
    size: { totalBytes: sizeVerdict.stats.totalBytes, uncompressedBytes: sizeVerdict.stats.uncompressedBytes, entries: sizeVerdict.stats.entries, largest: sizeVerdict.stats.largest, ...(sizeVerdict.limits.maxBytes !== null ? { maxBytes: sizeVerdict.limits.maxBytes } : {}), ...(sizeVerdict.limits.warnBytes !== null ? { warnBytes: sizeVerdict.limits.warnBytes } : {}) },
    ...(warnings.length ? { warnings } : {}),
    // T1 (r57): avisos de calidad del contenido (fórmulas repetidas entre capítulos); informativos, nunca fallan.
    ...(built.summary.qualityWarnings?.length ? { qualityWarnings: built.summary.qualityWarnings } : {}),
    // r58 (I2): informe de calidad (contadores por severidad + hallazgos, tope COURSE_QUALITY_SUMMARY_MAX_FINDINGS).
    ...(qualityReport ? { qualityReport } : {}),
    // r58 (I3): registro de horas del paquete (sin las líneas; están en facts): objetivo / estimado / asignado / gap.
    ...(built.expectations.facts.hoursReport ? { hoursReport: hoursReportSummary(built.expectations.facts.hoursReport) } : {}),
  });
  if (!ok) logger.warn(`Job ${job.id}: el .mbz v3 se subió (artifact ${artifact.id}) pero completeJob devolvió false (lease perdida)`);
}

/**
 * r63 (V1): entradas de C1–C7 para el informe de observación: el course_plan (ya resuelto en `byItem`) y los sidecars
 * `dynamic_context_summary_json` reales (opcionales, fuera de `byItem`) de la generación vigente de cada content. Nunca
 * lanza: un fallo vuelve como `error` (INFO en el informe) y las fuentes que sí cargaron se usan igual.
 */
export async function loadObservationSidecarsV3(
  q: { query: (sql: string, params?: any[]) => Promise<any[]> },
  runId: string,
  manifest: { items: ReadonlyArray<{ key: string; type: string; chapterId?: string | null }> },
  byItem: Map<string, ResolvedItemV3>,
  loaders: { loadText(a: ResolvedArtifactV3): Promise<string> },
): Promise<{ coursePlan: CoursePlanInput | null; contextSummaries: Record<string, ContextSummaryInput> | null; error: string | null }> {
  const errors: string[] = [];
  let coursePlan: CoursePlanInput | null = null;
  try {
    const planItem = manifest.items.find((i) => i.type === 'course_plan');
    const art = planItem ? byItem.get(planItem.key)?.artifacts.find((a) => a.type === 'dynamic_course_plan_json') : undefined;
    if (art) {
      const parsed = JSON.parse(await loaders.loadText(art));
      if (parsed && typeof parsed === 'object' && parsed.chapters) coursePlan = parsed as CoursePlanInput;
      else errors.push('course_plan sin chapters');
    }
  } catch (err) {
    errors.push(`course_plan: ${errMessage(err).slice(0, 80)}`);
  }
  let contextSummaries: Record<string, ContextSummaryInput> | null = null;
  try {
    const chapterOf = new Map(manifest.items.filter((i) => i.type === 'content' && i.chapterId).map((i) => [i.key, String(i.chapterId)]));
    const rows: any[] = await q.query(
      `select g.item_key as item_key, g.id as item_run_id, a.id as artifact_id, a.type as artifact_type,
              a.storage_bucket as storage_bucket, a.storage_path as storage_path, a.mime_type as mime_type
         from ${effectiveOutputRowsSql('$1')} g
         join public.artifacts a on a.item_run_id = g.id and a.status is distinct from 'disabled'
        where g.status = 'completed' and a.type = 'dynamic_context_summary_json'
        order by g.item_key, a.id`,
      [runId],
    );
    const wanted = (Array.isArray(rows) ? rows : []).filter((r) => r && r.artifact_type === 'dynamic_context_summary_json' && chapterOf.has(r.item_key));
    for (const r of wanted) {
      const chapterId = chapterOf.get(r.item_key)!;
      try {
        const s = JSON.parse(await loaders.loadText({ itemKey: r.item_key, itemType: 'content' as any, itemRunId: r.item_run_id, artifactId: r.artifact_id, type: r.artifact_type, storageBucket: r.storage_bucket ?? '', storagePath: r.storage_path ?? '', mimeType: r.mime_type ?? null, metadata: {} }));
        if (s?.chapterId && s.chapterId !== chapterId) { errors.push(`sidecar ${r.artifact_id} de otro capítulo`); continue; }
        contextSummaries = contextSummaries ?? {};
        contextSummaries[chapterId] = {
          summary: s?.summary ?? null,
          concepts_introduced: Array.isArray(s?.concepts_introduced) ? s.concepts_introduced : null,
          concepts_assumed: Array.isArray(s?.concepts_assumed) ? s.concepts_assumed : null,
          key_terms: Array.isArray(s?.key_terms) ? s.key_terms : null,
        };
      } catch (err) {
        errors.push(`sidecar ${r.item_key}: ${errMessage(err).slice(0, 60)}`);
      }
    }
  } catch (err) {
    errors.push(`sidecars: ${errMessage(err).slice(0, 80)}`);
  }
  return { coursePlan, contextSummaries, error: errors.length ? errors.slice(0, 4).join('; ') : null };
}

/**
 * r58 (I3): horas que la bienvenida muestra como «definidas por la institución»: las horas objetivo congeladas en el
 * Blueprint (perfil del curso o documento). Sin objetivo → null (la bienvenida no muestra duración; nunca se inventa).
 */
export function packageDeclaredHours(snapshot: BlueprintSnapshotV2): number | null {
  const t = snapshot?.course?.targetHours;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Review r1 (M-5): origen de las horas objetivo. `document` solo si el Blueprint lo congeló explícitamente
 * (`course.targetHoursSource = 'document'`); hoy el lock no lo congela (decisión #9 pendiente) → null = redacción neutra
 * «Duración estimada del curso: X h.» (el objetivo puede venir del perfil, de una propuesta de Cursia o del documento).
 */
export function packageDeclaredHoursSource(snapshot: BlueprintSnapshotV2): 'document' | null {
  return packageDeclaredHours(snapshot) !== null && (snapshot?.course as Record<string, unknown> | undefined)?.['targetHoursSource'] === 'document' ? 'document' : null;
}

/**
 * r58 (AU1 R2): items del run cuyo texto de IA NO es real (`output_summary.llmMode` del servidor o
 * `metadata.llmMode` de alguno de sus artifacts = mock | replay). Ordenados. Exportado para tests.
 */
export function nonRealLlmItemKeys(byItem: Map<string, { itemKey: string; outputSummary?: Record<string, any> | null; artifacts: Array<{ metadata?: Record<string, any> | null }> }>): string[] {
  const out: string[] = [];
  for (const it of byItem.values()) {
    if (isNonRealLlmMode(it.outputSummary?.llmMode) || it.artifacts.some((a) => isNonRealLlmMode(a.metadata?.llmMode))) out.push(it.itemKey);
  }
  return out.sort();
}

/**
 * EV6 T5: videos pendientes del paquete para el resumen del job / metadata del .mbz
 * (orden del Manifest). La UI solo necesita saber cuáles y cuántos.
 */
export function pendingVideosSummary(
  manifest: ManifestDto,
  itemKeys: string[],
): Array<{ itemKey: string; chapterId: string; chapterNumber: number | null }> {
  const keys = new Set(itemKeys);
  const out: Array<{ itemKey: string; chapterId: string; chapterNumber: number | null }> = [];
  for (const m of manifest.manifest.modules ?? []) {
    for (const c of m.chapters ?? []) {
      const key = `video:${c.chapterId}`;
      if (keys.has(key)) out.push({ itemKey: key, chapterId: c.chapterId, chapterNumber: Number.isInteger(c.chapterNumber) ? c.chapterNumber : null });
    }
  }
  return out;
}

async function findExistingDynamicMbzV3(
  artifacts: ArtifactsService,
  ownerId: string,
  courseId: string,
  runId: string,
  sourceIdsHash: string,
  packageKind: PackageKind = 'final',
  manifestId?: number,
  logger?: Pick<Logger, 'warn'>,
): Promise<{ id: string; metadata: Record<string, any> | null } | null> {
  const list = await artifacts.findAll(ownerId, { courseId, type: 'dynamic_mbz' });
  const candidates = list.filter((a) => {
    const meta = a.metadata as Record<string, any> | null;
    if (!(meta?.runId === runId && meta?.sourceIdsHash === sourceIdsHash && meta?.builderVersion === DYNAMIC_MBZ_BUILDER_VERSION_V3)) return false;
    // EV6 DoD: solo se reutiliza un .mbz del MISMO tipo. Un paquete QA nunca reutiliza uno sin
    // rótulo (B1, anterior a EV6 DoD) y un final nunca reutiliza uno de vista previa.
    if (packageKind !== 'final') return meta?.packageKind === packageKind;
    return !meta?.packageKind && !summaryLooksPreview(meta);
  });
  if (!candidates.length) return null;
  // r58 (AU1 R1): v3 exige además que esos bytes hayan pasado validateMbzV3 (metadata.validatedSha256).
  const expected = { ownerId, courseId, manifestId: Number(manifestId ?? (candidates[0].metadata as any)?.manifestId), runId, sourceIdsHash, qa: packageKind !== 'final' };
  const match = await firstVerifiedCandidate(artifacts, candidates, expected, true, logger);
  return match ? { id: match.id, metadata: (match.metadata as Record<string, any> | null) ?? null } : null;
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
    finops: app.get(FinopsLedgerService),
  };
  const pollMs = readPositiveInt('DYNAMIC_PACKAGE_WORKER_POLL_MS', 5000);

  let shuttingDown = false;
  const activeJobs = new Set<Promise<void>>();
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // R16 (#1): espera acotada (DYNAMIC_WORKER_DRAIN_TIMEOUT_MS, por debajo del kill_timeout de PM2). El empaque
    // no llama a proveedores pagados: un job cortado queda con su lease vencido y se reintenta (restore-first).
    const timeoutMs = drainTimeoutMs();
    logger.warn(`Recibido ${signal}; deja de reclamar y espera ${activeJobs.size} job(s) activo(s) (tope ${Math.round(timeoutMs / 1000)} s)`);
    if ((await awaitDrain(activeJobs, timeoutMs)) === 'timeout') {
      logger.error(`${activeJobs.size} job(s) de empaque siguen en vuelo tras ${Math.round(timeoutMs / 1000)} s; se sale igual (lease vencido → reintento)`);
    }
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
