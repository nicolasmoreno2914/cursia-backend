import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import { ArtifactsService } from '../artifacts/artifacts.service';

export const EXECUTION_MODE = 'dynamic_package';
/** worker_status del job de run (dynamic_generation) que cuentan como "terminado con éxito". */
const RUN_DONE_STATUS = 'completed';
/** worker_status del job de package que se consideran "vivos" (una segunda POST los reutiliza). */
const ALIVE_PACKAGE_STATUSES = ['queued', 'running', 'retrying', 'completed'];

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
   * `dynamic_package` (idempotente: una segunda POST devuelve el mismo job
   * mientras siga vivo).
   */
  async requestPackage(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RequestPackageResult> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const run = await this.loadRunRow(courseId, manifest, runId);
    await this.assertRunReady(run, manifest);

    const existing = await this.findLatestPackageJob(runId);
    if (existing && ALIVE_PACKAGE_STATUSES.includes(existing.worker_status)) {
      return { jobId: existing.id, status: existing.worker_status, created: false };
    }

    const jobId = await this.insertPackageJob(run, manifest, blueprintNumber, runId);
    return { jobId, status: 'queued', created: true };
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
          const { url } = await this.artifacts.getDownloadUrl(artifactId, ownerId, 300);
          if (url) result.downloadUrl = url;
        } catch (err) {
          this.logger.warn(`No se pudo firmar la URL de descarga del artifact ${artifactId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
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
    const items: Array<{ item_key: string; status: string }> = await this.dataSource.query(
      `select item_key, status from public.generation_item_runs where job_id = $1`,
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
