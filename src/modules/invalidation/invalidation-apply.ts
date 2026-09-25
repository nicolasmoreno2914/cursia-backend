import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { effectiveOutputRowsSql } from '../dynamic-generation/item-generations';
import type { ManifestItem } from '../generation-manifests/generation-manifest-builder';
import { computeFingerprints, matchFingerprint } from './fingerprints';
import {
  InvalidationAction,
  InvalidationFromItem,
  InvalidationPlan,
  InvalidationPlanInput,
  computeInvalidationPlan,
} from './plan';

/**
 * Fase 8 (F8-BE) — del plan puro (`plan.ts`) a la base.
 *
 * Tres piezas, separadas para poder probar la lógica sin DB:
 *  1. `loadFromItemsFromDb` (DB, solo lectura): los item runs + artifacts del
 *     run A (y, para items que A no tiene, los artifacts `disabled` de su
 *     linaje fromRun) en la forma `InvalidationFromItem` del core.
 *  2. `planApplyWrites` (PURA): qué filas escribir para el run B — seeds de
 *     item runs, filas de artifact "carried" (misma storage_path inmutable)
 *     y cambios de status de los artifacts de A.
 *  3. `executeApplyWrites` (DB, dentro de la transacción del caller): ejecuta
 *     lo anterior. NUNCA reescribe `storage_path` ni borra filas: sobre los
 *     artifacts de A solo cambia `status` + `metadata` (motivo) + `updated_at`.
 */

export interface QueryExecutor {
  query(sql: string, params?: any[]): Promise<any>;
}

/** Status agregado de los artifacts vinculados a un item run. */
export function aggregateArtifactStatus(statuses: Array<string | null | undefined>): 'ready' | 'stale' | 'disabled' | 'mixed' | null {
  if (statuses.length === 0) return null;
  const s = statuses.map((x) => (x == null ? 'ready' : String(x)));
  if (s.every((x) => x === 'ready')) return 'ready';
  if (s.every((x) => x === 'disabled')) return 'disabled';
  if (s.every((x) => x === 'ready' || x === 'stale')) return 'stale';
  return 'mixed';
}

function uniformFingerprint(fps: Array<string | null | undefined>): string | null {
  const vals = [...new Set(fps.map((f) => (typeof f === 'string' && f ? f : null)))];
  return vals.length === 1 ? vals[0] : null;
}

interface ItemArtifactsRow {
  item_run_id: string;
  item_key: string;
  status: string;
  arts: Array<{ id: string; status: string | null; fp: string | null }>;
}

async function itemsWithArtifacts(q: QueryExecutor, jobId: string): Promise<ItemArtifactsRow[]> {
  return q.query(
    `select g.id as item_run_id, g.item_key, g.status,
            coalesce(json_agg(json_build_object('id', a.id, 'status', a.status, 'fp', a.metadata->>'inputFingerprint')
                              order by a.id) filter (where a.id is not null), '[]'::json) as arts
       from ${effectiveOutputRowsSql('$1')} g
       left join public.artifacts a on a.item_run_id = g.id
      group by g.id, g.item_key, g.status`,
    [jobId],
  );
}

/** Máximo de saltos del linaje fromRun que se recorren buscando artifacts deshabilitados. */
export const MAX_LINEAGE_DEPTH = 32;

/**
 * Items del run A en la forma del core. Además, para cada key del Manifest
 * destino que A NO tiene (toggle OFF→ON, p.ej. video), busca en el linaje
 * fromRun de A (A.fromRunId → …) el item run más cercano cuyos artifacts
 * estén TODOS `disabled`: es el candidato a "REUSE de un deshabilitado que
 * coincida" (spec §3); el core decide con `inputFingerprint`.
 */
export async function loadFromItemsFromDb(
  q: QueryExecutor,
  runA: { id: string; course_id: number; input_payload: any },
  fromKeys: Set<string>,
  toKeys: Set<string>,
): Promise<InvalidationFromItem[]> {
  const out: InvalidationFromItem[] = [];
  for (const r of await itemsWithArtifacts(q, runA.id)) {
    out.push({
      itemKey: r.item_key,
      itemRunId: r.item_run_id,
      status: r.status,
      artifactIds: r.arts.map((a) => a.id),
      artifactStatus: aggregateArtifactStatus(r.arts.map((a) => a.status)),
      inputFingerprint: uniformFingerprint(r.arts.map((a) => a.fp)),
    });
  }
  const have = new Set(out.map((o) => o.itemKey));
  const wanted = new Set([...toKeys].filter((k) => !fromKeys.has(k) && !have.has(k)));
  const seen = new Set<string>([runA.id]);
  let parent: string | null = runA.input_payload?.fromRunId ?? null;
  for (let depth = 0; parent && wanted.size > 0 && depth < MAX_LINEAGE_DEPTH; depth++) {
    if (seen.has(parent)) break;
    seen.add(parent);
    const [row] = await q.query(
      `select id, input_payload from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2`,
      [parent, runA.course_id],
    );
    if (!row) break;
    for (const r of await itemsWithArtifacts(q, row.id)) {
      if (!wanted.has(r.item_key)) continue;
      if (aggregateArtifactStatus(r.arts.map((a) => a.status)) !== 'disabled') continue;
      out.push({
        itemKey: r.item_key,
        itemRunId: r.item_run_id,
        status: r.status,
        artifactIds: r.arts.map((a) => a.id),
        artifactStatus: 'disabled',
        // Sin huella guardada (o no uniforme) → null: el core nunca reutiliza
        // un deshabilitado sin huella (REGENERATE, fix wave).
        inputFingerprint: uniformFingerprint(r.arts.map((a) => a.fp)),
      });
      wanted.delete(r.item_key);
    }
    parent = row.input_payload?.fromRunId ?? null;
  }
  return out;
}

export interface PlanContext {
  runA: { id: string; course_id: number; input_payload: any };
  manifestA: { id: number; rulesVersion: number; manifest: { rulesVersion?: number; items: ManifestItem[] } };
  blueprintA: BlueprintSnapshotV1;
  manifestB: { id: number; rulesVersion: number; manifest: { rulesVersion?: number; items: ManifestItem[] } };
  blueprintB: BlueprintSnapshotV1;
  /** context_hash del run A (B lo hereda). */
  contextHash: string;
}

/** Arma los inputs desde la DB y llama al core puro. */
export async function computePlanFromDb(q: QueryExecutor, ctx: PlanContext): Promise<{ plan: InvalidationPlan; input: InvalidationPlanInput }> {
  const fromKeys = new Set(ctx.manifestA.manifest.items.map((i) => i.key));
  const toKeys = new Set(ctx.manifestB.manifest.items.map((i) => i.key));
  const items = await loadFromItemsFromDb(q, ctx.runA, fromKeys, toKeys);
  const input: InvalidationPlanInput = {
    from: {
      blueprint: ctx.blueprintA,
      manifest: ctx.manifestA.manifest,
      items,
      courseContextSha256: ctx.contextHash,
    },
    to: { blueprint: ctx.blueprintB, manifest: ctx.manifestB.manifest, courseContextSha256: ctx.contextHash },
  };
  return { plan: computeInvalidationPlan(input), input };
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras (pura)
// ─────────────────────────────────────────────────────────────────────────────

export type SeedStatus = 'completed' | 'pending';

export interface ItemSeed {
  itemKey: string;
  type: string;
  moduleId: string | null;
  chapterId: string | null;
  dependsOn: string[];
  status: SeedStatus;
  carriedFromItemRunId: string | null;
  action: InvalidationAction['action'];
  reasons: string[];
  /** Solo REVIEW: marcas `review:<motivo>` que la UI usa para disparar el Coherence (Fase 7). */
  reviewMarks: string[];
}

export interface CarriedArtifactPlan {
  itemKey: string;
  sourceArtifactId: string;
  sourceItemRunId: string;
  /** Status de la fila NUEVA de B: 'stale' solo para STALE_NO_AUTO. */
  status: 'ready' | 'stale';
  action: InvalidationAction['action'];
  reasons: string[];
  /** Huella con la que la fila queda "válida" (null = conservar la del artifact de origen). */
  inputFingerprint: string | null;
  reviewMarks: string[];
}

export interface StatusChangePlan {
  itemKey: string;
  itemRunId: string;
  status: 'stale' | 'disabled';
  action: InvalidationAction['action'];
  reasons: string[];
  /** Solo SOFT_DISABLE: huella con la que el artifact era válido (para un toggle ON posterior). */
  inputFingerprint: string | null;
}

export interface ApplyWrites {
  seeds: ItemSeed[];
  carried: CarriedArtifactPlan[];
  statusChanges: StatusChangePlan[];
  /** Items de video del Manifest destino que el run B va a generar (gasto de Videogen si videoMode='real'). */
  videoItemsToGenerate: string[];
  /**
   * Items reutilizados cuyo origen NO tiene todos los roles de artifact que
   * exige el rulesVersion destino (p.ej. un content v1 reutilizado en un run
   * v2 no tiene `dynamic_context_package_json`): `<key>:<tipo>:missing_role`.
   * El apply falla con 409 si no está vacío (nunca un run B inempaquetable).
   */
  missingRoles: string[];
}

export interface RoleCheck {
  required: (itemType: string) => readonly string[] | undefined;
  typeOf: (artifactId: string) => string | null | undefined;
}

const REUSE_LIKE = new Set(['REUSE', 'REVIEW', 'STALE_NO_AUTO']);

/**
 * PURA. Traduce el plan (+ el Manifest destino, que aporta dependsOn) a las
 * escrituras del apply. Falla fuerte ante un plan incoherente (acción de
 * reuso sin salida de origen, item del destino sin acción, etc.).
 */
export function planApplyWrites(
  plan: InvalidationPlan,
  targetItems: ManifestItem[],
  fromBlueprint: BlueprintSnapshotV1,
  fromContextHash: string | null,
  sourceArtifactStatus: (artifactId: string) => string | null | undefined,
  sourceFingerprint: (artifactId: string) => string | null | undefined,
  roles?: RoleCheck,
): ApplyWrites {
  const byKey = new Map<string, InvalidationAction>();
  for (const a of plan.actions) {
    if (!a.inTargetManifest) continue;
    if (byKey.has(a.itemKey)) throw new Error(`INVALID_INVALIDATION_PLAN: acción duplicada para ${a.itemKey}`);
    byKey.set(a.itemKey, a);
  }
  const fromFp = computeFingerprints(fromBlueprint, { courseContextSha256: fromContextHash });
  const seeds: ItemSeed[] = [];
  const carried: CarriedArtifactPlan[] = [];
  const statusChanges: StatusChangePlan[] = [];
  const videoItemsToGenerate: string[] = [];
  const missingRoles: string[] = [];

  for (const it of targetItems) {
    const a = byKey.get(it.key);
    if (!a) throw new Error(`INVALID_INVALIDATION_PLAN: el item ${it.key} del Manifest destino no tiene acción`);
    byKey.delete(it.key);
    const reuse = REUSE_LIKE.has(a.action);
    if (reuse && (!a.fromItemRunId || a.fromArtifactIds.length === 0)) {
      throw new Error(`INVALID_INVALIDATION_PLAN: ${it.key} es ${a.action} sin item run/artifacts de origen`);
    }
    const reviewMarks = a.action === 'REVIEW' ? a.reasons.map((r) => `review:${r}`) : [];
    seeds.push({
      itemKey: it.key,
      type: it.type,
      moduleId: it.moduleId,
      chapterId: it.chapterId,
      dependsOn: [...it.dependsOn],
      status: reuse ? 'completed' : 'pending',
      carriedFromItemRunId: reuse ? a.fromItemRunId : null,
      action: a.action,
      reasons: [...a.reasons],
      reviewMarks,
    });
    if (reuse && roles) {
      const have = new Set(a.fromArtifactIds.map((id) => roles.typeOf(id)));
      for (const t of roles.required(it.type) ?? []) if (!have.has(t)) missingRoles.push(`${it.key}:${t}:missing_role`);
    }
    if (reuse) {
      for (const artifactId of a.fromArtifactIds) {
        const srcStatus = sourceArtifactStatus(artifactId);
        const srcFp = sourceFingerprint(artifactId) ?? null;
        let fp: string | null;
        if (a.action === 'STALE_NO_AUTO') {
          // El video sigue siendo válido para la huella con la que se generó
          // (la del Blueprint de A si estaba ready), nunca para la del destino.
          fp = srcFp ?? (srcStatus == null || srcStatus === 'ready' ? matchFingerprint(fromFp, it.key) : 'unknown');
        } else {
          fp = a.matchFingerprint;
        }
        carried.push({
          itemKey: it.key,
          sourceArtifactId: artifactId,
          sourceItemRunId: a.fromItemRunId!,
          status: a.action === 'STALE_NO_AUTO' ? 'stale' : 'ready',
          action: a.action,
          reasons: [...a.reasons],
          inputFingerprint: fp,
          reviewMarks,
        });
      }
    }
    // Artifacts de A que dejan de ser vigentes (se conservan como histórico).
    if ((a.action === 'REGENERATE' || a.action === 'STALE_NO_AUTO') && a.fromItemRunId && a.fromArtifactIds.length > 0) {
      statusChanges.push({ itemKey: it.key, itemRunId: a.fromItemRunId, status: 'stale', action: a.action, reasons: [...a.reasons], inputFingerprint: null });
    }
    if (it.type === 'video' && (a.action === 'GENERATE' || a.action === 'REGENERATE')) videoItemsToGenerate.push(it.key);
  }
  const leftovers = [...byKey.keys()];
  if (leftovers.length > 0) {
    throw new Error(`INVALID_INVALIDATION_PLAN: acciones para items que no están en el Manifest destino: ${leftovers.join(', ')}`);
  }
  for (const a of plan.actions) {
    if (a.inTargetManifest || a.action !== 'SOFT_DISABLE') continue;
    if (!a.fromItemRunId || a.fromArtifactIds.length === 0) continue;
    // Huella para un toggle ON posterior: la guardada si existe; si no, la
    // del Blueprint de A (con el que se generó/reutilizó) solo si estaba ready.
    const statuses = a.fromArtifactIds.map((id) => sourceArtifactStatus(id));
    const stored = [...new Set(a.fromArtifactIds.map((id) => sourceFingerprint(id) ?? null))];
    const allReady = statuses.every((s) => s == null || s === 'ready');
    const fp = stored.length === 1 && stored[0] ? stored[0] : allReady ? matchFingerprint(fromFp, a.itemKey) : 'unknown';
    statusChanges.push({ itemKey: a.itemKey, itemRunId: a.fromItemRunId, status: 'disabled', action: a.action, reasons: [...a.reasons], inputFingerprint: fp });
  }
  return { seeds, carried, statusChanges, videoItemsToGenerate, missingRoles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras (DB)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecuteApplyArgs {
  jobB: string;
  runA: string;
  courseId: number;
  manifestB: { id: number; blueprintId: number };
  planSha256: string;
  writes: ApplyWrites;
  sourceArtifacts: Map<string, any>;
  idempotencyKey: (itemKey: string) => string;
}

/**
 * Ejecuta las escrituras dentro de la transacción del caller (que ya tomó el
 * lock del curso). Devuelve el mapa itemKey → item run de B.
 */
export async function executeApplyWrites(qr: QueryExecutor, args: ExecuteApplyArgs): Promise<Map<string, string>> {
  const { jobB, runA, courseId, manifestB, planSha256, writes } = args;
  const itemRunIds = new Map<string, string>();

  // 1) item runs de B (en el orden del Manifest destino).
  for (const s of writes.seeds) {
    const summary: Record<string, any> = {
      invalidation: { action: s.action, reasons: s.reasons, fromRunId: runA, fromItemRunId: s.carriedFromItemRunId, planSha256 },
    };
    if (s.reviewMarks.length) summary.reviewMarks = s.reviewMarks;
    let carriedSummary: Record<string, any> = {};
    if (s.carriedFromItemRunId) {
      const [src] = await qr.query(`select output_summary from public.generation_item_runs where id = $1`, [s.carriedFromItemRunId]);
      if (!src) throw new Error(`apply: el item run de origen ${s.carriedFromItemRunId} (${s.itemKey}) no existe`);
      // Se conserva el output_summary del origen (marcas contextSummary, hashes del Context Package…).
      const { invalidation: _i, reviewMarks: _r, ...rest } = src.output_summary ?? {};
      carriedSummary = rest;
    }
    const [row] = await qr.query(
      `insert into public.generation_item_runs
         (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
          depends_on, idempotency_key, status, output_summary, finished_at, carried_from_item_run_id)
       values ($1, $2, $3, $4, $5, 1, $6, $7::uuid, $8::uuid, $9::text[], $10, $11, $12::jsonb,
               case when $11 = 'completed' then now() else null end, $13::uuid)
       returning id`,
      [jobB, courseId, manifestB.blueprintId, manifestB.id, s.itemKey, s.type, s.moduleId, s.chapterId, s.dependsOn,
        args.idempotencyKey(s.itemKey), s.status, JSON.stringify({ ...carriedSummary, ...summary }), s.carriedFromItemRunId],
    );
    itemRunIds.set(s.itemKey, row.id);
  }

  // 2) filas de artifact "carried": MISMA storage_path inmutable, fila nueva vinculada a B.
  const carriedIdsByKey = new Map<string, string[]>();
  for (const c of writes.carried) {
    const src = args.sourceArtifacts.get(c.sourceArtifactId);
    if (!src) throw new Error(`apply: el artifact de origen ${c.sourceArtifactId} (${c.itemKey}) no existe`);
    if (src.item_run_id !== c.sourceItemRunId) {
      throw new Error(`apply: el artifact ${c.sourceArtifactId} ya no está vinculado al item run ${c.sourceItemRunId}`);
    }
    const seed = writes.seeds.find((s) => s.itemKey === c.itemKey)!;
    const srcMeta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
    const { staleReason: _s, disabledReason: _d, review: _rv, ...keepMeta } = srcMeta;
    const metadata = {
      ...keepMeta,
      inputFingerprint: c.inputFingerprint ?? srcMeta.inputFingerprint ?? null,
      carriedFrom: {
        artifactId: src.id,
        itemRunId: c.sourceItemRunId,
        runId: runA,
        action: c.action,
        reasons: c.reasons,
        planSha256,
        sourceStatus: src.status ?? null,
      },
      ...(c.reviewMarks.length ? { review: c.reviewMarks } : {}),
    };
    const [ins] = await qr.query(
      `insert into public.artifacts
         (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type,
          size_bytes, checksum_sha256, metadata, module_id, chapter_id, status, generated_with_version_id,
          manifest_id, manifest_item_key, item_run_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::uuid, $14::uuid, $15, $16, $17, $18, $19::uuid)
       returning id`,
      [src.owner_id, src.course_id, jobB, src.type, src.storage_provider, src.storage_bucket, src.storage_path, src.filename,
        src.mime_type, src.size_bytes, src.checksum_sha256, JSON.stringify(metadata), seed.moduleId, seed.chapterId, c.status,
        src.generated_with_version_id, manifestB.id, c.itemKey, itemRunIds.get(c.itemKey)],
    );
    carriedIdsByKey.set(c.itemKey, [...(carriedIdsByKey.get(c.itemKey) ?? []), ins.id]);
  }

  // 2b) output_summary.artifactIds del item de B = SUS filas carried (no las de A; fix wave M3).
  for (const [itemKey, ids] of carriedIdsByKey) {
    await qr.query(
      `update public.generation_item_runs
          set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('artifactIds', $2::jsonb)
        where id = $1`,
      [itemRunIds.get(itemKey), JSON.stringify([...ids].sort())],
    );
  }

  // 3) artifacts de A: solo status + motivo (nunca storage_path, nunca delete).
  for (const ch of writes.statusChanges) {
    const reasonKey = ch.status === 'stale' ? 'staleReason' : 'disabledReason';
    const reason = { action: ch.action, reasons: ch.reasons, byRunId: jobB, planSha256, itemKey: ch.itemKey };
    const extra: Record<string, any> = { [reasonKey]: reason };
    if (ch.status === 'disabled') extra.inputFingerprint = ch.inputFingerprint;
    // stale nunca pisa un disabled; disabled se aplica sobre ready/stale.
    await qr.query(
      `update public.artifacts
          set status = $2,
              metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($4::text, ($3::jsonb)->$4::text)
                         || case when $5::boolean then jsonb_build_object('disabledFromStatus', coalesce(status, 'ready'),
                                                                          'inputFingerprint', ($3::jsonb)->'inputFingerprint')
                                 else '{}'::jsonb end,
              updated_at = now()
        where item_run_id = $1 and coalesce(status, 'ready') <> 'disabled'`,
      [ch.itemRunId, ch.status, JSON.stringify(extra), reasonKey, ch.status === 'disabled'],
    );
  }
  return itemRunIds;
}
