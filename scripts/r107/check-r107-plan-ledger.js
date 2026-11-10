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
//   r107 B10 fix round 1 (P1-4) — la compuerta REAL (`regenGateFor`, no la copia del simulador):
//   L14 tope por debajo de la cota de la 2.ª llamada → `cap_reached` ANTES de enviarla (0 envíos); aprobar una
//       regeneración exige tope ≥ Σ cotas (409 CAP_BELOW_CALL_BOUND)
//   L15 medido > cota → WORKSHOP_PROVIDER_OVER_BOUND: lo real queda en la aprobación y en el ledger, se cortan las
//       llamadas que faltaban, el ítem falla visible
//   L16 esperando al proveedor / ambigua sin conciliar → re-aprobar = 409 WORKSHOP_REGEN_PENDING_PROVIDER (el plan lo dice);
//       el carril y la memoria se sueltan durante la espera; tras la conciliación del admin, se re-aprueba
//   L17 espera retomada tras matar el proceso → el MISMO id externo, 1 solo envío
//   fix 2: L18 aprobación mixta: la cota del render en espera queda comprometida → el contenido corta antes de enviarse (N1)
//   · L19 dos procesos liquidan la misma espera → uno solo la toma, un cargo, una subida, un resultado; `sent → settling` (N2)
//   · L20 retoma fallida sin cobro / job aceptado sin espera → conciliar → re-aprobar → produce; sin conciliar, falla cerrado (N3)
//
// Uso: npm run build && PG_BIN=/opt/homebrew/opt/postgresql@16/bin node scripts/r107/check-r107-plan-ledger.js [--bite]
//   --bite: copia dist/ y rompe UNA guarda por vez: `if (!d.allow)` de regenGateFor → L14; las cotas en vuelo de la IA de
//   B5 → L18; la condición del reclamo de la espera → L19. Cada mutación tiene que hacer fallar su prueba.
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

const oi = process.argv.indexOf('--only');
const ONLY = oi > 0 ? process.argv[oi + 1] : null;
if (process.argv.includes('--bite')) {
  // Mordida (P1-4): sin `if (!d.allow)` la compuerta deja pasar la 2.ª llamada → L14 tiene que fallar.
  const tmp = fs.mkdtempSync(path.join(REPO, '.r107-bite-')); // dentro del repo: resuelve node_modules
  // Mordidas (P1-4 / fix 2 N2): cada una rompe UNA guarda de la compuerta real y su prueba tiene que fallar.
  const bites = [
    { name: 'sin `if (!d.allow)` en regenGateFor', anchor: 'regenGateFor(s, approval, simulated)', from: 'if (!d.allow)', to: 'if (false)', only: 'L14' },
    { name: 'la IA de B5 sin las cotas en vuelo (solo lo gastado)', anchor: 'invokerFor(s, approval, pricing, meta)', from: '(cur.spent_usd, cur.calls)', to: '(cur.spent_usd, {})', only: 'L18' },
    { name: 'sin la condición del reclamo de la espera', anchor: 'async runRegenWait(', from: "and claim_id is not distinct from $3::text returning *", to: 'returning *', only: 'L19' },
  ];
  let code = 0;
  try {
    for (const m of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(distRoot, tmp, { recursive: true });
      const f = path.join(tmp, 'modules/course-workshop/plan/workshop-plan.service.js');
      const src = fs.readFileSync(f, 'utf8');
      const at = src.indexOf(m.anchor);
      const k = at < 0 ? -1 : src.indexOf(m.from, at);
      if (at < 0 || k < 0) { console.error(`❌ mordida «${m.name}»: no encontré la guarda`); code = 1; continue; }
      fs.writeFileSync(f, src.slice(0, k) + m.to + src.slice(k + m.from.length));
      const r = spawnSync(process.execPath, [__filename, '--dist', tmp, '--only', m.only], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
      const out = (r.stdout || '') + (r.stderr || '');
      const bit = r.status !== 0 && new RegExp(`❌ ${m.only}`).test(out);
      console.log(bit ? `✅ mordida «${m.name}»: ${m.only} FALLA` : `❌ mordida «${m.name}»: la mutación NO hizo fallar ${m.only}\n${out.slice(-2000)}`);
      if (!bit) code = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

let passes = 0; let failures = 0;
async function check(name, fn) { if (ONLY && !ONLY.split(',').some((o) => name.startsWith(o))) return; try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
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
    // r107 B10: el resultado de una regeneración se sube como artifact del Taller (servidor) en la carpeta del dueño.
    storage.putStorageObject = async (input) => { ART.assertWritableStoragePath(input.ownerId, input.storageBucket ?? 'cursia-artifacts', input.storagePath); objects.set(input.storagePath, Buffer.from(input.buffer)); return { sizeBytes: input.buffer.length, adopted: false, sha256: null }; };
    storage.deleteUnreferencedServerObject = async (o, b, p) => { objects.delete(p); return true; };
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

    // ── r107 B10: rehacer actividades contra el ledger REAL (enforce): aprobaciones MULTI-PROVEEDOR, reserva y conciliación.
    // Proveedores SIMULADOS (sin red); `simulated: false` para que el ledger real valúe los cargos como reales (USD de mentira).
    const SIMLIB = require(path.join(REPO, 'scripts/r107/lib/r107-regen-sim.js'));
    const regenClient = (op, moduleId, quote) => ({
      simulated: false, calls: 0,
      async call(req) {
        this.calls++;
        return { input: { requests: [{ quote, operation: op, instruction: quote, target: { moduleId }, targetEvidence: quote, changeEvidence: quote }] },
          stopReason: 'tool_use', model: req.model, messageId: `msg_b10_${crypto.randomUUID()}`, usage: { input_tokens: 1500, output_tokens: 300 }, simulated: false };
      },
    });
    const regenPlan = async (op, moduleId, quote, sim) => {
      const p = planFor(regenClient(op, moduleId, quote));
      p.regenProviders = () => sim;
      const r = await approveIntake(p, quote);
      const plan0 = await p.getPlan({ id: U }, sid);
      // El ítem MÁS NUEVO de esta operación que espera generación (la sesión acumula los de las pruebas anteriores).
      const it = plan0.items.filter((i) => i.operation === op && i.stage === 'estimate' && i.requestStatus === 'awaiting_generation' && i.quote === quote).pop();
      assert(it, `ítem en estimado: ${JSON.stringify(plan0.items.map((i) => [i.operation, i.stage]))}`);
      // Solo ESTE ítem (la sesión trae otros pedidos de L7–L11 esperando): su estimado y un tope que cubre sus cotas.
      const cap = Math.ceil(Math.max(Number(it.plannedCall.expectedUsd) * 1.5, Number(it.plannedCall.regen.totalBoundUsd)) * 100) / 100;
      const g = await p.approveGeneration({ id: U }, sid, plan0.planId, { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap });
      await p.whenIdle();
      return { p, g, it, key: `workshop:approval:${g.approval.id}`, interpId: r.c.approval.id };
    };

    await check('L12 (B10) rehacer el VIDEO contra el ledger REAL (enforce): aprobación multi-proveedor → reserva `pending` del tope → Videogen (costo informado) + YouTube (USD 0) + Anthropic, cada cargo con approvalId → reserva LIBERADA; disponible = antes − cargos reales', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '6.00', reason: 'QA r107 B10' });
      const sim = SIMLIB.simProviders(distRoot, { simulated: false });
      const before = await available();
      const r = await regenPlan('regenerate_video', 1016, 'Rehace el video interactivo del capítulo 1.', sim);
      const ap = (await r.p.listRequests({ id: U }, sid)).approvals.find((x) => x.id === r.g.approval.id);
      eq([ap.status, ap.calls.map((x) => [x.kind.split(':')[0], x.status]).sort()], ['done', [['anthropic', 'charged'], ['videogen', 'charged'], ['youtube', 'charged']]], 'tres proveedores, todos cobrados');
      const rows = await ds.query(`select provider, operation, amount::text a, measurement_status from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true' order by provider`, [r.g.approval.id]);
      // (el ledger agrega «.unattributed» cuando la llamada no queda atribuida a un curso: mismo criterio que L11)
      eq(rows.map((x) => [x.provider, x.operation.replace(/\.unattributed$/, ''), x.measurement_status]), [['anthropic', 'llm.workshop_regenerate', 'final'], ['videogen', 'videogen.workshop_regenerate', 'final']], 'cargos reales por proveedor');
      near(rows.find((x) => x.provider === 'videogen').a, 0.94, 'Videogen: el costo que informó');
      near(await net(r.key), 0, 'reserva liberada (neto 0)');
      const interp = await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [r.interpId]);
      near(await available(), before - Number(interp[0].t) - rows.reduce((a, x) => a + Number(x.a), 0), 'disponible = antes − cargos reales (interpretar + rehacer)');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });

    await check('L13 (B10) envío AMBIGUO a Gamma contra el ledger REAL: la reserva del tope queda PENDIENTE (el gasto posible no se pierde), figura en la conciliación del admin con su llamada de Gamma; `charged_partial` con la evidencia → cuenta eso y la aprobación queda conciliada', async () => {
      const sim = SIMLIB.simProviders(distRoot, { simulated: false, fault: { gammaCreate: 'ambiguous' } });
      const r = await regenPlan('regenerate_gamma', 1013, 'Rehace la presentación del capítulo 1.', sim);
      eq(sim.calls.gamma.filter((c) => c.op === 'create').length, 1, 'UN envío (no se reenvía)');
      eq((await pending(r.key)).measurement_status, 'pending', 'reserva PENDIENTE');
      const row = (await ctl.workshopReservations()).reservations.find((x) => x.reservationKey === r.key);
      assert(row && row.kind === 'generate' && row.approvalStatus === 'ambiguous' && row.calls.some((c) => /^gamma:/.test(c.kind) && c.status === 'ambiguous'), `en la conciliación: ${JSON.stringify(row)}`);
      const out = await ctl.reconcileWorkshopReservation({ reservationKey: r.key, outcome: 'charged_partial', amount: '0.55', reason: 'Gamma confirma la generación (55 créditos)', evidence: { source: 'provider_console', referenceIds: ['gen_sim_1'], observedAmount: '0.55' } }, saUser);
      eq([out.outcome, out.reconciled], ['charged_partial', true], 'conciliada');
      near(await net(r.key), 0.55, 'cuenta lo que Gamma cobró');
      eq(REAL_AI.n, 0, 'ninguna llamada real');
    });
    // ── r107 B10 fix round 1 (P1-4): la compuerta REAL del servicio ──
    const PO = L('modules/course-workshop/regenerate/ports.js');
    const llmOk = (msg) => async () => ({ text: '{}', messageId: msg, model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 100 }, stopReason: 'end_turn' });
    const reqRow = async (p, itemId) => (await ds.query(`select r.* from public.workshop_requests r join public.workshop_plan_items i on i.request_id = r.id where i.id = $1`, [itemId]))[0];
    const until = async (fn, what, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

    await check('L14 (B10 P1-4) compuerta REAL: tope por debajo de la cota de la 2.ª llamada → cap_reached ANTES de enviarla (0 envíos a la 2.ª); aprobar una regeneración exige tope ≥ Σ cotas', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '2.00', reason: 'QA r107 B10 L14' });
      const Q14 = 'Rehace el video del capítulo 1 (L14).';
      const p = planFor(regenClient('regenerate_video', 1016, Q14));
      const s = await svc.planSessionById(sid);
      const ap0 = await p.openApproval(s, { id: U }, { kind: 'generate', estimate: p.estimateOf([], 'L14'), capUsd: '0.300000' });
      await p.startApproval(ap0.id);
      const gate = p.regenGateFor(s, await p.approvalOf(ap0.id), false);
      await PO.paidCall(gate, { provider: 'anthropic', kind: 'scorm_room', boundUsd: '0.200000', attempt: 1 }, llmOk('msg_l14_1'), PO.classifyAnthropic, () => ({ costUsd: '0.150000', charge: null, externalId: 'msg_l14_1' }));
      let sent2 = 0; let e = null;
      try { await PO.paidCall(gate, { provider: 'anthropic', kind: 'scorm_room', boundUsd: '0.200000', attempt: 2 }, async () => { sent2++; return llmOk('msg_l14_2')(); }, PO.classifyAnthropic, () => ({ costUsd: '0.150000', charge: null })); } catch (x) { e = x; }
      assert(e && e.code === 'cap_reached', `2.ª llamada: ${e && e.message}`);
      eq(sent2, 0, '0 envíos a la 2.ª llamada');
      const ap = await p.approvalOf(ap0.id);
      eq(Object.values(ap.calls).map((c) => [c.kind, c.status]), [['anthropic:scorm_room', 'charged']], 'solo la 1.ª quedó registrada');
      near(ap.spent_usd, 0.15, 'gastado = la 1.ª');
      await p.closeApproval(ap0.id, 'stopped', 'L14');
      near(await net(`workshop:approval:${ap0.id}`), 0, 'reserva liberada');
      // P1-2a: tope ≥ estimado pero < Σ cotas de la regeneración → 409 (antes de reservar).
      const r = await approveIntake(p, Q14);
      const pl = await p.getPlan({ id: U }, sid);
      const it = pl.items.filter((i) => i.operation === 'regenerate_video' && i.stage === 'estimate' && i.requestStatus === 'awaiting_generation' && i.quote === Q14).pop();
      if (!it) throw new Error(`items: ${JSON.stringify(pl.items.map((i) => [i.operation, i.stage, i.requestStatus, i.status, i.quote]))} pending ${JSON.stringify(pl.pending.map((x) => [x.status, x.operation, x.reason]))} excl ${JSON.stringify(pl.excluded)}`);
      const exp = Number(it.plannedCall.expectedUsd);
      const cap = Math.ceil(exp * 101) / 100;
      assert(cap < Number(it.plannedCall.regen.totalBoundUsd), `el caso: ${cap} < ${it.plannedCall.regen.totalBoundUsd}`);
      eq(await errCode(p.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [it.id], confirmEstimateUsd: exp, capUsd: cap })), 'WORKSHOP_CAP_BELOW_CALL_BOUND', 'tope < Σ cotas → 409');
      assert(r, 'intake');
    });

    await check('L15 (B10 P1-2c) medido > cota → WORKSHOP_PROVIDER_OVER_BOUND: lo real en la aprobación Y en el ledger; se cortan las llamadas que faltaban; el ítem falla visible', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '20.00', reason: 'QA r107 B10 L15' });
      const sim = SIMLIB.simProviders(distRoot, { simulated: false, videogenCost: 7.77, videogenJobId: 'vg_sim_l15' }); // id propio: el ledger es idempotente por job
      const r = await regenPlan('regenerate_video', 1016, 'Rehace el video del capítulo 1 (L15).', sim);
      const ap = await r.p.approvalOf(r.g.approval.id);
      const cs = Object.values(ap.calls);
      eq(cs.map((c) => [c.kind, c.status, c.costUsd, c.overBound === true]), [['videogen:render', 'charged', '7.77', true]], 'solo el render, cobrado con lo REAL y marcado');
      assert(String(ap.stop_reason).startsWith('WORKSHOP_PROVIDER_OVER_BOUND'), `motivo: ${ap.stop_reason}`);
      near(ap.spent_usd, 7.77, 'lo real en la aprobación');
      eq([sim.calls.youtube.length, sim.calls.anthropic.length], [0, 0], 'ni YouTube ni IA después');
      const [row] = await ds.query(`select amount::text a, provider from public.generation_cost_events where metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [r.g.approval.id]);
      eq([row.provider, Number(row.a)], ['videogen', 7.77], 'lo real en el ledger');
      const req = await reqRow(r.p, r.it.id);
      eq([req.status, req.details.lastError.code], ['failed', 'WORKSHOP_PROVIDER_OVER_BOUND'], 'el ítem falla visible');
      eq(ap.status, 'failed', 'aprobación cerrada como fallida');
      near(await net(r.key), 0, 'reserva liberada (todo con su cargo)');
    });

    await check('L16 (B10 P1-5) esperando al proveedor → re-aprobar 409 y el plan lo dice; carril y memoria sueltos; ambigua sin conciliar → 409; tras la conciliación del admin se re-aprueba', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '10.00', reason: 'QA r107 B10 L16' });
      const simOpts = { simulated: false, videogenPendingPolls: 1e9, pollTimeoutMs: 60000 };
      const sim = SIMLIB.simProviders(distRoot, simOpts);
      const p = planFor(regenClient('regenerate_video', 1016, 'Rehace el video del capítulo 1 (L16).'));
      p.regenProviders = () => sim;
      await approveIntake(p, 'Rehace el video del capítulo 1 (L16).');
      const pl = await p.getPlan({ id: U }, sid);
      const it = pl.items.filter((i) => i.operation === 'regenerate_video' && i.stage === 'estimate' && i.requestStatus === 'awaiting_generation').pop();
      const cap = Math.ceil(Math.max(Number(it.plannedCall.expectedUsd) * 1.5, Number(it.plannedCall.regen.totalBoundUsd)) * 100) / 100;
      const g = await p.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap });
      const w = await until(async () => (await reqRow(p, it.id)).details.regenPending, 'la espera');
      eq([w.provider, w.externalId, w.approvalId], ['videogen', 'vg_sim_1', g.approval.id], 'id externo guardado con la aprobación');
      await until(async () => !p.laneBusy && svc.memoryReservations.size === 0, 'carril y memoria libres');
      const v = await p.getPlan({ id: U }, sid);
      eq([v.items.find((i) => i.id === it.id).providerWait.state, v.items.find((i) => i.id === it.id).providerWait.label], ['waiting_provider', 'esperando al proveedor'], 'el plan lo dice');
      eq(await errCode(p.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap })), 'WORKSHOP_REGEN_PENDING_PROVIDER', 'esperando → 409');
      eq((await p.approvalOf(g.approval.id)).status, 'running', 'la aprobación sigue viva (reserva intacta)');
      simOpts.videogenPendingPolls = 0; // el proveedor termina
      await p.whenIdle();
      const done = await p.getPlan({ id: U }, sid);
      eq([done.items.find((i) => i.id === it.id).stage, done.items.find((i) => i.id === it.id).providerWait], ['ready', null], 'terminó: ítem listo');
      eq([(await p.approvalOf(g.approval.id)).status, sim.calls.videogen.filter((c) => c.op === 'create').length], ['done', 1], 'cerrada con 1 envío');
      // Ambigua (plazo total vencido sin estado final) → 409 hasta conciliar; conciliada → se re-aprueba.
      const simT = SIMLIB.simProviders(distRoot, { simulated: false, fault: { videogenRender: 'timeout' }, pollTimeoutMs: 60 });
      const r = await regenPlan('regenerate_video', 1016, 'Rehace el video del capítulo 1 (L16 ambiguo).', simT);
      const rq = await reqRow(r.p, r.it.id);
      eq([rq.status, rq.details.regenAmbiguous && rq.details.regenAmbiguous.externalId, (await r.p.approvalOf(r.g.approval.id)).status], ['awaiting_generation', 'vg_sim_1', 'ambiguous'], 'ambigua solo al vencer el plazo');
      const v2 = await r.p.getPlan({ id: U }, sid);
      const it2 = v2.items.find((i) => i.id === r.it.id);
      eq(it2.providerWait && it2.providerWait.label, 'pendiente de conciliación', 'el plan lo dice');
      const again = { itemIds: [r.it.id], confirmEstimateUsd: Number(r.it.plannedCall.expectedUsd), capUsd: Math.ceil(Math.max(Number(r.it.plannedCall.expectedUsd) * 1.5, Number(r.it.plannedCall.regen.totalBoundUsd)) * 100) / 100 };
      eq(await errCode(r.p.approveGeneration({ id: U }, sid, v2.planId, again)), 'WORKSHOP_REGEN_PENDING_PROVIDER', 'ambigua sin conciliar → 409');
      await ctl.reconcileWorkshopReservation({ reservationKey: r.key, outcome: 'not_charged', reason: 'Videogen no muestra el render' }, saUser);
      const simOk = SIMLIB.simProviders(distRoot, { simulated: false });
      r.p.regenProviders = () => simOk;
      const g2 = await r.p.approveGeneration({ id: U }, sid, v2.planId, again);
      await r.p.whenIdle();
      eq([(await r.p.approvalOf(g2.approval.id)).status, (await r.p.getPlan({ id: U }, sid)).items.find((i) => i.id === r.it.id).stage], ['done', 'ready'], 'conciliada → re-aprobada y producida');
    });

    await check('L17 (B10 P1-3) espera RETOMADA tras matar el proceso (pm2 reload): el mismo id externo, 1 solo envío, el ítem termina', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '10.00', reason: 'QA r107 B10 L17' });
      const simOpts = { simulated: false, videogenPendingPolls: 1e9, pollTimeoutMs: 60000 };
      const sim = SIMLIB.simProviders(distRoot, simOpts);
      const svcA = new SVC.CourseWorkshopService(ds, storage, null);
      const A = new PLS.WorkshopPlanService(ds, storage, svcA, ledger, budget, regenClient('regenerate_video', 1016, 'Rehace el video del capítulo 1 (L17).'));
      A.pricingLoader = async () => DRY.seedPricing();
      A.regenProviders = () => sim;
      await approveIntake(A, 'Rehace el video del capítulo 1 (L17).');
      const pl = await A.getPlan({ id: U }, sid);
      const it = pl.items.filter((i) => i.operation === 'regenerate_video' && i.stage === 'estimate' && i.requestStatus === 'awaiting_generation').pop();
      const cap = Math.ceil(Math.max(Number(it.plannedCall.expectedUsd) * 1.5, Number(it.plannedCall.regen.totalBoundUsd)) * 100) / 100;
      const g = await A.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap });
      const w = await until(async () => (await reqRow(A, it.id)).details.regenPending, 'la espera de A');
      await until(async () => sim.calls.videogen.some((c) => c.op === 'status'), 'A consultando');
      A.simulateDeathForTests(); // pm2 reload: A deja de latir y de consultar
      await A.whenIdle();
      // El reclamo de A deja de latir: pasado el umbral de latido, otro proceso lo retoma.
      await ds.query(`update public.workshop_requests set updated_at = now() - interval '2 minutes' where id = (select request_id from public.workshop_plan_items where id = $1)`, [it.id]);
      await ds.query(`update public.workshop_ai_approvals set updated_at = now() - interval '2 minutes' where id = $1`, [g.approval.id]);
      simOpts.videogenPendingPolls = 0;
      const svcB = new SVC.CourseWorkshopService(ds, storage, null);
      assert(svcB.bootId !== svcA.bootId, 'otro arranque');
      const B = new PLS.WorkshopPlanService(ds, storage, svcB, ledger, budget, regenClient('regenerate_video', 1016, 'x'));
      B.pricingLoader = async () => DRY.seedPricing();
      B.regenProviders = () => sim;
      await B.sweep();
      await B.whenIdle();
      const creates = sim.calls.videogen.filter((c) => c.op === 'create');
      eq(creates.length, 1, '1 solo envío a Videogen');
      eq([...new Set(sim.calls.videogen.filter((c) => c.op === 'status').map((c) => c.jobId))], [w.externalId], 'A y B consultaron el MISMO id externo');
      const rq = await reqRow(B, it.id);
      assert(!rq.details.regenPending && String(rq.claim_id || '').startsWith(`${svcB.bootId}.`), `retomada por B: ${JSON.stringify([rq.status, rq.claim_id])}`);
      const ap = await B.approvalOf(g.approval.id);
      eq([ap.status, Object.values(ap.calls).map((c) => [c.kind, c.status]).sort()], ['done', [['anthropic:video_interactions', 'charged'], ['videogen:render', 'charged'], ['youtube:upload', 'charged']]], 'liquidada y terminada por B');
      eq((await B.getPlan({ id: U }, sid)).items.find((i) => i.id === it.id).stage, 'ready', 'ítem listo');
      near(await net(`workshop:approval:${g.approval.id}`), 0, 'reserva liberada');
    });
    // ── r107 B10 fix 2 ──
    const twoClient = (q1, q2) => ({
      simulated: false, calls: 0, content: 0,
      async call(req) {
        this.calls++;
        if (req.purpose === 'content') { this.content++; throw new Error('L18: el contenido NO debía enviarse'); }
        return { input: { requests: [
          { quote: q1, operation: 'regenerate_video', instruction: q1, target: { moduleId: 1016 }, targetEvidence: q1, changeEvidence: q1 },
          // La profundización del capítulo (texto largo): su llamada de contenido tiene una cota mayor que el margen de IA del video.
          { quote: q2, operation: 'edit_html', instruction: 'Agregar un ejemplo al final de la profundización del capítulo 1.', target: { moduleId: 1014 }, targetEvidence: 'la profundización del capítulo 1', changeEvidence: 'Agrega un ejemplo' },
        ] }, stopReason: 'tool_use', model: req.model, messageId: `msg_b10f2_${crypto.randomUUID()}`, usage: { input_tokens: 1500, output_tokens: 300 }, simulated: false };
      },
    });
    const pendingWait = async (tag, simOpts) => {
      const q = `Rehace el video del capítulo 1 (${tag}).`;
      const sim = SIMLIB.simProviders(distRoot, simOpts);
      const svcA = new SVC.CourseWorkshopService(ds, storage, null);
      const A = new PLS.WorkshopPlanService(ds, storage, svcA, ledger, budget, regenClient('regenerate_video', 1016, q));
      A.pricingLoader = async () => DRY.seedPricing();
      A.regenProviders = () => sim;
      await approveIntake(A, q);
      const pl = await A.getPlan({ id: U }, sid);
      const it = pl.items.filter((i) => i.operation === 'regenerate_video' && i.stage === 'estimate' && i.requestStatus === 'awaiting_generation' && i.quote === q).pop();
      const cap = Math.ceil(Math.max(Number(it.plannedCall.expectedUsd) * 1.5, Number(it.plannedCall.regen.totalBoundUsd)) * 100) / 100;
      const g = await A.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap });
      const w = await until(async () => (await reqRow(A, it.id)).details.regenPending, `la espera ${tag}`);
      await until(async () => sim.calls.videogen.some((c) => c.op === 'status'), 'A consultando');
      A.simulateDeathForTests();
      await A.whenIdle();
      return { A, sim, it, g, w, pl, cap, q };
    };
    const procB = (sim, label) => { const sv = new SVC.CourseWorkshopService(ds, storage, null); const P = new PLS.WorkshopPlanService(ds, storage, sv, ledger, budget, regenClient('regenerate_video', 1016, label)); P.pricingLoader = async () => DRY.seedPricing(); P.regenProviders = () => sim; return P; };

    await check('L18 (B10 fix 2 N1) aprobación MIXTA: la cota del render que espera queda comprometida → el contenido de B5 corta con cap_reached ANTES de enviarse; tope nunca superado', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '10.00', reason: 'QA r107 B10 L18' });
      const q1 = 'Rehace el video del capítulo 1 (L18).';
      const q2 = 'Agrega un ejemplo a la profundización del capítulo 1 (L18).';
      const client = twoClient(q1, q2);
      const simOpts = { simulated: false, videogenPendingPolls: 1e9, pollTimeoutMs: 60000, videogenJobId: 'vg_sim_l18' };
      const sim = SIMLIB.simProviders(distRoot, simOpts);
      const p = planFor(client);
      p.regenProviders = () => sim;
      await approveIntake(p, `${q1} ${q2}`);
      const pl = await p.getPlan({ id: U }, sid);
      const vid = pl.items.filter((i) => i.quote === q1 && i.requestStatus === 'awaiting_generation').pop();
      const con = pl.items.filter((i) => i.quote === q2 && i.requestStatus === 'awaiting_generation').pop();
      assert(vid && con && con.stage === "estimate", `dos ítems: ${JSON.stringify(pl.items.filter((i) => [q1, q2].includes(i.quote)).map((i) => [i.operation, i.stage, i.requestStatus]))} ${JSON.stringify(pl.pending.concat(pl.excluded).map((x) => [x.quote, x.status, x.reason]).filter((x) => x[0] === q2))}`);
      const tb = Number(vid.plannedCall.regen.totalBoundUsd);
      const vb = Number(vid.plannedCall.regen.providers.find((l) => l.provider === 'videogen').boundUsd);
      const cb = Number(con.plannedCall.boundUsd);
      const exp = Number(vid.plannedCall.expectedUsd) + Number(con.plannedCall.expectedUsd);
      const cap = Math.max(tb, exp) + (vb + cb - Math.max(tb, exp)) / 2;
      assert(cap + 1e-9 >= tb && cap + 1e-9 >= exp && cap < vb + cb, `el escenario: Σ cotas video ${tb} ≤ tope ${cap} < render ${vb} + contenido ${cb}`);
      const g = await p.approveGeneration({ id: U }, sid, pl.planId, { itemIds: [vid.id, con.id], confirmEstimateUsd: Number((Number(vid.plannedCall.expectedUsd) + Number(con.plannedCall.expectedUsd)).toFixed(6)), capUsd: Number(cap.toFixed(6)) });
      await until(async () => (await reqRow(p, vid.id)).details.regenPending, 'el render esperando');
      await until(async () => (await reqRow(p, con.id)).status === 'awaiting_generation', 'el contenido cortado');
      const cr = await reqRow(p, con.id);
      eq(client.content, 0, 'el contenido NO se envió');
      assert(/tope/.test(cr.reason), `motivo visible: ${cr.reason}`);
      const ap = await p.approvalOf(g.approval.id);
      eq(Object.values(ap.calls).map((c) => [c.kind, c.status]), [['videogen:render', 'sent']], 'solo el render, en vuelo (su cota comprometida)');
      simOpts.videogenPendingPolls = 0;
      await p.whenIdle();
      const ap2 = await p.approvalOf(g.approval.id);
      assert(Number(ap2.spent_usd) <= Number(ap2.cap_usd) + 1e-9, `gastado ${ap2.spent_usd} ≤ tope ${ap2.cap_usd}`);
      eq([ap2.status, (await reqRow(p, vid.id)).status], ['stopped', 'resolved'], 'el video terminó; la aprobación queda cortada por el tope del contenido');
    });

    await check('L19 (B10 fix 2 N2) dos procesos liquidan la MISMA espera: uno solo la toma (el otro no consulta), un solo cargo, una sola subida a YouTube, un solo resultado; `sent → settling` condicional', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '10.00', reason: 'QA r107 B10 L19' });
      const { it, g, w } = await pendingWait('L19', { simulated: false, videogenPendingPolls: 1e9, pollTimeoutMs: 60000, videogenJobId: 'vg_sim_l19' });
      const simB = SIMLIB.simProviders(distRoot, { simulated: false, videogenJobId: 'vg_sim_l19' });
      const simC = SIMLIB.simProviders(distRoot, { simulated: false, videogenJobId: 'vg_sim_l19' });
      const B = procB(simB, 'b'); const C = procB(simC, 'c');
      const before = Number((await B.approvalOf(g.approval.id)).spent_usd);
      const reqId = (await reqRow(B, it.id)).id;
      const errs = await Promise.all([B.settleWaitForTests(sid, reqId), C.settleWaitForTests(sid, reqId)].map((x) => x.then(() => null, (e) => e)));
      eq(errs, [null, null], 'ninguno falla');
      const statusB = simB.calls.videogen.filter((c) => c.op === 'status').length;
      const statusC = simC.calls.videogen.filter((c) => c.op === 'status').length;
      eq([statusB > 0, statusC > 0].filter(Boolean).length, 1, `uno solo tomó la espera (consultas B ${statusB}, C ${statusC})`);
      await B.whenIdle(); await C.whenIdle();
      const ap = await B.approvalOf(g.approval.id);
      const vg = Object.values(ap.calls).filter((c) => c.kind === 'videogen:render');
      eq(vg.map((c) => c.status), ['charged'], 'el render liquidado una vez');
      near(Number(ap.spent_usd) - before, Object.values(ap.calls).filter((c) => c.status === 'charged').reduce((a, c) => a + Number(c.costUsd), 0), 'un solo cargo en spent_usd por llamada');
      eq(simB.calls.youtube.length + simC.calls.youtube.length, 1, 'una sola subida a YouTube');
      const arts = await ds.query(`select count(*)::int n from public.artifacts where type = 'workshop_regen_result' and metadata->>'approvalId' = $1`, [g.approval.id]);
      eq(arts[0].n, 1, 'un solo resultado');
      const rows = await ds.query(`select count(*)::int n from public.generation_cost_events where provider = 'videogen' and metadata->>'approvalId' = $1 and coalesce(metadata->>'reservation','') <> 'true'`, [g.approval.id]);
      eq(rows[0].n, 1, 'un solo cargo de Videogen en el ledger');
      eq([(await reqRow(B, it.id)).status, ap.status], ['resolved', 'done'], 'ítem listo, aprobación cerrada');
      assert(w.externalId === 'vg_sim_l19', 'mismo id externo');
      // La transición `sent → settling` en sí: dos procesos a la vez → la gana UNO.
      const s = await svc.planSessionById(sid);
      const ap0 = await B.openApproval(s, { id: U }, { kind: 'generate', estimate: B.estimateOf([], 'L19'), capUsd: '0.100000' });
      await B.startApproval(ap0.id);
      const gate = B.regenGateFor(s, await B.approvalOf(ap0.id), false);
      const t = await gate.begin({ provider: 'gamma', kind: 'generate', boundUsd: '0.050000', attempt: 1 });
      const wins = await Promise.all([B.claimSettle(ap0.id, t.id, 'claim-b', null), C.claimSettle(ap0.id, t.id, 'claim-c', null)]);
      eq(wins.filter(Boolean).length, 1, 'una sola gana `settling`');
      await t.charged({ costUsd: '0.040000', charge: null });
      let again = null; try { await t.charged({ costUsd: '0.040000', charge: null }); } catch (e) { again = e; }
      assert(again && again.extra && again.extra.alreadySettled, 'liquidar dos veces no suma');
      near((await B.approvalOf(ap0.id)).spent_usd, 0.04, 'una vez en spent_usd');
      await B.closeApproval(ap0.id, 'done', null);
    });

    await check('L20 (B10 fix 2 N3) retoma fallida sin cobro → el pago intermedio se descarta; conciliar → re-aprobar → produce (sin quedar `preparing`); un job aceptado sin espera ni conciliación falla CERRADO y visible', async () => {
      await admin.adjust(sa, U, { month: BCOM.currentMonth(), amountUsd: '10.00', reason: 'QA r107 B10 L20' });
      const { it, g, w, pl, cap } = await pendingWait('L20', { simulated: false, videogenPendingPolls: 1e9, pollTimeoutMs: 60000, videogenJobId: 'vg_sim_l20' });
      // La llamada deja de estar en vuelo sin cobro conocido (p. ej. la aprobación se cerró ambigua) y el reclamo murió.
      await ds.query(`update public.workshop_ai_approvals set calls = jsonb_set(calls, array[$2::text, 'status'], '"ambiguous"'::jsonb), status = 'ambiguous', updated_at = now() - interval '2 minutes' where id = $1`, [g.approval.id, w.callId]);
      await ds.query(`update public.workshop_requests set updated_at = now() - interval '2 minutes' where id = (select request_id from public.workshop_plan_items where id = $1)`, [it.id]);
      const simB = SIMLIB.simProviders(distRoot, { simulated: false, videogenJobId: 'vg_sim_l20b' });
      const B = procB(simB, 'Rehace el video del capítulo 1 (L20).');
      await B.sweep(); await B.whenIdle();
      let rq = await reqRow(B, it.id);
      eq([rq.status, rq.details.regenPending ?? null, rq.details.regenPaid.videogen, rq.details.regenAmbiguous.externalId], ['awaiting_generation', null, null, 'vg_sim_l20'], 'espera cerrada, pago intermedio descartado, pendiente de conciliación');
      const again = { itemIds: [it.id], confirmEstimateUsd: Number(it.plannedCall.expectedUsd), capUsd: cap };
      eq(await errCode(B.approveGeneration({ id: U }, sid, pl.planId, again)), 'WORKSHOP_REGEN_PENDING_PROVIDER', 'sin conciliar → 409');
      await ctl.reconcileWorkshopReservation({ reservationKey: `workshop:approval:${g.approval.id}`, outcome: 'not_charged', reason: 'Videogen no muestra el render' }, saUser);
      const g2 = await B.approveGeneration({ id: U }, sid, pl.planId, again);
      await B.whenIdle();
      rq = await reqRow(B, it.id);
      eq([rq.status, (await B.approvalOf(g2.approval.id)).status, simB.calls.videogen.filter((c) => c.op === 'create').length], ['resolved', 'done', 1], 'conciliada → re-aprobada → producida (render nuevo)');
      // priorOf: un job aceptado SIN liquidar y SIN espera.
      const q2 = 'Rehace el video del capítulo 1 (L20b).';
      const P2 = procB(simB, q2);
      await approveIntake(P2, q2);
      const pl2 = await P2.getPlan({ id: U }, sid);
      const it2 = pl2.items.filter((i) => i.quote === q2 && i.requestStatus === 'awaiting_generation').pop();
      const mod = { originalSha1: (await svc.planSessionById(sid)).originalSha1, operation: 'regenerate_video', moduleId: 1016 };
      const setPaid = (approvalId) => ds.query(`update public.workshop_requests set details = details || jsonb_build_object('regenPaid', $2::jsonb) where id = (select request_id from public.workshop_plan_items where id = $1)`, [it2.id, JSON.stringify({ ...mod, videogen: { jobId: 'vg_huerfano', charged: false, callId: 'x', approvalId } })]);
      // (a) sin conciliar (la aprobación de L16, cerrada `done`) → falla cerrado y visible, no queda `preparing`.
      await setPaid(g2.approval.id);
      const creates0 = simB.calls.videogen.filter((c) => c.op === 'create').length;
      const opts2 = { itemIds: [it2.id], confirmEstimateUsd: Number(it2.plannedCall.expectedUsd), capUsd: cap };
      await P2.approveGeneration({ id: U }, sid, pl2.planId, opts2); await P2.whenIdle();
      rq = await reqRow(P2, it2.id);
      eq([rq.status, rq.details.regenAmbiguous && rq.details.regenAmbiguous.externalId, simB.calls.videogen.filter((c) => c.op === 'create').length - creates0], ['awaiting_generation', 'vg_huerfano', 0], 'falla cerrado: visible, sin reenviar');
      assert(/conciliaci/.test(rq.reason), `motivo: ${rq.reason}`);
      // (b) conciliado `not_charged` → se vuelve a enviar y produce.
      await setPaid(g.approval.id);
      await ds.query(`update public.workshop_requests set details = details - 'regenAmbiguous' where id = $1`, [rq.id]);
      await P2.approveGeneration({ id: U }, sid, pl2.planId, opts2); await P2.whenIdle();
      rq = await reqRow(P2, it2.id);
      eq([rq.status, simB.calls.videogen.filter((c) => c.op === 'create').length - creates0], ['resolved', 1], 'conciliado not_charged → reenvía y produce');
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
