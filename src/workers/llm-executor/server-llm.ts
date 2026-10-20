import { createHash, randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { pauseRunForCap, reservePaidCall, RunBudgetCapReached, serverLlmChargeInput, settlePaidCall, WorkerLedger } from '../finops-worker-hooks';
import type { CallRole } from '../../modules/finops/finops-ledger.service';
import { itemRecoveryBudgetMessage } from '../../modules/finops/run-spend-guard';
import { LlmStreamError, LlmStreamResult, streamMessage } from './anthropic-stream';
import { inFlightRemainingMs, PRIOR_CALL_IN_FLIGHT, priorCallInFlightMessage, retryAfterSecondsFor } from '../lease-takeover';
import { settleAmbiguousAsPossibleDuplicate } from '../../modules/finops/ambiguous-resend';

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
 * Tope de desconocidos en total (cualquier llamada) en la ventana de la parte antes de dejarla en revisión.
 * r62 (regla de ambigüedad acotada, punto 3): NUNCA más de un reenvío ambiguo por parte → el primer desconocido se
 * reenvía una vez (si el peor caso entra en lo autorizado); cualquier desconocido más en la misma ventana → revisión.
 */
export const LLM_UNKNOWN_ITEM_MAX = 2;
/** Prefijo del hash del pedido dentro del callTag de la reserva (identifica "la misma llamada" entre intentos y workers). */
export const LLM_CALL_HASH_LEN = 12;
export const LLM_WORKER_MAX_TOKENS_CAP = 16000;

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
     * run? Sin el método (harnesses previos) el reenvío único sigue como antes (lo acota el guard de cada llamada).
     */
    ambiguousResendBudget?(a: { runId: string; itemRunId: string; nextCost: number; authorization: 'paid' | 'any' }): Promise<{ fits: boolean; reason: string | null; worstItem: number; worstRun: number }>;
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
}

/** Error con la forma que espera el ejecutor (04-api.js). */
type ApiError = { fatal: boolean; msg: string; status?: number; code?: string; runPaused?: boolean; itemBudget?: boolean; pendingReview?: boolean; ambiguous?: boolean; handBack?: 'lease_lost' | 'worker_draining' | typeof PRIOR_CALL_IN_FLIGHT; retryAfterSeconds?: number };

/** HTTP que NO prueba que Anthropic no procesó el pedido (timeout de gateway): se trata como resultado desconocido. */
const LLM_HTTP_AMBIGUOUS_STATUSES: readonly number[] = [408, 504];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Ventana de la parte (igual que el presupuesto de recuperación): generación vigente desde su último reinicio. */
export async function itemWindowStart(ds: DataSource, itemRunId: string): Promise<{ since: Date; checkpoints: Record<string, { path: string; at: string }> }> {
  const [r] = await ds.query(
    `select greatest(created_at, coalesce(nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz, created_at)) as since,
            coalesce(output_summary->'llmCheckpoints', '{}'::jsonb) as cps
       from public.generation_item_runs where id = $1`,
    [itemRunId],
  );
  return { since: r ? new Date(r.since) : new Date(0), checkpoints: (r && r.cps) || {} };
}

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

/**
 * r62: reservas de ESTA llamada (mismo hash) que siguen sin liquidar en la ventana (resultados desconocidos que todavía
 * nadie concilió). Si hay alguna, el próximo envío de la llamada es un REENVÍO AMBIGUO.
 */
export async function pendingUnknownReservations(ds: DataSource, itemRunId: string, since: Date, callHash: string, exclude: readonly string[] = []): Promise<Array<{ key: string; amount: number }>> {
  const rows: Array<{ key: string; amount: string }> = await ds.query(
    `select e.idempotency_key as key, e.amount::text as amount from public.generation_cost_events e
      where e.idempotency_key like $1 and e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'
        and (e.metadata->>'callTag') like $2 and e.created_at >= $3
        and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
        and not (e.idempotency_key = any($4::text[]))
      order by e.created_at, e.id`,
    [`reservation:llm:${itemRunId}:%`, `${LLM_WORKER_CALL_TAG_PREFIX}-%-${callHash.slice(0, LLM_CALL_HASH_LEN)}-%`, since.toISOString(), [...exclude]],
  );
  return rows.map((r) => ({ key: String(r.key), amount: Number(r.amount) || 0 }));
}

/** null = se puede (re)intentar; si no, el motivo de dejar la parte en revisión. */
async function unknownLimitReached(ds: DataSource, itemRunId: string, since: Date, hash: string, exclude: readonly string[]): Promise<string | null> {
  const same = await countUnknownCalls(ds, itemRunId, since, hash, exclude);
  if (same >= LLM_UNKNOWN_MAX) return `${same} intentos de la misma llamada sin respuesta`;
  const total = await countUnknownCalls(ds, itemRunId, since, undefined, exclude);
  if (total >= LLM_UNKNOWN_ITEM_MAX) return `${total} llamadas sin respuesta en esta parte`;
  return null;
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return async function api(system: unknown, user: unknown, maxTok?: number, schema?: unknown, model?: string, metaOut?: Record<string, any>, extraHeaders?: Record<string, string>, cacheOpts?: { cachePrefix?: string }): Promise<string> {
    const { body, model: useModel, maxTokens } = serverLlmRequestBody({ system, user, maxTok, schema, model, defaultModel: deps.defaultModel, cacheOpts });
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
    const win = await itemWindowStart(deps.dataSource, item.itemRunId);
    const cached = await fromCheckpoint(win);
    if (cached !== null) return cached;

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
      const unknownReason = await unknownLimitReached(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown]);
      if (unknownReason) {
        throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW, msg: pendingReviewMessage(unknownReason) } as ApiError;
      }
      // r62 (regla de ambigüedad acotada, punto 3): esta llamada ya tiene un resultado DESCONOCIDO (de este intento o de
      // uno anterior: lease tomada / worker caído, pasada la ventana en vuelo de Q-21) → el envío que sigue es EL reenvío
      // ambiguo de la parte. Solo si el peor caso entra en lo autorizado; antes, la reserva perdida se liquida como
      // cobrada con la marca possible_duplicate (actor system). Si no entra → revisión (excepción registrada).
      const priorUnknown = await pendingUnknownReservations(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown]);
      if (priorUnknown.length > 0) {
        const nextCost = Math.max(...priorUnknown.map((u) => u.amount));
        if (deps.budget.ambiguousResendBudget) {
          const b = await deps.budget.ambiguousResendBudget({ runId: item.runId, itemRunId: item.itemRunId, nextCost, authorization: 'any' });
          if (!b.fits) {
            throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW,
              msg: pendingReviewMessage(`el reenvío no entra en el presupuesto autorizado (${b.reason}; peor caso de la parte USD ${b.worstItem.toFixed(4)}, del run USD ${b.worstRun.toFixed(4)})`) } as ApiError;
          }
        }
        if (deps.finops.reconcileReservationAsCharged) {
          const settled = await settleAmbiguousAsPossibleDuplicate(deps.finops as Required<Pick<WorkerLedger, 'reconcileReservationAsCharged'>>, priorUnknown.map((u) => u.key), {
            provider: 'anthropic', cause: 'unknown_result', itemRunId: item.itemRunId, itemKey: item.itemKey, runId: item.runId,
          });
          if (settled.failed.length) throw new Error(`no se pudo liquidar la reserva desconocida ${settled.failed[0].key}: ${settled.failed[0].error}`);
        }
        deps.logger.warn(`[llm-worker] ${item.itemKey}: reenvío ambiguo ÚNICO de la llamada ${hash.slice(0, 10)} (reserva perdida liquidada como posible duplicado, USD ${nextCost})`);
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
      const reservation = { kind: 'llm' as const, ownerId: item.ownerId, itemRunId: item.itemRunId, generation: item.generation, itemAttempt: item.attempt, tag, estimate: { promptChars, maxTokens, model: useModel } };
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
      let r: LlmStreamResult;
      try {
        r = await streamMessage({ apiKey: deps.apiKey, baseUrl: deps.baseUrl, body, idleMs: deps.idleMs, totalMs: deps.totalMs, fetchImpl: deps.fetchImpl });
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
          // Empezó y se cortó: Anthropic cobró lo generado. Se registra conservador (entrada exacta, salida = tope)
          // y la parte lo reintenta como cualquier transitorio, dentro de su presupuesto.
          const u = e.extra.usage;
          notUnknown.delete(resKey); // sin message id no se puede liquidar: queda pendiente y cuenta como desconocida
          if (e.extra.messageId && u) {
            await settlePaidCall(deps.finops, resKey, serverLlmChargeInput({
              ownerId: item.ownerId, itemRunId: item.itemRunId, model: useModel, messageId: e.extra.messageId, requestId: e.extra.requestId ?? null,
              usage: { ...u, output_tokens: Math.max(u.output_tokens, maxTokens) }, callRole: role.callRole, attempt: role.attempt,
            }), 'llm_worker_stream_cut_conservative');
          }
          throw { fatal: false, status: 0, msg: 'La respuesta de la IA se cortó antes de terminar. Reintentando…' } as ApiError;
        }
        // Desconocido (sin respuesta, o timeout de gateway 408/504): la reserva queda PENDIENTE (cuenta en el
        // presupuesto y en el contador de desconocidos).
        notUnknown.delete(resKey);
        deps.logger.warn(`[llm-worker] ${item.itemKey}: resultado DESCONOCIDO (${e.message}); reserva ${resKey} pendiente`);
        const reason = await unknownLimitReached(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown]);
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
}
