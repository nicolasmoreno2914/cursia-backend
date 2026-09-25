import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { resolveRunArtifacts } from './artifact-resolver';
import { sortedArtifactIds, sourceIdsHash } from './packaging-reuse-key';
import { DYNAMIC_MBZ_BUILDER_VERSION } from '../../package/dynamic-mbz-builder';

export const EXECUTION_MODE = 'dynamic_package';
/** worker_status del job de run (dynamic_generation) que cuentan como "terminado con éxito". */
const RUN_DONE_STATUS = 'completed';
/** worker_status del job de package en curso — una segunda POST reutiliza el mismo job sin crear otro. */
const IN_PROGRESS_PACKAGE_STATUSES = ['queued', 'running', 'retrying'];
// worker_status terminal-fallido ('failed', 'failed_retryable', 'cancelled') y cualquier otro
// status no contemplado caen al `else` implícito de requestPackage: nunca se reusan, siempre
// se permite un job nuevo (I2/I3, integral-review) — no necesitan una constante propia.

// M2 (fase5b-audit integral-review.md): TTL de la signed URL de descarga del
// .mbz, configurable por env var — el default (300s) no cambia si no se setea.
function resolveDownloadUrlTtlSeconds(): number {
  const raw = Number(process.env.DYNAMIC_PACKAGE_DOWNLOAD_URL_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
}
const DOWNLOAD_URL_TTL_SECONDS = resolveDownloadUrlTtlSeconds();

export interface PackageJobRow {
  id: string;
  owner_id: string;
  course_id: number;
  worker_status: string;
  status: string;
  input_payload: Record<string, any>;
  output_summary: Record<string, any>;
  error_message: string | null;
}

export interface RequestPackageResult {
  jobId: string;
  status: string;
  created: boolean;
}

export interface PackageStatusResult {
  status: string;
  artifactId?: string;
  downloadUrl?: string;
  error?: string;
}

/**
 * Empaquetado dinámico (Fase 5B.1, bloque B3): crea/reusa el job
 * `dynamic_package` que produce el `.mbz` de un run 5A completado, y expone
 * su estado + descarga. Ejecuta el build real `dynamic-package-worker.ts`
 * (Task/worker separado) — este servicio SOLO valida, encola y lee estado,
 * igual que `RunsService` no ejecuta items (los ejecuta
 * `dynamic-item-worker.ts`).
 *
 * Ownership + `dynamic` + existencia del Manifest se delegan siempre en
 * `GenerationManifestsService.get` (404 ajeno/inexistente, 400 legacy) —
 * mismo patrón que `RunsController`/`RunsService`.
 */
@Injectable()
export class PackagingService {
  private readonly logger = new Logger(PackagingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
    private readonly artifacts: ArtifactsService,
  ) {}

  /**
   * POST …/runs/:runId/package. 404/400 vía manifests.get; 404 si el runId no
   * pertenece a este Manifest/curso; 409 con `missing[]` si el run no está
   * `completed` o le faltan items; si no, get-or-create del job
   * `dynamic_package`.
   *
   * Idempotencia (I2/I3, integral-review):
   * - Un job `queued`/`running`/`retrying` se reusa siempre (evita duplicar
   *   trabajo en curso).
   * - Un job `completed` se reusa SOLO si se construyó con el mismo
   *   `DYNAMIC_MBZ_BUILDER_VERSION` actual y el mismo set de artifacts de
   *   origen — si un fix cambió el builder, o el run se volvió a generar,
   *   se crea un job nuevo en vez de devolver el `.mbz` viejo para siempre.
   * - Un job `failed`/`failed_retryable`/`cancelled` NUNCA se reusa — un job
   *   huérfano o fallido no debe bloquear un reintento.
   */
  async requestPackage(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RequestPackageResult> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const run = await this.loadRunRow(courseId, manifest, runId);
    await this.assertRunReady(run, manifest);

    const existing = await this.findLatestPackageJob(runId);
    if (existing) {
      if (IN_PROGRESS_PACKAGE_STATUSES.includes(existing.worker_status)) {
        return { jobId: existing.id, status: existing.worker_status, created: false };
      }
      if (existing.worker_status === RUN_DONE_STATUS) {
        const sameBuild = await this.isSameBuild(run, manifest, existing);
        if (sameBuild) {
          return { jobId: existing.id, status: existing.worker_status, created: false };
        }
        this.logger.log(
          `requestPackage: job ${existing.id} completado con un build distinto (builderVersion u origen de artifacts cambió) — se crea un job nuevo para runId=${runId}`,
        );
      }
      // FAILED_PACKAGE_STATUSES u otro status no contemplado: no se reusa, se crea uno nuevo.
    }

    const jobId = await this.insertPackageJob(run, manifest, blueprintNumber, runId);
    return { jobId, status: 'queued', created: true };
  }

  /**
   * Compara el job `completed` existente contra el build actual: mismo
   * `builderVersion` (metadata del worker, I2) y mismo set ordenado de
   * artifact ids de origen (recalculado en vivo vía `resolveRunArtifacts`,
   * igual que hace el worker antes de reusar un `dynamic_mbz`).
   */
  private async isSameBuild(run: any, manifest: ManifestDto, existing: PackageJobRow): Promise<boolean> {
    const existingBuilderVersion = existing.output_summary?.builderVersion;
    if (existingBuilderVersion !== DYNAMIC_MBZ_BUILDER_VERSION) return false;
    try {
      const byItem = await resolveRunArtifacts({ query: this.dataSource.query.bind(this.dataSource) }, run.id, manifest.manifest);
      const ids = sortedArtifactIds(byItem);
      const currentHash = sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ids);
      return currentHash === existing.output_summary?.sourceIdsHash;
    } catch (err) {
      // Si el run ya no resuelve limpio (p.ej. artifacts borrados), no se
      // puede confirmar que sea el mismo build — más seguro crear uno nuevo
      // que reusar a ciegas.
      this.logger.warn(`isSameBuild: no se pudo resolver artifacts para runId=${run.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** GET …/runs/:runId/package. */
  async getPackageStatus(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<PackageStatusResult> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    await this.loadRunRow(courseId, manifest, runId); // valida ownership + que el run pertenezca al curso/Manifest

    const job = await this.findLatestPackageJob(runId);
    if (!job) {
      throw new NotFoundException(`No hay ningún empaquetado iniciado para la ejecución ${runId}`);
    }

    const result: PackageStatusResult = { status: job.worker_status };
    if (job.worker_status === 'completed') {
      const artifactId = job.output_summary?.artifactId as string | undefined;
      if (artifactId) {
        result.artifactId = artifactId;
        try {
          const { url } = await this.artifacts.getDownloadUrl(artifactId, ownerId, DOWNLOAD_URL_TTL_SECONDS);
          if (url) {
            result.downloadUrl = url;
          } else {
            // M2 (fase5b-audit integral-review.md): antes se dejaba
            // downloadUrl sin definir y no se tocaba result.error — el
            // llamador no podía distinguir "sin URL porque el signing falló"
            // de "sin URL porque el job no completó". Ahora es explícito.
            result.error = 'El artifact está listo pero no se pudo generar su URL de descarga (respuesta vacía del signer).';
            this.logger.warn(`getDownloadUrl(${artifactId}) devolvió una url vacía`);
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.warn(`No se pudo firmar la URL de descarga del artifact ${artifactId}: ${detail}`);
          result.error = `No se pudo firmar la URL de descarga del artifact (${detail})`;
        }
      }
    }
    // El error_message del job (si lo hay) tiene prioridad sobre un fallo de
    // signing — un job fallido es un problema más grave que no poder firmar
    // la URL de un job completado.
    if (job.error_message) result.error = job.error_message;
    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async loadRunRow(courseId: number, manifest: ManifestDto, runId: string): Promise<any> {
    const [row] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation'
          and course_id = $2 and input_payload->>'manifestId' = $3`,
      [runId, courseId, String(manifest.id)],
    );
    if (!row) {
      throw new NotFoundException(
        `La ejecución ${runId} no existe para el Manifest del Blueprint v${manifest.blueprintNumber} del curso #${courseId}`,
      );
    }
    return row;
  }

  /** 409 con `missing[]` si el run no terminó `completed` o hay items sin completar (falla fuerte, spec §"Trampas"). */
  private async assertRunReady(run: any, manifest: ManifestDto): Promise<void> {
    // I4 (integral-review): un run con videoMode='mock' (el default en
    // staging) nunca se empaqueta — el .mbz saldría "completed" con
    // actividades url que apuntan a mock-cdn.cursia.local. Falla fuerte y
    // visible ANTES de encolar el job de empaquetado, no en el worker.
    const hasVideoItem = manifest.manifest.items.some((it) => it.type === 'video');
    const videoMode = run.input_payload?.videoMode;
    if (hasVideoItem && videoMode !== 'real') {
      throw new ConflictException({
        message: `run con videos simulados: no empaquetable (videoMode=${videoMode ?? 'mock'}). Solo se empaquetan runs generados con videoMode='real'.`,
        missing: [],
      });
    }

    // M8 (fase5b-audit integral-review.md): filtrar generation = 1, igual
    // que artifact-resolver.ts — hoy es un no-op porque 5A solo siembra
    // generation 1, pero sin esto este precheck divergiría del resolver en
    // cuanto existan regeneraciones (Fase 8).
    const items: Array<{ item_key: string; status: string }> = await this.dataSource.query(
      `select item_key, status from public.generation_item_runs where job_id = $1 and generation = 1`,
      [run.id],
    );
    const statusByKey = new Map(items.map((i) => [i.item_key, i.status]));
    const missing = manifest.manifest.items
      .filter((it) => statusByKey.get(it.key) !== 'completed')
      .map((it) => it.key);

    if (run.worker_status !== RUN_DONE_STATUS || missing.length > 0) {
      // El filtro global de excepciones (AllExceptionsFilter) aplana
      // `exception.getResponse()` a un string (`error: message.message`) y
      // descarta cualquier otro campo — así que `missing` viaja también
      // serializado dentro del propio mensaje (mismo truco que RunsService
      // usa para "runId=<uuid>" en sus 409). El body estructurado
      // ({message, missing}) queda además disponible para quien llame al
      // servicio directamente (tests) o a un cliente HTTP que sí lea el
      // JSON crudo sin pasar por ese filtro.
      const message =
        `La ejecución ${run.id} no está lista para empaquetar (worker_status=${run.worker_status}, ` +
        `${missing.length} item(s) sin completar) missingJson=${JSON.stringify(missing)}`;
      throw new ConflictException({ message, missing });
    }
  }

  private async findLatestPackageJob(runId: string): Promise<PackageJobRow | null> {
    const [row] = await this.dataSource.query(
      `select id, owner_id, course_id, worker_status, status, input_payload, output_summary, error_message
         from public.production_jobs
        where execution_mode = $1 and input_payload->>'runId' = $2
        order by created_at desc, id desc
        limit 1`,
      [EXECUTION_MODE, runId],
    );
    return row ?? null;
  }

  private async insertPackageJob(run: any, manifest: ManifestDto, blueprintNumber: number, runId: string): Promise<string> {
    const inputPayload = { runId, manifestId: manifest.id, blueprintNumber };
    const [job] = await this.dataSource.query(
      `insert into public.production_jobs
         (owner_id, course_id, frontend_course_id, execution_mode, status, worker_status, current_step,
          progress, blueprint_version_id, input_payload, output_summary, options, result,
          lease_until, worker_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'queued', 'queued', 'dynamic_package',
               0, $5, $6::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               null, null, now(), now())
       returning id`,
      [run.owner_id, run.course_id, run.frontend_course_id ?? null, EXECUTION_MODE, manifest.blueprintId, JSON.stringify(inputPayload)],
    );
    if (!job?.id) {
      throw new InternalServerErrorException(`No se pudo crear el job de empaquetado para la ejecución ${runId}`);
    }
    return job.id;
  }
}
