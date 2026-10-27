// r78-ready · SuperAdmin + presupuesto: ¿el owner (SuperAdmin por SUPER_ADMIN_EMAILS + SUPER_ADMIN_USER_IDS, canario V2) puede
// arrancar una generación autorizada con CURSIA_USER_BUDGETS = off | shadow | enforce y presupuesto por defecto USD 0?
// PG descartable CON las migraciones r75 aplicadas (escenario «el owner aprueba r75 en Orbia»). Cuentas sintéticas locales,
// sin proveedores reales (USD 0). También: SUPER_ADMIN_USER_IDS mal configurado bloquea al owner.
'use strict';
const path = require('path');
const env = require(process.env.REPO + '/test/r75/lib/env');
const { startFakeSupabase } = require(process.env.REPO + '/test/r75/lib/fake-supabase');
const { keepTeacherDesign } = require(path.join(process.env.REPO, 'test', 'e2e-v2', 'design-approval.js'));
const crypto = require('crypto');
let ok = 0, fail = 0;
const rows = [];
const check = (name, cond, detail) => { if (cond) { ok++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + ' → ' + detail); } };
const brief = (r) => `${r.status} ${r.code || ''} ${String(r.error || '').slice(0, 200)}`;
const SA = { id: crypto.randomUUID(), email: 'qa-r78-sa@x.test' };
const D = { nombre: 'r78 SA', sector: 'Educación', pais: 'Colombia', ciudad: 'Bogotá', contexto: 'Estudiantes', nivel: 'Básico', tono: 'cercano', obj: 'Aprender', comp: 'Comprende', videoMode: 'mock' };
async function buildCourse(A, title) {
  const dc = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
  if (dc.status !== 201) throw new Error('POST /courses/dynamic ' + brief(dc));
  const cid = Number(dc.data.id);
  let st = (await A('GET', `/courses/${cid}/modules`)).data;
  if (!st.modules.length) await A('POST', `/courses/${cid}/modules`, { title: 'Módulo', objective: 'Objetivo', examEnabled: false, expectedCounter: st.structureVersionCounter });
  await keepTeacherDesign(async (mt, p, b) => { const r = await A(mt, p, b); return { status: r.status, data: r.data, error: r.error }; }, cid, title);
  st = (await A('GET', `/courses/${cid}/modules`)).data;
  const lock = await A('POST', `/courses/${cid}/blueprints`, { expectedCounter: st.structureVersionCounter });
  const n = lock.data.blueprint.blueprintNumber;
  await A('POST', `/courses/${cid}/blueprints/${n}/manifest`);
  return { id: cid, n, base: `/courses/${cid}/blueprints/${n}/manifest/runs` };
}
(async () => {
  await env.dbConnect();
  check('migraciones r75 presentes (user_budgets, budget_reservations)', (await env.tableExists('user_budgets')) && (await env.tableExists('budget_reservations')), '');
  await env.q(`insert into public.authorized_users (email, is_admin) values ($1, true)`, [SA.email]).catch(() => {});
  const fakes = await startFakeSupabase({ serviceKey: env.SERVICE_KEY });
  const T = env.tokenFor(SA);
  const A = (m, p, b) => env.api(m, p, { token: T, body: b });
  const common = { SUPER_ADMIN_EMAILS: SA.email, SUPER_ADMIN_USER_IDS: SA.id, DYNAMIC_V2_ALLOWED_OWNERS: SA.id, DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true',
    CURSIA_ACCOUNT_GUARD: 'off', CURSIA_RBAC_MODE: 'off' };
  // SUPER_ADMIN_USER_IDS con OTRO uuid → el owner (email de admin) queda fuera.
  await env.startApp(fakes, Object.assign({}, common, { SUPER_ADMIN_USER_IDS: crypto.randomUUID(), CURSIA_USER_BUDGETS: 'off' }), 'app-pin-wrong');
  const fw = await A('GET', '/courses');
  check('SUPER_ADMIN_USER_IDS sin el uuid del owner → el owner queda BLOQUEADO (403 admin_email_unverified): fijar EXACTO', fw.status === 403, brief(fw));
  await env.stopApp();
  for (const mode of ['off', 'shadow', 'enforce']) {
    await env.startApp(fakes, Object.assign({}, common, { CURSIA_USER_BUDGETS: mode }), 'app-' + mode);
    const me = await A('GET', '/me/context');
    const c = await buildCourse(A, 'SA ' + mode);
    const pv = await A('POST', `${c.base}/estimate-preview`, D);
    const ub = pv.data && pv.data.userBudget;
    const st = await A('POST', c.base, D);
    const res = await env.q(`select count(*)::int n from public.budget_reservations`);
    rows.push({ mode, superAdmin: me.data && me.data.superAdmin, preview: pv.status, required: ub && ub.requiredUsd, available: ub && ub.availableUsd, start: st.status, code: st.code || null, reservations: res[0].n });
    if (mode === 'enforce') {
      check(`enforce + USD 0: el SuperAdmin NO arranca (409 user_budget_not_assigned, D-18)`, st.status === 409 && /user_budget_not_assigned|user_budget_insufficient/.test(st.code || ''), brief(st));
      const month = new Date().toISOString().slice(0, 7);
      // Disponible = presupuesto − gasto del mes − lo retenido por runs vivos (también los arrancados en off/shadow).
      const amt = String(Math.ceil(Number((ub && ub.requiredUsd) || 1) - Number((ub && ub.availableUsd) || 0) + 1));
      const pb = await A('PUT', `/admin/users/${SA.id}/budget`, { monthlyAmountUsd: amt + '.00', effectiveMonth: month, reason: 'QA r78: presupuesto del owner antes de enforce' });
      check('el SuperAdmin se asigna presupuesto mensual (PUT /admin/users/:id/budget) 200', pb.status === 200 || pb.status === 201, brief(pb));
      const st2 = await A('POST', c.base, D);
      check('enforce con presupuesto ≥ requerido: el SuperAdmin arranca (201) y queda una reserva start', (st2.status === 201 || st2.status === 200), brief(st2));
      const r2 = await env.q(`select count(*)::int n from public.budget_reservations where kind = 'start'`);
      rows.push({ mode: 'enforce+budget', budgetUsd: amt, start: st2.status, reservations: r2[0].n });
      // Mes siguiente: la versión recurring sigue vigente (no se resetea a 0).
      const nm = await env.q(`select count(*)::int n from public.user_budgets where user_id = $1::uuid and kind = 'recurring'`, [SA.id]);
      check('presupuesto recurring persistido (aplica a meses siguientes)', nm[0].n >= 1, JSON.stringify(nm));
    } else {
      check(`${mode} + USD 0: el SuperAdmin arranca (201/200)`, st.status === 201 || st.status === 200, brief(st));
    }
    await env.stopApp();
  }
  console.log('\nTabla:'); for (const r of rows) console.log('   ' + JSON.stringify(r));
  console.log(`\n${ok} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
