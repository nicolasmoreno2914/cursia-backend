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
import { loadPendingVideogenReservations } from './run-completion';
import {
  PROVIDER_RECONCILE_AMBIGUOUS_KINDS,
  PROVIDER_RECONCILE_EXCLUDED_COURSE_IDS,
  PROVIDER_RECONCILE_KEY,
  PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS,
  PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS,
  PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS,
  PROVIDER_RECONCILE_MAX_RESUBMITS,
  PROVIDER_RECONCILE_PERMANENT_SKIPS,
  PROVIDER_RECONCILE_SQL_REGEX,
  ProviderReconcileKind,
  gammaMeasuredCreditsOf,
  providerReconcileDecision,
  providerReconcileStateOf,
  videogenCountedAmount,
} from './provider-reconcile';

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
  videogen?: Pick<VideogenService, 'getVideoStatus' | 'getVideoCost'> | null;
  gamma?: { getGeneration(generationId: string): Promise<GammaGenerationStatus> } | null;
}
export const PROVIDER_RECONCILE_CLIENTS = 'PROVIDER_RECONCILE_CLIENTS';

/** Quién decide en el ledger (auditoría: H4 de L-flow cuenta `recorded_by like 'admin%'` como manual). */
export const PROVIDER_RECONCILE_RECORDED_BY = 'system_provider_reconcile';
export const PROVIDER_RECONCILE_DECIDED_BY = 'system';

type Row = {
  id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
  finished_at: Date; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number; attempt_count: number;
};

type PendingCharge = { idempotency_key: string; amount: string; reservation: boolean; attempt: number; provider: string; external_operation_id: string | null };

/** Resultado de la evidencia de UNA parte. */
type Evidence =
  | { action: 'wait'; why: string }
  | { action: 'repoll'; why: string }
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

  private videogen(): Pick<VideogenService, 'getVideoStatus' | 'getVideoCost'> {
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
              pj.course_id, pj.owner_id, b.blueprint_number
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation'
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
          and not (pj.course_id = any($5::bigint[]))
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
                   and coalesce(g.output_summary->'${PROVIDER_RECONCILE_KEY}'->>'declinedError', '') = coalesce(g.error, ''))
        order by g.finished_at desc, g.id desc
        limit $4`,
      [now.toISOString(), windowSecs, PROVIDER_RECONCILE_SQL_REGEX, limit, [...PROVIDER_RECONCILE_EXCLUDED_COURSE_IDS]],
    );
    result.candidates = rows.length;
    const handled = new Set<string>();
    for (const r of rows) {
      handled.add(String(r.id));
      try {
        await this.reconcileOne(r, now, policy, result);
      } catch (err) {
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
    const d = providerReconcileDecision(r, now, policy);
    if (d.heal === false) {
      result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: d.reason });
      if (PROVIDER_RECONCILE_PERMANENT_SKIPS.includes(d.reason)) {
        await this.decline(r, d.reason, d.reason === 'ambiguous_cap_reached' ? 'duplicate_charge' : 'unrecoverable', now, result,
          `se agotaron los reenvíos automáticos de la parte (${PROVIDER_RECONCILE_MAX_RESUBMITS}, de ellos ${PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS} ambiguo)`);
      }
      return;
    }
    const os = (r.output_summary ?? {}) as Record<string, any>;
    const ack = Math.max(0, Math.floor(Number(os.reconciliationAcknowledgedThroughAttempt ?? 0)) || 0);
    const provider = r.type === 'video' ? 'videogen' : 'gamma';
    const pending = await this.pendingCharges(r.id, provider, ack);
    const ageSecs = (now.getTime() - new Date(r.finished_at).getTime()) / 1000;
    const giveUp = ageSecs >= PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS;

    let ev: Evidence;
    switch (d.kind) {
      case 'videogen_failed':
      case 'videogen_stuck':
        ev = await this.videogenEvidence(r, os, d.kind, pending, giveUp);
        break;
      case 'gamma_failed':
        ev = await this.gammaEvidence(r, os, pending, giveUp);
        break;
      default:
        ev = { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount: null, why: `${d.kind}: envío sin id del proveedor (nada que consultar)` };
    }

    if (ev.action === 'wait') {
      result.waiting.push({ runId: r.job_id, itemKey: r.item_key, why: ev.why });
      await this.patchState(r, { lastCheckAt: now.toISOString(), lastWait: ev.why.slice(0, 300) });
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
      const left = await this.pendingCharges(r.id, provider, ack);
      for (const c of left) {
        await this.settleConservative(r, c, d.kind, ev.why);
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
    const state = {
      rounds: d.round,
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
    try {
      await this.runs.retryItem(Number(r.course_id), String(r.owner_id), Number(r.blueprint_number), r.job_id, r.item_key, resubmitVideo, resubmitProvider, {
        policy, now,
        providerReconcile: { kind: d.kind, action: ev.action, ambiguous, expectError: String(r.error ?? ''), state },
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

  /** Videogen con jobId: estado → costo → conciliación (released / charged_partial / charged con tope en la reserva). */
  private async videogenEvidence(r: Row, os: Record<string, any>, kind: ProviderReconcileKind, pending: PendingCharge[], giveUp: boolean): Promise<Evidence> {
    const jobId = String(os.external?.videogenJobId ?? '');
    const resKey = typeof os.externalReservationKey === 'string' ? os.externalReservationKey : null;
    const res = resKey ? pending.find((p) => p.idempotency_key === resKey && p.reservation) ?? null : null;
    let st: VideogenBatchJob;
    try {
      st = await withTimeout(this.videogen().getVideoStatus(jobId), PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS, `GET status ${jobId}`);
    } catch (err) {
      if (giveUp) return { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount: res?.amount ?? null, why: `estado de ${jobId} no disponible desde hace ${PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS / 3600} h (${errText(err)})` };
      return { action: 'wait', why: `estado de ${jobId} no disponible (${errText(err)})` };
    }
    const status = String(st.status ?? '');
    if (isJobCompleted(status) || status.toLowerCase() === 'completed_local') {
      // El job terminó bien: se retoma por poll (gratis); el worker liquida la reserva con el costo al completar.
      return { action: 'repoll', why: `Videogen informa ${status} para ${jobId}` };
    }
    if (!isJobFailed(status)) {
      // Sigue en curso. Un job que nunca termina (auto-healer agotado) puede todavía cobrar: conservador.
      if (kind === 'videogen_stuck' || giveUp) {
        return { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount: res?.amount ?? null, why: `el job ${jobId} sigue ${status || 'sin estado'} y no terminó (puede cobrar todavía)` };
      }
      return { action: 'wait', why: `el job ${jobId} figura ${status || 'sin estado'}` };
    }
    // Falla CONOCIDA: costo (estimado) del job.
    let cost: VideogenCostBreakdown;
    try {
      cost = await withTimeout(this.videogen().getVideoCost(jobId), PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS, `GET cost ${jobId}`);
    } catch (err) {
      if (giveUp) return { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount: res?.amount ?? null, why: `costo de ${jobId} no disponible desde hace ${PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS / 3600} h (${errText(err)})` };
      return { action: 'wait', why: `costo de ${jobId} no disponible (${errText(err)})` };
    }
    if (!res) {
      // Sin la reserva del intento (ya conciliada por otro tick, o una parte sin reserva): nada que liquidar acá.
      return { action: 'resubmit', ambiguous: false, settlement: 'none', counted: null, reservedAmount: null, why: `job ${jobId} falló (${st.error ?? 'sin detalle'}); costo informado ${cost.estimated_total_cost}` };
    }
    const reserved = Number(res.amount);
    const counted = normalizeDecimal(videogenCountedAmount(cost.estimated_total_cost, reserved));
    const reason = `r62 auto: Videogen informó el job ${jobId} ${status} (${String(st.error ?? 'sin detalle').slice(0, 120)}); ` +
      `GET /api/costs/videos/{id} estimated_total_cost=${cost.estimated_total_cost} (estimado, con tope en la reserva ${normalizeDecimal(reserved)})`;
    const meta = this.meta(r, kind, { videogenJobId: jobId, reportedCost: cost.estimated_total_cost, reservedAmount: normalizeDecimal(reserved), countedAmount: counted, breakdown: cost.breakdown ?? null });
    let settlement: string;
    if (cmpDec(counted, 0) === 0) {
      const out = await this.ledger.reconcileReservationAsNotCharged(res.idempotency_key, reason, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
      settlement = out.alreadySettled ? 'already_settled' : 'released';
    } else if (cmpDec(counted, normalizeDecimal(reserved)) < 0) {
      const out = await this.ledger.reconcileReservationAsChargedPartial(res.idempotency_key, counted, reason, {
        source: 'provider_api_response', referenceIds: [`videogen:job:${jobId}`.slice(0, 200)], observedAmount: counted, currency: 'USD',
        notes: `GET /api/external/videos/{id}/status=${status}; GET /api/costs/videos/{id} estimated_total_cost=${cost.estimated_total_cost}`.slice(0, 1000),
        observedAt: new Date().toISOString(),
      }, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
      settlement = out.alreadySettled ? 'already_settled' : 'charged_partial';
    } else {
      const out = await this.ledger.reconcileReservationAsCharged(res.idempotency_key, reason, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
      settlement = out.alreadySettled ? 'already_settled' : 'charged';
    }
    return { action: 'resubmit', ambiguous: false, settlement, counted, reservedAmount: res.amount, why: `job ${jobId} falló (${String(st.error ?? 'sin detalle').slice(0, 120)}); conciliado ${settlement} USD ${counted}` };
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
        const g = await this.gamma().getGeneration(gid);
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
      if (giveUp) return { action: 'resubmit', ambiguous: true, settlement: 'none', counted: null, reservedAmount, why: `Gamma no informó los créditos de ${gid} (${detail})` };
      return { action: 'wait', why: `Gamma todavía no informa los créditos de ${gid} (${detail})` };
    }
    if (!open) return { action: 'resubmit', ambiguous: false, settlement: 'already_settled', counted: null, reservedAmount, why: `generación ${gid} falló; ${detail}` };
    const out = await this.ledger.settleMeasuredUsage(key, { gamma_credit: credits }, 'gamma_credits_measured', {
      recordedBy: PROVIDER_RECONCILE_RECORDED_BY,
      metadata: this.meta(r, 'gamma_failed', { gammaGenerationId: gid, creditsDeducted: credits, evidence: detail.slice(0, 300) }),
    });
    return { action: 'resubmit', ambiguous: false, settlement: 'measured', counted: out.newTotal, reservedAmount, why: `generación ${gid} falló; ${detail}; liquidado USD ${out.newTotal}` };
  }

  /** Punto 3: la llamada perdida se cuenta COBRADA (monto reservado) con la marca possible_duplicate. Idempotente. */
  private async settleConservative(r: Row, c: PendingCharge, kind: ProviderReconcileKind, why: string): Promise<void> {
    const reason = `r62 auto: resultado sin evidencia del proveedor (${why.slice(0, 200)}) — se cuenta como cobrado (possible_duplicate)`;
    const metadata = this.meta(r, kind, { possible_duplicate: true, conservative: true, why: why.slice(0, 300) });
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
      return { ok: false, reason: 'run_budget_cap', detail: `el reenvío llevaría el run a USD ${after.toFixed(4)} y el saldo autorizado es USD ${Number(auth).toFixed(4)}` };
    }
    const g = await this.budget.guardRunSpend({ runId: r.job_id, itemRunId: r.id, nextCost: next, authorizedBudget: null, snapshot: true });
    const hard = g.decision.itemHardLimit;
    if (hard !== null) {
      const itemSpent = await this.itemSpent(r);
      if (itemSpent + next > hard + 1e-9) {
        return { ok: false, reason: 'item_recovery_budget_exhausted',
          detail: `la parte ya gastó USD ${itemSpent.toFixed(4)}; con el reenvío (USD ${next.toFixed(4)}) superaría su presupuesto de recuperación (USD ${hard.toFixed(4)})` };
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
  private async pendingCharges(itemRunId: string, provider: string, ack: number): Promise<PendingCharge[]> {
    const rows: any[] = await this.dataSource.query(
      `select e.idempotency_key, e.amount::text as amount, coalesce((e.metadata->>'reservation') = 'true', false) as reservation,
              coalesce(e.attempt, 0) as attempt, e.provider, e.external_operation_id
         from public.generation_cost_events e
        where e.item_run_id = $1 and e.event_kind = 'CHARGE' and e.billing_account <> 'mock' and e.provider = $2
          and e.measurement_status = 'pending' and coalesce(e.attempt, 0) > $3::int
          and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
        order by e.created_at, e.id`,
      [itemRunId, provider, ack],
    );
    return rows.map((x) => ({ idempotency_key: String(x.idempotency_key), amount: String(x.amount), reservation: !!x.reservation, attempt: Number(x.attempt), provider: String(x.provider), external_operation_id: x.external_operation_id ?? null }));
  }

  private meta(r: Row, kind: ProviderReconcileKind | 'reservation', extra: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: r.job_id, itemKey: r.item_key, itemRunId: r.id, decidedBy: PROVIDER_RECONCILE_DECIDED_BY, decidedByRole: 'system', actor: 'system', r62: 'provider_reconcile', kind,
      failureCode: /^\s*([a-z][a-z0-9_]*)/.exec(String(r.error ?? ''))?.[1] ?? null, ...extra,
    };
  }

  private async patchState(r: { id: string }, patch: Record<string, unknown>): Promise<void> {
    await this.dataSource.query(
      `update public.generation_item_runs
          set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('${PROVIDER_RECONCILE_KEY}',
                coalesce(output_summary->'${PROVIDER_RECONCILE_KEY}', '{}'::jsonb) || $2::jsonb)
        where id = $1 and status = 'failed'`,
      [r.id, JSON.stringify(patch)],
    );
  }

  /** Excepción explícita (punto 3): queda en el item (providerReconcile.declined + attention_reason) y en el log. */
  private async decline(r: Row, reason: string, attention: 'budget' | 'duplicate_charge' | 'unrecoverable', now: Date, result: ProviderReconcileSweepResult, detail: string): Promise<void> {
    await this.patchState(r, { declined: reason.slice(0, 100), declinedAt: now.toISOString(), declinedError: String(r.error ?? ''), declinedDetail: detail.slice(0, 400), attentionReason: attention });
    try {
      await this.dataSource.query(`update public.generation_item_runs set attention_reason = $2 where id = $1 and status = 'failed'`, [r.id, attention]);
    } catch {
      // Esquema sin columnas de recuperación (bases previas a REL): el motivo queda en output_summary.
    }
    result.declined.push({ runId: r.job_id, itemKey: r.item_key, reason });
    this.logger.warn(`conciliación de proveedor: ${r.item_key} (run ${r.job_id}) NO se reenvía solo (${reason}: ${detail}); excepción registrada (${attention})`);
  }

  // ── d5: reservas de Videogen con jobId (sin reenvío) ───────────────────────

  /**
   * Reservas de Videogen PENDIENTES de partes que ya no las usan (las que listaba la herramienta de admin), con un jobId
   * conocido y recientes: se concilian con la evidencia del job (terminal) — nunca de forma conservadora acá (no hay
   * reenvío que lo justifique: siguen contadas como gasto hasta tener evidencia).
   */
  private async reconcileVideogenReservations(now: Date, windowSecs: number, skipItems: Set<string>, result: ProviderReconcileSweepResult): Promise<void> {
    const pend = await loadPendingVideogenReservations(this.dataSource, null);
    for (const p of pend) {
      if (!p.videogenJobId || skipItems.has(p.itemRunId)) continue;
      if (p.courseId !== null && PROVIDER_RECONCILE_EXCLUDED_COURSE_IDS.includes(Number(p.courseId))) continue;
      if (!p.createdAt || now.getTime() - Date.parse(p.createdAt) > windowSecs * 1000) continue;
      const [it] = await this.dataSource.query(
        `select g.id, g.job_id, g.item_key, g.status, g.error, g.output_summary, pj.status as job_status, pj.worker_status
           from public.generation_item_runs g join public.production_jobs pj on pj.id = g.job_id where g.id = $1`,
        [p.itemRunId],
      );
      if (!it || ['cancelled', 'cancelling'].includes(String(it.job_status)) || ['cancelled', 'cancelling'].includes(String(it.worker_status))) continue;
      if (['pending', 'running', 'retrying'].includes(String(it.status))) continue;
      const os = (typeof it.output_summary === 'string' ? JSON.parse(it.output_summary) : it.output_summary) ?? {};
      const archived = (Array.isArray(os.previousExternals) ? os.previousExternals : []).find((x: any) => x && x.externalReservationKey === p.reservationKey);
      const jobId = String(archived?.external?.videogenJobId ?? (os.externalReservationKey === p.reservationKey ? os.external?.videogenJobId ?? '' : ''));
      if (!jobId) continue;
      let st: VideogenBatchJob;
      let cost: VideogenCostBreakdown;
      try {
        st = await withTimeout(this.videogen().getVideoStatus(jobId), PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS, `GET status ${jobId}`);
        const status = String(st.status ?? '');
        const terminal = isJobFailed(status) || isJobCompleted(status) || status.toLowerCase() === 'completed_local';
        if (!terminal) continue;
        cost = await withTimeout(this.videogen().getVideoCost(jobId), PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS, `GET cost ${jobId}`);
      } catch {
        continue; // sin evidencia: sigue pendiente (contada como gasto); próximo tick
      }
      const reserved = Number(p.amount);
      const counted = normalizeDecimal(videogenCountedAmount(cost.estimated_total_cost, reserved));
      const row = { id: String(it.id), job_id: String(it.job_id), item_key: String(it.item_key), error: it.error } as Row;
      const reason = `r62 auto: reserva de Videogen del job ${jobId} (${st.status}) conciliada con GET /api/costs/videos/{id} estimated_total_cost=${cost.estimated_total_cost} (estimado, tope en la reserva)`;
      const meta = this.meta(row, 'reservation', { videogenJobId: jobId, reportedCost: cost.estimated_total_cost, reservedAmount: normalizeDecimal(reserved), countedAmount: counted, attemptState: p.attemptState });
      let settlement: string;
      if (cmpDec(counted, 0) === 0) {
        const o = await this.ledger.reconcileReservationAsNotCharged(p.reservationKey, reason, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
        settlement = o.alreadySettled ? 'already_settled' : 'released';
      } else if (cmpDec(counted, normalizeDecimal(reserved)) < 0) {
        const o = await this.ledger.reconcileReservationAsChargedPartial(p.reservationKey, counted, reason, {
          source: 'provider_api_response', referenceIds: [`videogen:job:${jobId}`.slice(0, 200)], observedAmount: counted, currency: 'USD',
          notes: `status=${st.status}; estimated_total_cost=${cost.estimated_total_cost}`, observedAt: new Date().toISOString(),
        }, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
        settlement = o.alreadySettled ? 'already_settled' : 'charged_partial';
      } else {
        const o = await this.ledger.reconcileReservationAsCharged(p.reservationKey, reason, { decidedBy: PROVIDER_RECONCILE_DECIDED_BY, recordedBy: PROVIDER_RECONCILE_RECORDED_BY, metadata: meta });
        settlement = o.alreadySettled ? 'already_settled' : 'charged';
      }
      result.reservationsReconciled.push({ runId: p.runId, reservationKey: p.reservationKey, settlement });
      this.logger.warn(`conciliación de reservas de Videogen: ${p.reservationKey} (run ${p.runId}) → ${settlement} USD ${counted} (job ${jobId})`);
    }
  }
}
