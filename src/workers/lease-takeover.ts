// ─────────────────────────────────────────────────────────────────────────────
// r61 (Q-21) — toma de la lease con una llamada pagada EN VUELO.
//
// Cuando la lease de un worker A vence (caída, latido perdido, proceso colgado) y otro reclamante B toma la parte,
// la llamada pagada que A tenía en vuelo puede seguir viva y terminar (y cobrarse). Reglas:
//  1. B NUNCA reenvía una llamada de un intento anterior que figura enviada y sin liquidar mientras todavía puede
//     estar en vuelo (enviada dentro del timeout de esa llamada + margen): devuelve la parte con retryAfter ≥ lo que
//     falta de la ventana (sin consumir intento), para que A termine y liquide.
//  2. Pasada la ventana, si sigue sin liquidar → el camino de siempre (reconciliación / regla de desconocido), nunca
//     un reenvío silencioso.
//  3. El A «zombi» puede LIQUIDAR su propia reserva (verdad del dinero) y puede dejar el RESULTADO de esa llamada solo
//     donde no pisa nada del intento nuevo: un id externo que todavía falta (Gamma/Videogen, cercado por el marcador de
//     envío de A) o un punto de guardado direccionado por el hash del pedido (LLM). Nunca completa, falla ni sube
//     artifacts de la parte (cercado por worker_id + el cerco en proceso de abajo).
// ─────────────────────────────────────────────────────────────────────────────

/** Prefijo estable del error con el que B devuelve la parte (reanudable, sin gasto nuevo, sin consumir intento). */
export const PRIOR_CALL_IN_FLIGHT = 'prior_call_in_flight';

/** Margen sobre el timeout de la llamada (latencia de red/DB entre la reserva, el envío y la liquidación). */
export const IN_FLIGHT_MARGIN_MS = 30_000;

/**
 * Ventana en vuelo por proveedor (timeout por defecto de la llamada, provider-clients.ts, + margen). Conservadora:
 * PROVIDER_CALL_TIMEOUT_MS solo puede ACORTAR esos timeouts, nunca alargarlos.
 */
export const IN_FLIGHT_WINDOW_MS: Readonly<Record<string, number>> = Object.freeze({
  openai: 120_000 + IN_FLIGHT_MARGIN_MS, // TTS
  anthropic: 120_000 + IN_FLIGHT_MARGIN_MS, // guion del audiolibro (AnthropicClient)
  gamma: 60_000 + IN_FLIGHT_MARGIN_MS, // createGeneration
  // batchCreate de Videogen no tiene timeout propio: cota operativa (pasada, el envío se trata como ambiguo, igual que hoy).
  videogen: 10 * 60_000,
});

/**
 * ¿El intento anterior terminó por una TOMA de la lease (barrido `lease_expired`) o por una devolución de esta misma
 * espera? Solo entonces su llamada pagada puede seguir en vuelo. Si el worker anterior falló la parte él mismo
 * (reconciliación, ambiguo, rechazo, drenaje), su llamada ya terminó y se decide como siempre, sin esperar.
 */
export function priorAttemptMayBeInFlight(item: { previousError?: string | null }): boolean {
  const e = typeof item.previousError === 'string' ? item.previousError : '';
  return /^lease_expired\b/.test(e) || e.startsWith(PRIOR_CALL_IN_FLIGHT);
}

/** Proveedor de una reserva por su clave (`reservation:<kind>:…`). */
export function providerOfReservationKey(key: string): string | null {
  const m = /^reservation:(tts|llm|gamma|videogen):/.exec(key);
  if (!m) return null;
  return m[1] === 'tts' ? 'openai' : m[1] === 'llm' ? 'anthropic' : m[1];
}

/** ms que faltan para que una llamada enviada en `sentAt` deje de poder estar en vuelo (0 = fuera de la ventana). */
export function inFlightRemainingMs(sentAt: string | Date | null | undefined, windowMs: number, now: number = Date.now()): number {
  if (sentAt === null || sentAt === undefined || !(windowMs > 0)) return 0;
  const t = sentAt instanceof Date ? sentAt.getTime() : Date.parse(String(sentAt));
  if (!Number.isFinite(t)) return 0;
  const left = t + windowMs - now;
  // Un reloj adelantado (sentAt en el futuro) nunca extiende la espera más allá de la ventana.
  return left > 0 ? Math.min(left, windowMs) : 0;
}

/** Segundos de retryAfter para devolver la parte (≥ lo que falta de la ventana; mínimo 1 s). */
export function retryAfterSecondsFor(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000) + 1);
}

export function priorCallInFlightMessage(what: string, remainingMs: number): string {
  return (
    `${PRIOR_CALL_IN_FLIGHT}: ${what} de un intento anterior figura enviada y sin liquidar y todavía puede estar en vuelo ` +
    `(faltan ~${Math.ceil(remainingMs / 1000)} s de su ventana). No se reenvía: la parte vuelve a la cola sin consumir intento ` +
    'y se retoma cuando esa llamada termine (o, pasada la ventana, por el camino de reconciliación).'
  );
}

/**
 * Cerco EN PROCESO por intento: el mismo proceso (mismo executorId → mismo worker_id) puede volver a reclamar una parte
 * cuya tarea anterior sigue viva (colgada más allá de su lease). El cerco de la DB (`worker_id = $2`) no distingue esas
 * dos tareas; este sí: la tarea vieja deja de ser la vigente y no escribe más en la parte.
 */
export class ItemTaskFence {
  private readonly current = new Map<string, number>();
  private seq = 0;

  enter(itemRunId: string): number {
    const token = ++this.seq;
    this.current.set(itemRunId, token);
    return token;
  }

  isCurrent(itemRunId: string, token: number): boolean {
    return this.current.get(itemRunId) === token;
  }

  leave(itemRunId: string, token: number): void {
    if (this.current.get(itemRunId) === token) this.current.delete(itemRunId);
  }
}

/** Un cerco por proceso (los workers del proceso comparten executorId). */
export const PROCESS_ITEM_FENCE = new ItemTaskFence();

type SchedulerWrites = {
  heartbeatItem?: (...a: any[]) => Promise<boolean>;
  completeItem?: (...a: any[]) => Promise<boolean>;
  completeItemDetailed?: (...a: any[]) => Promise<{ ok: boolean; reason?: string }>;
  failItem?: (...a: any[]) => Promise<boolean>;
  failItemDetailed?: (...a: any[]) => Promise<any>;
  recordItemExternal?: (...a: any[]) => Promise<boolean>;
  blockItemForBudget?: (...a: any[]) => Promise<any>;
};

/**
 * Envuelve las escrituras del scheduler de UNA tarea: si la tarea dejó de ser la vigente para su parte (otra tarea del
 * mismo proceso la reclamó), cada escritura es un no-op que responde «lease perdida» (false / {ok:false}).
 */
export function fencedScheduler<S extends SchedulerWrites>(scheduler: S, itemRunId: string, token: number, fence: ItemTaskFence = PROCESS_ITEM_FENCE): S {
  const stale = () => !fence.isCurrent(itemRunId, token);
  return new Proxy(scheduler, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      const name = String(prop);
      const writes = ['heartbeatItem', 'completeItem', 'failItem', 'recordItemExternal', 'blockItemForBudget'];
      if (name === 'completeItemDetailed' || name === 'failItemDetailed') {
        return (...a: any[]) => (stale() ? Promise.resolve({ ok: false, reason: 'lease_lost' }) : v.apply(target, a));
      }
      if (writes.includes(name)) return (...a: any[]) => (stale() ? Promise.resolve(false) : v.apply(target, a));
      return v.bind(target);
    },
  });
}

type Q = { query(sql: string, params?: unknown[]): Promise<any> };

function rowsOf(res: any): any[] {
  return Array.isArray(res) && Array.isArray(res[0]) ? res[0] : Array.isArray(res) ? res : [];
}

/**
 * El A zombi registra el id externo que el proveedor le devolvió (Gamma generationId / Videogen jobId) aunque ya no
 * sea el dueño de la parte. Cercado por el MARCADOR de envío de A (`externalSubmitStartedAt` idéntico): si un humano
 * pidió un reenvío (el marcador se archivó) o ya hay un id, no escribe nada. Solo partes vivas (pending/retrying/running): nunca una completada, fallida (ya ambigua/en reconciliación) ni cancelada. Con el id
 * registrado, el próximo reclamante retoma por poll (gratis) y liquida la reserva de A en el terminal.
 */
export async function adoptLateExternalId(
  ds: Q,
  itemRunId: string,
  marker: string,
  idField: 'gammaGenerationId' | 'videogenJobId',
  external: Record<string, unknown>,
): Promise<boolean> {
  const res = await ds.query(
    `update public.generation_item_runs
        set output_summary = jsonb_set(coalesce(output_summary, '{}'::jsonb), '{external}',
                                       coalesce(output_summary->'external', '{}'::jsonb) || $3::jsonb || jsonb_build_object('adoptedLate', true)),
            updated_at = now()
      where id = $1 and status in ('pending', 'retrying', 'running')
        and output_summary->>'externalSubmitStartedAt' = $2
        and coalesce(output_summary->'external'->>$4, '') = ''
      returning id`,
    [itemRunId, marker, JSON.stringify(external), idField],
  );
  return rowsOf(res).length > 0;
}
