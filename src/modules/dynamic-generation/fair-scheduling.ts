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
 *   - DYNAMIC_SCHEDULER_CAP_INFLIGHT_GRACE_SECONDS  (solo con topes) una parte cuya lease VENCIÓ hace menos de esto sigue
 *                                         contando para su tope (su llamada al proveedor puede seguir en vuelo: Q-21).
 *                                         Default 600 (la ventana de Videogen); 0 = solo las running.
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
export const CAP_INFLIGHT_GRACE_DEFAULT_SECONDS = 600;
/** Tope de cordura de cualquier límite configurable (un valor mayor es un error de configuración). */
export const CAP_LIMIT_MAX = 1000;

/** Motivo del claim cuando el run espera su turno de admisión (cola visible, no un error). */
export const ADMISSION_QUEUED_REASON = 'admission_queued' as const;

/** worker_status de un run ADMITIDO (ya empezó). Un run `queued` todavía no ocupa lugar. */
export const ADMITTED_RUN_WORKER_STATUSES: readonly string[] = ['running', 'retrying'];

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
  /** Segundos que una parte con la lease vencida (sweep → `lease_expired`) sigue contando para su tope. */
  capGraceSeconds: number;
  admission: { enabled: false } | { enabled: true; maxActiveRuns: number; maxActivePerOwner: number | null };
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
  let capGraceSeconds = CAP_INFLIGHT_GRACE_DEFAULT_SECONDS;
  const rawGrace = String(env[CAP_INFLIGHT_GRACE_ENV] ?? '').trim();
  if (rawGrace) {
    if (/^\d+$/.test(rawGrace) && Number(rawGrace) <= 3600) capGraceSeconds = Number(rawGrace);
    else errors.push(`${CAP_INFLIGHT_GRACE_ENV}=${rawGrace} inválido (entero 0..3600); se usa ${CAP_INFLIGHT_GRACE_DEFAULT_SECONDS}`);
  }
  const enabled = String(env[ADMISSION_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
  let admission: FairSchedulingConfig['admission'] = { enabled: false };
  if (enabled) {
    const maxActiveRuns = intIn(env[ADMISSION_MAX_ACTIVE_RUNS_ENV], ADMISSION_MAX_ACTIVE_RUNS_ENV, errors) ?? ADMISSION_DEFAULT_MAX_ACTIVE_RUNS;
    const maxActivePerOwner = intIn(env[ADMISSION_MAX_PER_OWNER_ENV], ADMISSION_MAX_PER_OWNER_ENV, errors);
    admission = { enabled: true, maxActiveRuns, maxActivePerOwner };
  }
  return { policy, caps, capGraceSeconds, admission, errors };
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

/**
 * Partes que ocupan un tope: las running (también con la lease vencida y sin barrer) y las que el barrido devolvió por
 * lease vencida hace menos de `graceParam` segundos (su llamada puede seguir en vuelo en el proveedor). `typesParam` =
 * tipos del tope. Mismo texto para el pre-filtro, el claim (bajo el lock del tope) y las métricas.
 */
export function capOccupancySql(typesParam: string, graceParam: string): string {
  return `select count(*)::int as n from public.generation_item_runs
           where type = any(${typesParam}::text[])
             and (status = 'running'
                  or (status in ('pending', 'retrying') and error = 'lease_expired'
                      and updated_at > now() - make_interval(secs => ${graceParam}::int)))`;
}

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
