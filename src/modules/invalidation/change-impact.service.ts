import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assembleLockSnapshotV2, loadLockRows } from '../course-blueprints/lock-snapshot';
import { BlueprintSnapshotV2, snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { GenerationManifestsService } from '../generation-manifests/generation-manifests.service';
import { GenerationManifestV1, buildGenerationManifestV3 } from '../generation-manifests/generation-manifest-builder';
import { readActivityTypeRulesConfig } from '../generation-manifests/manifest-rules-config';
import { canonicalContextHash } from '../dynamic-generation/run-hash';
import { deriveDesignRulesOrNull } from '../pedagogy/design-rules';
import { applyPedagogyToSnapshot } from '../pedagogy/pedagogical-blueprint';
import { materializeDistribution, providerPlanFor, withApplicationContext, withTargetHours } from '../pedagogy/dry-run';
import { profileApplicationContext, profileDesignPreferences, profileTargetHours } from '../pedagogy/pedagogy-profile';
import { distributeCourseHours } from '../study-time/distributor';
import { estimateCourseStudyTime } from '../study-time/time-model';
import { studyTimeInputFromManifest } from '../study-time/manifest-input';
import { computePlanFromDb } from './invalidation-apply';
import { dependencyTable, summarizeChangeImpact } from './change-impact';

export interface ChangeImpactRequest {
  /** Run de origen (default: el último run del curso). */
  fromRunId?: string;
  /** Perfil pedagógico de vista previa (sin guardar): otro enfoque, otras horas… Ausente = el guardado. */
  profile?: unknown;
  /** true = aplicar además la propuesta del distribuidor («Aplicar diseño») para las horas objetivo del perfil. */
  applyDistribution?: boolean;
}

/**
 * Fase 5 — vista previa del impacto de los cambios (sin escrituras, sin proveedores, USD 0).
 *
 * «Desde» = el último run del curso (lo que ya se generó). «Hasta» = el Blueprint que el lock congelaría HOY
 * (assembleLockSnapshotV2: estructura viva + perfil vigente o el de vista previa + contexto académico), opcionalmente
 * con la propuesta del distribuidor aplicada en memoria. Entre ambos corre el MISMO plan de invalidación v3 que usa la
 * regeneración real (huellas por item): qué se regenera, qué queda intacto, qué pagado queda marcado, y su costo
 * simulado. Nada se confirma ni se destruye: para aplicarlo el docente confirma la estructura y genera como siempre.
 */
@Injectable()
export class ChangeImpactService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
  ) {}

  async preview(courseId: number, ownerId: string, body: ChangeImpactRequest) {
    assertDynamicOwnerAllowed(ownerId);
    const allowUnowned = process.env.ALLOW_UNOWNED_COURSES === 'true';
    const [course] = await this.dataSource.query(
      `select id, title, structure_version, final_exam_enabled, activity_engine,
              (to_jsonb(courses) ->> 'review_cards_enabled')::boolean as review_cards_enabled
         from public.courses where id = $1 and (owner_id = $2 or ($3 = true and owner_id is null))`,
      [courseId, ownerId, allowUnowned],
    );
    if (!course) throw new NotFoundException(`Course #${courseId} not found`);
    if (course.structure_version !== 'dynamic') throw new BadRequestException(`El curso #${courseId} no es "dynamic".`);

    // «Hasta»: lo que el lock congelaría hoy (con el perfil de vista previa si viene).
    const rows = await loadLockRows(this.dataSource, courseId);
    const asBad = <T>(fn: () => T): T => {
      try { return fn(); } catch (err) { throw new BadRequestException((err instanceof Error ? err.message : String(err)).slice(0, 500)); }
    };
    const assembled = await assembleLockSnapshotV2(this.dataSource, course, rows, body.profile !== undefined ? { profileOverride: body.profile } : {});
    if (!assembled.snapshot) throw new BadRequestException(`La estructura actual no se puede evaluar: ${assembled.errors.map((e) => e.message).join('; ')}`);
    let to: BlueprintSnapshotV2 = assembled.snapshot;
    let distribution: { status: string; estimatedHours: number; changes: unknown[] } | null = null;
    if (body.applyDistribution) {
      const profile = assembled.profile;
      const targetHours = asBad(() => profileTargetHours(profile));
      if (targetHours === null) throw new BadRequestException({ code: 'NO_TARGET_HOURS', message: 'NO_TARGET_HOURS: sin horas objetivo no hay propuesta que aplicar.' });
      const rules = asBad(() => deriveDesignRulesOrNull(profile));
      // Mismo camino que el dry-run: el distribuidor dimensiona sobre lo que el lock congelaría (estructura + diseño).
      const appContext = profileApplicationContext(profile);
      const base0 = withTargetHours(stripDesign(to), targetHours);
      const base = appContext ? withApplicationContext(base0, appContext) : base0;
      const lockShaped = rules ? applyPedagogyToSnapshot(base, rules) : base;
      const dist = asBad(() => distributeCourseHours({ snapshot: lockShaped, rules, targetHours, activityTypeRules: 2, preferences: profileDesignPreferences(profile) }));
      const plain = materializeDistribution(lockShaped, dist, appContext);
      to = rules ? applyPedagogyToSnapshot(plain, rules) : plain;
      distribution = { status: dist.status, estimatedHours: dist.estimatedHours, changes: dist.changes };
    }

    // «Desde»: el último run del curso.
    const [runA] = body.fromRunId
      ? await this.dataSource.query(`select * from public.production_jobs where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2 and owner_id = $3`, [body.fromRunId, courseId, ownerId])
      : await this.dataSource.query(
        `select * from public.production_jobs where execution_mode = 'dynamic_generation' and course_id = $1 and owner_id = $2
          order by created_at desc, id desc limit 1`,
        [courseId, ownerId],
      );
    const source = { courseId, blueprintId: 0, blueprintNumber: 0, blueprintSha256: snapshotSha256V2(to) };
    if (!runA) {
      const manifestB = buildGenerationManifestV3(to, source, { activityTypeRules: readActivityTypeRulesConfig() });
      return {
        available: false as const, reason: 'NO_PREVIOUS_RUN', dryRun: true, providersCalled: 0, spendUsd: '0.00',
        message: 'El curso todavía no se generó: no hay nada que conservar. Generarlo completo costaría lo estimado.',
        fullGeneration: providerPlanFor(manifestB),
        hours: estimateCourseStudyTime(studyTimeInputFromManifest(manifestB, to)).courseEstimatedHours,
        distribution,
        dependencies: dependencyTable(),
      };
    }
    const bpNumberA = Number(runA.input_payload?.blueprintNumber);
    const manifestA = await this.manifests.getById(courseId, ownerId, bpNumberA, Number(runA.input_payload?.manifestId));
    if (manifestA.rulesVersion !== 3) throw new BadRequestException('La vista previa del impacto necesita un run con reglas v3.');
    const blueprintA = (await this.manifests.blueprintOfForRules(courseId, ownerId, bpNumberA, manifestA.rulesVersion)).snapshot as BlueprintSnapshotV2;
    const [ctx] = await this.dataSource.query(`select context, context_hash from public.generation_run_contexts where job_id = $1`, [runA.id]);
    if (!ctx || canonicalContextHash(ctx.context) !== ctx.context_hash) throw new BadRequestException(`La ejecución ${runA.id} no tiene un contexto congelado íntegro`);
    const atr = (manifestA.manifest as GenerationManifestV1).features?.activityTypeRules ?? 0;
    const manifestB = buildGenerationManifestV3(to, source, { activityTypeRules: atr as 0 | 1 | 2 });
    const { plan } = await computePlanFromDb(this.dataSource, {
      runA, manifestA, blueprintA, manifestB: { manifest: manifestB } as any, blueprintB: to, contextHash: ctx.context_hash,
    });
    const impact = summarizeChangeImpact({
      plan,
      to: { blueprint: to, manifest: manifestB, studyTime: estimateCourseStudyTime(studyTimeInputFromManifest(manifestB, to)) },
      from: { manifest: manifestA.manifest as GenerationManifestV1, studyTime: estimateCourseStudyTime(studyTimeInputFromManifest(manifestA.manifest as GenerationManifestV1, blueprintA)) },
    });
    return {
      available: true as const,
      fromRunId: runA.id,
      fromBlueprintNumber: bpNumberA,
      blueprintChanged: snapshotSha256V2(to) !== snapshotSha256V2(blueprintA),
      impact,
      distribution,
      dependencies: dependencyTable(),
    };
  }
}

/** Blueprint sin el diseño pedagógico (el distribuidor parte de la estructura y vuelve a aplicar las reglas). */
function stripDesign(s: BlueprintSnapshotV2): BlueprintSnapshotV2 {
  const { pedagogy: _p, ...course } = s.course as any;
  return {
    ...s,
    course,
    modules: s.modules.map((m) => {
      const { design: _md, ...mm } = m as any;
      return { ...mm, chapters: m.chapters.map((c) => { const { design: _cd, ...cc } = c as any; return cc; }) };
    }),
  } as BlueprintSnapshotV2;
}
