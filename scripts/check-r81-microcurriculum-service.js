#!/usr/bin/env node
/* eslint-disable */
// r81 · «Crear microcurrículo» — persistencia, cuota, generación y controlador contra el código COMPILADO en dist/.
// USD 0: Postgres 16 local DESCARTABLE (PG_BIN) + generador FALSO inyectado (sin red, sin proveedores) + ledger falso.
//
//   MS1  migración aditiva e idempotente (dos veces); el script se niega sin MIGRATION_ENV=staging
//   MS2  flag apagado → 404 en todo salvo /quota ({ enabled: false })
//   MS3  CRUD por dueño: crear (respuestas normalizadas), leer, listar sin documento, PATCH reemplaza respuestas, borrar; ajeno → 404
//   MS4  generar: obligatorias faltantes → 400 ANSWERS_INCOMPLETE con `missing`; éxito → generated, issues [], costo,
//        ledger `llm.microcurriculo` (sin atribuir, billingAccount cursia), generación `succeeded`
//   MS5  salida inválida (max_tokens / sin tool_use) → reintento → ok; errores no aritméticos → reintento con la lista;
//        persisten → generated CON issues visibles (nunca éxito silencioso); se queda con el de menos errores
//   MS6  reparación aritmética en la generación: horas desbalanceadas → repairs registradas, sin reintento
//   MS7  proveedor caído (segundo plano) → failed + lastError GENERATION_FAILED, cupo LIBERADO; inservible ×2 → failed
//   MS8  cuota: 10/mes → 429 QUOTA_EXHAUSTED con resetsAt (1.º del mes siguiente UTC); mes siguiente → cupo nuevo;
//        superadmin sin límite; borrar no devuelve cupo; MICROCURRICULUM_MONTHLY_LIMIT configurable
//   MS9  regenerar sección: requiere generado (409), ×3 → 429 REGEN_EXHAUSTED; una falla no consume; resto fijo
//   MS10 PATCH del documento: procedencia docente, issues recalculados en el servidor sin IA; identificación → respuestas
//   MS11 asíncrono: 202 inmediato con status generating, sondeo GET /:id hasta generated; 2.ª generación / PATCH → 409
//   MS11b generación interrumpida (> 6 min) → GET/lista/cupo la marcan fallida con lastError y liberan la reserva
//   MS12 kill switch de FinOps → 503 con su código, SIN reserva ni llamada
//   MS13 PDF (nombre microcurriculo-<slug>.pdf) y /academic-context (forma válida); sin documento → 409
//   MS14 controlador: rutas del contrato con @AuthenticatedOnly + SupabaseJwtGuard; el filtro reenvía missing/resetsAt
//
// Uso: node scripts/check-r81-microcurriculum-service.js [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const D = (rel) => {
  try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
};
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const clone = (x) => JSON.parse(JSON.stringify(x));
async function rejects(p, status, code, m) {
  try { await p; } catch (err) {
    const st = err && err.getStatus ? err.getStatus() : null;
    const body = err && err.getResponse ? err.getResponse() : null;
    assert(st === status, `${m || ''}: status ${st} (esperado ${status}) — ${err && err.message}`);
    if (code) assert(body && body.code === code, `${m || ''}: code ${body && body.code} (esperado ${code})`);
    return body;
  }
  throw new Error(`${m || ''}: se esperaba un error ${status}${code ? ` ${code}` : ''}`);
}

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function cleanEnv() { return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }; }

const FIX_DIR = path.join(REPO, 'scripts/fixtures/microcurriculum/r81');
const FIX = (k) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${k}.json`), 'utf8'));

(async () => {
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const S = D('modules/microcurriculum/microcurriculum.service.js');
  const ACX = D('modules/academic-context/academic-context.js');
  const A_norm = (x) => D('modules/microcurriculum/answers.js').normalizeAnswers(JSON.parse(JSON.stringify(x)));

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r81-pg16-'));
  const DB = 'r81db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const ENV_KEYS = ['MICROCURRICULUM_ENABLED', 'MICROCURRICULUM_MONTHLY_LIMIT', 'MICROCURRICULUM_REGEN_LIMIT', 'SUPER_ADMIN_EMAILS', 'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST', 'MICROCURRICULUM_MODEL'];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
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
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    const SQL = fs.readFileSync(path.join(REPO, 'supabase-migration-r81-microcurricula.sql'), 'utf8');

    await check('MS1 migración aditiva e idempotente (dos veces, con roles de Supabase); el script se niega sin MIGRATION_ENV=staging', async () => {
      await withClient(DB, async (c) => {
        await c.query(`create role anon nologin; create role authenticated nologin; create table public.user_settings (user_id uuid primary key, logo_b64 text)`);
        await c.query(SQL);
        await c.query(SQL);
        const t = await c.query(`select relname, relrowsecurity from pg_class where relname in ('microcurricula','microcurriculum_generations') order by relname`);
        eq(t.rows.map((x) => [x.relname, x.relrowsecurity]), [['microcurricula', true], ['microcurriculum_generations', true]]);
        const g = await c.query(`select has_table_privilege('authenticated', 'public.microcurricula', 'select') as a`);
        eq(g.rows[0].a, false, 'sin acceso para authenticated');
      });
      const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/migrate-r81-microcurricula.js')], { env: { ...cleanEnv(), DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'postgres', DB_NAME: DB }, encoding: 'utf8', cwd: os.tmpdir() });
      assert(res.status !== 0 && /MIGRATION_ENV/.test(res.stderr), `debió negarse: ${res.status} ${res.stderr}`);
    });

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();

    const OWNER = { id: '11111111-2222-4333-8444-555555555555', email: 'docente@ejemplo.edu' };
    const OTHER = { id: '99999999-8888-4777-8666-555555555555', email: 'otra@ejemplo.edu' };
    const ADMIN = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'owner@cursia.test' };
    const charges = [];
    const ledger = { recordCharge: async (x) => { charges.push(x); return { inserted: true, event: {} }; } };
    // Generador falso: cola de respuestas (objeto | función | Error); registra cada petición.
    const gen = { queue: [], calls: [], delayMs: 0 };
    let msg = 0;
    const generator = {
      async generate(req) {
        gen.calls.push(req);
        if (gen.delayMs) await new Promise((r) => setTimeout(r, gen.delayMs));
        const next = gen.queue.length ? gen.queue.shift() : null;
        if (next instanceof Error) throw next;
        const input = typeof next === 'function' ? next(req) : next;
        if (input && input.__raw) return input.__raw;
        msg++;
        return { input, stopReason: 'tool_use', model: req.model, messageId: `msg_fake_${msg}`, usage: { input_tokens: 6000, output_tokens: 5000 } };
      },
    };
    const svc = new S.MicrocurriculumService(ds, ledger, generator);
    const ANS = (k) => FIX(k).answers;
    const TOOL = (k) => clone(FIX(k).tool);
    /** POST …/generate (202 → generating) + esperar el segundo plano + sondear GET /:id. */
    const G = async (actor, id) => {
      const r = await svc.generate(actor, id);
      assert(r.status === 'generating', `202 con status generating (fue ${r.status})`);
      await svc.whenIdle();
      return svc.get(actor, id);
    };
    const R = async (actor, id, section) => {
      const r = await svc.regenerate(actor, id, section);
      assert(r.status === 'generating' && r.pendingSection === section && !!r.document, 'regenerando: documento vigente visible + pendingSection');
      await svc.whenIdle();
      return svc.get(actor, id);
    };
    const reset = () => { gen.queue = []; gen.calls = []; gen.delayMs = 0; charges.length = 0; };
    const genRows = async (owner) => ds.query(`select kind, section, status, cost_usd::float as cost from public.microcurriculum_generations where owner_id = $1 order by id`, [owner]);

    await check('MS2 flag apagado → /quota { enabled:false }; listar, crear, leer, generar → 404', async () => {
      eq(await svc.quota(OWNER), { enabled: false });
      await rejects(svc.list(OWNER), 404);
      await rejects(svc.create(OWNER, {}), 404);
      await rejects(svc.get(OWNER, '11111111-2222-4333-8444-555555555555'), 404);
      await rejects(svc.generate(OWNER, '11111111-2222-4333-8444-555555555555'), 404);
      process.env.MICROCURRICULUM_ENABLED = 'yes';
      await rejects(svc.list(OWNER), 404, null, 'solo el string exacto «true»');
    });
    process.env.MICROCURRICULUM_ENABLED = 'true';

    let draftId = null;
    await check('MS3 CRUD por dueño: crear normaliza y titula; leer; listar sin documento; PATCH por paso; ajeno e id inválido → 404', async () => {
      const a = ANS('universidad');
      const rec = await svc.create(OWNER, { identification: { courseName: '  Finanzas Corporativas ', institutionType: 'universidad' }, contents: { requiredTopics: ['Flujo de caja', 'flujo de caja'] } });
      draftId = rec.id;
      eq([rec.status, rec.title, rec.answers.contents.requiredTopics, rec.document, rec.issues, rec.regenCount, rec.regenLimit], ['draft_answers', 'Finanzas Corporativas', ['Flujo de caja'], null, [], 0, 3]);
      const p = await svc.update(OWNER, draftId, { answers: { identification: { courseName: 'Finanzas Corporativas', institutionType: 'universidad' }, learners: a.learners, purpose: a.purpose } });
      eq(p.answers.learners.profile, a.learners.profile, 'paso nuevo');
      const p2 = await svc.update(OWNER, draftId, { answers: { identification: p.answers.identification, learners: a.learners, purpose: a.purpose, time: { mode: 'credits', credits: 3 } } });
      eq([p2.answers.contents, p2.answers.time], [undefined, { mode: 'credits', credits: 3 }], 'las respuestas COMPLETAS reemplazan (sin mezclar)');
      const list = await svc.list(OWNER);
      eq(list.items.map((x) => [x.id, x.title, x.document, x.status]), [[draftId, 'Finanzas Corporativas', null, 'draft_answers']]);
      await rejects(svc.get(OTHER, draftId), 404, null, 'ajeno');
      await rejects(svc.update(OTHER, draftId, { answers: {} }), 404, null, 'PATCH ajeno');
      await rejects(svc.get(OWNER, 'no-es-uuid'), 404, null, 'id inválido');
      eq((await svc.list(OTHER)).items, [], 'lista ajena vacía');
      const tmp = await svc.create(OWNER, {});
      eq(tmp.title, 'Microcurrículo sin título');
      eq(await svc.remove(OWNER, tmp.id), { ok: true });
      await rejects(svc.get(OWNER, tmp.id), 404, null, 'borrado');
    });

    await check('MS4 generar: incompleto → 400 ANSWERS_INCOMPLETE con missing (sin llamada); completo → generated, issues [], costo, ledger y generación succeeded', async () => {
      reset();
      const body = await rejects(svc.generate(OWNER, draftId), 400, 'ANSWERS_INCOMPLETE');
      eq(body.missing, ['contents.requiredTopics', 'methodology.strategies'], 'faltan');
      eq(gen.calls.length, 0, 'sin llamada');
      await svc.update(OWNER, draftId, { answers: ANS('universidad') });
      gen.queue.push(TOOL('universidad'));
      const rec = await G(OWNER, draftId);
      eq([rec.status, rec.issues, rec.document.identification.courseName, rec.document.repairs], ['generated', [], 'Finanzas Corporativas', []]);
      eq(gen.calls.length, 1, 'una llamada');
      eq(gen.calls[0].tool.name, 'emit_microcurriculum');
      eq(gen.calls[0].model, 'claude-sonnet-4-6');
      eq(gen.calls[0].maxTokens, 12000);
      assert(gen.calls[0].user.includes('EXACTAMENTE 144 h'), 'restricciones');
      eq(rec.costUsd, 0.093, 'costo estimado 6000×3 + 5000×15 por MTok');
      eq(charges.length, 1);
      eq([charges[0].operation, charges[0].provider, charges[0].billingAccount, charges[0].unattributedReason, charges[0].attributionCourseId, charges[0].externalOperationId, charges[0].metadata.kind],
        ['llm.microcurriculo', 'anthropic', 'cursia', 'microcurriculo', null, 'msg_fake_1', 'microcurriculum']);
      eq((await genRows(OWNER.id)).map((g) => [g.kind, g.status]), [['generate', 'succeeded']]);
      eq((await svc.quota(OWNER)).used, 1);
    });

    await check('MS5 salida inválida (max_tokens, luego sin tool_use) cuenta para el reintento; errores no aritméticos → reintento con la lista; persisten → generated con issues', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('tecnica'));
      gen.queue.push({ __raw: { input: TOOL('tecnica'), stopReason: 'max_tokens', model: 'claude-sonnet-4-6', messageId: 'msg_cut', usage: { input_tokens: 6000, output_tokens: 12000 } } });
      gen.queue.push(TOOL('tecnica'));
      const rec = await G(OWNER, d.id);
      eq([rec.status, rec.issues.length, gen.calls.length, charges.length], ['generated', 0, 2, 2], 'cortada → reintento ok');
      assert(/se cortó por longitud/.test(gen.calls[1].user), 'el reintento explica el problema');

      reset();
      const d2 = await svc.create(OWNER, ANS('tecnica'));
      const bad = TOOL('tecnica'); bad.outcomes[0].verb = 'comprender'; // V6: no aritmético
      gen.queue.push(bad, TOOL('tecnica'));
      const r2 = await G(OWNER, d2.id);
      eq([r2.status, r2.issues, gen.calls.length], ['generated', [], 2]);
      assert(gen.calls[1].user.includes('[V6] RA1: «comprender» no es un verbo observable'), 'la lista de errores va al reintento');

      reset();
      const d3 = await svc.create(OWNER, ANS('tecnica'));
      const worse = TOOL('tecnica'); worse.outcomes[0].verb = 'comprender'; worse.outcomes[1].verb = 'conocer';
      const stillBad = TOOL('tecnica'); stillBad.outcomes[0].verb = 'comprender';
      gen.queue.push(worse, stillBad);
      const r3 = await G(OWNER, d3.id);
      eq(r3.status, 'generated', 'se entrega el borrador');
      eq(r3.issues.map((i) => i.code), ['V6'], 'issues visibles (el de menos errores)');
      eq(gen.calls.length, 2, 'un solo reintento');
      eq((await genRows(OWNER.id)).filter((g) => g.status === 'succeeded').length, 4, 'cuentan como generaciones');
    });

    await check('MS6 reparación aritmética en la generación: horas y % desbalanceados → repairs registradas, sin reintento', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('etdh'));
      const t = TOOL('etdh'); t.units[0].hours.practice = 25; t.evaluation[2].percent = 40;
      gen.queue.push(t);
      const rec = await G(OWNER, d.id);
      eq([rec.status, rec.issues, gen.calls.length], ['generated', [], 1]);
      eq(rec.document.repairs.length, 2, JSON.stringify(rec.document.repairs));
      assert(/Horas: se redistribuyeron/.test(rec.document.repairs[0]) && /Evaluación: los porcentajes sumaban 90 %/.test(rec.document.repairs[1]), rec.document.repairs.join(' | '));
      eq(rec.document.units.reduce((a, u) => a + u.hours.practice, 0), 60, 'reparto exigido');
    });

    await check('MS7 proveedor caído (en segundo plano) → failed + lastError GENERATION_FAILED, cupo liberado; salida inservible ×2 → failed igual; con documento previo no se pierde', async () => {
      reset();
      const before = (await svc.quota(OWNER)).used;
      const d = await svc.create(OWNER, ANS('colegio'));
      gen.queue.push(new Error('overloaded_error 529'));
      const f1 = await G(OWNER, d.id);
      eq([f1.status, f1.lastError && f1.lastError.code, f1.pendingSection], ['failed', 'GENERATION_FAILED', null]);
      assert(/no se descontó de tu cupo/.test(f1.lastError.message), f1.lastError.message);
      eq((await svc.quota(OWNER)).used, before, 'cupo liberado');
      reset();
      gen.queue.push({ description: 'x' }, 'texto');
      eq((await G(OWNER, d.id)).lastError.code, 'GENERATION_FAILED');
      eq(gen.calls.length, 2);
      eq(charges.length, 2, 'el gasto de las llamadas fallidas igual queda en el ledger');
      const g = await svc.get(OWNER, d.id);
      eq([g.status, g.costUsd > 0], ['failed', true]);
      eq((await svc.quota(OWNER)).used, before, 'sigue sin descontar');
      reset();
      gen.queue.push(TOOL('colegio'));
      const ok2 = await G(OWNER, d.id);
      eq([ok2.status, ok2.lastError], ['generated', null], 'reintento manual ok (lastError se limpia)');
      reset();
      gen.queue.push(new Error('timeout'));
      const kept = await G(OWNER, d.id);
      eq([kept.status, !!kept.document, kept.lastError.code], ['generated', true, 'GENERATION_FAILED'], 'una regeneración completa fallida conserva el documento anterior');
    });

    await check('MS8 cuota: 10/mes → 429 QUOTA_EXHAUSTED con resetsAt; mes siguiente → cupo nuevo; superadmin sin límite; borrar no devuelve cupo; límite por env', async () => {
      reset();
      const U = { id: '22222222-3333-4444-8555-666666666666', email: 'u@ejemplo.edu' };
      svc.now = () => new Date(Date.UTC(2026, 10, 15, 12));
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const d = await svc.create(U, ANS('corporativa'));
        ids.push(d.id);
        gen.queue.push(TOOL('corporativa'));
        await G(U, d.id);
      }
      const q = await svc.quota(U);
      eq([q.enabled, q.unlimited, q.limit, q.used, q.remaining, q.resetsAt, q.regenLimit], [true, false, 10, 10, 0, '2026-12-01T00:00:00.000Z', 3]);
      await svc.remove(U, ids[0]);
      eq((await svc.quota(U)).used, 10, 'borrar no devuelve cupo');
      const d = await svc.create(U, ANS('corporativa'));
      const callsBefore = gen.calls.length;
      const body = await rejects(svc.generate(U, d.id), 429, 'QUOTA_EXHAUSTED');
      eq(body.resetsAt, '2026-12-01T00:00:00.000Z');
      eq(gen.calls.length, callsBefore, 'sin llamada');
      eq((await svc.get(U, d.id)).status, 'draft_answers', 'el borrador no queda generando');
      svc.now = () => new Date(Date.UTC(2026, 11, 1, 0, 0, 1));
      eq((await svc.quota(U)).used, 0, 'mes nuevo UTC');
      svc.now = () => new Date(Date.UTC(2026, 10, 15, 12));
      process.env.SUPER_ADMIN_EMAILS = ADMIN.email;
      for (let i = 0; i < 11; i++) { const x = await svc.create(ADMIN, ANS('corporativa')); gen.queue.push(TOOL('corporativa')); await G(ADMIN, x.id); }
      const qa = await svc.quota(ADMIN);
      eq([qa.unlimited, qa.used], [true, 11], 'superadmin sin límite');
      delete process.env.SUPER_ADMIN_EMAILS;
      process.env.MICROCURRICULUM_MONTHLY_LIMIT = '12';
      eq((await svc.quota(U)).remaining, 2, 'límite por env');
      delete process.env.MICROCURRICULUM_MONTHLY_LIMIT;
      svc.now = () => new Date();
    });

    await check('MS9 regenerar: antes de generar → 409 NOT_GENERATED; sección inválida → 400; ×3 → 429 REGEN_EXHAUSTED; una falla no consume; resto fijo', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('universidad'));
      await rejects(svc.regenerate(OWNER, d.id, 'units'), 409, 'NOT_GENERATED');
      await rejects(svc.regenerate(OWNER, d.id, 'bibliografia'), 400);
      gen.queue.push(TOOL('universidad'));
      const g = await G(OWNER, d.id);
      const usedBefore = (await svc.quota(OWNER)).used;
      const ev = TOOL('universidad').evaluation.map((e) => ({ ...e, name: `${e.name} (nueva)` }));
      gen.queue.push({ evaluation: ev });
      const r1 = await R(OWNER, d.id, 'evaluation');
      eq([r1.regenCount, r1.document.evaluation[0].name, r1.issues], [1, 'Taller de flujo de caja (nueva)', []]);
      eq(r1.document.units, g.document.units, 'unidades intactas');
      eq(gen.calls[gen.calls.length - 1].tool.input_schema.required, ['evaluation'], 'herramienta de sección');
      gen.queue.push(new Error('overloaded'));
      const afterFail = await R(OWNER, d.id, 'outcomes');
      eq([afterFail.status, afterFail.regenCount, afterFail.lastError.code, afterFail.pendingSection], ['generated', 1, 'GENERATION_FAILED', null], 'la falla no consume');
      gen.queue.push({ outcomes: TOOL('universidad').outcomes }, { units: TOOL('universidad').units });
      await R(OWNER, d.id, 'outcomes');
      const r3 = await R(OWNER, d.id, 'units');
      eq(r3.regenCount, 3);
      await rejects(svc.regenerate(OWNER, d.id, 'units'), 429, 'REGEN_EXHAUSTED');
      eq((await svc.quota(OWNER)).used, usedBefore, 'regenerar no gasta el cupo mensual');
    });

    await check('MS10 PATCH del documento: procedencia docente, issues recalculados en el servidor sin IA; identificación → respuestas; sin documento → 409', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('universidad'));
      await rejects(svc.update(OWNER, d.id, { document: {} }), 409, 'DOCUMENT_REQUIRED');
      gen.queue.push(TOOL('universidad'));
      const g = await G(OWNER, d.id);
      reset();
      const doc = clone(g.document);
      doc.description = 'Descripción reescrita por la docente.';
      doc.evaluation[3].percent = 30;
      const p = await svc.update(OWNER, d.id, { document: doc });
      eq(gen.calls.length, 0, 'sin IA');
      eq([p.document.provenance.description, p.document.provenance.evaluation, p.document.provenance.units], ['docente', 'docente', 'cursia']);
      eq(p.issues.map((i) => i.code), ['V2'], 'franja recalculada');
      doc.evaluation[3].percent = 40;
      doc.identification.courseName = 'Finanzas Corporativas II';
      const p2 = await svc.update(OWNER, d.id, { document: doc });
      eq([p2.issues, p2.answers.identification.courseName, p2.title], [[], 'Finanzas Corporativas II', 'Finanzas Corporativas II'], 'identificación editada vuelve a las respuestas (V7 coherente)');
      await rejects(svc.update(OWNER, d.id, { document: [1] }), 400, 'DOCUMENT_INVALID');
      const full = clone(p2.answers); full.contents.requiredTopics = ['Flujo de caja', 'Opciones reales'];
      const p3 = await svc.update(OWNER, d.id, { answers: full });
      eq(p3.issues.map((i) => i.code), ['V4'], 'cambiar respuestas también revalida');
    });

    await check('MS11 asíncrono: 202 inmediato (generating) y GET sondea hasta generated; segunda generación / PATCH durante la generación → 409; respuesta antes de la llamada', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('tecnica'));
      gen.delayMs = 300;
      gen.queue.push(TOOL('tecnica'), TOOL('tecnica'));
      const t0 = Date.now();
      const first = await svc.generate(OWNER, d.id);
      assert(Date.now() - t0 < 250, `respondió sin esperar la IA (${Date.now() - t0} ms)`);
      eq([first.status, first.pendingSection, first.document], ['generating', null, null]);
      eq((await svc.get(OWNER, d.id)).status, 'generating', 'sondeo: sigue generando');
      await rejects(svc.generate(OWNER, d.id), 409, 'GENERATION_IN_PROGRESS', 'segunda');
      await rejects(svc.update(OWNER, d.id, { answers: ANS('tecnica') }), 409, 'GENERATION_IN_PROGRESS', 'PATCH');
      await svc.whenIdle();
      const done = await svc.get(OWNER, d.id);
      eq([done.status, done.issues, done.lastError, gen.calls.length], ['generated', [], null, 1], 'sondeo: generado');
      gen.delayMs = 0;
    });

    await check('MS11b generación interrumpida (proceso reiniciado; generating > 6 min) → GET/lista/cupo la dan por fallida, liberan la reserva y explican; < 6 min sigue generando', async () => {
      reset();
      const V = { id: '44444444-5555-4666-8777-888888888888', email: 'v@ejemplo.edu' };
      const d = await svc.create(V, ANS('tecnica'));
      const mark = async (min, kind = 'generate', section = null) => {
        await ds.query(`update public.microcurricula set status = 'generating', generating_since = now() - ($2 || ' minutes')::interval, pending_section = $3 where id = $1`, [d.id, String(min), section]);
        await ds.query(`insert into public.microcurriculum_generations (owner_id, microcurriculum_id, kind, section, status) values ($1, $2, $3, $4, 'reserved')`, [V.id, d.id, kind, section]);
      };
      await mark(3);
      eq([(await svc.get(V, d.id)).status, (await svc.quota(V)).used], ['generating', 1], '3 min: sigue en curso y cuenta');
      await ds.query(`update public.microcurricula set generating_since = now() - interval '7 minutes' where id = $1`, [d.id]);
      eq((await svc.quota(V)).used, 0, 'cupo: la reserva interrumpida se libera');
      const r = await svc.get(V, d.id);
      eq([r.status, r.lastError], ['failed', { code: 'GENERATION_INTERRUPTED', message: 'La generación se interrumpió; no se descontó de tu cupo.' }]);
      // regeneración interrumpida con documento: vuelve a generated y devuelve el contador
      gen.queue.push(TOOL('tecnica'));
      await G(V, d.id);
      await ds.query(`update public.microcurricula set regen_count = 1 where id = $1`, [d.id]);
      await mark(7, 'regenerate', 'units');
      const items = (await svc.list(V)).items;
      eq(items.map((x) => [x.status, x.regenCount, x.lastError && x.lastError.code]), [['generated', 0, 'GENERATION_INTERRUPTED']], 'lista recupera');
      eq((await ds.query(`select count(*)::int as n from public.microcurriculum_generations where microcurriculum_id = $1 and status = 'reserved'`, [d.id]))[0].n, 0);
      eq((await svc.quota(V)).used, 1, 'solo la generación exitosa cuenta');
    });

    await check('MS12 kill switch de FinOps → 503 con su código, SIN reserva ni llamada', async () => {
      reset();
      const d = await svc.create(OWNER, ANS('tecnica'));
      const before = (await genRows(OWNER.id)).length;
      process.env.FINOPS_KILL_SWITCH = 'true';
      const body = await rejects(svc.generate(OWNER, d.id), 503);
      assert(body.code && body.code !== 'GENERATION_FAILED', `código propio: ${body.code}`);
      delete process.env.FINOPS_KILL_SWITCH;
      eq([gen.calls.length, (await genRows(OWNER.id)).length, (await svc.get(OWNER, d.id)).status], [0, before, 'draft_answers']);
    });

    await check('MS13 PDF microcurriculo-<slug>.pdf con logo de la cuenta inválido → Cursia; /academic-context válido; sin documento → 409', async () => {
      reset();
      const OWNER = { id: '33333333-4444-4555-8666-777777777777', email: 'pdf@ejemplo.edu' }; // cupo propio
      await ds.query(`insert into public.user_settings (user_id, logo_b64) values ($1, 'data:image/png;base64,AAAA') on conflict do nothing`, [OWNER.id]);
      const d = await svc.create(OWNER, ANS('colegio'));
      await rejects(svc.pdf(OWNER, d.id), 409, 'DOCUMENT_REQUIRED');
      await rejects(svc.academicContext(OWNER, d.id), 409, 'DOCUMENT_REQUIRED');
      gen.queue.push(TOOL('colegio'));
      await G(OWNER, d.id);
      const p = await svc.pdf(OWNER, d.id);
      eq(p.filename, 'microcurriculo-ciencias-naturales-los-ecosistemas.pdf');
      assert(p.pdf.slice(0, 5).toString() === '%PDF-' && p.pdf.length > 5000, 'PDF');
      const p2 = await svc.pdf(OWNER, d.id);
      assert(Buffer.compare(p.pdf, p2.pdf) === 0, 'mismo estado → mismos bytes');
      const { context } = await svc.academicContext(OWNER, d.id);
      eq(ACX.validateAcademicContextShape(context), []);
      eq(context.identity.subjectName.value, 'Ciencias Naturales: los ecosistemas');
      await rejects(svc.pdf(OTHER, d.id), 404);
    });

    await check('MS14 controlador: rutas del contrato, @AuthenticatedOnly + SupabaseJwtGuard; el filtro de errores reenvía missing y resetsAt', async () => {
      const { MicrocurriculumController } = D('modules/microcurriculum/microcurriculum.controller.js');
      const { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } = require('@nestjs/common/constants');
      const { RequestMethod } = require('@nestjs/common');
      eq(Reflect.getMetadata(PATH_METADATA, MicrocurriculumController), 'microcurricula');
      const guards = Reflect.getMetadata(GUARDS_METADATA, MicrocurriculumController) || [];
      assert(guards.some((g) => g && g.name === 'SupabaseJwtGuard'), 'SupabaseJwtGuard');
      const keys = Reflect.getMetadataKeys(MicrocurriculumController);
      assert(keys.some((k) => String(k).includes('authenticated')), `marca AuthenticatedOnly: ${keys.join(',')}`);
      const proto = MicrocurriculumController.prototype;
      const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').map((n) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[n])]} ${Reflect.getMetadata(PATH_METADATA, proto[n])}`).sort();
      eq(routes, ['DELETE :id', 'GET /', 'GET :id', 'GET :id/academic-context', 'GET :id/pdf', 'GET quota', 'PATCH :id', 'POST /', 'POST :id/generate', 'POST :id/regenerate'].sort());
      const { HTTP_CODE_METADATA } = require('@nestjs/common/constants');
      eq([Reflect.getMetadata(HTTP_CODE_METADATA, proto.generate), Reflect.getMetadata(HTTP_CODE_METADATA, proto.regenerate)], [202, 202], 'generar/regenerar → 202');
      const { AllExceptionsFilter } = D('common/filters/http-exception.filter.js');
      const { HttpException } = require('@nestjs/common');
      let sent = null;
      const host = { switchToHttp: () => ({ getResponse: () => ({ status: () => ({ json: (b) => { sent = b; } }) }), getRequest: () => ({ url: '/api/v1/microcurricula/x/generate', method: 'POST' }) }) };
      new AllExceptionsFilter().catch(new HttpException({ code: 'QUOTA_EXHAUSTED', message: 'cupo', resetsAt: '2026-12-01T00:00:00.000Z' }, 429), host);
      eq([sent.statusCode, sent.code, sent.error, sent.resetsAt], [429, 'QUOTA_EXHAUSTED', 'cupo', '2026-12-01T00:00:00.000Z']);
      new AllExceptionsFilter().catch(new HttpException({ code: 'ANSWERS_INCOMPLETE', message: 'faltan', missing: ['learners.profile'] }, 400), host);
      eq([sent.code, sent.missing], ['ANSWERS_INCOMPLETE', ['learners.profile']]);
    });

    await check('MS15 DTOs con el ValidationPipe global (whitelist + forbidNonWhitelisted): respuestas completas y documento pasan; > 2 000 caracteres → 400; null = «Que Cursia lo proponga»', async () => {
      const { ValidationPipe } = require('@nestjs/common');
      const dto = D('modules/microcurriculum/dto/microcurriculum.dto.js');
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
      const run = (body, metatype) => pipe.transform(body, { type: 'body', metatype });
      for (const k of ['universidad', 'tecnica', 'etdh', 'colegio', 'corporativa']) {
        const r = await run({ answers: ANS(k) }, dto.CreateMicrocurriculumDto);
        eq(A_norm(r.answers), A_norm(ANS(k)), `respuestas ${k} intactas`);
      }
      const r2 = await run({ document: TOOL('universidad') }, dto.UpdateMicrocurriculumDto);
      eq(Object.keys(r2.document).length, 13, 'documento sin recortar');
      await rejects(run({ answers: { identification: { courseName: 'x'.repeat(2001) } } }, dto.UpdateMicrocurriculumDto), 400);
      await rejects(run({ answers: { contents: { requiredTopics: Array.from({ length: 41 }, (_, i) => `t${i}`) } } }, dto.UpdateMicrocurriculumDto), 400);
      await rejects(run({ answers: { time: { totalHours: 1001 } } }, dto.UpdateMicrocurriculumDto), 400);
      await rejects(run({ answers: { otra: 1 } }, dto.UpdateMicrocurriculumDto), 400);
      await rejects(run({ answers: { methodology: { strategies: ['proyectos', 'gamificación'] } } }, dto.UpdateMicrocurriculumDto), 400, null, 'estrategia fuera del set del spec');
      await run({ answers: { methodology: { strategies: ['proyectos', 'casos', 'talleres', 'magistral', 'aula invertida', 'ABP', 'laboratorio', 'salidas de campo'] } } }, dto.UpdateMicrocurriculumDto);
      await run({ answers: { time: { totalHours: null, split: { contact: null } }, contents: { unitCount: null }, identification: { modality: '' } } }, dto.UpdateMicrocurriculumDto);
      // review P2-6: '' en un número es «vacío» (undefined), NUNCA 0; un texto numérico se convierte
      const e = await run({ answers: { time: { totalHours: '', split: { contact: '', practice: '12,5' } }, contents: { unitCount: '' } } }, dto.UpdateMicrocurriculumDto);
      eq([e.answers.time.totalHours, e.answers.time.split.contact, e.answers.time.split.practice, e.answers.contents.unitCount], [undefined, undefined, 12.5, undefined]);
      eq(A_norm(e.answers).time, { split: { practice: 12.5 } }, 'sin «0 h» exigidas');
      await rejects(run({ answers: { time: { totalHours: 'muchas' } } }, dto.UpdateMicrocurriculumDto), 400);
      await rejects(run({ section: 'bibliografia' }, dto.RegenerateSectionDto), 400);
    });

    await check('MS16 (review P1-1) el reintento falla (529) tras un 1.er intento usable con V6 → se guarda ESE documento con sus issues (generated), no failed', async () => {
      reset();
      const W = { id: '55555555-6666-4777-8888-999999999999', email: 'w@ejemplo.edu' };
      const d = await svc.create(W, ANS('tecnica'));
      const bad = TOOL('tecnica'); bad.outcomes[0].verb = 'comprender';
      gen.queue.push(bad, new Error('529 overloaded'));
      const r = await G(W, d.id);
      eq([r.status, r.issues.map((i) => i.code), r.lastError, gen.calls.length, (await svc.quota(W)).used], ['generated', ['V6'], null, 2, 1]);
    });

    await check('MS17 (review P1-3) /academic-context con un documento de forma inválida → 409 DOCUMENT_INVALID con issues (nunca 500); el filtro reenvía issues', async () => {
      reset();
      const W = { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', email: 'w2@ejemplo.edu' };
      const d = await svc.create(W, ANS('universidad'));
      gen.queue.push(TOOL('universidad'));
      await G(W, d.id);
      await ds.query(`update public.microcurricula set document = jsonb_set(document, '{units,1,id}', '"U1"') where id = $1`, [d.id]);
      const body = await rejects(svc.academicContext(W, d.id), 409, 'DOCUMENT_INVALID');
      assert(Array.isArray(body.issues) && body.issues.some((i) => i.code === 'V8' && /Id repetido: U1/.test(i.message)), JSON.stringify(body.issues));
      await ds.query(`update public.microcurricula set document = jsonb_set(document, '{units,1,id}', '"U2"') where id = $1`, [d.id]);
      await ds.query(`update public.microcurricula set document = jsonb_set(document, '{units,0,hours,contact}', '9000') where id = $1`, [d.id]);
      const b2 = await rejects(svc.academicContext(W, d.id), 409, 'DOCUMENT_INVALID');
      assert(b2.issues.length > 0, 'con comprobaciones');
      const { AllExceptionsFilter } = D('common/filters/http-exception.filter.js');
      const { ConflictException } = require('@nestjs/common');
      let sent = null;
      const host = { switchToHttp: () => ({ getResponse: () => ({ status: () => ({ json: (x) => { sent = x; } }) }), getRequest: () => ({ url: '/x', method: 'GET' }) }) };
      new AllExceptionsFilter().catch(new ConflictException({ code: 'DOCUMENT_INVALID', message: 'm', issues: b2.issues }), host);
      eq([sent.statusCode, sent.code, sent.issues.length], [409, 'DOCUMENT_INVALID', b2.issues.length]);
    });

    await check('MS18 (review P2-1) regenerar «outcomes» con un V2 del docente en evaluación: sin reintento por lo fijo, % del docente intactos, V2 visible, historial de reparaciones conservado', async () => {
      reset();
      const W = { id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb', email: 'w3@ejemplo.edu' };
      const d = await svc.create(W, ANS('etdh'));
      const t = TOOL('etdh'); t.units[0].hours.practice = 25;
      gen.queue.push(t);
      const g = await G(W, d.id);
      eq(g.document.repairs.length, 1, 'una reparación previa');
      const doc = clone(g.document); doc.evaluation[0].percent = 20;
      await svc.update(W, d.id, { document: doc });
      reset();
      gen.queue.push({ outcomes: TOOL('etdh').outcomes });
      const r = await R(W, d.id, 'outcomes');
      eq(gen.calls.length, 1, 'sin reintento por un error fuera de la sección');
      eq(r.document.evaluation.map((e) => e.percent), [20, 25, 50], 'los % del docente no se reescalan');
      eq(r.issues.map((i) => i.code), ['V2'], 'queda visible');
      eq(r.document.repairs, g.document.repairs, 'historial conservado');
      eq(r.document.provenance.evaluation, 'docente');
    });

    await check('MS19 (review P2-3) la generación usa las respuestas leídas BAJO el lock (no la lectura previa)', async () => {
      reset();
      const W = { id: '88888888-9999-4aaa-8bbb-cccccccccccc', email: 'w4@ejemplo.edu' };
      const d = await svc.create(W, ANS('corporativa'));
      const orig = svc.recoverStale.bind(svc);
      svc.recoverStale = async (owner, id) => {
        // Un PATCH de otra pestaña entra entre la lectura previa y la reserva.
        await ds.query(`update public.microcurricula set answers = jsonb_set(answers, '{identification,courseName}', '"Liderazgo remoto v2"') where id = $1`, [d.id]);
        return orig(owner, id);
      };
      gen.queue.push(TOOL('corporativa'));
      try { await G(W, d.id); } finally { svc.recoverStale = orig; }
      assert(gen.calls[0].user.includes('Liderazgo remoto v2'), 'prompt con la instantánea bajo lock');
      eq((await svc.get(W, d.id)).document.identification.courseName, 'Liderazgo remoto v2');
    });

    await check('MS20 (review P2-4/P2-5) DELETE durante la generación → 409; una reserva huérfana de OTRO borrador no da un 429 falso', async () => {
      reset();
      const W = { id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', email: 'w5@ejemplo.edu' };
      const a = await svc.create(W, ANS('tecnica'));
      gen.delayMs = 200; gen.queue.push(TOOL('tecnica'));
      await svc.generate(W, a.id);
      await rejects(svc.remove(W, a.id), 409, 'GENERATION_IN_PROGRESS');
      await svc.whenIdle(); gen.delayMs = 0;
      process.env.MICROCURRICULUM_MONTHLY_LIMIT = '2';
      const b = await svc.create(W, ANS('tecnica'));
      await ds.query(`update public.microcurricula set status = 'generating', generating_since = now() - interval '7 minutes' where id = $1`, [b.id]);
      await ds.query(`insert into public.microcurriculum_generations (owner_id, microcurriculum_id, kind, status) values ($1, $2, 'generate', 'reserved')`, [W.id, b.id]);
      const c = await svc.create(W, ANS('tecnica'));
      gen.queue.push(TOOL('tecnica'));
      eq((await G(W, c.id)).status, 'generated', 'la huérfana de b se libera antes de contar');
      delete process.env.MICROCURRICULUM_MONTHLY_LIMIT;
    });

    await check('MS21 (review P2-7) flag apagado: el guard da 404 ANTES de los pipes (cualquier ruta salvo quota); está en los guards del controlador', async () => {
      const { MicrocurriculumFlagGuard } = D('modules/microcurriculum/microcurriculum-flag.guard.js');
      const { MicrocurriculumController } = D('modules/microcurriculum/microcurriculum.controller.js');
      const { GUARDS_METADATA } = require('@nestjs/common/constants');
      const guards = Reflect.getMetadata(GUARDS_METADATA, MicrocurriculumController) || [];
      eq(guards.map((g) => g.name), ['SupabaseJwtGuard', 'MicrocurriculumFlagGuard']);
      const ctx = (name) => ({ getHandler: () => MicrocurriculumController.prototype[name] });
      const g = new MicrocurriculumFlagGuard();
      process.env.MICROCURRICULUM_ENABLED = 'false';
      try {
        for (const h of ['create', 'regenerate', 'update', 'get', 'list', 'pdf']) {
          let st = null; try { g.canActivate(ctx(h)); } catch (e) { st = e.getStatus(); }
          eq(st, 404, h);
        }
        eq(g.canActivate(ctx('quota')), true, 'quota pasa');
      } finally { process.env.MICROCURRICULUM_ENABLED = 'true'; }
      eq(g.canActivate(ctx('create')), true, 'flag encendido pasa');
    });

    await check('MS22 (review P2-8) control de gasto en segundo plano → lastError genérico para el docente (sin variables internas)', async () => {
      reset();
      const W = { id: 'aaaaaaaa-1111-4222-8333-444444444444', email: 'w6@ejemplo.edu' };
      const d = await svc.create(W, ANS('tecnica'));
      const { ServiceUnavailableException } = require('@nestjs/common');
      gen.queue.push(new ServiceUnavailableException({ code: 'finops_kill_switch', message: 'el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) está activo' }));
      const r = await G(W, d.id);
      eq([r.status, r.lastError.code], ['failed', 'GENERATION_FAILED']);
      eq(r.lastError.message, S.AI_UNAVAILABLE_MESSAGE);
      assert(!/FINOPS|ALLOWLIST/i.test(r.lastError.message), 'sin detalles internos');
    });

    await check('MS23 (review P2-13) una generación COMPLETA exitosa reinicia las regeneraciones (regenCount → 0)', async () => {
      reset();
      const W = { id: 'bbbbbbbb-1111-4222-8333-444444444444', email: 'w7@ejemplo.edu' };
      const d = await svc.create(W, ANS('universidad'));
      gen.queue.push(TOOL('universidad'), { evaluation: TOOL('universidad').evaluation }, { evaluation: TOOL('universidad').evaluation });
      await G(W, d.id);
      await R(W, d.id, 'evaluation');
      eq((await R(W, d.id, 'evaluation')).regenCount, 2);
      gen.queue.push(TOOL('universidad'));
      eq((await G(W, d.id)).regenCount, 0);
    });
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${ok} OK, ${fail} fallidas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
