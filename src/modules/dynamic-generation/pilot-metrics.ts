/**
 * Loop 10 C2 — métricas del piloto de UN run dinámico (SOLO LECTURA, sin proveedores).
 *
 * Una sola función (`computePilotMetrics`) para el endpoint de SuperAdmin (GET /admin/dynamic-runs/:runId/pilot-metrics)
 * y para el CLI (scripts/pilot-metrics.js): las dos leen la MISMA base con las MISMAS consultas, dentro de una transacción
 * READ ONLY (Postgres rechaza cualquier escritura). Fuentes (todas existentes; nada nuevo se registra para esto):
 *   - production_jobs (run + jobs de empaque `dynamic_package` con input_payload.runId), output_summary.pause /
 *     .cancellation / .spendBreaker;
 *   - generation_item_runs (estado, tipo, output_summary.generatedBy, huellas de los ejercicios guiados);
 *   - generation_item_attempts (REL R2: intentos, desenlaces, clases de falla, reaperturas con actor y estrategia,
 *     ejecutor); sin la migración la sección queda `available: false` (nunca se inventa);
 *   - generation_cost_events (ledger: proveedor, tipo de item, final/pending, reservas), cost_budget_authorizations,
 *     cost_estimates (estimado del run).
 * Documentación de los campos: docs/v21/pilot-metrics.md.
 */
import { GUIDED_PRACTICE_DISTINCT, guidedPracticeNormTitle, guidedPracticeSignatureJaccard } from '../course-shell/guided-practice';

export const PILOT_METRICS_VERSION = 'pilot-metrics-v1';

export interface PilotMetricsQueryable {
  query(sql: string, params?: any[]): Promise<any>;
}

type Row = Record<string, any>;
const rowsOf = (r: any): Row[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []));
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as any).toISOString());
const secs = (a: unknown, b: unknown): number | null => (a == null || b == null ? null : Math.round((new Date(b as any).getTime() - new Date(a as any).getTime()) / 1000));
const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v));
const money = (v: number): number => Math.round(v * 1e6) / 1e6;
const parse = (v: unknown): any => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };

function p50(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1];
}

/** Ejecutor del navegador: executor_kind 'browser' o un executorId del navegador («browser-…»). */
export function isBrowserExecutor(kind: unknown, executorId: unknown): boolean {
  return kind === 'browser' || /^browser[-_:]/i.test(String(executorId || ''));
}

/** Acción manual de una reapertura según su estrategia (retry / regenerate / otra). */
function reopenAction(strategy: unknown): string {
  const s = String(strategy || '');
  if (/regenerat/.test(s)) return 'regenerate';
  if (/retry/.test(s) || s === '') return 'retry';
  return s.slice(0, 64);
}
const isManualActor = (a: unknown): boolean => a === 'owner' || /^admin:/.test(String(a || ''));

export interface PilotMetricsOptions {
  /** Batería de calidad del run (el endpoint la pasa; el CLI no tiene storage → null con motivo). */
  quality?: ((run: { runId: string; courseId: number; ownerId: string; blueprintNumber: number | null }) => Promise<unknown>) | null;
  qualityUnavailableReason?: string;
  /** Tope de filas listadas (browser, intervenciones). */
  listLimit?: number;
}

export class PilotMetricsNotFound extends Error {
  constructor(public readonly runId: string) {
    super(`pilot_metrics_run_not_found: ${runId}`);
  }
}

async function tableExists(q: PilotMetricsQueryable, name: string): Promise<boolean> {
  const r = rowsOf(await q.query(`select to_regclass($1) is not null as ok`, [`public.${name}`]));
  return !!(r[0] && r[0].ok);
}

/** Calcula las métricas del run. Lanza PilotMetricsNotFound si el run no existe (o no es dinámico). Nunca escribe. */
export async function computePilotMetrics(q: PilotMetricsQueryable, runId: string, opts: PilotMetricsOptions = {}): Promise<Record<string, unknown>> {
  const LIMIT = opts.listLimit ?? 200;
  const [job] = rowsOf(await q.query(
    `select id, owner_id, course_id, status, worker_status, created_at, started_at, finished_at, updated_at, input_payload, output_summary
       from public.production_jobs where id = $1 and execution_mode = 'dynamic_generation'`,
    [runId],
  ));
  if (!job) throw new PilotMetricsNotFound(runId);
  const out = parse(job.output_summary) || {};
  const input = parse(job.input_payload) || {};
  const hasAttempts = await tableExists(q, 'generation_item_attempts');
  const hasLedger = await tableExists(q, 'generation_cost_events');
  const hasAuth = await tableExists(q, 'cost_budget_authorizations');
  const hasEstimates = await tableExists(q, 'cost_estimates');

  const items = rowsOf(await q.query(
    `select id, item_key, type, generation, status, worker_id, claimed_at, finished_at, created_at, attempt_count, chapter_id::text as chapter_id, output_summary
       from public.generation_item_runs where job_id = $1 order by item_key, generation`,
    [runId],
  ));
  const latest = new Map<string, Row>();
  for (const it of items) { const p = latest.get(it.item_key); if (!p || Number(it.generation) > Number(p.generation)) latest.set(it.item_key, it); }
  const attempts = hasAttempts ? rowsOf(await q.query(
    `select a.id, a.item_run_id, a.item_key, a.generation, a.attempt_no, a.executor_kind, a.executor_id, a.started_at, a.finished_at, a.outcome,
            a.failure_class, a.failure_code, a.strategy_applied, a.actor, g.type
       from public.generation_item_attempts a join public.generation_item_runs g on g.id = a.item_run_id
      where a.job_id = $1 order by a.started_at, a.id`,
    [runId],
  )) : [];
  const auths = hasAuth ? rowsOf(await q.query(
    `select id, created_at, decision, authorized_budget::text as authorized_budget, approved_by, reason, estimate_id
       from public.cost_budget_authorizations where run_id = $1 order by created_at, id`,
    [runId],
  )) : [];
  const packages = rowsOf(await q.query(
    `select id, worker_status, status, created_at, finished_at from public.production_jobs
      where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 order by created_at, id`,
    [runId],
  ));

  // ── timing ──
  const realAttempts = attempts.filter((a) => a.outcome !== 'reopened');
  const firstClaimAt = realAttempts.length ? realAttempts[0].started_at : items.map((i) => i.claimed_at).filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? null;
  const authorizedAt = auths.find((a) => a.decision !== 'BLOCKED')?.created_at ?? null;
  // Fix I2: la aprobación HUMANA del flujo normal es una fila ADMIN_APPROVED sin run (run_id null) que el run consume al
  // crearse (bindRun: fila del run con reason «bound_from:<id>»). Su created_at es cuándo aprobó la persona; el de la
  // fila del run, cuándo se vinculó (boundAt).
  const bound = auths.find((a) => /^bound_from:[0-9a-f-]{36}$/i.test(String(a.reason || '')));
  let human: Row | null = null;
  if (bound && hasAuth) {
    [human] = rowsOf(await q.query(
      `select id, created_at, approved_by, authorized_budget::text as authorized_budget, decision from public.cost_budget_authorizations where id = $1`,
      [String(bound.reason).slice('bound_from:'.length)],
    ));
  }
  const terminal = ['completed', 'preview'].includes(String(job.worker_status));
  const completedAt = terminal ? job.finished_at ?? job.updated_at : null;
  const lastItemFinishedAt = items.map((i) => i.finished_at).filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const pkgReady = packages.find((p) => p.worker_status === 'completed');
  const start = human?.created_at ?? authorizedAt ?? job.created_at;
  const end = pkgReady?.finished_at ?? completedAt ?? null;
  const durByType = new Map<string, number[]>();
  const durSource = realAttempts.filter((a) => a.outcome === 'completed' && a.finished_at && a.started_at);
  if (durSource.length) for (const a of durSource) { const d = secs(a.started_at, a.finished_at)!; (durByType.get(a.type) || durByType.set(a.type, []).get(a.type)!).push(d); }
  else for (const it of latest.values()) if (it.status === 'completed' && it.claimed_at && it.finished_at) { const d = secs(it.claimed_at, it.finished_at)!; (durByType.get(it.type) || durByType.set(it.type, []).get(it.type)!).push(d); }
  const timing = {
    runCreatedAt: iso(job.created_at),
    authorizedAt: iso(authorizedAt),
    boundAt: iso(bound?.created_at ?? null),
    humanApprovedAt: iso(human?.created_at ?? null),
    humanApprovedBy: human?.approved_by ?? null,
    firstClaimAt: iso(firstClaimAt),
    completedAt: iso(completedAt),
    lastItemFinishedAt: iso(lastItemFinishedAt),
    packageReadyAt: iso(pkgReady?.finished_at ?? null),
    packageJobs: packages.length,
    workerStatus: job.worker_status ?? null,
    authorizationToFirstClaimSeconds: secs(start, firstClaimAt),
    firstClaimToCompletionSeconds: secs(firstClaimAt, completedAt),
    completionToPackageSeconds: secs(completedAt, pkgReady?.finished_at ?? null),
    totalWallSeconds: secs(start, end),
    totalWallFrom: human ? 'human_approval' : authorizedAt ? 'authorization' : 'run_created',
    totalWallTo: pkgReady ? 'package_ready' : completedAt ? 'completed' : null,
    durationSource: durSource.length ? 'attempts' : 'item_runs',
    byItemType: Object.fromEntries([...durByType.entries()].sort().map(([t, xs]) => [t, { count: xs.length, p50Seconds: p50(xs), maxSeconds: Math.max(...xs) }])),
  };

  // ── cost ──
  let cost: Record<string, unknown> = { available: false, reason: 'generation_cost_events no existe' };
  if (hasLedger) {
    const ev = rowsOf(await q.query(
      `select e.id, e.event_kind, e.provider, coalesce(e.item_type, 'run') as item_type, e.amount::text as amount, e.measurement_status, e.billing_account,
              e.cost_source, (e.metadata->>'reservation') = 'true' as reservation,
              exists (select 1 from public.generation_cost_events c where c.corrects_event_id = e.id) as corrected
         from public.generation_cost_events e where e.run_id = $1`,
      [runId],
    ));
    const counted = ev.filter((e) => e.billing_account !== 'user_key');
    // Pendiente = cargo con medición `pending` que ningún evento corrigió todavía (una reserva conciliada o ajustada ya
    // no está pendiente: su ajuste final la neta).
    const isPending = (e: Row) => e.event_kind === 'CHARGE' && e.measurement_status === 'pending' && !e.corrected;
    const group = (key: 'provider' | 'item_type') => {
      const m: Record<string, { totalUsd: number; settledUsd: number; pendingUsd: number; events: number }> = {};
      for (const e of counted) {
        const k = String(e[key] || 'unknown');
        const g = (m[k] = m[k] || { totalUsd: 0, settledUsd: 0, pendingUsd: 0, events: 0 });
        g.totalUsd += num(e.amount); g.events++;
        if (isPending(e)) g.pendingUsd += num(e.amount); else g.settledUsd += num(e.amount);
      }
      for (const g of Object.values(m)) { g.totalUsd = money(g.totalUsd); g.settledUsd = money(g.settledUsd); g.pendingUsd = money(g.pendingUsd); }
      return m;
    };
    const total = counted.reduce((a, e) => a + num(e.amount), 0);
    const pending = counted.filter(isPending).reduce((a, e) => a + num(e.amount), 0);
    const latestAuth = auths.length ? auths[auths.length - 1] : null;
    let estimate: Row | null = null;
    if (hasEstimates) {
      [estimate] = rowsOf(await q.query(
        `select id, created_at, scope, totals from public.cost_estimates where run_id = $1 and scope = 'run' order by created_at, id limit 1`,
        [runId],
      ));
      if (!estimate) {
        const firstAuthEst = auths.find((a) => a.estimate_id)?.estimate_id;
        if (firstAuthEst) [estimate] = rowsOf(await q.query(`select id, created_at, scope, totals from public.cost_estimates where id = $1`, [firstAuthEst]));
      }
    }
    const totals = parse(estimate?.totals) || {};
    const authorized = latestAuth && latestAuth.decision !== 'BLOCKED' ? num(latestAuth.authorized_budget) : null;
    cost = {
      available: true,
      currency: 'USD',
      totalUsd: money(total),
      settledUsd: money(total - pending),
      pendingUsd: money(pending),
      userKeyUsd: money(ev.filter((e) => e.billing_account === 'user_key').reduce((a, e) => a + num(e.amount), 0)),
      openReservations: ev.filter((e) => e.reservation && e.event_kind === 'CHARGE' && !e.corrected).length,
      events: ev.length,
      byProvider: group('provider'),
      byItemType: group('item_type'),
      authorizedBudgetUsd: authorized,
      firstAuthorizedBudgetUsd: auths.find((a) => a.decision !== 'BLOCKED') ? num(auths.find((a) => a.decision !== 'BLOCKED')!.authorized_budget) : null,
      estimate: estimate ? { id: estimate.id, createdAt: iso(estimate.created_at), expectedUsd: totals.expected != null ? num(totals.expected) : null, maxUsd: totals.max != null ? num(totals.max) : null } : null,
      totalVsAuthorized: authorized ? Math.round((total / authorized) * 10000) / 10000 : null,
      totalVsEstimateExpected: totals.expected ? Math.round((total / num(totals.expected)) * 10000) / 10000 : null,
    };
  }

  // ── retries ──
  const statusCounts: Record<string, number> = {};
  for (const it of latest.values()) statusCounts[it.status] = (statusCounts[it.status] || 0) + 1;
  let retries: Record<string, unknown> = {
    available: hasAttempts, itemStatusCounts: statusCounts,
    ...(hasAttempts ? {} : { reason: 'generation_item_attempts no existe (migración REL R2): solo attempt_count de cada item' }),
  };
  {
    const perItem = new Map<string, { type: string; n: number }>();
    if (hasAttempts) for (const a of realAttempts) { const k = a.item_key; const g = perItem.get(k) || { type: a.type, n: 0 }; g.n++; perItem.set(k, g); }
    else for (const it of items) { const g = perItem.get(it.item_key) || { type: it.type, n: 0 }; g.n += num(it.attempt_count); perItem.set(it.item_key, g); }
    const multi: Record<string, number> = {};
    const hist: Record<string, number> = {};
    for (const g of perItem.values()) { hist[String(g.n)] = (hist[String(g.n)] || 0) + 1; if (g.n > 1) multi[g.type] = (multi[g.type] || 0) + 1; }
    const outcomes: Record<string, number> = {};
    const classes: Record<string, number> = {};
    const codes: Record<string, number> = {};
    for (const a of attempts) {
      outcomes[a.outcome || 'open'] = (outcomes[a.outcome || 'open'] || 0) + 1;
      if (a.outcome !== 'reopened' && a.failure_class) classes[a.failure_class] = (classes[a.failure_class] || 0) + 1;
      if (a.outcome !== 'reopened' && a.failure_code) codes[a.failure_code] = (codes[a.failure_code] || 0) + 1;
    }
    const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])));
    retries = {
      ...retries,
      items: perItem.size,
      attempts: hasAttempts ? realAttempts.length : [...perItem.values()].reduce((a, g) => a + g.n, 0),
      attemptsPerItemHistogram: sorted(hist),
      itemsWithMultipleAttemptsByType: sorted(multi),
      outcomeCounts: sorted(outcomes),
      failureClassCounts: sorted(classes),
      failureCodeTop: Object.entries(codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([code, count]) => ({ code, count })),
    };
  }

  // ── recoveries ──
  const reopened = attempts.filter((a) => a.outcome === 'reopened');
  const autoReopen = reopened.filter((a) => !isManualActor(a.actor));
  const byStrategy: Record<string, number> = {};
  for (const a of autoReopen) { const k = `${a.actor}:${a.strategy_applied || 'unknown'}`; byStrategy[k] = (byStrategy[k] || 0) + 1; }
  let takeovers = 0;
  const byRun = new Map<string, Row[]>();
  for (const a of realAttempts) (byRun.get(a.item_run_id) || byRun.set(a.item_run_id, []).get(a.item_run_id)!).push(a);
  for (const xs of byRun.values()) for (let i = 1; i < xs.length; i++) if (['lease_expired', 'abandoned'].includes(xs[i - 1].outcome) && xs[i].executor_id && xs[i].executor_id !== xs[i - 1].executor_id) takeovers++;
  const pause = out.pause && typeof out.pause === 'object' ? out.pause : null;
  const systemPause = pause && /^system:/.test(String(pause.pausedBy || ''));
  const recoveries = {
    available: hasAttempts,
    autoReopens: autoReopen.length,
    autoReopensByActorStrategy: byStrategy,
    autoHealItems: [...latest.values()].filter((it) => parse(it.output_summary)?.autoHeal).length,
    leaseExpired: attempts.filter((a) => a.outcome === 'lease_expired').length,
    abandoned: attempts.filter((a) => a.outcome === 'abandoned').length,
    leaseTakeovers: takeovers,
    workerHandBacks: attempts.filter((a) => a.outcome === 'drained').length,
    pauses: pause ? [{
      pausedAt: pause.pausedAt ?? null, pausedBy: pause.pausedBy ?? null, reason: pause.reason ?? (systemPause ? String(pause.pausedBy).slice(7) : 'user'),
      system: !!systemPause, detail: pause.detail ?? null, resumedAt: pause.resumedAt ?? null, resumedBy: pause.resumedBy ?? null,
      resumedBySystem: /^system:/.test(String(pause.resumedBy || '')),
    }] : [],
    pauseHistory: 'latest_only',
    spendBreaker: out.spendBreaker ?? null,
  };

  // ── manual interventions ──
  const manual: Array<{ action: string; who: string | null; at: string | null; detail?: unknown }> = [];
  for (const a of auths) {
    if (a.decision !== 'ADMIN_APPROVED') continue;
    // Fix I2: una fila vinculada (bound_from) se lista con la hora y la persona de la aprobación ORIGINAL.
    const orig = bound && a.id === bound.id && human ? human : null;
    manual.push({ action: 'authorize_budget', who: (orig ?? a).approved_by ?? null, at: iso((orig ?? a).created_at),
      detail: { authorizedBudgetUsd: num((orig ?? a).authorized_budget), reason: a.reason ?? null, ...(orig ? { boundAt: iso(a.created_at), approvalId: orig.id } : {}) } });
  }
  for (const a of reopened.filter((x) => isManualActor(x.actor))) manual.push({ action: reopenAction(a.strategy_applied), who: a.actor, at: iso(a.started_at), detail: { itemKey: a.item_key, generation: Number(a.generation), strategy: a.strategy_applied ?? null } });
  if (pause && !systemPause) manual.push({ action: 'pause', who: pause.pausedBy ?? null, at: pause.pausedAt ?? null });
  // Fix M5: pausas o reanudaciones del sistema («system:…») son recuperaciones, no intervenciones manuales.
  if (pause && pause.resumedAt && !/^system:/.test(String(pause.resumedBy || ''))) manual.push({ action: 'resume', who: pause.resumedBy ?? null, at: pause.resumedAt });
  if (out.cancellation && typeof out.cancellation === 'object') manual.push({ action: 'cancel', who: out.cancellation.requestedBy ?? null, at: out.cancellation.requestedAt ?? null, detail: { reason: out.cancellation.reason ?? null } });
  if (hasLedger) {
    const rec = rowsOf(await q.query(
      `select created_at, recorded_by, metadata->>'settlement' as settlement, metadata->>'actor' as actor from public.generation_cost_events
        where run_id = $1 and event_kind = 'ADJUSTMENT' and metadata->>'settlement' like 'reconciled_as_%' order by created_at, id`,
      [runId],
    ));
    for (const r of rec) manual.push({ action: 'reconcile', who: r.actor || r.recorded_by || null, at: iso(r.created_at), detail: { settlement: r.settlement } });
  }
  manual.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const interventions = { count: manual.length, byAction: manual.reduce((m: Record<string, number>, x) => { m[x.action] = (m[x.action] || 0) + 1; return m; }, {}), list: manual.slice(0, LIMIT) };

  // ── browser use ──
  const browserAttempts = realAttempts.filter((a) => isBrowserExecutor(a.executor_kind, a.executor_id));
  const byExecutorKind: Record<string, number> = {};
  for (const a of realAttempts) { const k = a.executor_kind || 'unknown'; byExecutorKind[k] = (byExecutorKind[k] || 0) + 1; }
  const generatedBy: Record<string, number> = {};
  for (const it of latest.values()) if (it.status === 'completed') { const g = parse(it.output_summary)?.generatedBy || (/^browser[-_:]/i.test(String(it.worker_id || '')) ? 'browser' : 'unspecified'); generatedBy[g] = (generatedBy[g] || 0) + 1; }
  const browserItems = [...latest.values()].filter((it) => /^browser[-_:]/i.test(String(it.worker_id || '')));
  const browser = {
    used: browserAttempts.length > 0 || browserItems.length > 0,
    attempts: browserAttempts.length,
    byExecutorKind: Object.fromEntries(Object.entries(byExecutorKind).sort((a, b) => a[0].localeCompare(b[0]))),
    completedItemsByGeneratedBy: Object.fromEntries(Object.entries(generatedBy).sort((a, b) => a[0].localeCompare(b[0]))),
    list: (browserAttempts.length ? browserAttempts.map((a) => ({ itemKey: a.item_key, type: a.type, executorId: a.executor_id, startedAt: iso(a.started_at), outcome: a.outcome ?? null }))
      : browserItems.map((it) => ({ itemKey: it.item_key, type: it.type, executorId: it.worker_id, startedAt: iso(it.claimed_at), outcome: it.status }))).slice(0, LIMIT),
  };

  // ── quality ──
  const guidedFromSummaries = guidedPracticeFromSummaries([...latest.values()].filter((it) => it.type === 'guided_practice' && it.status === 'completed'));
  let battery: unknown = null;
  let batteryReason: string | null = opts.quality ? null : (opts.qualityUnavailableReason ?? 'sin lector de artifacts (CLI solo base): usar GET /admin/dynamic-runs/:runId/pilot-metrics');
  if (opts.quality) {
    try { battery = await opts.quality({ runId, courseId: Number(job.course_id), ownerId: String(job.owner_id), blueprintNumber: input.blueprintNumber != null ? Number(input.blueprintNumber) : null }); } catch (e: any) { batteryReason = String(e?.message || e).slice(0, 300); }
  }
  const b: any = battery;
  const quality = {
    battery: b ? { version: b.version, pass: b.pass, summary: b.summary, guidedPractice: b.guidedPractice ?? null, checks: (b.checks || []).map((c: any) => ({ id: c.id, metric: c.metric, pass: c.pass, blocking: c.blocking !== false, findings: (c.findings || []).length })), unreadableArtifacts: b.unreadableArtifacts ?? [] } : null,
    batteryUnavailableReason: b ? null : batteryReason,
    guidedPracticeFromSummaries: guidedFromSummaries,
  };

  return {
    version: PILOT_METRICS_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    run: { id: job.id, courseId: job.course_id, ownerId: job.owner_id, blueprintNumber: input.blueprintNumber ?? null, manifestId: input.manifestId ?? null, status: job.status, workerStatus: job.worker_status, items: latest.size },
    timing, cost, retries, recoveries, interventions, browser, quality,
  };
}

/**
 * Ejercicios guiados desde los output_summary del servidor (sin storage): minutos, ejercicios y repetidos entre
 * capítulos con las huellas (mismo título o firma ≥ 0,5). Runs anteriores al Loop 10 no tienen huellas.
 */
export function guidedPracticeFromSummaries(rows: Row[]): Record<string, unknown> | null {
  if (!rows.length) return null;
  const xs: Array<{ ch: string; title: string; nt: string; sig: string }> = [];
  let minutes = 0;
  let exercises = 0;
  let withFp = 0;
  for (const r of rows) {
    const s = parse(r.output_summary) || {};
    const v = s.v3Validation || {};
    minutes += num(v.minutes ?? s.minutes);
    exercises += num(v.exerciseCount ?? s.exerciseCount);
    const fps = Array.isArray(v.fingerprints) ? v.fingerprints : [];
    if (fps.length) withFp++;
    for (const f of fps) if (f && typeof f.title === 'string') xs.push({ ch: String(r.chapter_id || r.item_key), title: f.title, nt: guidedPracticeNormTitle(f.title), sig: String(f.sig || '') });
  }
  let dups = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    if (xs[i].ch === xs[j].ch) continue;
    if ((xs[i].nt && xs[i].nt === xs[j].nt) || guidedPracticeSignatureJaccard(xs[i].sig, xs[j].sig) >= GUIDED_PRACTICE_DISTINCT.situationJaccard) dups++;
  }
  return { chapters: rows.length, chaptersWithFingerprints: withFp, exercises, minutes, hours: Math.round((minutes / 60) * 10) / 10, crossChapterDuplicates: dups };
}
