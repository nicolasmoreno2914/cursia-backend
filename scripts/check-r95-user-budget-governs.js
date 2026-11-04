#!/usr/bin/env node
/* eslint-disable */
// r95 (decisión del owner, 2026-11-03) — EL PRESUPUESTO ASIGNADO DEL USUARIO MANDA.
// Si quien paga tiene presupuesto asignado (r75, shadow/enforce) y el monto autorizado cabe en su disponible, la decisión
// es «Autorizar y generar» (el usuario), aunque supere los topes globales maxCostPerRun / maxCostPerCourse /
// ownerMonthlyCap. Sin presupuesto asignado, todo como antes. monthlyCap (techo de la plataforma), topes por proveedor,
// on_exceed y el pedido explícito de admin siguen mandando.
//
// Parte pura: governRunBudget / userBudgetGovernedPolicy. Parte DB (PG16 desechable, servicios reales de dist/): preview y
// approve-and-start de un usuario con y sin presupuesto, revalidación en la tx del run y techo de la plataforma.
//
// Usage: npm run build && node scripts/check-r95-user-budget-governs.js [--pure-only]
const path = require('path');
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { setupR95Db, NCTX, L } = require('./lib/r95-db');

const PURE_ONLY = process.argv.includes('--pure-only');
const F = L('modules/finops/index.js');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const dec = (v) => (v === null || v === undefined ? v : Number(v));
async function rejects(p, re, msg, status) {
  try { await p; } catch (err) {
    const body = err && err.getResponse ? err.getResponse() : null;
    const text = `${err && err.message} ${body ? JSON.stringify(body) : ''}`;
    assert(re.test(text), `${msg}: error inesperado ${text.slice(0, 400)}`);
    if (status) eq(err.getStatus && err.getStatus(), status, `${msg} (status)`);
    return err;
  }
  throw new Error(`${msg}: no rechazó`);
}

const est = (expected, max, byProvider) => ({ totals: { min: String(expected / 2), expected: String(expected), max: String(max), byProvider: byProvider || { gamma: { min: '0', expected: String(expected), max: String(max) } }, byItemType: {} } });
const GLOBAL = { maxCostPerRun: '150', maxCostPerCourse: '500', monthlyCap: '10000', ownerMonthlyCap: '1000' };
const pol = (limits, extra) => ({ id: 'p1', version: 1, limits, onExceed: 'ADMIN_APPROVAL', ...(extra || {}) });
const ub = (available, mode = 'enforce', assigned = true) => ({ mode, assigned, available: String(available) });
const gov = (o) => F.governRunBudget({ estimate: o.estimate, policy: o.policy === undefined ? pol(GLOBAL) : o.policy, spentSoFar: o.spent || { course: '0', byProvider: {} },
  monthSpent: o.month ?? '0', ownerMonthSpent: o.ownerMonth ?? '0', paidRealProviders: o.paid || ['gamma'], userBudget: o.ub === undefined ? ub(300) : o.ub });

async function pureChecks() {
  await check('PURA incidente Yeremy: presupuesto asignado USD 300, esperado 170 > maxCostPerRun 150 → autoriza el usuario (AUTO + firma), monto = máximo (cabe en 300), motivo user_budget_governs', async () => {
    const base = F.decideRunBudget({ estimate: est(170, 255), policy: pol(GLOBAL), spentSoFar: { course: '0' }, paidRealProviders: ['gamma'] });
    eq(base.decision, 'ADMIN_APPROVAL', 'sin la regla: admin (como hoy)');
    const g = gov({ estimate: est(170, 255) });
    eq([g.applies, g.decision.decision, g.decision.userAuthorizationRequired, g.decision.reasons.includes(F.USER_BUDGET_GOVERNS_REASON)], [true, 'AUTO_WITHIN_POLICY', true, true], 'gobernada');
    eq([dec(g.plan.amount), dec(g.signedPlan.amount), g.plan.withinPolicy], [255, 255, true], 'monto = máximo');
    eq([dec(g.policy.limits.maxCostPerRun), dec(g.policy.limits.maxCostPerCourse), dec(g.policy.limits.ownerMonthlyCap), dec(g.policy.limits.monthlyCap)], [300, 300, 300, 10000], 'topes sustituidos por el disponible; monthlyCap intacto');
    eq([g.policy.id, g.policy.version], ['p1', 1], 'misma política (huella estable)');
  });
  await check('PURA el monto a autorizar (máximo del estimado) tiene que caber en el disponible: esperado 170, máximo 400, disponible 300 → no aplica (admin); con disponible 400 → aplica por 400', async () => {
    const g = gov({ estimate: est(170, 400) });
    eq([g.applies, g.why], [false, 'still_requires_admin'], 'máximo > disponible: no se firma por encima de lo disponible');
    const g2 = gov({ estimate: est(170, 400), ub: ub(400) });
    eq([g2.applies, dec(g2.plan.amount)], [true, 400], 'cabe justo');
  });
  await check('PURA no cabe en el disponible (esperado 170 > disponible 100) → no aplica (queda en admin / «Solicitar autorización»)', async () => {
    const g = gov({ estimate: est(170, 255), ub: ub(100) });
    eq([g.applies, g.why], [false, 'still_requires_admin'], 'no gobierna');
  });
  await check('PURA sin presupuesto asignado o con presupuestos apagados → topes globales como siempre', async () => {
    eq(gov({ estimate: est(170, 255), ub: ub(300, 'enforce', false) }).why, 'no_assigned_budget', 'sin asignar');
    eq(gov({ estimate: est(170, 255), ub: ub(300, 'off') }).why, 'budgets_off', 'off');
    eq(gov({ estimate: est(170, 255), ub: null }).why, 'budgets_off', 'sin gate');
  });
  await check('PURA modo shadow también gobierna (el monto autorizado ya es el tope del run: el runtime guard lo hace cumplir)', async () => {
    eq(gov({ estimate: est(170, 255), ub: ub(300, 'shadow') }).applies, true, 'shadow');
  });
  await check('PURA techo de la plataforma: monthlyCap sigue mandando (mes comprometido 9.900 + 170 > 10.000 → no aplica)', async () => {
    const g = gov({ estimate: est(170, 255), month: '9900' });
    eq([g.applies, g.why], [false, 'outside_platform_ceiling'], 'monthlyCap');
    const g2 = gov({ estimate: est(170, 255), month: '9800' });
    eq([g2.applies, dec(g2.plan.amount)], [true, 200], 'remanente del mes acota el monto (10.000 − 9.800)');
  });
  await check('PURA sin monthlyCap en la política → no aplica (la firma única exige el techo de la plataforma)', async () => {
    const { monthlyCap, ...noMonthly } = GLOBAL;
    eq(gov({ estimate: est(170, 255), policy: pol(noMonthly) }).why, 'still_requires_admin', 'sin techo');
  });
  await check('PURA pedido explícito de admin (requireHumanApprovalForRealSpend) y topes por proveedor siguen mandando', async () => {
    eq(gov({ estimate: est(170, 255), policy: pol(GLOBAL, { requireHumanApprovalForRealSpend: true }) }).why, 'still_requires_admin', 'flag explícito');
    eq(gov({ estimate: est(170, 255), policy: pol({ ...GLOBAL, maxCostPerProvider: { gamma: '100' } }) }).why, 'still_requires_admin', 'tope de proveedor');
  });
  await check('PURA ya dentro de la política (esperado 40 ≤ 150) → no se toca nada (ni el monto)', async () => {
    eq(gov({ estimate: est(40, 60) }).why, 'already_user_authorization', 'ya era del usuario');
  });
  await check('PURA sin proveedores pagados / sin política → no aplica', async () => {
    eq(gov({ estimate: est(170, 255), paid: [] }).why, 'no_paid_provider', 'solo LLM');
    eq(gov({ estimate: est(170, 255), policy: null }).why, 'no_budget_policy', 'sin política');
  });
  await check('PURA tope por curso: gasto previo 450 del curso + 170 > 500 → con presupuesto gobierna (el disponible reemplaza al tope por curso)', async () => {
    const g = gov({ estimate: est(170, 255), spent: { course: '450', byProvider: {} } });
    eq([g.applies, dec(g.policy.limits.maxCostPerCourse), dec(g.plan.amount)], [true, 750, 255], 'tope por curso = gasto + disponible');
  });
}

async function dbChecks() {
  const U = { yes: '22222222-3333-4444-8555-666666666601', no: '22222222-3333-4444-8555-666666666602', low: '22222222-3333-4444-8555-666666666603', shadow: '22222222-3333-4444-8555-666666666604' };
  const H = await setupR95Db('r95-ubg');
  const { ds, runs } = H;
  const user = (id) => ({ id, email: `${id.slice(-4)}@cliente.test` });
  const authRows = (cid) => ds.query(`select run_id, decision, approved_by, reason, authorized_budget::text as b from public.cost_budget_authorizations where course_id = $1 order by created_at, (run_id is not null), id`, [cid]);
  const runCount = async (cid) => Number((await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [cid]))[0].n);
  try {
    // Política global como la de producción: tope por generación chico (para que el estimado lo supere).
    const TIGHT = { maxCostPerRun: '0.0001', maxCostPerCourse: '0.0002', monthlyCap: '100000', ownerMonthlyCap: '0.0003' };

    await check('DB usuario SIN presupuesto asignado (enforce): esperado > maxCostPerRun → sigue pidiendo admin (approval_forbidden), nada creado', async () => {
      const C = await H.makeCourse(U.no, 'Sin presupuesto', 'no@cliente.test');
      await H.coursePolicy(C.cid, TIGHT);
      const pv = await runs.previewStart(C.cid, user(U.no), 1, NCTX);
      eq([pv.decision, pv.approval.mode, pv.approval.governedBy], ['ADMIN_APPROVAL', 'admin', 'policy'], 'admin');
      await rejects(runs.approveAndStart(C.cid, user(U.no), 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      eq(await runCount(C.cid), 0, 'sin run');
    });

    let yes = null;
    await check('DB usuario CON presupuesto USD 50 (enforce): mismo estimado > topes globales → mode user, governedBy user_budget, monto ≤ disponible', async () => {
      await H.setBudget(U.yes, '50');
      yes = await H.makeCourse(U.yes, 'Con presupuesto', 'yes@cliente.test');
      await H.coursePolicy(yes.cid, TIGHT);
      const pv = await runs.previewStart(yes.cid, user(U.yes), 1, NCTX);
      eq([pv.decision, pv.approval.mode, pv.approval.userAuthorizationRequired, pv.approval.required, pv.approval.withinPolicy, pv.approval.governedBy],
        ['AUTO_WITHIN_POLICY', 'user', true, false, true, 'user_budget'], 'decisión');
      assert(pv.reasons.includes('user_budget_governs'), 'motivo');
      assert(Number(pv.estimate.expected) > 0.0001, 'el estimado supera el tope global');
      assert(Number(pv.approval.amount) <= 50 && Number(pv.approval.amount) >= Number(pv.estimate.expected), `monto ${pv.approval.amount}`);
      eq(dec(pv.approval.amount), dec(pv.estimate.max), 'monto = máximo (cabe en 50)');
      eq([pv.userBudget.sufficient, dec(pv.userBudget.requiredUsd)], [true, dec(pv.approval.amount)], 'userBudget');
      yes.pv = pv;
    });

    await check('DB «Autorizar y generar» del usuario con presupuesto → run creado con su firma (AUTO_WITHIN_POLICY firmada + vinculada), sin admin; reserva a su nombre', async () => {
      const res = await runs.approveAndStart(yes.cid, user(U.yes), 1, NCTX, yes.pv.estimateHash);
      eq([res.created, dec(res.approval.amount)], [true, dec(yes.pv.approval.amount)], 'creado');
      const rows = await authRows(yes.cid);
      eq(rows.map((x) => [x.decision, x.run_id === null]), [['AUTO_WITHIN_POLICY', true], ['AUTO_WITHIN_POLICY', false]], 'filas');
      assert(/^user_authorized_within_policy:/.test(rows[0].reason), rows[0].reason);
      eq(rows.filter((x) => x.decision === 'ADMIN_APPROVED').length, 0, 'sin admin');
      eq(dec(await H.budget.runPaidAuthorizedBudget(res.run.id)), dec(yes.pv.approval.amount), 'cubre proveedores pagados');
      const [rsv] = await ds.query(`select user_id::text as u, amount_usd::text as a from public.budget_reservations where run_id = $1 and kind = 'start'`, [res.run.id]);
      eq([rsv && rsv.u, rsv && dec(rsv.a)], [U.yes, dec(yes.pv.approval.amount)], 'reserva del usuario');
    });

    await check('DB presupuesto que no alcanza (USD 0,0001 < esperado) → admin como antes; approval_forbidden deja el estimado para la bandeja', async () => {
      await H.setBudget(U.low, '0.0001');
      const C = await H.makeCourse(U.low, 'Presupuesto chico', 'low@cliente.test');
      await H.coursePolicy(C.cid, TIGHT);
      const pv = await runs.previewStart(C.cid, user(U.low), 1, NCTX);
      eq([pv.approval.mode, pv.approval.governedBy], ['admin', 'policy'], 'admin');
      const err = await rejects(runs.approveAndStart(C.cid, user(U.low), 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      const body = err.getResponse();
      assert(/^[0-9a-f-]{36}$/.test(String(body.estimateId)), 'estimateId en el 403');
      const [e] = await ds.query(`select created_by, course_id from public.cost_estimates where id = $1`, [body.estimateId]);
      eq([e.created_by, e.course_id], ['runs.service:approval_forbidden', C.cid], 'estimado registrado');
    });

    await check('DB techo de la plataforma: con presupuesto pero monthlyCap agotado → no gobierna (admin, bloqueado por monthlyCap)', async () => {
      const U4 = '22222222-3333-4444-8555-666666666605';
      await H.setBudget(U4, '50');
      const C = await H.makeCourse(U4, 'Techo', 'u4@cliente.test');
      await H.coursePolicy(C.cid, { ...TIGHT, monthlyCap: '0.0001' });
      const pv = await runs.previewStart(C.cid, user(U4), 1, NCTX);
      eq([pv.approval.mode, pv.approval.governedBy, pv.approval.withinPolicy], ['admin', 'policy', false], 'techo');
      assert(pv.approval.blockedBy.some((b) => b.limit === 'monthlyCap'), JSON.stringify(pv.approval.blockedBy));
    });

    await check('DB revalidación: el presupuesto baja entre la vista previa y el clic → 409 estimate_stale, sin run (nunca se firma por encima del disponible)', async () => {
      const U5 = '22222222-3333-4444-8555-666666666606';
      await H.setBudget(U5, '50');
      const C = await H.makeCourse(U5, 'Baja el presupuesto', 'u5@cliente.test');
      await H.coursePolicy(C.cid, TIGHT);
      const pv = await runs.previewStart(C.cid, user(U5), 1, NCTX);
      eq(pv.approval.governedBy, 'user_budget', 'gobernada');
      await H.setBudget(U5, '0.0001');
      await rejects(runs.approveAndStart(C.cid, user(U5), 1, NCTX, pv.estimateHash), /estimate_stale|approval_forbidden/, 'cambió', null);
      eq(await runCount(C.cid), 0, 'sin run');
    });

    await check('DB modo shadow: con presupuesto asignado también decide el usuario', async () => {
      process.env.CURSIA_USER_BUDGETS = 'shadow';
      try {
        await H.setBudget(U.shadow, '50');
        const C = await H.makeCourse(U.shadow, 'Shadow', 'sh@cliente.test');
        await H.coursePolicy(C.cid, TIGHT);
        const pv = await runs.previewStart(C.cid, user(U.shadow), 1, NCTX);
        eq([pv.approval.mode, pv.approval.governedBy], ['user', 'user_budget'], 'shadow gobierna');
        const res = await runs.approveAndStart(C.cid, user(U.shadow), 1, NCTX, pv.estimateHash);
        eq(res.created, true, 'run creado');
      } finally { process.env.CURSIA_USER_BUDGETS = 'enforce'; }
    });

    await check('DB modo off: el presupuesto no se lee y los topes globales mandan (como antes de r95)', async () => {
      process.env.CURSIA_USER_BUDGETS = 'off';
      try {
        const U6 = '22222222-3333-4444-8555-666666666607';
        await H.setBudget(U6, '50');
        const C = await H.makeCourse(U6, 'Off', 'u6@cliente.test');
        await H.coursePolicy(C.cid, TIGHT);
        const pv = await runs.previewStart(C.cid, user(U6), 1, NCTX);
        eq([pv.approval.mode, pv.approval.governedBy], ['admin', 'policy'], 'off');
      } finally { process.env.CURSIA_USER_BUDGETS = 'enforce'; }
    });

    await check('DB startRun directo (sin firma) con presupuesto → 409 user_authorization_required (no budget_approval_required)', async () => {
      const U7 = '22222222-3333-4444-8555-666666666608';
      await H.setBudget(U7, '50');
      const C = await H.makeCourse(U7, 'Sin firma', 'u7@cliente.test');
      await H.coursePolicy(C.cid, TIGHT);
      await rejects(runs.startRun(C.cid, U7, 1, NCTX, { startedBy: U7 }), /user_authorization_required/, 'firma', 409);
      const [e] = await ds.query(`select created_by from public.cost_estimates where course_id = $1 order by created_at desc limit 1`, [C.cid]);
      eq(e.created_by, 'runs.service:user_authorization_required', 'estimado etiquetado');
    });
  } finally {
    await H.close();
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('❌ Error inesperado:', err && err.stack ? err.stack : err); process.exit(1); });
