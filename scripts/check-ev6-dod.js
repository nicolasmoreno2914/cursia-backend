#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — DoD «curso completo». Fase A: diagnóstico (casos [DOD] que fallaban); Fase B (BE-A):
// implementación — `node scripts/check-ev6-dod.js --strict` debe pasar entero.
//
// Este check CODIFICA la nueva Definition of Done:
//   generación iniciada → TODOS los componentes contratados (según la estructura confirmada)
//   generados y validados (videos REALES incluidos) → paquete Moodle disponible → curso completo.
//   Nunca `completed` si falta o es de vista previa (mock) cualquier componente requerido.
//
// Dos clases de casos:
//   [BASE]  invariantes que YA se cumplen hoy (deben pasar; protegen contra regresiones).
//   [DOD]   comportamiento nuevo (Fase B, BE-A) — cada título conserva qué violaba ANTES («HOY: …» = Fase A).
//
// Contrato propuesto que los [DOD] usan (definido en DOD-diagnosis.md §7):
//   - run v3 con algún componente de vista previa (video mock / proveedor mock) y todo lo demás
//     terminado → worker_status 'preview' (NUNCA 'completed');
//   - RunDto.completion = { state: 'in_progress'|'packaging'|'complete'|'preview'|'needs_attention'|'cancelled',
//       generationComplete: boolean, packageReady: boolean, complete: boolean (= ambos),
//       missingComponents: string[], adminActions: [{code, itemKey?}] };
//   - videoMode por defecto 'real' (camino comercial); 'mock' solo con el escape QA
//     DYNAMIC_ALLOW_VIDEO_PREVIEW=true (403 `video_preview_not_allowed` si no);
//   - el empaquetado de un run de vista previa es solo QA (409 `preview_not_deliverable` sin el escape);
//   - «Generar videos reales» (video-upgrade) es herramienta de ADMIN: preview y confirm → 403 a no-admins.
//
// PG16 DESECHABLE (puerto libre ≠ 5570 y ≠ 8099), esquema real (mismas migraciones que
// check-ev6-video-upgrade.js), servicios COMPILADOS, Videogen/YouTube/Gamma/TTS falsos: 0 red, 0 gasto.
//
// Usage: npm run build && node scripts/check-ev6-dod.js
// Exit code: 0 si todos los [BASE] pasan (los [DOD] fallando es lo esperado en Fase A); 1 si un [BASE]
// falla o el setup falla. `--strict` → 1 si cualquier caso falla (para usar en Fase B).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('data:')) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const STRICT = process.argv.includes('--strict');
const results = { base: { pass: 0, fail: 0 }, dod: { pass: 0, fail: 0 } };
async function check(kind, name, fn) {
  const tag = kind === 'dod' ? '[DOD]' : '[BASE]';
  try {
    await fn();
    results[kind].pass++;
    console.log(`✅ ${tag} ${name}`);
  } catch (err) {
    results[kind].fail++;
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : String(err);
    console.error(`❌ ${tag} ${name}\n   ${msg}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejectsRe(p, re, m, status) {
  let err = null;
  let val;
  try { val = await p; } catch (e) { err = e; }
  assert(err, `${m}: NO lanzó (devolvió ${JSON.stringify(val && typeof val === 'object' ? Object.keys(val) : val)})`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${m}: mensaje inesperado "${text.slice(0, 300)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${m}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
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
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 || port === 8099 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CUSTOMER = '33333333-4444-4555-8666-777777777777'; // cliente normal: V2 sí, fuera de DYNAMIC_REAL_VIDEO_OWNERS
const CONTEXT = { nombre: 'Curso EV6 DoD', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
const QA_MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
const ADMIN = { id: OWNER, email: 'Admin@Cursia.test' };
const OWNER_NOT_ADMIN = { id: OWNER, email: 'owner@cursia.test' };
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'VIDEOGEN_API_KEY', 'ALLOW_UNOWNED_COURSES',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPER_ADMIN_EMAILS', 'DYNAMIC_ALLOW_VIDEO_PREVIEW',
  'DYNAMIC_REAL_VIDEO_ALL_OWNERS',
];

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const F = L('modules/finops/index.js');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
  const T = L('modules/dynamic-generation/item-transitions.js');
  const VU = L('modules/dynamic-generation/video-upgrade.js');
  const features = L('modules/features/dynamic-features.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-dod-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-dod-cwd-'));
  const ROLE = 'postgres.ev6dodlocaltest01';
  const DB = 'ev6doddb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  let setupFailed = false;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`Postgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
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
    for (const s of ['scripts/migrate-production-jobs-constraints.js']) {
      const res = runScript(s, localEnv({}));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_REAL_VIDEO_ALL_OWNERS;
    // Fase B: los runs de vista previa de este check se crean por el camino QA (escape explícito);
    // los casos «producción» lo borran en su propio bloque.
    process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = 'true';
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    require('./lib/provider-test-env').applyFakeProviderEnv();
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.VIDEOGEN_API_KEY = 'fake-key-never-used-no-network';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytPreflight = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytPreflight, budget);
    const packaging = new PackagingService(ds, manifests, {});

    const latest = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const jobOf = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    const recompute = (runId) => runs.tx((qr) => T.recomputeRunStatus(qr, runId));

    /** Curso v3 confirmado (1 módulo, 2 capítulos con video, uno con actividad, examen de módulo + final). Sin run. */
    async function confirmedCourse(title, owner = OWNER, { videos = true } = {}) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [owner, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID();
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: videos, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: videos, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled)
                          values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      const mf = await manifests.getOrCreate(cid, owner, 1);
      await ds.query(
        `insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, 'ADMIN_APPROVAL')`,
        [String(cid), JSON.stringify({ maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000' })]);
      return { cid, c1, c2, m1, manifest: mf.manifest, snapshot: s2, owner };
    }

    /**
     * Run (creado por el camino QA: video + proveedores mock) con TODOS los items terminados y el run
     * todavía activo, para que recomputeRunStatus decida. `videoMode`/`providerModes` reescriben lo
     * congelado (simula un run comercial real sin gastar); `videoItemMode` es el `mode` de cada video.
     */
    async function finishedRun(title, { videoMode = 'mock', providerModes = { presentation: 'mock', audio: 'mock' }, videoItemMode = 'mock' } = {}) {
      const C = await confirmedCourse(title);
      const res = await runs.startRun(C.cid, OWNER, 1, QA_MOCK_CTX);
      const runId = res.run.id;
      await ds.query(`update public.production_jobs set input_payload = input_payload || $2::jsonb, status = 'running', worker_status = 'running' where id = $1`,
        [runId, JSON.stringify({ videoMode, providerModes })]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1`, [runId]);
      // «Validado»: los tipos v3 que el servidor valida al completar llevan su v3Validation (como el scheduler real).
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || $2::jsonb
                       where job_id = $1 and type in ('course_intro', 'module_intro', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam')`,
        [runId, JSON.stringify({ v3Validation: { artifactType: 'fixture', artifactId: crypto.randomUUID(), contentSha256: 'x'.repeat(64) } })]);
      for (const c of [C.c1, C.c2]) {
        await ds.query(`update public.generation_item_runs set output_summary = output_summary || $2::jsonb where job_id = $1 and item_key = $3`,
          [runId, JSON.stringify({ mode: typeof videoItemMode === 'function' ? videoItemMode(c) : videoItemMode, delivery: 'completed',
            youtubeVideoId: 'Yt' + c.replace(/-/g, '').slice(0, 9), youtubeUrl: 'https://youtu.be/Yt' + c.replace(/-/g, '').slice(0, 9), external: { durationSec: 468 } }), `video:${c}`]);
      }
      return { ...C, runId };
    }

    // ════ 1. ¿Cuándo un run llega a `completed`? ═════════════════════════════
    await check('base', 'un item requerido sin completar (video real `failed` + sus preguntas `blocked`) → el run NUNCA queda completed (queda failed)', async () => {
      const R = await finishedRun('DoD base fallo', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const v2 = await latest(R.runId, `video:${R.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado' where id = $1`, [v2.id]);
      const i2 = await latest(R.runId, `video_interactions:${R.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      eq(await recompute(R.runId), 'failed', 'estado del run');
    });

    await check('base', 'run comercial (video real, Gamma/TTS reales) con todo completado y validado → completed', async () => {
      const R = await finishedRun('DoD base real', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      eq(await recompute(R.runId), 'completed', 'estado del run');
    });

    await check('dod', 'run v3 con TODOS los items terminados pero videos de VISTA PREVIA (mode mock) → NO completed (estado distinto, p.ej. `preview`). HOY: recomputeRunStatus solo cuenta status de items (item-transitions.ts:227) → completed', async () => {
      const R = await finishedRun('DoD preview video', { videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'mock' });
      const st = await recompute(R.runId);
      assert(st !== 'completed', `el run quedó «${st}» con videos de vista previa`);
      eq(st, 'preview', 'estado del run');
    });

    await check('dod', 'run v3 con videos reales pero Gamma/TTS congelados en mock (escape QA) → NO completed. HOY: completed', async () => {
      const R = await finishedRun('DoD preview proveedores', { videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' }, videoItemMode: 'real' });
      const st = await recompute(R.runId);
      assert(st !== 'completed', `el run quedó «${st}» con proveedores simulados`);
    });

    await check('dod', 'run con un video de vista previa dentro de un run REAL (sin upgrade: ruling 6) → NO completed. HOY: completed (solo el empaquetado lo detecta, video-upgrade.ts / packaging-v3.ts:850)', async () => {
      const R = await finishedRun('DoD ruling6', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: (c) => 'mock' });
      const st = await recompute(R.runId);
      assert(st !== 'completed', `el run quedó «${st}» con un video mock en un run real`);
    });

    // ════ 2. Lo que el run le dice a la UI (contrato RunDto.completion) ══════
    await check('dod', 'RunDto de un run de vista previa: completion = {state:"preview", complete:false, missingComponents ⊇ videos}. HOY: no existe completion; status "completed"', async () => {
      const R = await finishedRun('DoD dto preview');
      await recompute(R.runId);
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      assert(dto.status !== 'completed', `RunDto.status = ${dto.status}`);
      assert(dto.completion && dto.completion.complete === false && dto.completion.state === 'preview', `completion = ${JSON.stringify(dto.completion)}`);
      assert((dto.completion.missingComponents || []).includes(`video:${R.c1}`), 'falta el video en missingComponents');
    });

    await check('dod', 'RunDto de un run comercial con TODO generado y validado pero SIN paquete todavía: completion = {state:"packaging", generationComplete:true, packageReady:false, complete:false, missingComponents:[]} (el curso es completo solo con el .mbz disponible). HOY: no existe completion', async () => {
      const R = await finishedRun('DoD dto completo', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await recompute(R.runId);
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      const c = dto.completion;
      eq(c && [c.state, c.generationComplete, c.packageReady, c.complete, c.missingComponents], ['packaging', true, false, false, []], 'completion');
    });

    await check('dod', 'video real FALLIDO para siempre (videogen_failed, fuera de la allow-list del auto-healer) → run recuperable NO completo, con ACCIÓN DE ADMIN explícita (completion.state "needs_attention", adminActions con el video). HOY: run failed sin acción de admin en el contrato', async () => {
      const R = await finishedRun('DoD video fallido', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const v2 = await latest(R.runId, `video:${R.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado', finished_at = now() where id = $1`, [v2.id]);
      const i2 = await latest(R.runId, `video_interactions:${R.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      await recompute(R.runId);
      // El auto-healer NO lo reabre (requiere intervención): confirmado por la política pura.
      const ah = L('modules/dynamic-generation/auto-heal.js');
      const d = ah.autoHealDecision({ status: 'failed', type: 'video', error: 'videogen_failed: render rechazado', output_summary: {}, finished_at: new Date() }, new Date());
      eq(d.heal, false, 'el auto-healer no lo toma');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      assert(dto.completion && dto.completion.complete === false && dto.completion.state === 'needs_attention', `completion = ${JSON.stringify(dto.completion)}`);
      assert((dto.completion.adminActions || []).some((a) => a.itemKey === `video:${R.c2}`), `adminActions = ${JSON.stringify(dto.completion && dto.completion.adminActions)}`);
    });

    await check('dod', '§2.6 (B2): run cuyo upgrade de videos falló → hoy empaquetable «con videos pendientes»; DoD: completion.complete=false y state "needs_attention" (nunca entregado como completo)', async () => {
      // Run de vista previa terminado → upgrade confirmado → ambos videos del upgrade fallan para siempre.
      const R = await finishedRun('DoD 2.6');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [R.runId]);
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN, 1, R.runId);
      await runs.confirmVideoUpgrade(R.cid, ADMIN, 1, R.runId, pv.estimateHash);
      for (const c of [R.c1, R.c2]) {
        const v = await latest(R.runId, `video:${c}`);
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: definitivo', finished_at = now() where id = $1`, [v.id]);
        const i = await latest(R.runId, `video_interactions:${c}`);
        await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i.id]);
      }
      await recompute(R.runId);
      const job = await jobOf(R.runId);
      eq(await VU.runIsUpgradeOnlyFailure(ds, job), true, 'fallo solo del upgrade (precondición)');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      assert(dto.completion && dto.completion.complete === false && dto.completion.state === 'needs_attention', `completion = ${JSON.stringify(dto.completion)}`);
    });

    // ════ 3. Modo de video del camino comercial ══════════════════════════════
    await check('dod', 'camino comercial: un inicio SIN videoMode explícito se estima/crea con video REAL (paidRealProviders incluye videogen). HOY: DEFAULT_VIDEO_MODE = mock (runs.service.ts:147) → sin videogen', async () => {
      const C = await confirmedCourse('DoD default real');
      const pv = await runs.previewStart(C.cid, ADMIN, 1, { ...CONTEXT, providerModes: { presentation: 'mock', audio: 'mock' } });
      assert((pv.paidRealProviders || []).includes('videogen'), `paidRealProviders = ${JSON.stringify(pv.paidRealProviders)}`);
    });

    await check('dod', 'videoMode "mock" pedido SIN el escape QA (producción) → 403 video_preview_not_allowed, nada creado. HOY: aceptado (normalizeVideoMode, runs.service.ts:3692)', async () => {
      const C = await confirmedCourse('DoD mock prohibido');
      const prev = process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
      const prevV = process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK; // entorno tipo producción: ningún escape QA
      delete process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      try {
        const err = await rejectsRe(runs.previewStart(C.cid, ADMIN, 1, { ...CONTEXT, videoMode: 'mock' }), /video_preview_not_allowed/, 'preview con mock', 403);
        eq(err.getResponse().code, 'video_preview_not_allowed', 'código estable');
        await rejectsRe(runs.startRun(C.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /video_preview_not_allowed/, 'start con mock', 403);
        const [{ n }] = await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [C.cid]);
        eq(n, 0, 'nada creado');
        const [{ e }] = await ds.query(`select count(*)::int e from public.cost_estimates where course_id = $1`, [C.cid]);
        eq(e, 0, 'nada estimado');
      } finally {
        process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = prev;
        process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = prevV;
      }
    });

    // R3 (Fase B): la elegibilidad de video real sigue siendo la allow-list (quién paga = Q1 abierta), pero un
    // owner NO elegible recibe una negativa CLARA (403 real_video_not_enabled, en español) — nunca una bajada
    // silenciosa a vista previa; con DYNAMIC_REAL_VIDEO_ALL_OWNERS=true (rollout comercial) todo owner es elegible.
    await check('dod', 'cliente normal NO elegible (fuera de DYNAMIC_REAL_VIDEO_OWNERS): features.realVideo false y un inicio sin videoMode → 403 real_video_not_enabled con mensaje en español; nada creado ni bajado a vista previa', async () => {
      const f = features.resolveDynamicFeatures(CUSTOMER, process.env);
      eq([f.dynamicCourseStructure, f.realVideo], [true, false], 'features');
      const C = await confirmedCourse('DoD cliente no elegible', CUSTOMER);
      const err = await rejectsRe(runs.previewStart(C.cid, { id: CUSTOMER, email: 'cliente@cursia.test' }, 1, { ...CONTEXT, providerModes: { presentation: 'mock', audio: 'mock' } }),
        /real_video_not_enabled/, 'preview sin videoMode', 403);
      const body = err.getResponse();
      eq(body.code, 'real_video_not_enabled', 'código');
      assert(/video real/i.test(body.message) && /un curso completo incluye sus videos/i.test(body.message) && /no se cre[oó] ni se cobr[oó] nada/i.test(body.message), `mensaje: ${body.message}`);
      await rejectsRe(runs.startRun(C.cid, CUSTOMER, 1, { ...CONTEXT, providerModes: { presentation: 'mock', audio: 'mock' } }), /real_video_not_enabled/, 'start sin videoMode', 403);
      const [{ n }] = await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [C.cid]);
      eq(n, 0, 'nada creado (ni un run de vista previa)');
    });

    await check('dod', 'DYNAMIC_REAL_VIDEO_ALL_OWNERS=true (rollout comercial): el cliente normal es elegible (features.realVideo true) y su inicio sin videoMode se estima con video REAL (videogen); solo el string exacto "true"', async () => {
      process.env.DYNAMIC_REAL_VIDEO_ALL_OWNERS = 'True';
      try {
        eq(features.resolveDynamicFeatures(CUSTOMER, process.env).realVideo, false, '"True" no activa (fail closed)');
        process.env.DYNAMIC_REAL_VIDEO_ALL_OWNERS = 'true';
        eq(features.resolveDynamicFeatures(CUSTOMER, process.env).realVideo, true, 'elegible con ALL_OWNERS');
        const C = await confirmedCourse('DoD cliente ALL_OWNERS', CUSTOMER);
        const pv = await runs.previewStart(C.cid, { id: CUSTOMER, email: 'cliente@cursia.test' }, 1, { ...CONTEXT, providerModes: { presentation: 'mock', audio: 'mock' } });
        assert((pv.paidRealProviders || []).includes('videogen'), `paidRealProviders = ${JSON.stringify(pv.paidRealProviders)}`);
        eq(pv.approval && pv.approval.canApprove, false, 'el cliente no puede autoaprobar (aprobación sin cambios)');
      } finally {
        delete process.env.DYNAMIC_REAL_VIDEO_ALL_OWNERS;
      }
    });

    // ════ 4. Empaquetado ══════════════════════════════════════════════════════
    await check('base', 'v1/v2: un run con videos mock sigue sin empaquetarse (409 mock_video_not_packageable)', async () => {
      const R = await finishedRun('DoD v2 mock');
      await recompute(R.runId);
      const job = await jobOf(R.runId);
      await rejectsRe(packaging.assertRunReady(job, { rulesVersion: 2, manifest: R.manifest.manifest ?? R.manifest }), /mock_video_not_packageable/, 'v2 mock', 409);
    });

    await check('dod', 'v3: el empaquetado de un run de VISTA PREVIA es solo QA → sin el escape, 409 preview_not_deliverable. HOY: B1 lo empaqueta omitiendo los videos (packaging.service.ts:397-404)', async () => {
      const R = await finishedRun('DoD pkg preview');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [R.runId]);
      const job = await jobOf(R.runId);
      await rejectsRe(packaging.assertRunReady(job, { rulesVersion: 3, manifest: R.manifest.manifest ?? R.manifest }), /preview_not_deliverable/, 'preview v3', 409);
    });

    // ════ 5. «Generar videos reales» = herramienta de admin ════════════════
    await check('base', '«Generar videos reales»: la CONFIRMACIÓN ya exige SUPER_ADMIN (403 approval_forbidden a un dueño no admin)', async () => {
      const R = await finishedRun('DoD vup confirm');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [R.runId]);
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN, 1, R.runId);
      await rejectsRe(runs.confirmVideoUpgrade(R.cid, OWNER_NOT_ADMIN, 1, R.runId, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
    });

    await check('dod', '«Generar videos reales»: la VISTA PREVIA (estimado USD) también es solo admin → 403 a un dueño no admin. HOY: devuelve el estimado con canApprove:false (runs.service.ts previewVideoUpgrade)', async () => {
      const R = await finishedRun('DoD vup preview');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [R.runId]);
      await rejectsRe(runs.previewVideoUpgrade(R.cid, OWNER_NOT_ADMIN, 1, R.runId), /forbidden|admin/i, 'no admin', 403);
    });

    // ════ 6. Fase B (BE-A): casos agregados ═══════════════════════════════════
    await check('dod', 'run VIEJO `completed` con videos de vista previa (anterior a la DoD): RunDto.completion lo lee como "preview" SIN escribir nada (worker_status/updated_at intactos)', async () => {
      const R = await finishedRun('DoD viejo completed mock');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() - interval '3 days', updated_at = now() - interval '3 days' where id = $1`, [R.runId]);
      const before = await jobOf(R.runId);
      const itemsBefore = await ds.query(`select id, status, updated_at, output_summary from public.generation_item_runs where job_id = $1 order by id`, [R.runId]);
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      eq([dto.status, dto.completion.state, dto.completion.complete, dto.completion.generationComplete], ['completed', 'preview', false, false], 'lectura');
      assert(dto.completion.previewComponents.includes(`video:${R.c1}`) && dto.completion.previewComponents.includes(`presentation:${R.c1}`), `previewComponents = ${JSON.stringify(dto.completion.previewComponents)}`);
      const after = await jobOf(R.runId);
      eq([after.worker_status, after.status, String(after.updated_at)], [before.worker_status, before.status, String(before.updated_at)], 'fila del run intacta');
      const itemsAfter = await ds.query(`select id, status, updated_at, output_summary from public.generation_item_runs where job_id = $1 order by id`, [R.runId]);
      eq(JSON.stringify(itemsAfter), JSON.stringify(itemsBefore), 'items intactos');
    });

    await check('dod', 'run nuevo de vista previa termina `preview` (constraint lo acepta) y un ADMIN lo puede mejorar con «Generar videos reales» igual que un completed con mocks (preview → confirm → run reabierto con videos reales)', async () => {
      const R = await finishedRun('DoD preview upgradeable', { videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'mock' });
      eq(await recompute(R.runId), 'preview', 'estado del run');
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN, 1, R.runId);
      assert(pv.eligible === true && pv.pendingVideos.length === 2, `vista previa: ${JSON.stringify({ e: pv.eligible, b: pv.blockers, n: pv.pendingVideos.length })}`);
      const up = await runs.confirmVideoUpgrade(R.cid, ADMIN, 1, R.runId, pv.estimateHash);
      eq([up.created, up.run.videoMode, up.run.status], [true, 'real', 'queued'], 'upgrade confirmado');
      eq(up.run.completion.state, 'in_progress', 'completion durante el upgrade');
    });

    await check('dod', 'cancelar un upgrade de videos EN VUELO es solo de admin (403 admin_recovery_only al dueño); un ADMIN sí puede', async () => {
      const R = await finishedRun('DoD cancel upgrade');
      await recompute(R.runId);
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN, 1, R.runId);
      await runs.confirmVideoUpgrade(R.cid, ADMIN, 1, R.runId, pv.estimateHash);
      await rejectsRe(runs.cancelRun(R.cid, OWNER, 1, R.runId, { email: 'owner@cursia.test' }), /admin_recovery_only/, 'dueño', 403);
      eq((await jobOf(R.runId)).worker_status, 'queued', 'el run sigue en vuelo');
      const dto = await runs.cancelRun(R.cid, OWNER, 1, R.runId, { email: ADMIN.email });
      eq(dto.status, 'cancelled', 'admin cancela');
    });

    await check('dod', 'recuperación PAGA de un video fallido (render nuevo en Videogen) = solo admin: 403 admin_recovery_only al dueño; un reintento SIN gasto (item no pago) sigue siendo del dueño', async () => {
      const R = await finishedRun('DoD retry pago', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const v2 = await latest(R.runId, `video:${R.c2}`);
      // Render rechazado por Videogen: sin job reutilizable ni entrega (como lo deja el worker).
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado',
                        output_summary = output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl' where id = $1`, [v2.id]);
      const c1 = await latest(R.runId, `content:${R.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos' where id = $1`, [c1.id]);
      await recompute(R.runId);
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.runId, `video:${R.c2}`, true, false, undefined, { email: 'owner@cursia.test' }), /admin_recovery_only/, 'resubmit del dueño', 403);
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.runId, `video:${R.c2}`, false, false, undefined, { email: 'owner@cursia.test' }), /admin_recovery_only/, 'retry de video sin job del dueño', 403);
      eq((await latest(R.runId, `video:${R.c2}`)).status, 'failed', 'el video sigue failed (nada escrito)');
      const it = await runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, { email: 'owner@cursia.test' });
      eq(it.status, 'pending', 'reintento sin gasto del dueño');
    });

    await check('dod', 'paquete QA: run de vista previa → 409 preview_not_deliverable al dueño (aun con el escape) y a un admin SIN el escape; con SUPER_ADMIN + DYNAMIC_ALLOW_VIDEO_PREVIEW=true → packageKind qa_preview (deliverable:false), job declarado', async () => {
      const R = await finishedRun('DoD pkg qa');
      eq(await recompute(R.runId), 'preview', 'run preview');
      const job = await jobOf(R.runId);
      const mf = { rulesVersion: 3, manifest: R.manifest.manifest ?? R.manifest };
      await rejectsRe(packaging.assertRunReady(job, mf, { email: 'owner@cursia.test' }), /preview_not_deliverable/, 'dueño con escape', 409);
      const prevV = process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      delete process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      try {
        await rejectsRe(packaging.assertRunReady(job, mf, { email: ADMIN.email }), /preview_not_deliverable/, 'admin sin escape', 409);
      } finally {
        process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = prevV;
      }
      eq(await packaging.assertRunReady(job, mf, { email: ADMIN.email }), 'qa_preview', 'admin + escape');
    });

    await check('dod', 'paquete de vista previa ANTERIOR a la DoD (B1, sin packageKind, con videos omitidos): GET …/package lo identifica qa_preview, deliverable:false, complete:false y nombre QA-VISTA-PREVIA-… (sin tocar el job)', async () => {
      const R = await finishedRun('DoD pkg viejo');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [R.runId]);
      const run = await jobOf(R.runId);
      const os = { artifactId: null, sourceIdsHash: 'b1'.repeat(32), builderVersion: '3.6.0', pendingVideos: [{ itemKey: `video:${R.c1}`, chapterId: R.c1, chapterNumber: 1 }] };
      const [pj] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
        values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb) returning id, updated_at, output_summary`,
        [OWNER, R.cid, JSON.stringify({ runId: R.runId, manifestId: Number(run.input_payload.manifestId), blueprintNumber: 1 }), JSON.stringify(os)]);
      const st = await packaging.getPackageStatus(R.cid, OWNER, 1, R.runId);
      eq([st.packageKind, st.deliverable, st.complete, st.downloadFilename], ['qa_preview', false, false, `QA-VISTA-PREVIA-${'b1'.repeat(32)}.mbz`], 'estado del paquete viejo');
      const [again] = await ds.query(`select output_summary, updated_at from public.production_jobs where id = $1`, [pj.id]);
      eq([JSON.stringify(again.output_summary), String(again.updated_at)], [JSON.stringify(pj.output_summary), String(pj.updated_at)], 'job intacto');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      eq([dto.completion.state, dto.completion.packageReady], ['preview', false], 'el run sigue de vista previa');
    });

    await check('dod', 'builder: run 100 % real → .mbz BYTE-IDÉNTICO al dorado (builder 3.6.0, mismo fixture que check-ev6-pending-videos) con qaPreviewNotice ausente o false; con true → nombre «[QA — vista previa, no entregable]» + aviso visible en la bienvenida, validador OK', async () => {
      const PF = require('./lib/v21-packaging-fixtures');
      const B = L('package/dynamic-mbz-builder-v3.js');
      const V = L('package/v3/mbz-validator-v3.js');
      const JSZip = require('jszip');
      const o = { engine: 'h5p', finalExam: true, courseId: 644 };
      const GOLDEN_644 = '5de36d0645bcc04a2189f33849a53e1a2250991b4b3cd10ed0aaa3a11c3b0c1f';
      const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
      const r0 = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, o));
      const r1 = await B.buildDynamicMbzV3({ ...PF.packagingInput(distRoot, o), qaPreviewNotice: false });
      eq([sha(r0.mbz), sha(r1.mbz)], [GOLDEN_644, GOLDEN_644], 'sin rótulo: dorado');
      const rq = await B.buildDynamicMbzV3({ ...PF.packagingInput(distRoot, o), qaPreviewNotice: true });
      assert(sha(rq.mbz) !== GOLDEN_644, 'el paquete QA difiere');
      const v = await V.validateMbzV3(rq.mbz, rq.expectations);
      assert(v.ok, `validador QA: ${JSON.stringify(v.issues.slice(0, 5))}`);
      const z = await JSZip.loadAsync(rq.mbz);
      const course = await z.file('course/course.xml').async('string');
      assert(/<fullname>[^<]*\[QA — vista previa, no entregable\]<\/fullname>/.test(course), 'fullname con sufijo QA');
      const labels = await Promise.all(Object.keys(z.files).filter((f) => /activities\/label_\d+\/label\.xml$/.test(f)).map((f) => z.file(f).async('string')));
      const welcome = labels.find((x) => /QA — vista previa, no entregable/.test(x));
      assert(welcome && /no es el curso final/.test(welcome), 'aviso visible en un label');
      eq(rq.summary.counts, r0.summary.counts, 'mismas actividades (el aviso va dentro de la bienvenida)');
    });

    // ════ 7. Fix round 1 (review BE-A) ════════════════════════════════════════
    const RC = L('modules/dynamic-generation/run-completion.js');
    const IA = L('modules/invalidation/invalidation-apply.js');
    const AR = L('modules/dynamic-packaging/artifact-resolver.js');
    const RH = L('modules/dynamic-generation/run-hash.js');
    const ADMIN_X = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'admin@cursia.test' }; // SUPER_ADMIN que NO es el dueño
    const V3VAL = { v3Validation: { artifactType: 'fixture', artifactId: crypto.randomUUID(), contentSha256: 'x'.repeat(64) } };

    /** Run v3 100 % REAL sembrado como lo deja un run real (items + un artifact por rol), todavía activo. */
    async function seededRealRun(C) {
      const ctx = { ...CONTEXT };
      const contextHash = RH.canonicalContextHash(RH.normalizeCourseContext(ctx));
      const m = C.manifest;
      const [job] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
         values ($1, $2, 'dynamic_generation', 'running', 'running', 'dynamic_generation', 0, $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [C.owner, C.cid, JSON.stringify({ manifestId: m.id, blueprintNumber: 1, contextHash, videoMode: 'real', videoDelivery: 'youtube', providerModes: { presentation: 'real', audio: 'real' } })]);
      await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) values ($1, $2, $3::jsonb, $4)`,
        [job.id, m.id, JSON.stringify(RH.normalizeCourseContext(ctx)), contextHash]);
      const items = [...m.manifest.items].sort((a, b) => (a.type === 'video' ? -1 : 0) - (b.type === 'video' ? -1 : 0));
      const videoOf = new Map();
      for (const it of items) {
        let summary = {};
        if (it.type === 'video') summary = { mode: 'real', delivery: 'completed', youtubeVideoId: 'AbCdEfGhIjK', youtubeUrl: 'https://youtu.be/AbCdEfGhIjK', external: { durationSec: 468, videogenJobId: 'vg-' + it.chapterId } };
        if (['presentation', 'audio_welcome', 'audiobook_chapter'].includes(it.type)) summary = { mode: 'real' };
        if (RC.requiresV3Validation(it.type, it.variant)) summary = { ...summary, ...V3VAL };
        if (it.type === 'video_interactions') {
          const v = videoOf.get(it.chapterId);
          summary = { ...summary, sourceVideoItemRunId: v.itemRunId, videoIdentity: v };
        }
        const [ir] = await ds.query(
          `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status, finished_at, output_summary)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, 'completed', now(), $11::jsonb) returning id`,
          [job.id, C.cid, m.blueprintId, m.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, RH.itemIdempotencyKey(m.id, it.key, 1), JSON.stringify(summary)]);
        const arts = [];
        for (const role of AR.requiredArtifactTypesV3(it.type, it.variant)) {
          const p1 = `dod/${job.id}/${it.key}/${role}`;
          const [a] = await ds.query(
            `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
             values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', 'application/json', $6::jsonb, $7, $8, $9, $10, $11) returning id`,
            [C.owner, String(C.cid), job.id, role, p1, JSON.stringify(['dynamic_presentation', 'dynamic_audio_mp3'].includes(role) ? { mode: 'real' } : {}), it.moduleId, it.chapterId, m.id, it.key, ir.id]);
          arts.push({ id: a.id, type: role, bucket: 'cursia-artifacts', path: p1 });
        }
        if (it.type === 'video') videoOf.set(it.chapterId, { identity: IA.artifactOutputIdentity(arts), itemRunId: ir.id, generation: 1, artifactIds: arts.map((x) => x.id) });
      }
      return job.id;
    }

    await check('dod', 'fix C1: «Generar los cambios» (fromRun) de un curso 100 % REAL con videos → el run B (todo reutilizado, preguntas arrastradas con el sourceVideoItemRunId del run A) nace `completed` (completion packaging), nunca «sin validar»', async () => {
      const C = await confirmedCourse('DoD C1 fromRun real');
      const runA = await seededRealRun(C);
      eq(await recompute(runA), 'completed', 'run A real completed');
      // Blueprint 2 = misma estructura (p.ej. un reorden revertido): todo se REUTILIZA.
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 2, 2, $2::jsonb, $3, 0, 1, 2)`, [C.cid, snap.canonicalJsonV2(C.snapshot), snap.snapshotSha256V2(C.snapshot)]);
      await manifests.getOrCreate(C.cid, OWNER, 2);
      const res = await runs.startRun(C.cid, OWNER, 2, { fromRun: runA });
      eq(res.created, true, 'run B creado');
      const rowsB = await ds.query(`select item_key, status, carried_from_item_run_id, output_summary from public.generation_item_runs where job_id = $1`, [res.run.id]);
      assert(rowsB.every((r) => r.status === 'completed' && r.carried_from_item_run_id), 'todo reutilizado (arrastrado)');
      const vi = rowsB.find((r) => r.item_key === `video_interactions:${C.c1}`);
      const vB = rowsB.find((r) => r.item_key === `video:${C.c1}`);
      assert(vi.output_summary.sourceVideoItemRunId === vB.carried_from_item_run_id, 'las preguntas siguen apuntando al video del run A (precondición de C1)');
      const job = await jobOf(res.run.id);
      eq(job.worker_status, 'completed', 'run B completed');
      const dto = await runs.getRun(C.cid, OWNER, 2, res.run.id);
      eq([dto.completion.state, dto.completion.generationComplete, dto.completion.missingComponents], ['packaging', true, []], 'completion de B');
      // Un C desde B (arrastre de 2 saltos) sigue siendo válido: cadena completa de procedencia.
      const chainRows = await RC.attachCarryChains(ds, (await ds.query(`select * from public.generation_item_runs where job_id = $1`, [res.run.id])));
      const vChain = chainRows.find((r) => r.item_key === `video:${C.c1}`).carry_chain;
      eq(vChain.length, 1, 'cadena de B = [video de A]');
      // Pura: arrastre multi-salto (preguntas de A, video de C ← B ← A).
      const pure = RC.questionsOfVideo({ id: 'C-v', carried_from_item_run_id: 'B-v', carry_chain: ['B-v', 'A-v'] },
        { id: 'C-q', status: 'completed', carried_from_item_run_id: 'B-q', output_summary: { sourceVideoItemRunId: 'A-v' } });
      eq(pure, true, 'multi-salto');
      eq(RC.questionsOfVideo({ id: 'C-v', carry_chain: ['B-v'] }, { id: 'q', status: 'completed', output_summary: { sourceVideoItemRunId: 'otro' }, carried_from_item_run_id: 'x' }), false, 'otro video → no');
      eq(RC.questionsOfVideo({ id: 'C-v', carry_chain: ['A-v'] }, { id: 'q', status: 'completed', output_summary: { sourceVideoItemRunId: 'A-v' } }), false, 'preguntas NO arrastradas apuntando a un ancestro → no');
    });

    await check('dod', 'fix C2: el dueño reintenta un item NO pago (content fallido) cuyo video dependiente quedó blocked sin haber renderizado nunca → permitido (pending); un video con render fallido sigue siendo de admin', async () => {
      const R = await finishedRun('DoD C2', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const c1 = await latest(R.runId, `content:${R.c1}`);
      const v1 = await latest(R.runId, `video:${R.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos' where id = $1`, [c1.id]);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = null, output_summary = output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl' - 'mode' where id = $1`, [v1.id]);
      await recompute(R.runId);
      const owner = { id: OWNER, email: 'owner@cursia.test' };
      // Sin presupuesto del run para el primer render: el gate de FinOps de siempre (no el de recuperación de admin).
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner), /budget_approval_required/, 'FinOps, no admin_recovery_only', 409);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason)
                      values ($1, $2, 1000, 'ADMIN_APPROVED', 'admin@cursia.test', 'DoD C2: presupuesto del run')`, [R.runId, R.cid]);
      const it = await runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner);
      eq(it.status, 'pending', 'reintento del dueño');
      eq((await latest(R.runId, `video:${R.c1}`)).status, 'pending', 'el video dependiente se desbloquea (primer render, gate de FinOps de siempre)');
    });

    await check('dod', 'fix I1: un curso SIN videos arranca (default real) para un owner NO elegible para video real; con videos sigue el 403 real_video_not_enabled', async () => {
      const C = await confirmedCourse('DoD I1 sin videos', CUSTOMER, { videos: false });
      eq(C.manifest.manifest.items.filter((i) => i.type === 'video').length, 0, 'Manifest sin videos');
      const body = { ...CONTEXT, providerModes: { presentation: 'mock', audio: 'mock' } };
      const pv = await runs.previewStart(C.cid, { id: CUSTOMER, email: 'cliente@cursia.test' }, 1, body);
      assert(!(pv.paidRealProviders || []).includes('videogen'), `sin videogen: ${JSON.stringify(pv.paidRealProviders)}`);
      const res = await runs.startRun(C.cid, CUSTOMER, 1, body);
      eq([res.created, res.run.videoMode], [true, 'real'], 'creado');
    });

    await check('dod', 'fix I2: un SUPER_ADMIN que NO es el dueño opera las herramientas de recuperación sobre el curso del cliente (vista previa + confirmación del upgrade con actedBy, reintento pago, cancelación); un no admin ajeno sigue con 404', async () => {
      const R = await finishedRun('DoD I2');
      await recompute(R.runId);
      await rejectsRe(runs.previewVideoUpgrade(R.cid, { id: ADMIN_X.id, email: 'otro@cursia.test' }, 1, R.runId), /admin_recovery_only/, 'no admin', 403);
      await rejectsRe(runs.getRun(R.cid, ADMIN_X.id, 1, R.runId), /not found|no existe/i, 'ajeno sin rol: ownership intacto', 404);
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN_X, 1, R.runId);
      eq([pv.eligible, pv.pendingVideos.length], [true, 2], 'vista previa del admin');
      const up = await runs.confirmVideoUpgrade(R.cid, ADMIN_X, 1, R.runId, pv.estimateHash);
      eq([up.created, up.upgrade.by, up.upgrade.actedBy, up.upgrade.confirmedBy], [true, OWNER, ADMIN_X.id, ADMIN_X.email], 'upgrade a nombre del dueño, actuado por el admin');
      const gen = await latest(R.runId, `video:${R.c1}`);
      eq(gen.output_summary.regeneration.requestedBy, ADMIN_X.id, 'regeneración registra al admin que actuó');
      const dto = await runs.cancelRun(R.cid, ADMIN_X.id, 1, R.runId, ADMIN_X);
      eq(dto.status, 'cancelled', 'el admin cancela el upgrade en vuelo');
      const [cj] = await ds.query(`select output_summary from public.production_jobs where id = $1`, [R.runId]);
      eq(cj.output_summary.cancellation.requestedBy, ADMIN_X.id, 'la cancelación registra al admin que actuó');
      // Reintento pago (render fallido) por el admin sobre el curso del cliente.
      const R2 = await finishedRun('DoD I2 retry', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const v2 = await latest(R2.runId, `video:${R2.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado', output_summary = output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl' where id = $1`, [v2.id]);
      await recompute(R2.runId);
      // El dueño (no admin) no puede reenviar el render; el admin ajeno pasa el gate de recuperación y, con el
      // presupuesto del run aprobado, el video vuelve a pending con el reenvío registrado a su nombre.
      await rejectsRe(runs.retryItem(R2.cid, OWNER, 1, R2.runId, `video:${R2.c2}`, true, false, undefined, { id: OWNER, email: 'owner@cursia.test' }), /admin_recovery_only/, 'dueño', 403);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason)
                      values ($1, $2, 1000, 'ADMIN_APPROVED', 'admin@cursia.test', 'DoD I2: presupuesto del run')`, [R2.runId, R2.cid]);
      const it = await runs.retryItem(R2.cid, ADMIN_X.id, 1, R2.runId, `video:${R2.c2}`, true, false, undefined, ADMIN_X);
      eq(it.status, 'pending', 'el admin reenvía el render del cliente');
      const prevErr = it.outputSummary.previousErrors.slice(-1)[0];
      eq(prevErr.retriedBy, ADMIN_X.id, 'el reintento registra al admin que actuó');
    });

    await check('dod', 'fix I3: un run `completed` con un componente SIN validar (fila anterior a la validación del servidor) nunca da un paquete FINAL: dueño → 409 preview_not_deliverable; SUPER_ADMIN → degraded (rotulado QA)', async () => {
      const R = await finishedRun('DoD I3', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      eq(await recompute(R.runId), 'completed', 'precondición');
      const ci = await latest(R.runId, `course_intro:${R.cid}`);
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'v3Validation' where id = $1`, [ci.id]);
      const job = await jobOf(R.runId);
      const mf = { rulesVersion: 3, manifest: R.manifest.manifest ?? R.manifest };
      const e = await rejectsRe(packaging.assertRunReady(job, mf, { email: 'owner@cursia.test' }), /preview_not_deliverable/, 'dueño', 409);
      assert(/sin validar/.test(e.message), e.message);
      eq(await packaging.assertRunReady(job, mf, { email: ADMIN.email }), 'degraded', 'admin');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      eq(dto.completion.state, 'needs_attention', 'completion');
    });

    await check('dod', 'fix M2/M5: recompute sin Manifest del run → failed (nunca completed); v3 con video real entregado por videogen_direct → sin validar (nunca empaquetable)', async () => {
      const R = await finishedRun('DoD M2', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await ds.query(`update public.production_jobs set input_payload = input_payload - 'manifestId' where id = $1`, [R.runId]);
      eq(await recompute(R.runId), 'failed', 'sin Manifest');
      const job = { worker_status: 'completed', input_payload: { videoMode: 'real', videoDelivery: 'videogen_direct', providerModes: { presentation: 'real', audio: 'real' } } };
      const c = RC.evaluateRunCompletion(job, [{ id: 'v', item_key: 'video:c', type: 'video', status: 'completed', output_summary: { mode: 'real' } }],
        { rulesVersion: 3, items: [{ key: 'video:c', type: 'video', chapterId: 'c' }] });
      eq([c.state, c.missingComponents], ['needs_attention', ['video:c']], 'v3 + videogen_direct');
      const c2 = RC.evaluateRunCompletion(job, [{ id: 'v', item_key: 'video:c', type: 'video', status: 'completed', output_summary: { mode: 'real' } }],
        { rulesVersion: 2, items: [{ key: 'video:c', type: 'video', chapterId: 'c' }] });
      eq(c2.generationComplete, true, 'v2 + videogen_direct sigue siendo válido');
    });

    await check('dod', 'migración: supabase-migration-ev6-dod-preview-status.sql lista EXACTAMENTE los worker_status del lib (fuente única) y es idempotente; el CHECK aplicado acepta preview y rechaza un valor desconocido', async () => {
      const lib = require('./lib/production-jobs-constraints');
      const sql = fs.readFileSync(path.join(REPO, 'supabase-migration-ev6-dod-preview-status.sql'), 'utf8');
      const m = /worker_status in \(([^)]*)\)/.exec(sql);
      const vals = m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
      eq(vals, [...lib.WORKER_STATUSES], 'misma lista');
      assert(lib.WORKER_STATUSES.includes('preview'), 'lib con preview');
      await ds.query(sql);
      await ds.query(sql);
      const [{ def }] = await ds.query(`select pg_get_constraintdef(oid) def from pg_constraint where conname = 'production_jobs_worker_status_check'`);
      assert(/'preview'/.test(def), def);
      let bad = null;
      try { await ds.query(`insert into public.production_jobs (owner_id, execution_mode, status, worker_status) values ($1, 'dynamic_package', 'x', 'previewx')`, [OWNER]); } catch (e) { bad = e; }
      assert(bad && bad.code === '23514', 'valor desconocido rechazado');
    });
  } catch (err) {
    setupFailed = true;
    console.error(`❌ setup falló: ${err && err.stack ? err.stack : err}`);
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
  const { base, dod } = results;
  console.log(`\n[BASE] ${base.pass} ✅ ${base.fail} ❌   ·   [DOD] ${dod.pass} ✅ ${dod.fail} ❌`);
  const bad = setupFailed || base.fail > 0 || (STRICT && dod.fail > 0);
  process.exit(bad ? 1 : 0);
})();
