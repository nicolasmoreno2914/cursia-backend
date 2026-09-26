import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import {
  AnyBlueprintSnapshot,
  BlueprintSnapshotV1,
  RawChapterRow,
  RawModuleRow,
  buildBlueprintSnapshot,
  recanonicalizeBlueprintSnapshotV2,
  snapshotSha256,
  snapshotSha256V2,
} from '../course-blueprints/blueprint-snapshot';
import {
  ALL_MANIFEST_ITEM_TYPES,
  GenerationManifestV1,
  ManifestItemType,
  V3_ONLY_ITEM_TYPES,
  canonicalManifestJson,
  manifestSha256,
  validateGenerationManifest,
} from '../generation-manifests/generation-manifest-builder';
import { requiredArtifactTypes, requiredArtifactTypesV3 } from '../dynamic-packaging/artifact-resolver';
import { RunsService } from './runs.service';
import { canonicalContextHash, sortKeysDeep } from './run-hash';
import {
  ACTIVE_RUN_WORKER_STATUSES,
  applyItemFailure,
  blockDependents,
  isActiveRun,
  isCancelledLike,
  markRunRunning,
  recomputeRunStatus,
  sweepRunExpiredLeases,
} from './item-transitions';
import { latestGenerationPredicate } from './item-generations';
import { artifactOutputIdentity } from '../invalidation/invalidation-apply';
import {
  FINAL_EXAM_QUESTION_RANGE,
  H5pActivityType,
  V3_PAYLOAD_INVALID,
  VideoClaimFacts,
  activityTypeForChapter,
  v3ValidatedArtifactType,
  v3ValidationErrorMessage,
  validateV3ItemArtifact,
  videoClaimFacts,
} from '../course-shell';
import { V3_ARTIFACT_TEXT_READER, V3ArtifactTextReader } from './v3-artifact-reader';

export type ItemType = ManifestItemType;

/** content/scorm/video/exam (v1) + course_plan/course_intro/module_intro (rulesVersion 2). */
const ALL_ITEM_TYPES: readonly ItemType[] = ALL_MANIFEST_ITEM_TYPES;
export const MIN_LEASE_SECONDS = 15;
export const MAX_LEASE_SECONDS = 3600;
export const DEFAULT_LEASE_SECONDS = 120;
const MAX_ERROR_LENGTH = 4000;
const MAX_EXECUTOR_ID_LENGTH = 200;
/**
 * Reintentos del claim global SOLO por carreras (candidato elegido sin lock
 * que otro tomó antes de bloquear su run). No limita cuántos runs se miran:
 * el candidato se elige entre TODOS los runs elegibles en una sola consulta.
 */
const GLOBAL_CLAIM_RACE_RETRIES = 50;
/**
 * Tipos que puede reclamar el camino navegador (ownerId); video solo el worker.
 * rulesVersion 2 (spec v2 §3): course_plan, course_intro y module_intro son
 * items LLM del ejecutor del navegador, igual que content/scorm/exam.
 */
export const BROWSER_CLAIMABLE_TYPES: ItemType[] = [
  'content', 'scorm', 'exam', 'course_plan', 'course_intro', 'module_intro',
  // V2.1 rulesVersion 3 (R4): items LLM del ejecutor del navegador (activity en sus dos variantes).
  'experience', 'video_interactions', 'activity', 'final_exam',
];
/**
 * V2.1 rulesVersion 3 (R4): items de PROVEEDOR que solo reclama el worker del
 * backend (nunca el navegador): video (Videogen, dynamic-item-worker, como
 * siempre), presentation (Gamma) y audio_welcome / audiobook_chapter (TTS),
 * estos tres en dynamic-provider-worker.
 */
export const WORKER_ONLY_TYPES: readonly ItemType[] = ['video', 'presentation', 'audio_welcome', 'audiobook_chapter'];
/** Tipos v3 que reclama el camino navegador (un claim con alguno = ejecutor v3). */
const V3_BROWSER_ITEM_TYPES: readonly ItemType[] = V3_ONLY_ITEM_TYPES.filter((t) => BROWSER_CLAIMABLE_TYPES.includes(t));
/** Tipos que solo existen en Manifests rulesVersion 2 (M3: un claim del navegador sin ninguno = ejecutor v1-only). */
const V2_ONLY_ITEM_TYPES: readonly ItemType[] = ['course_plan', 'course_intro', 'module_intro'];

/**
 * Predicado de "item reclamable" (spec §3.4, condición 6, R16), compartido
 * por el claim por run y el global. `typesParam` = placeholder del array de
 * tipos. Dependencias literales del Manifest, resueltas contra la generación
 * VIGENTE (la más alta) de cada clave dentro del mismo run (F78-BE2: una
 * regeneración, generation 2, depende de los items vigentes del run; sin
 * regeneraciones es idéntico a "misma generation"):
 * - ninguna dependencia vigente en estado distinto de `completed`
 *   (NOT EXISTS literal por clave);
 * - y TODAS las claves de depends_on existen como fila: una dependencia
 *   ausente nunca vuelve reclamable al dependiente (se reporta con
 *   logger.error vía reportMissingDependencies).
 */
function claimablePredicate(g: string, typesParam: string): string {
  return `${g}.status in ('pending', 'retrying')
            and (${g}.next_retry_at is null or ${g}.next_retry_at <= now())
            and (${g}.lease_until is null or ${g}.lease_until < now())
            and ${g}.type = any(${typesParam}::text[])
            and not exists (
              select 1 from public.generation_item_runs d
               where d.job_id = ${g}.job_id and d.manifest_id = ${g}.manifest_id
                 and d.item_key = any(${g}.depends_on) and d.status <> 'completed'
                 and ${latestGenerationPredicate('d')})
            and not exists (
              select 1 from unnest(${g}.depends_on) as dk(key)
               where not exists (
                 select 1 from public.generation_item_runs d2
                  where d2.job_id = ${g}.job_id and d2.manifest_id = ${g}.manifest_id
                    and d2.item_key = dk.key))`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaimedItem {
  itemRunId: string;
  runId: string;
  courseId: number;
  /** courses.metadata.courseId congelado en el run (puede ser null). */
  frontendCourseId: string | null;
  /**
   * Valor que el ejecutor debe usar como `artifacts.course_id` al subir los
   * artifacts de este item (R4: el id de frontend; si el curso no tiene,
   * el id numérico como texto). completeItem solo vincula artifacts con este
   * course_id.
   */
  artifactCourseId: string;
  manifestId: number;
  blueprintId: number;
  blueprintNumber: number;
  itemKey: string;
  type: ItemType;
  /** rulesVersion del Manifest del item (contrato R2: el ejecutor despacha por esto). */
  rulesVersion: number;
  /** V2.1 (R4): solo en items `activity` de rulesVersion 3 — 'h5p' | 'scorm' (course.activityEngine congelado). */
  variant?: 'h5p' | 'scorm';
  /** null solo en items de scope course (rulesVersion 2: course_plan, course_intro). */
  moduleId: string | null;
  chapterId: string | null;
  /** null solo en items de scope course. */
  moduleNumber: number | null;
  chapterNumber: number | null;
  idempotencyKey: string;
  generation: number;
  dependsOn: string[];
  attempt: number;
  outputSummary: Record<string, any>;
  context: { courseContext: Record<string, any>; contextHash: string };
  blueprint: {
    course: { id: number; title: string };
    /** null solo en items de scope course (rulesVersion 2). */
    module: { id: string; title: string; objective: string | null; position: number } | null;
    chapter: { id: string; title: string; objective: string | null; position: number; videoEnabled: boolean } | null;
    /**
     * Capítulos del módulo del item, en orden del Manifest (para exam:
     * exactamente los que evalúa). Vacío en items de scope course.
     */
    moduleChapters: Array<{ id: string; title: string; objective: string | null; chapterNumber: number }>;
    /**
     * R18: outline del curso COMPLETO (todos los módulos, en orden del
     * Manifest), con numeración global — para que los builders dynamic
     * puedan reproducir la línea "Estructura: N módulos · M capítulos" +
     * listado por módulo/capítulo de `ctx()` legacy sin leer la estructura
     * viva (condición 1: se arma acá, del snapshot congelado del Blueprint +
     * numeración del Manifest, igual que `moduleChapters`).
     */
    outline: Array<{
      moduleNumber: number;
      id: string;
      title: string;
      /**
       * Objetivo del snapshot congelado (null si no tiene). Contrato R2 punto
       * 5: el plan de conceptos y el Context Package lo usan; los prompts v1
       * no lo leen (sin cambio de comportamiento en v1).
       */
      objective: string | null;
      chapters: Array<{ chapterNumber: number; id: string; title: string; objective: string | null }>;
    }>;
  };
  dependencyArtifacts: Array<{ itemKey: string; artifactId: string; type: string; storagePath: string }>;
  /**
   * V2.1 R11a: `claimPayload`, solo items de rulesVersion 3 validados por el
   * servidor (nombres alineados con `_dynClaimField` del ejecutor R11b). Dice
   * qué artifact se valida al completar y trae los datos que el ejecutor NO
   * decide: tipo H5P de la rotación (activity h5p), plan de checkpoints +
   * youtubeId/duración medida del video (video_interactions), rango de
   * preguntas (final_exam), capítulos exactos del journey (module_intro).
   * Las salidas de las dependencias (content md + Context Package, video…)
   * siguen llegando en `dependencyArtifacts`, como en v2.
   */
  claimPayload?: ClaimPayloadV3;
}

export interface ClaimPayloadV3 {
  /** Artifact cuyo contenido valida el servidor al completar (null = solo roles). */
  validatedArtifactType: string | null;
  activityType?: H5pActivityType;
  video?: VideoClaimFacts;
  finalExam?: { minQuestions: number; maxQuestions: number };
  moduleChapterIds?: string[];
  chapterId?: string;
}

/**
 * V2.1 R11a: el payload de un item v3 no se puede armar por un dato de su
 * dependencia (p.ej. video sin youtubeId o sin duración medida). El claim lo
 * marca `failed` (no reintentable: reintentar no cambia el dato) en la misma
 * transacción, en vez de entregar un item sin datos o reintentarlo en bucle.
 */
class ClaimPayloadUnavailable extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export interface ClaimOptions {
  runId?: string;
  executorId: string;
  types: ItemType[];
  leaseSeconds: number;
  /** Presente → camino navegador: solo runs de ese dueño. Ausente → worker interno. */
  ownerId?: string;
}

/** Resultado de una operación sobre un item reclamado (el endpoint lo devuelve tal cual, 200). */
export interface ItemOpResult {
  ok: boolean;
  reason?: string;
  /** V2.1 R11a: códigos del validador server-side (reason = v3_payload_invalid). */
  errors?: string[];
}

/** Rechazo de guard dentro de una transacción: provoca rollback y se devuelve como {ok:false, reason}. */
class GuardRejection extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameJson(a: any, b: any): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

/**
 * Merge top-level de `patch` sobre `existing` (output_summary). La clave
 * `external` (ids de proveedores externos, R3/R15) nunca se sobreescribe con
 * un valor distinto: si ambos son objetos se permite AGREGAR claves nuevas
 * (p.ej. batchId y luego videoId) pero no cambiar una existente; si no son
 * objetos deben ser iguales.
 */
export function mergeOutputSummary(
  existing: Record<string, any>,
  patch: Record<string, any>,
): { ok: true; merged: Record<string, any> } | { ok: false; reason: string } {
  const merged = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    if (k === 'external' && existing && existing.external !== undefined && existing.external !== null) {
      const cur = existing.external;
      if (isPlainObject(cur) && isPlainObject(v)) {
        for (const [ek, ev] of Object.entries(v)) {
          if (ek in cur && !sameJson(cur[ek], ev)) return { ok: false, reason: 'external_conflict' };
        }
        merged.external = { ...cur, ...v };
        continue;
      }
      if (!sameJson(cur, v)) return { ok: false, reason: 'external_conflict' };
      continue;
    }
    merged[k] = v;
  }
  return { ok: true, merged: JSON.parse(JSON.stringify(merged)) };
}

/**
 * Scheduler por item de la generación dinámica (Fase 5A, Task 3; spec
 * §3.3–§3.9, §7 condiciones 1–6; rulings R2, R3, R12–R15).
 *
 * - Claim: por run, UNA transacción: fila del run FOR UPDATE (mismo orden
 *   de locks que cancel/retry/reopen de Task 2 → sin deadlocks), barrido de
 *   leases vencidos del run, y selección FOR UPDATE SKIP LOCKED de un item
 *   pending/retrying con backoff vencido, tipo permitido y TODAS sus
 *   dependencias (depends_on literal del Manifest, mismo manifest_id +
 *   generation) en `completed`. Orden: created_at, luego posición del item
 *   en manifest_json.items (orden del Manifest; la siembra inserta todo en
 *   una sola sentencia, así que created_at empata dentro de un run), luego id.
 *   Los claims concurrentes sobre el mismo run se serializan en el lock del
 *   run (cada uno toma un item distinto); el claim global (worker, sin runId)
 *   elige el item candidato entre TODOS los runs elegibles sin tomar locks y
 *   luego lo re-selecciona bajo el lock de su run (siempre run → item, R16).
 * - El payload (ClaimedItem) se arma DENTRO de la transacción del claim desde
 *   el backend: contexto congelado (generation_run_contexts, hash
 *   verificado), porción del snapshot del Blueprint leída por
 *   (blueprint_id, course_id) y re-verificada (R2, sin métodos de Fase 3
 *   con owner), numeración del Manifest (hash verificado) y artifacts
 *   vinculados de las dependencias. Si algo no verifica → 500 y el claim se
 *   deshace (nunca se entrega un item con datos no verificados).
 * - complete/fail/heartbeat/recordExternal (R14): exigen status='running',
 *   worker_id = executorId y run no cancelado; si no → {ok:false, reason}.
 * - Tras complete/fail/sweep se recalcula el estado del run (R12).
 *
 * `ownerId` presente = camino navegador (JWT): todo se restringe a runs de
 * ese dueño. Ausente = worker interno.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly runs: RunsService,
    /** V2.1 R11a: lector de artifacts para validar items LLM v3 (ausente → un item v3 validable no se completa). */
    @Optional() @Inject(V3_ARTIFACT_TEXT_READER) private readonly v3Reader?: V3ArtifactTextReader,
  ) {}

  // ── claim ────────────────────────────────────────────────────────────────

  async claimNextItem(opts: ClaimOptions): Promise<ClaimedItem | null> {
    const executorId = this.checkExecutorId(opts.executorId);
    const types = this.checkTypes(opts.types);
    const leaseSeconds = this.clampLease(opts.leaseSeconds);
    if (opts.ownerId !== undefined && opts.ownerId !== null) {
      // Defensa en profundidad (R16): el camino navegador (ownerId) nunca
      // reclama tipos fuera de content/scorm/exam, aunque el DTO lo deje pasar.
      const bad = types.filter((t) => !BROWSER_CLAIMABLE_TYPES.includes(t));
      if (bad.length > 0) {
        throw new BadRequestException(`browser_type_not_allowed: el navegador no puede reclamar items ${bad.join(', ')}`);
      }
    }

    if (opts.runId) {
      if (!UUID_RE.test(opts.runId)) throw new BadRequestException('runId inválido');
      if (opts.ownerId !== undefined && opts.ownerId !== null) {
        await this.assertBrowserTypesMatchRun(opts.runId, opts.ownerId, types);
      }
      // M6: un item cuyo payload no se puede armar se marca failed dentro del
      // claim; se sigue con el próximo candidato en vez de devolver "nada".
      for (let attempt = 0; attempt < GLOBAL_CLAIM_RACE_RETRIES; attempt++) {
        const r = await this.claimInRun(opts.runId, executorId, types, leaseSeconds, opts.ownerId);
        if (r.item) return r.item;
        if (!r.unavailable) break;
      }
      await this.reportMissingDependencies(opts.runId, opts.ownerId);
      return null;
    }

    // Global (worker, R16). Orden de locks: el candidato se ELIGE sin tomar
    // ningún lock (lectura simple sobre TODOS los runs elegibles, mismo
    // predicado que el claim por run, sin tope de runs); después
    // claimInRun bloquea la fila del run (FOR UPDATE) y re-selecciona ESE item
    // con el predicado completo FOR UPDATE SKIP LOCKED — siempre run → item,
    // igual que cancel/retry/reopen. Si el item se esfumó (lo tomó otro, se
    // canceló el run…) se prueba el siguiente candidato. Los reintentos solo
    // se consumen en carreras; al agotarlos se registra un warn (nunca un
    // null silencioso por "demasiados runs").
    await this.sweepExpiredLeases();
    const tried: string[] = [];
    for (let attempt = 0; attempt < GLOBAL_CLAIM_RACE_RETRIES; attempt++) {
      const [cand] = await this.dataSource.query(
        `select g.id, g.job_id
           from public.generation_item_runs g
           join public.production_jobs pj on pj.id = g.job_id
           join public.course_generation_manifests m on m.id = g.manifest_id
           left join lateral (
             select e.ord
               from jsonb_array_elements(m.manifest_json->'items') with ordinality as e(it, ord)
              where e.it->>'key' = g.item_key
              limit 1
           ) mo on true
          where pj.execution_mode = 'dynamic_generation'
            and pj.worker_status = any($1::text[])
            and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
            and ($2::text is null or pj.owner_id = $2)
            and not (g.id = any($3::uuid[]))
            and ${claimablePredicate('g', '$4')}
          order by g.created_at, mo.ord nulls last, g.id
          limit 1`,
        [ACTIVE_RUN_WORKER_STATUSES, opts.ownerId ?? null, tried, types],
      );
      if (!cand) {
        await this.reportMissingDependencies(null, opts.ownerId);
        return null;
      }
      tried.push(cand.id);
      const { item } = await this.claimInRun(cand.job_id, executorId, types, leaseSeconds, opts.ownerId, cand.id);
      if (item) return item;
    }
    this.logger.warn(
      `claim global: ${GLOBAL_CLAIM_RACE_RETRIES} candidatos seguidos se esfumaron por carreras ` +
        `(executor ${executorId}, tipos ${types.join(',')}); se devuelve null y el próximo poll reintenta`,
    );
    return null;
  }

  /**
   * Claim dentro de UN run, en una transacción: fila del run FOR UPDATE →
   * barrido de leases del run → item FOR UPDATE SKIP LOCKED con el predicado
   * completo (si `itemId` viene del claim global, solo ese item).
   */
  private async claimInRun(
    runId: string,
    executorId: string,
    types: ItemType[],
    leaseSeconds: number,
    ownerId?: string,
    itemId?: string,
  ): Promise<{ item: ClaimedItem | null; unavailable: boolean }> {
    let cancelledJob: any = null;
    let unavailable: string | null = null;
    const claimed = await this.runs.tx(async (qr) => {
      const job = await this.lockRun(qr, runId, ownerId, 'update');
      if (!job) return null;
      if (isCancelledLike(job)) {
        cancelledJob = job;
        return null;
      }
      if (!isActiveRun(job)) return null;

      if ((await sweepRunExpiredLeases(qr, job.id)) > 0) {
        await recomputeRunStatus(qr, job.id);
      }

      const [cand] = await qr.query(
        `select g.id
           from public.generation_item_runs g
           join public.course_generation_manifests m on m.id = g.manifest_id
           left join lateral (
             select e.ord
               from jsonb_array_elements(m.manifest_json->'items') with ordinality as e(it, ord)
              where e.it->>'key' = g.item_key
              limit 1
           ) mo on true
          where g.job_id = $1
            and ($3::uuid is null or g.id = $3)
            and ${claimablePredicate('g', '$2')}
          order by g.created_at, mo.ord nulls last, g.id
          limit 1
          for update of g skip locked`,
        [job.id, types, itemId ?? null],
      );
      if (!cand) return null;

      const [row] = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'running', worker_id = $2, claimed_at = now(),
                  lease_until = now() + make_interval(secs => $3::int),
                  attempt_count = attempt_count + 1, next_retry_at = null, updated_at = now()
            where id = $1 and status in ('pending', 'retrying')
            returning *`,
          [cand.id, executorId, leaseSeconds],
        ),
      );
      if (!row) throw new InternalServerErrorException(`No se pudo reclamar el item ${cand.id} (fila no actualizada)`);
      await markRunRunning(qr, job.id);
      try {
        return await this.buildClaimedItem(qr, job, row);
      } catch (err) {
        if (!(err instanceof ClaimPayloadUnavailable)) throw err;
        await applyItemFailure(qr, row.id, `claim_payload_unavailable: ${err.message}`.slice(0, MAX_ERROR_LENGTH), false);
        await recomputeRunStatus(qr, job.id);
        unavailable = `${row.item_key}: ${err.message}`;
        return null;
      }
    });
    if (unavailable) {
      this.logger.error(`Item ${unavailable} — marcado failed en el claim (dato de una dependencia ausente; no se inventa)`);
    }
    if (cancelledJob) await this.runs.reconcileCancellation(cancelledJob);
    return { item: claimed, unavailable: unavailable !== null };
  }

  /**
   * M3 (review-rv2): un ejecutor del navegador que solo conoce tipos v1
   * (frontend viejo en caché, o uno que no pudo leer el rulesVersion del run)
   * reclamando un run rulesVersion 2 nunca encontraría nada reclamable
   * (content depende de course_plan) y el run quedaría estancado SIN error.
   * Se rechaza con 409 `rules_version_mismatch` (mensaje visible en la UI /
   * consola) en vez de devolver `null` en silencio. Solo el camino navegador
   * (ownerId): el worker interno reclama `video` y no se ve afectado.
   */
  private async assertBrowserTypesMatchRun(runId: string, ownerId: string, types: ItemType[]): Promise<void> {
    // V2.1 (R4): un ejecutor v3 (reclama algún tipo v3) no se restringe acá.
    if (types.some((t) => V3_BROWSER_ITEM_TYPES.includes(t))) return;
    const claimsV2 = types.some((t) => V2_ONLY_ITEM_TYPES.includes(t));
    const [row] = await this.dataSource.query(
      `select m.rules_version
         from public.production_jobs pj
         join public.course_generation_manifests m on m.id::text = pj.input_payload->>'manifestId'
        where pj.id = $1 and pj.execution_mode = 'dynamic_generation' and pj.owner_id = $2`,
      [runId, ownerId],
    );
    const rulesVersion = row ? Number(row.rules_version) : null;
    // R4: un ejecutor v1/v2 sobre un run v3 nunca reclamaría experience/activity/…
    // (el run quedaría estancado sin error) → mismo 409 rules_version_mismatch.
    if (rulesVersion === 3) {
      const message =
        `rules_version_mismatch: la ejecución ${runId} es rulesVersion=3 (V2.1: experiencias, actividades, ` +
        `presentaciones y audio) y este ejecutor no reclama tipos de rulesVersion 3 (${types.join(', ')}). ` +
        'Recargá la página para usar el generador actualizado; con este ejecutor el curso no avanzaría.';
      throw new ConflictException({ message, code: 'rules_version_mismatch', rulesVersion, runId });
    }
    if (claimsV2) return;
    if (rulesVersion === 2) {
      const message =
        `rules_version_mismatch: la ejecución ${runId} es rulesVersion=2 (plan de conceptos, introducciones y ` +
        `Context Package) y este ejecutor solo reclama tipos de rulesVersion 1 (${types.join(', ')}). ` +
        'Recargá la página para usar el generador actualizado; con este ejecutor el curso no avanzaría.';
      throw new ConflictException({ message, code: 'rules_version_mismatch', rulesVersion, runId });
    }
  }

  // ── heartbeat / complete / fail / external ───────────────────────────────

  async heartbeatItem(itemRunId: string, executorId: string, leaseSeconds: number, ownerId?: string): Promise<boolean> {
    return (await this.heartbeatItemDetailed(itemRunId, executorId, leaseSeconds, ownerId)).ok;
  }

  async heartbeatItemDetailed(
    itemRunId: string,
    executorId: string,
    leaseSeconds: number,
    ownerId?: string,
  ): Promise<ItemOpResult> {
    executorId = this.checkExecutorId(executorId);
    if (!UUID_RE.test(String(itemRunId))) return { ok: false, reason: 'not_found' };
    const rows = returningRows(
      await this.dataSource.query(
        `update public.generation_item_runs g
            set lease_until = now() + make_interval(secs => $3::int), updated_at = now()
          where g.id = $1 and g.status = 'running' and g.worker_id = $2
            and exists (
              select 1 from public.production_jobs pj
               where pj.id = g.job_id and pj.execution_mode = 'dynamic_generation'
                 and pj.worker_status = any($4::text[])
                 and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
                 and ($5::text is null or pj.owner_id = $5))
          returning g.id`,
        [itemRunId, executorId, this.clampLease(leaseSeconds), ACTIVE_RUN_WORKER_STATUSES, ownerId ?? null],
      ),
    );
    if (rows.length === 1) return { ok: true };
    return { ok: false, reason: await this.diagnose(itemRunId, executorId, ownerId) };
  }

  async completeItem(
    itemRunId: string,
    executorId: string,
    output: { artifactIds: string[]; summary: Record<string, any> },
    ownerId?: string,
  ): Promise<boolean> {
    return (await this.completeItemDetailed(itemRunId, executorId, output, ownerId)).ok;
  }

  /**
   * R13/R14: vincula los artifacts (ya subidos por el ejecutor) y completa el
   * item en UNA transacción. Solo se vinculan artifacts del dueño del run,
   * con course_id = artifactCourseId y todavía sin item_run_id; si no se
   * vinculan TODOS → rollback y {ok:false, reason:'artifacts_not_linkable'}
   * (un artifact subido por un lease perdido queda huérfano, R13).
   */
  /**
   * V2.1 fix round 1 (I3): identidad del video vigente (última generación de
   * `video:<ch>` del run, que tiene que estar completed) para las
   * interacciones de ese capítulo: `{identity, itemRunId, generation,
   * artifactIds}`. `identity` = artifactOutputIdentity (storage paths): una
   * fila carried conserva la identidad; un video regenerado la cambia. Sin
   * video completado → 409 (unas interacciones sin video no se completan).
   */
  private async consumedVideoIdentity(qr: QueryRunner, jobId: string, item: any): Promise<Record<string, any>> {
    const videoKey = `video:${item.chapter_id}`;
    const [v] = await qr.query(
      `select g.id, g.generation, g.status from public.generation_item_runs g
        where g.job_id = $1 and g.item_key = $2 and ${latestGenerationPredicate('g')}`,
      [jobId, videoKey],
    );
    if (!v || v.status !== 'completed') {
      throw new ConflictException({
        message: `video_not_completed: ${item.item_key} no se completa sin ${videoKey} completado (estado ${v?.status ?? 'inexistente'})`,
        code: 'video_not_completed',
      });
    }
    const arts: any[] = await qr.query(
      `select id, type, storage_bucket as bucket, storage_path as path from public.artifacts
        where item_run_id = $1 and coalesce(status, 'ready') <> 'disabled' order by id`,
      [v.id],
    );
    const identity = artifactOutputIdentity(arts);
    if (!identity) {
      throw new ConflictException({
        message: `video_not_completed: ${videoKey} (item run ${v.id}) no tiene artifacts; no se puede registrar la identidad del video`,
        code: 'video_not_completed',
      });
    }
    return { identity, itemRunId: v.id, generation: Number(v.generation), artifactIds: arts.map((a) => a.id) };
  }

  async completeItemDetailed(
    itemRunId: string,
    executorId: string,
    output: { artifactIds: string[]; summary: Record<string, any> },
    ownerId?: string,
  ): Promise<ItemOpResult> {
    executorId = this.checkExecutorId(executorId);
    const ids = [...new Set((output?.artifactIds ?? []).map(String))];
    if (ids.length === 0) return { ok: false, reason: 'no_artifacts' };
    if (ids.some((id) => !UUID_RE.test(id))) return { ok: false, reason: 'invalid_artifact_id' };
    const summary = output?.summary ?? {};
    if (!isPlainObject(summary)) return { ok: false, reason: 'invalid_summary' };

    // V2.1 R11a: items LLM de rulesVersion 3 → el servidor valida el contenido
    // del artifact ANTES de aceptar (fuera de la transacción: la descarga no
    // retiene locks). Inválido → el item falla reintentable con los códigos
    // del validador (nunca se acepta en silencio). v1/v2: no aplica.
    const pre = await this.prevalidateV3(itemRunId, executorId, ids, ownerId);
    if (pre.kind === 'invalid') {
      const failed = await this.failItemDetailed(itemRunId, executorId, pre.message, pre.retryable, ownerId);
      return failed.ok ? { ok: false, reason: V3_PAYLOAD_INVALID, errors: pre.codes } : failed;
    }
    const validationPatch =
      pre.kind === 'valid'
        ? { v3Validation: { artifactType: pre.artifactType, artifactId: pre.artifactId, contentSha256: pre.contentSha256, ...pre.summary } }
        : {};

    return this.guardedItemOp(itemRunId, executorId, ownerId, 'update', async (qr, job, item) => {
      if (pre.kind === 'valid') {
        // El artifact validado sigue siendo el mismo objeto (misma ruta) al completar.
        const [a] = await qr.query(`select storage_bucket, storage_path from public.artifacts where id = $1`, [pre.artifactId]);
        if (!a || a.storage_bucket !== pre.storageBucket || a.storage_path !== pre.storagePath) {
          throw new GuardRejection('artifact_changed_after_validation');
        }
      }
      const merged = mergeOutputSummary(item.output_summary ?? {}, { ...summary, ...validationPatch, artifactIds: ids });
      if (merged.ok === false) throw new GuardRejection(merged.reason);

      // Spec §3.3 / R16: un artifact por item y rol (type). Se rechaza antes
      // del UPDATE; el índice único parcial uq_artifacts_item_run_type es la
      // red de seguridad (23505 → mismo rechazo, rollback de todo).
      const dupTypes = await qr.query(
        `select type from public.artifacts where id = any($1::uuid[]) group by type having count(*) > 1`,
        [ids],
      );
      if (dupTypes.length > 0) throw new GuardRejection('duplicate_artifact_type');

      let linked: any[];
      try {
        linked = returningRows(
          await qr.query(
            `update public.artifacts
                set manifest_id = $2, manifest_item_key = $3, item_run_id = $4, module_id = $5, chapter_id = $6,
                    status = 'ready', generated_with_version_id = $7, updated_at = now()
              where id = any($1::uuid[]) and owner_id = $8 and course_id = $9 and item_run_id is null
              returning id`,
            [ids, item.manifest_id, item.item_key, item.id, item.module_id, item.chapter_id, item.blueprint_id,
              job.owner_id, this.artifactCourseId(job)],
          ),
        );
      } catch (err) {
        const code = (err as any)?.code ?? (err as any)?.driverError?.code;
        if (code === '23505') throw new GuardRejection('duplicate_artifact_type');
        throw err;
      }
      if (linked.length !== ids.length) throw new GuardRejection('artifacts_not_linkable');

      // M1 (review-rv2): en rulesVersion 2 un item solo se completa con TODOS
      // sus roles obligatorios (misma tabla que el resolver de empaquetado:
      // content → md + Context Package; course_plan → plan json; intros → su
      // md; scorm/exam/video como v1). Si falta alguno → 409 con los tipos
      // faltantes y rollback (el item sigue running, nada queda vinculado):
      // un item completado a medias ya no se puede reintentar. v1 intacto.
      const [mrow] = await qr.query(
        `select rules_version from public.course_generation_manifests where id = $1`,
        [item.manifest_id],
      );
      const itemRulesVersion = mrow ? Number(mrow.rules_version) : null;
      if (itemRulesVersion === 2 || itemRulesVersion === 3) {
        // V2.1 (R4): v3 usa su tabla de roles; activity según el variant del
        // item en el Manifest congelado. Sin tabla para el tipo → 409 (nunca
        // se completa un item v3 sin saber qué debía producir).
        let required: string[];
        if (itemRulesVersion === 3) {
          const variant = await this.manifestItemVariant(qr, item.manifest_id, item.item_key);
          const v3 = requiredArtifactTypesV3(item.type, variant);
          if (!v3) {
            throw new ConflictException({
              message:
                `missing_required_artifacts: el item ${item.item_key} (${item.type}, rulesVersion 3) no tiene roles de ` +
                `artifact definidos${item.type === 'activity' ? ` para variant=${JSON.stringify(variant)}` : ''}; no se completa`,
              code: 'missing_required_artifacts',
              missing: [],
            });
          }
          required = v3;
        } else {
          required = requiredArtifactTypes(2, item.type) ?? [];
        }
        const linkedTypes = new Set(
          (await qr.query(`select type from public.artifacts where id = any($1::uuid[])`, [ids])).map((r: any) => r.type),
        );
        const missingTypes: string[] = required.filter((t) => !linkedTypes.has(t));
        // El resumen del capítulo (dynamic_context_summary_json) es opcional,
        // pero su ausencia tiene que quedar MARCADA (output_summary.
        // contextSummary='missing', mismo invariante que la auditoría [4j]):
        // nunca un content v2 sin resumen y sin marca.
        if (
          item.type === 'content' &&
          !linkedTypes.has('dynamic_context_summary_json') &&
          merged.merged.contextSummary !== 'missing'
        ) {
          missingTypes.push('dynamic_context_summary_json (o la marca contextSummary="missing")');
        }
        if (missingTypes.length > 0) {
          throw new ConflictException({
            message:
              `missing_required_artifacts: el item ${item.item_key} (${item.type}, rulesVersion ${itemRulesVersion}) no se puede completar ` +
              `sin sus artifacts obligatorios; faltan: ${missingTypes.join(', ')}`,
            code: 'missing_required_artifacts',
            missing: missingTypes,
          });
        }
        if (item.type === 'content' && Number(item.generation) > 1) {
          await this.assertRegeneratedContextPackage(qr, item, merged.merged);
        }
        // V2.1 fix round 1 (review G2 I3): las interacciones registran la
        // identidad del video CONTRA el que se generaron (generación vigente
        // de video:<ch> en este run al completar). La invalidación compara
        // contra ESTO, nunca contra el video actual.
        if (itemRulesVersion === 3 && item.type === 'video_interactions') {
          merged.merged.videoIdentity = await this.consumedVideoIdentity(qr, job.id, item);
        }
      }

      const done = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'completed', finished_at = now(), lease_until = null, next_retry_at = null,
                  error = null, output_summary = $3::jsonb, updated_at = now()
            where id = $1 and status = 'running' and worker_id = $2
            returning id`,
          [item.id, executorId, JSON.stringify(merged.merged)],
        ),
      );
      if (done.length !== 1) throw new GuardRejection('not_running');
      await recomputeRunStatus(qr, job.id);
    });
  }

  async failItem(
    itemRunId: string,
    executorId: string,
    error: string,
    retryable: boolean,
    ownerId?: string,
    opts?: { retryAfterSeconds?: number; refundAttempt?: boolean },
  ): Promise<boolean> {
    return (await this.failItemDetailed(itemRunId, executorId, error, retryable, ownerId, opts)).ok;
  }

  /**
   * retryable y quedan intentos → `retrying` con backoff; si no → `failed` +
   * dependientes transitivos `blocked` (condición 6). Recalcula el run (R12).
   */
  async failItemDetailed(
    itemRunId: string,
    executorId: string,
    error: string,
    retryable: boolean,
    ownerId?: string,
    opts?: { retryAfterSeconds?: number; refundAttempt?: boolean },
  ): Promise<ItemOpResult> {
    executorId = this.checkExecutorId(executorId);
    const msg = String(error ?? '').trim().slice(0, MAX_ERROR_LENGTH) || 'unknown_error';
    return this.guardedItemOp(itemRunId, executorId, ownerId, 'update', async (qr, job, item) => {
      const t = await applyItemFailure(qr, item.id, msg, !!retryable, opts?.retryAfterSeconds ?? null, opts?.refundAttempt === true);
      if (!t) throw new GuardRejection('not_running');
      await recomputeRunStatus(qr, job.id);
    });
  }

  /**
   * V2.1 RF-b — runtime guard de presupuesto: un item `running` cuyo envío
   * pagado superaría el presupuesto autorizado del run pasa a `blocked` con
   * error `budget_exceeded: …` (visible, sin gasto: se llama ANTES del envío).
   * Sus dependientes transitivos también quedan `blocked`. Se reanuda con
   * retryItem tras ampliar la autorización (POST /finops/courses/:id/authorizations).
   */
  async blockItemForBudget(itemRunId: string, executorId: string, detail: string, ownerId?: string): Promise<boolean> {
    executorId = this.checkExecutorId(executorId);
    const raw = String(detail ?? '').trim();
    const msg = (raw.startsWith('budget_exceeded') ? raw : `budget_exceeded: ${raw || 'presupuesto agotado'}`).slice(0, MAX_ERROR_LENGTH);
    const res = await this.guardedItemOp(itemRunId, executorId, ownerId, 'update', async (qr, job, item) => {
      const rows = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'blocked', error = $2, worker_id = null, lease_until = null, next_retry_at = null,
                  finished_at = null, updated_at = now()
            where id = $1 and status = 'running'
            returning id`,
          [item.id, msg],
        ),
      );
      if (rows.length !== 1) throw new GuardRejection('not_running');
      await blockDependents(qr, job.id, item.item_key);
      await recomputeRunStatus(qr, job.id);
    });
    return res.ok;
  }

  async recordItemExternal(
    itemRunId: string,
    executorId: string,
    patch: Record<string, any>,
    ownerId?: string,
  ): Promise<boolean> {
    return (await this.recordItemExternalDetailed(itemRunId, executorId, patch, ownerId)).ok;
  }

  /**
   * R15: merge top-level de `patch` en output_summary bajo FOR UPDATE con los
   * guards de R14; nunca cambia un `external` existente por otro distinto
   * (→ {ok:false, reason:'external_conflict'}). Usado por el worker de video
   * (R3) para persistir externalSubmitStartedAt y los ids de Videogen.
   */
  async recordItemExternalDetailed(
    itemRunId: string,
    executorId: string,
    patch: Record<string, any>,
    ownerId?: string,
  ): Promise<ItemOpResult> {
    executorId = this.checkExecutorId(executorId);
    if (!isPlainObject(patch)) return { ok: false, reason: 'invalid_patch' };
    // M5: si el run ya está cancelado, solo se permite un merge EXCLUSIVAMENTE
    // de `external` (los ids de Videogen) — nunca `externalSubmitStartedAt` ni
    // ningún otro campo. Esto evita que un video ya sometido (dinero real
    // gastado) quede huérfano solo porque el cancel ganó la carrera contra el
    // registro del id; el item igual queda cancelado por reconcileCancellation,
    // pero el id sobrevive para que un futuro reopen lo vea como
    // 'ambiguous_video_submission' recuperable en vez de perderlo en logs.
    const patchKeys = Object.keys(patch);
    const allowCancelled = patchKeys.length === 1 && patchKeys[0] === 'external';
    return this.guardedItemOp(itemRunId, executorId, ownerId, 'share', async (qr, _job, item) => {
      const merged = mergeOutputSummary(item.output_summary ?? {}, patch);
      if (merged.ok === false) throw new GuardRejection(merged.reason);
      const rows = returningRows(
        await qr.query(
          `update public.generation_item_runs set output_summary = $3::jsonb, updated_at = now()
            where id = $1 and status = 'running' and worker_id = $2 returning id`,
          [item.id, executorId, JSON.stringify(merged.merged)],
        ),
      );
      if (rows.length !== 1) throw new GuardRejection('not_running');
    }, allowCancelled);
  }

  // ── V2.1 R11a: validación server-side de items LLM v3 ─────────────────────

  /**
   * Lectura sin locks del item + su artifact validable; descarga y valida.
   * - 'skip': no aplica (no v3, tipo sin validación de contenido, o el
   *   estado/artifacts no son completables → la transacción de completeItem
   *   devuelve el motivo de siempre: not_running, lease_lost,
   *   artifacts_not_linkable, missing_required_artifacts…).
   * - 'invalid': el contenido no pasa el validador (o falta un dato medido de
   *   la dependencia, p.ej. la duración del video → no reintentable).
   * - 'valid': ok; la transacción re-verifica que el artifact no cambió.
   */
  private async prevalidateV3(
    itemRunId: string,
    executorId: string,
    artifactIds: string[],
    ownerId?: string,
  ): Promise<
    | { kind: 'skip' }
    | { kind: 'invalid'; message: string; codes: string[]; retryable: boolean }
    | {
        kind: 'valid';
        artifactType: string;
        artifactId: string;
        storageBucket: string;
        storagePath: string;
        contentSha256: string;
        summary: Record<string, unknown>;
      }
  > {
    if (!UUID_RE.test(String(itemRunId))) return { kind: 'skip' };
    const [g] = await this.dataSource.query(
      `select g.id, g.job_id, g.manifest_id, g.item_key, g.type, g.status, g.worker_id, g.chapter_id, g.module_id,
              pj.owner_id, pj.course_id as job_course_id, pj.frontend_course_id, m.rules_version, m.manifest_json
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
        where g.id = $1 and pj.execution_mode = 'dynamic_generation' and ($2::text is null or pj.owner_id = $2)`,
      [itemRunId, ownerId ?? null],
    );
    if (!g || Number(g.rules_version) !== 3 || g.status !== 'running' || g.worker_id !== executorId) return { kind: 'skip' };
    const manifest = typeof g.manifest_json === 'string' ? JSON.parse(g.manifest_json) : g.manifest_json;
    const mItem = (manifest?.items ?? []).find((i: any) => i && i.key === g.item_key);
    if (!mItem) {
      // M5 (fail closed): un item v3 running sin su entrada del Manifest es integridad rota.
      throw new InternalServerErrorException(`v3_validation_context: el item ${g.item_key} no está en su Manifest congelado; no se completa sin validar`);
    }
    const artifactType = v3ValidatedArtifactType(g.type, mItem.variant ?? null);
    if (!artifactType) return { kind: 'skip' };

    const rows = await this.dataSource.query(
      `select id, type, storage_bucket, storage_path from public.artifacts
        where id = any($1::uuid[]) and type = $2 and owner_id = $3 and course_id = $4 and item_run_id is null`,
      [artifactIds, artifactType, g.owner_id, g.frontend_course_id ?? String(g.job_course_id)],
    );
    if (rows.length !== 1) return { kind: 'skip' };
    const art = rows[0];
    if (!this.v3Reader) {
      throw new InternalServerErrorException(
        `v3_validator_unavailable: el item ${g.item_key} (${g.type}, rulesVersion 3) exige validar ${artifactType} en el servidor ` +
          'y no hay lector de artifacts configurado; no se completa sin validar',
      );
    }

    const ctx: Parameters<typeof validateV3ItemArtifact>[0] = {
      type: g.type,
      variant: mItem.variant ?? null,
      itemKey: g.item_key,
      chapterId: g.chapter_id ?? null,
      chapterNumber: mItem.chapterNumber ?? null,
    };
    if (g.type === 'module_intro') {
      const mod = (manifest.modules ?? []).find((m: any) => m.moduleId === g.module_id);
      ctx.moduleChapterIds = mod ? mod.chapters.map((c: any) => c.chapterId) : [];
      if (ctx.moduleChapterIds.length === 0) {
        throw new InternalServerErrorException(`v3_validation_context: el module_intro ${g.item_key} no tiene capítulos en el Manifest; no se completa sin validar`);
      }
    }
    if (g.type === 'video_interactions') {
      const vf = await this.loadVideoFacts(this.dataSource, g.job_id, g.manifest_id, `video:${g.chapter_id}`);
      if (vf.ok === false) {
        // M6: reintentable — si el video se regenera, un claim nuevo trae el plan vigente.
        return { kind: 'invalid', message: `${V3_PAYLOAD_INVALID}: ${vf.code}: ${vf.message}`, codes: [vf.code], retryable: true };
      }
      ctx.video = { videoItemKey: vf.video.videoItemKey, durationSec: vf.video.durationSec };
    }

    let text: string;
    try {
      text = await this.v3Reader.readText({
        id: art.id,
        ownerId: g.owner_id,
        itemKey: g.item_key,
        itemRunId: g.id,
        type: art.type,
        storageBucket: art.storage_bucket,
        storagePath: art.storage_path,
      });
    } catch (err) {
      // No es un problema del contenido: el item sigue running y el ejecutor puede reintentar completar.
      throw new ServiceUnavailableException(
        `v3_artifact_unreadable: no se pudo leer ${artifactType} (${art.id}) del item ${g.item_key} para validarlo: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const r = validateV3ItemArtifact(ctx, text);
    if (!r.ok) {
      return {
        kind: 'invalid',
        message: v3ValidationErrorMessage({ itemKey: g.item_key, type: g.type }, r.errors),
        codes: [...new Set(r.errors.map((e) => e.code))].sort(),
        retryable: true,
      };
    }
    return {
      kind: 'valid',
      artifactType,
      artifactId: art.id,
      storageBucket: art.storage_bucket,
      storagePath: art.storage_path,
      // M7: huella del contenido validado; el empaque (R12) verifica que el objeto descargado coincida.
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      summary: (r.summary ?? {}) as Record<string, unknown>,
    };
  }

  /** Datos del video completado (vigente) del capítulo: output_summary + metadata de su dynamic_video. */
  private async loadVideoFacts(
    q: { query: (sql: string, params?: any[]) => Promise<any[]> },
    jobId: string,
    manifestId: number,
    videoItemKey: string,
  ): Promise<ReturnType<typeof videoClaimFacts>> {
    const [v] = await q.query(
      `select d.output_summary, a.metadata
         from public.generation_item_runs d
         left join public.artifacts a on a.item_run_id = d.id and a.type = 'dynamic_video'
        where d.job_id = $1 and d.manifest_id = $2 and d.item_key = $3 and d.status = 'completed'
          and ${latestGenerationPredicate('d')}
        order by a.created_at desc nulls last
        limit 1`,
      [jobId, manifestId, videoItemKey],
    );
    if (!v) return { ok: false, code: 'VIDEO_NOT_COMPLETED', message: `el video ${videoItemKey} no está completado` };
    return videoClaimFacts({ videoItemKey, outputSummary: v.output_summary, artifactMetadata: v.metadata });
  }

  /** Bloque `claimPayload` del ClaimedItem (solo rulesVersion 3 y tipos validados por el servidor). */
  private async buildClaimV3(qr: QueryRunner, row: any, mItem: any, manifest: GenerationManifestV1): Promise<ClaimPayloadV3 | undefined> {
    if (manifest.rulesVersion !== 3) return undefined;
    const validatedArtifactType = v3ValidatedArtifactType(row.type, mItem.variant ?? null);
    const out: ClaimPayloadV3 = { validatedArtifactType };
    switch (row.type) {
      case 'course_intro':
      case 'final_exam':
      case 'experience':
      case 'module_intro':
      case 'video_interactions':
      case 'activity':
        break;
      default:
        return undefined;
    }
    if (row.type === 'experience') out.chapterId = row.chapter_id;
    if (row.type === 'final_exam') {
      out.finalExam = { minQuestions: FINAL_EXAM_QUESTION_RANGE.min, maxQuestions: FINAL_EXAM_QUESTION_RANGE.max };
    }
    if (row.type === 'module_intro') {
      const mod = manifest.modules.find((m) => m.moduleId === row.module_id);
      out.moduleChapterIds = mod ? mod.chapters.map((c) => c.chapterId) : [];
    }
    if (row.type === 'activity' && mItem.variant === 'h5p') out.activityType = activityTypeForChapter(row.chapter_id);
    if (row.type === 'video_interactions') {
      const vf = await this.loadVideoFacts(qr, row.job_id, row.manifest_id, `video:${row.chapter_id}`);
      if (vf.ok === false) throw new ClaimPayloadUnavailable(vf.code, vf.message);
      out.video = vf.video;
    }
    return out;
  }

  // ── sweep ────────────────────────────────────────────────────────────────

  /**
   * `running` con lease_until < now() → failItem(retryable) con
   * 'lease_expired' (el intento ya se contó en el claim; la idempotency_key
   * no cambia). Con runId: ese run (esperando su lock). Sin runId: todos los
   * runs con leases vencidos, una transacción por run, saltando runs cuyo
   * lock está tomado (los barre el próximo claim/lectura). Devuelve cuántos
   * items transicionó.
   */
  async sweepExpiredLeases(runId?: string): Promise<number> {
    let jobIds: string[];
    if (runId) {
      if (!UUID_RE.test(runId)) throw new BadRequestException('runId inválido');
      jobIds = [runId];
    } else {
      const rows = await this.dataSource.query(
        `select distinct job_id from public.generation_item_runs
          where status = 'running' and lease_until < now()
          order by job_id`,
      );
      jobIds = rows.map((r: any) => r.job_id);
    }

    let total = 0;
    for (const jobId of jobIds) {
      let cancelledJob: any = null;
      total += await this.runs.tx(async (qr) => {
        const job = await this.lockRun(qr, jobId, undefined, runId ? 'update' : 'update-skip');
        if (!job) return 0;
        if (isCancelledLike(job)) {
          cancelledJob = job;
          return 0;
        }
        if (!isActiveRun(job)) return 0;
        const n = await sweepRunExpiredLeases(qr, job.id);
        if (n > 0) await recomputeRunStatus(qr, job.id);
        return n;
      });
      if (cancelledJob) await this.runs.reconcileCancellation(cancelledJob);
    }
    return total;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * F78-BE2: el Context Package de un content REGENERADO (generation > 1) se
   * reconstruye en el navegador desde los inputs congelados del run
   * (outline del Blueprint + contexto + course_plan vigente, ver
   * dynBuildContextPackage en 46-dynamic-context-package.js): con el MISMO
   * course_plan (misma storage_path) tiene que dar el MISMO
   * contextPackageSha256 que la generación anterior. Si difiere, el ejecutor
   * usó otros inputs → 409 `context_package_mismatch` y rollback (el item
   * sigue running; nunca se completa con un paquete divergente en silencio).
   * Si el plan cambió, o falta el dato en alguna de las dos generaciones, no
   * se compara (no hay base para afirmar que deban coincidir).
   */
  private async assertRegeneratedContextPackage(qr: QueryRunner, item: any, summary: Record<string, any>): Promise<void> {
    const fromId = item.output_summary?.regeneration?.fromItemRunId;
    if (!fromId) return;
    const [prev] = await qr.query(`select output_summary from public.generation_item_runs where id = $1`, [fromId]);
    const prevSha = prev?.output_summary?.contextPackageSha256;
    const newSha = summary?.contextPackageSha256;
    const prevPlan = prev?.output_summary?.coursePlanArtifactId;
    const newPlan = summary?.coursePlanArtifactId;
    if (!prevSha || !newSha || !prevPlan || !newPlan) return;
    const plans: Array<{ id: string; storage_bucket: string; storage_path: string }> = await qr.query(
      `select id, storage_bucket, storage_path from public.artifacts where id = any($1::uuid[])`,
      [[...new Set([String(prevPlan), String(newPlan)])]],
    );
    const pathOf = (id: string) => {
      const r = plans.find((p) => p.id === id);
      return r ? `${r.storage_bucket}/${r.storage_path}` : null;
    };
    const a = pathOf(String(prevPlan));
    const b = pathOf(String(newPlan));
    if (!a || !b || a !== b) return;
    if (prevSha !== newSha) {
      throw new ConflictException({
        message:
          `context_package_mismatch: el content regenerado ${item.item_key} (generation ${item.generation}) trae un Context Package ` +
          `(${String(newSha).slice(0, 12)}…) distinto al de la generación ${prev ? 'anterior' : '?'} (${String(prevSha).slice(0, 12)}…) ` +
          'con el mismo course_plan: el paquete se debe reconstruir desde los inputs congelados del run',
        code: 'context_package_mismatch',
      });
    }
  }

  /**
   * Operación sobre un item reclamado con los guards de R14, en una
   * transacción: fila del run bloqueada primero ('update' si la operación
   * cambia el run, 'share' si no), después el item FOR UPDATE. Run cancelado
   * → reconciliado (R9) y {ok:false,'run_cancelled'}.
   */
  private async guardedItemOp(
    itemRunId: string,
    executorId: string,
    ownerId: string | undefined,
    runLock: 'update' | 'share',
    fn: (qr: QueryRunner, job: any, item: any) => Promise<void>,
    /**
     * M5: si true y el run está cancelado, no rechaza — sigue adelante con
     * `fn` (usado únicamente por el merge external-only de
     * recordItemExternalDetailed). El run sigue reconciliándose después
     * (items no terminales → cancelled), pero el patch ya quedó persistido.
     */
    allowCancelled = false,
  ): Promise<ItemOpResult> {
    if (!UUID_RE.test(String(itemRunId))) return { ok: false, reason: 'not_found' };
    const [head] = await this.dataSource.query(
      `select g.job_id from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
        where g.id = $1 and pj.execution_mode = 'dynamic_generation' and ($2::text is null or pj.owner_id = $2)`,
      [itemRunId, ownerId ?? null],
    );
    if (!head) return { ok: false, reason: 'not_found' };

    let cancelledJob: any = null;
    let result: ItemOpResult;
    try {
      result = await this.runs.tx(async (qr) => {
        const job = await this.lockRun(qr, head.job_id, ownerId, runLock);
        if (!job) throw new GuardRejection('not_found');
        if (isCancelledLike(job)) {
          cancelledJob = job;
          if (!allowCancelled) throw new GuardRejection('run_cancelled');
        } else if (!isActiveRun(job)) {
          throw new GuardRejection('run_not_active');
        }
        const [item] = await qr.query(`select * from public.generation_item_runs where id = $1 for update`, [itemRunId]);
        if (!item) throw new GuardRejection('not_found');
        if (item.status !== 'running') throw new GuardRejection('not_running');
        if (item.worker_id !== executorId) throw new GuardRejection('lease_lost');
        await fn(qr, job, item);
        return { ok: true };
      });
    } catch (err) {
      if (!(err instanceof GuardRejection)) throw err;
      result = { ok: false, reason: err.reason };
    }
    if (cancelledJob) await this.runs.reconcileCancellation(cancelledJob);
    return result;
  }

  /**
   * R16: un item pending/retrying con una clave de depends_on sin fila
   * (integridad rota: la siembra copia el Manifest completo) nunca es
   * reclamable; se registra con logger.error en cada claim vacío para que no
   * quede atascado en silencio. Solo lectura, sin locks.
   */
  private async reportMissingDependencies(runId: string | null, ownerId?: string): Promise<void> {
    const rows = await this.dataSource.query(
      `select g.job_id, g.item_key,
              array(select dk.key from unnest(g.depends_on) as dk(key)
                     where not exists (select 1 from public.generation_item_runs d2
                                        where d2.job_id = g.job_id and d2.manifest_id = g.manifest_id
                                          and d2.item_key = dk.key)) as missing
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
        where g.status in ('pending', 'retrying')
          and pj.execution_mode = 'dynamic_generation'
          and pj.worker_status = any($1::text[])
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and ($2::uuid is null or g.job_id = $2)
          and ($3::text is null or pj.owner_id = $3)
          and exists (select 1 from unnest(g.depends_on) as dk(key)
                       where not exists (select 1 from public.generation_item_runs d2
                                          where d2.job_id = g.job_id and d2.manifest_id = g.manifest_id
                                            and d2.item_key = dk.key))
        limit 50`,
      [ACTIVE_RUN_WORKER_STATUSES, runId, ownerId ?? null],
    );
    for (const r of rows) {
      this.logger.error(
        `Item ${r.item_key} (run ${r.job_id}) NO reclamable: dependencia(s) sin fila en generation_item_runs ` +
          `(${(r.missing ?? []).join(', ')}) — integridad rota, requiere intervención`,
      );
    }
  }

  private async lockRun(
    qr: QueryRunner,
    runId: string,
    ownerId: string | undefined,
    mode: 'update' | 'update-skip' | 'share',
  ): Promise<any | null> {
    const lock = mode === 'share' ? 'for share' : mode === 'update-skip' ? 'for update skip locked' : 'for update';
    const [job] = await qr.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and ($2::text is null or owner_id = $2)
        ${lock}`,
      [runId, ownerId ?? null],
    );
    return job ?? null;
  }

  /** Motivo de un heartbeat rechazado (solo diagnóstico; sin locks). */
  private async diagnose(itemRunId: string, executorId: string, ownerId?: string): Promise<string> {
    const [r] = await this.dataSource.query(
      `select g.status, g.worker_id, pj.status as job_status, pj.worker_status as job_worker_status
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
        where g.id = $1 and pj.execution_mode = 'dynamic_generation' and ($2::text is null or pj.owner_id = $2)`,
      [itemRunId, ownerId ?? null],
    );
    if (!r) return 'not_found';
    if (isCancelledLike({ status: r.job_status, worker_status: r.job_worker_status })) return 'run_cancelled';
    if (!isActiveRun({ status: r.job_status, worker_status: r.job_worker_status })) return 'run_not_active';
    if (r.status !== 'running') return 'not_running';
    if (r.worker_id !== executorId) return 'lease_lost';
    return 'rejected';
  }

  private artifactCourseId(job: any): string {
    return job.frontend_course_id ?? String(job.course_id);
  }

  private checkExecutorId(executorId: string): string {
    const v = typeof executorId === 'string' ? executorId.trim() : '';
    if (!v || v.length > MAX_EXECUTOR_ID_LENGTH) {
      throw new BadRequestException(`executorId inválido (1..${MAX_EXECUTOR_ID_LENGTH} caracteres)`);
    }
    return v;
  }

  private checkTypes(types: ItemType[]): ItemType[] {
    // Tipos de v1 y v2 se aceptan siempre: un tipo que no existe en el
    // Manifest del run simplemente no matchea ningún item.
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => !ALL_ITEM_TYPES.includes(t))) {
      throw new BadRequestException(`types debe ser un subconjunto no vacío de ${ALL_ITEM_TYPES.join(', ')}`);
    }
    return [...new Set(types)];
  }

  private clampLease(leaseSeconds: number): number {
    const n = Number.isFinite(Number(leaseSeconds)) ? Math.floor(Number(leaseSeconds)) : DEFAULT_LEASE_SECONDS;
    return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, n));
  }

  /**
   * Payload del item reclamado, armado SOLO desde el backend (condición 1):
   * contexto congelado + Manifest + snapshot del Blueprint verificados +
   * artifacts de las dependencias. Cualquier inconsistencia → 500 (y el
   * claim se deshace porque corre dentro de su transacción).
   */
  private async buildClaimedItem(qr: QueryRunner, job: any, row: any): Promise<ClaimedItem> {
    const where = `Item ${row.item_key} (run ${job.id})`;
    const fail = (msg: string) => new InternalServerErrorException(`${where}: ${msg} (integridad rota)`);

    // Contexto congelado (condición 2).
    const [ctx] = await qr.query(
      `select context, context_hash from public.generation_run_contexts where job_id = $1`,
      [job.id],
    );
    if (!ctx) throw fail('el run no tiene contexto congelado');
    if (canonicalContextHash(ctx.context) !== ctx.context_hash) throw fail('el contexto no coincide con su context_hash');
    const payloadHash = job.input_payload?.contextHash;
    if (payloadHash && payloadHash !== ctx.context_hash) throw fail('input_payload.contextHash ≠ context_hash');

    // Manifest (hash verificado).
    const [mrow] = await qr.query(`select * from public.course_generation_manifests where id = $1`, [row.manifest_id]);
    if (!mrow) throw fail('el Manifest no existe');
    if (mrow.course_id !== row.course_id || mrow.blueprint_id !== row.blueprint_id) {
      throw fail('el Manifest no corresponde al curso/Blueprint del item');
    }
    let manifest: GenerationManifestV1;
    try {
      const stored = typeof mrow.manifest_json === 'string' ? JSON.parse(mrow.manifest_json) : mrow.manifest_json;
      manifest = JSON.parse(canonicalManifestJson(stored));
    } catch (err) {
      throw fail(`manifest_json ilegible (${err instanceof Error ? err.message : String(err)})`);
    }
    if (manifestSha256(manifest) !== mrow.manifest_sha256) throw fail('sha256 del Manifest no coincide');

    // Blueprint por (blueprint_id, course_id) + recanonicalización (R2).
    const [bp] = await qr.query(
      `select id, course_id, blueprint_number, snapshot_json, snapshot_sha256
         from public.course_blueprints where id = $1 and course_id = $2`,
      [row.blueprint_id, row.course_id],
    );
    if (!bp) throw fail('el Blueprint no existe');
    // V2.1 (R4): Blueprint schemaVersion 2 (runs v3) con su propio builder/sha.
    const snapshot: AnyBlueprintSnapshot = this.recanonicalizeAnySnapshot(bp.snapshot_json, fail);
    const bpSha = snapshot.schemaVersion === 2 ? snapshotSha256V2(snapshot) : snapshotSha256(snapshot);
    if (bpSha !== bp.snapshot_sha256) throw fail('sha256 del snapshot del Blueprint no coincide');
    if (mrow.blueprint_sha256 !== bp.snapshot_sha256) throw fail('blueprint_sha256 del Manifest ≠ snapshot del Blueprint');
    const source = {
      courseId: bp.course_id,
      blueprintId: bp.id,
      blueprintNumber: bp.blueprint_number,
      blueprintSha256: bp.snapshot_sha256,
    };
    const errors = validateGenerationManifest(manifest, snapshot, source);
    if (errors.length > 0) throw fail(`Manifest inválido contra el Blueprint: ${errors.slice(0, 3).map((e) => e.code).join(', ')}`);

    const mItem = manifest.items.find((i) => i.key === row.item_key);
    if (
      !mItem ||
      mItem.type !== row.type ||
      (mItem.moduleId ?? null) !== (row.module_id ?? null) ||
      (mItem.chapterId ?? null) !== (row.chapter_id ?? null) ||
      !sameJson(mItem.dependsOn, row.depends_on ?? [])
    ) {
      throw fail('el item no coincide con su entrada del Manifest');
    }
    // rulesVersion 2: items de scope course (course_plan, course_intro) no
    // tienen módulo ni capítulo — module/chapter null y moduleChapters vacío.
    // Cualquier otro item exige su módulo (como siempre).
    const courseScope = mItem.scope === 'course';
    if (courseScope && (row.module_id !== null || row.chapter_id !== null)) {
      throw fail('item de scope course con module_id/chapter_id');
    }
    const mModule = courseScope ? null : manifest.modules.find((m) => m.moduleId === row.module_id);
    const sModule = courseScope ? null : snapshot.modules.find((m) => m.id === row.module_id);
    if (!courseScope && (!mModule || !sModule)) throw fail('módulo ausente en Manifest/Blueprint');
    const sChapter = row.chapter_id && sModule ? sModule.chapters.find((c) => c.id === row.chapter_id) : null;
    if (row.chapter_id && !sChapter) throw fail('capítulo ausente en el Blueprint');
    const moduleChapters = !mModule
      ? []
      : mModule.chapters.map((mc) => {
          const sc = sModule!.chapters.find((c) => c.id === mc.chapterId);
          if (!sc) throw fail(`capítulo ${mc.chapterId} del Manifest ausente en el Blueprint`);
          return { id: sc.id, title: sc.title, objective: sc.objective ?? null, chapterNumber: mc.chapterNumber };
        });

    // Outline del curso completo (R18), en el mismo orden en que el Manifest
    // enumera sus módulos (manifest.modules ya está en orden de moduleNumber
    // — ver generation-manifest-builder.ts), resuelto contra el snapshot
    // congelado del Blueprint (misma fuente que moduleChapters arriba).
    const outline = manifest.modules.map((mm) => {
      const sm = snapshot.modules.find((m) => m.id === mm.moduleId);
      if (!sm) throw fail(`módulo ${mm.moduleId} del Manifest ausente en el Blueprint`);
      return {
        moduleNumber: mm.moduleNumber,
        id: sm.id,
        title: sm.title,
        objective: sm.objective ?? null,
        chapters: mm.chapters.map((mc) => {
          const sc = sm.chapters.find((c) => c.id === mc.chapterId);
          if (!sc) throw fail(`capítulo ${mc.chapterId} del Manifest ausente en el Blueprint`);
          return { chapterNumber: mc.chapterNumber, id: sc.id, title: sc.title, objective: sc.objective ?? null };
        }),
      };
    });

    const deps: string[] = row.depends_on ?? [];
    const depArtifacts =
      deps.length === 0
        ? []
        : await qr.query(
            `select d.item_key, a.id, a.type, a.storage_path
               from public.generation_item_runs d
               join public.artifacts a on a.item_run_id = d.id
              where d.job_id = $1 and d.manifest_id = $2 and d.item_key = any($3::text[])
                and d.status = 'completed' and ${latestGenerationPredicate('d')}
              order by array_position($3::text[], d.item_key), a.created_at, a.id`,
            // F78-BE2: artifacts de la generación VIGENTE de cada dependencia
            // (la que el predicado de claim exigió completed).
            [row.job_id, row.manifest_id, deps],
          );

    const v3 = await this.buildClaimV3(qr, row, mItem, manifest);

    return {
      itemRunId: row.id,
      runId: job.id,
      courseId: row.course_id,
      frontendCourseId: job.frontend_course_id ?? null,
      artifactCourseId: this.artifactCourseId(job),
      manifestId: row.manifest_id,
      blueprintId: row.blueprint_id,
      blueprintNumber: bp.blueprint_number,
      itemKey: row.item_key,
      type: row.type,
      rulesVersion: manifest.rulesVersion,
      // V2.1 (R4): solo items activity de rulesVersion 3.
      ...(mItem.variant !== undefined ? { variant: mItem.variant } : {}),
      moduleId: row.module_id ?? null,
      chapterId: row.chapter_id ?? null,
      moduleNumber: mItem.moduleNumber ?? null,
      chapterNumber: mItem.chapterNumber ?? null,
      idempotencyKey: row.idempotency_key,
      generation: row.generation,
      dependsOn: deps,
      attempt: row.attempt_count,
      outputSummary: row.output_summary ?? {},
      context: { courseContext: ctx.context, contextHash: ctx.context_hash },
      blueprint: {
        course: { id: snapshot.course.id, title: snapshot.course.title },
        module: sModule
          ? { id: sModule.id, title: sModule.title, objective: sModule.objective ?? null, position: sModule.position }
          : null,
        chapter: sChapter
          ? {
              id: sChapter.id,
              title: sChapter.title,
              objective: sChapter.objective ?? null,
              position: sChapter.position,
              videoEnabled: sChapter.videoEnabled,
            }
          : null,
        moduleChapters,
        outline,
      },
      dependencyArtifacts: depArtifacts.map((a: any) => ({
        itemKey: a.item_key,
        artifactId: a.id,
        type: a.type,
        storagePath: a.storage_path,
      })),
      ...(v3 ? { claimPayload: v3 } : {}),
    };
  }

  /**
   * Re-arma el snapshot v1 leído de jsonb en orden canónico pasándolo por
   * buildBlueprintSnapshot (única fuente del orden) — misma técnica que
   * CourseBlueprintsService.recanonicalize (privado, owner-scoped: no se usa
   * desde el camino del worker, R2).
   */
  private recanonicalizeAnySnapshot(stored: any, fail: (msg: string) => Error): AnyBlueprintSnapshot {
    const s = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (s && s.schemaVersion === 2) {
      try {
        return recanonicalizeBlueprintSnapshotV2(s);
      } catch (err) {
        throw fail(`snapshot v2 del Blueprint inválido (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return this.recanonicalizeSnapshot(s, fail);
  }

  /** `variant` del item en el Manifest congelado (solo activity v3); null si no tiene. */
  private async manifestItemVariant(qr: QueryRunner, manifestId: number, itemKey: string): Promise<string | null> {
    const [r] = await qr.query(
      `select e.it->>'variant' as variant
         from public.course_generation_manifests m,
              jsonb_array_elements(m.manifest_json->'items') as e(it)
        where m.id = $1 and e.it->>'key' = $2
        limit 1`,
      [manifestId, itemKey],
    );
    return r?.variant ?? null;
  }

  private recanonicalizeSnapshot(stored: any, fail: (msg: string) => Error): BlueprintSnapshotV1 {
    const s = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!s || s.schemaVersion !== 1 || !Array.isArray(s.modules)) throw fail('snapshot del Blueprint con forma no soportada');
    const modules: RawModuleRow[] = [];
    const chapters: RawChapterRow[] = [];
    for (const m of s.modules) {
      modules.push({ id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled });
      for (const c of m.chapters ?? []) {
        chapters.push({ id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective, video_enabled: c.videoEnabled });
      }
    }
    try {
      return buildBlueprintSnapshot({ id: s.course?.id, title: s.course?.title }, modules, chapters);
    } catch (err) {
      throw fail(`snapshot del Blueprint inválido (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
