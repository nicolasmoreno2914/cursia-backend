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
import { autoHealEnabled } from '../dynamic-generation/auto-heal';

/** `DYNAMIC_AUTO_PACKAGE_ENABLED=false` apaga el empaque automático (disparo y barrido). Default: encendido. */
export const AUTO_PACKAGE_ENABLED_ENV = 'DYNAMIC_AUTO_PACKAGE_ENABLED';
/**
 * T8 (factory mode, 2026-10-18): re-armar SOLO un paquete final completado porque cambió la versión del builder es
 * OPT-IN. Default false: un deploy que sube el builder nunca re-empaqueta cursos ya entregados (16-oct: un deploy
 * re-armó 4 cursos viejos con 3.14.0). El empaque inicial de un run recién completado (y el reintento de un fallo /
 * la re-completitud sin confirmar) no cambia: lo gobiernan DYNAMIC_AUTO_PACKAGE_ENABLED y holdPackaging.
 */
export const AUTO_REPACKAGE_ON_BUILDER_BUMP_ENV = 'DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP';
/**
 * Intentos automáticos de paquete final por completitud del run (el primero + 2 reintentos) para fallos NO
 * transitorios (error de build sin clasificar, bug del builder sin la reparación por item). r62 (d7): un job
 * cuyo fallo el worker registró como TRANSITORIO (`output_summary.failure.transient`, clase A del clasificador:
 * Storage, DB, red) no cuenta contra este tope — se reintenta con espera creciente hasta la ventana larga.
 */
export const AUTO_PACKAGE_MAX_ATTEMPTS = 3;
/** Espera mínima entre un job de paquete fallido y el reintento automático (base de la espera creciente). */
export const AUTO_PACKAGE_RETRY_BACKOFF_SECONDS = 60;
/** r62 (d7): techo de la espera creciente entre reintentos automáticos (fallos de job y transitorios de `ensure`). */
export const AUTO_PACKAGE_RETRY_BACKOFF_MAX_SECONDS = 3600;
/**
 * Ventana larga: un run marcado hace más que esto ya no se reintenta solo. Al agotarse con fallos transitorios
 * la excepción queda explícita (`completion.packageJob.attentionReason = package_transient_exhausted`).
 */
export const AUTO_PACKAGE_MAX_AGE_HOURS = 72;
/** r62 (d7): pasado esto desde la marca, un empaque que sigue reintentando transitorios levanta una alerta visible. */
export const AUTO_PACKAGE_ALERT_HOURS = 24;
/**
 * Fix round 1 (M1): errores TRANSITORIOS de `ensure` (DB/red, sin job creado): espera propia
 * (`autoPackage.transient = {count, at}`), así un run trabado no se re-evalúa en cada tick. r62 (d7): sin tope de
 * rondas — la espera crece (300 s, 600 s, … hasta AUTO_PACKAGE_RETRY_BACKOFF_MAX_SECONDS) y el límite es la ventana
 * larga. `AUTO_PACKAGE_MAX_TRANSIENT` queda solo como el umbral desde el que se levanta la alerta.
 */
export const AUTO_PACKAGE_MAX_TRANSIENT = 5;
export const AUTO_PACKAGE_TRANSIENT_BACKOFF_SECONDS = 300;
/** r62 (d7): motivos explícitos de la excepción del empaque automático (`completion.packageJob.attentionReason`). */
export const PACKAGE_TRANSIENT_EXHAUSTED = 'package_transient_exhausted';
export const PACKAGE_ATTEMPTS_EXHAUSTED = 'package_attempts_exhausted';
/** r62 (d7): alerta (no bloquea): el empaque lleva más de AUTO_PACKAGE_ALERT_HOURS reintentando transitorios. */
export const PACKAGE_TRANSIENT_RETRYING_ALERT = 'package_transient_retrying';

/** r62 (d7): espera creciente `base · 2^(n-1)` con techo (n = fallos ya registrados; n ≤ 1 → base). Pura. */
export function autoPackageBackoffSeconds(base: number, n: number, max = AUTO_PACKAGE_RETRY_BACKOFF_MAX_SECONDS): number {
  const k = Math.max(0, Math.min(30, Math.floor(Number(n) || 0) - 1));
  return Math.min(max, base * 2 ** k);
}

/**
 * r62 (d7): ¿el job de paquete fallido quedó registrado por el worker como TRANSITORIO? Solo el campo que escribe
 * el worker al fallar (`output_summary.failure.transient === true`); un job anterior a r62 (sin el campo) cuenta
 * como no transitorio (comportamiento de siempre). Misma regla en SQL (`transientFailureSql`).
 */
export function packageFailureIsTransient(outputSummary: unknown): boolean {
  return obj(obj(outputSummary).failure).transient === true;
}

function transientFailureSql(p: string): string {
  return `coalesce(${p}.output_summary->'failure'->>'transient', '') = 'true'`;
}
/**
 * DoD follow-up (R2): el barrido corre en el tick del auto-healer. Con el tick apagado
 * (`DYNAMIC_AUTO_HEAL_ENABLED=false`) nadie reintenta ni re-arma solo → nada queda «pendiente» (el run
 * pasa a la acción manual / de admin). Única excepción: un run recién marcado sin job todavía (el aviso
 * post-commit lo está encolando), durante esta gracia.
 */
export const AUTO_PACKAGE_HOOK_GRACE_SECONDS = 120;
/**
 * DoD follow-up (R8): un run que el barrido seleccionó y `ensure` saltó por «nada pendiente» queda
 * registrado (`autoPackage.lastSkip`) y el SQL no lo vuelve a seleccionar durante esta espera (no
 * cuenta contra el tope de transitorios: no es un fallo).
 */
export const AUTO_PACKAGE_SKIP_BACKOFF_SECONDS = 300;

/**
 * DoD follow-up (R8): MISMA clasificación que `packageKindOf` (package-freshness.ts) en SQL, para que el
 * barrido y el estado vean los mismos jobs FINALES: el `packageKind` declarado (output_summary, si no
 * input_payload) si es uno conocido; si no, un resumen con videos omitidos o proveedores simulados es
 * de vista previa (paquetes anteriores a EV6 DoD); el resto, final.
 */
export function finalPackageKindSql(p: string): string {
  const k = `coalesce(${p}.output_summary->>'packageKind', ${p}.input_payload->>'packageKind')`;
  const mp = `${p}.output_summary->'mockProviderItems'`;
  return `(case
      when ${k} in ('final', 'qa_preview', 'degraded') then ${k} = 'final'
      when jsonb_typeof(${p}.output_summary->'pendingVideos') = 'array' and jsonb_array_length(${p}.output_summary->'pendingVideos') > 0 then false
      when jsonb_typeof(${mp}) = 'array' then jsonb_array_length(${mp}) = 0
      when jsonb_typeof(${mp}) = 'number' then (${mp})::text::numeric <= 0
      when jsonb_typeof(${mp}) = 'boolean' then (${mp})::text <> 'true'
      when jsonb_typeof(${mp}) = 'string' and (${p}.output_summary->>'mockProviderItems') ~ '^\\s*[0-9]+(\\.[0-9]+)?\\s*$'
        then trim(${p}.output_summary->>'mockProviderItems')::numeric <= 0
      else true
    end)`;
}

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

/** T8: `DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP=true` re-arma solo los paquetes de un builder anterior. Default: apagado. */
export function autoRepackageOnBuilderBump(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[AUTO_REPACKAGE_ON_BUILDER_BUMP_ENV] ?? '').trim().toLowerCase() === 'true';
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
  /** r62 (d7): fallidos desde la marca que NO son transitorios (los únicos que cuentan contra AUTO_PACKAGE_MAX_ATTEMPTS). */
  hardFailedSinceMark: number;
  /** r62 (d7): fallidos transitorios desde la marca (Storage/DB/red; sin tope de rondas, solo la ventana larga). */
  transientFailedSinceMark: number;
  /** r62 (d7): cuándo el barrido vuelve a intentarlo (espera creciente) — solo con un reintento pendiente. */
  nextRetryAt: Date | null;
  /** r62 (d7): alerta visible mientras se sigue reintentando solo (no bloquea). */
  alert: string | null;
  /** r62 (d7): motivo explícito cuando el reintento automático se agotó (excepción registrada). */
  attentionReason: string | null;
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
  // r62 (d7): solo los fallos NO transitorios cuentan contra el tope de intentos.
  const hardFailed = failed.filter((j) => !packageFailureIsTransient(j.output_summary));
  const transientFailed = failed.length - hardFailed.length;
  const lastFailureAt = failed.length ? dateOf(failed[0].finished_at) ?? dateOf(failed[0].updated_at) : null;
  const latest = finals[0] ?? null;
  let status = latest ? (PACKAGE_JOB_FAILED_STATUSES.includes(latest.worker_status) ? 'failed' : latest.worker_status) : 'none';
  const blocked = mark?.blocked && (!latest || new Date(latest.created_at).getTime() <= mark.blocked.at.getTime()) ? mark.blocked : null;
  if (blocked) status = 'failed';
  const eligible = !!mark && run.worker_status === 'completed';
  const withinWindow = !!mark && now.getTime() - mark.eligibleAt.getTime() <= AUTO_PACKAGE_MAX_AGE_HOURS * 3_600_000;
  // r62 (d7): sin tope de rondas para lo transitorio (jobs A y errores de `ensure`): el límite es la ventana larga.
  const capsOk = eligible && autoPackageEnabled(env) && !blocked && hardFailed.length < AUTO_PACKAGE_MAX_ATTEMPTS;
  // DoD follow-up (R2): sin el tick del barrido nadie reintenta ni re-arma: nada queda pendiente (salvo el
  // aviso post-commit de un run recién marcado, que encola sin el tick).
  const sweepOn = autoHealEnabled(env);
  const hookGrace = status === 'none' && !!mark && failed.length === 0 && (mark.transient.count ?? 0) === 0 &&
    now.getTime() - mark.eligibleAt.getTime() <= AUTO_PACKAGE_HOOK_GRACE_SECONDS * 1000;
  const autoRetryPending = (status === 'failed' || status === 'none') && capsOk && withinWindow && (sweepOn || hookGrace);
  // r62 (d7): espera creciente, alerta y excepción explícita (mismas cuentas que el SQL del barrido).
  const transientCount = mark?.transient.count ?? 0;
  const anyTransient = transientFailed > 0 || transientCount > 0;
  let nextRetryAt: Date | null = null;
  // Solo con fallos transitorios (los demás conservan el contrato previo del estado).
  if (autoRetryPending && anyTransient && status === 'failed' && lastFailureAt) {
    nextRetryAt = new Date(lastFailureAt.getTime() + autoPackageBackoffSeconds(AUTO_PACKAGE_RETRY_BACKOFF_SECONDS, failed.length) * 1000);
  } else if (autoRetryPending && status === 'none' && transientCount > 0 && mark?.transient.at) {
    nextRetryAt = new Date(mark.transient.at.getTime() + autoPackageBackoffSeconds(AUTO_PACKAGE_TRANSIENT_BACKOFF_SECONDS, transientCount) * 1000);
  }
  const alert = autoRetryPending && anyTransient && !!mark &&
    (now.getTime() - mark.eligibleAt.getTime() >= AUTO_PACKAGE_ALERT_HOURS * 3_600_000 || transientCount >= AUTO_PACKAGE_MAX_TRANSIENT)
    ? PACKAGE_TRANSIENT_RETRYING_ALERT : null;
  let attentionReason: string | null = null;
  if (eligible && autoPackageEnabled(env) && !blocked && !autoRetryPending && (status === 'failed' || status === 'none')) {
    if (hardFailed.length >= AUTO_PACKAGE_MAX_ATTEMPTS) attentionReason = PACKAGE_ATTEMPTS_EXHAUSTED;
    else if (!withinWindow && anyTransient) attentionReason = PACKAGE_TRANSIENT_EXHAUSTED;
  }
  let rebuildPending = false;
  if (status === 'completed' && latest && mark && capsOk && sweepOn) {
    const builder = obj(latest.output_summary).builderVersion;
    // T8: un builder nuevo solo re-arma con el opt-in (default: el paquete queda `stale` con acción visible).
    const builderChanged = autoRepackageOnBuilderBump(env) && builder !== currentBuilderVersionFor(rulesVersion);
    const unconfirmed = new Date(latest.created_at).getTime() < mark.eligibleAt.getTime() && mark.satisfiedJobId !== latest.id;
    rebuildPending = builderChanged || (withinWindow && unconfirmed);
  }
  return {
    status, autoRetryPending, rebuildPending, failedSinceMark: failed.length, lastFailureAt, eligible, blocked, blockedCode: blocked?.code ?? null,
    hardFailedSinceMark: hardFailed.length, transientFailedSinceMark: transientFailed, nextRetryAt, alert, attentionReason,
  };
}

/**
 * Candidatos del barrido (grueso, SQL; `AutoPackageService.ensure` decide fino con el mismo
 * `loadAutoPackageState`): runs `completed` CON la marca, sin bloqueo de precheck vigente, sin job final
 * activo, con intentos disponibles (fallidos desde la marca y transitorios), pasada la espera, y además:
 *  - sin job final o con el último fallido — dentro de la ventana;
 *  - último job final completado con OTRA versión del builder — en cualquier momento (fix round 1, I1), SOLO con
 *    `DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP=true` (T8; default apagado);
 *  - último job final completado ANTES de la marca vigente sin confirmar como mismo build — dentro de la
 *    ventana (re-completitud cuyo disparo se perdió; fix round 1, I1/M2).
 * DoD follow-up (R8): «final» se clasifica igual que `packageKindOf` (`finalPackageKindSql`), un bloqueo
 * deja de contar si después se creó un job final (igual que el estado), y un run saltado por «nada
 * pendiente» espera `AUTO_PACKAGE_SKIP_BACKOFF_SECONDS` antes de volver a seleccionarse.
 */
export async function findAutoPackageCandidates(
  q: Q,
  now: Date,
  limit = 50,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const isFinal = finalPackageKindSql('p');
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
     ),
     c as (
       select mk.*, l.id as job_id, l.worker_status as job_status, l.created_at as job_created, l.builder
         from marked mk
         left join lateral (
           select p.id, p.worker_status, p.created_at, p.output_summary->>'builderVersion' as builder
             from public.production_jobs p
            where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = mk.id::text
              and ${isFinal}
            order by p.created_at desc, p.id desc
            limit 1
         ) l on true
     )
     select c.id from c
       left join lateral (
         -- r62 (d7): fallidos finales desde la marca; solo los NO transitorios cuentan contra el tope de intentos y la
         -- espera crece con el total de fallidos (misma regla que loadAutoPackageState).
         select count(*)::int as failed,
                count(*) filter (where not (${transientFailureSql('p')}))::int as hard_failed,
                max(coalesce(p.finished_at, p.updated_at)) as last_failed_at
           from public.production_jobs p
          where p.execution_mode = 'dynamic_package' and p.input_payload->>'runId' = c.id::text
            and p.worker_status = any($4::text[]) and p.created_at >= c.eligible_at
            and ${isFinal}
       ) f on true
      where not (c.ap ? 'blocked'
                 and jsonb_typeof(c.ap->'blocked') = 'object'
                 and (c.ap->'blocked'->>'code') is not null
                 and (c.ap->'blocked'->>'at')::timestamptz >= c.eligible_at
                 and (c.job_id is null or c.job_created <= (c.ap->'blocked'->>'at')::timestamptz))
        and (c.job_id is null or not (c.job_status = any($3::text[])))
        and f.hard_failed < $5::int
        and (f.last_failed_at is null
             or f.last_failed_at <= $1::timestamptz - make_interval(secs => least($8::int, $6::int * power(2, least(30, greatest(f.failed - 1, 0))))::int))
        and coalesce((c.ap->'transient'->>'at')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz
              - make_interval(secs => least($8::int, $9::int * power(2, least(30, greatest(coalesce((c.ap->'transient'->>'count')::int, 0) - 1, 0))))::int)
        and coalesce((c.ap->'lastSkip'->>'at')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz - make_interval(secs => $12::int)
        and (
          ((c.job_id is null or c.job_status = any($4::text[])) and c.eligible_at > $1::timestamptz - make_interval(hours => $2::int))
          or ($13::boolean and c.job_status = 'completed' and c.builder is distinct from (case when c.rules_version = 3 then $10 else $11 end))
          or (c.job_status = 'completed' and c.job_created < c.eligible_at
              and coalesce(c.ap->>'satisfiedJobId', '') <> c.job_id::text
              and c.eligible_at > $1::timestamptz - make_interval(hours => $2::int))
        )
      order by c.eligible_at desc
      limit $7`,
    [now.toISOString(), AUTO_PACKAGE_MAX_AGE_HOURS, [...PACKAGE_JOB_ACTIVE_STATUSES], [...PACKAGE_JOB_FAILED_STATUSES],
      // r62 (d7): $8 = techo de la espera creciente (antes, el tope de transitorios, que ya no existe).
      AUTO_PACKAGE_MAX_ATTEMPTS, AUTO_PACKAGE_RETRY_BACKOFF_SECONDS, limit, AUTO_PACKAGE_RETRY_BACKOFF_MAX_SECONDS,
      AUTO_PACKAGE_TRANSIENT_BACKOFF_SECONDS, DYNAMIC_MBZ_BUILDER_VERSION_V3, DYNAMIC_MBZ_BUILDER_VERSION,
      AUTO_PACKAGE_SKIP_BACKOFF_SECONDS, autoRepackageOnBuilderBump(env)],
  );
  return rows.map((r) => r.id);
}
