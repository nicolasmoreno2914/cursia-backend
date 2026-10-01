import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PackagingService } from './packaging.service';
import { RunsService } from '../dynamic-generation/runs.service';
import {
  AUTO_PACKAGE_MAX_ATTEMPTS,
  AUTO_PACKAGE_MAX_TRANSIENT,
  autoPackageEnabled,
  autoPackageMarkOf,
  findAutoPackageCandidates,
  loadAutoPackageState,
} from './auto-package-state';
import { isDynamicCourseStructureEnabled } from '../features/dynamic-features';

export type AutoPackageOutcome =
  | { action: 'enqueued' | 'reused'; runId: string; jobId: string; status: string }
  | { action: 'skipped'; runId: string; reason: string }
  | { action: 'blocked'; runId: string; code: string };

/**
 * EV6 DoD BE-B — empaque final AUTOMÁTICO (ver auto-package-state.ts para las reglas).
 *
 * - `onModuleInit`: se suscribe a «el run pasó a completed» de RunsService (aviso DESPUÉS del commit).
 *   Corre en cualquier proceso que cargue AppModule (API o workers): encolar es solo un INSERT del job
 *   `dynamic_package`; lo construye el worker de empaquetado de siempre.
 * - `ensure(runId)`: idempotente. Solo runs `completed` con la marca de BE-B; usa el MISMO
 *   get-or-create de PackagingService (assertRunReady + precheck v3 + clave de reuse + lock por run), así
 *   un disparo repetido, el barrido y el botón manual nunca arman dos veces. Un precheck que no deja
 *   encolar (409, p.ej. un video sin publicar en YouTube) queda registrado en la marca del run
 *   (`autoPackage.blocked`, solo el código) → `completion.state='needs_attention'` + `retry_package`.
 * - `sweep()`: lo corre el tick del auto-healer (solo la API, main.ts): runs marcados sin paquete vigente
 *   ni job activo (disparo perdido / job fallido), con tope de intentos y espera.
 */
@Injectable()
export class AutoPackageService implements OnModuleInit {
  private readonly logger = new Logger(AutoPackageService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly packaging: PackagingService,
    @Optional() private readonly runs?: RunsService,
  ) {}

  onModuleInit(): void {
    this.runs?.onRunCompleted((runId) => this.ensure(runId, 'transition'));
  }

  async ensure(runId: string, source: 'transition' | 'sweep' = 'transition', env: Record<string, string | undefined> = process.env): Promise<AutoPackageOutcome> {
    if (!autoPackageEnabled(env) || !isDynamicCourseStructureEnabled(env)) return { action: 'skipped', runId, reason: 'disabled' };
    const [run] = await this.dataSource.query(
      `select r.id, r.owner_id, r.course_id, r.status, r.worker_status, r.output_summary, b.blueprint_number, m.rules_version
         from public.production_jobs r
         left join public.course_generation_manifests m on m.id = (r.input_payload->>'manifestId')::bigint
         left join public.course_blueprints b on b.id = m.blueprint_id
        where r.id = $1 and r.execution_mode = 'dynamic_generation'`,
      [runId],
    );
    if (!run) return { action: 'skipped', runId, reason: 'not_found' };
    if (run.worker_status !== 'completed') return { action: 'skipped', runId, reason: `not_completed:${run.worker_status}` };
    const mark = autoPackageMarkOf(run);
    // Runs completados antes de BE-B: nunca se empaquetan solos (no se tocan).
    if (!mark) return { action: 'skipped', runId, reason: 'not_eligible' };
    if (mark.blocked) return { action: 'skipped', runId, reason: `blocked:${mark.blocked.code}` };
    const state = await loadAutoPackageState(this.dataSource, run, new Date(), env, Number(run.rules_version ?? 3));
    if (state.failedSinceMark >= AUTO_PACKAGE_MAX_ATTEMPTS) return { action: 'skipped', runId, reason: 'attempts_exhausted' };
    if (mark.transient.count >= AUTO_PACKAGE_MAX_TRANSIENT) return { action: 'skipped', runId, reason: 'transient_exhausted' };
    // El barrido solo actúa sobre lo que el estado declara pendiente (misma regla que RunDto.completion).
    if (source === 'sweep' && !state.autoRetryPending && !state.rebuildPending) return { action: 'skipped', runId, reason: 'nothing_pending' };
    const bp = Number(run.blueprint_number);
    if (!Number.isInteger(bp)) return { action: 'skipped', runId, reason: 'manifest_unresolvable' };
    try {
      const res = await this.packaging.requestPackage(Number(run.course_id), String(run.owner_id), bp, runId, undefined, { auto: true });
      if (!res.created && res.status === 'completed') {
        // Fix round 1 (M2): el paquete completado ES el build vigente → confirmado (el barrido no lo vuelve a mirar).
        await this.dataSource.query(
          `update public.production_jobs
              set output_summary = jsonb_set(output_summary, '{autoPackage,satisfiedJobId}', to_jsonb($2::text), true)
            where id = $1 and jsonb_typeof(output_summary->'autoPackage') = 'object'`,
          [runId, res.jobId],
        );
      }
      this.logger.log(`empaque automático (${source}): run ${runId} → job ${res.jobId} (${res.created ? 'encolado' : `reusado, ${res.status}`})`);
      return { action: res.created ? 'enqueued' : 'reused', runId, jobId: res.jobId, status: res.status };
    } catch (err) {
      const resp = (err as { getResponse?: () => unknown })?.getResponse?.() as any;
      const status = (err as { getStatus?: () => number })?.getStatus?.();
      const missing: string[] = Array.isArray(resp?.missing) ? resp.missing.filter((x: unknown) => typeof x === 'string').slice(0, 50).map((x: string) => x.slice(0, 200)) : [];
      const code = String((resp && typeof resp === 'object' && resp.code) || (missing.length ? 'package_not_ready' : status ? `http_${status}` : 'error')).slice(0, 80);
      if (status && status >= 400 && status < 500) {
        // Fix round 1 (I2): el run no se puede empaquetar tal como está. Queda registrado el código, el mensaje
        // (para el admin) y lo que falta; la acción de admin es la del componente que lo bloquea (nunca un
        // retry_package que devolvería el mismo 409/403). Sin reintentos solos.
        const message = String((resp && typeof resp === 'object' && typeof resp.message === 'string' ? resp.message : (err as Error)?.message) ?? '').slice(0, 400);
        await this.dataSource.query(
          `update public.production_jobs
              set output_summary = jsonb_set(output_summary, '{autoPackage,blocked}',
                    jsonb_build_object('code', $2::text, 'message', $3::text, 'missing', $4::jsonb, 'at', now()), true),
                  updated_at = now()
            where id = $1 and jsonb_typeof(output_summary->'autoPackage') = 'object'`,
          [runId, code, message, JSON.stringify(missing)],
        );
        this.logger.warn(`empaque automático (${source}): run ${runId} no se puede empaquetar (${code}); queda para un admin`);
        return { action: 'blocked', runId, code };
      }
      // Fix round 1 (M1): error transitorio (DB, red) — cuenta contra su propio tope, con espera.
      await this.dataSource.query(
        `update public.production_jobs
            set output_summary = jsonb_set(output_summary, '{autoPackage,transient}',
                  jsonb_build_object('count', coalesce((output_summary->'autoPackage'->'transient'->>'count')::int, 0) + 1, 'at', now()), true)
          where id = $1 and jsonb_typeof(output_summary->'autoPackage') = 'object'`,
        [runId],
      ).catch(() => undefined);
      this.logger.warn(`empaque automático (${source}): run ${runId} falló (${err instanceof Error ? err.message : String(err)}); lo retoma el barrido`);
      return { action: 'skipped', runId, reason: 'transient_error' };
    }
  }

  /** Barrido (tick del auto-healer, solo la API). */
  async sweep(opts: { now?: Date; limit?: number } = {}): Promise<AutoPackageOutcome[]> {
    if (!autoPackageEnabled() || !isDynamicCourseStructureEnabled()) return [];
    const ids = await findAutoPackageCandidates(this.dataSource, opts.now ?? new Date(), opts.limit ?? 50);
    const out: AutoPackageOutcome[] = [];
    for (const id of ids) out.push(await this.ensure(id, 'sweep'));
    if (ids.length) this.logger.log(`empaque automático: barrido — ${ids.length} candidato(s): ${JSON.stringify(out.map((o) => o.action))}`);
    return out;
  }
}
