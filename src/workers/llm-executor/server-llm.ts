import { createHash, randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { pauseRunForCap, reservePaidCall, RunBudgetCapReached, serverLlmChargeInput, settlePaidCall, WorkerLedger } from '../finops-worker-hooks';
import type { CallRole } from '../../modules/finops/finops-ledger.service';
import { itemRecoveryBudgetMessage } from '../../modules/finops/run-spend-guard';
import { LlmStreamError, LlmStreamResult, nonStreamMessage, streamMessage } from './anthropic-stream';
import { inFlightRemainingMs, PRIOR_CALL_IN_FLIGHT, priorCallInFlightMessage, retryAfterSecondsFor } from '../lease-takeover';
import { settleAmbiguousAsPossibleDuplicate } from '../../modules/finops/ambiguous-resend';
import { usd2 } from '../../modules/finops/usd-display';

/**
 * Loop 4 — `api()` del ejecutor cuando corre en el WORKER del backend (mismo contrato que `api()` de 04-api.js:
 * devuelve el texto, llena metaOut {stopReason, usage}, lanza {fatal, msg, status, …}).
 *
 * Por cada llamada: guard de gasto (pausa / tope / presupuesto de la parte / disyuntor) → reserva durable →
 * streaming directo a Anthropic (sin Cloudflare: sin 524) → liquidación exacta. Además:
 *  - PUNTO DE GUARDADO por respuesta: cada respuesta aceptada se guarda (Storage + índice en el item). Si la parte
 *    se reanuda (worker caído, lease vencido, drenaje, falla de subida), la MISMA llamada se responde desde el
 *    guardado: no se vuelve a generar ni a cobrar un paso ya terminado (p.ej. la 1.ª pasada de una Actividad).
 *  - REGLA DE DESCONOCIDO (aprobada en el Loop 4): un resultado desconocido (el pedido salió y no volvió nada) deja
 *    su reserva PENDIENTE; esa MISMA llamada (mismo pedido, identificado por su hash) se reintenta UNA vez
 *    automáticamente. Un segundo desconocido de la misma llamada → la parte queda en revisión (`llm_pending_review`),
 *    sin volver a generar; el resto del curso sigue. Se cuenta POR LLAMADA (no por parte) porque una sola caída del
 *    worker o de la red deja a la vez una reserva pendiente por cada llamada en paralelo de la parte, y eso es UN
 *    evento, no varios. Tope de seguridad anti-loop: LLM_UNKNOWN_ITEM_MAX desconocidos en total en la ventana de la
 *    parte (aunque sean llamadas distintas) → revisión. Se cuentan por sus reservas pendientes en el ledger
 *    (sobreviven a una caída del worker).
 */

export const LLM_WORKER_CALL_TAG_PREFIX = 'llmw';
export const LLM_PENDING_REVIEW = 'llm_pending_review';
/** Máximo de resultados desconocidos de UNA MISMA llamada antes de dejar la parte en revisión (1 reintento automático). */
export const LLM_UNKNOWN_MAX = 2;
/**
 * r62 (regla de ambigüedad acotada, punto 3; review N1 I2): el tope es por LLAMADA (LLM_UNKNOWN_MAX: a lo sumo un reenvío
 * de cada llamada desconocida) y por EVENTO: las reservas desconocidas de un mismo intento (un worker caído con k llamadas
 * en vuelo, o un corte que afecta a varias llamadas del intento) son UN evento; su reenvío conjunto se admite solo si
 * la suma de las reservas perdidas entra en el presupuesto de la parte y en el saldo del run. Un SEGUNDO evento ambiguo
 * en la ventana de la parte → revisión. LLM_UNKNOWN_ITEM_MAX queda solo como tope anti-bucle de respaldo (por encima de
 * la concurrencia del worker: un crash con todos los carriles en vuelo nunca lo alcanza).
 */
export const LLM_UNKNOWN_ITEM_MAX = 4;
/** r62 (re-review I2-bis): tope de respaldo = max(4, carriles en paralelo de la parte). */
export function llmUnknownItemMax(parallelCalls?: number | null): number {
  const n = Math.floor(Number(parallelCalls ?? 0));
  return Math.max(LLM_UNKNOWN_ITEM_MAX, Number.isFinite(n) && n > 0 ? n : 0);
}
/** r62: eventos ambiguos admitidos por ventana de la parte. */
export const LLM_UNKNOWN_EVENT_MAX = 1;
/** Prefijo del hash del pedido dentro del callTag de la reserva (identifica "la misma llamada" entre intentos y workers). */
export const LLM_CALL_HASH_LEN = 12;
export const LLM_WORKER_MAX_TOKENS_CAP = 16000;
/**
 * r64 (R1 #1567): la MISMA solicitud cortada a mitad del stream no se repite igual. Tras un corte, esa llamada se
 * reenvía por el transporte sin streaming (respuesta entera o error HTTP conocido, sin cobro a medias). Este código es
 * la guarda defensiva si un transporte sin streaming llegara a cortarse (hoy no ocurre: falla como HTTP/desconocido).
 */
export const LLM_OUTPUT_CUT_REPEATED = 'llm_output_cut_repeated';
export type LlmTransport = 'stream' | 'nonstream';

/**
 * r64: ¿alguna llamada de esta parte ya se cortó a mitad del stream desde `since` (este intento o uno anterior,
 * otro proceso incluido; el worker pasa toda la historia de la fila)? En R1 los cortes fueron de UNA parte (la principal y sus reintentos dirigidos):
 * con un corte, toda la parte sigue sin streaming. Lee el ledger: el cargo conservador del corte
 * (`metadata.streamCut`) o su ajuste (`llm_worker_stream_cut_conservative`). Ante un error de lectura responde
 * `false` (el primer envío vuelve a ser por streaming; nunca bloquea).
 */
export async function priorStreamCut(ds: Pick<DataSource, 'query'>, itemRunId: string, since: Date): Promise<boolean> {
  try {
    const rows = await ds.query(
      `select exists (select 1 from public.generation_cost_events
         where item_run_id = $1 and created_at >= $2
           and ((event_kind = 'CHARGE' and metadata ? 'streamCut')
             or (event_kind = 'ADJUSTMENT' and metadata->>'reason' = 'llm_worker_stream_cut_conservative'))) as stream_cut_seen`,
      [itemRunId, since],
    );
    return !!(rows && rows[0] && (rows[0].stream_cut_seen === true || rows[0].stream_cut_seen === 't'));
  } catch {
    return false;
  }
}

export interface ServerLlmItem {
  itemRunId: string;
  runId: string;
  itemKey: string;
  attempt: number;
  generation: number;
  ownerId: string;
  artifactCourseId: string;
  manifestId: number | string;
}

export interface ServerLlmDeps {
  dataSource: DataSource;
  finops: WorkerLedger;
  budget: {
    guardServerLlmCall(a: { runId: string; itemRunId: string; model: string; promptChars: number; maxTokens: number }): Promise<null | {
      code: 'run_paused' | 'item_recovery_budget_exhausted' | 'run_budget_not_authorized'; message: string; runId: string; paused: boolean;
    }>;
    /** FinOps atómico: pausa por el tope cuando la RESERVA se rechazó (el guard ya había permitido). */
    pauseRunBySystem?(runId: string, reason: string, detail: string, requiredUsd?: number | null): Promise<boolean>;
    /**
     * r62 (regla de ambigüedad acotada, punto 3): ¿el PEOR caso de reenviar una llamada ambigua (lo gastado por la parte,
     * con la reserva perdida, + la reserva nueva) entra en el presupuesto de recuperación de la parte y en el saldo del
     * run? Obligatorio (review I3): sin él —o sin `finops.reconcileReservationAsCharged`— nunca se reenvía (falla cerrado:
     * la parte queda en revisión con humanReason budget).
     */
    ambiguousResendBudget(a: { runId: string; itemRunId: string; nextCost: number; authorization: 'paid' | 'any' }): Promise<{ fits: boolean; reason: string | null; worstItem: number; worstRun: number }>;
  };
  /** Guardado de respuestas (Storage). */
  checkpoints: {
    put(path: string, json: string): Promise<void>;
    get(path: string): Promise<string | null>;
  };
  /** Agrega entradas al índice de guardados del item (merge ATÓMICO bajo lease: hay llamadas en paralelo). */
  recordCheckpoint(itemRunId: string, entries: Record<string, { path: string; at: string }>): Promise<boolean>;
  /**
   * r61 (Q-21): guardado TARDÍO de una respuesta pagada cuando este worker ya perdió la parte (recordCheckpoint
   * rechazado). Solo agrega la clave `hash` si todavía no existe (nunca pisa nada del intento nuevo) y si el pedido
   * salió (`sentAt`) dentro de la ventana vigente de la parte. Así el reclamante nuevo responde desde el guardado
   * en vez de volver a pagar la misma llamada. Sin el campo: comportamiento anterior (el guardado se pierde).
   */
  recordLateCheckpoint?(itemRunId: string, hash: string, entry: { path: string; at: string; lateFromAttempt: number }, sentAt: string): Promise<boolean>;
  /**
   * r61 (Q-21): ventana (ms) en la que una llamada de OTRO intento con el mismo hash, reservada y sin liquidar, todavía
   * puede estar en vuelo → no se reenvía; la parte se devuelve (`prior_call_in_flight`, retryAfter ≥ lo que falta).
   * Sin el campo (o ≤ 0) no se mira (comportamiento anterior). El worker lo fija a totalMs + margen.
   */
  priorInFlightWindowMs?: number;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  idleMs: number;
  totalMs: number;
  fetchImpl?: typeof fetch;
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
  /**
   * Review I3/M3: antes de CADA llamada pagada. Devuelve el motivo para no hacerla y devolver la parte ('lease_lost':
   * la parte ya no es de este worker; 'worker_draining': deploy) o null. Así un worker que perdió la parte o que se
   * está apagando nunca sigue gastando: la llamada en vuelo termina (y queda guardada) y la siguiente no sale.
   */
  shouldStop?: () => 'lease_lost' | 'worker_draining' | null;
  /** Reintentos de la liquidación en el ledger tras una respuesta OK (review I6). */
  settleRetryDelaysMs?: number[];
  /**
   * r62 (E2E M): marca DURABLE de envío (`output_summary.llmSent[reservationKey] = sentAt`) escrita justo ANTES del fetch,
   * bajo la lease. Con ella, una reserva de un intento caído SIN marca nunca salió → se libera sola (`never_sent`); con
   * marca es ambigua (regla del punto 3). false = la parte ya no es de este worker (no se envía). Sin el campo, las
   * reservas no llevan `sendMarked` y se tratan como siempre (ambiguas).
   */
  markSent?(itemRunId: string, reservationKey: string, sentAt: string): Promise<boolean>;
  /** r62 (I2-bis): llamadas en paralelo que el ejecutor puede hacer en una parte (tope de respaldo = max(4, esto)). */
  maxParallelCalls?: number;
}

/** Error con la forma que espera el ejecutor (04-api.js). */
type ApiError = { fatal: boolean; msg: string; status?: number; code?: string; runPaused?: boolean; itemBudget?: boolean; pendingReview?: boolean; ambiguous?: boolean; handBack?: 'lease_lost' | 'worker_draining' | typeof PRIOR_CALL_IN_FLIGHT; retryAfterSeconds?: number };

/** HTTP que NO prueba que Anthropic no procesó el pedido (timeout de gateway): se trata como resultado desconocido. */
const LLM_HTTP_AMBIGUOUS_STATUSES: readonly number[] = [408, 504];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * r65 (R4): max_tokens de la ronda automática extra de una parte que agotó su tope (output_summary.autoBudgetExtension):
 * ×1,5 del pedido (las salidas de R1 rondaban el tope de 5000), con el tope del worker.
 */
export function autoBudgetExtensionMaxTokens(maxTok?: number): number {
  return Math.max(1, Math.min(LLM_WORKER_MAX_TOKENS_CAP, Math.ceil((maxTok || 4000) * 1.5)));
}

/** Ventana de la parte (igual que el presupuesto de recuperación): generación vigente desde su último reinicio. */
export async function itemWindowStart(ds: DataSource, itemRunId: string): Promise<{ since: Date; checkpoints: Record<string, { path: string; at: string }>; sent: Record<string, string>; autoBudgetExtension: boolean }> {
  const [r] = await ds.query(
    `select greatest(created_at, coalesce(nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz, created_at)) as since,
            coalesce(output_summary->'llmCheckpoints', '{}'::jsonb) as cps,
            coalesce(output_summary->'llmSent', '{}'::jsonb) as sent,
            -- r65 (R4): la parte está en su ronda automática extra por tope agotado (cambio de estrategia).
            coalesce(output_summary ? 'autoBudgetExtension', false) as auto_ext
       from public.generation_item_runs where id = $1`,
    [itemRunId],
  );
  return { since: r ? new Date(r.since) : new Date(0), checkpoints: (r && r.cps) || {}, sent: (r && r.sent && typeof r.sent === 'object') ? r.sent : {},
    autoBudgetExtension: !!r && (r.auto_ext === true || r.auto_ext === 't') };
}

/** r62: el SQL que inserta la marca de envío (merge atómico bajo la lease del worker). */
export const LLM_MARK_SENT_SQL =
  `update public.generation_item_runs
      set output_summary = jsonb_set(coalesce(output_summary, '{}'::jsonb), '{llmSent}',
                                     coalesce(output_summary->'llmSent', '{}'::jsonb) || jsonb_build_object($3::text, $4::text)), updated_at = now()
    where id = $1 and worker_id = $2 and status = 'running' returning id`;

/** Desconocidos de la parte en su ventana = reservas del worker que siguen pendientes (ni liquidadas ni liberadas). */
/**
 * Reservas del worker sin liquidar en la ventana de la parte = resultados desconocidos. `exclude`: reservas que ESTE
 * proceso todavía tiene en vuelo o cuya respuesta sí llegó (review I1/I6) — nunca cuentan como desconocidas.
 */
export async function countUnknownCalls(ds: DataSource, itemRunId: string, since: Date, callHash?: string, exclude: readonly string[] = []): Promise<number> {
  const tagLike = callHash ? `${LLM_WORKER_CALL_TAG_PREFIX}-%-${callHash.slice(0, LLM_CALL_HASH_LEN)}-%` : `${LLM_WORKER_CALL_TAG_PREFIX}-%`;
  const [r] = await ds.query(
    `select count(*)::int as n from public.generation_cost_events e
      where e.idempotency_key like $1 and e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'
        and (e.metadata->>'callTag') like $2 and e.created_at >= $3
        and (${UNKNOWN_RESERVATION_SQL})
        and not (e.idempotency_key = any($4::text[]))`,
    [`reservation:llm:${itemRunId}:%`, tagLike, since.toISOString(), [...exclude]],
  );
  return r ? Number(r.n) : 0;
}

/**
 * r61 (Q-21): la llamada `hash` de OTRO intento de la parte (clave `…:a<n>:` distinta de la propia), reservada y sin
 * liquidar, todavía puede estar en vuelo. Devuelve los ms que faltan (0 = nada en vuelo). La edad se mide con el
 * reloj de la DB (created_at de la reserva vs now()), así dos workers con relojes distintos ven la misma ventana.
 */
export async function priorAttemptInFlightMs(ds: DataSource, itemRunId: string, since: Date, callHash: string, ownAttempt: number, windowMs: number): Promise<number> {
  const [r] = await ds.query(
    `select coalesce(max(extract(epoch from (e.created_at + make_interval(secs => $5::double precision) - now())) * 1000), 0)::float8 as remaining_ms
       from public.generation_cost_events e
      where e.idempotency_key like $1 and e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'
        and (e.metadata->>'callTag') like $2 and e.created_at >= $3
        and e.idempotency_key not like $4
        and e.created_at > now() - make_interval(secs => $5::double precision)
        and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`,
    [`reservation:llm:${itemRunId}:%`, `${LLM_WORKER_CALL_TAG_PREFIX}-%-${callHash.slice(0, LLM_CALL_HASH_LEN)}-%`, since.toISOString(),
      `reservation:llm:${itemRunId}:g%:a${ownAttempt}:%`, windowMs / 1000],
  );
  const ms = r ? Number(r.remaining_ms) : 0;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, windowMs) : 0;
}

/**
 * r62: una reserva del worker es un resultado DESCONOCIDO si sigue sin liquidar, o si el sistema la liquidó como
 * cobrada con la marca `possibleDuplicate` (regla de ambigüedad acotada): sigue contando para los topes de la parte.
 */
const UNKNOWN_RESERVATION_SQL = `not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
             or exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id and a.event_kind = 'ADJUSTMENT'
                         and coalesce(a.metadata->>'possibleDuplicate', '') = 'true')`;

export interface UnknownReservation {
  key: string;
  amount: number;
  /** Intento que la creó (de la clave `…:a<n>:…`). */
  attempt: number;
  /** La reserva usa la marca durable de envío (llmSent). */
  sendMarked: boolean;
  /** Ya liquidada por el sistema como cobrada con la marca possible_duplicate (sigue siendo un desconocido). */
  possibleDuplicate: boolean;
  createdAt: Date | null;
}

const attemptOfKey = (key: string): number => {
  const m = /:a(\d+):/.exec(key);
  return m ? Number(m[1]) : 0;
};

/**
 * r62: reservas DESCONOCIDAS del worker en la ventana de la parte (sin liquidar; con `includePossibleDuplicate`, también
 * las ya liquidadas por el sistema como posible duplicado). `callHash` acota a UNA llamada. `exclude`: reservas que este
 * proceso tiene en vuelo o cuya respuesta sí llegó (nunca cuentan).
 */
export async function unknownReservations(
  ds: DataSource, itemRunId: string, since: Date, opts: { callHash?: string; exclude?: readonly string[]; includePossibleDuplicate?: boolean } = {},
): Promise<UnknownReservation[]> {
  const tagLike = opts.callHash ? `${LLM_WORKER_CALL_TAG_PREFIX}-%-${opts.callHash.slice(0, LLM_CALL_HASH_LEN)}-%` : `${LLM_WORKER_CALL_TAG_PREFIX}-%`;
  const rows: Array<Record<string, any>> = await ds.query(
    `select e.idempotency_key as key, e.amount::text as amount, e.created_at,
            coalesce((e.metadata->>'sendMarked') = 'true', false) as send_marked,
            exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id) as settled
       from public.generation_cost_events e
      where e.idempotency_key like $1 and e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'
        and (e.metadata->>'callTag') like $2 and e.created_at >= $3
        and not (e.idempotency_key = any($4::text[]))
        and (not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
             or ($5::boolean and exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id and a.event_kind = 'ADJUSTMENT'
                                          and coalesce(a.metadata->>'possibleDuplicate', '') = 'true')))
      order by e.created_at, e.id`,
    [`reservation:llm:${itemRunId}:%`, tagLike, since.toISOString(), [...(opts.exclude ?? [])], !!opts.includePossibleDuplicate],
  );
  return rows.map((r) => ({
    key: String(r.key), amount: Number(r.amount) || 0, attempt: attemptOfKey(String(r.key)), sendMarked: r.send_marked === true || r.send_marked === 't',
    possibleDuplicate: r.settled === true || r.settled === 't' || r.possibleDuplicate === true, createdAt: r.created_at ? new Date(r.created_at) : null,
  }));
}

/** Compat r62 (fakes / harnesses): reservas sin liquidar de UNA llamada. */
export async function pendingUnknownReservations(ds: DataSource, itemRunId: string, since: Date, callHash: string, exclude: readonly string[] = []): Promise<Array<{ key: string; amount: number }>> {
  return (await unknownReservations(ds, itemRunId, since, { callHash, exclude })).map((u) => ({ key: u.key, amount: u.amount }));
}

/**
 * r62 (re-review I2-bis): EVENTOS ambiguos de la parte en su ventana. Un evento es:
 *  - todas las desconocidas de UN intento anterior (caído / tomado: sus llamadas estaban en vuelo a la vez);
 *  - en el intento actual, las que se SOLAPARON en el tiempo: creadas hasta el momento en que este proceso detectó su
 *    primer desconocido (`firstUnknownAt`). Una desconocida creada DESPUÉS (p. ej. tras el reenvío de la primera) es un
 *    evento NUEVO → la parte va a revisión.
 * Sin `firstUnknownAt` (todavía no hubo desconocidos en este proceso) las del intento actual cuentan como un evento.
 */
export function countUnknownEvents(all: ReadonlyArray<Pick<UnknownReservation, 'attempt' | 'createdAt'>>, currentAttempt: number, firstUnknownAt: Date | null): number {
  const prior = new Set(all.filter((u) => u.attempt !== currentAttempt).map((u) => u.attempt));
  const cur = all.filter((u) => u.attempt === currentAttempt);
  let curEvents = 0;
  if (cur.length) {
    if (!firstUnknownAt) curEvents = 1;
    else {
      const overlap = cur.some((u) => !u.createdAt || u.createdAt.getTime() <= firstUnknownAt.getTime());
      const later = cur.some((u) => !!u.createdAt && u.createdAt.getTime() > firstUnknownAt.getTime());
      curEvents = (overlap ? 1 : 0) + (later ? 1 : 0);
    }
  }
  return prior.size + curEvents;
}

/**
 * r62 (re-review I2-ter): instante de detección con el reloj de la DB (el mismo de `created_at` de las reservas, como
 * priorAttemptInFlightMs), nunca el del worker: con relojes desfasados el solapamiento se decidiría mal. Si la DB no
 * responde, se usa el alta de la propia reserva desconocida (más eventos → revisión: falla cerrado).
 */
export async function dbNow(ds: DataSource, fallbackReservationKey?: string): Promise<Date> {
  try {
    const [r] = await ds.query(`select now() as db_now`);
    const d = r && r.db_now ? new Date(r.db_now) : null;
    if (d && Number.isFinite(d.getTime())) return d;
  } catch { /* abajo */ }
  if (fallbackReservationKey) {
    try {
      const [e] = await ds.query(`select created_at as db_now from public.generation_cost_events where idempotency_key = $1`, [fallbackReservationKey]);
      const d = e && e.db_now ? new Date(e.db_now) : null;
      if (d && Number.isFinite(d.getTime())) return d;
    } catch { /* abajo */ }
  }
  return new Date(0);
}

/**
 * null = se puede (re)intentar; si no, el motivo de dejar la parte en revisión. r62 (I2 / I2-bis): por LLAMADA (≤ 1
 * reenvío), por EVENTO (countUnknownEvents ≤ LLM_UNKNOWN_EVENT_MAX) y tope de respaldo max(4, carriles).
 */
async function unknownLimitReached(
  ds: DataSource, itemRunId: string, since: Date, hash: string, exclude: readonly string[],
  ctx: { attempt: number; firstUnknownAt: Date | null; maxParallelCalls?: number } = { attempt: 0, firstUnknownAt: null },
): Promise<string | null> {
  const same = await countUnknownCalls(ds, itemRunId, since, hash, exclude);
  if (same >= LLM_UNKNOWN_MAX) return `${same} intentos de la misma llamada sin respuesta`;
  const all = await unknownReservations(ds, itemRunId, since, { exclude, includePossibleDuplicate: true });
  const events = countUnknownEvents(all, ctx.attempt, ctx.firstUnknownAt);
  if (events > LLM_UNKNOWN_EVENT_MAX) return `${events} eventos ambiguos (llamadas sin respuesta en momentos distintos) en esta parte`;
  const total = await countUnknownCalls(ds, itemRunId, since, undefined, exclude);
  const cap = llmUnknownItemMax(ctx.maxParallelCalls);
  if (total >= cap) return `${total} llamadas sin respuesta en esta parte (tope ${cap})`;
  return null;
}

/**
 * r62 (E2E M): reservas de intentos ANTERIORES que usan la marca de envío y no la tienen → nunca salieron (el worker
 * murió entre reservar y enviar): se liberan (`never_sent`, sin gasto). Solo pasada la ventana en vuelo (un worker vivo
 * entre la reserva y la marca no pierde la suya). Devuelve las claves liberadas.
 */
async function releaseNeverSentOrphans(deps: ServerLlmDeps, item: ServerLlmItem, win: { since: Date; sent: Record<string, string> }, exclude: readonly string[]): Promise<string[]> {
  const all = await unknownReservations(deps.dataSource, item.itemRunId, win.since, { exclude });
  const minAgeMs = Math.max(0, deps.priorInFlightWindowMs ?? 0);
  const out: string[] = [];
  for (const u of all) {
    if (u.attempt === item.attempt || !u.sendMarked || win.sent[u.key]) continue;
    if (minAgeMs > 0 && u.createdAt && Date.now() - u.createdAt.getTime() < minAgeMs) continue;
    await settlePaidCall(deps.finops, u.key, null, 'llm_worker_never_sent_orphan');
    out.push(u.key);
  }
  if (out.length) deps.logger.warn(`[llm-worker] ${item.itemKey}: ${out.length} reserva(s) de un intento anterior nunca enviada(s) → liberada(s) sin gasto`);
  return out;
}

/** Mismo mapeo de errores HTTP que api() del navegador (04-api.js). */
function httpError(status: number, body: string): ApiError {
  let msg = body;
  try { const j = JSON.parse(body); msg = (j && j.error && j.error.message) || body; } catch { /* texto plano */ }
  if (status === 401 || status === 403) return { fatal: true, status, msg: '❌ No tienes acceso. Inicia sesión o verifica tu cuenta en Cursia.' };
  if (/credit|balance/i.test(msg)) return { fatal: true, status, msg: '❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.' };
  if (status === 400) {
    if (/model/i.test(msg)) return { fatal: true, status, msg: '❌ Error de configuración interna. Intenta nuevamente o contacta soporte.' };
    return { fatal: true, status, msg: '❌ Error al procesar la solicitud: ' + String(msg).slice(0, 300) };
  }
  if (status === 429 || status === 529 || status === 503 || status === 502) return { fatal: false, status, msg: `Servidor ocupado (${status}). Reintentando…` };
  if (status >= 500) return { fatal: false, status, msg: `Error del servidor (${status}). Reintentando…` };
  return { fatal: false, status, msg: `Error de red (${status}): ${String(msg).slice(0, 200)}` };
}

/**
 * Loop 6 (O5): mismo contrato que apiCachedUserContent (04-api.js) — el prefijo pedido va como bloque con
 * cache_control y el resto como otro bloque; la concatenación es byte-idéntica al mensaje original. Si el prefijo no
 * es el comienzo del mensaje (o el mensaje ya viene en bloques), no se toca nada.
 */
export function cachedUserContent(user: unknown, cacheOpts?: { cachePrefix?: string }): unknown {
  const pre = cacheOpts && typeof cacheOpts.cachePrefix === 'string' ? cacheOpts.cachePrefix : '';
  if (!pre || typeof user !== 'string' || !user.startsWith(pre)) return user;
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: pre, cache_control: { type: 'ephemeral' } }];
  if (user.length > pre.length) blocks.push({ type: 'text', text: user.slice(pre.length) });
  return blocks;
}

/**
 * r58 (record/replay): el pedido EXACTO que el worker manda a Anthropic por cada llamada de api() — una sola definición
 * para el worker (createServerApi) y para el replay offline (scripts/lib/replay-api.js): mismo body ⇒ mismo hash ⇒
 * los puntos de guardado del servidor sirven de fixtures sin volver a pagar.
 */
export function serverLlmRequestBody(a: {
  system: unknown; user: unknown; maxTok?: number; schema?: unknown; model?: string; defaultModel: string; cacheOpts?: { cachePrefix?: string };
}): { body: Record<string, unknown>; model: string; maxTokens: number } {
  const useModel = a.model || a.defaultModel;
  const maxTokens = Math.max(1, Math.min(a.maxTok || 4000, LLM_WORKER_MAX_TOKENS_CAP));
  const body: Record<string, unknown> = { model: useModel, max_tokens: maxTokens, system: a.system, messages: [{ role: 'user', content: cachedUserContent(a.user, a.cacheOpts) }] };
  if (a.schema) body.output_config = { format: { type: 'json_schema', schema: a.schema } };
  return { body, model: useModel, maxTokens };
}

/** Hash del pedido (clave del punto de guardado `output_summary.llmCheckpoints[hash]`). */
export function serverLlmRequestHash(body: Record<string, unknown>): string {
  return sha(JSON.stringify(body));
}

export function pendingReviewMessage(detail: string): string {
  return `${LLM_PENDING_REVIEW}: resultado ambiguo repetido de la IA (${detail}). Esta parte queda en revisión sin volver a generarse; el resto del curso sigue. Se conservan las reservas para conciliarlas.`;
}

export function createServerApi(deps: ServerLlmDeps, item: ServerLlmItem, roleOf: (extraHeaders: any) => { callRole: CallRole; attempt: number }) {
  let seq = 0;
  // Reservas de ESTE proceso que no son desconocidas: en vuelo (todavía sin resultado) o con respuesta recibida cuya
  // liquidación falló (quedan pendientes en el ledger para conciliar, pero la respuesta sí llegó).
  const notUnknown = new Set<string>();
  let neverSentChecked = false;
  // r62 (I2-bis): instante en que ESTE proceso detectó su primer resultado desconocido (solapamiento de un evento).
  let firstUnknownAt: Date | null = null;
  const unknownCtx = () => ({ attempt: item.attempt, firstUnknownAt, maxParallelCalls: deps.maxParallelCalls });
  // r64: llamadas (hash) de este proceso que ya se cortaron a mitad del stream; con una, la parte sigue sin streaming.
  const cutCalls = new Map<string, { cuts: number; causes: string[] }>();
  let streamCutSeen: boolean | null = null; // null = todavía no se miró el ledger de la parte
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const api = async function api(system: unknown, user: unknown, maxTok?: number, schema?: unknown, model?: string, metaOut?: Record<string, any>, extraHeaders?: Record<string, string>, cacheOpts?: { cachePrefix?: string }): Promise<string> {
    // r65 (R4): la ventana se lee ANTES de armar el pedido. Una parte en su ronda automática extra (tope de la parte
    // agotado, output_summary.autoBudgetExtension) cambia de estrategia: sin streaming y max_tokens × 1,5 (con el tope del
    // worker). El hash del pedido cambia (max_tokens es parte del body): es OTRA solicitud, sin punto de guardado previo
    // (además, los guardados de antes del reinicio del presupuesto quedan fuera de la ventana). La reserva y el guard
    // usan ese max_tokens nuevo (maxTokens sale del body).
    const win = await itemWindowStart(deps.dataSource, item.itemRunId);
    const extended = win.autoBudgetExtension === true;
    const { body, model: useModel, maxTokens } = serverLlmRequestBody({ system, user, maxTok: extended ? autoBudgetExtensionMaxTokens(maxTok) : maxTok, schema, model, defaultModel: deps.defaultModel, cacheOpts });
    const hash = serverLlmRequestHash(body);
    const role = roleOf(extraHeaders);

    // ── Punto de guardado: la misma llamada ya respondida en esta ventana de la parte → sin costo ni generación. ──
    const fromCheckpoint = async (w: { since: Date; checkpoints: Record<string, { path: string; at: string }> }): Promise<string | null> => {
      const cp = w.checkpoints[hash];
      if (!cp || !(new Date(cp.at) >= w.since)) return null;
      const raw = await deps.checkpoints.get(cp.path).catch(() => null);
      let saved: { text: string; usage: Record<string, number>; stopReason: string | null } | null = null;
      try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; } // guardado ilegible = no hay guardado (M2)
      if (!saved || typeof saved.text !== 'string' || !saved.text) return null;
      if (metaOut) { metaOut.stopReason = saved.stopReason; metaOut.usage = { ...saved.usage }; metaOut.fromCheckpoint = true; }
      deps.logger.log(`[llm-worker] ${item.itemKey}: respuesta desde el punto de guardado (${hash.slice(0, 10)}) — sin costo`);
      return saved.text;
    };
    const cached = await fromCheckpoint(win);
    if (cached !== null) return cached;
    // r64: transporte de ESTA llamada. Si ya se cortó por streaming (aquí o en un intento anterior), va sin streaming.
    // Toda la historia de ESTA fila (no solo la ventana vigente): un reintento manual reinicia el presupuesto, pero los
    // cortes anteriores siguen siendo evidencia de que su stream falla (R1: la parte se reintenta sobre sus 5 cortes).
    if (streamCutSeen === null) streamCutSeen = await priorStreamCut(deps.dataSource, item.itemRunId, new Date(0));
    let transport: LlmTransport = extended || streamCutSeen || cutCalls.size > 0 ? 'nonstream' : 'stream';

    // FinOps atómico (review I2): la cota cuenta el body ENTERO que se envía (sistema, mensaje y el esquema de salida).
    const promptChars = JSON.stringify(body).length;
    for (;;) {
      // r61 (Q-21): la MISMA llamada de otro intento (lease tomada) puede seguir en vuelo → nunca se reenvía. Va ANTES de
      // shouldStop (review I1): aun drenando, la parte se devuelve como prior_call_in_flight y la señal no se pierde. Con
      // la ventana activa se relee el guardado justo antes de enviar aunque no haya nada en vuelo (review M1: el
      // guardado tardío de A puede llegar entre la primera lectura y este punto, también en el `continue` del reintento).
      if (deps.priorInFlightWindowMs && deps.priorInFlightWindowMs > 0) {
        const left = await priorAttemptInFlightMs(deps.dataSource, item.itemRunId, win.since, hash, item.attempt, deps.priorInFlightWindowMs);
        const again = await fromCheckpoint(await itemWindowStart(deps.dataSource, item.itemRunId));
        if (again !== null) return again;
        if (left > 0) {
          deps.logger.warn(`[llm-worker] ${item.itemKey}: la llamada ${hash.slice(0, 10)} de un intento anterior sigue en vuelo — no se reenvía; la parte vuelve a la cola`);
          throw { fatal: true, handBack: PRIOR_CALL_IN_FLIGHT, code: PRIOR_CALL_IN_FLIGHT, retryAfterSeconds: retryAfterSecondsFor(left), msg: priorCallInFlightMessage('la llamada a la IA', left) } as ApiError;
        }
      }
      const stop = deps.shouldStop ? deps.shouldStop() : null;
      if (stop) throw { fatal: true, handBack: stop, code: stop, msg: `${stop}: la parte vuelve a la cola antes de una llamada nueva` } as ApiError;
      // r62 (E2E M): reservas de intentos anteriores que NUNCA salieron (worker muerto entre reservar y enviar) se liberan
      // antes de contar desconocidos: no son ambiguas.
      if (!neverSentChecked) {
        neverSentChecked = true;
        await releaseNeverSentOrphans(deps, item, await itemWindowStart(deps.dataSource, item.itemRunId), [...notUnknown]);
      }
      const unknownReason = await unknownLimitReached(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown], unknownCtx());
      if (unknownReason) {
        throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW, msg: pendingReviewMessage(unknownReason) } as ApiError;
      }
      // r62 (regla de ambigüedad acotada, punto 3; review I2/I3): esta llamada ya tiene un resultado DESCONOCIDO sin
      // conciliar (de este intento o de uno caído, pasada la ventana en vuelo de Q-21) → el envío que sigue es un REENVÍO
      // AMBIGUO. El EVENTO son todas las reservas desconocidas sin conciliar de ese intento (un crash con k carriles en
      // vuelo): su suma tiene que entrar en el presupuesto de la parte y en el saldo del run; entonces se liquidan TODAS
      // como cobradas (possible_duplicate, actor system) y cada carril reenvía su llamada una vez. Falla cerrado: sin la
      // evaluación del presupuesto o sin la liquidación, nunca se reenvía (revisión).
      const priorUnknown = await unknownReservations(deps.dataSource, item.itemRunId, win.since, { callHash: hash, exclude: [...notUnknown] });
      if (priorUnknown.length > 0) {
        const eventAttempts = new Set(priorUnknown.map((u) => u.attempt));
        const group = (await unknownReservations(deps.dataSource, item.itemRunId, win.since, { exclude: [...notUnknown] })).filter((u) => eventAttempts.has(u.attempt));
        const keys = [...new Set([...priorUnknown, ...group].map((u) => u.key))];
        const amountOf = new Map([...priorUnknown, ...group].map((u) => [u.key, u.amount]));
        const nextCost = keys.reduce((t, k) => t + (amountOf.get(k) ?? 0), 0);
        if (typeof deps.budget.ambiguousResendBudget !== 'function' || typeof deps.finops.reconcileReservationAsCharged !== 'function') {
          throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW,
            msg: pendingReviewMessage('el reenvío no entra en el presupuesto autorizado (sin evaluación del presupuesto o sin conciliación en este worker: falla cerrado)') } as ApiError;
        }
        const b = await deps.budget.ambiguousResendBudget({ runId: item.runId, itemRunId: item.itemRunId, nextCost, authorization: 'any' });
        if (!b.fits) {
          throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW,
            msg: pendingReviewMessage(`el reenvío no entra en el presupuesto autorizado (${b.reason}; peor caso de la parte USD ${usd2(b.worstItem)}, del run USD ${usd2(b.worstRun)})`) } as ApiError;
        }
        const settled = await settleAmbiguousAsPossibleDuplicate(deps.finops as Required<Pick<WorkerLedger, 'reconcileReservationAsCharged'>>, keys, {
          provider: 'anthropic', cause: 'unknown_result', itemRunId: item.itemRunId, itemKey: item.itemKey, runId: item.runId,
        });
        if (settled.failed.length) throw new Error(`no se pudo liquidar la reserva desconocida ${settled.failed[0].key}: ${settled.failed[0].error}`);
        deps.logger.warn(`[llm-worker] ${item.itemKey}: reenvío ambiguo ÚNICO de la llamada ${hash.slice(0, 10)} — evento de ${keys.length} reserva(s) perdida(s) liquidada(s) como posible duplicado (USD ${nextCost.toFixed(4)})`);
      }
      const deny = await deps.budget.guardServerLlmCall({ runId: item.runId, itemRunId: item.itemRunId, model: useModel, promptChars, maxTokens });
      if (deny) {
        if (deny.code === 'item_recovery_budget_exhausted') {
          throw { fatal: true, itemBudget: true, status: 409, code: deny.code, msg: itemRecoveryBudgetMessage(deny.message) } as ApiError;
        }
        // r58 H4: run sin ninguna autorización → no se llama (0 gasto); el guard pausó el run y la parte vuelve a la cola.
        if (deny.code === 'run_budget_not_authorized') {
          throw { fatal: true, runPaused: true, status: 409, code: deny.code, msg: 'run_budget_not_authorized: ' + deny.message } as ApiError;
        }
        throw { fatal: true, runPaused: true, status: 409, code: 'run_paused', msg: 'run_paused: ' + deny.message } as ApiError;
      }
      const tag = `${LLM_WORKER_CALL_TAG_PREFIX}-${role.callRole}-${hash.slice(0, LLM_CALL_HASH_LEN)}-${++seq}-${randomUUID().slice(0, 8)}`;
      const reservation = { kind: 'llm' as const, ownerId: item.ownerId, itemRunId: item.itemRunId, generation: item.generation, itemAttempt: item.attempt, tag, estimate: { promptChars, maxTokens, model: useModel },
        ...(deps.markSent ? { sendMarked: true } : {}) };
      let resKey: string;
      try {
        resKey = await reservePaidCall(deps.finops, reservation);
      } catch (e) {
        if (!(e instanceof RunBudgetCapReached)) throw e;
        // FinOps atómico: otra reserva concurrente llegó primero al tope → no se llama (0 gasto) y el run se pausa.
        await pauseRunForCap(deps.budget, e).catch(() => false);
        if (e.reason === 'run_budget_not_authorized') {
          throw { fatal: true, runPaused: true, status: 409, code: e.reason, msg: 'run_budget_not_authorized: ' + e.detail } as ApiError;
        }
        throw { fatal: true, runPaused: true, status: 409, code: 'run_paused', msg: 'run_paused: Pausa automática: se alcanzó el presupuesto autorizado del run: ' + e.detail } as ApiError;
      }
      notUnknown.add(resKey);
      const sentAt = new Date().toISOString();
      // r62 (E2E M): marca DURABLE de envío justo antes del fetch. Si ya no somos dueños de la parte, no se envía y la
      // reserva se libera (nunca salió).
      if (deps.markSent) {
        let marked = false;
        try {
          marked = await deps.markSent(item.itemRunId, resKey, sentAt);
        } catch (err) {
          // r62 (re-review m3): la marca no se pudo escribir (DB) → no se envía nada: la reserva se libera (never_sent),
          // nunca queda abierta; la llamada se reintenta como un transitorio sin gasto.
          await settlePaidCall(deps.finops, resKey, null, 'llm_worker_never_sent').catch(() => undefined);
          notUnknown.delete(resKey);
          throw { fatal: false, status: 0, msg: `Error de red: no se pudo registrar el envío (${err instanceof Error ? err.message : String(err)}); la llamada no salió` } as ApiError;
        }
        if (!marked) {
          await settlePaidCall(deps.finops, resKey, null, 'llm_worker_never_sent');
          notUnknown.delete(resKey);
          throw { fatal: true, handBack: 'lease_lost', code: 'lease_lost', msg: 'lease_lost: la parte ya no es de este worker; la llamada no se envió (reserva liberada)' } as ApiError;
        }
      }
      let r: LlmStreamResult;
      try {
        const send = transport === 'nonstream' ? nonStreamMessage : streamMessage;
        r = await send({ apiKey: deps.apiKey, baseUrl: deps.baseUrl, body, idleMs: deps.idleMs, totalMs: deps.totalMs, fetchImpl: deps.fetchImpl });
      } catch (e) {
        if (!(e instanceof LlmStreamError)) { notUnknown.delete(resKey); throw e; }
        const ambiguousHttp = e.kind === 'http' && LLM_HTTP_AMBIGUOUS_STATUSES.includes(e.extra.status ?? 0);
        if (e.kind === 'never_sent') {
          // El pedido no salió: sin costo (se libera) y reintento seguro (transitorio).
          await settlePaidCall(deps.finops, resKey, null, 'llm_worker_never_sent');
          throw { fatal: false, status: 0, msg: 'Error de red: ' + e.message } as ApiError;
        }
        if (e.kind === 'http' && !ambiguousHttp) {
          // Respuesta de error de Anthropic (review I2): resultado CONOCIDO y sin cobro → se libera siempre.
          const st = e.extra.status ?? 0;
          await settlePaidCall(deps.finops, resKey, null, `llm_worker_rejected_${st}`);
          throw httpError(st, e.extra.body ?? e.message);
        }
        if (e.kind === 'cut') {
          // Empezó y se cortó: Anthropic cobró lo generado. Se registra conservador (entrada exacta, salida = tope).
          // Lo recibido a medias NUNCA se usa (ni se completa a ciegas): la respuesta tiene que llegar entera y validarse.
          const u = e.extra.usage;
          const cause = e.extra.cause || 'unknown_cut';
          notUnknown.delete(resKey); // sin message id no se puede liquidar: queda pendiente y cuenta como desconocida
          if (e.extra.messageId && u) {
            // Review r64 (m5): si llegó el `message_delta` (usage final), la salida real se conoce → se cobra la real; si no,
            // conservador (salida = tope), como siempre.
            const charge = serverLlmChargeInput({
              ownerId: item.ownerId, itemRunId: item.itemRunId, model: useModel, messageId: e.extra.messageId, requestId: e.extra.requestId ?? null,
              usage: e.extra.sawUsageDelta ? { ...u } : { ...u, output_tokens: Math.max(u.output_tokens, maxTokens) }, callRole: role.callRole, attempt: role.attempt,
            });
            // r64: evidencia del corte en el ledger (antes se perdía: el log solo decía «se cortó»).
            charge.metadata = { ...(charge.metadata || {}), streamCut: { callHash: hash.slice(0, LLM_CALL_HASH_LEN), transport, cause, partialChars: e.extra.partialChars ?? null, sawUsageDelta: !!e.extra.sawUsageDelta, receivedOutputTokens: u.output_tokens } };
            await settlePaidCall(deps.finops, resKey, charge, 'llm_worker_stream_cut_conservative');
          }
          const prev = cutCalls.get(hash) || { cuts: 0, causes: [] };
          prev.cuts++; prev.causes.push(cause);
          cutCalls.set(hash, prev);
          deps.logger.warn(`[llm-worker] ${item.itemKey}: la respuesta de la llamada ${hash.slice(0, 10)} se cortó a mitad (${transport}; causa ${cause}; ${e.extra.partialChars ?? '?'} caracteres recibidos; message ${e.extra.messageId || '?'}; request ${e.extra.requestId || '?'}): ${e.message}`);
          if (transport === 'stream') {
            // r64: cambio de estrategia, no repetición: la MISMA solicitud por el transporte sin streaming, ya (dentro del
            // mismo presupuesto: el guard de la parte y del run se vuelve a evaluar antes del envío).
            transport = 'nonstream';
            continue;
          }
          // Guarda defensiva: hoy el transporte sin streaming nunca devuelve `cut` (falla como HTTP o desconocido, con sus
          // reglas). Si algún día lo hiciera, no se insiste igual: excepción explícita con las causas.
          throw { fatal: true, status: 0, code: LLM_OUTPUT_CUT_REPEATED, msg: `${LLM_OUTPUT_CUT_REPEATED}: la respuesta de la IA se cortó ${prev.cuts} veces en la misma solicitud (${prev.causes.join(', ')}); no se repite igual` } as ApiError;
        }
        // Desconocido (sin respuesta, o timeout de gateway 408/504): la reserva queda PENDIENTE (cuenta en el
        // presupuesto y en el contador de desconocidos).
        notUnknown.delete(resKey);
        deps.logger.warn(`[llm-worker] ${item.itemKey}: resultado DESCONOCIDO (${e.message}); reserva ${resKey} pendiente`);
        if (!firstUnknownAt) firstUnknownAt = await dbNow(deps.dataSource, resKey);
        const reason = await unknownLimitReached(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown], unknownCtx());
        if (reason) {
          throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW, msg: pendingReviewMessage(reason) } as ApiError;
        }
        continue; // un único reintento automático
      }
      // Review I6: la respuesta llegó y se pagó → se GUARDA ANTES de liquidar. Si el ledger falla al liquidar, se
      // reintenta; si sigue fallando, la respuesta igual se usa (nunca se vuelve a pedir y pagar) y la reserva queda
      // pendiente para conciliar (sin contar como desconocida en este proceso).
      if (r.text) {
        try {
          const path = `${item.ownerId}/dynamic/${item.artifactCourseId}/${item.manifestId}/llm-checkpoints/${item.itemRunId}/${hash}.json`;
          await deps.checkpoints.put(path, JSON.stringify({ text: r.text, usage: r.usage, stopReason: r.stopReason, messageId: r.messageId }));
          const entry = { path, at: new Date().toISOString() };
          const owned = await deps.recordCheckpoint(item.itemRunId, { [hash]: entry });
          if (!owned && deps.recordLateCheckpoint) {
            // r61 (Q-21): la parte ya no es de este worker (lease tomada a mitad de la llamada). La respuesta YA se
            // pagó: se deja como guardado tardío (solo si esa clave no existe) para que el reclamante nuevo no la pague otra vez.
            const late = await deps.recordLateCheckpoint(item.itemRunId, hash, { ...entry, lateFromAttempt: item.attempt }, sentAt);
            deps.logger.warn(`[llm-worker] ${item.itemKey}: lease perdida con la llamada ${hash.slice(0, 10)} en vuelo — guardado tardío ${late ? 'registrado' : 'rechazado'}`);
          }
          win.checkpoints[hash] = entry;
        } catch (err) {
          deps.logger.warn(`[llm-worker] ${item.itemKey}: no se pudo guardar el punto de guardado: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const charge = serverLlmChargeInput({
        ownerId: item.ownerId, itemRunId: item.itemRunId, model: useModel, messageId: r.messageId, requestId: r.requestId,
        usage: r.usage, callRole: role.callRole, attempt: role.attempt,
      });
      const delays = deps.settleRetryDelaysMs ?? [500, 2000, 5000];
      for (let i = 0; ; i++) {
        try {
          await settlePaidCall(deps.finops, resKey, charge, 'llm_worker_measured');
          notUnknown.delete(resKey);
          break;
        } catch (err) {
          if (i >= delays.length) {
            deps.logger.error(`[llm-worker] ${item.itemKey}: la respuesta ${r.messageId} llegó pero no se pudo liquidar en el ledger (${err instanceof Error ? err.message : String(err)}); reserva ${resKey} queda pendiente para conciliar`);
            break;
          }
          await sleep(delays[i]);
        }
      }
      if (metaOut) { metaOut.stopReason = r.stopReason; metaOut.usage = { ...r.usage }; }
      if (!r.text) throw { fatal: false, msg: 'Respuesta vacía de la API' } as ApiError;
      return r.text;
    }
  };
  /**
   * r62 (E2E M: «nunca una reserva abierta con la parte completada»): antes de completar la parte, toda reserva
   * desconocida que quede sin conciliar en su ventana se resuelve — nunca enviada (sin marca) → liberada; enviada →
   * cobrada con possible_duplicate (actor system; conservador: ya contaba como gasto). Devuelve cuántas resolvió.
   */
  const settleLeftovers = async (): Promise<{ released: number; settled: number }> => {
    const win = await itemWindowStart(deps.dataSource, item.itemRunId);
    const left = await unknownReservations(deps.dataSource, item.itemRunId, win.since, { exclude: [...notUnknown] });
    let released = 0;
    const ambiguous: string[] = [];
    for (const u of left) {
      if (u.sendMarked && !win.sent[u.key]) { await settlePaidCall(deps.finops, u.key, null, 'llm_worker_never_sent_orphan'); released++; }
      else ambiguous.push(u.key);
    }
    let settled = 0;
    if (ambiguous.length && typeof deps.finops.reconcileReservationAsCharged === 'function') {
      const r = await settleAmbiguousAsPossibleDuplicate(deps.finops as Required<Pick<WorkerLedger, 'reconcileReservationAsCharged'>>, ambiguous, {
        provider: 'anthropic', cause: 'unknown_result', itemRunId: item.itemRunId, itemKey: item.itemKey, runId: item.runId,
      });
      settled = r.settled.length + r.alreadySettled.length;
    }
    return { released, settled };
  };
  return Object.assign(api, { settleLeftovers });
}
