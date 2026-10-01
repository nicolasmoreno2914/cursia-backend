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

/** `DYNAMIC_AUTO_PACKAGE_ENABLED=false` apaga el empaque automático (disparo y barrido). Default: encendido. */
export const AUTO_PACKAGE_ENABLED_ENV = 'DYNAMIC_AUTO_PACKAGE_ENABLED';
/** Intentos automáticos de paquete final por completitud del run (el primero + 2 reintentos). */
export const AUTO_PACKAGE_MAX_ATTEMPTS = 3;
/** Espera mínima entre un job de paquete fallido y el reintento automático. */
export const AUTO_PACKAGE_RETRY_BACKOFF_SECONDS = 60;
/** Ventana: un run marcado hace más que esto ya no se reintenta solo (queda para un admin). */
export const AUTO_PACKAGE_MAX_AGE_HOURS = 72;

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

/** Marca de empaque automático del run (null = run anterior a BE-B o nunca completado desde entonces). */
export function autoPackageMarkOf(run: { output_summary?: unknown } | null | undefined): {
  eligibleAt: Date;
  blocked: { code: string; at: Date } | null;
} | null {
  const ap = obj(run?.output_summary).autoPackage;
  const eligibleAt = dateOf(ap?.eligibleAt);
  if (!eligibleAt) return null;
  const b = ap?.blocked;
  const at = dateOf(b?.at);
  // Un bloqueo anterior a la marca vigente (otra completitud) no cuenta.
  const blocked = b && typeof b.code === 'string' && at && at.getTime() >= eligibleAt.getTime() ? { code: b.code, at } : null;
  return { eligibleAt, blocked };
}

export interface AutoPackageState {
  /** Estado del último job de paquete FINAL: none | queued | running | retrying | completed | failed. */
  status: string;
  /** El servidor lo va a (re)intentar solo. */
  autoRetryPending: boolean;
  /** Jobs finales fallidos desde la marca vigente. */
  failedSinceMark: number;
  /** Último fallo (finished_at/updated_at) de un job final desde la marca. */
  lastFailureAt: Date | null;
  /** El run está marcado para el empaque automático. */
  eligible: boolean;
  /** Código del último bloqueo del precheck automático (p.ej. youtube_delivery_incomplete). */
  blockedCode: string | null;
}

/**
 * Estado del empaque final de un run (solo lectura). Un job QA / degradado nunca cuenta (el paquete
 * automático es siempre `final`). Un precheck automático que no pudo encolar (409) cuenta como `failed`
 * sin reintento automático (lo resuelve un admin con `retry_package`).
 */
export async function loadAutoPackageState(
  q: Q,
  run: { id: string; worker_status?: string | null; output_summary?: unknown },
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
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
  const blockedCode = mark?.blocked && (!latest || new Date(latest.created_at).getTime() <= mark.blocked.at.getTime()) ? mark.blocked.code : null;
  if (blockedCode) status = 'failed';
  const eligible = !!mark && run.worker_status === 'completed';
  const withinWindow = !!mark && now.getTime() - mark.eligibleAt.getTime() <= AUTO_PACKAGE_MAX_AGE_HOURS * 3_600_000;
  const autoRetryPending = status === 'failed' && !blockedCode && eligible && withinWindow && autoPackageEnabled(env) &&
    failed.length < AUTO_PACKAGE_MAX_ATTEMPTS;
  return { status, autoRetryPending, failedSinceMark: failed.length, lastFailureAt, eligible, blockedCode };
}

/**
 * Candidatos del barrido: runs `completed` CON la marca, dentro de la ventana, sin job final activo, sin
 * job final completado desde la marca, sin bloqueo de precheck, con intentos disponibles y pasada la
 * espera desde el último fallo. Grueso (SQL); `AutoPackageService.ensure` decide fino.
 */
export async function findAutoPackageCandidates(q: Q, now: Date, limit = 50): Promise<string[]> {
  const rows: Array<{ id: string }> = await q.query(
    `with marked as (
       select r.id, (r.output_summary->'autoPackage'->>'eligibleAt')::timestamptz as eligible_at
         from public.production_jobs r
        where r.execution_mode = 'dynamic_generation' and r.worker_status = 'completed'
          and jsonb_typeof(r.output_summary->'autoPackage') = 'object'
          and r.output_summary->'autoPackage' ? 'eligibleAt'
          and not (r.output_summary->'autoPackage' ? 'blocked'
                   and (r.output_summary->'autoPackage'->'blocked'->>'at')::timestamptz >= (r.output_summary->'autoPackage'->>'eligibleAt')::timestamptz)
     )
     select m.id from marked m
      where m.eligible_at > $1::timestamptz - make_interval(hours => $2::int)
        and not exists (select 1 from public.production_jobs p
                         where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = m.id::text
                           and p.worker_status = any($3::text[]))
        and not exists (select 1 from public.production_jobs p
                         where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = m.id::text
                           and p.worker_status = 'completed' and p.created_at >= m.eligible_at
                           and coalesce(p.input_payload->>'packageKind', 'final') = 'final')
        and (select count(*) from public.production_jobs p
              where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = m.id::text
                and p.worker_status = any($4::text[]) and p.created_at >= m.eligible_at
                and coalesce(p.input_payload->>'packageKind', 'final') = 'final') < $5::int
        and not exists (select 1 from public.production_jobs p
                         where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = m.id::text
                           and p.worker_status = any($4::text[]) and p.created_at >= m.eligible_at
                           and coalesce(p.finished_at, p.updated_at) > $1::timestamptz - make_interval(secs => $6::int))
      order by m.eligible_at desc
      limit $7`,
    [now.toISOString(), AUTO_PACKAGE_MAX_AGE_HOURS, [...PACKAGE_JOB_ACTIVE_STATUSES], [...PACKAGE_JOB_FAILED_STATUSES],
      AUTO_PACKAGE_MAX_ATTEMPTS, AUTO_PACKAGE_RETRY_BACKOFF_SECONDS, limit],
  );
  return rows.map((r) => r.id);
}
