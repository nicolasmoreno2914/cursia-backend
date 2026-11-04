#!/usr/bin/env node
/* eslint-disable */
// r90 (decisión del dueño 2026-11-03) — «tope de seguridad» por run = ceil_centavo(esperado × FINOPS_RUN_SAFETY_CAP_FACTOR).
//
//   S1  factor: default 1,5; acotado a [1,1, 3]; inválido / fuera de rango → 1,5 (nunca lanza)
//   S2  matemática del tope (hacia arriba al centavo; 0 → 0)
//   S3  estimateCost (seed + priors, sin red): totals.safetyCap = ceil(expected × factor), capFactor, max p90 intacto
//   S4  FinopsBudgetService.estimate() lee FINOPS_RUN_SAFETY_CAP_FACTOR (catálogo stub, sin DB)
//   S5  política: esperado 34.66 / máximo legado 191.45 con maxCostPerRun 150 → AUTO_WITHIN_POLICY (antes ADMIN_APPROVAL)
//   S6  monto autorizado (planNormalApproval) = tope; acotado por el remanente si es menor; max legado sigue en el estimado
//   S7  el esperado sobre el límite sigue bloqueando / pidiendo admin (el tope no abre la política)
//   S8  límites por proveedor / tipo siguen contra el máximo p90 (review P2-1)
//   S9  estimateSummary / estimateCategories exponen safetyCap + capFactor y conservan max
//   S10 pausa al alcanzar el autorizado: decideRunSpend(authorizedBudget = tope) → run_budget_cap
//   S11 estimado viejo sin safetyCap (compatibilidad): la vista usa esperado × 1,5
//   S12 aviso de factor inválido · S13 factor en el estimado incremental · S14 guard de proveedores pagados PAUSA al tope
//   S15 partes en vuelo sin reserva cuentan su esperado (p50), `next` su p90
//   (DB, check-v21-finops-wiring: un run frenado por un worker pagado termina `paused` run_budget_cap, nunca `blocked`)
//
// Uso: node scripts/check-r90-safety-cap.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');
const netAttempts = [];
for (const mod of ['http', 'https']) {
  const m = require(mod);
  m.request = function () { netAttempts.push(mod); throw new Error('red prohibida'); };
  m.get = m.request;
}
require('reflect-metadata');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const load = (rel) => require(path.join(distRoot, rel));
const F = load('modules/finops/index.js');
const DR = load('modules/pedagogy/dry-run.js');
const { FinopsBudgetService } = load('modules/finops/finops-budget.service.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) {
    failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const n2 = (x) => Number(x).toFixed(2);

const CAPS = { maxCostPerRun: '150', maxCostPerCourse: '500', monthlyCap: '2000', ownerMonthlyCap: '1000' };
const policy = (limits, onExceed = 'ADMIN_APPROVAL') => F.policyFromRow({ id: 'p1', version: 1, limits, require_human_approval_for_real_spend: true, on_exceed: onExceed });
/** El estimado del dueño (curso S): esperado 34.66, máximo p90×reintentos 191.45. */
function ownerEstimate(withCap = true) {
  const totals = {
    min: '20.0000000000', expected: '34.6600000000', max: '191.4500000000',
    byProvider: {
      anthropic: { min: '12', expected: '20.66', max: '120.45' },
      gamma: { min: '5', expected: '9', max: '45' },
      openai: { min: '3', expected: '5', max: '26' },
    },
    byItemType: {},
    retryAllowance: { expected: '1.0', max: '143.59' },
  };
  if (withCap) { totals.safetyCap = F.safetyCapOf(totals.expected, 1.5); totals.capFactor = 1.5; }
  return { currency: 'USD', totals };
}

(async () => {
  await check('S1 factor: default, límites e inválidos', () => {
    eq(F.readSafetyCapFactor({}), 1.5, 'ausente');
    eq(F.DEFAULT_SAFETY_CAP_FACTOR, 1.5, 'default');
    const cases = { '': 1.5, '2': 2, ' 2 ': 2, '1.1': 1.1, '3': 3, '1.25': 1.25, '1.09': 1.5, '1': 1.5, '3.01': 1.5, '10': 1.5, 'abc': 1.5, '-2': 1.5, 'NaN': 1.5, 'Infinity': 1.5, '1e0': 1.5, '2,5': 1.5 };
    for (const [raw, want] of Object.entries(cases)) eq(F.readSafetyCapFactor({ FINOPS_RUN_SAFETY_CAP_FACTOR: raw }), want, `env=${JSON.stringify(raw)}`);
    eq(F.parseSafetyCapFactor(2.5), 2.5, 'número');
    eq(F.parseSafetyCapFactor(null), 1.5, 'null');
  });

  await check('S2 tope = hacia arriba al centavo de esperado × factor', () => {
    eq(F.safetyCapOf('34.66', 1.5), '51.9900000000', '34.66 × 1,5 exacto');
    eq(F.safetyCapOf('34.6612', 1.5), '52.0000000000', '51.9918 → 52.00');
    eq(F.safetyCapOf('34.6601', 1.5), '52.0000000000', '51.99015 → 52.00 (siempre hacia arriba)');
    eq(F.safetyCapOf('0.0000000001', 1.5), '0.0100000000', 'mínimo un centavo');
    eq(F.safetyCapOf('0', 1.5), '0.0000000000', 'cero');
    eq(F.safetyCapOf('10', 2), '20.0000000000', 'factor 2');
    eq(F.safetyCapOf('10', 9), '15.0000000000', 'factor inválido → 1,5');
    eq(F.safetyCapOf('23.4', 1.5), '35.1000000000', '#93');
  });

  const seed = DR.seedPricing();
  const manifest = [
    { key: 'c1', type: 'content', moduleId: 'm1', chapterId: 'c1' },
    { key: 'c2', type: 'content', moduleId: 'm1', chapterId: 'c2' },
    { key: 'p1', type: 'presentation', moduleId: 'm1', chapterId: 'c1' },
    { key: 'e1', type: 'exam', moduleId: 'm1', chapterId: null },
  ];
  const items = F.estimateItemsForRun(manifest, 'real', null);
  const base = { items, catalog: seed.catalog, usageModel: load('modules/finops/usage-model.js').usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } };

  await check('S3 estimateCost: totals.safetyCap / capFactor; max p90 intacto', () => {
    const e = F.estimateCost(base);
    eq(e.totals.capFactor, 1.5, 'factor default');
    eq(e.totals.safetyCap, F.safetyCapOf(e.totals.expected, 1.5), 'tope');
    assert(Number(e.totals.safetyCap) >= Number(e.totals.expected) * 1.5 - 1e-9 && Number(e.totals.safetyCap) < Number(e.totals.expected) * 1.5 + 0.01, 'redondeo al centavo');
    const e2 = F.estimateCost({ ...base, safetyCapFactor: 2 });
    eq([e2.totals.max, e2.totals.expected], [e.totals.max, e.totals.expected], 'max/esperado no dependen del factor');
    eq(e2.totals.safetyCap, F.safetyCapOf(e.totals.expected, 2), 'factor 2');
    assert(Number(e.totals.max) > Number(e.totals.safetyCap), `el máximo p90 legado sigue ahí y es mayor (${e.totals.max} vs ${e.totals.safetyCap})`);
    eq(F.estimateCost({ ...base, safetyCapFactor: 7 }).totals.capFactor, 1.5, 'factor inválido → 1,5');
  });

  await check('S4 FinopsBudgetService.estimate() usa FINOPS_RUN_SAFETY_CAP_FACTOR', async () => {
    const svc = new FinopsBudgetService(null, null);
    svc.catalog = async () => seed.catalog;
    const prev = process.env.FINOPS_RUN_SAFETY_CAP_FACTOR;
    try {
      delete process.env.FINOPS_RUN_SAFETY_CAP_FACTOR;
      const a = await svc.estimate(items, { retryPolicy: { maxRetries: 1 } });
      eq(a.totals.capFactor, 1.5, 'sin env');
      process.env.FINOPS_RUN_SAFETY_CAP_FACTOR = '2';
      const b = await svc.estimate(items, { retryPolicy: { maxRetries: 1 } });
      eq([b.totals.capFactor, b.totals.safetyCap], [2, F.safetyCapOf(b.totals.expected, 2)], 'env=2');
      process.env.FINOPS_RUN_SAFETY_CAP_FACTOR = '0.5';
      eq((await svc.estimate(items, { retryPolicy: { maxRetries: 1 } })).totals.capFactor, 1.5, 'env inválida');
    } finally {
      if (prev === undefined) delete process.env.FINOPS_RUN_SAFETY_CAP_FACTOR; else process.env.FINOPS_RUN_SAFETY_CAP_FACTOR = prev;
    }
  });

  await check('S5 política: 34.66 / 191.45 con maxCostPerRun 150 → AUTO_WITHIN_POLICY (firma del usuario)', () => {
    const E = ownerEstimate();
    const r = F.decideRunBudget({ estimate: E, policy: policy(CAPS), spentSoFar: { course: '0' }, paidRealProviders: ['gamma', 'openai'] });
    eq([r.decision, r.userAuthorizationRequired], ['AUTO_WITHIN_POLICY', true], `decisión (${r.reasons.join('|')})`);
    // Antes (máximo p90 contra el límite): la misma política pedía admin.
    const legacy = F.evaluateBudget({ estimate: E, policy: policy(CAPS), realSpend: true });
    eq(legacy.decision, 'ADMIN_APPROVAL', 'evaluateBudget crudo (max legado) = el comportamiento anterior');
    assert(legacy.reasons.some((x) => /maxCostPerRun:max_over_limit\(max=191\.45/.test(x)), legacy.reasons.join('|'));
    eq(E.totals.max, '191.4500000000', 'el estimado no se modifica (max legado presente)');
  });

  await check('S6 monto autorizado = tope de seguridad (acotado por el remanente)', () => {
    const E = ownerEstimate();
    const p = F.planNormalApproval({ estimate: E, policy: policy(CAPS), courseSpent: '0', monthSpent: '0', ownerMonthSpent: '0' });
    eq([p.withinPolicy, n2(p.amount), p.cappedByLimit], [true, '51.99', null], 'monto = tope');
    eq(n2(F.safetyCapOfEstimate(E)), '51.99', 'safetyCapOfEstimate (= lo que autoriza finopsBindRun en AUTO)');
    const capped = F.planNormalApproval({ estimate: E, policy: policy({ ...CAPS, maxCostPerCourse: '80' }), courseSpent: '40', monthSpent: '0', ownerMonthSpent: '0' });
    eq([capped.withinPolicy, n2(capped.amount), capped.cappedByLimit], [true, '40.00', 'maxCostPerCourse'], 'remanente menor que el tope');
    eq(E.totals.max, '191.4500000000', 'max legado intacto');
  });

  await check('S7 el esperado sobre el límite sigue bloqueando / pidiendo admin', () => {
    const E = ownerEstimate();
    eq(F.decideRunBudget({ estimate: E, policy: policy({ ...CAPS, maxCostPerRun: '30' }), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'esperado > límite (on_exceed ADMIN)');
    eq(F.decideRunBudget({ estimate: E, policy: policy({ ...CAPS, maxCostPerRun: '30' }, 'BLOCK'), paidRealProviders: ['gamma'] }).decision, 'BLOCK', 'on_exceed BLOCK');
    // banda: esperado ≤ límite < tope → admin
    eq(F.decideRunBudget({ estimate: E, policy: policy({ ...CAPS, maxCostPerRun: '45' }), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'banda esperado..tope');
    const pl = F.planNormalApproval({ estimate: E, policy: policy({ ...CAPS, maxCostPerRun: '30' }), courseSpent: '0', monthSpent: '0', ownerMonthSpent: '0' });
    eq([pl.withinPolicy, pl.blockedBy[0].limit], [false, 'maxCostPerRun'], 'plan bloqueado');
  });

  await check('S8 límites por proveedor / tipo siguen contra el máximo p90 (review P2-1: garantía)', () => {
    const E = ownerEstimate(); // gamma: esperado 9, p90 45
    eq(F.decideRunBudget({ estimate: E, policy: policy({ ...CAPS, maxCostPerProvider: { gamma: '45' } }), paidRealProviders: ['gamma'] }).decision, 'AUTO_WITHIN_POLICY', 'gamma 45 ≥ p90 45');
    eq(F.decideRunBudget({ estimate: E, policy: policy({ ...CAPS, maxCostPerProvider: { gamma: '14' } }), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'gamma 14: esperado entra, p90 no → admin (no se relaja con el tope)');
    const pl = F.planNormalApproval({ estimate: E, policy: policy({ ...CAPS, maxCostPerProvider: { gamma: '14' } }), courseSpent: '0', monthSpent: '0', ownerMonthSpent: '0' });
    eq([pl.withinPolicy, pl.blockedBy[0].over], [false, 'max'], 'plan: el máximo del proveedor no entra');
  });

  await check('S9 estimateSummary / estimateCategories: safetyCap + capFactor, max conservado', () => {
    const e = F.estimateCost(base);
    const s = F.estimateSummary(e);
    eq([s.safetyCap, s.capFactor, s.max], [e.totals.safetyCap, 1.5, e.totals.max], 'summary');
    const cats = F.estimateCategories(s.byProvider, s.capFactor);
    for (const c of Object.keys(cats)) eq(cats[c].safetyCap, F.safetyCapOf(cats[c].expected, 1.5), `categoría ${c}`);
    assert(cats.content.max && Number(cats.content.max) > 0, 'max por categoría presente');
    const legacy = F.estimateCategories(s.byProvider);
    assert(!('safetyCap' in legacy.content), 'sin factor: la forma de siempre');
  });

  await check('S10 al alcanzar el autorizado (= tope) el guard decide run_budget_cap (→ pauseRunBySystem)', () => {
    const cap = Number(F.safetyCapOf('34.66', 1.5));
    const ok = F.decideRunSpend({ authorizedBudget: cap, runSpent: 40, nextCost: 1, itemSpent: null, itemExpected: null, itemEstimatedMax: null, runExpected: null, progressExpected: null });
    eq(ok.allow, true, 'dentro del tope');
    const stop = F.decideRunSpend({ authorizedBudget: cap, runSpent: 51.5, nextCost: 1, itemSpent: null, itemExpected: null, itemEstimatedMax: null, runExpected: null, progressExpected: null });
    eq([stop.allow, stop.reason], [false, 'run_budget_cap'], 'sobre el tope');
  });

  await check('S11 estimado viejo sin safetyCap: la vista usa esperado × 1,5', () => {
    const E = ownerEstimate(false);
    eq(n2(F.safetyCapOfEstimate(E)), '51.99', 'fallback');
    eq(F.decideRunBudget({ estimate: E, policy: policy(CAPS), paidRealProviders: ['gamma'] }).decision, 'AUTO_WITHIN_POLICY', 'decisión');
    const v = F.policyEstimateView(E);
    eq([n2(v.totals.max), n2(v.totals.byProvider.gamma.max), E.totals.max], ['51.99', '45.00', '191.4500000000'], 'vista: solo el total usa el tope; proveedores p90; original intacto');
  });

  await check('S12 aviso al arrancar con FINOPS_RUN_SAFETY_CAP_FACTOR inválido / fuera de rango (review P2-4)', () => {
    for (const raw of ['1.0', '1,5', '4', '1.1234567', 'abc']) assert(F.safetyCapFactorWarning({ FINOPS_RUN_SAFETY_CAP_FACTOR: raw }), `avisa ${raw}`);
    for (const raw of [undefined, '', '1.5', '2', '1.1', '3']) eq(F.safetyCapFactorWarning(raw === undefined ? {} : { FINOPS_RUN_SAFETY_CAP_FACTOR: raw }), null, `no avisa ${raw}`);
  });

  await check('S13 estimado incremental (regeneración) lleva el factor del estimado de origen (review P2-4)', () => {
    const e = F.estimateCost({ ...base, safetyCapFactor: 2 });
    const r = F.incrementalCostForPlan(items.map((it) => ({ itemKey: it.itemKey, action: 'REGENERATE' })), e.lines, {}, e.totals.capFactor);
    eq([r.totals.incremental.capFactor, r.totals.incremental.safetyCap], [2, F.safetyCapOf(r.totals.incremental.expected, 2)], 'factor 2');
    eq(F.incrementalCostForPlan([], e.lines, {}).totals.incremental.capFactor, 1.5, 'sin factor → 1,5');
  });

  await check('S14 guardPaidSubmission: tope alcanzado con autorización → PAUSA el run (run_budget_cap, requiredUsd = comprometido) y devuelve run_paused; sin autorización → bloquea como siempre (review P1-1)', async () => {
    const mk = (authorized) => {
      const svc = new FinopsBudgetService({ query: async () => [{ worker_status: 'running' }] }, null);
      const st = { pauses: [], singleAt: [] };
      svc.runPaidAuthorizedBudget = async () => authorized;
      svc.runActual = async () => '51.8';
      svc.reservedInFlight = async () => '0';
      svc.singleCallCost = async (_t, _p, _r, at) => { st.singleAt.push(at || 'max'); return '1.0000000000'; };
      svc.guardRunSpend = async () => ({ decision: { allow: true, reason: 'ok' } });
      svc.pauseRunBySystem = async (...args) => { st.pauses.push(args); return true; };
      return { svc, st };
    };
    const { svc, st } = mk('52.31');
    const g = await svc.guardPaidSubmission({ runId: 'run-1', itemRunId: 'ir-1', itemType: 'presentation' });
    eq([g.allow, g.reason], [false, F.RUN_PAUSED_GUARD_REASON || 'run_paused'], 'run_paused (el worker devuelve la parte)');
    eq(st.pauses.length, 1, 'una pausa');
    eq([st.pauses[0][0], st.pauses[0][1], n2(st.pauses[0][3])], ['run-1', 'run_budget_cap', '52.80'], 'pausa run_budget_cap con requiredUsd = comprometido');
    eq(st.singleAt, ['max'], '`next` sigue acotado por su p90');
    const ok = mk('60');
    eq((await ok.svc.guardPaidSubmission({ runId: 'run-1', itemRunId: 'ir-1', itemType: 'presentation' })).allow, true, 'dentro del tope');
    const none = mk(null);
    const gn = await none.svc.guardPaidSubmission({ runId: 'run-1', itemRunId: 'ir-1', itemType: 'presentation' });
    eq([gn.allow, gn.reason, none.st.pauses.length], [false, 'no_authorization', 0], 'sin autorización: bloquea, sin pausa');
  });

  await check('S15 reservas en vuelo de partes pagadas sin reserva: costo esperado de una llamada (p50), no p90', async () => {
    const svc = new FinopsBudgetService(null, null);
    const at = [];
    svc.singleCallCost = async (_t, _p, _r, a) => { at.push(a || 'max'); return a === 'expected' ? '0.6000000000' : '1.0000000000'; };
    const runner = { query: async () => [{ id: 'a', type: 'presentation' }, { id: 'b', type: 'presentation' }] };
    eq(n2(await svc.reservedInFlight('run-1', null, runner)), '1.20', 'dos partes × esperado');
    eq(at, ['expected'], 'esperado (cacheado por tipo)');
    svc.catalog = async () => seed.catalog;
    delete svc.singleCallCost;
    const pE = Number(await svc.singleCallCost('presentation', 'gamma', undefined, 'expected'));
    const pM = Number(await svc.singleCallCost('presentation', 'gamma'));
    assert(pE > 0 && pE <= pM, `p50 ${pE} ≤ p90 ${pM}`);
  });

  eq(netAttempts.length, 0, 'red');
  console.log(`\n${passes} OK · ${failures} fallas · red: ${netAttempts.length} intentos`);
  process.exit(failures ? 1 : 0);
})();
