/**
 * r107 B10 fix round 1 (P1-3/P1-5/P2-2) · ESPERA de los proveedores asíncronos (render de Videogen, generación de Gamma)
 * y su LIQUIDACIÓN. La usan el productor en línea (pruebas) y el trabajo de espera reanudable del servicio, con las
 * MISMAS reglas:
 *   - un error al consultar el estado es TRANSITORIO: se reintenta con backoff hasta el plazo total (no es ambiguo);
 *   - ambiguo SOLO si vence el plazo total sin estado final (o si el envío inicial falló sin respuesta, en el productor);
 *   - sin medición del proveedor se cuenta la COTA de la llamada (nunca 0);
 *   - lo medido por encima de la cota es un incidente (lo levanta la compuerta: `over_bound`).
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { GammaGenerationStatus } from '../../../workers/provider-real/provider-clients';
import { VideogenBatchJob, isJobCompleted, isJobFailed } from '../../../video-engine/videogen.service';
import { ChargeContext, PaidCallTicket, RegenProviders, gammaChargeInputOf, gammaMeasuredUsd, videogenChargeInputOf } from './ports';
import { RegenError } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera entre consultas: intervalo × 2^n, tope 60 s (y nunca más allá del plazo). */
export function waitBackoffMs(n: number, intervalMs: number): number {
  return Math.min(60_000, Math.max(1, intervalMs) * Math.pow(2, Math.min(n, 10)));
}

export class WaitTimeout extends Error {
  constructor(message: string, readonly lastError: string | null) { super(message); this.name = 'WaitTimeout'; }
}

/**
 * Consulta hasta un estado final o hasta `deadlineAt`. Los errores de la consulta se reintentan (transitorios).
 * `onTick` corre en cada vuelta (el servicio late y verifica que el reclamo siga siendo suyo; puede cortar lanzando).
 */
export async function pollUntilFinal<T>(a: { fetch: () => Promise<T>; isFinal: (s: T) => boolean; intervalMs: number; deadlineAt: number; what: string; onTick?: () => Promise<void> }): Promise<T> {
  let n = 0;
  let lastErr: string | null = null;
  for (;;) {
    if (a.onTick) await a.onTick();
    try {
      const s = await a.fetch();
      if (a.isFinal(s)) return s;
      lastErr = null;
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    }
    const left = a.deadlineAt - Date.now();
    if (left <= 0) throw new WaitTimeout(`${a.what} no terminó a tiempo${lastErr ? ` (última consulta: ${lastErr})` : ''}`, lastErr);
    await sleep(Math.min(left, waitBackoffMs(n++, a.intervalMs)));
  }
}

export const videogenFinal = (j: VideogenBatchJob) => isJobCompleted(j.status) || isJobFailed(j.status);
export const gammaFinal = (s: GammaGenerationStatus) => s.status === 'completed' || s.status === 'failed';

/** Liquida un render TERMINADO: fallido → ambiguo (Videogen informa el costo aparte); listo → costo medido o la cota. */
export async function settleVideogenJob(a: { ticket: PaidCallTicket; job: VideogenBatchJob; jobId: string; boundUsd: string; providers: RegenProviders; charge: ChargeContext }): Promise<void> {
  if (isJobFailed(a.job.status)) {
    throw await a.ticket.failed(new Error(`Videogen: el render ${a.jobId} falló (${a.job.error ?? 'sin detalle'})`), 'ambiguous');
  }
  let cost: number | null = null;
  try { cost = await a.providers.videogen.cost(a.jobId); } catch { cost = null; }
  const measured = cost !== null && Number.isFinite(cost) && cost >= 0;
  await a.ticket.charged({ costUsd: measured ? String(cost) : a.boundUsd, charge: videogenChargeInputOf(a.charge, a.ticket.id, { jobId: a.jobId, cost: measured ? cost : null }), externalId: a.jobId });
}

/** Liquida una generación TERMINADA de Gamma: créditos medidos o (P1-1) la COTA; una fallida se cobra y se informa. */
export async function settleGammaGeneration(a: { ticket: PaidCallTicket; st: GammaGenerationStatus; generationId: string; boundUsd: string; pricing: DryRunPricing; charge: ChargeContext }): Promise<void> {
  const credits = typeof a.st.creditsDeducted === 'number' && Number.isFinite(a.st.creditsDeducted) && a.st.creditsDeducted >= 0 ? a.st.creditsDeducted : null;
  await a.ticket.charged({ costUsd: credits === null ? a.boundUsd : gammaMeasuredUsd(a.pricing, credits), charge: gammaChargeInputOf(a.charge, a.ticket.id, { generationId: a.generationId, credits, failed: a.st.status === 'failed' }), externalId: a.generationId });
  if (a.st.status === 'failed') throw new RegenError('invalid_result', `Gamma no pudo generar la presentación (${a.st.error ?? 'sin detalle'}). No se reenvía sola.`);
}
