#!/usr/bin/env node
/* eslint-disable */
// Loop Cost Efficiency + Reliability (tras el piloto #1209): presupuesto de recuperación por parte + tope del run +
// disyuntor de consumo anómalo, aplicados en el SERVIDOR antes de cada llamada pagada (proxy LLM del navegador y
// workers). USD 0: proveedores solo como variables falsas, nunca se llaman; el "proveedor" es el ledger simulado.
//
// Parte pura: decideRunSpend (tope / parte / disyuntor / aceptación al reanudar) + simulación de INTERVENCIONES
// HUMANAS en un curso hipotético con varios errores.
// Parte DB (PG16 desechable): escenarios 4–10 del loop (desconocido sin reintento, una parte agota su presupuesto
// y el resto sigue, gasto dentro del margen, disyuntor + pausa segura, varias capas sin multiplicarse, pausa sin
// gasto, reanudar desde checkpoints sin recobrar).
//
// Usage: npm run build && node scripts/check-recovery-budget.js [--pure-only] [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const EL = loadDist('modules/reliability/execution-lease.js');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

Logger.overrideLogger({ log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const G = loadDist('modules/finops/run-spend-guard.js');
  const base = { authorizedBudget: 100, runSpent: 0, nextCost: 0.15, itemSpent: 0, itemExpected: 0.1, itemEstimatedMax: 0.17, runExpected: 43.29, progressExpected: 0 };

  await check('puro: la PRIMERA llamada de una parte siempre pasa; mientras lo gastado < límite (2,5× esperado / máx. estimado / piso USD 0,25) la parte sigue recuperándose', () => {
    eq(G.itemHardLimit(0.1, 0.17), 0.25, 'piso');
    eq(Number(G.itemHardLimit(0.22, 0.4).toFixed(4)), 0.55, '2,5× esperado');
    eq(G.decideRunSpend(base).allow, true, '1.ª llamada');
    eq(G.decideRunSpend({ ...base, itemSpent: 0.24 }).allow, true, 'aún bajo el límite');
    const d = G.decideRunSpend({ ...base, itemSpent: 0.25 });
    eq([d.allow, d.reason], [false, 'item_recovery_budget_exhausted'], 'alcanzado');
  });

  await check('puro: tope del run (autorizado) y disyuntor — unos centavos de más NO disparan; una anomalía significativa sí; al reanudar, lo aceptado sube el umbral (rearmado)', () => {
    eq(G.decideRunSpend({ ...base, authorizedBudget: 10, runSpent: 9.9 }).reason, 'run_budget_cap', 'tope');
    // umbral = 1,5 × esperado(progreso) + max(3, 10 % × 43,29 = 4,33)
    const t = G.breakerThreshold(43.29, 10);
    eq(Number(t.toFixed(3)), 19.329, 'umbral');
    eq(G.decideRunSpend({ ...base, runSpent: 15.5, progressExpected: 10 }).allow, true, '+55 % sobre lo esperado del avance: dentro del margen');
    eq(G.decideRunSpend({ ...base, runSpent: 19.3, progressExpected: 10 }).reason, 'circuit_breaker', 'anomalía');
    eq(G.decideRunSpend({ ...base, runSpent: 19.3, progressExpected: 10, breakerAcknowledgedUsd: 2 }).allow, true, 'aceptado al reanudar');
    eq(G.decideRunSpend({ ...base, runSpent: 23, progressExpected: 10, breakerAcknowledgedUsd: 2 }).reason, 'circuit_breaker', 'anomalía NUEVA → vuelve a disparar');
    eq(G.decideRunSpend({ ...base, runExpected: null, progressExpected: null, runSpent: 99 }).allow, true, 'sin estimado: sin disyuntor (solo tope)');
  });

  await check('puro: SIMULACIÓN — intervenciones humanas en un curso M hipotético (112 partes) con errores normales y en un escenario tipo #1209', () => {
    const CL = loadDist('modules/reliability/failure-classifier.js');
    const AH = loadDist('modules/dynamic-generation/auto-heal.js');
    const human = (error) => {
      const row = { id: 'x', type: 'content', status: 'failed', error, output_summary: {}, finished_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date(Date.now() - 3600e3).toISOString(), attempt_count: 3, max_attempts: 3 };
      const v = CL.classifyFailure({ source: 'browser', itemType: 'content', error, outputSummary: {} });
      const heal = AH.autoHealDecision(row, new Date());
      return { cls: v.class, auto: heal.heal === true || (v.class === 'A' || v.class === 'B') };
    };
    // Errores NORMALES: se resuelven solos (transitorios, proveedor ocupado, formato) → 0 intervenciones.
    const normal = [
      '❌ Falló después de 4 intentos: Error de red: Failed to fetch',
      '❌ Falló después de 4 intentos: Servidor ocupado (529). Reintentando…',
      'experience inválido tras reintento dirigido: $.movements.deepening[2]: falta campo',
      'SCORM v2 inválido: sala 3 sin opciones',
      'lease_expired',
    ];
    for (const e of normal) { const h = human(e); assert(h.auto && h.cls !== 'D' && h.cls !== 'C', 'automático: ' + e + ' → ' + h.cls); }
    // Requieren a una persona (nunca se reintentan solos): resultado desconocido (524), parte sin presupuesto, crédito.
    const needs = [
      '⚠️ Resultado ambiguo de la IA (HTTP 524: la respuesta se perdió y el proveedor pudo cobrarla). No se reintenta solo para no pagarla dos veces.',
      G.itemRecoveryBudgetMessage('esta parte ya gastó USD 0.36 (esperado USD 0.10, presupuesto de recuperación hasta USD 0.25)'),
    ];
    for (const e of needs) assert(!human(e).auto, 'a una persona: ' + e.slice(0, 40));
    // Curso hipotético: 3 cortes de red, 2 «proveedor ocupado», 4 errores de formato, 1 lease vencido, 1 resultado
    // desconocido, 1 parte que falla siempre (agota su presupuesto) → solo 2 intervenciones (las 2 partes), el resto sigue.
    const events = [].concat(Array(3).fill(normal[0]), Array(2).fill(normal[1]), Array(4).fill(normal[2]), [normal[4]], [needs[0]], [needs[1]]);
    const interventions = events.filter((e) => !human(e).auto).length;
    eq(interventions, 2, 'curso con varios errores normales');
    // Escenario tipo #1209 (sin el cambio 4): los 524 son estructurales en Libro Guía / Actividades → cada parte afectada
    // pide una persona UNA vez (antes: se reintentaba a ciegas hasta 13 veces y gastaba).
    console.log('   métrica — intervenciones: curso hipotético = 2; tipo #1209 sin dividir llamadas largas ≈ 1 por parte con 524 (≈ 20 de 27 partes largas)');
  });
}

// ════════════════════════════════════════════════════════════════════════════
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
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso REL lease', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];
const A = 'browser-dev-AAAAAAAA';
const B = 'browser-dev-BBBBBBBB';
const TYPES = ['content', 'experience'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const AL = loadDist('modules/reliability/attempt-log.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-recbudget-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-recbudget-cwd-'));
  const ROLE = 'postgres.recbudgetlocal01';
  const DB = 'recbudgetdb';
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
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    {
      const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({}));
      assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    {
      const res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `migrate-rel-exec-lease: ${res.out.slice(-800)}`);
    }
    const indexDef = async () => (await withClient(DB, (c) => c.query(`select indexdef from pg_indexes where indexname = 'uq_dynamic_generation_active_run'`))).rows[0].indexdef;

    await check('DB migración run-pause: sin MIGRATION_ENV=staging se niega; dos veces (idempotente) → el índice único de run activo incluye paused', async () => {
      assert(!/'paused'/.test(await indexDef()), 'antes: sin paused');
      let res = runScript('scripts/migrate-run-pause.js', localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV/.test(res.out), 'guardarraíl staging: ' + res.out.slice(-300));
      for (let i = 0; i < 2; i++) {
        res = runScript('scripts/migrate-run-pause.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `migrate #${i + 1}: ${res.out.slice(-800)}`);
      }
      const def = await indexDef();
      assert(/'queued'/.test(def) && /'running'/.test(def) && /'retrying'/.test(def) && /'paused'/.test(def) && /UNIQUE/i.test(def), def);
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    AL.resetRelSchemaCache();
    EL.resetExecLeaseSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID(); const c3 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true },
          { id: c3, module_id: m1, position: 2, title: 'Sellos', objective: null, video_enabled: false, activity_enabled: true }],
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
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 3)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check REL lease' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      // Todo completado salvo los 3 content (pendientes, reclamables por el navegador).
      const keys = [c1, c2, c3].map((c) => `content:${c}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and not (item_key = any($2::text[]))`, [runId, keys]);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and item_key = any($2::text[])`, [runId, keys]);
      return { cid, m1, c1, c2, c3, runId, keys };
    }
    const runRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    const claim = (runId, executorId, extra = {}) => sched.claimNextItemDetailed({ runId, executorId, types: TYPES, leaseSeconds: 120, ownerId: OWNER, ...extra });
    const secsLeft = (row) => (new Date(row.executor_lease_expires_at).getTime() - Date.now()) / 1000;
    const expire = (runId) => ds.query(`update public.production_jobs set executor_lease_expires_at = now() - interval '1 second' where id = $1`, [runId]);
    async function readsFor(C) {
      const out = {};
      for (const ex of [A, B, null]) {
        const dto = await runs.getRun(C.cid, OWNER, 1, C.runId, { executorId: ex });
        const cur = await runs.getCurrentRun(C.cid, OWNER, 1, { executorId: ex });
        assert(dto && dto.id === C.runId && cur && cur.id === C.runId, 'GET ok para ' + ex);
        assert(Array.isArray(dto.items) && dto.items.length > 0 && dto.progress, 'progreso visible para ' + ex);
        out[ex || 'anon'] = dto.executionLease;
      }
      return out;
    }

    const PREFIX_UNUSED = null; void PREFIX_UNUSED;
    const AH = loadDist('modules/dynamic-generation/auto-heal.js');
    const CL = loadDist('modules/reliability/failure-classifier.js');
    const G = loadDist('modules/finops/run-spend-guard.js');
    const status = async (runId) => { const r = await runRow(runId); return [r.status, r.worker_status]; };
    const itemOf = async (C, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [C.runId, key]))[0];
    const runSpent = async (runId) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1`, [runId]))[0].t);
    const itemSpent = async (runId, key) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and item_key = $2`, [runId, key]))[0].t);
    // Una llamada del proxy LLM tal como la hace functions/api/proxy.js: guard → reserva → (proveedor falso) → liquidación.
    let msgSeq = 0;
    async function proxyCall(itemRunId, o = {}) {
      const promptChars = o.promptChars ?? 36000;
      const maxTokens = o.maxTokens ?? 8000;
      const deny = await budget.guardLlmProxyCall({ subject: OWNER, itemRunId, model: 'claude-sonnet-4-6', promptChars, maxTokens, billingAccount: 'cursia' });
      if (deny) return { denied: deny };
      const callId = crypto.randomUUID();
      await ledger.recordCharge(F.llmReservationToChargeInput(F.parseLlmReservationIngest({ subject: OWNER, itemRunId, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', callId, promptChars, maxTokens, billingAccount: 'cursia' })));
      if (o.outcome === 'unknown') return { callId, pending: true };
      const u = F.parseLlmUsageIngest({ subject: OWNER, itemRunId, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', messageId: 'msg_rb_' + (++msgSeq), usage: { input_tokens: o.inTok ?? 12000, output_tokens: o.outTok ?? 5400 }, billingAccount: 'cursia', callId });
      await ledger.settleReservation(F.llmProxyReservationKey(callId), F.llmIngestToChargeInput(u), 'llm_proxy_measured');
      return { callId, ok: true };
    }
    const allPending = (C) => ds.query(`update public.generation_item_runs set status = 'pending', finished_at = null where job_id = $1`, [C.runId]);

    // ── Escenarios 4, 5, 6 ─────────────────────────────────────────────────────
    const C = await makeCourse('Presupuesto de recuperación');
    const est = await budget.runItemEstimates(C.runId);
    const k1 = `content:${C.c1}`;
    const hard1 = G.itemHardLimit(est.byKey.get(k1).expected, est.byKey.get(k1).max);

    await check('DB escenario 6: una parte que gasta MÁS de lo esperado sigue recuperándose dentro de su margen y se detiene SOLO al alcanzar su límite (exceso máx. 1 llamada)', async () => {
      const it = await itemOf(C, k1);
      let allowed = 0;
      let denial = null;
      for (let i = 0; i < 10 && !denial; i++) {
        const r = await proxyCall(it.id);
        if (r.denied) denial = r.denied; else allowed++;
      }
      assert(denial && denial.code === 'item_recovery_budget_exhausted', 'se detuvo por presupuesto: ' + JSON.stringify(denial));
      const spent = await itemSpent(C.runId, k1);
      assert(allowed >= 2, `tuvo oportunidades reales de recuperación (${allowed} llamadas; esperado ${est.byKey.get(k1).expected.toFixed(3)}, límite ${hard1.toFixed(3)})`);
      assert(spent >= hard1 && spent < hard1 + 0.2, `gastado ${spent.toFixed(3)} ≈ límite ${hard1.toFixed(3)} + ≤ 1 llamada`);
      console.log(`   parte ${k1}: esperado USD ${est.byKey.get(k1).expected.toFixed(3)}, límite USD ${hard1.toFixed(3)}, ${allowed} llamadas permitidas, gastado USD ${spent.toFixed(3)}`);
    });

    await check('DB escenario 5: la parte que agotó su presupuesto queda fallida NO reintentable, fuera del auto-heal; las demás partes siguen (otra parte llama, el claim entrega otras)', async () => {
      const it = await itemOf(C, k1);
      const cl = await sched.claimNextItemDetailed({ runId: C.runId, executorId: A, types: TYPES, leaseSeconds: 120, ownerId: OWNER });
      assert(cl.item, 'claim entrega una parte');
      // El navegador falla la parte con el código estable (lo que hace el ejecutor al recibir item_recovery_budget_exhausted).
      const target = cl.item.itemKey === k1 ? cl.item : null;
      if (target) await sched.failItem(target.itemRunId, A, G.itemRecoveryBudgetMessage('test'), false);
      else await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where id = $1`, [it.id, G.itemRecoveryBudgetMessage('test')]);
      const row = await itemOf(C, k1);
      eq(row.status, 'failed', 'fallida');
      const v = CL.classifyFailure({ source: 'browser', itemType: 'content', error: row.error, outputSummary: row.output_summary || {} });
      eq([v.class, v.code], ['D', 'item_recovery_budget_exhausted'], 'clase D (solo esta parte)');
      const heal = AH.autoHealDecision({ ...row, finished_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date(Date.now() - 3600e3).toISOString() }, new Date());
      eq(heal.heal, false, 'el auto-heal NO la reabre');
      const other = await itemOf(C, `content:${C.c2}`);
      const r2 = await proxyCall(other.id);
      assert(r2.ok, 'otra parte sigue llamando: ' + JSON.stringify(r2));
      eq(await status(C.runId).then((s) => s[1] !== 'paused'), true, 'el run NO se pausó');
    });

    await check('DB escenario 4: resultado DESCONOCIDO → la reserva queda pendiente y CUENTA (parte y run); el 524 ambiguo nunca se reintenta solo (clase D, fuera del auto-heal)', async () => {
      const k3 = `content:${C.c3}`;
      const it = await itemOf(C, k3);
      const before = await itemSpent(C.runId, k3);
      const r = await proxyCall(it.id, { outcome: 'unknown' });
      assert(r.pending, 'pendiente');
      const after = await itemSpent(C.runId, k3);
      assert(after > before, 'la reserva pendiente cuenta en la parte');
      const msg = '⚠️ Resultado ambiguo de la IA (HTTP 524: la respuesta se perdió y el proveedor pudo cobrarla). No se reintenta solo para no pagarla dos veces.';
      const v = CL.classifyFailure({ source: 'browser', itemType: 'content', error: msg, outputSummary: {} });
      eq([v.class, v.code], ['D', 'llm_response_lost'], 'clase');
      const heal = AH.autoHealDecision({ id: it.id, type: 'content', status: 'failed', error: msg, output_summary: {}, finished_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date(Date.now() - 3600e3).toISOString() }, new Date());
      eq(heal.heal, false, 'sin reintento automático');
    });

    // ── Escenario 8: varias capas sobre la MISMA parte no se multiplican ───────────
    await check('DB escenario 8: navegador (reintentos de la llamada) + auto-heal (reaperturas) + worker sobre partes que fallan a la vez → cada parte queda acotada por SU presupuesto, sin importar la capa', async () => {
      const D = await makeCourse('Varias capas');
      const estD = await budget.runItemEstimates(D.runId);
      const keys = [`content:${D.c1}`, `content:${D.c2}`, `content:${D.c3}`];
      // 3 partes fallando a la vez: 15 intentos cada una, intercalados (como lanes + rondas del auto-heal).
      const allowed = Object.fromEntries(keys.map((k) => [k, 0]));
      for (let round = 0; round < 15; round++) {
        await Promise.all(keys.map(async (k) => {
          const it = await itemOf(D, k);
          const r = await proxyCall(it.id);
          if (r.ok) allowed[k]++;
        }));
        // el auto-heal reabre (retryItem auto) — no cambia el presupuesto de la parte
      }
      for (const k of keys) {
        const lim = G.itemHardLimit(estD.byKey.get(k).expected, estD.byKey.get(k).max);
        const sp = await itemSpent(D.runId, k);
        assert(sp < lim + 0.35, `${k}: gastado ${sp.toFixed(3)} acotado por su límite ${lim.toFixed(3)} (+ llamadas concurrentes en vuelo)`);
        assert(allowed[k] <= 6, `${k}: ${allowed[k]} llamadas de 15 intentos`);
      }
      // Worker de proveedores: su propia parte con su propio presupuesto (mismo guard).
      const pres = (await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'presentation' limit 1`, [D.runId]))[0];
      const presExp = estD.byKey.get(pres.item_key);
      if (presExp) {
        const lim = G.itemHardLimit(presExp.expected, presExp.max);
        // Lo gastado en la parte (cualquier proveedor / capa) supera su límite → el worker tampoco puede enviar.
        const r = await proxyCall(pres.id, { inTok: Math.ceil(lim / 3e-6) + 1000, outTok: 10 });
        assert(r.ok, 'carga previa de la parte');
        const g = await budget.guardPaidSubmission({ runId: D.runId, itemRunId: pres.id, itemType: 'presentation' });
        eq([g.allow, g.reason], [false, 'item_recovery_budget_exhausted'], 'worker: misma regla por parte');
      }
    });

    // ── Escenarios 7, 9, 10 ───────────────────────────────────────────────────
    const E = await makeCourse('Disyuntor');
    await check('DB escenario 7: consumo global ANÓMALO → el disyuntor pausa el run (pausa segura); el navegador recibe run_paused, el claim y los workers también', async () => {
      await allPending(E);
      const estE = await budget.runItemEstimates(E.runId);
      const it1 = await itemOf(E, `content:${E.c1}`);
      const it2 = await itemOf(E, `content:${E.c2}`);
      // Primera llamada de la parte 1: el proveedor (falso) devuelve un uso enorme → el run queda muy por encima de lo esperado.
      const r1 = await proxyCall(it1.id, { inTok: 1500000, outTok: 50000 });
      assert(r1.ok, 'primera llamada');
      const spent = await runSpent(E.runId);
      const r2 = await proxyCall(it2.id);
      assert(r2.denied && r2.denied.code === 'run_paused' && r2.denied.paused, 'disyuntor: ' + JSON.stringify(r2));
      eq(await status(E.runId), ['paused', 'paused'], 'run pausado por Cursia');
      const row = await runRow(E.runId);
      eq([row.output_summary.pause.pausedBy, row.output_summary.pause.reason], ['system:circuit_breaker', 'circuit_breaker'], 'motivo');
      const dto = await runs.getRun(E.cid, OWNER, 1, E.runId, {});
      eq([dto.paused, dto.pauseInfo.automatic, dto.pauseInfo.reason], [true, true, 'circuit_breaker'], 'la UI lo explica');
      const cl = await sched.claimNextItemDetailed({ runId: E.runId, executorId: A, types: TYPES, leaseSeconds: 120, ownerId: OWNER });
      eq([cl.item, cl.reason], [null, 'run_paused'], 'claim');
      console.log(`   run gastó USD ${spent.toFixed(2)} con esperado del avance ≈ 0 (run esperado USD ${estE.total.toFixed(2)}) → pausa`);
    });

    await check('DB escenario 9: con el run PAUSADO nadie gasta — proxy (navegador) run_paused, worker de proveedores run_paused, claim run_paused; 0 cargos nuevos', async () => {
      const n0 = (await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1`, [E.runId]))[0].n;
      const it3 = await itemOf(E, `content:${E.c3}`);
      const r = await proxyCall(it3.id);
      eq(r.denied && r.denied.code, 'run_paused', 'navegador');
      const vid = (await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'video' limit 1`, [E.runId]))[0];
      const g = await budget.guardPaidSubmission({ runId: E.runId, itemRunId: vid.id, itemType: 'video' });
      eq([g.allow, g.reason], [false, 'run_paused'], 'worker');
      const n1 = (await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1`, [E.runId]))[0].n;
      eq(n1, n0, 'sin cargos nuevos');
    });

    await check('DB escenario 10: REANUDAR → el disyuntor acepta el sobreconsumo previo (no vuelve a disparar por lo mismo), sigue desde los checkpoints (las partes terminadas no se reclaman ni se recobran) y se rearma ante una anomalía NUEVA', async () => {
      // Una parte terminada (checkpoint) antes de reanudar.
      const done = await itemOf(E, `experience:${E.c1}`) || null;
      if (done) await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [done.id]);
      const chargesDone = done ? (await ds.query(`select count(*)::int n from public.generation_cost_events where item_run_id = $1`, [done.id]))[0].n : 0;
      const dto = await runs.resumeRun(E.cid, OWNER, 1, E.runId);
      assert(!dto.paused, 'reanudado');
      const row = await runRow(E.runId);
      assert(Number(row.output_summary.spendBreaker.acknowledgedUsd) > 0, 'sobreconsumo aceptado registrado');
      const it3 = await itemOf(E, `content:${E.c3}`);
      const r = await proxyCall(it3.id);
      assert(r.ok, 'la llamada siguiente pasa: ' + JSON.stringify(r));
      const claimed = [];
      for (let i = 0; i < 6; i++) {
        const cl = await sched.claimNextItemDetailed({ runId: E.runId, executorId: A, types: TYPES, leaseSeconds: 120, ownerId: OWNER });
        if (!cl.item) break;
        claimed.push(cl.item.itemKey);
      }
      if (done) assert(!claimed.includes(done.item_key), 'la parte terminada no se vuelve a entregar');
      if (done) eq((await ds.query(`select count(*)::int n from public.generation_cost_events where item_run_id = $1`, [done.id]))[0].n, chargesDone, 'ni se vuelve a cobrar');
      // Anomalía NUEVA → vuelve a pausar.
      const it2 = await itemOf(E, `content:${E.c2}`);
      await proxyCall(it2.id, { inTok: 1500000, outTok: 50000 });
      const r3 = await proxyCall(it3.id);
      assert(r3.denied && r3.denied.code === 'run_paused', 'rearmado: ' + JSON.stringify(r3));
    });

    await check('DB escenario 7b: una desviación PEQUEÑA no pausa (sin falsos positivos): +40 % de gasto sobre lo esperado del avance → sigue', async () => {
      const H = await makeCourse('Sin falso positivo');
      const it = await itemOf(H, `content:${H.c1}`);
      // makeCourse deja todo terminado salvo los 3 content: avance esperado ≈ casi todo el run; gasto normal + 40 % del content.
      for (let i = 0; i < 2; i++) { const r = await proxyCall(it.id, { inTok: 12000, outTok: 5400 }); assert(r.ok || (r.denied && r.denied.code === 'item_recovery_budget_exhausted'), JSON.stringify(r)); }
      eq((await status(H.runId))[1] !== 'paused', true, 'no pausado');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});


