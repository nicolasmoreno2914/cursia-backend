/**
 * EV6 DoD BE-B — empaque final AUTOMÁTICO: reglas y lecturas compartidas (sin Nest, solo lectura).
 *
 * «Curso completo» = generación completa (todo real y validado) + paquete Moodle final disponible.
 * Cuando un run pasa a `completed`, el servidor encola el job `dynamic_package` solo (sin clic):
 *  - disparo: `recomputeRunStatus` marca el run (`output_summary.autoPackage.eligibleAt`) y anota el run
 *    en la transacción; `RunsService.tx` avisa DESPUÉS del commit → `AutoPackageService.ensure` (encolar
 *    nunca queda dentro de una transacción que se pueda deshacer);
 *  - barrido: el tick del auto-healer (API) vuelve a intentar los runs marcados sin paquete vigente ni job
 *    activo (disparo perdido, job fallido), con un tope de intentos y una espera entre ellos;
 *  - SOLO runs con la marca: los runs completados antes de este cambio nunca la tienen → nunca se
 *    empaquetan solos ni se tocan;
 *  - idempotente: el get-or-create de PackagingService (misma clave de reuse, lock por run) nunca arma
 *    dos veces; un paquete QA / de vista previa nunca se arma solo (solo `final`).
 *
 * Este archivo lo importan RunsService (para `RunDto.completion`) y AutoPackageService.
 */
import { packageKindOf } from './package-freshness';
import { DYNAMIC_MBZ_BUILDER_VERSION } from '../../package/dynamic-mbz-builder';
import { DYNAMIC_MBZ_BUILDER_VERSION_V3 } from '../../package/dynamic-mbz-builder-v3';

/** `DYNAMIC_AUTO_PACKAGE_ENABLED=false` apaga el empaque automático (disparo y barrido). Default: encendido. */
export const AUTO_PACKAGE_ENABLED_ENV = 'DYNAMIC_AUTO_PACKAGE_ENABLED';
/** Intentos automáticos de paquete final por completitud del run (el primero + 2 reintentos). */
export const AUTO_PACKAGE_MAX_ATTEMPTS = 3;
/** Espera mínima entre un job de paquete fallido y el reintento automático. */
export const AUTO_PACKAGE_RETRY_BACKOFF_SECONDS = 60;
/** Ventana: un run marcado hace más que esto ya no se reintenta solo (queda para un admin). */
export const AUTO_PACKAGE_MAX_AGE_HOURS = 72;
/**
 * Fix round 1 (M1): errores TRANSITORIOS de `ensure` (DB/red, sin job creado): tope y espera propios
 * (`autoPackage.transient = {count, at}`), así un run trabado no se re-evalúa en cada tick.
 */
export const AUTO_PACKAGE_MAX_TRANSIENT = 5;
export const AUTO_PACKAGE_TRANSIENT_BACKOFF_SECONDS = 300;

/** Versión del builder vigente según las reglas del Manifest (la misma que usa la clave de reuse). */
export function currentBuilderVersionFor(rulesVersion: number): string {
  return Number(rulesVersion) === 3 ? DYNAMIC_MBZ_BUILDER_VERSION_V3 : DYNAMIC_MBZ_BUILDER_VERSION;
}

export const PACKAGE_JOB_ACTIVE_STATUSES: readonly string[] = ['queued', 'running', 'retrying'];
export const PACKAGE_JOB_FAILED_STATUSES: readonly string[] = ['failed', 'failed_retryable', 'cancelled'];

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

export function autoPackageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[AUTO_PACKAGE_ENABLED_ENV] ?? '').trim().toLowerCase() !== 'false';
}

function obj(v: unknown): Record<string, any> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) ?? {};
    } catch {
      return {};
    }
  }
  return (v && typeof v === 'object' ? v : {}) as Record<string, any>;
}

function dateOf(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Bloqueo del precheck automático (fix round 1, I2): código, mensaje para admin y lo que falta. */
export interface AutoPackageBlock {
  code: string;
  message: string | null;
  missing: string[];
  at: Date;
}

/** Marca de empaque automático del run (null = run anterior a BE-B o nunca completado desde entonces). */
export function autoPackageMarkOf(run: { output_summary?: unknown } | null | undefined): {
  eligibleAt: Date;
  blocked: AutoPackageBlock | null;
  transient: { count: number; at: Date | null };
  satisfiedJobId: string | null;
} | null {
  const ap = obj(run?.output_summary).autoPackage;
  const eligibleAt = dateOf(ap?.eligibleAt);
  if (!eligibleAt) return null;
  const b = ap?.blocked;
  const at = dateOf(b?.at);
  // Un bloqueo anterior a la marca vigente (otra completitud) no cuenta.
  const blocked = b && typeof b.code === 'string' && at && at.getTime() >= eligibleAt.getTime()
    ? {
        code: b.code,
        message: typeof b.message === 'string' ? b.message : null,
        missing: Array.isArray(b.missing) ? b.missing.filter((x: unknown) => typeof x === 'string') : [],
        at,
      }
    : null;
  const tc = Number(ap?.transient?.count ?? 0);
  return {
    eligibleAt,
    blocked,
    transient: { count: Number.isInteger(tc) && tc > 0 ? tc : 0, at: dateOf(ap?.transient?.at) },
    satisfiedJobId: typeof ap?.satisfiedJobId === 'string' ? ap.satisfiedJobId : null,
  };
}

export interface AutoPackageState {
  /** Estado del último job de paquete FINAL: none | queued | running | retrying | completed | failed. */
  status: string;
  /** (none / failed) el servidor lo va a encolar o reintentar solo. */
  autoRetryPending: boolean;
  /**
   * Fix round 1 (I1): (completed) si ese paquete resultara NO vigente, el barrido lo re-arma solo:
   * cambió la versión del builder (cualquier momento), o el run volvió a completarse después de ese
   * job y todavía no se confirmó que sea el mismo build (dentro de la ventana). Mismos topes.
   */
  rebuildPending: boolean;
  /** Jobs finales fallidos desde la marca vigente. */
  failedSinceMark: number;
  lastFailureAt: Date | null;
  /** El run está marcado para el empaque automático (completado desde BE-B). */
  eligible: boolean;
  /** Fix round 1 (I2): precheck que no dejó encolar (código, mensaje para admin, faltantes). */
  blocked: AutoPackageBlock | null;
  /** Compatibilidad: código del bloqueo. */
  blockedCode: string | null;
}

/**
 * Estado del empaque final de un run (solo lectura). Un job QA / degradado nunca cuenta (el paquete
 * automático es siempre `final`). `rulesVersion` = reglas del Manifest del run (versión del builder).
 */
export async function loadAutoPackageState(
  q: Q,
  run: { id: string; worker_status?: string | null; output_summary?: unknown },
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  rulesVersion = 3,
): Promise<AutoPackageState> {
  const jobs: Array<{ id: string; worker_status: string; input_payload: any; output_summary: any; created_at: Date; finished_at: Date | null; updated_at: Date | null }> =
    await q.query(
      `select id, worker_status, input_payload, output_summary, created_at, finished_at, updated_at
         from public.production_jobs
        where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1
        order by created_at desc, id desc
        limit 50`,
      [run.id],
    );
  const finals = jobs.filter((j) => packageKindOf({ input_payload: obj(j.input_payload), output_summary: obj(j.output_summary) }) === 'final');
  const mark = autoPackageMarkOf(run);
  const sinceMark = mark ? finals.filter((j) => new Date(j.created_at).getTime() >= mark.eligibleAt.getTime()) : [];
  const failed = sinceMark.filter((j) => PACKAGE_JOB_FAILED_STATUSES.includes(j.worker_status));
  const lastFailureAt = failed.length ? dateOf(failed[0].finished_at) ?? dateOf(failed[0].updated_at) : null;
  const latest = finals[0] ?? null;
  let status = latest ? (PACKAGE_JOB_FAILED_STATUSES.includes(latest.worker_status) ? 'failed' : latest.worker_status) : 'none';
  const blocked = mark?.blocked && (!latest || new Date(latest.created_at).getTime() <= mark.blocked.at.getTime()) ? mark.blocked : null;
  if (blocked) status = 'failed';
  const eligible = !!mark && run.worker_status === 'completed';
  const withinWindow = !!mark && now.getTime() - mark.eligibleAt.getTime() <= AUTO_PACKAGE_MAX_AGE_HOURS * 3_600_000;
  const capsOk = eligible && autoPackageEnabled(env) && !blocked && failed.length < AUTO_PACKAGE_MAX_ATTEMPTS &&
    (mark?.transient.count ?? 0) < AUTO_PACKAGE_MAX_TRANSIENT;
  const autoRetryPending = (status === 'failed' || status === 'none') && capsOk && withinWindow;
  let rebuildPending = false;
  if (status === 'completed' && latest && mark && capsOk) {
    const builder = obj(latest.output_summary).builderVersion;
    const builderChanged = builder !== currentBuilderVersionFor(rulesVersion);
    const unconfirmed = new Date(latest.created_at).getTime() < mark.eligibleAt.getTime() && mark.satisfiedJobId !== latest.id;
    rebuildPending = builderChanged || (withinWindow && unconfirmed);
  }
  return { status, autoRetryPending, rebuildPending, failedSinceMark: failed.length, lastFailureAt, eligible, blocked, blockedCode: blocked?.code ?? null };
}

/**
 * Candidatos del barrido (grueso, SQL; `AutoPackageService.ensure` decide fino con el mismo
 * `loadAutoPackageState`): runs `completed` CON la marca, sin bloqueo de precheck, sin job final activo,
 * con intentos disponibles (fallidos desde la marca y transitorios), pasada la espera, y además:
 *  - sin job final o con el último fallido — dentro de la ventana;
 *  - último job final completado con OTRA versión del builder — en cualquier momento (fix round 1, I1);
 *  - último job final completado ANTES de la marca vigente sin confirmar como mismo build — dentro de la
 *    ventana (re-completitud cuyo disparo se perdió; fix round 1, I1/M2).
 */
export async function findAutoPackageCandidates(q: Q, now: Date, limit = 50): Promise<string[]> {
  const rows: Array<{ id: string }> = await q.query(
    `with marked as (
       select r.id, r.output_summary->'autoPackage' as ap,
              (r.output_summary->'autoPackage'->>'eligibleAt')::timestamptz as eligible_at,
              coalesce(m.rules_version, 3) as rules_version
         from public.production_jobs r
         left join public.course_generation_manifests m on m.id = (r.input_payload->>'manifestId')::bigint
        where r.execution_mode = 'dynamic_generation' and r.worker_status = 'completed'
          and jsonb_typeof(r.output_summary->'autoPackage') = 'object'
          and r.output_summary->'autoPackage' ? 'eligibleAt'
          and not (r.output_summary->'autoPackage' ? 'blocked'
                   and (r.output_summary->'autoPackage'->'blocked'->>'at')::timestamptz >= (r.output_summary->'autoPackage'->>'eligibleAt')::timestamptz)
     ),
     c as (
       select mk.*, l.id as job_id, l.worker_status as job_status, l.created_at as job_created, l.builder
         from marked mk
         left join lateral (
           select p.id, p.worker_status, p.created_at, p.output_summary->>'builderVersion' as builder
             from public.production_jobs p
            where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = mk.id::text
              and coalesce(p.input_payload->>'packageKind', 'final') = 'final'
            order by p.created_at desc, p.id desc
            limit 1
         ) l on true
     )
     select c.id from c
      where (c.job_id is null or not (c.job_status = any($3::text[])))
        and (select count(*) from public.production_jobs p
              where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = c.id::text
                and p.worker_status = any($4::text[]) and p.created_at >= c.eligible_at
                and coalesce(p.input_payload->>'packageKind', 'final') = 'final') < $5::int
        and not exists (select 1 from public.production_jobs p
                         where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = c.id::text
                           and p.worker_status = any($4::text[]) and p.created_at >= c.eligible_at
                           and coalesce(p.finished_at, p.updated_at) > $1::timestamptz - make_interval(secs => $6::int))
        and coalesce((c.ap->'transient'->>'count')::int, 0) < $8::int
        and coalesce((c.ap->'transient'->>'at')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz - make_interval(secs => $9::int)
        and (
          ((c.job_id is null or c.job_status = any($4::text[])) and c.eligible_at > $1::timestamptz - make_interval(hours => $2::int))
          or (c.job_status = 'completed' and c.builder is distinct from (case when c.rules_version = 3 then $10 else $11 end))
          or (c.job_status = 'completed' and c.job_created < c.eligible_at
              and coalesce(c.ap->>'satisfiedJobId', '') <> c.job_id::text
              and c.eligible_at > $1::timestamptz - make_interval(hours => $2::int))
        )
      order by c.eligible_at desc
      limit $7`,
    [now.toISOString(), AUTO_PACKAGE_MAX_AGE_HOURS, [...PACKAGE_JOB_ACTIVE_STATUSES], [...PACKAGE_JOB_FAILED_STATUSES],
      AUTO_PACKAGE_MAX_ATTEMPTS, AUTO_PACKAGE_RETRY_BACKOFF_SECONDS, limit, AUTO_PACKAGE_MAX_TRANSIENT,
      AUTO_PACKAGE_TRANSIENT_BACKOFF_SECONDS, DYNAMIC_MBZ_BUILDER_VERSION_V3, DYNAMIC_MBZ_BUILDER_VERSION],
  );
  return rows.map((r) => r.id);
}
