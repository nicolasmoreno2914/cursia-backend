import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { FinopsBudgetService } from '../finops/finops-budget.service';
import { cmpDec, normalizeDecimal } from '../finops/decimal';
import { costIdempotencyKey } from '../finops/idempotency';
import { paidProviderOfItemType } from '../finops/run-budget';
import { isJobCompleted, isJobFailed, VideogenBatchJob, VideogenCostBreakdown, VideogenService } from '../../video-engine/videogen.service';
import { GammaClient, GammaGenerationStatus } from '../../workers/provider-real/provider-clients';
import { AUTO_HEAL_MAX_AGE_HOURS_RANGE, AutoHealPolicy, autoHealPolicyFromEnv } from './auto-heal';
import { latestGenerationPredicate } from './item-generations';
import { RunsService } from './runs.service';
import { PROVIDER_STUCK_NO_CANCEL } from './videogen-render-cap';
import { loadPendingVideogenReservations } from './run-completion';
import {
  PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK,
  PROVIDER_RECONCILE_EXCLUDED_RUN_IDS,
  PROVIDER_RECONCILE_EXCLUDED_RUN_PREFIXES,
  PROVIDER_RECONCILE_KEY,
  PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS,
  PROVIDER_RECONCILE_MAX_CANCEL_ATTEMPTS,
  PROVIDER_RECONCILE_MAX_REPOLLS,
  PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS,
  PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS,
  PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS,
  PROVIDER_RECONCILE_MAX_RESUBMITS,
  PROVIDER_RECONCILE_PERMANENT_SKIPS,
  PROVIDER_RECONCILE_SQL_REGEX,
  ProviderReconcileKind,
  gammaMeasuredCreditsOf,
  providerReconcileDecision,
  providerReconcileLiveJobMaxSeconds,
  providerReconcileRecheckSeconds,
  providerReconcileRunEligible,
  providerReconcileRunsSince,
  providerReconcileStateOf,
  videogenCountedAmount,
  videogenJobIdOf,
  videogenZeroCostReleasable,
} from './provider-reconcile';
import { usd2 } from '../finops/usd-display';

/**
 * r62 (N2) — barrido de conciliación automática de Videogen / Gamma (ver provider-reconcile.ts). Corre en el tick del
 * auto-healer (main.ts). Cada parte:
 *  1. evidencia del proveedor (GET existentes, con timeout) → conciliación de su reserva en el ledger (`decidedBy='system'`);
 *  2. sin evidencia → liquidación conservadora `charged` + `possible_duplicate` (punto 3 de la regla);
 *  3. reenvío (retryItem auto.providerReconcile: locks, decisión re-evaluada bajo lock, gate de FinOps en simulación,
 *     dependientes desbloqueados) SOLO si el peor caso entra en el presupuesto de la parte y en el saldo autorizado;
 *     si no, la excepción queda registrada (`providerReconcile.declined` + `attention_reason`).
 * Los GET al proveedor son gratis; ninguna llamada pagada sale de acá (el reenvío lo hace el worker, con su guard).
 */

/** Clientes del proveedor que usa el barrido (solo los GET de estado / costo). Inyectables en pruebas. */
export interface ProviderReconcileClients {
  videogen?: (Pick<VideogenService, 'getVideoStatus' | 'getVideoCost'> & Partial<Pick<VideogenService, 'cancelVideo'>>) | null;
  gamma?: { getGeneration(generationId: string): Promise<GammaGenerationStatus> } | null;
  /** Timeout de cada GET del barrido (default PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS; pruebas). */
  lookupTimeoutMs?: number;
}
export const PROVIDER_RECONCILE_CLIENTS = 'PROVIDER_RECONCILE_CLIENTS';

/** Quién decide en el ledger (auditoría: H4 de L-flow cuenta `recorded_by like 'admin%'` como manual). */
export const PROVIDER_RECONCILE_RECORDED_BY = 'system_provider_reconcile';
export const PROVIDER_RECONCILE_DECIDED_BY = 'system';

type Row = {
  id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
  finished_at: Date; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number; attempt_count: number;
  generation: number; run_created_at: Date | null;
};

type PendingCharge = { idempotency_key: string; amount: string; reservation: boolean; attempt: number; provider: string; external_operation_id: string | null };

/** Resultado de la evidencia de UNA parte. */
type Evidence =
  | { action: 'wait'; why: string; recheck?: boolean; zeroCostSeenAt?: string }
  | { action: 'repoll'; why: string; adoptJobId?: string | null }
  | { action: 'decline'; reason: string; attention: 'budget' | 'duplicate_charge' | 'unrecoverable'; why: string }
  | { action: 'resubmit'; ambiguous: boolean; settlement: string; counted: string | null; why: string; reservedAmount: string | null };

export interface ProviderReconcileSweepResult {
  candidates: number;
  resubmitted: Array<{ runId: string; itemKey: string; kind: ProviderReconcileKind; settlement: string; ambiguous: boolean }>;
  repolled: Array<{ runId: string; itemKey: string; kind: ProviderReconcileKind }>;
  declined: Array<{ runId: string; itemKey: string; reason: string }>;
  waiting: Array<{ runId: string; itemKey: string; why: string }>;
  skipped: Array<{ runId: string; itemKey: string; reason: string }>;
  /** d5: reservas de Videogen con jobId conciliadas con la evidencia (sin reenvío). */
  reservationsReconciled: Array<{ runId: string; reservationKey: string; settlement: string }>;
}

class LookupError extends Error {}
/** Review I2: la fila cambió desde el SELECT del barrido (reapertura, otro tick, otro proceso): no se escribe nada. */
class StaleRow extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  return Promise.race([
    p.finally(() => { if (t) clearTimeout(t); }),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new LookupError(`${what}: sin respuesta en ${ms} ms`)), ms); t.unref?.(); }),
  ]);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

@Injectable()
export class ProviderReconcileService {
  private readonly logger = new Logger(ProviderReconcileService.name);
  private readonly clients: ProviderReconcileClients;

  constructor(
    private readonly dataSource: DataSource,
    private readonly runs: RunsService,
    private readonly ledger: FinopsLedgerService,
    private readonly budget: FinopsBudgetService,
    @Optional() @Inject(PROVIDER_RECONCILE_CLIENTS) clients?: ProviderReconcileClients | null,
  ) {
    this.clients = clients ?? {};
  }

  private lookupMs(): number {
    const n = Number(this.clients.lookupTimeoutMs);
    return Number.isFinite(n) && n > 0 ? n : PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS;
  }

  private videogen(): Pick<VideogenService, 'getVideoStatus' | 'getVideoCost'> & Partial<Pick<VideogenService, 'cancelVideo'>> {
    if (this.clients.videogen === undefined) this.clients.videogen = new VideogenService();
    if (!this.clients.videogen) throw new LookupError('Videogen no configurado en el barrido');
    return this.clients.videogen;
  }

  private gamma(): { getGeneration(generationId: string): Promise<GammaGenerationStatus> } {
    if (this.clients.gamma === undefined) {
      const key = String(process.env.GAMMA_API_KEY ?? '').trim();
      this.clients.gamma = key ? new GammaClient(key, process.env) : null;
    }
    if (!this.clients.gamma) throw new LookupError('Gamma no configurado en el barrido (GAMMA_API_KEY)');
    return this.clients.gamma;
  }

  async sweep(opts: { policy?: AutoHealPolicy; now?: Date; limit?: number } = {}): Promise<ProviderReconcileSweepResult> {
    const policy = opts.policy ?? autoHealPolicyFromEnv();
    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const result: ProviderReconcileSweepResult = { candidates: 0, resubmitted: [], repolled: [], declined: [], waiting: [], skipped: [], reservationsReconciled: [] };
    const windowSecs = Math.round(Math.min(Math.max(policy.maxAgeHours, 0), AUTO_HEAL_MAX_AGE_HOURS_RANGE.max) * 3600);
    const rows: Row[] = await this.dataSource.query(
      `select g.id, g.job_id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at, g.attempt_count,
              g.generation, pj.created_at as run_created_at, pj.course_id, pj.owner_id, b.blueprint_number
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation'
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
          -- review M1: solo runs creados desde la activación, nunca los históricos conocidos
          and pj.created_at >= $5::timestamptz
          and not (pj.id::text = any($6::text[]))
          and not (pj.id::text like any($7::text[]))
          and g.status = 'failed'
          and g.type in ('video', 'presentation')
          and ${latestGenerationPredicate('g')}
          and g.finished_at > $1::timestamptz - make_interval(secs => $2::int)
          and not exists (
            select 1 from public.production_jobs pj2
             where pj2.execution_mode = 'dynamic_generation' and pj2.course_id = pj.course_id and pj2.id <> pj.id
               and (pj2.created_at > pj.created_at or (pj2.created_at = pj.created_at and pj2.id > pj.id)))
          and not exists (select 1 from public.course_generation_manifests m2 where m2.course_id = m.course_id and m2.id > m.id)
          and g.error ~ $3
          -- la excepción ya registrada para ESTE error no se vuelve a mirar (un tope alcanzado sí se registra una vez)
          and not (coalesce(g.output_summary->'${PROVIDER_RECONCILE_KEY}', '{}'::jsonb) ? 'declined'
                   and coalesce(g.output_summary->'${PROVIDER_RECONCILE_KEY}'->>'declinedError', '') = coalesce(g.error, '')
                   -- review overdue I2: un job declinado por no poder cancelarse se sigue vigilando gratis
                   and coalesce(g.output_summary->'${PROVIDER_RECONCILE_KEY}'->>'declined', '') <> '${PROVIDER_STUCK_NO_CANCEL}')
        order by g.finished_at desc, g.id desc
        limit $4`,
      [now.toISOString(), windowSecs, PROVIDER_RECONCILE_SQL_REGEX, limit, providerReconcileRunsSince(),
        [...PROVIDER_RECONCILE_EXCLUDED_RUN_IDS], PROVIDER_RECONCILE_EXCLUDED_RUN_PREFIXES.map((x) => `${x}%`)],
    );
    result.candidates = rows.length;
    const handled = new Set<string>();
    for (const r of rows) {
      handled.add(String(r.id));
      try {
        await this.reconcileOne(r, now, policy, result);
      } catch (err) {
        if (err instanceof StaleRow) {
          result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: 'stale_row' });
          continue;
        }
        // Infraestructura (DB / ledger): se reintenta en el próximo tick (la ventana de edad acota).
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: `error: ${errText(err)}` });
        this.logger.warn(`conciliación de proveedor: ${r.item_key} (run ${r.job_id}) falló este tick (${errText(err)}); se reintenta`);
      }
    }
    try {
      await this.reconcileVideogenReservations(now, windowSecs, handled, result);
    } catch (err) {
      this.logger.warn(`conciliación de reservas de Videogen: el barrido falló (${errText(err)}); se reintenta en el próximo tick`);
    }
    if (rows.length || result.reservationsReconciled.length) {
      this.logger.log(`conciliación de proveedor: candidatos ${result.candidates}, reenviados ${result.resubmitted.length}, re-poll ${result.repolled.length}, ` +
        `excepciones ${result.declined.length}, en espera ${result.waiting.length}, reservas conciliadas ${result.reservationsReconciled.length}`);
    }
    return result;
  }

  // ── una parte ──────────────────────────────────────────────────────────────

  private async reconcileOne(r: Row, now: Date, policy: AutoHealPolicy, result: ProviderReconcileSweepResult): Promise<void> {
    // Re-review m-n1: la vigilancia es de la excepción de ESTE error (un reenvío produce un error nuevo).
    const stNow = providerReconcileStateOf(r.output_summary);
    const watch = stNow.declined === PROVIDER_STUCK_NO_CANCEL && String(stNow.declinedError ?? '') === String(r.error ?? '');
    const d = providerReconcileDecision(r, now, policy, { id: r.job_id, created_at: r.run_created_at }, { watch });
    if (d.heal === false) {
      result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: d.reason });
      if (!watch && PROVIDER_RECONCILE_PERMANENT_SKIPS.includes(d.reason)) {
        await this.decline(r, d.reason, d.reason === 'ambiguous_cap_reached' ? 'duplicate_charge' : 'unrecoverable', now, result,
          `se agotaron los reenvíos automáticos de la parte (${PROVIDER_RECONCILE_MAX_RESUBMITS}, de ellos ${PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS} ambiguo)`);
      }
      return;
    }
    const os = (r.output_summary ?? {}) as Record<string, any>;
    const ack = Math.max(0, Math.floor(Number(os.reconciliationAcknowledgedThroughAttempt ?? 0)) || 0);
    const provider = r.type === 'video' ? 'videogen' : 'gamma';
    const pending = await this.pendingCharges(r, provider, ack);
    const ageSecs = (now.getTime() - new Date(r.finished_at).getTime()) / 1000;
    const prevState = providerReconcileStateOf(os);

    let ev: Evidence;
    switch (d.kind) {
      case 'videogen_failed':
      case 'videogen_stuck':
      case 'videogen_overdue':
      case 'videogen_orphan':
        ev = await this.videogenEvidence(r, os, d.kind, pending, ageSecs, prevState, now, watch);
        break;
      case 'gamma_failed':
        ev = await this.gammaEvidence(r, os, pending, ageSecs >= PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS);
        break;
      default:
        ev = { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount: null, why: `${d.kind}: envío sin id del proveedor (nada que consultar)` };
    }

    if (ev.action === 'wait') {
      // Review C1: job vivo / lookup caído / segunda lectura de un costo 0 → se vuelve a consultar con espera creciente,
      // nunca un reenvío.
      result.waiting.push({ runId: r.job_id, itemKey: r.item_key, why: ev.why });
      const checks = Math.max(0, Math.floor(Number(prevState.checks ?? 0)) || 0) + 1;
      const wait = ev.zeroCostSeenAt ? PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS : providerReconcileRecheckSeconds(checks - 1);
      await this.patchState(r, {
        lastCheckAt: now.toISOString(), lastWait: ev.why.slice(0, 300), checks,
        nextCheckAt: new Date(now.getTime() + wait * 1000).toISOString(), nextCheckError: String(r.error ?? ''),
        ...(ev.zeroCostSeenAt ? { zeroCostSeenAt: ev.zeroCostSeenAt } : {}),
      });
      return;
    }
    if (ev.action === 'decline') {
      await this.decline(r, ev.reason, ev.attention, now, result, ev.why);
      return;
    }
    if (ev.action === 'repoll' && Math.floor(Number(prevState.repolls ?? 0)) >= PROVIDER_RECONCILE_MAX_REPOLLS) {
      await this.decline(r, 'repoll_cap_reached', 'unrecoverable', now, result, `Videogen informa el job terminado pero el worker no lo completó tras ${PROVIDER_RECONCILE_MAX_REPOLLS} re-poll`);
      return;
    }
    if (ev.action === 'resubmit' && ev.ambiguous && !d.ambiguousAllowed) {
      await this.decline(r, 'ambiguous_cap_reached', 'duplicate_charge', now, result, 'ya hubo un reenvío con resultado ambiguo en esta parte');
      return;
    }

    let settlement = ev.action === 'resubmit' ? ev.settlement : 'none';
    let reservedAmount = ev.action === 'resubmit' ? ev.reservedAmount : null;
    if (ev.action === 'resubmit') {
      // Todo lo que siga pendiente de la parte (sin evidencia) se liquida de forma conservadora: el próximo intento
      // nunca convive con una reserva incierta sin decidir.
      const left = await this.pendingCharges(r, provider, ack);
      for (const c of left) {
        await this.whileUnchanged(r, () => this.settleConservative(r, c, d.kind, ev.why, ev.ambiguous));
        if (settlement === 'none') settlement = 'reconciled_as_charged';
        if (!reservedAmount && c.reservation) reservedAmount = c.amount;
      }
      if (left.length && !ev.ambiguous && ev.settlement !== 'none') {
        // Había otra reserva sin evidencia además de la conciliada: el reenvío cuenta como ambiguo.
        (ev as { ambiguous: boolean }).ambiguous = true;
        if (!d.ambiguousAllowed) {
          await this.decline(r, 'ambiguous_cap_reached', 'duplicate_charge', now, result, 'quedaban reservas sin evidencia y ya hubo un reenvío ambiguo');
          return;
        }
      }
      if (ev.ambiguous && settlement === 'none') {
        // Ambiguo sin ninguna reserva que lo cuente en el ledger: el posible cobro no está acotado → excepción.
        await this.decline(r, 'ambiguous_without_reservation', 'duplicate_charge', now, result, 'el resultado es ambiguo y no hay reserva que lo cuente como gasto');
        return;
      }
      const fits = await this.worstCaseFits(r, provider, reservedAmount);
      if (fits.ok === false) {
        await this.decline(r, fits.reason, 'budget', now, result, fits.detail);
        return;
      }
    }

    const prev = providerReconcileStateOf(os);
    const ambiguous = ev.action === 'resubmit' && ev.ambiguous;
    const nowIso = now.toISOString();
    const history = (Array.isArray(prev.history) ? prev.history : []).slice(-9);
    // Review M3: un re-poll (gratis) no consume reenvíos; tiene su propio tope.
    const state = {
      rounds: ev.action === 'repoll' ? d.round - 1 : d.round,
      repolls: Math.max(0, Math.floor(Number(prev.repolls ?? 0)) || 0) + (ev.action === 'repoll' ? 1 : 0),
      ambiguousRounds: d.ambiguousRounds + (ambiguous ? 1 : 0),
      lastAt: nowIso, lastKind: d.kind, lastAction: ev.action, lastSettlement: settlement,
      lastReason: ev.why.slice(0, 300),
      maxRounds: PROVIDER_RECONCILE_MAX_RESUBMITS, maxAmbiguousRounds: PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS,
      history: [...history, {
        at: nowIso, kind: d.kind, action: ev.action, settlement, ambiguous,
        counted: ev.action === 'resubmit' ? ev.counted : null, error: String(r.error ?? '').slice(0, 200),
      }],
    };
    const resubmitVideo = ev.action === 'resubmit' && r.type === 'video';
    const resubmitProvider = ev.action === 'resubmit' && r.type === 'presentation';
    if (ev.action === 'repoll' && ev.adoptJobId) {
      // Review I3: el job existe (sufijo del error) pero el worker no llegó a persistirlo → se registra (cercado por el
      // error y el intento) para que el re-poll lo retome sin reenviar.
      await this.whileUnchanged(r, (m) => m.query( // misma transacción: la fila ya está tomada
        `update public.generation_item_runs
            set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('external',
                  coalesce(output_summary->'external', '{}'::jsonb) || jsonb_build_object('videogenJobId', $2::text, 'mode', 'real', 'adoptedBy', 'provider_reconcile'))
          where id = $1 and status = 'failed' and coalesce(error, '') = $3 and attempt_count = $4 and not (coalesce(output_summary->'external', '{}'::jsonb) ? 'videogenJobId')`,
        [r.id, ev.adoptJobId, String(r.error ?? ''), r.attempt_count],
      ));
    }
    try {
      await this.runs.retryItem(Number(r.course_id), String(r.owner_id), Number(r.blueprint_number), r.job_id, r.item_key, resubmitVideo, resubmitProvider, {
        policy, now,
        providerReconcile: { kind: d.kind, action: ev.action, ambiguous, expectError: String(r.error ?? ''), state, ...(watch ? { watch: true } : {}) },
      });
    } catch (err) {
      const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
      const code = String((resp && typeof resp === 'object' && ((resp as any).reason || (resp as any).code)) || (err instanceof Error ? err.name : 'error')).slice(0, 100);
      const status = (err as { getStatus?: () => number })?.getStatus?.();
      // Carrera (otro tick / retry lo cambió), pausa del usuario o infraestructura → próximo tick (la reserva ya quedó
      // conciliada: repetir la conciliación es un no-op). Solo un rechazo DEFINITIVO registra la excepción.
      const transient = code === 'auto_heal_not_eligible' || code === 'run_paused' ||
        /unavailable|timeout|ECONN|EMAXCONN|deadlock|lock|QueryFailed|Connection|InternalServerError|Error$/i.test(code) ||
        (typeof status === 'number' && status >= 500) || typeof status !== 'number';
      if (transient) {
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: code });
        return;
      }
      await this.decline(r, code, /budget|presupuesto/i.test(code) ? 'budget' : 'unrecoverable', now, result, `retryItem: ${errText(err)}`);
      return;
    }
    if (ev.action === 'repoll') {
      result.repolled.push({ runId: r.job_id, itemKey: r.item_key, kind: d.kind });
      this.logger.warn(`conciliación de proveedor: ${r.item_key} (run ${r.job_id}) — ${ev.why}; se retoma el MISMO job (sin reenviar)`);
    } else {
      result.resubmitted.push({ runId: r.job_id, itemKey: r.item_key, kind: d.kind, settlement, ambiguous });
      this.logger.warn(`conciliación de proveedor: ${r.item_key} (run ${r.job_id}) — ${d.kind}: reserva ${settlement}${ambiguous ? ' (possible_duplicate)' : ''}; ` +
        `reenvío automático ${d.round}/${PROVIDER_RECONCILE_MAX_RESUBMITS} dentro del presupuesto`);
    }
  }

  /**
   * Videogen con jobId (persistido o del sufijo del error): estado → costo → conciliación. Review C1: con un estado no
   * terminal (o el GET caído) NUNCA se reenvía (el job viejo todavía puede renderizar y cobrar): se vuelve a consultar
   * con espera creciente y, pasado el tope, queda la excepción. Review I1: un costo 0 libera solo con evidencia fuerte.
   */
  private async videogenEvidence(r: Row, os: Record<string, any>, kind: ProviderReconcileKind, pending: PendingCharge[], ageSecs: number,
    prevState: Record<string, any>, now: Date, watch = false): Promise<Evidence> {
    const jobId = String(videogenJobIdOf(os, r.error) ?? '');
    const resKey = typeof os.externalReservationKey === 'string' ? os.externalReservationKey : null;
    const res = resKey ? pending.find((p) => p.idempotency_key === resKey && p.reservation) ?? null : null;
    let st: VideogenBatchJob;
    try {
      st = await withTimeout(this.videogen().getVideoStatus(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET status ${jobId}`);
    } catch (err) {
      if (ageSecs >= PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS) {
        return { action: 'decline', reason: 'videogen_lookup_unavailable', attention: 'duplicate_charge',
          why: `el estado del job ${jobId} no se pudo consultar durante ${PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS / 3600} h (${errText(err)}); no se reenvía con el job posiblemente vivo` };
      }
      return { action: 'wait', recheck: true, why: `estado de ${jobId} no disponible (${errText(err)})` };
    }
    const status = String(st.status ?? '');
    if (isJobCompleted(status) || status.toLowerCase() === 'completed_local') {
      // El job terminó bien: se retoma por poll (gratis); el worker liquida la reserva con el costo al completar.
      return { action: 'repoll', adoptJobId: os.external?.videogenJobId ? null : jobId, why: `Videogen informa ${status} para ${jobId}` };
    }
    const cancelAt = Date.parse(String(prevState.cancelRequestedAt ?? ''));
    const cancelPending = Number.isFinite(cancelAt) && String(prevState.cancelError ?? '') === String(r.error ?? '');
    if (watch && (!isJobFailed(status) || cancelPending)) {
      // Vigilancia (excepción provider_stuck_no_cancel ya registrada): se sigue consultando gratis. Un `failed` después de
      // un cancel no prueba nada (Videogen marca failed sin detener el procesador): solo `completed` lo resuelve.
      return { action: 'wait', recheck: true, why: `vigilancia del job ${jobId}: sigue ${status || 'sin estado'} (excepción registrada; se entrega solo si termina)` };
    }
    let cancelConfirmed = false;
    if (cancelPending) {
      // Review overdue I1: tras cancelar, reenviar solo si DOS lecturas (la primera ≥ 10 min después del cancel, la segunda
      // ≥ 10 min después de la primera) muestran `failed` y el job IDÉNTICO a la foto S0 tomada al cancelar (etapa,
      // progreso, escenas, costo y registros de uso). Si el procesador lo tomó justo antes del cancel (Videogen marca
      // failed pero no lo detiene), escribe current_step y/o suma uso → diferencia → excepción, nunca un reenvío.
      if (now.getTime() - cancelAt < PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS * 1000) {
        return { action: 'wait', recheck: true, why: `cancelación del job ${jobId} pedida; se confirma el estado (${status || 'sin estado'})` };
      }
      let snap: Record<string, unknown> | null = null;
      try {
        const c = await withTimeout(this.videogen().getVideoCost(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET cost ${jobId}`);
        snap = videogenSnapshot(st, c);
      } catch (err) {
        return { action: 'wait', recheck: true, why: `costo de ${jobId} no disponible para confirmar la cancelación (${errText(err)})` };
      }
      const s0 = (prevState.cancelSnapshot ?? null) as Record<string, unknown> | null;
      const vgc = this.videogen();
      const attempts = Math.max(1, Math.floor(Number(prevState.cancelAttempts ?? 1)) || 1);
      if (s0 && /^(queued|pending|waiting)$/i.test(status) && sameSnapshot({ ...snap, status: 'failed' }, s0) && attempts < PROVIDER_RECONCILE_MAX_CANCEL_ATTEMPTS
        && typeof vgc.cancelVideo === 'function') {
        // Re-review I-n1: la cancelación anterior no tuvo efecto (POST vencido / 5xx antes de aplicar) y el job sigue
        // encolado e idéntico a S0 → se vuelve a pedir, con la MISMA foto S0 y la marca persistida antes del POST.
        return this.requestCancel(r, vgc, jobId, s0, now, attempts + 1);
      }
      if (!isJobFailed(status) || !s0 || !sameSnapshot(snap, s0)) {
        return { action: 'decline', reason: PROVIDER_STUCK_NO_CANCEL, attention: 'duplicate_charge',
          why: `el job ${jobId} cambió después de la cancelación (estado ${status || 'sin estado'}; antes ${JSON.stringify(s0)}, ahora ${JSON.stringify(snap)}): ` +
            'el procesador de Videogen lo tomó y la cancelación no lo detiene; reenviar podría producir un doble render pagado' };
      }
      const first = Date.parse(String(prevState.cancelConfirm1At ?? ''));
      if (!Number.isFinite(first)) {
        await this.patchState(r, { cancelConfirm1At: now.toISOString() });
        return { action: 'wait', recheck: true, why: `job ${jobId} cancelado e igual a la foto S0 (1.ª lectura); se confirma con otra ≥ 10 min después` };
      }
      if (now.getTime() - first < PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS * 1000) {
        return { action: 'wait', recheck: true, why: `job ${jobId} cancelado: esperando la 2.ª lectura` };
      }
      cancelConfirmed = true;
    }
    if (!isJobFailed(status)) {
      // Tope ÚNICO de render (el del worker), desde el primer poll del job.
      const since = Date.parse(String(os.videoPollSince ?? '')) || new Date(r.finished_at).getTime();
      const liveSecs = (now.getTime() - since) / 1000;
      const cap = providerReconcileLiveJobMaxSeconds();
      if (kind !== 'videogen_overdue' && kind !== 'videogen_stuck' && liveSecs < cap) {
        return { action: 'wait', recheck: true, why: `el job ${jobId} sigue ${status || 'sin estado'} (se vuelve a consultar, sin reenviar)` };
      }
      const queued = /^(queued|pending|waiting)$/i.test(status);
      const vg = this.videogen();
      if (queued && !cancelPending && typeof vg.cancelVideo === 'function') {
        // Encolado: la cancelación de Videogen lo saca de la cola (nunca empezó a gastar). Se confirma y se sigue por evidencia.
        let s0: Record<string, unknown>;
        try {
          // Foto S0 ANTES del cancel (lo que se va a comparar después): estado/etapa/progreso/escenas + costo y uso.
          const c0 = await withTimeout(vg.getVideoCost(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET cost ${jobId}`);
          s0 = videogenSnapshot({ ...st, status: 'failed' }, c0);
        } catch (err) {
          return { action: 'wait', recheck: true, why: `costo de ${jobId} no disponible para la foto S0 (${errText(err)}); no se cancela todavía` };
        }
        return this.requestCancel(r, vg, jobId, s0, now, 1);
      }
      // Procesando (o sin cancelación efectiva): reenviar podría producir un doble render pagado → excepción (c).
      return { action: 'decline', reason: PROVIDER_STUCK_NO_CANCEL, attention: 'duplicate_charge',
        why: `el job ${jobId} sigue ${status || 'sin estado'} tras ${(liveSecs / 3600).toFixed(2)} h (tope ${(cap / 3600).toFixed(2)} h) y Videogen no puede detener un job ` +
          `${queued ? 'encolado ya cancelado sin efecto' : 'que ya está procesando'}: reenviar podría producir un doble render pagado` };
    }
    // Job TERMINAL fallido: ya no puede renderizar. Costo (estimado) del job.
    let cost: VideogenCostBreakdown;
    try {
      cost = await withTimeout(this.videogen().getVideoCost(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET cost ${jobId}`);
    } catch (err) {
      if (ageSecs >= PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS) {
        // Sin costo pero con el job muerto: se cuenta la reserva completa (conservador) y se puede reenviar (no hay doble render).
        return { action: 'resubmit', ambiguous: false, settlement: 'none', counted: null, reservedAmount: res?.amount ?? null,
          why: `job ${jobId} falló; costo no disponible durante ${PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS / 3600} h (${errText(err)}): se cuenta la reserva completa` };
      }
      return { action: 'wait', recheck: true, why: `costo de ${jobId} no disponible (${errText(err)})` };
    }
    if (!res) {
      // Sin la reserva del intento (ya conciliada por otro tick, o una parte sin reserva): nada que liquidar acá.
      return { action: 'resubmit', ambiguous: false, settlement: 'none', counted: null, reservedAmount: null, why: `job ${jobId} falló (${st.error ?? 'sin detalle'}); costo informado ${cost.estimated_total_cost}` };
    }
    const reserved = normalizeDecimal(res.amount);
    const counted = normalizeDecimal(videogenCountedAmount(cost.estimated_total_cost, cost.breakdown ?? null));
    let mode: 'release' | 'partial' | 'charged' | 'over';
    const s0 = (prevState.cancelSnapshot ?? null) as Record<string, any> | null;
    if (cmpDec(counted, 0) === 0 && cancelConfirmed && s0 && s0.currentStep === null && Number(s0.cost) === 0 && Number(s0.usageLogs ?? 0) === 0) {
      // Cancelado en la cola, confirmado dos veces idéntico a S0 (nunca empezó: sin etapa, sin costo, sin uso) → liberar.
      mode = 'release';
    } else if (cmpDec(counted, 0) === 0) {
      if (videogenZeroCostReleasable({ status, error: st.error ?? r.error, reportedCost: cost.estimated_total_cost, breakdown: cost.breakdown ?? null })) {
        // Dos lecturas en 0 separadas por ≥ 10 min (para ESTE error) antes de liberar.
        const seen = prevState.zeroCostSeenAt && String(prevState.nextCheckError ?? '') === String(r.error ?? '') ? Date.parse(String(prevState.zeroCostSeenAt)) : NaN;
        if (!Number.isFinite(seen)) return { action: 'wait', zeroCostSeenAt: now.toISOString(), why: `Videogen informa costo 0 para ${jobId}: se confirma con una segunda lectura` };
        if (now.getTime() - seen < PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS * 1000) {
          return { action: 'wait', zeroCostSeenAt: String(prevState.zeroCostSeenAt), why: `costo 0 de ${jobId}: esperando la segunda lectura` };
        }
        mode = 'release';
      } else {
        mode = 'charged'; // 0 sin evidencia fuerte (desglose ausente / etapas pagadas / estimado no ingerido) → conservador
      }
    } else if (cmpDec(counted, reserved) < 0) mode = 'partial';
    else if (cmpDec(counted, reserved) === 0) mode = 'charged';
    else mode = 'over';
    const reason = `r62 auto: Videogen informó el job ${jobId} ${status} (${String(st.error ?? 'sin detalle').slice(0, 120)}); ` +
      `GET /api/costs/videos/{id} estimated_total_cost=${cost.estimated_total_cost} (estimado; contado ${counted}, reserva ${reserved}, ${mode})`;
    const meta = this.meta(r, kind, { videogenJobId: jobId, reportedCost: cost.estimated_total_cost, reservedAmount: reserved, countedAmount: mode === 'charged' ? reserved : counted, breakdown: cost.breakdown ?? null, settleMode: mode });
    const settlement = await this.whileUnchanged(r, () => this.settleVideogenReservation(res.idempotency_key, mode, counted, reason, jobId, status, cost.estimated_total_cost, meta));
    return { action: 'resubmit', ambiguous: false, settlement, counted: mode === 'charged' ? reserved : mode === 'release' ? normalizeDecimal(0) : counted, reservedAmount: res.amount,
      why: `job ${jobId} falló (${String(st.error ?? 'sin detalle').slice(0, 120)}); conciliado ${settlement}` };
  }

  /**
   * Re-review I-n1: la marca de cancelación (cancelRequestedAt + cancelError + foto S0, y se borra cancelConfirm1At)
   * se PERSISTE ANTES del POST. Si el POST vence, da 5xx o el procesador de Videogen aplica markFailed y después falla al
   * responder, la marca ya está: el próximo `failed` pasa por la regla de las dos lecturas contra S0 (nunca un reenvío
   * con una sola lectura). Si la marca no se pudo escribir (la fila cambió), no se cancela.
   */
  private async requestCancel(r: Row, vg: Partial<Pick<VideogenService, 'cancelVideo'>>, jobId: string, s0: Record<string, unknown>,
    now: Date, attempt: number): Promise<Evidence> {
    const marked = await this.patchState(r, {
      cancelRequestedAt: now.toISOString(), cancelError: String(r.error ?? ''), cancelSnapshot: s0, cancelConfirm1At: null,
      cancelAttempts: attempt, cancelResult: { pending: true },
    });
    if (!marked) throw new StaleRow(`la parte ${r.item_key} cambió antes de pedir la cancelación`);
    try {
      const c = await withTimeout(vg.cancelVideo!(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `POST cancel ${jobId}`);
      await this.patchState(r, { cancelResult: c });
      return { action: 'wait', recheck: true, why: `job ${jobId} encolado pasado el tope de render: cancelación pedida (intento ${attempt})` };
    } catch (err) {
      await this.patchState(r, { cancelResult: { error: errText(err) } });
      return { action: 'wait', recheck: true, why: `la cancelación del job ${jobId} no respondió (${errText(err)}); la marca queda y se confirma contra S0` };
    }
  }

  /** Liquidación de una reserva de Videogen según el modo (release / partial / charged / over). Idempotente. */
  private async settleVideogenReservation(key: string, mode: 'release' | 'partial' | 'charged' | 'over', counted: string, reason: string,
    jobId: string, status: string, reported: number, meta: Record<string, unknown>): Promise<string> {
    const opts = { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta };
    if (mode === 'release') {
      const o = await this.ledger.reconcileReservationAsNotCharged(key, reason, opts);
      return o.alreadySettled ? 'already_settled' : 'released';
    }
    if (mode === 'partial') {
      const o = await this.ledger.reconcileReservationAsChargedPartial(key, counted, reason, {
        source: 'provider_api_response', referenceIds: [`videogen:job:${jobId}`.slice(0, 200)], observedAmount: counted, currency: 'USD',
        notes: `GET /api/external/videos/{id}/status=${status}; GET /api/costs/videos/{id} estimated_total_cost=${reported}`.slice(0, 1000),
        observedAt: new Date().toISOString(),
      }, opts);
      return o.alreadySettled ? 'already_settled' : 'charged_partial';
    }
    if (mode === 'over') {
      // Review I1: lo informado supera la reserva → se cuenta TODO lo informado (nunca de menos); el peor caso del
      // reenvío lo mide con este monto (si el run no tiene saldo, la excepción es de presupuesto).
      const [ev] = await this.dataSource.query(`select (select count(*)::int from public.generation_cost_events a where a.corrects_event_id = e.id) as n
        from public.generation_cost_events e where e.idempotency_key = $1 and e.event_kind = 'CHARGE'`, [key]);
      if (ev && Number(ev.n) > 0) return 'already_settled';
      await this.ledger.recordAdjustment(key, counted, reason, {
        recordedBy: PROVIDER_RECONCILE_RECORDED_BY, settlement: true, settlementLabel: 'reconciled_as_charged',
        metadata: { ...meta, reservationReconciledAsCharged: true, overReservation: true, decidedBy: PROVIDER_RECONCILE_DECIDED_BY },
      });
      return 'charged_over_reservation';
    }
    const o = await this.ledger.reconcileReservationAsCharged(key, reason, opts);
    return o.alreadySettled ? 'already_settled' : 'charged';
  }

  /** Gamma con generationId: `credits.deducted` (del mensaje del worker o de un GET nuevo) → liquidación medida. */
  private async gammaEvidence(r: Row, os: Record<string, any>, pending: PendingCharge[], giveUp: boolean): Promise<Evidence> {
    const gid = String(os.external?.gammaGenerationId ?? '');
    const key = costIdempotencyKey('gamma', { generationId: gid });
    const open = pending.find((p) => p.idempotency_key === key) ?? null;
    const reservedAmount = pending.find((p) => p.reservation)?.amount ?? open?.amount ?? null;
    const measured = gammaMeasuredCreditsOf(r.error);
    if (measured !== null && !open) {
      // El worker ya liquidó la generación con los créditos medidos: falla conocida, nada pendiente.
      return { action: 'resubmit', ambiguous: false, settlement: 'measured_by_worker', counted: null, reservedAmount, why: `generación ${gid} falló con ${measured} créditos medidos` };
    }
    let credits: number | null = measured;
    let detail = measured !== null ? `créditos del mensaje: ${measured}` : '';
    if (credits === null) {
      try {
        const g = await withTimeout(this.gamma().getGeneration(gid), this.lookupMs(), `GET /generations/${gid}`);
        if (typeof g.creditsDeducted === 'number' && Number.isFinite(g.creditsDeducted) && g.creditsDeducted >= 0) {
          credits = g.creditsDeducted;
          detail = `GET /generations/{id}: status=${g.status}, credits.deducted=${g.creditsDeducted}`;
        } else {
          detail = `GET /generations/{id}: status=${g.status}, sin credits.deducted`;
        }
      } catch (err) {
        detail = `GET /generations/{id} falló (${errText(err)})`;
      }
    }
    if (credits === null) {
      // La generación ya terminó (falló): no hay doble generación viva; sin créditos se cuenta el estimado completo.
      if (giveUp) return { action: 'resubmit', ambiguous: false, settlement: 'none', counted: null, reservedAmount, why: `Gamma no informó los créditos de ${gid} (${detail}): se cuenta el estimado completo` };
      return { action: 'wait', why: `Gamma todavía no informa los créditos de ${gid} (${detail})` };
    }
    if (!open) return { action: 'resubmit', ambiguous: false, settlement: 'already_settled', counted: null, reservedAmount, why: `generación ${gid} falló; ${detail}` };
    const out = await this.whileUnchanged(r, () => this.ledger.settleMeasuredUsage(key, { gamma_credit: credits }, 'gamma_credits_measured', {
      recordedBy: PROVIDER_RECONCILE_RECORDED_BY,
      metadata: this.meta(r, 'gamma_failed', { gammaGenerationId: gid, creditsDeducted: credits, evidence: detail.slice(0, 300) }),
    }));
    return { action: 'resubmit', ambiguous: false, settlement: 'measured', counted: out.newTotal, reservedAmount, why: `generación ${gid} falló; ${detail}; liquidado USD ${out.newTotal}` };
  }

  /** Punto 3: la llamada perdida se cuenta COBRADA (monto reservado) con la marca possible_duplicate. Idempotente. */
  private async settleConservative(r: Row, c: PendingCharge, kind: ProviderReconcileKind, why: string, ambiguous: boolean): Promise<void> {
    const reason = `r62 auto: resultado sin evidencia del proveedor (${why.slice(0, 200)}) — se cuenta como cobrado${ambiguous ? ' (possible_duplicate)' : ''}`;
    const metadata = this.meta(r, kind, { ...(ambiguous ? { possible_duplicate: true } : {}), conservative: true, why: why.slice(0, 300) });
    if (c.reservation) {
      await this.ledger.reconcileReservationAsCharged(c.idempotency_key, reason, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata });
      return;
    }
    // Cargo pendiente que no es una reserva (p.ej. Gamma `gamma:gen:<id>` estimado): se cierra con su mismo monto.
    await this.ledger.recordAdjustment(c.idempotency_key, c.amount, reason, {
      recordedBy: PROVIDER_RECONCILE_RECORDED_BY, settlement: true, settlementLabel: 'reconciled_as_charged',
      metadata: { ...metadata, reservationReconciledAsCharged: true, decidedBy: PROVIDER_RECONCILE_DECIDED_BY },
    });
  }

  /**
   * Peor caso del reenvío: lo ya liquidado (en el ledger) + la reserva nueva ≤ saldo autorizado del run Y ≤ presupuesto
   * de recuperación de la parte (run-spend-guard.ts, misma ventana que el guard del worker).
   */
  private async worstCaseFits(r: Row, provider: string, reservedAmount: string | null): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
    const single = Number(await this.budget.singleCallCost(r.type, paidProviderOfItemType(r.type) ?? provider).catch(() => '0'));
    const next = Math.max(single, Number(reservedAmount ?? 0) || 0);
    const auth = await this.budget.runPaidAuthorizedBudget(r.job_id);
    if (auth === null) return { ok: false, reason: 'run_budget_not_authorized', detail: 'el run no tiene una autorización vigente para proveedores pagados' };
    const [spent, inFlight] = await Promise.all([this.budget.runActual(r.job_id), this.budget.reservedInFlight(r.job_id, r.id)]);
    const after = Number(spent) + Number(inFlight) + next;
    if (after > Number(auth) + 1e-9) {
      return { ok: false, reason: 'run_budget_cap', detail: `el reenvío llevaría el run a USD ${usd2(after)} y el saldo autorizado es USD ${usd2(auth)}` };
    }
    const g = await this.budget.guardRunSpend({ runId: r.job_id, itemRunId: r.id, nextCost: next, authorizedBudget: null, snapshot: true });
    const hard = g.decision.itemHardLimit;
    if (hard !== null) {
      const itemSpent = await this.itemSpent(r);
      if (itemSpent + next > hard + 1e-9) {
        return { ok: false, reason: 'item_recovery_budget_exhausted',
          detail: `la parte ya gastó USD ${usd2(itemSpent)}; con el reenvío (USD ${usd2(next)}) superaría su presupuesto de recuperación (USD ${usd2(hard)})` };
      }
    }
    return { ok: true };
  }

  /** Lo gastado por la parte en su generación vigente desde su último reinicio de presupuesto (= guardRunSpend). */
  private async itemSpent(r: Row): Promise<number> {
    const [sp] = await this.dataSource.query(
      `with cur as (
         select created_at, nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz as reset_at
           from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1)
       select coalesce(sum(e.amount),0)::text as t
         from public.generation_cost_events e, cur
        where e.run_id = $1 and e.item_key = $2 and e.billing_account <> 'user_key'
          and e.created_at >= greatest(cur.created_at, coalesce(cur.reset_at, cur.created_at))`,
      [r.job_id, r.item_key],
    );
    return Number(sp?.t ?? 0);
  }

  /** Cargos reales PENDIENTES (sin ningún ajuste) de la parte, de intentos todavía no reconocidos, del proveedor. */
  /** Review I2: acotado a los intentos que el barrido VIO (attempt ≤ attempt_count del SELECT): nunca toca el intento nuevo en vuelo. */
  private async pendingCharges(r: Row, provider: string, ack: number): Promise<PendingCharge[]> {
    const rows: any[] = await this.dataSource.query(
      `select e.idempotency_key, e.amount::text as amount, coalesce((e.metadata->>'reservation') = 'true', false) as reservation,
              coalesce(e.attempt, 0) as attempt, e.provider, e.external_operation_id
         from public.generation_cost_events e
        where e.item_run_id = $1 and e.event_kind = 'CHARGE' and e.billing_account <> 'mock' and e.provider = $2
          and e.measurement_status = 'pending' and coalesce(e.attempt, 0) > $3::int and coalesce(e.attempt, 0) <= $4::int
          and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
        order by e.created_at, e.id`,
      [r.id, provider, ack, Math.max(0, Math.floor(Number(r.attempt_count) || 0))],
    );
    return rows.map((x) => ({ idempotency_key: String(x.idempotency_key), amount: String(x.amount), reservation: !!x.reservation, attempt: Number(x.attempt), provider: String(x.provider), external_operation_id: x.external_operation_id ?? null }));
  }

  private meta(r: Row, kind: ProviderReconcileKind | 'reservation', extra: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: r.job_id, itemKey: r.item_key, itemRunId: r.id, decidedBy: PROVIDER_RECONCILE_DECIDED_BY, decidedByRole: 'system', actor: 'system', r62: 'provider_reconcile', kind,
      failureCode: /^\s*([a-z][a-z0-9_]*)/.exec(String(r.error ?? ''))?.[1] ?? null, ...extra,
    };
  }

  /** Review M4: solo sobre la MISMA falla que se evaluó (mismo error e intento). */
  private async patchState(r: Row, patch: Record<string, unknown>): Promise<boolean> {
    const res = await this.dataSource.query(
      `update public.generation_item_runs
          set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('${PROVIDER_RECONCILE_KEY}',
                coalesce(output_summary->'${PROVIDER_RECONCILE_KEY}', '{}'::jsonb) || $2::jsonb)
        where id = $1 and status = 'failed' and coalesce(error, '') = $3 and attempt_count = $4`,
      [r.id, JSON.stringify(patch), String(r.error ?? ''), r.attempt_count],
    );
    // typeorm (pg) devuelve [filas, cantidad] en un UPDATE.
    return Array.isArray(res) && typeof res[1] === 'number' ? res[1] > 0 : true;
  }

  /**
   * Review I2 + re-review m1: cada escritura (ledger o estado) corre con la fila de la parte tomada `FOR NO KEY UPDATE`
   * (bloquea UPDATE / FOR UPDATE concurrentes —retryItem, el scheduler— pero no el FOR KEY SHARE de las FK del ledger,
   * que la escritura de adentro necesita; con FOR UPDATE se trabaría contra sí mismo) y
   * verificada EXACTAMENTE como la vio el barrido (failed, mismo error, mismo intento, generación vigente). Si cambió
   * (reapertura manual, otro tick, otro proceso durante un reload) no se escribe nada (StaleRow) y el próximo tick
   * re-evalúa; mientras dura la escritura, una reapertura concurrente (retryItem toma la misma fila FOR UPDATE) espera.
   * Una escritura sobre la MISMA fila tiene que usar el `m` recibido (otra conexión se trabaría con este lock).
   * Las escrituras del ledger que corren adentro (reconcile*, recordAdjustment, settleMeasuredUsage) solo tocan
   * generation_cost_events, así que no pueden esperar un lock que tenga retryItem. lock_timeout corto: si la fila está
   * tomada, este tick no espera (StaleRow → próximo tick). Junto con la cota de intento de pendingCharges, la reserva de
   * un intento nuevo nunca se liquida acá.
   */
  private async whileUnchanged<T>(r: Row, fn: (m: { query: (sql: string, params?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (m) => {
      await m.query(`set local lock_timeout = '5s'`);
      let cur: any;
      try {
        [cur] = await m.query(
          `select g.status, g.error, g.attempt_count, g.generation,
                  (select max(n.generation) from public.generation_item_runs n where n.job_id = g.job_id and n.item_key = g.item_key) as latest
             from public.generation_item_runs g where g.id = $1 for no key update of g`,
          [r.id],
        );
      } catch (err) {
        if (/lock timeout|lock_timeout|canceling statement due to lock/i.test(errText(err))) throw new StaleRow(`la parte ${r.item_key} está tomada`);
        throw err;
      }
      if (!cur || cur.status !== 'failed' || String(cur.error ?? '') !== String(r.error ?? '') || Number(cur.attempt_count) !== Number(r.attempt_count)
        || Number(cur.latest) !== Number(cur.generation)) {
        throw new StaleRow(`la parte ${r.item_key} cambió desde la lectura`);
      }
      return fn(m);
    });
  }

  /** Excepción explícita (punto 3): queda en el item (providerReconcile.declined + attention_reason) y en el log. */
  private async decline(r: Row, reason: string, attention: 'budget' | 'duplicate_charge' | 'unrecoverable', now: Date, result: ProviderReconcileSweepResult, detail: string): Promise<void> {
    await this.patchState(r, { declined: reason.slice(0, 100), declinedAt: now.toISOString(), declinedError: String(r.error ?? ''), declinedDetail: detail.slice(0, 400), attentionReason: attention });
    try {
      await this.dataSource.query(`update public.generation_item_runs set attention_reason = $2 where id = $1 and status = 'failed' and coalesce(error, '') = $3 and attempt_count = $4`,
        [r.id, attention, String(r.error ?? ''), r.attempt_count]);
    } catch {
      // Esquema sin columnas de recuperación (bases previas a REL): el motivo queda en output_summary.
    }
    result.declined.push({ runId: r.job_id, itemKey: r.item_key, reason });
    this.logger.warn(`conciliación de proveedor: ${r.item_key} (run ${r.job_id}) NO se reenvía solo (${reason}: ${detail}); excepción registrada (${attention})`);
  }

  // ── d5: reservas de Videogen con jobId (sin reenvío) ───────────────────────

  /**
   * Reservas de Videogen PENDIENTES de partes que ya no las usan (las que listaba la herramienta de admin), con un jobId
   * conocido y recientes, de runs elegibles: se concilian con la evidencia del job TERMINAL. Nunca se liberan acá (un
   * costo 0 o un job completado se cuentan como cobrados; review I1) ni se concilian sin evidencia (siguen contadas).
   * Review I4: a lo sumo PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK reservas consultadas por tick (el tick es serial con
   * el empaque automático).
   */
  private async reconcileVideogenReservations(now: Date, windowSecs: number, skipItems: Set<string>, result: ProviderReconcileSweepResult): Promise<void> {
    const pend = await loadPendingVideogenReservations(this.dataSource, null);
    let lookups = 0;
    for (const p of pend) {
      if (lookups >= PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK) break;
      if (!p.videogenJobId || skipItems.has(p.itemRunId)) continue;
      if (!p.createdAt || now.getTime() - Date.parse(p.createdAt) > windowSecs * 1000) continue;
      const [it] = await this.dataSource.query(
        `select g.id, g.job_id, g.item_key, g.status, g.error, g.output_summary, pj.status as job_status, pj.worker_status, pj.created_at as run_created_at
           from public.generation_item_runs g join public.production_jobs pj on pj.id = g.job_id where g.id = $1`,
        [p.itemRunId],
      );
      if (!it || ['cancelled', 'cancelling'].includes(String(it.job_status)) || ['cancelled', 'cancelling'].includes(String(it.worker_status))) continue;
      if (!providerReconcileRunEligible({ id: String(it.job_id), created_at: it.run_created_at })) continue;
      if (['pending', 'running', 'retrying'].includes(String(it.status))) continue;
      const os = (typeof it.output_summary === 'string' ? JSON.parse(it.output_summary) : it.output_summary) ?? {};
      const archived = (Array.isArray(os.previousExternals) ? os.previousExternals : []).find((x: any) => x && x.externalReservationKey === p.reservationKey);
      const jobId = String(archived?.external?.videogenJobId ?? (os.externalReservationKey === p.reservationKey ? os.external?.videogenJobId ?? '' : ''));
      if (!jobId) continue;
      lookups++;
      let st: VideogenBatchJob;
      let cost: VideogenCostBreakdown;
      try {
        st = await withTimeout(this.videogen().getVideoStatus(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET status ${jobId}`);
        const status = String(st.status ?? '');
        const terminal = isJobFailed(status) || isJobCompleted(status) || status.toLowerCase() === 'completed_local';
        if (!terminal) continue;
        cost = await withTimeout(this.videogen().getVideoCost(jobId, { timeoutMs: this.lookupMs() }), this.lookupMs(), `GET cost ${jobId}`);
      } catch {
        continue; // sin evidencia: sigue pendiente (contada como gasto); próximo tick
      }
      const reserved = normalizeDecimal(p.amount);
      const counted = normalizeDecimal(videogenCountedAmount(cost.estimated_total_cost, cost.breakdown ?? null));
      const mode: 'partial' | 'charged' | 'over' = cmpDec(counted, 0) === 0 || cmpDec(counted, reserved) === 0 ? 'charged'
        : cmpDec(counted, reserved) < 0 ? 'partial' : 'over';
      const row = { id: String(it.id), job_id: String(it.job_id), item_key: String(it.item_key), error: it.error } as Row;
      const reason = `r62 auto: reserva de Videogen del job ${jobId} (${st.status}) conciliada con GET /api/costs/videos/{id} estimated_total_cost=${cost.estimated_total_cost} (estimado; ${mode})`;
      const meta = this.meta(row, 'reservation', { videogenJobId: jobId, reportedCost: cost.estimated_total_cost, reservedAmount: reserved, countedAmount: mode === 'charged' ? reserved : counted, attemptState: p.attemptState, settleMode: mode });
      const settlement = await this.settleVideogenReservation(p.reservationKey, mode, counted, reason, jobId, String(st.status), cost.estimated_total_cost, meta);
      result.reservationsReconciled.push({ runId: p.runId, reservationKey: p.reservationKey, settlement });
      this.logger.warn(`conciliación de reservas de Videogen: ${p.reservationKey} (run ${p.runId}) → ${settlement} (job ${jobId})`);
    }
  }
}

/**
 * Review overdue I1 — foto comparable de un job de Videogen (status + costo). `status` se normaliza a `failed` en S0
 * porque la foto se toma antes del cancel (el estado esperado después es `failed`); el resto tiene que quedar igual.
 */
function videogenSnapshot(st: VideogenBatchJob, c: VideogenCostBreakdown): Record<string, unknown> {
  return {
    status: String(st.status ?? '').toLowerCase(),
    currentStep: st.current_step ?? null,
    progress: st.progress ?? null,
    scenes: st.scenes_count ?? c.scenes_count ?? null,
    cost: Number(c.estimated_total_cost),
    usageLogs: c.usage_logs_count ?? null,
  };
}

/** Igualdad campo a campo (el jsonb de Postgres no conserva el orden de las claves). */
function sameSnapshot(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  return true;
}
