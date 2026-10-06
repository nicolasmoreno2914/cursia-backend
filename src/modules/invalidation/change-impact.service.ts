import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assembleLockSnapshotV2, loadLockRows, plainCourseRefV2 } from '../course-blueprints/lock-snapshot';
import { BlueprintSnapshotV2, RawChapterRowV2, RawModuleRow, buildBlueprintSnapshotV2, snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { GenerationManifestsService } from '../generation-manifests/generation-manifests.service';
import { GenerationManifestV1, buildGenerationManifestV3 } from '../generation-manifests/generation-manifest-builder';
import { activityTypeRulesForNextManifest } from '../generation-manifests/manifest-rules-config';
import { canonicalContextHash } from '../dynamic-generation/run-hash';
import { providerPlanFor, runPedagogyDryRun } from '../pedagogy/dry-run';
import { profileTargetHours } from '../pedagogy/pedagogy-profile';
import type { ProposedModule } from '../study-time/distributor';
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

    // «Hasta»: lo que el lock congelaría hoy (con el perfil de vista previa si viene). Un perfil o una propuesta que el
    // motor no puede evaluar es un 400, nunca un 500 (review F5 I1).
    const rows = await loadLockRows(this.dataSource, courseId);
    // LOOP 7 (A2 A3): las reglas de actividad del PRÓXIMO Manifest (las que se congelarán): fuente única.
    let atrNext: 0 | 1 | 2;
    try {
      atrNext = await activityTypeRulesForNextManifest(this.dataSource, courseId);
    } catch (err) {
      throw new BadRequestException(`Configuración inválida de reglas de actividad: ${(err as Error).message}`);
    }
    const bad = (err: unknown) => new BadRequestException((err instanceof Error ? err.message : String(err)).slice(0, 500));
    const assemble = async (r: typeof rows, override: { profileOverride?: unknown }) => {
      let a: Awaited<ReturnType<typeof assembleLockSnapshotV2>>;
      try { a = await assembleLockSnapshotV2(this.dataSource, course, r, override); } catch (err) { throw bad(err); }
      if (!a.snapshot) throw new BadRequestException(`La estructura actual no se puede evaluar: ${a.errors.map((e) => e.message).join('; ')}`);
      return a as typeof a & { snapshot: BlueprintSnapshotV2 };
    };
    const assembled = await assemble(rows, body.profile !== undefined ? { profileOverride: body.profile } : {});
    let to: BlueprintSnapshotV2 = assembled.snapshot;
    let distribution: { status: string; applicable: boolean; estimatedHours: number; proposalSha256: string; changes: unknown[] } | null = null;
    if (body.applyDistribution) {
      const profile = assembled.profile;
      let targetHours: number | null;
      try { targetHours = profileTargetHours(profile); } catch (err) { throw bad(err); }
      if (targetHours === null) throw new BadRequestException({ code: 'NO_TARGET_HOURS', message: 'NO_TARGET_HOURS: sin horas objetivo no hay propuesta que aplicar.' });
      // Review F5 I3: EXACTAMENTE el cálculo de «Aplicar diseño» (course-structure.service): dry-run sobre la estructura
      // viva con las reglas de actividad configuradas; luego la propuesta se aplica a las filas EN MEMORIA como lo haría
      // el apply (insertar capítulos propuestos, reordenar, minutos de aplicación) y el Blueprint sale del mismo
      // ensamblado que el lock. Así lo previsualizado es lo que se confirmaría.
      // LOOP 7 (A1 I2): datos del curso de la fuente única (los mismos que el lock y que «Aplicar diseño»).
      const courseRef = plainCourseRefV2(course, assembled.snapshot.course.academicContext ?? null);
      let dist: NonNullable<ReturnType<typeof runPedagogyDryRun>['distribution']>;
      try {
        const dr = runPedagogyDryRun({ structure: buildBlueprintSnapshotV2(courseRef as any, rows.modules, rows.chapters), profile, activityTypeRules: atrNext });
        if (!dr.distribution) throw new Error('NO_TARGET_HOURS: sin horas objetivo no hay propuesta que aplicar.');
        dist = dr.distribution;
      } catch (err) { throw bad(err); }
      const applicable = dist.status !== 'minimum_exceeds_target' && !dist.materialized.manifestErrors.length;
      distribution = { status: dist.status, applicable, estimatedHours: dist.estimatedHours, proposalSha256: dist.proposalSha256, changes: dist.changes };
      // Una propuesta que «Aplicar diseño» rechazaría no se previsualiza como aplicada: el impacto es el de hoy.
      if (applicable) to = (await assemble(applyProposalToRows(rows, dist.modules), { profileOverride: profile })).snapshot;
    }

    // «Desde»: el último run TERMINADO con al menos un item completado (el mismo criterio de la regeneración real,
    // dynInvFindPreviousRun): un run activo o vacío no es lo «ya generado» (review F5 I2).
    const runFilter = `execution_mode = 'dynamic_generation' and course_id = $1 and owner_id = $2
          and coalesce(worker_status, '') in ('completed', 'preview', 'failed', 'cancelled')
          and exists (select 1 from public.generation_item_runs gi where gi.job_id = production_jobs.id and gi.status = 'completed')`;
    let runA: any;
    if (body.fromRunId) {
      [runA] = await this.dataSource.query(`select * from public.production_jobs where id = $3 and execution_mode = 'dynamic_generation' and course_id = $1 and owner_id = $2`, [courseId, ownerId, body.fromRunId]);
      if (!runA) throw new NotFoundException(`Run ${body.fromRunId} not found`);
      [runA] = await this.dataSource.query(`select * from public.production_jobs where id = $3 and ${runFilter}`, [courseId, ownerId, body.fromRunId]);
      if (!runA) throw new BadRequestException({ code: 'RUN_NOT_FINISHED', message: 'RUN_NOT_FINISHED: la generación indicada sigue en curso o no completó ningún recurso.' });
    } else {
      [runA] = await this.dataSource.query(`select * from public.production_jobs where ${runFilter} order by created_at desc, id desc limit 1`, [courseId, ownerId]);
    }
    const source = { courseId, blueprintId: 0, blueprintNumber: 0, blueprintSha256: snapshotSha256V2(to) };
    if (!runA) {
      const manifestB = buildGenerationManifestV3(to, source, { activityTypeRules: atrNext });
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
    const manifestB = buildGenerationManifestV3(to, source, { activityTypeRules: atrNext });
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

/**
 * La propuesta del distribuidor aplicada a las filas en memoria, igual que «Aplicar diseño» (course-structure.service):
 * capítulos propuestos insertados en su posición (práctica: sin video), los existentes reordenados con sus minutos de
 * Actividad de Aplicación. Nada se escribe.
 */
export function applyProposalToRows(
  rows: { modules: RawModuleRow[]; chapters: RawChapterRowV2[] },
  modules: ProposedModule[],
): { modules: RawModuleRow[]; chapters: RawChapterRowV2[] } {
  const byId = new Map(rows.chapters.map((c) => [String(c.id), c]));
  const touched = new Set<string>();
  const chapters: RawChapterRowV2[] = [];
  for (const m of modules) {
    m.chapters.forEach((c, ci) => {
      if (c.proposed) {
        const practice = c.kind === 'practice';
        chapters.push({
          id: c.id, module_id: m.id, position: ci, title: c.title, objective: c.objective, description: null,
          video_enabled: practice ? false : c.videoEnabled, activity_enabled: c.activityEnabled,
          chapter_kind: practice ? 'practice' : null, application_minutes: c.applicationMinutes, outcome_ids: null,
        } as unknown as RawChapterRowV2);
      } else {
        const row = byId.get(String(c.id));
        if (!row) return;
        touched.add(String(c.id));
        chapters.push({ ...row, position: ci, application_minutes: c.applicationMinutes } as RawChapterRowV2);
      }
    });
  }
  for (const c of rows.chapters) if (!touched.has(String(c.id))) chapters.push(c);
  return { modules: rows.modules, chapters };
}
