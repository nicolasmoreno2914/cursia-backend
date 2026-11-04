#!/usr/bin/env node
/* eslint-disable */
// r95 · Bloque Admin — endpoints de SuperAdmin sobre cursos de OTROS usuarios (sin migraciones):
//   GET  /admin/dynamic-runs/pending-approvals          «Generaciones que esperan aprobación»
//   GET  /admin/dynamic-runs/courses/:courseId/latest   última generación V2 + partes no completadas (solo lectura)
//   POST /admin/dynamic-runs/:runId/items/:itemKey/retry reintento SIMPLE (nunca resubmitVideo/resubmitProvider)
// Permisos: la clase lleva SupabaseJwtGuard + SuperAdminGuard (+ @SuperAdminOnly): un no SuperAdmin → 403.
// Auditoría: course.admin_view_run, finops.pending_approvals_view, course.admin_retry_item (admin_audit_log).
// Aprobación: con el endpoint EXISTENTE POST /finops/courses/:courseId/authorizations {estimateId, authorizedBudget}.
//
// Usage: npm run build && node scripts/check-r95-admin-approvals.js
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { setupR95Db, NCTX, MOCK_CTX, L, SA_EMAIL } = require('./lib/r95-db');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
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

(async () => {
  const { AdminDynamicRunsController } = L('modules/dynamic-generation/admin-runs.controller.js');
  const { SuperAdminGuard } = L('auth/super-admin.guard.js');
  const { SupabaseJwtGuard } = L('auth/supabase-jwt.guard.js');

  await check('PERMISOS: AdminDynamicRunsController lleva SupabaseJwtGuard + SuperAdminGuard; las 3 rutas nuevas existen y un no SuperAdmin recibe 403 (el SuperAdmin pasa)', async () => {
    const guards = Reflect.getMetadata('__guards__', AdminDynamicRunsController) || [];
    assert(guards.includes(SupabaseJwtGuard) && guards.includes(SuperAdminGuard), 'guards de la clase');
    const P = AdminDynamicRunsController.prototype;
    eq([Reflect.getMetadata('path', P.pendingApprovals), Reflect.getMetadata('path', P.courseLatest), Reflect.getMetadata('path', P.retryItem)],
      ['pending-approvals', 'courses/:courseId/latest', ':runId/items/:itemKey/retry'], 'rutas');
    eq([Reflect.getMetadata('method', P.pendingApprovals), Reflect.getMetadata('method', P.courseLatest), Reflect.getMetadata('method', P.retryItem)], [0, 0, 1], 'GET, GET, POST');
    const prev = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = SA_EMAIL;
    try {
      const ctx = (user) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) });
      const g = new SuperAdminGuard();
      for (const u of [{ id: 'x', email: 'docente@cliente.test' }, { id: 'y' }, undefined]) {
        let status = null;
        try { g.canActivate(ctx(u)); } catch (err) { status = err.getStatus(); }
        eq(status, 403, `no SA (${u && u.email}) → 403`);
      }
      eq(g.canActivate(ctx({ id: 'z', email: SA_EMAIL })), true, 'SA pasa');
    } finally { if (prev === undefined) delete process.env.SUPER_ADMIN_EMAILS; else process.env.SUPER_ADMIN_EMAILS = prev; }
  });

  const H = await setupR95Db('r95-adm');
  const { ds, runs, courseOps, finopsAdmin } = H;
  const ctrl = new AdminDynamicRunsController({}, {}, {}, {}, courseOps);
  const SA_USER = { id: H.saActor.id, email: SA_EMAIL };
  const OWNER = '33333333-4444-4555-8666-777777777701';
  const OWNER2 = '33333333-4444-4555-8666-777777777702';
  const owner = { id: OWNER, email: 'yeremy@cliente.test' };
  // Como staging: presupuestos en shadow (sin presupuesto asignado el arranque no se bloquea; la regla r95 no aplica).
  process.env.CURSIA_USER_BUDGETS = 'shadow';
  const auditOf = (action) => ds.query(`select actor_id::text as a, action, target_type, target_id, after from public.admin_audit_log where action = $1 order by id`, [action]);
  try {
    // Política global sin presupuesto asignado → admin (curso de otro usuario que espera aprobación).
    const C = await H.makeCourse(OWNER, 'Curso de Yeremy', 'yeremy@cliente.test');
    await H.coursePolicy(C.cid, { maxCostPerRun: '0.0001', maxCostPerCourse: '0.0002', monthlyCap: '100000', ownerMonthlyCap: '0.0003' });
    let pending = null;
    await check('BANDEJA: el dueño (no admin) pide «Autorizar y generar» → 403 approval_forbidden; el curso aparece en pending-approvals con curso, correo del dueño, esperado, máximo, estimateId y fecha', async () => {
      const pv = await runs.previewStart(C.cid, owner, 1, NCTX);
      eq(pv.approval.mode, 'admin', 'admin');
      await rejects(runs.approveAndStart(C.cid, owner, 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      const res = await ctrl.pendingApprovals(undefined, SA_USER);
      const it = res.items.find((x) => x.courseId === C.cid);
      assert(it, 'en la bandeja: ' + JSON.stringify(res.items));
      eq([it.courseTitle, it.ownerEmail, it.ownerId, it.reason, it.currency], ['Curso de Yeremy', 'yeremy@cliente.test', OWNER, 'approval_forbidden', 'USD'], 'datos');
      eq([Number(it.expected), Number(it.max), Number(it.suggestedAmount), it.safetyCap], [Number(pv.estimate.expected), Number(pv.estimate.max), Number(pv.estimate.max), null], 'montos');
      assert(/^[0-9a-f-]{36}$/.test(it.estimateId) && !isNaN(Date.parse(it.createdAt)), 'estimateId/fecha');
      pending = it;
      const aud = await auditOf('finops.pending_approvals_view');
      assert(aud.length >= 1 && aud[aud.length - 1].a === H.saActor.id, 'auditado');
    });

    await check('BANDEJA: un estimado de una firma pendiente del usuario (user_authorization_required) NO entra (no espera a un admin)', async () => {
      const C2 = await H.makeCourse(OWNER2, 'Firma pendiente', 'o2@cliente.test');
      await H.coursePolicy(C2.cid, { maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '100000', ownerMonthlyCap: '1000' });
      await rejects(runs.startRun(C2.cid, OWNER2, 1, NCTX), /user_authorization_required/, 'firma', 409);
      const res = await ctrl.pendingApprovals(undefined, SA_USER);
      assert(!res.items.some((x) => x.courseId === C2.cid), 'no aparece');
    });

    await check('APROBAR: el SuperAdmin aprueba con el endpoint EXISTENTE (estimateId + monto mostrado) → sale de la bandeja; el dueño arranca (mode none) y el run consume esa aprobación', async () => {
      const row = await finopsAdmin.authorize(C.cid, { estimateId: pending.estimateId, authorizedBudget: pending.suggestedAmount, reason: 'r95: aprobado desde Administración' }, SA_USER);
      eq([row.decision, row.estimateId, Number(row.authorizedBudget)], ['ADMIN_APPROVED', pending.estimateId, Number(pending.suggestedAmount)], 'aprobación');
      const res = await ctrl.pendingApprovals(undefined, SA_USER);
      assert(!res.items.some((x) => x.courseId === C.cid), 'ya no está pendiente');
      const pv = await runs.previewStart(C.cid, owner, 1, NCTX);
      eq([pv.approval.mode, !!pv.approval.existing], ['none', true], 'aprobación vigente');
      const started = await runs.approveAndStart(C.cid, owner, 1, NCTX, pv.estimateHash);
      eq(started.created, true, 'run creado');
      const [bound] = await ds.query(`select decision from public.cost_budget_authorizations where run_id = $1 order by created_at desc limit 1`, [started.run.id]);
      eq(bound.decision, 'ADMIN_APPROVED', 'consumió la aprobación del admin');
    });

    // Run de otro usuario con una parte fallida.
    const D = await H.makeCourse(OWNER2, 'Curso con parte fallida', 'o2@cliente.test');
    const runD = (await runs.startRun(D.cid, OWNER2, 1, MOCK_CTX)).run.id;
    const [failedItem] = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [runD]);
    await ds.query(`update public.generation_item_runs set status = 'failed', error = 'llm_timeout: corte de red', attempt_count = 3, finished_at = now() where job_id = $1 and item_key = $2`, [runD, failedItem.item_key]);

    await check('VISTA: el SuperAdmin ve la última generación de un curso AJENO (GET …/runs/:runId daría 404) con sus partes no completadas; la parte fallida trae su código y es reintentable; queda en la auditoría', async () => {
      const v = await ctrl.courseLatest(D.cid, SA_USER);
      eq([v.course.id, v.course.ownerEmail, v.course.ownerId, v.run.runId, v.run.blueprintNumber], [D.cid, 'o2@cliente.test', OWNER2, runD, 1], 'curso y run');
      assert(v.run.counts.total > 0 && v.run.counts.failed === 1, JSON.stringify(v.run.counts));
      const f = v.items.find((x) => x.itemKey === failedItem.item_key);
      eq([f && f.status, f && f.failureCode, f && f.retryable, f && f.attempts], ['failed', 'llm_timeout', true, 3], 'parte fallida');
      assert(v.items.every((x) => x.status !== 'completed'), 'solo no completadas');
      assert(!JSON.stringify(v).includes('corte de red'), 'nunca el texto técnico del error');
      const aud = await auditOf('course.admin_view_run');
      eq([aud.length, aud[0].target_type, aud[0].target_id, aud[0].after.runId], [1, 'course', String(D.cid), runD], 'auditoría');
      await rejects(ctrl.courseLatest(999999, SA_USER), /No existe el curso/, '404', 404);
      const none = await ctrl.courseLatest((await H.makeCourse(OWNER2, 'Sin runs')).cid, SA_USER);
      eq([none.run, none.items], [null, []], 'curso sin generación');
    });

    await check('REINTENTAR PARTE: reintento simple del SuperAdmin (en nombre del dueño) → la parte vuelve a pendiente; auditado ok:true; nunca acepta resubmitProvider / resubmitVideo', async () => {
      await rejects(Promise.resolve().then(() => ctrl.retryItem(runD, failedItem.item_key, { resubmitProvider: true }, SA_USER)), /campos no permitidos: resubmitProvider/, 'sin reenvío pago', 400);
      await rejects(Promise.resolve().then(() => ctrl.retryItem(runD, failedItem.item_key, { resubmitVideo: true }, SA_USER)), /campos no permitidos: resubmitVideo/, 'sin reenvío de video', 400);
      await ctrl.retryItem(runD, failedItem.item_key, { reason: 'QA r95: reintento desde Administración' }, SA_USER);
      const [it] = await ds.query(`select status from public.generation_item_runs g where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runD, failedItem.item_key]);
      assert(['pending', 'retrying', 'running'].includes(it.status), `estado tras reintentar: ${it.status}`);
      const aud = await auditOf('course.admin_retry_item');
      eq([aud.length, aud[0].a, aud[0].target_id, aud[0].after.ok, aud[0].after.itemKey, aud[0].after.reason], [1, H.saActor.id, String(D.cid), true, failedItem.item_key, 'QA r95: reintento desde Administración'], 'auditoría');
    });

    await check('REINTENTAR PARTE: una parte que no se puede reintentar (ya en curso) → el error de retryItem llega tal cual y queda auditado con ok:false', async () => {
      const err = await rejects(ctrl.retryItem(runD, failedItem.item_key, {}, SA_USER), /./, 'no reintentable', null);
      assert(err.getStatus && err.getStatus() >= 400 && err.getStatus() < 500, 'error 4xx');
      const aud = await auditOf('course.admin_retry_item');
      eq([aud.length, aud[1].after.ok], [2, false], 'auditado el intento fallido');
      await rejects(ctrl.retryItem('00000000-0000-4000-8000-000000000000', 'x', {}, SA_USER), /No existe la generación/, '404', 404);
    });
  } finally {
    await H.close();
  }
  console.log(`\n${passes} OK, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('❌ Error inesperado:', err && err.stack ? err.stack : err); process.exit(1); });
