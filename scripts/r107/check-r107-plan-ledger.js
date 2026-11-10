#!/usr/bin/env node
/* eslint-disable */
// r107 B5 fix round 1 — reservas y cargos del Taller contra el FinopsLedgerService REAL y la compuerta REAL de
// presupuestos por usuario (r75, BudgetReservationService) en `enforce`. PG16 desechable con el esquema de staging
// (baseline + FinOps + r75 access + r75 budgets), sin red ni IA: USD 0 (solo escribe en la base local).
//
//   L1  enforce sin presupuesto: la compuerta del Taller (preflight) → 409 USER_BUDGET_INSUFFICIENT y la reserva
//       directa en el ledger → USER_BUDGET_EXHAUSTED: no se inserta nada
//   L2  con presupuesto: la reserva del tope entra `pending`, descuenta del disponible; cargo real final con approvalId;
//       todas las llamadas con su cargo → closeReservation LIBERA: neto = solo el cargo real; disponible = presupuesto − cargo
//   L3  una llamada ambigua (o en vuelo) → la reserva queda PENDIENTE (neto = tope + cargos), el disponible no se recupera
//   L4  un cargo que no se pudo registrar se reintenta al cerrar (idempotente por el id del mensaje) → registrado y liberada
//   L5  una reserva con el tope por encima del disponible restante → USER_BUDGET_EXHAUSTED (el ledger hace cumplir el saldo)
//   L6  (fix round 2, N1) una llamada `not_sent` libera la reserva; junto a una ambigua, sigue pendiente
//   r107 B6 (con las migraciones r107 B1–B6 aplicadas con sus scripts sobre el mismo esquema):
//   L7  openApproval de PUNTA A PUNTA (WorkshopPlanService real, sesión real): reserva real → llamada → cargo → liberada
//   L8  conciliación admin de una aprobación `ambiguous`: listado, `charged_partial` con monto real + evidencia, aprobación
//       `reconciled`, auditoría (admin_audit_log), no-op al repetir, 409 a otra decisión, `charged` entero → 400
//   L9  `not_charged` libera; una aprobación en curso no figura ni se concilia; solo SuperAdmin
//   r107 B8 (+ migración B8):
//   L10 diagnóstico de CALIDAD con el ledger REAL: estimado sin llamar → aprobar → reserva `pending` del tope (tipo
//       `quality`) → llamada → cargo `llm.workshop_quality` con approvalId → reserva LIBERADA; disponible = antes − cargo
//   L11 pregunta puntual con el ledger REAL: lo mismo con `question` / `llm.workshop_question`; una llamada ambigua deja la
//       reserva PENDIENTE (aparece en la conciliación del admin con su tipo)
//
// Uso: npm run build && PG_BIN=/opt/homebrew/opt/postgresql@16/bin node scripts/r107/check-r107-plan-ledger.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const ai = process.argv.indexOf('--dist');
const distRoot = path.resolve(ai > 0 ? process.argv[ai + 1] : path.join(REPO, 'dist'));
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const REAL_AI = { n: 0 };
{ const sdk = require('@anthropic-ai/sdk'); const A = sdk.default || sdk.Anthropic || sdk; if (A.Messages) A.Messages.prototype.create = function () { REAL_AI.n++; throw new Error('llamada REAL bloqueada'); }; }
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const near = (a, b, m) => assert(Math.abs(Number(a) - Number(b)) < 1e-6, `${m}: esperado ${b}, encontrado ${a}`);
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
function cleanEnv(extra) { const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }; for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v); return env; }

const U = '11111111-2222-4333-8444-5555555551b5';
const SA = '11111111-2222-4333-8444-5555555555ff';
const SA_EMAIL = 'sa@cursia.test';
const ENV_KEYS = ['CURSIA_USER_BUDGETS', 'SUPER_ADMIN_EMAILS', 'CURSIA_RBAC_MODE', 'CURSIA_BUDGET_RECONCILER', 'WORKSHOP_AI_MODEL'];

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const F = L('modules/finops/index.js');
  const { BudgetReadService } = L('modules/budgets/budget-read.service.js');
  const { BudgetReservationService } = L('modules/budgets/budget-reservation.service.js');
  const { BudgetAdminService } = L('modules/budgets/budget-admin.service.js');
  const BCOM = L('modules/budgets/budget-common.js');
  const { AuditLogService } = L('modules/access/audit-log.service.js');
  const { SuspensionsService } = L('modules/access/suspensions.service.js');
  const { PlatformControlsService } = L('modules/access/platform-controls.service.js');
  const PLS = L('modules/course-workshop/plan/workshop-plan.service.js');
  const PL = L('modules/course-workshop/plan/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r107b5-ledger-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r107b5-cwd-'));
  const ROLE = 'postgres.r107b5ledgerlocal';
  const DB = 'r107b5ledger';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    // Esquema de staging: el mismo orden que check-r75-budgets.js (baseline + FinOps + r75 access + r75 budgets).
    await withClient(DB, async (c) => { for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js', 'scripts/migrate-v21-finops-rls.js',
      'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js', 'scripts/migrate-r75-access.js', 'scripts/migrate-r75-budgets.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-1500)}`);
    }
    Object.assign(process.env, { SUPER_ADMIN_EMAILS: SA_EMAIL, CURSIA_RBAC_MODE: 'off', CURSIA_BUDGET_RECONCILER: 'off', CURSIA_USER_BUDGETS: 'enforce' });
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const read = new BudgetReadService(ds);
    const audit = new AuditLogService(ds);
    const gate = new BudgetReservationService(ds, read, audit, budget, ledger, new SuspensionsService(ds, audit, null, null), new PlatformControlsService(ds, audit));
    gate.onModuleInit(); // como BudgetsModule: registra la compuerta en el ledger y en FinopsBudgetService
    const admin = new BudgetAdminService(ds, read, gate, audit);
    const sa = { id: SA, email: SA_EMAIL, superAdmin: true };
    const plan = new PLS.WorkshopPlanService(ds, null, null, ledger, budget, { simulated: false, async call() { throw new Error('nunca'); } });
    const available = async () => Number((await gate.availability(ds, U)).available);
    const net = async (key) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where idempotency_key = $1 or corrects_event_id = (select id from public.generation_cost_events where idempotency_key = $1)`, [key]))[0].t);
    const pending = async (key) => (await ds.query(`select e.measurement_status, (select count(*)::int from public.generation_cost_events a where a.corrects_event_id = e.id) adj from public.generation_cost_events e where e.idempotency_key = $1`, [key]))[0];
    const chargeFor = (approvalId, msg, input = 1000, output = 500) => PLS.workshopChargeInput({ payer: U, courseId: null, purpose: 'content', metadata: { approvalId },
      result: { model: 'claude-sonnet-4-6', messageId: msg, usage: { input_tokens: input, output_tokens: output }, input: {}, stopReason: 'tool_use' } });
    const reserve = (id, cap) => ledger.recordCharge(PLS.approvalReservationInput({ approvalId: id, payer: U, courseId: null, capUsd: cap, kind: 'generate', simulated: false }));
    const errCode = async (p) => { try { await p; return null; } catch (e) { return (e.getResponse ? e.getResponse().code : null) || e.code || e.message; } };

    await check('L1 enforce SIN presupuesto: la compuerta del Taller corta (409 USER_BUDGET_INSUFFICIENT) y la reserva directa en el ledger REAL se rechaza (USER_BUDGET_EXHAUSTED): nada insertado', async () => {
      eq(await errCode(plan.preflight(U, '0.300000')), 'USER_BUDGET_INSUFFICIENT', 'preflight del Taller');
      eq(await errCode(reserve('l1', '0.300000')), 'USER_BUDGET_EXHAUSTED', 'ledger real');
      eq((await ds.query(`select count(*)::int n from public.generation_cost_events where idempotency_key = 'workshop:approval:l1'`))[0].n, 0, 'nada insertado');
    });

    await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '1.00', reason: 'QA r107 B5' });

    await check('L2 con presupuesto: reserva del tope `pending` (descuenta el tope), cargo real con approvalId, todas con su cargo → LIBERADA: neto = cargo real; disponible = presupuesto − cargo', async () => {
      const a0 = await available();
      near(a0, 1, 'presupuesto asignado');
      eq(await errCode(plan.preflight(U, '0.300000')), null, 'el Taller deja reservar');
      const res = await reserve('l2', '0.300000');
      eq(res.inserted, true, 'reserva insertada');
      eq((await pending('workshop:approval:l2')).measurement_status, 'pending', 'pending');
      near(await available(), 0.7, 'el tope reservado descuenta');
      const ch = chargeFor('l2', 'msg_l2');
      await ledger.recordCharge(ch);
      const [byMeta] = await ds.query(`select amount::text a, operation from public.generation_cost_events where metadata->>'approvalId' = 'l2' and coalesce(metadata->>'reservation','') <> 'true'`);
      assert(byMeta && Number(byMeta.a) > 0 && /llm\.workshop_content/.test(byMeta.operation), `cargo real con approvalId: ${JSON.stringify(byMeta)}`);
      const o = await PL.closeReservation(ledger, { reservationKey: 'workshop:approval:l2', calls: { c1: { id: 'c1', kind: 'content_html', attempt: 1, boundUsd: '0.2', status: 'charged', at: 'x' } } }, 'workshop_approval_done');
      eq(o.reservation, 'released', 'liberada');
      near(await net('workshop:approval:l2'), 0, 'la reserva neta vale 0');
      near(await available(), 1 - Number(byMeta.a), 'disponible = presupuesto − cargo real');
    });

    await check('L3 llamada AMBIGUA o en vuelo → la reserva queda PENDIENTE: neto = tope, el disponible NO se recupera (gasto posible no se pierde)', async () => {
      const before = await available();
      await reserve('l3', '0.200000');
      for (const st of ['ambiguous', 'sent']) {
        const o = await PL.closeReservation(ledger, { reservationKey: 'workshop:approval:l3', calls: { c1: { id: 'c1', kind: 'content_html', attempt: 1, boundUsd: '0.2', status: st, at: 'x' } } }, 'workshop_approval_failed');
        eq(o.reservation, 'pending', `${st}: pendiente`);
      }
      const p = await pending('workshop:approval:l3');
      eq([p.measurement_status, p.adj], ['pending', 0], 'sin liquidar');
      near(await net('workshop:approval:l3'), 0.2, 'el tope sigue contado');
      near(await available(), before - 0.2, 'el disponible no se recuperó');
    });

    await check('L4 un cargo que falló se reintenta al cerrar (idempotente) → registrado una sola vez y la reserva LIBERADA', async () => {
      await reserve('l4', '0.200000');
      const before = await available();
      const ch = chargeFor('l4', 'msg_l4');
      const o = await PL.closeReservation(ledger, { reservationKey: 'workshop:approval:l4', calls: { c1: { id: 'c1', kind: 'content_html', attempt: 1, boundUsd: '0.2', status: 'charge_unrecorded', at: 'x', charge: ch } } }, 'workshop_approval_done');
      eq([o.reservation, o.calls.c1.status], ['released', 'charged'], 'registrado y liberada');
      await ledger.recordCharge(ch); // reintento: idempotente
      eq((await ds.query(`select count(*)::int n from public.generation_cost_events where metadata->>'approvalId' = 'l4' and coalesce(metadata->>'reservation','') <> 'true'`))[0].n, 1, 'un solo cargo');
      assert(await available() > before, 'al liberar se recupera el tope (menos el cargo)');
    });

    await check('L6 (fix round 2, N1) una llamada que NO llegó a enviarse (`not_sent`) → la reserva se LIBERA en el ledger real; junto a una ambigua → sigue pendiente', async () => {
      await reserve('l6', '0.100000');
      const ns = { id: 'c1', kind: 'content_html', attempt: 1, boundUsd: '0.1', status: 'not_sent', at: 'x' };
      eq(PL.callErrorOutcome(new PL.WorkshopAiNotSentError(new Error('falta ANTHROPIC_API_KEY'))).status, 'not_sent', 'clasificación');
      let o = await PL.closeReservation(ledger, { reservationKey: 'workshop:approval:l6', calls: { c1: ns } }, 'workshop_approval_failed');
      eq(o.reservation, 'released', 'liberada');
      near(await net('workshop:approval:l6'), 0, 'neto 0');
      await reserve('l6b', '0.100000');
      o = await PL.closeReservation(ledger, { reservationKey: 'workshop:approval:l6b', calls: { c1: ns, c2: { ...ns, id: 'c2', status: 'ambiguous' } } }, 'workshop_approval_failed');
      eq(o.reservation, 'pending', 'una ambigua alcanza para retenerla');
      near(await net('workshop:approval:l6b'), 0.1, 'neto = tope');
    });

    await check('L5 el LEDGER hace cumplir el saldo: un tope por encima del disponible restante → USER_BUDGET_EXHAUSTED (aunque la compuerta previa no se hubiera corrido)', async () => {
      const av = await available();
      eq(await errCode(reserve('l5', (av + 0.05).toFixed(6))), 'USER_BUDGET_EXHAUSTED', 'rechazado por el ledger');
      eq(await errCode(plan.preflight(U, (av + 0.05).toFixed(6))), 'USER_BUDGET_INSUFFICIENT', 'y por la compuerta del Taller');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });

    // ── r107 B6: openApproval de punta a punta con el ledger REAL + las migraciones r107 sobre el esquema de staging ──
    for (const s of ['scripts/migrate-r107-workshop-sessions.js', 'scripts/migrate-r107-b2-inventory.js', 'scripts/migrate-r107-b3-diagnosis.js', 'scripts/migrate-r107-b5-plan.js', 'scripts/migrate-r107-b6-apply.js', 'scripts/migrate-r107-b8-quality.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-1500)}`);
    }
    const SVC = L('modules/course-workshop/course-workshop.service.js');
    const ART = L('modules/artifacts/artifacts.service.js');
    const DRY = L('modules/pedagogy/dry-run.js');
    const { FinopsAdminController } = L('modules/finops/finops.controller.js');
    const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
    const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
    global.fetch = realFetch;
    const MBZ = (await S.simulateCourse(distRoot, COURSES.find((c) => c.id === '1x1-sin-examenes'))).built.mbz;
    global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
    const objects = new Map();
    const storage = {
      async createSignedUploadUrl(ownerId, bucket, p) { ART.assertWritableStoragePath(ownerId, bucket, p); return { method: 'backend', url: `http://storage.local/${p}`, token: 't' }; },
      async headStorageObjectBytes(bucket, p) { return objects.has(p) ? objects.get(p).length : null; },
      async downloadStorageObjectCapped(bucket, p, opts) {
        if (!objects.has(p)) throw new ART.StorageHttpError(404, 'not_found', p);
        const b = objects.get(p);
        const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });
        return ART.readBodyCapped(new Response(body), opts.maxBytes, () => {}, opts.onChunk, { sizeHint: opts.sizeHint });
      },
    };
    const svc = new SVC.CourseWorkshopService(ds, storage, null);
    const sess = await svc.createSession({ id: U, email: 'u@cursia.test' }, { filename: 'l7.mbz', sizeBytes: MBZ.length });
    objects.set(sess.upload.storagePath, MBZ);
    await svc.markUploaded({ id: U }, sess.session.id);
    await Promise.all([...svc.inFlight.values()]);
    const sid = sess.session.id;
    eq((await svc.get({ id: U }, sid)).status, 'identified', 'sesión identificada (con las migraciones r107 sobre el esquema de staging)');
    const mkClient = (mode) => ({
      simulated: false, calls: 0,
      async call(req) {
        this.calls++;
        if (mode === 'timeout') throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
        return { input: { requests: [{ quote: 'Agrega una línea a la bienvenida.', operation: 'edit_html', instruction: 'Agregar una línea al final de la bienvenida.', target: { moduleId: 1000 }, targetEvidence: 'Agrega una línea a la bienvenida.', changeEvidence: 'Agrega una línea a la bienvenida.' }] },
          stopReason: 'tool_use', model: req.model, messageId: `msg_l7_${crypto.randomUUID()}`, usage: { input_tokens: 1500, output_tokens: 300 }, simulated: false };
      },
    });
    const planFor = (client) => { const p = new PLS.WorkshopPlanService(ds, storage, svc, ledger, budget, client); p.pricingLoader = async () => DRY.seedPricing(); return p; };
    const approveIntake = async (p, text) => {
      const a = await p.createTextIntake({ id: U }, sid, text);
      const c = await p.confirmInterpretation({ id: U }, sid, a.id, { confirmEstimateUsd: Number(a.estimate.expectedUsd), capUsd: Number(a.estimate.proposedCapUsd) });
      await p.whenIdle();
      return { a, c, ap: (await p.listRequests({ id: U }, sid)).approvals.find((x) => x.id === c.approval.id) };
    };

    await check('L7 (B6) openApproval de PUNTA A PUNTA contra el ledger REAL con las migraciones r107 (enforce): estimado → aprobar → reserva `pending` del tope en el ledger → la llamada → cargo real con approvalId → reserva LIBERADA; disponible = antes − cargo', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '2.00', reason: 'QA r107 B6' });
      const before = await available();
      const client = mkClient('ok');
      const p = planFor(client);
      const a = await p.createTextIntake({ id: U }, sid, 'Agrega una línea a la bienvenida.');
      eq(client.calls, 0, 'sin aprobar no se llama');
      const c = await p.confirmInterpretation({ id: U }, sid, a.id, { confirmEstimateUsd: Number(a.estimate.expectedUsd), capUsd: Number(a.estimate.proposedCapUsd) });
      const key = `workshop:approval:${c.approval.id}`;
      eq([c.approval.reserved, (await pending(key)).measurement_status], [true, 'pending'], 'reserva REAL pendiente antes de llamar');
      near(await available(), before - Number(a.estimate.proposedCapUsd), 'el tope reservado descuenta del disponible');
      await p.whenIdle();
      const ap = (await p.listRequests({ id: U }, sid)).approvals.find((x) => x.id === c.approval.id);
      eq([ap.status, ap.aiCalls, ap.calls.map((x) => x.status), client.calls], ['done', 1, ['charged'], 1], 'aprobación cerrada, llamada cobrada');
      const [ch] = await ds.query(`select amount::text a, operation, owner_id from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [c.approval.id]);
      assert(ch && Number(ch.a) > 0 && /^llm\.workshop_interpret/.test(ch.operation), `cargo real: ${JSON.stringify(ch)}`);
      const pd = await pending(key);
      assert(pd.adj >= 1, 'la reserva tiene su liquidación');
      near(await net(key), 0, 'reserva liberada (neto 0)');
      near(await available(), before - Number(ch.a), 'disponible = antes − cargo real');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });

    const ctl = new FinopsAdminController(ledger, budget, { get: () => audit });
    const saUser = { id: SA, email: SA_EMAIL };
    let amb1 = null; let amb2 = null;

    await check('L8 (B6) conciliación: una aprobación del Taller con una llamada AMBIGUA aparece en el listado admin de reservas pendientes (con sus llamadas); `charged` entero → 400; `charged_partial` con el monto real + evidencia → cuenta eso, aprobación `reconciled`, AUDITADA; repetir = no-op; otra decisión → 409', async () => {
      const p = planFor(mkClient('timeout'));
      const r1 = await approveIntake(p, 'Agrega una línea a la bienvenida.');
      eq([r1.ap.status, r1.ap.calls.map((x) => x.status)], ['ambiguous', ['ambiguous']], 'ambigua');
      amb1 = `workshop:approval:${r1.c.approval.id}`;
      near(await net(amb1), Number(r1.a.estimate.proposedCapUsd), 'el tope entero sigue retenido');
      const r2 = await approveIntake(p, 'Agrega una línea a la bienvenida.');
      amb2 = `workshop:approval:${r2.c.approval.id}`;
      const list = (await ctl.workshopReservations()).reservations;
      const row = list.find((x) => x.reservationKey === amb1);
      assert(row && row.approvalStatus === 'ambiguous' && row.sessionId === sid && row.kind === 'interpret' && row.calls.length === 1 && row.calls[0].status === 'ambiguous', `en el listado: ${JSON.stringify(row)}`);
      assert(list.some((x) => x.reservationKey === amb2), 'las dos');
      const badReq = async (b) => { try { await ctl.reconcileWorkshopReservation(b, saUser); return null; } catch (e) { return e.getStatus ? e.getStatus() : e.message; } };
      eq(await badReq({ reservationKey: amb1, outcome: 'charged', reason: 'x' }), 400, 'charged entero no');
      eq(await badReq({ reservationKey: 'workshop:approval:nope', outcome: 'not_charged', reason: 'x' }), 400, 'clave inválida');
      eq(await badReq({ reservationKey: `workshop:approval:${crypto.randomUUID()}`, outcome: 'not_charged', reason: 'x' }), 400, 'no es una reserva del Taller');
      const ev = { source: 'provider_console', referenceIds: ['req_l8_1'], observedAmount: '0.0123' };
      const out = await ctl.reconcileWorkshopReservation({ reservationKey: amb1, outcome: 'charged_partial', amount: '0.0123', reason: 'Anthropic confirma el cobro de la llamada (consola)', evidence: ev }, saUser);
      eq([out.outcome, out.reconciled, out.countedAmount], ['charged_partial', true, '0.0123000000'], 'conciliada con el monto real');
      near(await net(amb1), 0.0123, 'cuenta SOLO lo cobrado');
      const [w] = await ds.query(`select status, reconciliation from public.workshop_ai_approvals where id = $1`, [r1.c.approval.id]);
      eq([w.status, w.reconciliation.outcome, w.reconciliation.decidedBy, w.reconciliation.amount], ['reconciled', 'charged_partial', SA, '0.0123000000'], 'anotada en la aprobación');
      const [au] = await ds.query(`select actor_id::text a, action, target_type, target_id, after from public.admin_audit_log where action = 'finops.reconcile_workshop_approval' and target_id = $1`, [r1.c.approval.id]);
      assert(au && au.a === SA && au.target_type === 'workshop_ai_approval' && au.after.outcome === 'charged_partial', `auditada: ${JSON.stringify(au)}`);
      const again = await ctl.reconcileWorkshopReservation({ reservationKey: amb1, outcome: 'charged_partial', amount: '0.0123', reason: 'repetida', evidence: ev }, saUser);
      eq([again.alreadySettled, again.reconciled], [true, false], 'repetir = no-op');
      eq(await badReq({ reservationKey: amb1, outcome: 'not_charged', reason: 'cambio de opinión' }), 409, 'otra decisión sobre una ya cerrada → 409');
      assert(!(await ctl.workshopReservations()).reservations.some((x) => x.reservationKey === amb1), 'ya no figura como pendiente');
    });

    await check('L9 (B6) `not_charged` (Anthropic no cobró) → reserva LIBERADA a 0 con motivo, auditada; una aprobación todavía EN CURSO no figura ni se concilia (409); solo SuperAdmin (guard de la clase)', async () => {
      const before = await available();
      const out = await ctl.reconcileWorkshopReservation({ reservationKey: amb2, outcome: 'not_charged', reason: 'La consola de Anthropic no muestra la llamada' }, saUser);
      eq([out.outcome, out.reconciled], ['not_charged', true], 'liberada');
      near(await net(amb2), 0, 'neto 0');
      assert(await available() > before, 'el saldo retenido vuelve');
      // Una aprobación `running` (con su reserva pendiente) no se concilia: puede liquidarse sola.
      const [run] = await ds.query(`insert into public.workshop_ai_approvals (session_id, created_by, kind, estimate, cap_usd, status) values ($1, $2, 'interpret', '{}'::jsonb, 0.05, 'running') returning id`, [sid, U]);
      await reserve(run.id, '0.050000');
      const key = `workshop:approval:${run.id}`;
      assert(!(await ctl.workshopReservations()).reservations.some((x) => x.reservationKey === key), 'en curso: no figura');
      let st = null; try { await ctl.reconcileWorkshopReservation({ reservationKey: key, outcome: 'not_charged', reason: 'x' }, saUser); } catch (e) { st = e.getStatus(); }
      eq(st, 409, 'en curso → 409');
      const { SuperAdminGuard } = L('auth/super-admin.guard.js');
      const guards = Reflect.getMetadata('__guards__', FinopsAdminController) || [];
      assert(guards.includes(SuperAdminGuard), 'el controlador exige SuperAdmin');
    });

    // ── r107 B8: calidad y preguntas con las MISMAS aprobaciones, contra el ledger real ──
    const QLS = L('modules/course-workshop/quality/workshop-quality.service.js');
    await svc.startDiagnosis({ id: U }, sid);
    await Promise.all([...svc.inFlight.values()]);
    eq((await svc.getDiagnosis({ id: U }, sid)).status, 'ready', 'diagnóstico técnico listo');
    const qClient = (mode) => ({
      simulated: false, calls: 0,
      async call(req) {
        this.calls++;
        if (mode === 'timeout') throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
        const input = req.purpose === 'quality' ? { findings: [] } : { verdict: 'sin_evidencia', answer: 'No alcanza.', citations: [] };
        return { input, stopReason: 'tool_use', model: req.model, messageId: `msg_b8_${crypto.randomUUID()}`, usage: { input_tokens: 2500, output_tokens: 250 }, simulated: false };
      },
    });

    await check('L10 (B8) diagnóstico de CALIDAD de punta a punta contra el ledger REAL (enforce): la parte determinista y el estimado sin llamar → aprobar → reserva `pending` del tope (tipo quality) → la llamada → cargo llm.workshop_quality con approvalId → reserva LIBERADA; disponible = antes − cargo', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '2.00', reason: 'QA r107 B8' });
      const client = qClient('ok');
      const p = planFor(client);
      const q = new QLS.WorkshopQualityService(ds, svc, p);
      await q.startQuality({ id: U }, sid, {});
      await q.whenIdle();
      const v = await q.getQuality({ id: U }, sid);
      eq([v.status, client.calls], ['ready', 0], 'listo sin llamar');
      const before = await available();
      const a = await q.startQuality({ id: U }, sid, { chapters: 'all', confirmEstimateUsd: Number(v.ai.all.expectedUsd), capUsd: Number(v.ai.all.proposedCapUsd) });
      const key = `workshop:approval:${a.approval.id}`;
      eq([a.approval.kind, a.approval.reserved, (await pending(key)).measurement_status], ['quality', true, 'pending'], 'reserva REAL pendiente antes de llamar');
      near(await available(), before - Number(v.ai.all.proposedCapUsd), 'el tope reservado descuenta del disponible');
      await q.whenIdle();
      const g = await q.getQuality({ id: U }, sid);
      const ap = g.approvals.find((x) => x.id === a.approval.id);
      eq([ap.status, ap.calls.map((x) => x.status), client.calls, g.ai.chapters.map((c) => c.status)], ['done', ['charged'], 1, ['reviewed']], 'revisado y cobrado');
      const [ch] = await ds.query(`select amount::text a, operation from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [a.approval.id]);
      assert(ch && Number(ch.a) > 0 && /^llm\.workshop_quality/.test(ch.operation), `cargo real: ${JSON.stringify(ch)}`);
      near(await net(key), 0, 'reserva liberada (neto 0)');
      near(await available(), before - Number(ch.a), 'disponible = antes − cargo real');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });

    await check('L11 (B8) pregunta puntual contra el ledger REAL: reserva (tipo question) → cargo llm.workshop_question → liberada; una llamada AMBIGUA deja la reserva PENDIENTE y figura en la conciliación del admin con su tipo', async () => {
      const client = qClient('ok');
      const p = planFor(client);
      const q = new QLS.WorkshopQualityService(ds, svc, p);
      const ask = async (qq, text) => {
        const r = await qq.ask({ id: U }, sid, { text });
        await qq.whenIdle();
        const h = (await qq.listQuestions({ id: U }, sid)).questions.find((x) => x.id === r.id);
        assert(h.status === 'awaiting_confirmation', `evidencia recuperada: ${h.status} ${JSON.stringify(h.answer)}`);
        const c = await qq.ask({ id: U }, sid, { questionId: r.id, confirmEstimateUsd: Number(h.estimate.expectedUsd), capUsd: Number(h.estimate.proposedCapUsd) });
        await qq.whenIdle();
        return { c, h: (await qq.listQuestions({ id: U }, sid)).questions.find((x) => x.id === r.id) };
      };
      const text = '¿El capítulo 1 explica el tema del curso?';
      const before = await available();
      const r1 = await ask(q, text);
      const key = `workshop:approval:${r1.c.approval.id}`;
      eq([r1.c.approval.kind, r1.h.status, r1.h.answer.answer, client.calls], ['question', 'answered', 'No encontré evidencia suficiente en el curso para responder', 1], 'respondida (sin evidencia suficiente: el modelo lo dijo)');
      const [ch] = await ds.query(`select amount::text a, operation from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [r1.c.approval.id]);
      assert(ch && /^llm\.workshop_question/.test(ch.operation), `cargo: ${JSON.stringify(ch)}`);
      near(await net(key), 0, 'liberada');
      near(await available(), before - Number(ch.a), 'disponible = antes − cargo');
      const q2 = new QLS.WorkshopQualityService(ds, svc, planFor(qClient('timeout')));
      const r2 = await ask(q2, text);
      const key2 = `workshop:approval:${r2.c.approval.id}`;
      eq([r2.h.status, r2.h.error && r2.h.error.code], ['ambiguous', 'WORKSHOP_AI_CALL_AMBIGUOUS'], 'ambigua: estado propio (B8fe P2-3), no se reintenta a ciegas');
      eq((await pending(key2)).measurement_status, 'pending', 'reserva PENDIENTE');
      const row = (await ctl.workshopReservations()).reservations.find((x) => x.reservationKey === key2);
      assert(row && row.kind === 'question' && row.approvalStatus === 'ambiguous', `en la conciliación: ${JSON.stringify(row)}`);
      // La conciliación REAL del admin (`not_charged`) la deja reintentable.
      await ctl.reconcileWorkshopReservation({ reservationKey: key2, outcome: 'not_charged', reason: 'La consola de Anthropic no muestra la llamada' }, saUser);
      const after = (await q2.listQuestions({ id: U }, sid)).questions.find((x) => x.id === r2.h.id);
      eq([after.status, after.error.retryable], ['failed', true], 'conciliada → fallida reintentable');
      near(await net(key2), 0, 'reserva liberada por la conciliación');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
