// ─────────────────────────────────────────────────────────────────────────────
// r83 (incidente curso 91, 2026-11-02) — reapertura automática ÚNICA de una parte de IA en `llm_pending_review`.
//
// Cortes de red intermitentes del VPS dejaron una Actividad y el Examen final en revisión (clase D, hold_for_human,
// el dueño no puede reintentar). El riesgo real es ACOTADO: cobrar dos veces una llamada ya contada de forma
// conservadora. Regla:
//  - solo `llm_pending_review` por resultados desconocidos (no la variante «no entra en el presupuesto autorizado»);
//  - UNA vez por parte (output_summary.llmPendingReviewReopen), pasados LLM_REVIEW_REOPEN_DELAY_SECONDS (12 min) desde el
//    fallo y dentro de la ventana de recencia del auto-healer;
//  - con una SONDA de salud sin costo (llmProviderHealthProbe): ningún corte/desconocido de la IA en los últimos 10 min y
//    evidencia de que la IA responde — una llamada medida (cobrada OK) de Anthropic en los últimos 15 min, de cualquier
//    run o del proxy del navegador (mismo VPS, misma salida); si no hubo tráfico, un GET a `/v1/models` (endpoint de
//    listado: no genera ni cobra). Se eligió así porque una llamada de generación como sonda costaría dinero y podría
//    volver a quedar ambigua; el ledger ya sabe si la ruta VPS → Anthropic funciona;
//  - dinero: las reservas desconocidas de la parte se liquidan como cobradas con `possible_duplicate` (siguen contando
//    como gasto: nunca se liberan ni se cobran dos veces en el ledger) y el peor caso del reenvío (su suma) tiene que
//    entrar en el presupuesto de la parte + holgura de ambigüedad y en el saldo autorizado del run;
//  - la reapertura NO reinicia el presupuesto de la parte (recoveryBudgetResetAt): solo el CONTEO de eventos ambiguos
//    (`llmUnknownResetAt`). Los puntos de guardado se conservan (no se repaga lo ya respondido).
// Si vuelve a quedar en revisión → nunca más automático (humano).
// Puro salvo `llmProviderHealthProbe` / `anthropicReachable`.
// ─────────────────────────────────────────────────────────────────────────────

export const LLM_PENDING_REVIEW_CODE = 'llm_pending_review';
export const LLM_REVIEW_REOPEN_KEY = 'llmPendingReviewReopen';
export const LLM_REVIEW_REOPEN_STRATEGY = 'llm_pending_review_reopen';
export const LLM_REVIEW_REOPEN_MAX_ROUNDS = 1;
/** Espera desde el fallo (10–15 min pedidos: 12 min). `DYNAMIC_LLM_REVIEW_REOPEN_DELAY_SECONDS` (60–3600). */
export const LLM_REVIEW_REOPEN_DELAY_SECONDS = 720;
/** Sonda: sin cortes/desconocidos de la IA en esta ventana (s). */
export const LLM_HEALTH_QUIET_SECONDS = 600;
/** Sonda: alguna llamada medida OK de Anthropic en esta ventana (s). */
export const LLM_HEALTH_SUCCESS_SECONDS = 900;

export function llmReviewReopenDelaySeconds(env: Record<string, string | undefined> = process.env): number {
  const v = Math.floor(Number(env.DYNAMIC_LLM_REVIEW_REOPEN_DELAY_SECONDS));
  return Number.isFinite(v) && v >= 60 && v <= 3600 ? v : LLM_REVIEW_REOPEN_DELAY_SECONDS;
}

export interface LlmHealthProbeResult {
  ok: boolean;
  reason: 'recent_failures' | 'recent_success' | 'reachable' | 'unreachable' | 'no_evidence' | 'probe_error';
  recentFailures: number;
  recentSuccesses: number;
}

export interface LlmReviewRow {
  status: string;
  type?: string | null;
  error: string | null;
  output_summary: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export type LlmReviewReopenDecision =
  | { heal: true; round: number }
  | { heal: false; reason: 'not_failed' | 'not_pending_review' | 'over_budget' | 'cap_reached' | 'declined' | 'too_old' | 'backoff' | 'provider_unhealthy'; retryAt?: Date };

/** ¿La revisión fue por presupuesto (el reenvío no entraba)? Esa variante queda para un humano. */
export function isBudgetPendingReview(error: string | null | undefined, os: Record<string, any> | null | undefined): boolean {
  return /no entra en el presupuesto autorizado/.test(String(error ?? '')) || (os?.llmPendingReview?.reason === 'resend_over_budget');
}

export function llmReviewReopenRoundsOf(os: Record<string, any> | null | undefined): number {
  const n = Number(os?.[LLM_REVIEW_REOPEN_KEY]?.rounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Decisión pura. `health` undefined = no se consultó (bajo lock en retryItem la sonda ya la hizo el barrido).
 */
export function llmReviewReopenDecision(
  row: LlmReviewRow, now: Date, opts: { maxAgeHours: number; delaySeconds?: number; health?: LlmHealthProbeResult | null } = { maxAgeHours: 24 },
): LlmReviewReopenDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  const error = String(row.error ?? '').trim();
  if (!error.startsWith(LLM_PENDING_REVIEW_CODE)) return { heal: false, reason: 'not_pending_review' };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  if (isBudgetPendingReview(error, os)) return { heal: false, reason: 'over_budget' };
  if (os[LLM_REVIEW_REOPEN_KEY]?.declined) return { heal: false, reason: 'declined' };
  const rounds = llmReviewReopenRoundsOf(os);
  if (rounds >= LLM_REVIEW_REOPEN_MAX_ROUNDS) return { heal: false, reason: 'cap_reached' };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (failedAt && now.getTime() - failedAt.getTime() > opts.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old' };
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + (opts.delaySeconds ?? LLM_REVIEW_REOPEN_DELAY_SECONDS) * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', retryAt };
  }
  if (opts.health !== undefined && (!opts.health || !opts.health.ok)) return { heal: false, reason: 'provider_unhealthy' };
  return { heal: true, round: rounds + 1 };
}

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

/**
 * Sonda de salud SIN costo (review F8: la señal preferida es el LEDGER; el GET es solo el último recurso). 1) cortes/desconocidos recientes (telemetría `llmTransportEvents` de las partes, reloj DB)
 * → no sano; 2) una llamada medida OK de Anthropic reciente (ledger) → sano; 3) sin tráfico: `reachable()` (GET
 * `/v1/models`, no genera) si está disponible. Ante un error de lectura: no sano (se reintenta en el próximo tick).
 */
export async function llmProviderHealthProbe(q: Q, opts: { reachable?: (() => Promise<boolean | null>) | null; quietSeconds?: number; successSeconds?: number } = {}): Promise<LlmHealthProbeResult> {
  let recentFailures = 0;
  let recentSuccesses = 0;
  try {
    const [r] = await q.query(
      `select
         (select count(*) from public.generation_item_runs g
            cross join lateral jsonb_array_elements(coalesce(g.output_summary->'llmTransportEvents', '[]'::jsonb)) ev
           where g.updated_at > now() - interval '6 hours' and (ev->>'at') ~ '^[0-9]{4}-'
             and (ev->>'at')::timestamptz > now() - make_interval(secs => $1::int))::int as llm_health_failures,
         (select count(*) from public.generation_cost_events e
           where e.provider = 'anthropic' and e.event_kind = 'CHARGE' and e.billing_account <> 'mock'
             and not coalesce((e.metadata->>'reservation') = 'true', false) and not (coalesce(e.metadata, '{}'::jsonb) ? 'streamCut')
             and e.created_at > now() - make_interval(secs => $2::int))::int as llm_health_successes`,
      [opts.quietSeconds ?? LLM_HEALTH_QUIET_SECONDS, opts.successSeconds ?? LLM_HEALTH_SUCCESS_SECONDS],
    );
    recentFailures = Number(r && r.llm_health_failures) || 0;
    recentSuccesses = Number(r && r.llm_health_successes) || 0;
  } catch {
    return { ok: false, reason: 'probe_error', recentFailures, recentSuccesses };
  }
  if (recentFailures > 0) return { ok: false, reason: 'recent_failures', recentFailures, recentSuccesses };
  if (recentSuccesses > 0) return { ok: true, reason: 'recent_success', recentFailures, recentSuccesses };
  if (!opts.reachable) return { ok: false, reason: 'no_evidence', recentFailures, recentSuccesses };
  let reach: boolean | null = false;
  try { reach = await opts.reachable(); } catch { reach = false; }
  // Review F8: sin clave en este proceso → sin evidencia (no «inalcanzable»): se espera tráfico medido del ledger.
  if (reach === null) return { ok: false, reason: 'no_evidence', recentFailures, recentSuccesses };
  return { ok: reach, reason: reach ? 'reachable' : 'unreachable', recentFailures, recentSuccesses };
}

/**
 * GET `${baseUrl}/v1/models?limit=1` (listado de modelos: no genera texto ni consume tokens) con timeout corto. true =
 * la ruta hasta Anthropic responde (200).
 * Review F8: el barrido corre en el proceso de la API (main.ts), que puede NO tener `ANTHROPIC_API_KEY` (solo el worker
 * de IA la necesita). Sin clave → `null` = «sin evidencia» (nunca `false`/«inalcanzable», nunca un pedido sin clave): la
 * sonda se queda con la señal del LEDGER (una llamada medida OK reciente de cualquier worker), que es la preferida. En un
 * VPS sin tráfico y sin clave en la API, la reapertura automática simplemente no ocurre (la parte sigue en revisión
 * humana, como antes de r83). La clave nunca se registra ni se devuelve.
 */
export async function anthropicReachable(a: { apiKey?: string | null; baseUrl?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean | null> {
  const key = String(a.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!key) return null;
  const base = String(a.baseUrl ?? process.env.ANTHROPIC_API_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const f = a.fetchImpl ?? fetch;
  try {
    const res = await f(`${base}/v1/models?limit=1`, {
      method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(a.timeoutMs ?? 10_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
