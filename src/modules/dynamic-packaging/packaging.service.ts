import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { effectiveOutputRowsSql } from '../dynamic-generation/item-generations';
import { DataSource } from 'typeorm';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { MOCK_VIDEO_NOT_PACKAGEABLE, resolveRunArtifacts } from './artifact-resolver';
import { PackagingNotReadyError } from './packaging-types';
import { frozenVideoDeliveryOf, youtubeDeliveryProblems } from '../dynamic-generation/dynamic-video-delivery';
import { resolveDynamicMoodleVersion } from './packaging-reuse-key';
import { assertDynamicOwnerAllowed, isVideoPreviewAllowed } from '../features/dynamic-features';
import { isRealVideoOutput, prepareV3Package } from './packaging-v3';
import { VIDEO_MODE_INCONSISTENT, fallbackVideoModeOf, runIsUpgradeOnlyFailure } from '../dynamic-generation/video-upgrade';
import { MOCK_ARTIFACT_IN_REAL_RUN } from './packaging-guards';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { evaluateRunCompletion, loadCompletionInputs } from '../dynamic-generation/run-completion';
import {
  BuildFreshness,
  PackageKind,
  QA_PACKAGE_FILENAME_PREFIX,
  buildPackageFreshness,
  isDeliverableKind,
  packageKindOf,
} from './package-freshness';

export const EXECUTION_MODE = 'dynamic_package';
/** worker_status de un job de PAQUETE terminado con éxito. */
const RUN_DONE_STATUS = 'completed';
/**
 * EV6 DoD (BE-A): un run con componentes de vista previa (video o Gamma/TTS mock) no produce un
 * paquete entregable. Sin el escape de QA (DYNAMIC_ALLOW_VIDEO_PREVIEW=true) + SUPER_ADMIN → 409.
 */
export const PREVIEW_NOT_DELIVERABLE = 'preview_not_deliverable';

/** Quién pide el paquete (los paquetes QA / degradados son solo de SUPER_ADMIN). */
export interface PackageActor {
  id?: string | null;
  email?: string | null;
}
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
  /** EV6 DoD: `final` (entregable) | `qa_preview` | `degraded` (QA, nunca entregable). */
  packageKind: PackageKind;
  deliverable: boolean;
}

export interface PackageStatusResult {
  status: string;
  artifactId?: string;
  downloadUrl?: string;
  error?: string;
  /**
   * F78-BE2: ¿el paquete devuelto es el VIGENTE? Solo `true` cuando el job
   * está `completed` y su clave de reuse (builder + versión de Moodle + ids de
   * artifacts de origen) ya no coincide con la del run hoy (p.ej. un item se
   * regeneró después de empaquetar) o el run está regenerando. Un `.mbz`
   * stale sigue siendo descargable (histórico), pero la UI debe ofrecer
   * "Preparar paquete" de nuevo: POST …/package construye uno nuevo.
   */
  stale: boolean;
  /** Motivo cuando `stale` (código + frase): run_in_progress | run_not_completed | builder_changed | moodle_version_changed | sources_changed | artifacts_unresolvable. */
  staleReason?: string;
  /** Items (por key/UUID) cuya salida vigente no está en el paquete (sources_changed). */
  staleItemKeys?: string[];
  /**
   * EV6 T5 (v3): videos de vista previa que el paquete omitió (vacío = todos los videos son
   * reales). La UI muestra «Este curso contiene videos pendientes de generación…».
   */
  pendingVideos?: Array<{ itemKey: string; chapterId: string; chapterNumber: number | null }>;
  /**
   * EV6 DoD: tipo de paquete. Solo `final` es entregable al cliente; `qa_preview` (run de vista
   * previa) y `degraded` (§2.6) son paquetes de QA rotulados «QA — vista previa, no entregable».
   * Paquetes anteriores sin el campo: inferido de su resumen (videos omitidos / mocks → qa_preview).
   */
  packageKind: PackageKind;
  deliverable: boolean;
  /** Nombre sugerido para la descarga (`QA-VISTA-PREVIA-…` si no es entregable). */
  downloadFilename?: string;
  /** EV6 DoD: el curso está COMPLETO = paquete entregable, vigente y completado. */
  complete: boolean;
  /** Fix round 2 (M4): paquete QA/degradado nuevo pedido por un no admin → sin artifactId ni URL. */
  downloadRestricted?: boolean;
}

/** Fix round 2 (M4): job de paquete QA / degradado DECLARADO (los nuevos; los anteriores no tienen el campo). */
export function isAdminOnlyPackageJob(job: { input_payload?: any } | null | undefined): boolean {
  const k = job?.input_payload?.packageKind;
  return k === 'qa_preview' || k === 'degraded';
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
  async requestPackage(courseId: number, ownerId: string, blueprintNumber: number, runId: string, actor?: PackageActor): Promise<RequestPackageResult> {
    // Fix round 1 (I2): un SUPER_ADMIN pide el paquete (QA / degradado) sobre el curso de cualquier owner.
    ownerId = await this.ownerForActor(courseId, ownerId, actor);
    // G3: flag V2 + allow-list por owner (403 antes de tocar la DB).
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    const run = await this.loadRunRow(courseId, manifest, runId);
    const packageKind = await this.assertRunReady(run, manifest, actor);
    const deliverable = isDeliverableKind(packageKind);
    if (manifest.rulesVersion === 2) await this.assertV2ArtifactsResolvable(run, manifest);
    // V2.1 R12: rulesVersion 3 — artifacts completos, sin mocks en runs reales, video en YouTube y perfil
    // aplicable, TODO antes de encolar (409 con la lista). Nunca se empaqueta un v3 con las reglas v1/v2.
    if (manifest.rulesVersion === 3) await this.prepareV3OrConflict(run, manifest);

    const existing = await this.findLatestPackageJob(runId);
    // EV6 DoD: un job se reusa solo si es del MISMO tipo (un paquete QA nunca pasa por final ni al revés).
    if (existing && packageKindOf(existing) === packageKind) {
      if (IN_PROGRESS_PACKAGE_STATUSES.includes(existing.worker_status)) {
        return { jobId: existing.id, status: existing.worker_status, created: false, packageKind, deliverable };
      }
      if (existing.worker_status === RUN_DONE_STATUS) {
        const sameBuild = await this.isSameBuild(run, manifest, existing);
        if (sameBuild) {
          return { jobId: existing.id, status: existing.worker_status, created: false, packageKind, deliverable };
        }
        this.logger.log(
          `requestPackage: job ${existing.id} completado con un build distinto (builderVersion u origen de artifacts cambió) — se crea un job nuevo para runId=${runId}`,
        );
      }
      // FAILED_PACKAGE_STATUSES u otro status no contemplado: no se reusa, se crea uno nuevo.
    }

    const jobId = await this.insertPackageJob(run, manifest, blueprintNumber, runId, packageKind, actor?.id ?? null);
    return { jobId, status: 'queued', created: true, packageKind, deliverable };
  }

  /**
   * Compara el job `completed` existente contra el build actual: mismo
   * `builderVersion` (metadata del worker, I2) y mismo set ordenado de
   * artifact ids de origen (recalculado en vivo vía `resolveRunArtifacts`,
   * igual que hace el worker antes de reusar un `dynamic_mbz`).
   */
  private async isSameBuild(run: any, manifest: ManifestDto, existing: PackageJobRow): Promise<boolean> {
    return !(await this.buildFreshness(run, manifest, existing)).stale;
  }

  /**
   * F78-BE2: compara el job `completed` contra el build que saldría HOY del run (misma clave de
   * reuse que el worker). EV6 DoD: la lógica vive en package-freshness.ts (la comparte
   * RunsService para `RunDto.completion.packageReady`).
   */
  private async buildFreshness(run: any, manifest: ManifestDto, existing: PackageJobRow): Promise<BuildFreshness> {
    return buildPackageFreshness({ query: this.dataSource.query.bind(this.dataSource) }, run, manifest, existing, this.logger);
  }

  /** 409 (con la lista) si el run v3 no se puede empaquetar tal como está. */
  private async prepareV3OrConflict(run: any, manifest: ManifestDto): Promise<void> {
    try {
      await prepareV3Package({ query: this.dataSource.query.bind(this.dataSource) }, run.id, manifest, run.course_id, resolveDynamicMoodleVersion().resolved);
    } catch (err) {
      if (err instanceof PackagingNotReadyError) {
        const message =
          `La ejecución ${run.id} (rulesVersion 3) no se puede empaquetar todavía (${err.missing.length} problema(s)) ` +
          `missingJson=${JSON.stringify(err.missing)}`;
        throw new ConflictException({ message, missing: err.missing });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as any)?.code === MOCK_ARTIFACT_IN_REAL_RUN || (err as any)?.code === VIDEO_MODE_INCONSISTENT ||
        /^(ASSESSMENT_|THEME_INVALID|PROFILE_INVALID|STORAGE_PATH_INVALID)/.test(msg)) {
        throw new ConflictException({ message: msg, missing: [], code: (err as any)?.code ?? msg.split(':')[0] });
      }
      throw err;
    }
  }

  /** GET …/runs/:runId/package. */
  async getPackageStatus(courseId: number, ownerId: string, blueprintNumber: number, runId: string, actor?: PackageActor): Promise<PackageStatusResult> {
    // Fix round 1 (I2): un SUPER_ADMIN lee (y descarga) el paquete del curso de cualquier owner.
    ownerId = await this.ownerForActor(courseId, ownerId, actor);
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    const run = await this.loadRunRow(courseId, manifest, runId); // valida ownership + que el run pertenezca al curso/Manifest

    const job = await this.findLatestPackageJob(runId);
    if (!job) {
      throw new NotFoundException(`No hay ningún empaquetado iniciado para la ejecución ${runId}`);
    }

    const packageKind = packageKindOf(job);
    const deliverable = isDeliverableKind(packageKind);
    const result: PackageStatusResult = { status: job.worker_status, stale: false, packageKind, deliverable, complete: false };
    if (Array.isArray(job.output_summary?.pendingVideos)) result.pendingVideos = job.output_summary.pendingVideos;
    if (job.worker_status === 'completed') {
      const base = `${String(job.output_summary?.sourceIdsHash ?? job.id)}.mbz`;
      result.downloadFilename = deliverable ? base : `${QA_PACKAGE_FILENAME_PREFIX}${base}`;
      // F78-BE2: nunca devolver un paquete desactualizado como si fuera el vigente.
      const fresh = await this.buildFreshness(run, manifest, job);
      if (fresh.stale) {
        result.stale = true;
        result.staleReason = fresh.reason;
        if (fresh.staleItemKeys) result.staleItemKeys = fresh.staleItemKeys;
      }
      const artifactId = job.output_summary?.artifactId as string | undefined;
      // Fix round 2 (M4): un paquete QA / degradado NUEVO (declarado en el job por PackagingService) es
      // solo de SUPER_ADMIN, también para descargar. Los paquetes ya construidos antes (sin packageKind
      // declarado, p.ej. B1) siguen descargables por su dueño, sin cambios (el DTO los marca no entregables).
      if (artifactId && isAdminOnlyPackageJob(job) && !isSuperAdminEmail(actor?.email)) {
        result.downloadRestricted = true;
      } else if (artifactId) {
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
    // EV6 DoD: «curso completo» = paquete ENTREGABLE, vigente y completado de un run cuya generación
    // está completa (todo real y validado). Un paquete QA / degradado / viejo de vista previa nunca.
    if (job.worker_status === 'completed' && deliverable && !result.stale && !!result.artifactId) {
      const inputs = await loadCompletionInputs({ query: this.dataSource.query.bind(this.dataSource) }, run.id);
      result.complete = !!inputs && evaluateRunCompletion(inputs.job, inputs.rows, inputs.manifest, { ready: true }, { validationCutoffs: inputs.validationCutoffs }).complete;
    }
    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Fix round 1 (I2): dueño real del curso cuando actúa un SUPER_ADMIN; si no, el propio usuario (sin cambios). */
  private async ownerForActor(courseId: number, ownerId: string, actor?: PackageActor): Promise<string> {
    if (!isSuperAdminEmail(actor?.email)) return ownerId;
    const [c] = await this.dataSource.query(`select owner_id from public.courses where id = $1`, [courseId]);
    return c?.owner_id ? String(c.owner_id) : ownerId;
  }

  /**
   * Manifest congelado del run (input_payload.manifestId), no el "actual" de
   * DYNAMIC_MANIFEST_RULES_VERSION — mismo criterio que RunsService. Si el run
   * no existe para el curso: 404/400 del Blueprint o 404 del run, sin
   * consultar la config (fix wave review-rv2).
   */
  private async manifestOfRun(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<ManifestDto> {
    const [row] = await this.dataSource.query(
      `select input_payload->>'manifestId' as manifest_id from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2`,
      [runId, courseId],
    );
    const manifestId = Number(row?.manifest_id);
    if (!row || !Number.isInteger(manifestId)) {
      // Run inexistente para este curso: mismos 404/400 del Blueprint de
      // siempre, pero SIN leer el Manifest de la config (un run se resuelve
      // solo por su propio manifestId; la config nunca decide, fix wave
      // review-rv2) y con el 404 del run.
      await this.manifests.assertBlueprintAccessible(courseId, ownerId, blueprintNumber);
      throw new NotFoundException(`La ejecución ${runId} no existe para el Blueprint v${blueprintNumber} del curso #${courseId}`);
    }
    return this.manifests.getById(courseId, ownerId, blueprintNumber, manifestId);
  }

  /**
   * rulesVersion 2 (spec v2 §5): todo item del Manifest es obligatorio con
   * TODOS sus roles (plan, intros, Context Package de cada content). Si falta
   * cualquiera → 409 con la lista completa de keys faltantes (mismo formato
   * `missingJson=` que assertRunReady), antes de encolar el job.
   */
  private async assertV2ArtifactsResolvable(run: any, manifest: ManifestDto): Promise<void> {
    try {
      await resolveRunArtifacts({ query: this.dataSource.query.bind(this.dataSource) }, run.id, manifest.manifest);
    } catch (err) {
      if (!(err instanceof PackagingNotReadyError)) throw err;
      const message =
        `La ejecución ${run.id} (rulesVersion 2) no tiene todos los artifacts requeridos para empaquetar ` +
        `(${err.missing.length} faltante(s)) missingJson=${JSON.stringify(err.missing)}`;
      throw new ConflictException({ message, missing: err.missing });
    }
  }

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

  /**
   * 409 con `missing[]` si el run no terminó `completed` o hay items sin completar (falla fuerte,
   * spec §"Trampas"). EV6 DoD (BE-A): devuelve el TIPO de paquete que corresponde —
   * `final` (todo real), `qa_preview` (run con componentes de vista previa: solo SUPER_ADMIN y con
   * DYNAMIC_ALLOW_VIDEO_PREVIEW=true; si no 409 `preview_not_deliverable`) o `degraded` (§2.6:
   * upgrade de videos fallido, solo SUPER_ADMIN). Público para los checks.
   */
  async assertRunReady(run: any, manifest: ManifestDto, actor?: PackageActor): Promise<PackageKind> {
    // I4 (integral-review): un run con videoMode='mock' (el default en
    // staging) nunca se empaqueta — el .mbz saldría "completed" con
    // actividades url que apuntan a mock-cdn.cursia.local. Falla fuerte y
    // visible ANTES de encolar el job de empaquetado, no en el worker.
    const hasVideoItem = manifest.manifest.items.some((it) => it.type === 'video');
    const videoMode = run.input_payload?.videoMode;
    // EV6 T5: rulesVersion 3 empaqueta con los videos de vista previa OMITIDOS (prepareV3Package
    // los separa por item; nunca se presenta un video simulado como real). v1/v2: sin cambios.
    if (hasVideoItem && videoMode !== 'real' && manifest.rulesVersion !== 3) {
      throw new ConflictException({
        message: `${MOCK_VIDEO_NOT_PACKAGEABLE}: run con videos simulados: no empaquetable (videoMode=${videoMode ?? 'mock'}). Solo se empaquetan runs generados con videoMode='real'.`,
        missing: [],
      });
    }

    // M8 (fase5b-audit) + F78-BE2: MISMA selección que artifact-resolver.ts
    // (effectiveOutputRowsSql): por item, la generación completed más alta
    // (o la más alta si ninguna completó). Con regeneraciones (generation 2…)
    // el precheck y el resolver nunca divergen; sin ellas es generation = 1.
    const items: Array<{ item_key: string; status: string }> = await this.dataSource.query(
      `select gir.item_key, gir.status from ${effectiveOutputRowsSql('$1')} gir`,
      [run.id],
    );
    const statusByKey = new Map(items.map((i) => [i.item_key, i.status]));
    const missing = manifest.manifest.items
      .filter((it) => statusByKey.get(it.key) !== 'completed')
      .map((it) => it.key);

    // EV6 T5 B2 (§2.6): run terminado solo con videos del upgrade fallidos → se empaqueta (pendientes).
    // EV6 DoD: `preview` es un run terminado (todos sus items completados) — su paquete es solo QA.
    const runDone = run.worker_status === 'completed' || (manifest.rulesVersion === 3 && run.worker_status === 'preview');
    const upgradeOnlyFailure = manifest.rulesVersion === 3 && !runDone && missing.length === 0 &&
      (await runIsUpgradeOnlyFailure({ query: this.dataSource.query.bind(this.dataSource) }, run));
    if ((!runDone && !upgradeOnlyFailure) || missing.length > 0) {
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

    // DN-1: run youtube → cada video tiene que estar publicado (id + URL final
    // + delivery completed). Si no → 409 con las keys, antes de encolar nada.
    if (hasVideoItem && frozenVideoDeliveryOf(run.input_payload) === 'youtube') {
      const rows: Array<{ item_key: string; status: string; output_summary: Record<string, any> | null }> = await this.dataSource.query(
        `select gir.item_key, gir.status, gir.output_summary from ${effectiveOutputRowsSql('$1')} gir where gir.type = 'video'`,
        [run.id],
      );
      const byKey = new Map(rows.map((r) => [r.item_key, r]));
      const ytMissing = manifest.manifest.items
        .filter((it) => it.type === 'video')
        // EV6 T5: un video pendiente (vista previa) no se empaqueta → no se le exige YouTube.
        .filter((it) => manifest.rulesVersion !== 3 || isRealVideoOutput(byKey.get(it.key)?.output_summary ?? null, fallbackVideoModeOf(run.input_payload)))
        .flatMap((it) => {
          const r = byKey.get(it.key);
          return youtubeDeliveryProblems(it.key, r?.status ?? null, r?.output_summary ?? null);
        });
      if (ytMissing.length > 0) {
        const message =
          `youtube_delivery_incomplete: la ejecución ${run.id} tiene videos sin publicar en YouTube ` +
          `(${ytMissing.length} problema(s)); el paquete solo se arma con cada video publicado (Unlisted). ` +
          `missingJson=${JSON.stringify(ytMissing)}`;
        throw new ConflictException({ message, missing: ytMissing, code: 'youtube_delivery_incomplete' });
      }
    }
    if (manifest.rulesVersion !== 3) return 'final';
    return this.packageKindFor(run, manifest, upgradeOnlyFailure, actor);
  }

  /**
   * EV6 DoD (R4): ¿qué paquete se puede armar para este run v3 y quién puede pedirlo?
   * - todos los componentes reales → `final` (byte-idéntico a antes);
   * - §2.6 (upgrade de videos fallido) → `degraded`, solo SUPER_ADMIN;
   * - algún componente de vista previa (videos o Gamma/TTS mock) → `qa_preview`, solo SUPER_ADMIN
   *   con DYNAMIC_ALLOW_VIDEO_PREVIEW=true. Si no → 409 `preview_not_deliverable` (nada encolado).
   */
  private async packageKindFor(run: any, manifest: ManifestDto, upgradeOnlyFailure: boolean, actor?: PackageActor): Promise<PackageKind> {
    const inputs = await loadCompletionInputs({ query: this.dataSource.query.bind(this.dataSource) }, run.id);
    // Fix round 1 (M2/I3): sin datos para evaluar → nunca un paquete entregable (fail closed).
    if (!inputs) throw this.previewNotDeliverable(run.id, [], 'no se pudo evaluar la completitud del curso (integridad)');
    const completion = evaluateRunCompletion(inputs.job, inputs.rows, inputs.manifest, null, { upgradeOnlyFailure, validationCutoffs: inputs.validationCutoffs });
    const preview = completion.previewComponents;
    const admin = isSuperAdminEmail(actor?.email);
    if (upgradeOnlyFailure) {
      if (admin) return 'degraded';
      throw this.previewNotDeliverable(run.id, preview, 'el curso tiene videos que no se pudieron generar; el paquete con videos pendientes es solo para un administrador de Cursia');
    }
    // Fix round 1 (I3): un paquete FINAL (entregable) exige la generación COMPLETA: todo real y validado.
    if (completion.generationComplete) return 'final';
    const unvalidated = completion.missingComponents.filter((k) => !preview.includes(k));
    if (unvalidated.length === 0) {
      if (admin && isVideoPreviewAllowed()) return 'qa_preview';
      throw this.previewNotDeliverable(run.id, preview, 'el curso tiene componentes de vista previa (simulados); no se entrega un paquete sin todos sus componentes reales');
    }
    // Componentes completados SIN su validación (p.ej. filas anteriores a la validación del servidor):
    // nunca entregable; un administrador puede armar un paquete degradado rotulado QA para revisarlo.
    if (admin) return 'degraded';
    throw this.previewNotDeliverable(run.id, completion.missingComponents,
      `el curso tiene componentes sin validar (${unvalidated.length}); el paquete entregable exige todos los componentes reales y validados`);
  }

  private previewNotDeliverable(runId: string, preview: string[], why: string): ConflictException {
    const message =
      `${PREVIEW_NOT_DELIVERABLE}: ${why}. La ejecución ${runId} no se empaqueta como curso entregable ` +
      `(${preview.length} componente(s) de vista previa) missingJson=${JSON.stringify(preview)}`;
    return new ConflictException({ message, missing: preview, code: PREVIEW_NOT_DELIVERABLE });
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

  private async insertPackageJob(run: any, manifest: ManifestDto, blueprintNumber: number, runId: string, packageKind: PackageKind = 'final', requestedBy?: string | null): Promise<string> {
    // EV6 DoD: un paquete final conserva el input_payload de siempre; QA / degradado lo declaran.
    const inputPayload = { runId, manifestId: manifest.id, blueprintNumber, ...(packageKind !== 'final' ? { packageKind, ...(requestedBy ? { requestedBy } : {}) } : {}) };
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
