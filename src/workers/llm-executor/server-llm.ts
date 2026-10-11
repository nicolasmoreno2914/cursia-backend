import { createHash, randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { reservePaidCall, serverLlmChargeInput, settlePaidCall, WorkerLedger } from '../finops-worker-hooks';
import type { CallRole } from '../../modules/finops/finops-ledger.service';
import { itemRecoveryBudgetMessage } from '../../modules/finops/run-spend-guard';
import { LlmStreamError, LlmStreamResult, streamMessage } from './anthropic-stream';

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
/** Tope anti-loop: desconocidos en total (cualquier llamada) en la ventana de la parte antes de dejarla en revisión. */
export const LLM_UNKNOWN_ITEM_MAX = 4;
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
      code: 'run_paused' | 'item_recovery_budget_exhausted'; message: string; runId: string; paused: boolean;
    }>;
  };
  /** Guardado de respuestas (Storage). */
  checkpoints: {
    put(path: string, json: string): Promise<void>;
    get(path: string): Promise<string | null>;
  };
  /** Agrega entradas al índice de guardados del item (merge ATÓMICO bajo lease: hay llamadas en paralelo). */
  recordCheckpoint(itemRunId: string, entries: Record<string, { path: string; at: string }>): Promise<boolean>;
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
type ApiError = { fatal: boolean; msg: string; status?: number; code?: string; runPaused?: boolean; itemBudget?: boolean; pendingReview?: boolean; ambiguous?: boolean; handBack?: 'lease_lost' | 'worker_draining' };

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
        and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
        and not (e.idempotency_key = any($4::text[]))`,
    [`reservation:llm:${itemRunId}:%`, tagLike, since.toISOString(), [...exclude]],
  );
  return r ? Number(r.n) : 0;
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

export function pendingReviewMessage(detail: string): string {
  return `${LLM_PENDING_REVIEW}: resultado ambiguo repetido de la IA (${detail}). Esta parte queda en revisión sin volver a generarse; el resto del curso sigue. Se conservan las reservas para conciliarlas.`;
}

export function createServerApi(deps: ServerLlmDeps, item: ServerLlmItem, roleOf: (extraHeaders: any) => { callRole: CallRole; attempt: number }) {
  let seq = 0;
  // Reservas de ESTE proceso que no son desconocidas: en vuelo (todavía sin resultado) o con respuesta recibida cuya
  // liquidación falló (quedan pendientes en el ledger para conciliar, pero la respuesta sí llegó).
  const notUnknown = new Set<string>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return async function api(system: unknown, user: unknown, maxTok?: number, schema?: unknown, model?: string, metaOut?: Record<string, any>, extraHeaders?: Record<string, string>): Promise<string> {
    const useModel = model || deps.defaultModel;
    const maxTokens = Math.max(1, Math.min(maxTok || 4000, LLM_WORKER_MAX_TOKENS_CAP));
    const body: Record<string, unknown> = { model: useModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    const hash = sha(JSON.stringify(body));
    const role = roleOf(extraHeaders);

    // ── Punto de guardado: la misma llamada ya respondida en esta ventana de la parte → sin costo ni generación. ──
    const win = await itemWindowStart(deps.dataSource, item.itemRunId);
    const cp = win.checkpoints[hash];
    if (cp && new Date(cp.at) >= win.since) {
      const raw = await deps.checkpoints.get(cp.path).catch(() => null);
      let saved: { text: string; usage: Record<string, number>; stopReason: string | null } | null = null;
      try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; } // guardado ilegible = no hay guardado (M2)
      if (saved && typeof saved.text === 'string' && saved.text) {
        if (metaOut) { metaOut.stopReason = saved.stopReason; metaOut.usage = { ...saved.usage }; metaOut.fromCheckpoint = true; }
        deps.logger.log(`[llm-worker] ${item.itemKey}: respuesta desde el punto de guardado (${hash.slice(0, 10)}) — sin costo`);
        return saved.text;
      }
    }

    const promptChars = JSON.stringify({ system: system ?? null, messages: [{ role: 'user', content: user }] }).length;
    for (;;) {
      const stop = deps.shouldStop ? deps.shouldStop() : null;
      if (stop) throw { fatal: true, handBack: stop, code: stop, msg: `${stop}: la parte vuelve a la cola antes de una llamada nueva` } as ApiError;
      const unknownReason = await unknownLimitReached(deps.dataSource, item.itemRunId, win.since, hash, [...notUnknown]);
      if (unknownReason) {
        throw { fatal: true, pendingReview: true, code: LLM_PENDING_REVIEW, msg: pendingReviewMessage(unknownReason) } as ApiError;
      }
      const deny = await deps.budget.guardServerLlmCall({ runId: item.runId, itemRunId: item.itemRunId, model: useModel, promptChars, maxTokens });
      if (deny) {
        if (deny.code === 'item_recovery_budget_exhausted') {
          throw { fatal: true, itemBudget: true, status: 409, code: deny.code, msg: itemRecoveryBudgetMessage(deny.message) } as ApiError;
        }
        throw { fatal: true, runPaused: true, status: 409, code: 'run_paused', msg: 'run_paused: ' + deny.message } as ApiError;
      }
      const tag = `${LLM_WORKER_CALL_TAG_PREFIX}-${role.callRole}-${hash.slice(0, LLM_CALL_HASH_LEN)}-${++seq}-${randomUUID().slice(0, 8)}`;
      const reservation = { kind: 'llm' as const, ownerId: item.ownerId, itemRunId: item.itemRunId, generation: item.generation, itemAttempt: item.attempt, tag, estimate: { promptChars, maxTokens, model: useModel } };
      const resKey = await reservePaidCall(deps.finops, reservation);
      notUnknown.add(resKey);
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
          await deps.recordCheckpoint(item.itemRunId, { [hash]: entry });
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
