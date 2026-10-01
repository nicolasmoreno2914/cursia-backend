/**
 * F78-BE2 / V2.1 R12 — ¿el paquete `.mbz` de un job `dynamic_package` completado sigue siendo el
 * VIGENTE del run? Extraído de PackagingService (EV6 DoD, BE-A) para que RunsService calcule
 * `RunDto.completion.packageReady` con EXACTAMENTE la misma clave de reuse (sin depender del módulo
 * Nest de empaquetado). Solo lectura.
 *
 * EV6 DoD: además, cada job de empaquetado tiene un `packageKind`:
 *  - `final`: el paquete entregable al cliente (todos los componentes reales y validados);
 *  - `qa_preview`: paquete de QA de un run de vista previa (solo SUPER_ADMIN con el escape
 *    DYNAMIC_ALLOW_VIDEO_PREVIEW=true), rotulado «QA — vista previa, no entregable»;
 *  - `degraded`: §2.6 (upgrade de videos fallido), solo SUPER_ADMIN, mismo rótulo QA.
 * Un job anterior a este cambio no tiene el campo: `packageKindOf` lo infiere de su resumen
 * (videos omitidos / proveedores simulados → `qa_preview`; si no, `final`, sin tocar sus datos).
 */
import { ACTIVE_RUN_WORKER_STATUSES } from '../dynamic-generation/item-transitions';
import { runIsUpgradeOnlyFailure } from '../dynamic-generation/video-upgrade';
import type { ManifestDto } from '../generation-manifests/generation-manifests.service';
import { resolveRunArtifacts } from './artifact-resolver';
import { packageReuseHash, resolveDynamicMoodleVersion, sortedArtifactIds } from './packaging-reuse-key';
import { DYNAMIC_MBZ_BUILDER_VERSION } from '../../package/dynamic-mbz-builder';
import { DYNAMIC_MBZ_BUILDER_VERSION_V3 } from '../../package/dynamic-mbz-builder-v3';
import { prepareV3Package } from './packaging-v3';

export type PackageKind = 'final' | 'qa_preview' | 'degraded';
export const PACKAGE_KINDS: readonly PackageKind[] = ['final', 'qa_preview', 'degraded'];
/** Prefijo del nombre de archivo de un paquete que NO es entregable (QA / degradado). */
export const QA_PACKAGE_FILENAME_PREFIX = 'QA-VISTA-PREVIA-';

/** worker_status del run que cuentan como "terminado" para empaquetar (EV6 DoD: + preview, solo QA). */
export const RUN_DONE_STATUSES: readonly string[] = ['completed', 'preview'];

export function isRunDone(run: { worker_status?: string | null; status?: string | null }): boolean {
  return RUN_DONE_STATUSES.includes(String(run?.worker_status ?? '')) || RUN_DONE_STATUSES.includes(String(run?.status ?? ''));
}

/**
 * packageKind de un job de empaquetado (input_payload o output_summary). Jobs anteriores a EV6 DoD
 * no tienen el campo: si su resumen registra videos omitidos (B1) o salidas de proveedor simuladas,
 * son paquetes de VISTA PREVIA (`qa_preview`, nunca entregables) — se identifican sin tocar sus
 * datos; si no, `final` (bytes y clave de reuse idénticos a antes).
 */
export function packageKindOf(job: { input_payload?: any; output_summary?: any } | null | undefined): PackageKind {
  const k = job?.output_summary?.packageKind ?? job?.input_payload?.packageKind;
  if ((PACKAGE_KINDS as readonly string[]).includes(k)) return k as PackageKind;
  return summaryLooksPreview(job?.output_summary) ? 'qa_preview' : 'final';
}

/** Resumen/metadata de un paquete con videos omitidos o proveedores simulados (paquetes anteriores a EV6 DoD). */
export function summaryLooksPreview(summary: any): boolean {
  if (!summary || typeof summary !== 'object') return false;
  const pending = Array.isArray(summary.pendingVideos) && summary.pendingVideos.length > 0;
  const mocks = Array.isArray(summary.mockProviderItems) ? summary.mockProviderItems.length > 0 : Number(summary.mockProviderItems) > 0;
  return pending || mocks;
}

export function isDeliverableKind(kind: PackageKind): boolean {
  return kind === 'final';
}

export interface PackageJobLike {
  id: string;
  worker_status: string;
  status?: string;
  input_payload: Record<string, any>;
  output_summary: Record<string, any>;
  error_message?: string | null;
}

export interface BuildFreshness {
  stale: boolean;
  reason?: string;
  staleItemKeys?: string[];
}

type Q = { query: (sql: string, params?: any[]) => Promise<any> };
type Log = { warn(msg: string): void } | null | undefined;

/** Último job `dynamic_package` del run (o null). */
export async function findLatestPackageJob(q: Q, runId: string): Promise<(PackageJobLike & { owner_id: string; course_id: number }) | null> {
  const [row] = await q.query(
    `select id, owner_id, course_id, worker_status, status, input_payload, output_summary, error_message
       from public.production_jobs
      where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1
      order by created_at desc, id desc
      limit 1`,
    [runId],
  );
  return row ?? null;
}

/**
 * F78-BE2: compara el job `completed` contra el build que saldría HOY del run: mismo
 * `builderVersion` y misma clave de reuse. Fuente única para el reuse de requestPackage, el
 * `stale` de getPackageStatus y `RunDto.completion.packageReady`.
 */
export async function buildPackageFreshness(q: Q, run: any, manifest: ManifestDto, existing: PackageJobLike, logger?: Log): Promise<BuildFreshness> {
  if (manifest.rulesVersion === 3) return buildFreshnessV3(q, run, manifest, existing, logger);
  const runDone = run.worker_status === 'completed' || run.status === 'completed';
  if (!runDone) {
    // Fix wave M1: activo (regenerando) ≠ terminado sin completar (p.ej. una regeneración falló).
    if (ACTIVE_RUN_WORKER_STATUSES.includes(String(run.worker_status))) {
      return { stale: true, reason: `run_in_progress: la ejecución está ${run.worker_status} (hay items regenerándose); el paquete puede no incluir su salida nueva` };
    }
    return { stale: true, reason: `run_not_completed: la ejecución terminó en ${run.worker_status} (p.ej. una regeneración falló); reintenta los items fallidos` };
  }
  const existingBuilderVersion = existing.output_summary?.builderVersion;
  if (existingBuilderVersion !== DYNAMIC_MBZ_BUILDER_VERSION) {
    return { stale: true, reason: `builder_changed: el paquete se construyó con el builder ${existingBuilderVersion ?? '?'} (actual ${DYNAMIC_MBZ_BUILDER_VERSION})` };
  }
  try {
    const byItem = await resolveRunArtifacts(q, run.id, manifest.manifest);
    const ids = sortedArtifactIds(byItem);
    // I3 (review-it2): misma clave que el worker (incluye la versión de Moodle resuelta).
    const currentHash = packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, resolveDynamicMoodleVersion().resolved);
    if (currentHash === existing.output_summary?.sourceIdsHash) return { stale: false };
    const packaged = new Set<string>(Array.isArray(existing.output_summary?.sourceArtifactIds) ? existing.output_summary.sourceArtifactIds : []);
    const staleItemKeys = [...byItem.entries()]
      .filter(([, list]) => list.some((a) => !packaged.has(a.artifactId)))
      .map(([key]) => key)
      .sort();
    if (staleItemKeys.length === 0) {
      // Fix wave M2: mismos artifacts y mismo builder → lo único que cambió es la versión de Moodle de la clave.
      return {
        stale: true,
        reason: `moodle_version_changed: el paquete se construyó para Moodle ${existing.output_summary?.moodleVersion ?? '4.1'} (actual ${resolveDynamicMoodleVersion().resolved})`,
      };
    }
    return {
      stale: true,
      reason: `sources_changed: ${staleItemKeys.length} item(s) tienen salida más nueva que el paquete (p.ej. se regeneraron después de empaquetar)`,
      staleItemKeys,
    };
  } catch (err) {
    // Si el run ya no resuelve limpio (p.ej. artifacts borrados), no se puede confirmar que sea el
    // mismo build — nunca se lo presenta como vigente.
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn(`buildFreshness: no se pudo resolver artifacts para runId=${run.id}: ${detail}`);
    return { stale: true, reason: `artifacts_unresolvable: ${detail.slice(0, 300)}` };
  }
}

/**
 * V2.1 R12: ¿el paquete v3 completado sigue siendo el vigente? Misma clave que el worker
 * (`prepareV3Package`). EV6 DoD: un run `preview` cuenta como terminado (su paquete es QA).
 */
async function buildFreshnessV3(q: Q, run: any, manifest: ManifestDto, existing: PackageJobLike, logger?: Log): Promise<BuildFreshness> {
  const runDone = isRunDone(run) || (await runIsUpgradeOnlyFailure(q, run));
  if (!runDone) {
    if (ACTIVE_RUN_WORKER_STATUSES.includes(String(run.worker_status))) {
      return { stale: true, reason: `run_in_progress: la ejecución está ${run.worker_status} (hay items regenerándose); el paquete puede no incluir su salida nueva` };
    }
    return { stale: true, reason: `run_not_completed: la ejecución terminó en ${run.worker_status} (p.ej. una regeneración falló); reintenta los items fallidos` };
  }
  const existingBuilderVersion = existing.output_summary?.builderVersion;
  if (existingBuilderVersion !== DYNAMIC_MBZ_BUILDER_VERSION_V3) {
    return { stale: true, reason: `builder_changed: el paquete se construyó con el builder ${existingBuilderVersion ?? '?'} (actual ${DYNAMIC_MBZ_BUILDER_VERSION_V3})` };
  }
  try {
    const prepared = await prepareV3Package(q, run.id, manifest, run.course_id, resolveDynamicMoodleVersion().resolved);
    if (prepared.sourceIdsHash === existing.output_summary?.sourceIdsHash) return { stale: false };
    const packaged = new Set<string>(Array.isArray(existing.output_summary?.sourceArtifactIds) ? existing.output_summary.sourceArtifactIds : []);
    const staleItemKeys = [...prepared.byItem.entries()]
      .filter(([, it]) => it.artifacts.some((a) => !packaged.has(a.artifactId)))
      .map(([key]) => key)
      .sort();
    if (staleItemKeys.length) {
      return { stale: true, reason: `sources_changed: ${staleItemKeys.length} item(s) tienen salida más nueva que el paquete`, staleItemKeys };
    }
    return {
      stale: true,
      reason: 'profile_or_theme_changed: cambió el perfil de evaluación, el tema, el renderer o la versión de Moodle desde que se armó el paquete (se re-empaqueta sin generar nada)',
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn(`buildFreshnessV3: no se pudo preparar el paquete v3 del run ${run.id}: ${detail}`);
    return { stale: true, reason: `artifacts_unresolvable: ${detail.slice(0, 300)}` };
  }
}

/**
 * EV6 DoD: ¿hay un paquete VIGENTE y ENTREGABLE (packageKind final) del run? Lo usa
 * `RunDto.completion.packageReady`. Solo lectura; nunca lanza (un error → false).
 */
export async function hasDeliverablePackage(q: Q, run: any, manifest: ManifestDto, logger?: Log): Promise<boolean> {
  try {
    const job = await findLatestPackageJob(q, run.id);
    if (!job || job.worker_status !== 'completed' || !isDeliverableKind(packageKindOf(job))) return false;
    if (!job.output_summary?.artifactId) return false;
    const fresh = await buildPackageFreshness(q, run, manifest, job, logger);
    return !fresh.stale;
  } catch (err) {
    logger?.warn(`hasDeliverablePackage(${run?.id}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
