/**
 * r63 (SC) — reparto, límites de concurrencia y admisión del scheduler de la generación dinámica.
 *
 * TODO es configuración por variable de entorno y los DEFAULTS reproducen EXACTAMENTE el comportamiento previo:
 *   - DYNAMIC_SCHEDULER_POLICY            'fifo' (default: el claim global de siempre, `order by g.created_at, …`)
 *                                         | 'owner_rr' (round-robin entre dueños; FIFO dentro de cada dueño)
 *                                         | 'run_rr' (round-robin entre runs)
 *   - DYNAMIC_SCHEDULER_TYPE_CAPS         'video=2,presentation=3' — máximo de partes `running` de ese tipo en TODO el
 *                                         sistema (todos los procesos). Vacío (default) = sin tope (como siempre).
 *   - DYNAMIC_SCHEDULER_PROVIDER_CAPS     'gamma=3,openai_tts=2,videogen=2,anthropic=8' — ídem por proveedor
 *                                         (PROVIDERS_OF_TYPE). Vacío (default) = sin tope.
 *   Con topes, ocupan lugar (Q-21: la llamada del intento anterior puede seguir en vuelo en el proveedor):
 *     · las partes `running` (también con la lease vencida y sin barrer);
 *     · las DEVUELTAS por Q-21 (`prior_call_in_flight…`) mientras su next_retry_at (= lo que falta de la ventana) no llegó;
 *     · las barridas por lease vencida (`lease_expired`) durante la ventana EN VUELO de su tipo, contada desde el barrido
 *       (conservador): la MISMA de Q-21 (lease-takeover.ts / dynamic-llm-worker.ts) y con sus variables de entorno —
 *       LLM = DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS + 30 s; TTS = max(210 s, timeout TTS efectivo) + 30 s; guion del
 *       audiolibro = 150 s; Gamma = 90 s; Videogen = 10 min (inFlightWindowSecondsByType).
 *     DYNAMIC_SCHEDULER_CAP_INFLIGHT_GRACE_SECONDS (opcional, operación/simulación) reemplaza esas ventanas por un valor.
 *   - DYNAMIC_ADMISSION_STALL_SECONDS     un run admitido SIN partes running y sin actividad en sus partes durante esto
 *                                         (esperando a un humano, navegador cerrado, cuota de YouTube…) deja de ocupar
 *                                         lugar; cuando vuelve a tener trabajo, entra de nuevo por la cola. Default 1800.
 *   Los runs PAUSADOS ocupan lugar mientras tengan partes running; reanudado, un run vuelve a pasar por el lock de
 *   admisión en su próximo claim (si ya no ocupaba lugar).
 *   IMPORTANTE (rollout): la API (claims del navegador, métricas) y los workers leen estas variables de SU entorno; deben
 *   tener los mismos valores. Cada proceso registra al arrancar su configuración y su huella (logFairSchedulingConfig).
 *   - DYNAMIC_ADMISSION_ENABLED           'true' prende el control de admisión (default apagado).
 *   - DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS   runs ADMITIDOS a la vez (worker_status running/retrying) — default 12.
 *   - DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER  ídem por dueño — default sin tope por dueño.
 *
 * Round-robin SIN estado propio: «el run (o dueño) servido hace más tiempo» = max(claimed_at) de sus partes de los
 * tipos que pide ESTE claim (cada clase de worker tiene su propia ronda). `claimed_at` nunca se borra, así que la
 * ronda sobrevive a reinicios y no hay tabla nueva ni migración. Un run nunca servido va primero (nulls first) y,
 * entre iguales, el más viejo. Garantía anti-starvation: con R runs con partes reclamables de esa clase, cada uno
 * recibe una parte cada ≤ R claims de esa clase.
 *
 * Una configuración inválida NUNCA cambia el comportamiento en silencio: se ignora (queda el default de siempre) y
 * se informa con logger.error (una vez por proceso y valor) y en las métricas de cola (`configErrors`).
 */

import { IN_FLIGHT_MARGIN_MS, IN_FLIGHT_WINDOW_MS, PRIOR_CALL_IN_FLIGHT } from '../../workers/lease-takeover';
import { OPENAI_TTS_TIMEOUT_MS, ttsTimeoutMs } from '../../workers/provider-real/provider-clients';

const LEASE_EXPIRED = 'lease_expired'; // = item-transitions.LEASE_EXPIRED_ERROR (sin importar item-transitions acá)

export type SchedulerPolicy = 'fifo' | 'owner_rr' | 'run_rr';
export const SCHEDULER_POLICIES: readonly SchedulerPolicy[] = ['fifo', 'owner_rr', 'run_rr'];
export const SCHEDULER_POLICY_ENV = 'DYNAMIC_SCHEDULER_POLICY';
export const TYPE_CAPS_ENV = 'DYNAMIC_SCHEDULER_TYPE_CAPS';
export const PROVIDER_CAPS_ENV = 'DYNAMIC_SCHEDULER_PROVIDER_CAPS';
export const ADMISSION_ENABLED_ENV = 'DYNAMIC_ADMISSION_ENABLED';
export const ADMISSION_MAX_ACTIVE_RUNS_ENV = 'DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS';
export const ADMISSION_MAX_PER_OWNER_ENV = 'DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER';
export const ADMISSION_DEFAULT_MAX_ACTIVE_RUNS = 12;
export const CAP_INFLIGHT_GRACE_ENV = 'DYNAMIC_SCHEDULER_CAP_INFLIGHT_GRACE_SECONDS';
export const ADMISSION_STALL_ENV = 'DYNAMIC_ADMISSION_STALL_SECONDS';
export const ADMISSION_STALL_DEFAULT_SECONDS = 1800;
/** Mismo default que dynamic-llm-worker.ts (DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS = 15 min). */
export const LLM_WORKER_CALL_TIMEOUT_ENV = 'DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS';
export const LLM_WORKER_CALL_TIMEOUT_DEFAULT_MS = 15 * 60_000;
/** Tope de cordura de cualquier límite configurable (un valor mayor es un error de configuración). */
export const CAP_LIMIT_MAX = 1000;

/** Motivo del claim cuando el run espera su turno de admisión (cola visible, no un error). */
export const ADMISSION_QUEUED_REASON = 'admission_queued' as const;

/** worker_status de un run ADMITIDO (ya empezó). Un run `queued` todavía no ocupa lugar. */
export const ADMITTED_RUN_WORKER_STATUSES: readonly string[] = ['running', 'retrying'];
/** Runs que pueden ocupar lugar de admisión (los pausados, solo mientras tengan partes running). */
export const OCCUPANCY_CANDIDATE_WORKER_STATUSES: readonly string[] = ['queued', 'running', 'retrying', 'paused'];

/**
 * Proveedor(es) de cada tipo de parte para DYNAMIC_SCHEDULER_PROVIDER_CAPS. `audiobook_chapter` usa Anthropic (guion)
 * Y OpenAI TTS: cuenta para los dos topes. Los tipos de IA del navegador / worker de IA son Anthropic.
 */
export const PROVIDERS_OF_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  video: ['videogen'],
  presentation: ['gamma'],
  audio_welcome: ['openai_tts'],
  audiobook_chapter: ['openai_tts', 'anthropic'],
  content: ['anthropic'], scorm: ['anthropic'], exam: ['anthropic'], course_plan: ['anthropic'], course_intro: ['anthropic'],
  module_intro: ['anthropic'], experience: ['anthropic'], video_interactions: ['anthropic'], activity: ['anthropic'],
  final_exam: ['anthropic'], application_activity: ['anthropic'], guided_practice: ['anthropic'],
});
export const KNOWN_PROVIDERS: readonly string[] = ['videogen', 'gamma', 'openai_tts', 'anthropic'];

/** Un tope: clave estable (lock + métricas), tipos a los que aplica y máximo de partes running. */
export interface CapRule { key: string; types: string[]; max: number }

export interface FairSchedulingConfig {
  policy: SchedulerPolicy;
  caps: CapRule[];
  /** Ventana en vuelo (s) por tipo: una parte barrida por lease vencida sigue ocupando su tope durante esto. */
  capGraceByType: Record<string, number>;
  admission: { enabled: false } | { enabled: true; maxActiveRuns: number; maxActivePerOwner: number | null; stallSeconds: number };
  /** Valores inválidos (ignorados → default de siempre). */
  errors: string[];
}

type Env = Record<string, string | undefined>;

function intIn(raw: string | undefined, name: string, errors: string[]): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > CAP_LIMIT_MAX) {
    errors.push(`${name}=${s} inválido (entero 1..${CAP_LIMIT_MAX})`);
    return null;
  }
  return Number(s);
}

/** 'a=1,b=2' → [['a',1],['b',2]]; null si algún par es inválido (se ignora la variable ENTERA, nunca a medias). */
function parsePairs(raw: string | undefined, name: string, allowed: readonly string[], errors: string[]): Array<[string, number]> {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)\s*=\s*(\d+)$/.exec(part);
    const n = m ? Number(m[2]) : NaN;
    if (!m || !allowed.includes(m[1]) || seen.has(m[1]) || !(n >= 1 && n <= CAP_LIMIT_MAX)) {
      errors.push(`${name} inválido en «${part}» (formato clave=entero 1..${CAP_LIMIT_MAX}; claves: ${allowed.join(',')}); se ignora la variable`);
      return [];
    }
    seen.add(m[1]);
    out.push([m[1], n]);
  }
  return out;
}

export function fairSchedulingConfig(env: Env = process.env): FairSchedulingConfig {
  const errors: string[] = [];
  const rawPolicy = String(env[SCHEDULER_POLICY_ENV] ?? '').trim().toLowerCase();
  let policy: SchedulerPolicy = 'fifo';
  if (rawPolicy) {
    if ((SCHEDULER_POLICIES as readonly string[]).includes(rawPolicy)) policy = rawPolicy as SchedulerPolicy;
    else errors.push(`${SCHEDULER_POLICY_ENV}=${rawPolicy} inválido (${SCHEDULER_POLICIES.join('|')}); se usa fifo`);
  }
  const caps: CapRule[] = [];
  for (const [t, n] of parsePairs(env[TYPE_CAPS_ENV], TYPE_CAPS_ENV, Object.keys(PROVIDERS_OF_TYPE), errors)) {
    caps.push({ key: `type:${t}`, types: [t], max: n });
  }
  for (const [p, n] of parsePairs(env[PROVIDER_CAPS_ENV], PROVIDER_CAPS_ENV, KNOWN_PROVIDERS, errors)) {
    caps.push({ key: `provider:${p}`, types: Object.keys(PROVIDERS_OF_TYPE).filter((t) => PROVIDERS_OF_TYPE[t].includes(p)), max: n });
  }
  caps.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // orden fijo de los locks (sin deadlocks)
  let capGraceByType = inFlightWindowSecondsByType(env);
  const rawGrace = String(env[CAP_INFLIGHT_GRACE_ENV] ?? '').trim();
  if (rawGrace) {
    if (/^\d+$/.test(rawGrace) && Number(rawGrace) <= 7200) {
      const v = Number(rawGrace);
      capGraceByType = Object.fromEntries(Object.keys(capGraceByType).map((t) => [t, v]));
    } else errors.push(`${CAP_INFLIGHT_GRACE_ENV}=${rawGrace} inválido (entero 0..7200); se usan las ventanas de Q-21`);
  }
  const enabled = String(env[ADMISSION_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
  let admission: FairSchedulingConfig['admission'] = { enabled: false };
  if (enabled) {
    const maxActiveRuns = intIn(env[ADMISSION_MAX_ACTIVE_RUNS_ENV], ADMISSION_MAX_ACTIVE_RUNS_ENV, errors) ?? ADMISSION_DEFAULT_MAX_ACTIVE_RUNS;
    const maxActivePerOwner = intIn(env[ADMISSION_MAX_PER_OWNER_ENV], ADMISSION_MAX_PER_OWNER_ENV, errors);
    let stallSeconds = ADMISSION_STALL_DEFAULT_SECONDS;
    const rawStall = String(env[ADMISSION_STALL_ENV] ?? '').trim();
    if (rawStall) {
      if (/^\d+$/.test(rawStall) && Number(rawStall) >= 1 && Number(rawStall) <= 7 * 86400) stallSeconds = Number(rawStall);
      else errors.push(`${ADMISSION_STALL_ENV}=${rawStall} inválido (entero 1..604800); se usa ${ADMISSION_STALL_DEFAULT_SECONDS}`);
    }
    admission = { enabled: true, maxActiveRuns, maxActivePerOwner, stallSeconds };
  }
  return { policy, caps, capGraceByType, admission, errors };
}

/** Topes que alcanzan a alguno de estos tipos. */
export function capsForTypes(caps: readonly CapRule[], types: readonly string[]): CapRule[] {
  return caps.filter((c) => c.types.some((t) => types.includes(t)));
}

/**
 * Tipos que todavía tienen lugar según los running actuales por tope (`runningByCap[key]`). Pre-filtro barato (sin
 * lock); la verificación autoritativa es la del claim (lock de transacción por tope).
 */
export function typesWithRoom(types: readonly string[], caps: readonly CapRule[], runningByCap: Readonly<Record<string, number>>): string[] {
  return types.filter((t) => caps.every((c) => !c.types.includes(t) || (runningByCap[c.key] ?? 0) < c.max));
}

/**
 * ORDER BY del candidato del claim global. `fifo` = el de siempre (idéntico texto). Las otras dos usan las columnas
 * `os.last_claimed_at` (dueño) y `rs.last_claimed_at` (run) que agrega la consulta solo en esas políticas.
 */
export function candidateOrderBy(policy: SchedulerPolicy): string {
  if (policy === 'owner_rr') return 'order by os.last_claimed_at asc nulls first, g.created_at, mo.ord nulls last, g.id';
  if (policy === 'run_rr') return 'order by rs.last_claimed_at asc nulls first, pj.created_at, g.created_at, mo.ord nulls last, g.id';
  return 'order by g.created_at, mo.ord nulls last, g.id';
}

/**
 * CTEs + joins de «último servicio» para las políticas RR (vacío en `fifo`). Se calculan UNA vez por claim y solo
 * sobre los runs despachables (`statusesParam`): `rs` = max(claimed_at) por run de los tipos del claim (`typesParam`:
 * la ronda es por clase de worker), `os` = el máximo de esos por dueño. Solo lectura, sin locks.
 */
export function lastServedSql(policy: SchedulerPolicy, statusesParam: string, typesParam: string): { with: string; joins: string } {
  if (policy === 'fifo') return { with: '', joins: '' };
  const rs = `rs as (
         select x.job_id, max(x.claimed_at) as last_claimed_at
           from public.generation_item_runs x
           join public.production_jobs px on px.id = x.job_id
          where px.execution_mode = 'dynamic_generation' and px.worker_status = any(${statusesParam}::text[])
            and x.type = any(${typesParam}::text[])
          group by x.job_id)`;
  if (policy === 'run_rr') return { with: `with ${rs}`, joins: 'left join rs on rs.job_id = g.job_id' };
  const os = `os as (
         select px.owner_id, max(rs.last_claimed_at) as last_claimed_at
           from rs join public.production_jobs px on px.id = rs.job_id
          group by px.owner_id)`;
  return { with: `with ${rs}, ${os}`, joins: 'left join os on os.owner_id is not distinct from pj.owner_id' };
}

function positiveIntEnv(env: Env, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback; // mismo criterio que readPositiveInt de los workers
}

/**
 * Ventana EN VUELO (segundos) por tipo de parte: la misma que usa Q-21 para devolver una parte sin llamar
 * (IN_FLIGHT_WINDOW_MS de lease-takeover.ts y priorInFlightWindowMs de dynamic-llm-worker.ts), recalculada con ESTE env.
 */
export function inFlightWindowSecondsByType(env: Env = process.env): Record<string, number> {
  const llm = positiveIntEnv(env, LLM_WORKER_CALL_TIMEOUT_ENV, LLM_WORKER_CALL_TIMEOUT_DEFAULT_MS) + IN_FLIGHT_MARGIN_MS;
  const tts = Math.max(OPENAI_TTS_TIMEOUT_MS, ttsTimeoutMs(env as NodeJS.ProcessEnv).ms) + IN_FLIGHT_MARGIN_MS;
  const script = IN_FLIGHT_WINDOW_MS.anthropic;
  const ms: Record<string, number> = {};
  for (const t of Object.keys(PROVIDERS_OF_TYPE)) {
    ms[t] = t === 'video' ? IN_FLIGHT_WINDOW_MS.videogen
      : t === 'presentation' ? IN_FLIGHT_WINDOW_MS.gamma
        : t === 'audio_welcome' ? tts
          : t === 'audiobook_chapter' ? Math.max(tts, script)
            : llm;
  }
  return Object.fromEntries(Object.entries(ms).map(([t, v]) => [t, Math.ceil(v / 1000)]));
}

/** Parámetros de ventana para capOccupancySql: [tipos, segundos] en el mismo orden. */
export function capGraceParams(cfg: Pick<FairSchedulingConfig, 'capGraceByType'>): [string[], number[]] {
  const types = Object.keys(cfg.capGraceByType);
  return [types, types.map((t) => cfg.capGraceByType[t])];
}

/**
 * Partes que ocupan un tope (`typesParam` = tipos del tope; `wTypesParam`/`wSecsParam` = capGraceParams):
 *  - running (también con la lease vencida y sin barrer);
 *  - devueltas por Q-21 (`prior_call_in_flight…`) mientras su next_retry_at no llegó (= lo que falta de la ventana);
 *  - barridas por lease vencida durante la ventana en vuelo de su tipo, contada desde el barrido — también las que el
 *    barrido dejó `failed` (sin gracias ni intentos): su llamada puede seguir en vuelo igual (N2).
 * Mismo texto para el pre-filtro, el claim (bajo el lock del tope) y las métricas.
 */
export function capOccupancySql(typesParam: string, wTypesParam: string, wSecsParam: string): string {
  return `select count(*)::int as n from public.generation_item_runs g
           where g.type = any(${typesParam}::text[])
             and (g.status = 'running'
                  or (g.status in ('pending', 'retrying') and g.error like '${PRIOR_CALL_IN_FLIGHT}%' and g.next_retry_at > now())
                  or (g.status in ('pending', 'retrying', 'failed') and g.error = '${LEASE_EXPIRED}'
                      and g.updated_at > now() - make_interval(secs => coalesce(
                        (select w.s from unnest(${wTypesParam}::text[], ${wSecsParam}::int[]) as w(t, s) where w.t = g.type), 0))))`;
}

/**
 * Runs que OCUPAN lugar de admisión (`stallParam` = segundos de DYNAMIC_ADMISSION_STALL_SECONDS):
 *  - cualquier run abierto (también pausado o recién reanudado en `queued`) con alguna parte running (en vuelo);
 *  - un run running/retrying con actividad DEL EJECUTOR dentro del umbral: inicio del run, claim (`claimed_at`) o cierre
 *    (`finished_at`: completeItem / fallo terminal). NO cuenta `updated_at`: las reaperturas fuera del lock (retryItem,
 *    auto-heal, provider-reconcile, resolveYoutubeUpload, desbloqueo de dependientes) lo tocan y re-admitirían un run
 *    estancado sin pasar por el lock de admisión (N1). Esas rutas no tocan claimed_at y ponen finished_at = null.
 * Un run admitido sin partes running y sin actividad del ejecutor deja de ocupar (estancado) y vuelve por la cola.
 */
export function occupyingRunsSql(stallParam: string): string {
  return `select pj.id, pj.owner_id from public.production_jobs pj
           where pj.execution_mode = 'dynamic_generation'
             and pj.worker_status in ('queued', 'running', 'retrying', 'paused')
             and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
             and (exists (select 1 from public.generation_item_runs r where r.job_id = pj.id and r.status = 'running')
                  or (pj.worker_status in ('running', 'retrying')
                      and greatest(pj.started_at,
                                   (select max(greatest(a.claimed_at, a.finished_at)) from public.generation_item_runs a where a.job_id = pj.id))
                          > now() - make_interval(secs => ${stallParam}::int)))`;
}

/**
 * N3: posición en la cola de admisión en el ORDEN DE LA POLÍTICA (el mismo criterio que el claim global):
 *  fifo = alta del run; run_rr = run servido hace más tiempo (max claimed_at, nulls first); owner_rr = dueño servido hace
 *  más tiempo entre TODOS sus runs despachables, luego el alta. Solo entre los runs despachables que no ocupan lugar.
 *  Aproximación documentada: el claim real ordena por clase de worker y solo entre runs con algo reclamable de esa clase.
 *  Devuelve (id, pos). `statusesParam` = despachables, `stallParam` = umbral de estancado.
 */
export function admissionQueueSql(policy: SchedulerPolicy, statusesParam: string, stallParam: string): string {
  const order = policy === 'owner_rr' ? 'lo.l asc nulls first, w.created_at, w.id'
    : policy === 'run_rr' ? 'ls.l asc nulls first, w.created_at, w.id' : 'w.created_at, w.id';
  return `with d as (
            select pj.id, pj.owner_id, pj.created_at from public.production_jobs pj
             where pj.execution_mode = 'dynamic_generation' and pj.worker_status = any(${statusesParam}::text[])
               and coalesce(pj.status, '') not in ('cancelled', 'cancelling')),
          ls as (select x.job_id, max(x.claimed_at) as l from public.generation_item_runs x where x.job_id in (select id from d) group by x.job_id),
          lo as (select d.owner_id, max(ls.l) as l from d join ls on ls.job_id = d.id group by d.owner_id),
          w as (select d.* from d where d.id not in (select o.id from (${occupyingRunsSql(stallParam)}) o))
          select w.id, row_number() over (order by ${order})::int as pos
            from w left join ls on ls.job_id = w.id left join lo on lo.owner_id is not distinct from w.owner_id`;
}

/**
 * N3: gate GLOBAL de la cuota de YouTube (r62 P, mismo criterio que youtubeQuotaGateUntil de dynamic-item-worker.ts):
 * el `youtubeQuotaBlockedUntil` más lejano de un video abierto. Un run estancado cuya única parte reclamable es la
 * subida bloqueada por cuota NO se re-admite antes de ese instante (ocuparía un lugar sin poder subir nada).
 */
export const YOUTUBE_QUOTA_GATE_SQL = `select max((g.output_summary->>'youtubeQuotaBlockedUntil')::timestamptz) as gate_until
  from public.generation_item_runs g
 where g.type = 'video' and g.status in ('retrying', 'running', 'queued', 'pending')
   and (g.output_summary->>'youtubeQuotaBlockedUntil') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`;

/** Clave del advisory lock de transacción de un tope / de la admisión (hashtextextended). */
export const ADMISSION_LOCK_KEY = 'cursia:dynamic_generation:admission';
export function capLockKey(rule: CapRule): string { return `cursia:dynamic_generation:cap:${rule.key}`; }

const reported = new Set<string>();
/** logger.error una vez por proceso y por error (no inunda el log en cada claim). */
export function reportConfigErrorsOnce(errors: readonly string[], log: (m: string) => void): void {
  for (const e of errors) {
    if (reported.has(e)) continue;
    reported.add(e);
    log(`scheduler: configuración ignorada — ${e}`);
  }
}

/** Huella corta de la configuración efectiva (para comparar procesos en el log de arranque). */
export function fairSchedulingFingerprint(cfg: FairSchedulingConfig): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  const norm = JSON.stringify({ p: cfg.policy, c: cfg.caps, g: cfg.capGraceByType, a: cfg.admission });
  return createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

/**
 * H5 (rollout): cada proceso (API y workers) registra al arrancar su configuración de reparto y su huella. Si los
 * procesos no muestran la MISMA huella, los topes / la admisión se aplican distinto según quién reclame.
 */
export function logFairSchedulingConfig(log: { log: (m: string) => void; error: (m: string) => void }, processName: string, env: Env = process.env): string {
  const cfg = fairSchedulingConfig(env);
  const fp = fairSchedulingFingerprint(cfg);
  const adm = cfg.admission.enabled ? `on(max=${cfg.admission.maxActiveRuns}, porDueño=${cfg.admission.maxActivePerOwner ?? '-'}, estancado=${cfg.admission.stallSeconds}s)` : 'off';
  log.log(`scheduler [${processName}]: política=${cfg.policy}, topes=${cfg.caps.map((c) => `${c.key}=${c.max}`).join(',') || 'ninguno'}, admisión=${adm}, huella=${fp} ` +
    '(la API y todos los workers deben mostrar la MISMA huella)');
  for (const e of cfg.errors) log.error(`scheduler [${processName}]: configuración ignorada — ${e}`);
  return fp;
}
