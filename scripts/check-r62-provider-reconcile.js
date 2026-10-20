#!/usr/bin/env node
/* eslint-disable */
// r62 (N2) — conciliación AUTOMÁTICA de Videogen / Gamma con la evidencia del proveedor + reenvío acotado
// (d4, d5, d13, c2, c3; REGLA DE AMBIGÜEDAD ACOTADA). USD 0: PG16 desechable con las migraciones del repo, Videogen y
// Gamma FALSOS en 127.0.0.1 (responden los GET de estado y costo), YouTube falso, netguard (solo 127.0.0.1 / data:).
//
//   [PU]  decisión pura: casos, topes (2 reenvíos, 1 ambiguo), espera, excepción registrada, cursos históricos fuera
//   [V1]  reproducción de #1510: el job falla ANTES del render (costo 0,5351) → charged_partial (system) → reenvío →
//         render OK → video completo; video_interactions se reencola solo; 0 acciones de admin; intentos actor=system
//   [V2]  job que nunca termina (review C1): mientras siga vivo NUNCA se reenvía (re-consulta con espera creciente);
//         si termina `failed` → conciliado + reenvío; si no termina en 12 h → excepción; lookup caído 6 h → excepción
//   [Z]   regla de liberación (review I1): 0 libera solo failed + desglose en 0 + sin etapas pagadas + 2 lecturas ≥10 min;
//         0 con etapas pagadas → charged; informado > reserva → se cuenta todo (nunca de menos)
//   [O]   jobId solo en el sufijo del error (review I3): vivo → espera; completado → se adopta y re-poll; failed → conciliado
//   [R]   carrera (review I2): la parte cambia durante la consulta → no se liquida nada (ni el intento nuevo)
//   [T]   timeouts (review I4): GET de Gamma colgado acotado; tope de consultas d5 por tick; VideogenService con timeout
//   [X]   runs históricos / anteriores al corte (review M1): ni el barrido ni la completitud los toman
//   [G1]  Gamma fallido con créditos DEDUCIDOS (medidos por el worker) → reenvío sin consultar
//   [G2]  Gamma fallido SIN créditos en el fallo → GET /generations/{id} informa credits.deducted → liquidado medido → reenvío
//   [G3]  Gamma fallido sin créditos y Gamma nunca los informa → espera; pasado el tope, conservador + 1 reenvío ambiguo
//   [A1]  envío de Videogen ambiguo SIN jobId dentro del presupuesto → conservador + possible_duplicate + 1 reenvío → OK
//   [A2]  envío ambiguo FUERA del presupuesto → excepción (run_budget_cap, attention_reason=budget), sin reenvío
//   [D5]  reserva de Videogen archivada con jobId (sin endpoint de admin) → conciliada sola con el costo del job
//   [L]   el ledger de cada run nunca supera lo autorizado; los ajustes son del sistema (nunca recorded_by admin%)
//
// Usage: npm run build && node scripts/check-r62-provider-reconcile.js [--pure-only]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger } = require('@nestjs/common');
const LOGS = [];
Logger.overrideLogger({ log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)), debug() {}, verbose() {} });

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const dec = (x) => Number(x);

const PR = L('modules/dynamic-generation/provider-reconcile.js');
const AH = L('modules/dynamic-generation/auto-heal.js');
const FC = L('modules/reliability/failure-classifier.js');

// ─── puro ───────────────────────────────────────────────────────────────────
async function pureChecks() {
  const ago = (s) => new Date(Date.now() - s * 1000);
  const P = AH.DEFAULT_AUTO_HEAL_POLICY;
  const row = (o) => ({ status: 'failed', type: 'video', error: 'videogen_failed: generate_script 429', output_summary: { external: { videogenJobId: 'j1' } }, finished_at: ago(600), ...o });
  await check('[PU] casos: videogen_failed con jobId, job atascado (auto-healer agotado), ambiguo sin jobId, Gamma fallido con id, Gamma ambiguo sin id; el resto no', async () => {
    eq(PR.providerReconcileKindOf('video', 'videogen_failed: x', { external: { videogenJobId: 'j' } }, P), 'videogen_failed', 'videogen_failed');
    eq(PR.providerReconcileKindOf('video', 'videogen_failed: x', {}, P), null, 'sin jobId no hay evidencia (sigue el camino de siempre)');
    eq(PR.providerReconcileKindOf('video', 'video_timeout', { external: { videogenJobId: 'j' }, autoHeal: { rounds: 2 } }, P), null, 'timeout: el auto-healer sigue re-polleando gratis');
    eq(PR.providerReconcileKindOf('video', 'video_timeout', { external: { videogenJobId: 'j' }, autoHeal: { rounds: P.maxRounds } }, P), 'videogen_stuck', 'auto-healer agotado');
    eq(PR.providerReconcileKindOf('video', 'ambiguous_video_submission: 502', {}, P), 'videogen_ambiguous', 'c2');
    eq(PR.providerReconcileKindOf('presentation', 'gamma_generation_failed: x', { external: { gammaGenerationId: 'g' } }, P), 'gamma_failed', 'd13');
    eq(PR.providerReconcileKindOf('presentation', 'gamma_submit_ambiguous: x', {}, P), 'gamma_ambiguous', 'c3');
    for (const [t, e] of [['video', 'videogen_submit_rejected: (HTTP 400)'], ['video', 'budget_exceeded: x'], ['audio_welcome', 'provider_reconciliation_required: openai x'], ['content', 'videogen_failed: x']]) {
      eq(PR.providerReconcileKindOf(t, e, { external: { videogenJobId: 'j' } }, P), null, `${t} ${e}`);
    }
  });
  await check('[PU] decisión: espera de 120 s; ronda 1 y 2; tope de 2 reenvíos; UN ambiguo; excepción registrada para ESE error; ventana de 24 h', async () => {
    eq(PR.providerReconcileDecision(row({ finished_at: ago(30) }), new Date(), P).reason, 'backoff', 'espera');
    const d1 = PR.providerReconcileDecision(row(), new Date(), P);
    eq([d1.heal, d1.kind, d1.round, d1.ambiguousAllowed], [true, 'videogen_failed', 1, true], 'ronda 1');
    eq(PR.providerReconcileDecision(row({ output_summary: { external: { videogenJobId: 'j' }, providerReconcile: { rounds: 1 } } }), new Date(), P).round, 2, 'ronda 2');
    eq(PR.providerReconcileDecision(row({ output_summary: { external: { videogenJobId: 'j' }, providerReconcile: { rounds: PR.PROVIDER_RECONCILE_MAX_RESUBMITS } } }), new Date(), P).reason, 'cap_reached', 'tope');
    eq(PR.PROVIDER_RECONCILE_MAX_RESUBMITS, 2, 'N propuesto = 2');
    eq(PR.PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS, 1, 'nunca más de un reenvío ambiguo');
    const amb = row({ error: 'ambiguous_video_submission: x', output_summary: { providerReconcile: { rounds: 1, ambiguousRounds: 1 } } });
    eq(PR.providerReconcileDecision(amb, new Date(), P).reason, 'ambiguous_cap_reached', 'segundo ambiguo → excepción');
    const known = PR.providerReconcileDecision(row({ output_summary: { external: { videogenJobId: 'j' }, providerReconcile: { rounds: 1, ambiguousRounds: 1 } } }), new Date(), P);
    eq([known.heal, known.ambiguousAllowed], [true, false], 'una falla conocida sigue; si resulta sin evidencia el barrido la declina');
    const dec1 = row({ output_summary: { external: { videogenJobId: 'j' }, providerReconcile: { declined: 'run_budget_cap', declinedError: 'videogen_failed: generate_script 429' } } });
    eq(PR.providerReconcileDecision(dec1, new Date(), P).reason, 'declined', 'excepción registrada');
    eq(PR.providerReconcileDecision({ ...dec1, error: 'videogen_failed: otro' }, new Date(), P).heal, true, 'un error nuevo vuelve a evaluarse');
    eq(PR.providerReconcileDecision(row({ finished_at: ago(25 * 3600) }), new Date(), P).reason, 'too_old', 'ventana');
    eq(PR.providerReconcileDecision(row({ status: 'completed' }), new Date(), P).reason, 'not_failed', 'solo failed');
  });
  await check('[PU] monto contado = costo informado de Videogen con tope en la reserva; créditos medidos del mensaje del worker; cursos históricos excluidos', async () => {
    eq(PR.videogenCountedAmount(0.5351, null), 0.5351, 'informado');
    eq(PR.videogenCountedAmount(3, null), 3, 'nunca de menos (supera la reserva)');
    eq(PR.videogenCountedAmount(0.2, { script: 0.371, images: 0.16 }), 0.531, 'piso del desglose');
    eq(PR.videogenCountedAmount(0, {}), 0, 'cero');
    let e = null; try { PR.videogenCountedAmount(-1, null); } catch (x) { e = x; } assert(e, 'negativo rechazado');
    const z = (o) => PR.videogenZeroCostReleasable({ status: 'failed', error: 'content_txt vacío', reportedCost: 0, breakdown: { script: 0, tts: 0 }, ...o });
    eq([z({}), z({ status: 'completed' }), z({ breakdown: null }), z({ breakdown: { script: 0.01 } }), z({ error: 'generate_script: 429' }), z({ reportedCost: 0.01 })],
      [true, false, false, false, false, false], 'liberación solo con evidencia fuerte (failed, desglose en 0, sin etapas pagadas)');
    eq(PR.videogenJobIdFromError('ambiguous_video_submission: db caída (job de Videogen vg-abc_1)'), 'vg-abc_1', 'sufijo anclado');
    eq(PR.videogenJobIdFromError('ambiguous_video_submission: texto (job de Videogen x) y más'), null, 'solo al final');
    eq(PR.providerReconcileKindOf('video', 'ambiguous_video_submission: db (job de Videogen vg-1)', {}, AH.DEFAULT_AUTO_HEAL_POLICY), 'videogen_orphan', 'I3');
    eq(PR.PROVIDER_RECONCILE_AMBIGUOUS_KINDS.includes('videogen_stuck'), false, 'C1: un job con id nunca es «ambiguo»');
    eq(PR.gammaMeasuredCreditsOf('gamma_generation_failed: la generación g falló en Gamma (x) [créditos medidos: 40]. No se reenvía sola: regenera'), 40, 'medidos');
    eq(PR.gammaMeasuredCreditsOf('gamma_generation_failed: ... [Gamma no informó los créditos: cobro incierto]. No se reenvía sola'), null, 'sin medir');
    const E = (id, created_at) => PR.providerReconcileRunEligible({ id, created_at }, { PROVIDER_RECONCILE_RUNS_SINCE: '2026-10-20T00:00:00Z' });
    eq([E('6ccb5763-5c44-4ce4-9c1b-bf05ed155b4a', '2026-11-01'), E('d7155541-2ec4-43a4-ba3c-fb0787c17852', '2026-11-01'), E('1c02fd27-0000-4000-8000-000000000000', '2026-11-01'),
      E('aaaaaaaa-0000-4000-8000-000000000000', '2026-10-19T23:00:00Z'), E('aaaaaaaa-0000-4000-8000-000000000000', '2026-10-21T00:00:00Z')],
      [false, false, false, false, true], 'históricos (#1209, #1353, #1510) y runs anteriores al corte excluidos');
  });
  await check('[PU] clasificador: con id del proveedor la estrategia es provider_check y «qué hace hoy» es provider_reconcile; sin id sigue igual', async () => {
    const v = FC.classifyFailure({ source: 'video_worker', itemType: 'video', error: 'videogen_failed: x', outputSummary: { external: { videogenJobId: 'j' } } });
    eq([v.class, v.strategy, v.adminAction], ['C', 'provider_check', 'retry_video_render'], 'videogen_failed con jobId');
    eq(FC.classifyFailure({ source: 'video_worker', itemType: 'video', error: 'videogen_failed: x' }).strategy, 'hold_for_human', 'sin jobId');
    const g = FC.classifyFailure({ source: 'provider_worker', itemType: 'presentation', error: 'gamma_generation_failed: x [Gamma no informó los créditos: cobro incierto]. No se reenvía sola', outputSummary: { external: { gammaGenerationId: 'g' } } });
    eq([g.class, g.strategy], ['C', 'provider_check'], 'gamma sin créditos con id');
    eq(FC.currentRecoveryOf('videogen_failed: x', 'video', { external: { videogenJobId: 'j' } }), 'provider_reconcile', 'qué hace hoy');
    eq(FC.currentRecoveryOf('videogen_failed: x', 'video', {}), 'manual', 'sin jobId: humano');
  });
}

// ─── fakes HTTP (Videogen + Gamma) ─────────────────────────────────────────
function startFakes() {
  const vg = { submits: 0, statusCalls: 0, costCalls: 0, plan: [], jobs: new Map() };
  const gm = { getCalls: 0, gens: new Map() };
  const json = (rs, code, body) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(body)); };
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const p = new URL(rq.url, 'http://x').pathname;
      let m;
      if (rq.method === 'POST' && p === '/api/external/videos/batch-create') {
        vg.submits++;
        const next = vg.plan.shift() || { kind: 'ok' };
        if (next.kind === 'http502') return json(rs, 502, { error: 'upstream timeout' });
        const id = next.jobId || `vg-${vg.submits}-${crypto.randomUUID().slice(0, 6)}`;
        vg.jobs.set(id, { statuses: next.statuses || ['completed_local'], error: next.error || null, cost: next.cost ?? 0.97, breakdown: next.breakdown === undefined ? null : next.breakdown });
        return json(rs, 200, { batch_id: `b-${vg.submits}`, jobs: [{ job_id: id, chapter_number: 1, status: 'queued' }] });
      }
      if (rq.method === 'GET' && (m = p.match(/^\/api\/external\/videos\/([^/]+)\/status$/))) {
        vg.statusCalls++;
        if (vg.statusDown) return json(rs, 503, { error: 'videogen down' });
        if (m[1] === 'vg-hang') return; // nunca responde (timeout del cliente)
        const j = vg.jobs.get(m[1]);
        if (!j) return json(rs, 404, { error: 'not found' });
        const st = j.statuses.length > 1 ? j.statuses.shift() : j.statuses[0];
        return json(rs, 200, { job_id: m[1], status: st, error: /fail/.test(st) ? j.error : null, download_url: 'http://127.0.0.1:1/fake.mp4', progress: 100, duration_seconds: 468 });
      }
      if (rq.method === 'GET' && (m = p.match(/^\/api\/costs\/videos\/([^/]+)$/))) {
        vg.costCalls++;
        const j = vg.jobs.get(m[1]);
        if (!j || j.cost === 'error') return json(rs, 503, { error: 'cost service unavailable' });
        if (vg.onCost) { const h = vg.onCost; vg.onCost = null; return Promise.resolve(h(m[1])).then(() => json(rs, 200, { job_id: m[1], estimated_total_cost: j.cost, breakdown: j.breakdown })); }
        return json(rs, 200, { job_id: m[1], estimated_total_cost: j.cost, breakdown: j.breakdown });
      }
      if (rq.method === 'GET' && (m = p.match(/^\/gamma\/generations\/([^/]+)$/))) {
        gm.getCalls++;
        if (m[1] === 'gen-hang') return; // nunca responde
        const g = gm.gens.get(m[1]);
        if (!g) return json(rs, 404, { error: 'not found' });
        return json(rs, 200, { generationId: m[1], status: g.status, ...(g.credits === null ? {} : { credits: { deducted: g.credits, remaining: 1000 } }), error: g.status === 'failed' ? 'render failed' : null });
      }
      json(rs, 404, { error: `ruta falsa no encontrada ${rq.method} ${p}` });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, vg, gm, base: `http://127.0.0.1:${srv.address().port}` })));
}

// ─── DB ─────────────────────────────────────────────────────────────────────
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso r62 N2', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano',
  videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' } };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'VIDEOGEN_API_URL', 'SUPER_ADMIN_EMAILS',
  'GAMMA_API_KEY', 'GAMMA_API_BASE_URL', 'DYNAMIC_AUTO_HEAL_ENABLED', 'PROVIDER_RECONCILE_RUNS_SINCE', 'VIDEOGEN_HTTP_TIMEOUT_MS'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { SchedulerService, mergeOutputSummary } = L('modules/dynamic-generation/scheduler.service.js');
  const { ProviderReconcileService } = L('modules/dynamic-generation/provider-reconcile.service.js');
  const { VideogenService } = L('video-engine/videogen.service.js');
  const { GammaClient } = L('workers/provider-real/provider-clients.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const IW = L('workers/dynamic-item-worker.js');
  const HK = L('workers/finops-worker-hooks.js');
  const F = L('modules/finops/index.js');
  const { syntheticMp4WithMvhd } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));
  const { applyFakeProviderEnv } = require('./lib/provider-test-env');

  const fakes = await startFakes();
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62n2-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62n2-cwd-'));
  const ROLE = 'postgres.r62n2local01';
  const DB = 'r62n2db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    delete process.env.DYNAMIC_AUTO_HEAL_ENABLED;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-local-only';
    process.env.VIDEOGEN_API_URL = fakes.base;
    process.env.GAMMA_API_KEY = 'fake-gamma-key-local-only';
    process.env.GAMMA_API_BASE_URL = `${fakes.base}/gamma`;
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    process.env.PROVIDER_RECONCILE_RUNS_SINCE = '2020-01-01T00:00:00Z'; // los runs del check son de hoy

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 8 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);
    const videogen = new VideogenService();
    const gammaClient = new GammaClient(process.env.GAMMA_API_KEY, process.env);
    const recon = new ProviderReconcileService(ds, runs, ledger, budget, { videogen, gamma: gammaClient });
    const P = AH.DEFAULT_AUTO_HEAL_POLICY;
    const sweepAt = (secLater) => recon.sweep({ now: new Date(Date.now() + secLater * 1000), policy: P });

    async function makeCourse(title, authorized = '50') {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, CONTEXT)).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: authorized, approvedBy: 'admin@cursia.test', reason: 'check r62 N2' });
        runId = (await runs.startRun(cid, OWNER, 1, CONTEXT)).run.id;
      }
      // Todo listo salvo el video del capítulo 1, sus preguntas y la presentación del capítulo 1 (lo que prueba cada caso).
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(),
                        output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb
                      where job_id = $1 and item_key not in ($2, $3, $4)`, [runId, `video:${c1}`, `video_interactions:${c1}`, `presentation:${c1}`]);
      await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [runId]);
      return { cid, c1, c2, runId };
    }
    const latest = async (runId, key) => (await ds.query(`select *, to_jsonb(g)->>'attention_reason' as attention from public.generation_item_runs g where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const patchSummary = async (id, patch) => {
      const [row] = await ds.query(`select output_summary from public.generation_item_runs where id = $1`, [id]);
      const m = mergeOutputSummary(row.output_summary || {}, patch);
      if (!m.ok) return false;
      await ds.query(`update public.generation_item_runs set output_summary = $2::jsonb where id = $1`, [id, JSON.stringify(m.merged)]);
      return true;
    };
    /** Scheduler en la DB con la semántica que usa el worker: fail no reintentable → failed + dependientes blocked. */
    function dbScheduler() {
      const st = { failed: [], completed: [] };
      return {
        st,
        async heartbeatItem() { return true; },
        async recordItemExternal(id, _e, patch) { return patchSummary(id, patch); },
        async failItem(id, _e, msg, retryable) {
          st.failed.push({ id, msg, retryable });
          await ds.query(`update public.generation_item_runs set status = $3, error = $2, finished_at = now() where id = $1`, [id, msg, retryable ? 'retrying' : 'failed']);
          if (!retryable) {
            const [it] = await ds.query(`select job_id, item_key from public.generation_item_runs where id = $1`, [id]);
            await ds.query(`update public.generation_item_runs set status = 'blocked' where job_id = $1 and $2 = any(depends_on) and status in ('pending', 'retrying')`, [it.job_id, it.item_key]);
          }
          return true;
        },
        async completeItem(id, _e, payload) {
          st.completed.push({ id, payload });
          await patchSummary(id, payload.summary || {});
          await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), error = null,
                            output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [id]);
          return true;
        },
        async blockItemForBudget(id, _e, msg) { st.failed.push({ id, msg, blocked: true }); return true; },
      };
    }
    const mp4 = syntheticMp4WithMvhd(468);
    const yt = { uploads: 0 };
    const publisher = {
      async getConnection(ownerId) { return { userId: ownerId, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
      async getAccessToken() { return 'tok'; },
      async uploadFromUrl(_c, options) {
        yt.uploads++;
        if (options.onBeforeUpload) await options.onBeforeUpload(mp4);
        const id = ('R62vid' + yt.uploads + 'xxxxxxxxx').slice(0, 11);
        return { videoId: id, youtubeUrl: `https://www.youtube.com/watch?v=${id}` };
      },
    };
    const workerLog = { log() {}, warn() {}, error(m) { workerLog.errors.push(String(m)); }, errors: [] };
    const deps = (s) => ({
      scheduler: s, dataSource: ds, videogen, logger: workerLog, executorId: 'w-r62n2', leaseSeconds: 60, heartbeatMs: 600000,
      videoTimeoutMin: 0.002, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1, youtube: publisher,
      youtubeUploadRetryBaseMs: 1, fetchMp4: async () => mp4,
      artifacts: { async getDownloadUrl() { return { url: 'data:text/plain,Contenido%20del%20cap%C3%ADtulo' }; }, async uploadJsonArtifact() { return { id: 'art-' + crypto.randomUUID() }; } },
      finops: ledger, budget,
    });
    /** Claim del worker de video (attempt_count + 1, running), como el scheduler real. */
    const claim = async (runId, key, chapterId) => {
      const res = await ds.query(
        `update public.generation_item_runs set status = 'running', attempt_count = attempt_count + 1, worker_id = 'w-r62n2', claimed_at = now()
          where id = (select id from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1) returning *`, [runId, key]);
      const row = Array.isArray(res[0]) ? res[0][0] : res[0];
      return {
        itemRunId: row.id, runId, itemKey: row.item_key, type: row.type, idempotencyKey: row.idempotency_key, attempt: row.attempt_count,
        chapterId, chapterNumber: 1, manifestId: row.manifest_id, artifactCourseId: String(row.course_id), generation: row.generation, rulesVersion: 3,
        blueprint: { course: { id: row.course_id, title: 'Curso' }, chapter: { title: 'Bombas' } },
        dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content-art' }], outputSummary: row.output_summary || {},
      };
    };
    const runVideo = async (C) => { const s = dbScheduler(); await IW.processItem(deps(s), await claim(C.runId, `video:${C.c1}`, C.c1)); return s; };
    const events = (runId) => ds.query(
      `select event_kind, provider, item_key, amount::text as amount, measurement_status, recorded_by, idempotency_key, metadata, corrects_event_id
         from public.generation_cost_events where run_id = $1 order by created_at, id`, [runId]);
    const runTotal = async (runId) => dec((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [runId]))[0].t);
    const ledgerWithinAuthorized = async (runId) => {
      const auth = await budget.runPaidAuthorizedBudget(runId);
      const t = await runTotal(runId);
      assert(auth !== null && t <= dec(auth) + 1e-9, `ledger del run ${t} supera lo autorizado ${auth}`);
      return { total: t, authorized: dec(auth) };
    };
    const noAdminAdjustments = async (runId) => {
      const adm = (await events(runId)).filter((e) => /^admin/.test(String(e.recorded_by)) || String(e.metadata?.decidedByRole ?? '') === 'SUPER_ADMIN');
      eq(adm.length, 0, 'sin decisiones de admin en el ledger');
    };
    const completionOf = async (C) => (await runs.getRun(C.cid, OWNER, 1, C.runId)).completion;
    const reopenAttempts = (itemRunId) => ds.query(`select actor, strategy_applied, outcome from public.generation_item_attempts where item_run_id = $1 and outcome = 'reopened' order by created_at`, [itemRunId]);

    // ═══ V1 — reproducción de #1510 ═══════════════════════════════════════════
    const V1 = await makeCourse('r62 #1510');
    const vkey = `video:${V1.c1}`;
    const ikey = `video_interactions:${V1.c1}`;
    let jobA = null;
    await check('[V1] #1510: Videogen acepta el job y falla ANTES del render (generate_script 429) → videogen_failed con jobId; la reserva queda pendiente; video_interactions bloqueado', async () => {
      fakes.vg.plan.push({ kind: 'ok', jobId: 'vg-1510-a', statuses: ['processing', 'failed'], error: 'generate_script: OpenAI 429 rate limit', cost: 0.5351,
        breakdown: { script: 0.371, images: 0.16, tts: 0.0041 } });
      const s = await runVideo(V1);
      eq(s.st.failed.map((f) => [f.msg.split(':')[0], f.retryable]), [['videogen_failed', false]], `fallo ${JSON.stringify(s.st.failed)} ${workerLog.errors.join(' | ')}`);
      const row = await latest(V1.runId, vkey);
      jobA = row.output_summary.external.videogenJobId;
      eq([row.status, jobA], ['failed', 'vg-1510-a'], 'video failed con jobId');
      eq((await latest(V1.runId, ikey)).status, 'blocked', 'preguntas bloqueadas');
      const res = (await events(V1.runId)).filter((e) => e.provider === 'videogen');
      eq(res.map((e) => [e.event_kind, e.amount, e.measurement_status, e.metadata.reservation]), [['CHARGE', '1.1750000000', 'pending', true]], 'reserva pendiente (1,25 × 0,94)');
    });
    await check('[V1] dentro de la espera: el barrido no hace nada y la completitud NO pide acción de admin (ni reconcile_videogen_reservation): el servidor lo resuelve', async () => {
      const r1 = await sweepAt(0);
      eq([r1.resubmitted.length, r1.declined.length], [0, 0], 'nada todavía');
      assert(r1.skipped.some((x) => x.itemKey === vkey && x.reason === 'backoff'), JSON.stringify(r1.skipped));
      const comp = await completionOf(V1);
      eq((comp.adminActions || []).filter((a) => a.itemKey === vkey), [], `sin acción de admin: ${JSON.stringify(comp.adminActions)}`);
    });
    await check('[V1] pasada la espera: GET estado + GET costo → reserva conciliada charged_partial 0,5351 (decidedBy=system, evidencia provider_api_response) → reenvío automático; video_interactions se reencola solo', async () => {
      const before = { st: fakes.vg.statusCalls, cost: fakes.vg.costCalls, sub: fakes.vg.submits };
      const r2 = await sweepAt(PR.PROVIDER_RECONCILE_BACKOFF_SECONDS + 5);
      eq(r2.resubmitted.map((x) => [x.itemKey, x.kind, x.settlement, x.ambiguous]), [[vkey, 'videogen_failed', 'charged_partial', false]], `reenvío ${JSON.stringify(r2)}`);
      eq([fakes.vg.statusCalls - before.st >= 1, fakes.vg.costCalls - before.cost, fakes.vg.submits - before.sub], [true, 1, 0], 'solo GET; el barrido nunca envía a Videogen');
      const fam = (await events(V1.runId)).filter((e) => e.provider === 'videogen');
      const adj = fam.find((e) => e.event_kind === 'ADJUSTMENT');
      eq([adj.amount, adj.measurement_status, adj.recorded_by, adj.metadata.settlement, adj.metadata.decidedBy, adj.metadata.evidence.source, adj.metadata.evidence.observedAmount, adj.metadata.countedAmount],
        ['-0.6399000000', 'final', 'system_provider_reconcile', 'reconciled_as_charged_partial', 'system', 'provider_api_response', '0.5351000000', '0.5351000000'], 'ajuste charged_partial');
      eq(adj.metadata.evidence.referenceIds, ['videogen:job:vg-1510-a'], 'evidencia del job');
      const row = await latest(V1.runId, vkey);
      eq([row.status, row.error, !!row.output_summary.external, row.output_summary.providerReconcile.rounds, row.output_summary.providerReconcile.lastSettlement],
        ['pending', null, false, 1, 'charged_partial'], 'video reabierto con el job archivado');
      eq(row.output_summary.previousExternals.slice(-1)[0].external.videogenJobId, 'vg-1510-a', 'job archivado en previousExternals');
      eq((await latest(V1.runId, ikey)).status, 'pending', 'video_interactions reencolado solo');
      const att = await reopenAttempts(row.id);
      eq(att.map((a) => [a.actor, a.strategy_applied]), [['system', 'provider_reconcile_resubmit:videogen_failed']], 'intento con actor system y su motivo');
      const comp = await completionOf(V1);
      eq((comp.adminActions || []).length, 0, `0 acciones de admin: ${JSON.stringify(comp.adminActions)}`);
    });
    await check('[V1] el worker reenvía (job nuevo), el render termina y el video se completa (YouTube falso); ledger: 0,5351 del fallido + costo del nuevo, ≤ autorizado; 0 intervención', async () => {
      fakes.vg.plan.push({ kind: 'ok', jobId: 'vg-1510-b', statuses: ['processing', 'completed_local'], cost: 0.97 });
      const sub0 = fakes.vg.submits;
      const s = await runVideo(V1);
      eq([s.st.failed.length, s.st.completed.length, fakes.vg.submits - sub0], [0, 1, 1], `completo ${JSON.stringify(s.st.failed)} ${workerLog.errors.join(' | ')}`);
      const row = await latest(V1.runId, vkey);
      eq([row.status, row.output_summary.external.videogenJobId], ['completed', 'vg-1510-b'], 'video real completo');
      const vgEv = (await events(V1.runId)).filter((e) => e.provider === 'videogen');
      const counted = vgEv.reduce((t, e) => t + dec(e.amount), 0);
      assert(Math.abs(counted - (0.5351 + 0.97)) < 1e-9, `Videogen contado ${counted}`);
      const pend = await L('modules/dynamic-generation/run-completion.js').loadPendingVideogenReservations(ds, V1.runId);
      eq(pend.length, 0, 'ninguna reserva de Videogen pendiente (d5: no hace falta el endpoint de admin)');
      await ledgerWithinAuthorized(V1.runId);
      await noAdminAdjustments(V1.runId);
      // Las preguntas del video ya se pueden reclamar (dependencia completa).
      const cl = await sched.claimNextItem({ executorId: 'b-r62n2', types: ['video_interactions'], runId: V1.runId, ownerId: OWNER, leaseSeconds: 60, executorFeatures: [] });
      assert(cl && cl.itemKey === ikey, `video_interactions reclamable: ${JSON.stringify(cl && cl.itemKey)}`);
      const comp = await completionOf(V1);
      eq((comp.adminActions || []).length, 0, '0 acciones de admin');
    });
    await check('[V1] idempotente: otro barrido no repite nada (ni GET de costo, ni ajustes, ni reenvíos)', async () => {
      const n = (await events(V1.runId)).length;
      const c0 = fakes.vg.costCalls;
      const r = await sweepAt(PR.PROVIDER_RECONCILE_BACKOFF_SECONDS + 600);
      eq([r.resubmitted.length, r.declined.length, (await events(V1.runId)).length, fakes.vg.costCalls - c0], [0, 0, n, 0], 'nada');
    });

    /** Estado que deja el worker de Gamma real ante `failed` (mismas funciones del ledger que real-providers.ts). */
    const gammaFailed = async (C, gid, credits) => {
      const it = await latest(C.runId, `presentation:${C.c1}`);
      await ds.query(`update public.generation_item_runs set attempt_count = attempt_count + 1 where id = $1`, [it.id]);
      const attempt = it.attempt_count + 1;
      const resKey = await HK.reservePaidCall(ledger, { kind: 'gamma', ownerId: OWNER, itemRunId: it.id, generation: it.generation, itemAttempt: attempt, tag: 'submit', estimate: {} });
      const measured = typeof credits === 'number';
      await HK.settlePaidCall(ledger, resKey, measured
        ? HK.gammaChargeInput({ ownerId: OWNER, itemRunId: it.id, generationId: gid, creditsDeducted: credits, creditsRemaining: 1000, failed: true, itemAttempt: attempt })
        : HK.gammaPendingInput({ ownerId: OWNER, itemRunId: it.id, generationId: gid, itemAttempt: attempt, reason: 'gamma_credits_not_reported' }),
      measured ? 'gamma_credits_measured' : 'gamma_credits_not_reported');
      const msg = `gamma_generation_failed: la generación ${gid} falló en Gamma (render failed)` +
        (measured ? ` [créditos medidos: ${credits}]` : ' [Gamma no informó los créditos: cobro incierto]') + '. No se reenvía sola: regenera la presentación para pedir una nueva.';
      await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = now() - interval '5 minutes',
                        output_summary = coalesce(output_summary, '{}'::jsonb) || $3::jsonb where id = $1`,
        [it.id, msg, JSON.stringify({ externalSubmitStartedAt: new Date().toISOString(), externalReservationKey: resKey,
          external: { gammaGenerationId: gid, gammaThemeId: 't', themeFamily: 'f', themeMode: 'light', acceptedAtAttempt: attempt } })]);
      return it.id;
    };
    // ═══ V2 — job que nunca termina (review C1) ═════════════════════════════
    const stuckFail = async (C, jobId, statuses = ['processing']) => {
      fakes.vg.plan.push({ kind: 'ok', jobId, statuses, cost: 0.6, breakdown: { script: 0.4, images: 0.2 } });
      const s = await runVideo(C); // el poll corta por video_timeout (reintentable); el auto-healer lo re-pollea gratis
      assert(s.st.failed.some((f) => f.msg === 'video_timeout'), `video_timeout ${JSON.stringify(s.st.failed)}`);
      const row = await latest(C.runId, `video:${C.c1}`);
      // El auto-healer ya agotó sus rondas de re-poll gratis (5): el job sigue «processing».
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'video_timeout', finished_at = now() - interval '10 minutes',
                        output_summary = output_summary || jsonb_build_object('autoHeal', jsonb_build_object('rounds', $2::int)) where id = $1`, [row.id, P.maxRounds]);
      return row.id;
    };
    const V2 = await makeCourse('r62 job eterno');
    const v2key = `video:${V2.c1}`;
    await check('[V2] job atascado que SIGUE VIVO: nunca se reenvía ni se liquida; re-consulta con espera creciente; sin acción de admin mientras tanto', async () => {
      await stuckFail(V2, 'vg-stuck-1');
      const sub0 = fakes.vg.submits; const n0 = (await events(V2.runId)).length;
      const r1 = await sweepAt(5);
      eq([r1.resubmitted.length, r1.waiting.map((x) => x.itemKey)], [0, [v2key]], JSON.stringify(r1));
      const st1 = (await latest(V2.runId, v2key)).output_summary.providerReconcile;
      eq([st1.checks, Date.parse(st1.nextCheckAt) > Date.now() + 100 * 1000], [1, true], 'próxima consulta reprogramada');
      const rIn = await sweepAt(60);
      assert(rIn.skipped.some((x) => x.itemKey === v2key && x.reason === 'backoff'), `dentro de la espera no consulta: ${JSON.stringify(rIn)}`);
      const r2 = await sweepAt(3600);
      eq([r2.resubmitted.length, r2.waiting.length], [0, 1], 'sigue vivo → sigue esperando');
      eq([fakes.vg.submits - sub0, (await events(V2.runId)).length - n0], [0, 0], '0 envíos, 0 ajustes con el job vivo');
      eq((await latest(V2.runId, v2key)).status, 'failed', 'no se reabre');
      eq(((await completionOf(V2)).adminActions || []).filter((a) => a.itemKey === v2key), [], 'el servidor lo sigue');
    });
    await check('[V2] el job atascado termina `failed` → recién ahí: conciliado con su costo (charged_partial) y UN reenvío (no ambiguo)', async () => {
      fakes.vg.jobs.get('vg-stuck-1').statuses = ['failed'];
      fakes.vg.jobs.get('vg-stuck-1').error = 'render: ffmpeg crashed';
      const r = await sweepAt(3 * 3600);
      eq(r.resubmitted.map((x) => [x.kind, x.settlement, x.ambiguous]), [['videogen_stuck', 'charged_partial', false]], JSON.stringify(r));
      const row = await latest(V2.runId, v2key);
      eq([row.status, row.output_summary.providerReconcile.ambiguousRounds, row.output_summary.autoHeal.rounds], ['pending', 0, 0], 'reabierto; re-poll gratis reiniciado');
      await ledgerWithinAuthorized(V2.runId);
    });
    const V2b = await makeCourse('r62 job eterno 2');
    const v2bkey = `video:${V2b.c1}`;
    await check('[V2] un job que no termina en 12 h → excepción videogen_job_not_terminal (duplicate_charge), 0 reenvíos; la acción de admin aparece', async () => {
      await stuckFail(V2b, 'vg-stuck-2');
      const sub0 = fakes.vg.submits;
      await sweepAt(5);
      const r = await sweepAt(PR.PROVIDER_RECONCILE_LIVE_JOB_MAX_SECONDS + 60);
      eq([r.resubmitted.length, r.declined.map((x) => x.reason)], [0, ['videogen_job_not_terminal']], JSON.stringify(r));
      eq(fakes.vg.submits - sub0, 0, 'sin reenvío');
      const row = await latest(V2b.runId, v2bkey);
      eq([row.status, row.output_summary.providerReconcile.declined, row.attention], ['failed', 'videogen_job_not_terminal', 'duplicate_charge'], 'excepción explícita');
      assert(((await completionOf(V2b)).adminActions || []).some((a) => a.itemKey === v2bkey), 'acción de admin visible');
      eq((await sweepAt(PR.PROVIDER_RECONCILE_LIVE_JOB_MAX_SECONDS + 600)).declined.length, 0, 'no se re-evalúa en cada tick');
      await ledgerWithinAuthorized(V2b.runId);
    });
    const V2c = await makeCourse('r62 lookup caído');
    const v2ckey = `video:${V2c.c1}`;
    await check('[V2] lookup de estado caído con jobId → espera; a las 6 h excepción videogen_lookup_unavailable (no reenvío)', async () => {
      await stuckFail(V2c, 'vg-down-1');
      fakes.vg.statusDown = true;
      try {
        const sub0 = fakes.vg.submits;
        const r1 = await sweepAt(5);
        eq([r1.resubmitted.length, r1.waiting.length], [0, 1], JSON.stringify(r1));
        const r2 = await sweepAt(PR.PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS + 60);
        eq([r2.resubmitted.length, r2.declined.map((x) => x.reason)], [0, ['videogen_lookup_unavailable']], JSON.stringify(r2));
        eq(fakes.vg.submits - sub0, 0, 'sin reenvío');
        eq((await latest(V2c.runId, v2ckey)).attention, 'duplicate_charge', 'attention_reason');
      } finally { fakes.vg.statusDown = false; }
    });

    // ═══ Z — regla de liberación (review I1) ═══════════════════════════════
    const videogenFailed = async (title, job) => {
      const C = await makeCourse(title);
      fakes.vg.plan.push({ kind: 'ok', ...job, statuses: ['failed'] });
      const s = await runVideo(C);
      assert(s.st.failed.some((f) => /^videogen_failed/.test(f.msg)), JSON.stringify(s.st.failed));
      await ds.query(`update public.generation_item_runs set finished_at = now() - interval '10 minutes' where id = $1`, [(await latest(C.runId, `video:${C.c1}`)).id]);
      return C;
    };
    const vgAdj = async (C) => (await events(C.runId)).filter((e) => e.provider === 'videogen' && e.event_kind === 'ADJUSTMENT');
    await check('[Z] costo 0 con evidencia fuerte (failed, desglose en 0, sin etapas pagadas): primera lectura espera; < 10 min sigue esperando; ≥ 10 min → released', async () => {
      const C = await videogenFailed('r62 cero ok', { jobId: 'vg-zero-ok', error: 'content_txt vacío', cost: 0, breakdown: { script: 0, images: 0 } });
      const r1 = await sweepAt(5);
      eq([r1.resubmitted.length, r1.waiting.length, (await vgAdj(C)).length], [0, 1, 0], `primera lectura ${JSON.stringify(r1)}`);
      const r2 = await sweepAt(5 + 300);
      eq([r2.resubmitted.length, (await vgAdj(C)).length], [0, 0], 'dentro de los 10 min');
      const r3 = await sweepAt(5 + PR.PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS + 30);
      eq(r3.resubmitted.map((x) => x.settlement), ['released'], JSON.stringify(r3));
      eq((await vgAdj(C)).map((e) => e.metadata.settlement), ['reconciled_as_not_charged'], 'liberada');
    });
    await check('[Z] costo 0 de un job que falló en una etapa pagada (generate_script 429) → charged (reserva completa), nunca released', async () => {
      const C = await videogenFailed('r62 cero no', { jobId: 'vg-zero-no', error: 'generate_script: OpenAI 429', cost: 0, breakdown: null });
      const r = await sweepAt(5);
      eq(r.resubmitted.map((x) => x.settlement), ['charged'], JSON.stringify(r));
      eq((await vgAdj(C)).map((e) => [e.amount, e.metadata.settlement]), [['0.0000000000', 'reconciled_as_charged']], 'cuenta la reserva entera');
    });
    await check('[Z] lo informado (2,00) supera la reserva (1,175) → se cuenta TODO lo informado (nunca de menos)', async () => {
      const C = await videogenFailed('r62 sobre reserva', { jobId: 'vg-over', error: 'render: timeout', cost: 2, breakdown: { render: 2 } });
      const r = await sweepAt(5);
      eq(r.resubmitted.map((x) => x.settlement), ['charged_over_reservation'], JSON.stringify(r));
      const fam = (await events(C.runId)).filter((e) => e.provider === 'videogen');
      assert(Math.abs(fam.reduce((t, e) => t + dec(e.amount), 0) - 2) < 1e-9, `contado ${JSON.stringify(fam.map((e) => e.amount))}`);
      await ledgerWithinAuthorized(C.runId);
    });

    // ═══ O — jobId solo en el sufijo del error (review I3) ═══════════════════
    const orphan = async (title, jobId, statuses, cost = 0.6) => {
      const C = await makeCourse(title);
      const it = await latest(C.runId, `video:${C.c1}`);
      await ds.query(`update public.generation_item_runs set attempt_count = 1 where id = $1`, [it.id]);
      const resKey = await HK.reservePaidCall(ledger, { kind: 'videogen', ownerId: OWNER, itemRunId: it.id, generation: it.generation, itemAttempt: 1, tag: 'submit', estimate: {} });
      fakes.vg.jobs.set(jobId, { statuses, error: 'render failed', cost, breakdown: { script: cost } });
      await ds.query(`update public.generation_item_runs set status = 'failed', finished_at = now() - interval '10 minutes', error = $2,
                        output_summary = coalesce(output_summary, '{}'::jsonb) || $3::jsonb where id = $1`,
        [it.id, `ambiguous_video_submission: connection terminated (job de Videogen ${jobId})`, JSON.stringify({ externalSubmitStartedAt: new Date().toISOString(), externalReservationKey: resKey })]);
      return C;
    };
    await check('[O] jobId en el sufijo, job vivo → espera (0 reenvíos, 0 ajustes); al terminar `failed` → conciliado con su costo y reenvío NO ambiguo', async () => {
      const C = await orphan('r62 huérfano', 'vg-orph-1', ['processing']);
      const sub0 = fakes.vg.submits;
      const r1 = await sweepAt(5);
      eq([r1.resubmitted.length, r1.waiting.length, (await vgAdj(C)).length, fakes.vg.submits - sub0], [0, 1, 0, 0], JSON.stringify(r1));
      fakes.vg.jobs.get('vg-orph-1').statuses = ['failed'];
      const r2 = await sweepAt(3600);
      eq(r2.resubmitted.map((x) => [x.kind, x.settlement, x.ambiguous]), [['videogen_orphan', 'charged_partial', false]], JSON.stringify(r2));
    });
    await check('[O] jobId en el sufijo, job COMPLETADO → se adopta el job y se re-pollea (sin reenvío, sin consumir reenvíos); el worker lo completa', async () => {
      const C = await orphan('r62 huérfano ok', 'vg-orph-2', ['completed_local'], 0.97);
      const r = await sweepAt(5);
      eq(r.repolled.map((x) => x.kind), ['videogen_orphan'], JSON.stringify(r));
      const row = await latest(C.runId, `video:${C.c1}`);
      eq([row.status, row.output_summary.external.videogenJobId, row.output_summary.providerReconcile.rounds, row.output_summary.providerReconcile.repolls], ['pending', 'vg-orph-2', 0, 1], 'adoptado');
      const sub0 = fakes.vg.submits;
      const s = await runVideo(C);
      eq([s.st.completed.length, fakes.vg.submits - sub0], [1, 0], `completado por poll ${JSON.stringify(s.st.failed)} ${workerLog.errors.slice(-2).join(' | ')}`);
      await ledgerWithinAuthorized(C.runId);
    });

    // ═══ R — carrera (review I2) ═════════════════════════════════════════════
    await check('[R] la parte se reabre y reclama (intento nuevo con su reserva) MIENTRAS el barrido consulta el costo → no se liquida nada (stale_row): ni la reserva vieja ni la del intento en vuelo', async () => {
      const C = await videogenFailed('r62 carrera', { jobId: 'vg-race', error: 'render failed', cost: 0.5, breakdown: { render: 0.5 } });
      const it = await latest(C.runId, `video:${C.c1}`);
      fakes.vg.onCost = async () => {
        await ds.query(`update public.generation_item_runs set status = 'running', attempt_count = attempt_count + 1, error = null where id = $1`, [it.id]);
        await HK.reservePaidCall(ledger, { kind: 'videogen', ownerId: OWNER, itemRunId: it.id, generation: it.generation, itemAttempt: it.attempt_count + 1, tag: 'submit', estimate: {} });
      };
      const r = await sweepAt(5);
      eq([r.resubmitted.length, r.skipped.some((x) => x.reason === 'stale_row')], [0, true], JSON.stringify(r));
      eq((await vgAdj(C)).length, 0, 'ningún ajuste');
      const pend = (await events(C.runId)).filter((e) => e.provider === 'videogen' && e.measurement_status === 'pending');
      eq(pend.length, 2, 'las dos reservas siguen pendientes (la nueva intacta)');
    });

    // ═══ T — timeouts (review I4) ════════════════════════════════════════════
    await check('[T] VideogenService (cliente de Cursia) corta un GET colgado con VIDEOGEN_HTTP_TIMEOUT_MS; el barrido corta un GET de Gamma colgado (espera, sin reenvío)', async () => {
      process.env.VIDEOGEN_HTTP_TIMEOUT_MS = '300';
      try {
        const t0 = Date.now();
        let e = null; try { await videogen.getVideoStatus('vg-hang'); } catch (x) { e = x; }
        assert(e && /error de red \(TimeoutError/.test(e.message) && Date.now() - t0 < 5000, `timeout del cliente: ${e && e.message}`);
      } finally { delete process.env.VIDEOGEN_HTTP_TIMEOUT_MS; }
      const recon2 = new ProviderReconcileService(ds, runs, ledger, budget, { videogen, gamma: gammaClient, lookupTimeoutMs: 300 });
      const C = await makeCourse('r62 gamma colgado');
      await gammaFailed(C, 'gen-hang', null);
      const t0 = Date.now();
      const r = await recon2.sweep({ now: new Date(Date.now() + 5000), policy: P });
      assert(Date.now() - t0 < 10000, 'el GET colgado no bloquea el tick');
      eq([r.resubmitted.length, r.waiting.length], [0, 1], JSON.stringify(r));
    });
    await check('[T] d5: a lo sumo 10 consultas por tick; el resto en el próximo', async () => {
      const C = await makeCourse('r62 d5 tope');
      const it = await latest(C.runId, `video:${C.c1}`);
      const prev = [];
      for (let i = 1; i <= 12; i++) {
        const k = await HK.reservePaidCall(ledger, { kind: 'videogen', ownerId: OWNER, itemRunId: it.id, generation: it.generation, itemAttempt: i, tag: 'submit', estimate: {} });
        fakes.vg.jobs.set(`vg-cap-${i}`, { statuses: ['failed'], error: 'render failed', cost: 0.3, breakdown: { render: 0.3 } });
        prev.push({ external: { videogenJobId: `vg-cap-${i}`, mode: 'real' }, externalReservationKey: k, reason: 'videogen_failed: render failed' });
      }
      await ds.query(`update public.generation_item_runs set attempt_count = 13, status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || $2::jsonb where id = $1`,
        [it.id, JSON.stringify({ previousExternals: prev, reconciliationAcknowledgedThroughAttempt: 12, v3Validation: { artifactType: 'fixture' } })]);
      const r1 = await sweepAt(5);
      assert(r1.reservationsReconciled.length <= PR.PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK, `tope por tick: ${r1.reservationsReconciled.length}`);
      const mine1 = r1.reservationsReconciled.filter((x) => x.runId === C.runId).length;
      assert(mine1 >= 1 && mine1 < 12, `no todas en un tick: ${mine1}`);
      let total = mine1;
      for (let t = 0; t < 3 && total < 12; t++) {
        const rn = await sweepAt(65 + t * 60);
        assert(rn.reservationsReconciled.length <= PR.PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK, 'tope por tick');
        total += rn.reservationsReconciled.filter((x) => x.runId === C.runId).length;
      }
      eq(total, 12, 'el resto en los ticks siguientes');
      await ledgerWithinAuthorized(C.runId);
    });

    // ═══ X — runs anteriores al corte (review M1) ═══════════════════════════
    await check('[X] un run creado ANTES del corte de activación: el barrido no lo toma y la completitud muestra la acción de admin de inmediato', async () => {
      const C = await videogenFailed('r62 histórico', { jobId: 'vg-hist', error: 'render failed', cost: 0.5, breakdown: { render: 0.5 } });
      process.env.PROVIDER_RECONCILE_RUNS_SINCE = new Date(Date.now() + 86400000).toISOString();
      try {
        const r = await sweepAt(5);
        eq([r.resubmitted.length, r.waiting.length, r.declined.length], [0, 0, 0], JSON.stringify(r));
        eq((await vgAdj(C)).length, 0, 'nada conciliado');
        assert(((await completionOf(C)).adminActions || []).some((a) => a.itemKey === `video:${C.c1}`), 'acción visible (no oculta 6 h)');
      } finally { process.env.PROVIDER_RECONCILE_RUNS_SINCE = '2020-01-01T00:00:00Z'; }
    });

    // ═══ Gamma ═══════════════════════════════════════════════════════════════
    const G = await makeCourse('r62 Gamma');
    const gkey = `presentation:${G.c1}`;
    await check('[G1] Gamma fallido con créditos DEDUCIDOS (el worker ya liquidó 40 créditos) → reenvío automático sin consultar ni reajustar', async () => {
      await gammaFailed(G, 'gen-g1', 40);
      const n0 = (await events(G.runId)).length; const g0 = fakes.gm.getCalls;
      const r = await sweepAt(5);
      eq(r.resubmitted.filter((x) => x.runId === G.runId).map((x) => [x.itemKey, x.kind, x.settlement]), [[gkey, 'gamma_failed', 'measured_by_worker']], JSON.stringify(r));
      eq([(await events(G.runId)).length - n0, fakes.gm.getCalls - g0], [0, 0], 'sin ajustes ni GET');
      const row = await latest(G.runId, gkey);
      eq([row.status, !!row.output_summary.external, row.output_summary.previousExternals.slice(-1)[0].external.gammaGenerationId], ['pending', false, 'gen-g1'], 'generación archivada (resubmitProvider)');
      eq((await reopenAttempts(row.id)).map((a) => [a.actor, a.strategy_applied]), [['system', 'provider_reconcile_resubmit:gamma_failed']], 'intento system');
      await ledgerWithinAuthorized(G.runId);
    });
    await check('[G2] Gamma fallido SIN créditos en el fallo → GET /generations/{id} informa credits.deducted=12 → liquidado medido (USD 0,12) → reenvío', async () => {
      fakes.gm.gens.set('gen-g2', { status: 'failed', credits: 12 });
      await gammaFailed(G, 'gen-g2', null);
      const r = await sweepAt(5);
      eq(r.resubmitted.filter((x) => x.runId === G.runId).map((x) => [x.kind, x.settlement, x.ambiguous]), [['gamma_failed', 'measured', false]], JSON.stringify(r));
      const fam = (await events(G.runId)).filter((e) => e.idempotency_key === 'gamma:gen:gen-g2' || (e.event_kind === 'ADJUSTMENT' && e.metadata.adjusts === 'gamma:gen:gen-g2'));
      const net = fam.reduce((t, e) => t + dec(e.amount), 0);
      assert(Math.abs(net - 0.12) < 1e-9, `liquidado a 12 créditos: ${net} ${JSON.stringify(fam.map((e) => [e.event_kind, e.amount]))}`);
      eq(fam.find((e) => e.event_kind === 'ADJUSTMENT').recorded_by, 'system_provider_reconcile', 'del sistema');
      eq((await latest(G.runId, gkey)).output_summary.providerReconcile.rounds, 2, 'segunda ronda de la parte');
      await ledgerWithinAuthorized(G.runId);
    });
    await check('[G4] tercera falla de la MISMA parte (ya usó sus 2 reenvíos) → excepción registrada (cap_reached) una sola vez, sin reenvío; la acción de admin aparece', async () => {
      await gammaFailed(G, 'gen-g4', 40);
      const r = await sweepAt(5);
      eq([r.resubmitted.filter((x) => x.runId === G.runId).length, r.declined.filter((x) => x.runId === G.runId).map((x) => x.reason)], [0, ['cap_reached']], JSON.stringify(r));
      const row = await latest(G.runId, gkey);
      eq([row.status, row.output_summary.providerReconcile.declined, row.attention], ['failed', 'cap_reached', 'unrecoverable'], 'excepción');
      const comp = await completionOf(G);
      assert((comp.adminActions || []).some((a) => a.itemKey === gkey), `acción visible: ${JSON.stringify(comp.adminActions)}`);
      const r2 = await sweepAt(60);
      eq([r2.skipped.concat(r2.declined, r2.resubmitted, r2.waiting).filter((x) => x.runId === G.runId).length], [0], 'no se re-evalúa (ni siquiera es candidato)');
      await ledgerWithinAuthorized(G.runId);
    });
    const G3 = await makeCourse('r62 Gamma sin créditos');
    const g3key = `presentation:${G3.c1}`;
    await check('[G3] Gamma sin créditos y Gamma nunca los informa → en espera (sin reenvío) hasta el tope de consulta; después conservador (estimado completo) + reenvío (la generación ya terminó: sin doble generación viva)', async () => {
      fakes.gm.gens.set('gen-g3', { status: 'failed', credits: null });
      await gammaFailed(G3, 'gen-g3', null);
      const r1 = await sweepAt(5);
      eq([r1.resubmitted.filter((x) => x.runId === G3.runId).length, r1.waiting.filter((x) => x.runId === G3.runId).map((x) => x.itemKey)], [0, [g3key]], `espera ${JSON.stringify(r1)}`);
      const comp = await completionOf(G3);
      eq((comp.adminActions || []).filter((a) => a.itemKey === g3key), [], 'mientras espera, sin acción de admin');
      const r2 = await sweepAt(PR.PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS + 5);
      eq(r2.resubmitted.filter((x) => x.runId === G3.runId).map((x) => [x.kind, x.settlement, x.ambiguous]), [['gamma_failed', 'reconciled_as_charged', false]], JSON.stringify(r2));
      const adj = (await events(G3.runId)).filter((e) => e.event_kind === 'ADJUSTMENT' && e.metadata.adjusts === 'gamma:gen:gen-g3');
      eq(adj.map((e) => [e.amount, e.metadata.settlement, e.metadata.conservative, e.metadata.possible_duplicate]), [['0.0000000000', 'reconciled_as_charged', true, undefined]], 'conservador');
      eq((await latest(G3.runId, g3key)).output_summary.providerReconcile.ambiguousRounds, 0, 'no consume el reenvío ambiguo');
      await ledgerWithinAuthorized(G3.runId);
    });

    // ═══ Envío ambiguo sin id ════════════════════════════════════════════════
    const A1 = await makeCourse('r62 ambiguo dentro');
    const a1key = `video:${A1.c1}`;
    await check('[A1] envío a Videogen ambiguo SIN jobId (502 del batch-create) dentro del presupuesto → conservador charged + possible_duplicate → UN reenvío → el render termina', async () => {
      fakes.vg.plan.push({ kind: 'http502' });
      const s = await runVideo(A1);
      eq(s.st.failed.map((f) => f.msg.split(':')[0]), ['ambiguous_video_submission'], JSON.stringify(s.st.failed));
      const r = await sweepAt(PR.PROVIDER_RECONCILE_BACKOFF_SECONDS + 5);
      eq(r.resubmitted.map((x) => [x.kind, x.settlement, x.ambiguous]), [['videogen_ambiguous', 'reconciled_as_charged', true]], JSON.stringify(r));
      const adj = (await events(A1.runId)).filter((e) => e.provider === 'videogen' && e.event_kind === 'ADJUSTMENT');
      eq(adj.map((e) => [e.metadata.settlement, e.metadata.possible_duplicate, e.metadata.decidedBy]), [['reconciled_as_charged', true, 'system']], 'marca possible_duplicate');
      fakes.vg.plan.push({ kind: 'ok', jobId: 'vg-a1-b', statuses: ['completed_local'], cost: 0.97 });
      const s2 = await runVideo(A1);
      eq([s2.st.completed.length, (await latest(A1.runId, a1key)).status], [1, 'completed'], `completo ${JSON.stringify(s2.st.failed)} ${workerLog.errors.join(' | ')}`);
      await ledgerWithinAuthorized(A1.runId);
      await noAdminAdjustments(A1.runId);
    });
    const A2 = await makeCourse('r62 ambiguo fuera');
    const a2key = `video:${A2.c1}`;
    await check('[A2] envío ambiguo FUERA del presupuesto (saldo autorizado < lo liquidado + la reserva nueva) → excepción registrada (run_budget_cap, attention_reason=budget), sin reenvío; lo incierto queda contado', async () => {
      fakes.vg.plan.push({ kind: 'http502' });
      await runVideo(A2);
      // El saldo autorizado del run se ajusta a lo ya comprometido + 0,10 (no entra otra reserva de 1,175).
      const spent = await runTotal(A2.runId);
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run' order by created_at desc limit 1`, [A2.runId]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                      values ($1, $2, $3, $4, 'ADMIN_APPROVED', 'admin@cursia.test', 'check r62: saldo justo')`, [A2.runId, A2.cid, est.id, (spent + 0.1).toFixed(4)]);
      const sub0 = fakes.vg.submits;
      const r = await sweepAt(PR.PROVIDER_RECONCILE_BACKOFF_SECONDS + 5);
      eq([r.resubmitted.length, r.declined.map((x) => x.reason)], [0, ['run_budget_cap']], JSON.stringify(r));
      eq(fakes.vg.submits - sub0, 0, 'sin envío');
      const row = await latest(A2.runId, a2key);
      eq([row.status, row.output_summary.providerReconcile.declined, row.attention], ['failed', 'run_budget_cap', 'budget'], 'excepción explícita');
      const adj = (await events(A2.runId)).filter((e) => e.provider === 'videogen' && e.event_kind === 'ADJUSTMENT');
      eq(adj.map((e) => [e.metadata.settlement, e.metadata.possible_duplicate]), [['reconciled_as_charged', true]], 'la reserva incierta quedó cobrada (contada)');
      const comp = await completionOf(A2);
      assert((comp.adminActions || []).some((a) => a.itemKey === a2key), `acción visible: ${JSON.stringify(comp.adminActions)}`);
      await ledgerWithinAuthorized(A2.runId);
      const r2 = await sweepAt(PR.PROVIDER_RECONCILE_BACKOFF_SECONDS + 120);
      eq([r2.resubmitted.length, r2.declined.length], [0, 0], 'no se re-evalúa en cada tick');
    });

    // ═══ D5 — reserva archivada con jobId ════════════════════════════════════
    const D = await makeCourse('r62 d5');
    await check('[D5] reserva de Videogen de un intento ARCHIVADO (reenvío previo) con jobId → conciliada sola con el costo del job (charged_partial), sin endpoint de admin', async () => {
      const it = await latest(D.runId, `video:${D.c1}`);
      const resKey = await HK.reservePaidCall(ledger, { kind: 'videogen', ownerId: OWNER, itemRunId: it.id, generation: it.generation, itemAttempt: 1, tag: 'submit', estimate: {} });
      fakes.vg.jobs.set('vg-d5-old', { statuses: ['failed'], error: 'render failed', cost: 0.3 });
      await ds.query(`update public.generation_item_runs set attempt_count = 2, status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || $2::jsonb where id = $1`,
        [it.id, JSON.stringify({ previousExternals: [{ external: { videogenJobId: 'vg-d5-old', mode: 'real' }, externalReservationKey: resKey, reason: 'videogen_failed: render failed' }],
          reconciliationAcknowledgedThroughAttempt: 1, external: { videogenJobId: 'vg-d5-new', mode: 'real' }, v3Validation: { artifactType: 'fixture' } })]);
      const before = await L('modules/dynamic-generation/run-completion.js').loadPendingVideogenReservations(ds, D.runId);
      eq(before.map((p) => p.reservationKey), [resKey], 'pendiente (antes: acción de admin)');
      const r = await sweepAt(5);
      eq(r.reservationsReconciled.map((x) => [x.reservationKey, x.settlement]), [[resKey, 'charged_partial']], JSON.stringify(r));
      eq((await L('modules/dynamic-generation/run-completion.js').loadPendingVideogenReservations(ds, D.runId)).length, 0, 'ya no queda pendiente');
      const comp = await completionOf(D);
      eq((comp.adminActions || []).filter((a) => a.code === 'reconcile_videogen_reservation'), [], 'sin acción de conciliación de admin');
      await ledgerWithinAuthorized(D.runId);
    });

    await check('[L] en todos los runs: ledger ≤ autorizado; ningún ajuste de admin; todo ajuste automático lleva decidedBy=system', async () => {
      for (const C of [V1, V2, V2b, V2c, G, G3, A1, A2, D]) {
        await ledgerWithinAuthorized(C.runId);
        await noAdminAdjustments(C.runId);
        for (const e of (await events(C.runId)).filter((x) => x.recorded_by === 'system_provider_reconcile')) eq(e.metadata.decidedBy, 'system', 'decidedBy');
      }
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fakes.srv.close();
    restoreProviders();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) {
    try { await dbChecks(); } catch (err) { failures++; console.error(`❌ DB: ${err && err.stack ? err.stack.split('\n').slice(0, 10).join('\n   ') : err}`); }
  }
  console.log(`\n${failures ? '❌' : '✅'} check-r62-provider-reconcile: ${passes} ok, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})();
