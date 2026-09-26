import { ConflictException, Injectable, NotFoundException, NotImplementedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GenerationManifestsService } from '../generation-manifests/generation-manifests.service';
import type { ManifestItemType } from '../generation-manifests/generation-manifest-builder';
import { requiredArtifactTypes } from '../dynamic-packaging/artifact-resolver';
import { assertDynamicOwnerAllowed, isRealVideoAllowedForOwner, toHttpConfigError } from '../features/dynamic-features';
import { ACTIVE_RUN_WORKER_STATUSES } from '../dynamic-generation/item-transitions';
import { canonicalContextHash } from '../dynamic-generation/run-hash';
import { computePlanFromDb, planApplyWrites } from './invalidation-apply';
import type { InvalidationPlan } from './plan';
import { INVALIDATION_V3_NOT_IMPLEMENTED, assertInvalidationRulesSupported } from './plan';

export interface InvalidationPlanResponse {
  /** true: ya existe el run B de este par (A, Mb) — se devuelve el plan que se aplicó. */
  applied: boolean;
  existingRunId: string | null;
  fromRunId: string;
  fromManifestId: number;
  fromBlueprintNumber: number;
  toManifestId: number;
  toBlueprintNumber: number;
  toRulesVersion: number;
  videoMode: string;
  /** Videos que el run B generaría (gasto de Videogen si videoMode='real'). */
  videoItemsToGenerate: string[];
  /**
   * Todo lo que haría fallar el apply (fix wave M2), para que la UI avise
   * ANTES de confirmar; vacío = aplicable:
   * - `superseded_by:<runId>`: A ya fue reemplazado por otro run (409);
   * - `manifest_has_other_run:<runId>`: el Manifest destino ya tiene un run que no sale de A (409);
   * - `active_run:<runId>`: hay otro run activo en el curso (409);
   * - `real_video_not_allowed`: B generaría videos reales y el owner no está habilitado (403);
   * - `<key>:<tipo>:missing_role`: reutilizar dejaría roles v2 faltantes (409 reuse_missing_roles).
   * (La allow-list V2 ya responde 403 a este mismo GET.)
   */
  blockers: string[];
  plan: InvalidationPlan;
}

/**
 * Fase 8 (F8-BE): `GET …/manifest/invalidation-plan?fromRun=<runA>` — dry-run
 * SIN escrituras. Arma los inputs desde la DB (Blueprint/Manifest de A y del
 * Blueprint `n` con la rulesVersion configurada, items + artifacts de A y su
 * linaje) y llama al core puro `computeInvalidationPlan`. El apply real es
 * `POST …/manifest/runs {fromRun}` (RunsService.startRun).
 */
@Injectable()
export class InvalidationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
  ) {}

  async getPlan(courseId: number, ownerId: string, blueprintNumber: number, fromRunId: string): Promise<InvalidationPlanResponse> {
    assertDynamicOwnerAllowed(ownerId);
    const manifestB = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const [rowA] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2 and owner_id = $3`,
      [fromRunId, courseId, ownerId],
    );
    if (!rowA) throw new NotFoundException(`La ejecución de origen ${fromRunId} no existe para el curso #${courseId}`);
    const bpNumberA = Number(rowA.input_payload?.blueprintNumber);
    const manifestA = await this.manifests.getById(courseId, ownerId, bpNumberA, Number(rowA.input_payload?.manifestId));
    // V2.1 (R4): invalidación v3 = R5. 501 explícito antes de leer Blueprints (fail loud).
    try {
      assertInvalidationRulesSupported(manifestA.rulesVersion, manifestB.rulesVersion);
    } catch (err) {
      throw new NotImplementedException({ code: INVALIDATION_V3_NOT_IMPLEMENTED, message: (err as Error).message });
    }
    if (manifestA.id === manifestB.id) {
      throw new ConflictException(
        `La ejecución ${fromRunId} ya es del Manifest #${manifestB.id}: no hay cambio de estructura que aplicar. runId=${fromRunId}`,
      );
    }
    const base = {
      fromRunId,
      fromManifestId: manifestA.id,
      fromBlueprintNumber: bpNumberA,
      toManifestId: manifestB.id,
      toBlueprintNumber: blueprintNumber,
      toRulesVersion: manifestB.rulesVersion,
      // Misma normalización que RunsService.videoModeOf ('mock' por defecto).
      videoMode: rowA.input_payload?.videoMode === 'real' ? 'real' : 'mock',
    };

    const [existing] = await this.dataSource.query(
      `select id, input_payload, output_summary from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'manifestId' = $1
          and input_payload->>'fromRunId' = $2
        order by created_at desc, id desc limit 1`,
      [String(manifestB.id), fromRunId],
    );
    if (existing?.output_summary?.invalidation?.plan) {
      const plan: InvalidationPlan = existing.output_summary.invalidation.plan;
      return {
        ...base,
        applied: true,
        existingRunId: existing.id,
        videoItemsToGenerate: plan.actions
          .filter((a) => a.inTargetManifest && a.type === 'video' && (a.action === 'GENERATE' || a.action === 'REGENERATE'))
          .map((a) => a.itemKey),
        blockers: [],
        plan,
      };
    }

    const [ctx] = await this.dataSource.query(
      `select context, context_hash from public.generation_run_contexts where job_id = $1`,
      [rowA.id],
    );
    if (!ctx || canonicalContextHash(ctx.context) !== ctx.context_hash) {
      throw new ConflictException(`La ejecución ${fromRunId} no tiene un contexto congelado íntegro`);
    }
    const [bpA, bpB] = await Promise.all([
      this.manifests.blueprintOf(courseId, ownerId, bpNumberA),
      this.manifests.blueprintOf(courseId, ownerId, blueprintNumber),
    ]);
    const { plan } = await computePlanFromDb(this.dataSource, {
      runA: rowA,
      manifestA,
      blueprintA: bpA.snapshot,
      manifestB,
      blueprintB: bpB.snapshot,
      contextHash: ctx.context_hash,
    });
    const ids = [...new Set(plan.actions.flatMap((a) => a.fromArtifactIds))];
    const rows: any[] = ids.length
      ? await this.dataSource.query(`select id, type, status, metadata from public.artifacts where id = any($1::uuid[])`, [ids])
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const writes = planApplyWrites(
      plan,
      manifestB.manifest.items,
      bpA.snapshot,
      ctx.context_hash,
      (id) => byId.get(id)?.status ?? null,
      (id) => byId.get(id)?.metadata?.inputFingerprint ?? null,
      { required: (t) => requiredArtifactTypes(manifestB.rulesVersion, t as ManifestItemType), typeOf: (id) => byId.get(id)?.type },
    );
    const blockers: string[] = [];
    const [superseding] = await this.dataSource.query(
      `select id from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'fromRunId' = $1
        order by created_at desc, id desc limit 1`,
      [fromRunId],
    );
    if (superseding) blockers.push(`superseded_by:${superseding.id}`);
    const [otherOnMb] = await this.dataSource.query(
      `select id from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'manifestId' = $1
        order by created_at desc, id desc limit 1`,
      [String(manifestB.id)],
    );
    if (otherOnMb) blockers.push(`manifest_has_other_run:${otherOnMb.id}`);
    const [active] = await this.dataSource.query(
      `select id from public.production_jobs
        where execution_mode = 'dynamic_generation' and course_id = $1
          and input_payload->>'manifestId' is distinct from $2
          and worker_status = any($3::text[])
          and coalesce(status, '') not in ('cancelled', 'cancelling')
        order by created_at desc, id desc limit 1`,
      [courseId, String(manifestB.id), ACTIVE_RUN_WORKER_STATUSES],
    );
    if (active) blockers.push(`active_run:${active.id}`);
    if (base.videoMode === 'real' && writes.videoItemsToGenerate.length > 0) {
      let allowed = false;
      try {
        allowed = isRealVideoAllowedForOwner(ownerId);
      } catch (err) {
        toHttpConfigError(err);
      }
      if (!allowed) blockers.push('real_video_not_allowed');
    }
    blockers.push(...writes.missingRoles);
    return {
      ...base,
      applied: false,
      existingRunId: null,
      videoItemsToGenerate: writes.videoItemsToGenerate,
      blockers,
      plan,
    };
  }
}
