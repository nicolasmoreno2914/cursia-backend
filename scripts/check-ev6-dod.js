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

    await check('dod', 'builder: run 100 % real → .mbz BYTE-IDÉNTICO al dorado (builder 3.13.0, mismo fixture que check-ev6-pending-videos) con qaPreviewNotice ausente o false; con true → nombre «[QA — vista previa, no entregable]» + aviso visible en la bienvenida, validador OK', async () => {
      const PF = require('./lib/v21-packaging-fixtures');
      const B = L('package/dynamic-mbz-builder-v3.js');
      const V = L('package/v3/mbz-validator-v3.js');
      const JSZip = require('jszip');
      const o = { engine: 'h5p', finalExam: true, courseId: 644 };
      // QUIZFB (builder 3.10.0): mismo dorado que check-ev6-pending-videos (antes 5de36d06…, builder 3.6.0).
      // #583 QUAL (builder 3.11.0): reviewmaxmarks 69904 → 272, frase del cierre, tarjeta del Libro Guía como <intro> del recurso (sin label libro_card; ids renumerados) y runtime VC 4 — diff semántico en scratchpad/r18/qual/golddiff/sem.js (antes 812c6022…, 3.10.0).
      // UX r18 (builder 3.12.0): mismo dorado que check-ev6-pending-videos (antes 63dac759…, 3.11.0).
      // r19 W (builder 3.12.0 → 3.13.0): SOLO cambia el label cv3:shell:welcome (hero con superficie según heroTreatment, «Curso · N módulos · M capítulos», entrada ≤ 40 palabras y cuerpo en párrafos ≤ 70) — diff por entrada del zip en scratchpad/r19/w-logs/golddiff (hook.js + diff.js) (antes 7cb2a7c7…, 3.12.0).
      const GOLDEN_644 = '4469ff50f32c0fc38cf2b68a2b99a2fa97893ef784d414582cb58c956a3204ce';
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

    await check('dod', 'follow-up n5: el gate de recuperación de admin del reintento es el MISMO antes y bajo lock (dependentsToUnblock): un video bloqueado con render intentado que ESTE reintento no desbloquea no le quita al dueño un reintento gratis; uno que sí desbloquea → 403 admin_recovery_only al dueño, el admin sí', async () => {
      const R = await finishedRun('DoD n5', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason)
                      values ($1, $2, 1000, 'ADMIN_APPROVED', 'admin@cursia.test', 'DoD n5: presupuesto del run')`, [R.runId, R.cid]);
      const c1 = await latest(R.runId, `content:${R.c1}`);
      const v1 = await latest(R.runId, `video:${R.c1}`);
      const v2 = await latest(R.runId, `video:${R.c2}`);
      assert((v1.depends_on || []).includes(`content:${R.c1}`) && !(v2.depends_on || []).includes(`content:${R.c1}`), `precondición de dependencias: ${JSON.stringify([v1.depends_on, v2.depends_on])}`);
      const attempted = (id) => ds.query(`update public.generation_item_runs set status = 'blocked', error = 'videogen_failed: render rechazado',
        output_summary = (output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl') || '{"externalSubmitStartedAt":"2026-10-01T00:00:00Z"}'::jsonb where id = $1`, [id]);
      const owner = { id: OWNER, email: 'owner@cursia.test' };
      // (a) video AJENO (de otro capítulo) bloqueado con render intentado: el dueño reintenta su content gratis.
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos' where id = $1`, [c1.id]);
      await attempted(v2.id);
      await recompute(R.runId);
      const it = await runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner);
      eq([it.status, (await latest(R.runId, `video:${R.c2}`)).status], ['pending', 'blocked'], 'reintento del dueño; el video ajeno no se toca');
      // (b) el video DEPENDIENTE intentó un render: desbloquearlo lo re-renderizaría → admin.
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos', finished_at = now() where id = $1`, [(await latest(R.runId, `content:${R.c1}`)).id]);
      await attempted(v1.id);
      await recompute(R.runId);
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner), /admin_recovery_only/, 'dependiente con render intentado: dueño', 403);
      eq((await latest(R.runId, `content:${R.c1}`)).status, 'failed', 'nada cambió');
      const ad = await runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, { id: OWNER, email: ADMIN.email });
      eq(ad.status, 'pending', 'el admin sí');
    });

    await check('dod', 'follow-up fix round 1 m1: el gate de FinOps del reintento del dueño cuenta SOLO los items pagos que ESTE reintento desbloquea: sin presupuesto del run para videos, un video ajeno bloqueado (render intentado) no le pide aprobación de admin al reintento gratis de un content; un video dependiente sin render sí pasa por el gate de siempre', async () => {
      const R = await finishedRun('DoD m1', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      const c1 = await latest(R.runId, `content:${R.c1}`);
      const v2 = await latest(R.runId, `video:${R.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos' where id = $1`, [c1.id]);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = 'videogen_failed: render rechazado',
        output_summary = (output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl') || '{"externalSubmitStartedAt":"2026-10-01T00:00:00Z"}'::jsonb where id = $1`, [v2.id]);
      await recompute(R.runId);
      // El presupuesto aprobado del run (el del arranque por el camino QA, sin videos pagos) no cubre un video:
      // si el gate contara el video ajeno, el reintento gratis pediría aprobación de admin (409).
      const owner = { id: OWNER, email: 'owner@cursia.test' };
      const it = await runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner);
      eq([it.status, (await latest(R.runId, `video:${R.c2}`)).status], ['pending', 'blocked'], 'reintento gratis sin aprobación; el video ajeno no se toca');
      // Un video DEPENDIENTE que nunca renderizó: su primer render sigue pasando por el gate de FinOps.
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Falló después de 3 intentos', finished_at = now() where id = $1`, [(await latest(R.runId, `content:${R.c1}`)).id]);
      const v1 = await latest(R.runId, `video:${R.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = null, output_summary = output_summary - 'external' - 'delivery' - 'youtubeVideoId' - 'youtubeUrl' - 'mode' where id = $1`, [v1.id]);
      await recompute(R.runId);
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.runId, `content:${R.c1}`, false, false, undefined, owner), /budget_approval_required/, 'dependiente sin render: FinOps', 409);
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

    // ════ 8. Fix round 2 ═══════════════════════════════════════════════════════
    await check('dod', 'fix round 2 (cursos viejos): un run REAL que completó ANTES de la validación de servidor (sin v3Validation) se lee completo-en-generación (packaging) y empaqueta FINAL; un run viejo MOCK se lee preview; uno nuevo sin v3Validation sigue «sin validar»', async () => {
      RC._resetValidationCutoffsForTests();
      const age = async (runId) => {
        await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'v3Validation', finished_at = '2026-09-20T12:00:00Z' where job_id = $1`, [runId]);
        await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = '2026-09-20T12:00:00Z' where id = $1`, [runId]);
      };
      const R = await finishedRun('DoD viejo real', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await age(R.runId);
      const cut = await RC.loadValidationCutoffs(ds, Date.now() + 120000);
      // Marcador = primera fila validada de esta base, con el techo fijo de fix round 3 (N6).
      assert(cut.course_intro && cut.course_intro.getTime() <= RC.VALIDATION_CUTOFF_CEILING.getTime() && cut.course_intro.getTime() > Date.parse('2026-09-20T12:00:00Z'),
        `marcador de inicio de la validación: ${JSON.stringify(cut)}`);
      const dto = await runs.getRun(R.cid, OWNER, 1, R.runId);
      eq([dto.status, dto.completion.state, dto.completion.generationComplete, dto.completion.missingComponents], ['completed', 'packaging', true, []], 'viejo real');
      eq(await packaging.assertRunReady(await jobOf(R.runId), { rulesVersion: 3, manifest: R.manifest.manifest ?? R.manifest }, { email: 'owner@cursia.test' }), 'final', 'paquete final del dueño');
      const M = await finishedRun('DoD viejo mock');
      await age(M.runId);
      const dm = await runs.getRun(M.cid, OWNER, 1, M.runId);
      eq([dm.completion.state, dm.completion.missingComponents.every((k) => dm.completion.previewComponents.includes(k))], ['preview', true], 'viejo mock = preview (solo componentes de vista previa)');
      // Un item NUEVO (posterior al inicio de la validación) sin v3Validation sigue «sin validar».
      const N = await finishedRun('DoD nuevo sin validar', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'v3Validation' where job_id = $1 and type = 'experience'`, [N.runId]);
      eq(await recompute(N.runId), 'failed', 'nuevo sin validar → failed');
    });

    await check('dod', 'fix round 2 (M4): un paquete QA / degradado NUEVO es solo de admin también para descargar (GET …/package sin artifactId ni URL al dueño, 403 en /artifacts/:id/download-url); un paquete ANTERIOR (B1, sin packageKind declarado) sigue descargable por su dueño', async () => {
      const R = await finishedRun('DoD M4');
      eq(await recompute(R.runId), 'preview', 'run preview');
      const run = await jobOf(R.runId);
      const mkJob = async (input, os) => (await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
         values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [OWNER, R.cid, JSON.stringify({ runId: R.runId, manifestId: Number(run.input_payload.manifestId), blueprintNumber: 1, ...input }), JSON.stringify(os)]))[0].id;
      const signer = { calls: [], async getDownloadUrl(id, owner) { this.calls.push([id, owner]); return { url: `https://signed.invalid/${id}` }; } };
      const pk = new PackagingService(ds, manifests, signer);
      // Paquete anterior (B1, sin packageKind declarado): el dueño lo sigue descargando.
      await mkJob({}, { artifactId: crypto.randomUUID(), sourceIdsHash: 'b1'.repeat(32), builderVersion: '3.6.0', pendingVideos: [{ itemKey: `video:${R.c1}` }] });
      const old = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: 'owner@cursia.test' });
      assert(old.downloadUrl && !old.downloadRestricted && old.deliverable === false && old.packageKind === 'qa_preview', `B1: ${JSON.stringify(old)}`);
      // Paquete QA nuevo: dueño sin URL; admin con URL.
      const qaArt = crypto.randomUUID();
      await mkJob({ packageKind: 'qa_preview' }, { artifactId: qaArt, sourceIdsHash: 'c2'.repeat(32), builderVersion: '3.6.0', packageKind: 'qa_preview', deliverable: false });
      const own = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: 'owner@cursia.test' });
      eq([own.downloadRestricted, own.artifactId, own.downloadUrl, own.packageKind, own.deliverable], [true, undefined, undefined, 'qa_preview', false], 'dueño');
      const adm = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: ADMIN.email });
      eq([!!adm.downloadUrl, adm.artifactId, adm.downloadRestricted], [true, qaArt, undefined], 'admin');
      // Ruta genérica de artifacts.
      const { ArtifactsController } = L('modules/artifacts/artifacts.controller.js');
      const svc = (meta) => ({ async findOne() { return { id: 'a', type: 'dynamic_mbz', metadata: meta }; }, async getDownloadUrl() { return { url: 'u' }; } });
      await rejectsRe(new ArtifactsController(svc({ packageKind: 'qa_preview' })).getDownloadUrl(qaArt, { id: OWNER, email: 'owner@cursia.test' }), /admin_recovery_only/, 'QA nuevo, dueño', 403);
      eq((await new ArtifactsController(svc({ packageKind: 'degraded' })).getDownloadUrl(qaArt, { id: OWNER, email: ADMIN.email })).data.url, 'u', 'admin');
      eq((await new ArtifactsController(svc({ pendingVideos: [{}] })).getDownloadUrl(qaArt, { id: OWNER, email: 'owner@cursia.test' })).data.url, 'u', 'B1 anterior, dueño');
    });

    // ════ 9. Fix round 3 ═══════════════════════════════════════════════════════
    const OLD_AT = '2026-09-20T12:00:00Z'; // antes de la validación de servidor (y del techo N6)
    await check('dod', 'fix round 3 N1: «Generar los cambios» (fromRun) de un curso VIEJO real (sin v3Validation, anterior a la validación) → el run B (filas arrastradas que nacen con finished_at = ahora) nace `completed`, no «sin validar»', async () => {
      const C = await confirmedCourse('DoD N1 viejo fromRun');
      const runA = await seededRealRun(C);
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'v3Validation', finished_at = $2 where job_id = $1`, [runA, OLD_AT]);
      eq(await recompute(runA), 'completed', 'run A viejo real completed (exento: anterior a la validación)');
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 2, 2, $2::jsonb, $3, 0, 1, 2)`, [C.cid, snap.canonicalJsonV2(C.snapshot), snap.snapshotSha256V2(C.snapshot)]);
      await manifests.getOrCreate(C.cid, OWNER, 2);
      const res = await runs.startRun(C.cid, OWNER, 2, { fromRun: runA });
      const rowsB = await ds.query(`select item_key, status, finished_at, output_summary from public.generation_item_runs where job_id = $1`, [res.run.id]);
      assert(rowsB.every((r) => r.status === 'completed' && !r.output_summary.v3Validation && new Date(r.finished_at).getTime() > Date.parse(OLD_AT) + 86400e3),
        'precondición: filas arrastradas nuevas, sin v3Validation');
      eq((await jobOf(res.run.id)).worker_status, 'completed', 'run B completed');
      const dto = await runs.getRun(C.cid, OWNER, 2, res.run.id);
      eq([dto.completion.state, dto.completion.missingComponents], ['packaging', []], 'completion de B');
      // Pura: una fila arrastrada sin origen viejo (o una NUEVA sin validar) no queda exenta.
      const cuts = { course_intro: new Date('2026-09-26T00:00:00Z') };
      eq(RC.predatesValidation({ finished_at: new Date(), carried_from_item_run_id: 'x', carry_origin_finished_at: OLD_AT }, 'course_intro', cuts), true, 'arrastrada de origen viejo');
      eq(RC.predatesValidation({ finished_at: new Date(), carried_from_item_run_id: 'x', carry_origin_finished_at: new Date() }, 'course_intro', cuts), false, 'arrastrada de origen nuevo');
      eq(RC.predatesValidation({ finished_at: new Date(), carry_origin_finished_at: OLD_AT }, 'course_intro', cuts), false, 'no arrastrada: su propio finished_at');
    });

    await check('dod', 'fix round 3 N6: el marcador de inicio de la validación nunca pasa del techo fijo (borrar las primeras filas validadas no lo corre después)', async () => {
      RC._resetValidationCutoffsForTests();
      const cut = await RC.loadValidationCutoffs(ds);
      assert(Object.values(cut).length > 0 && Object.values(cut).every((d) => d.getTime() <= RC.VALIDATION_CUTOFF_CEILING.getTime()), JSON.stringify(cut));
    });

    await check('dod', 'fix round 3 N2: un .mbz QA / degradado NUEVO no aparece en GET /artifacts ni en GET /artifacts/:id para un no admin (sin storagePath); un admin sí; los .mbz anteriores no cambian', async () => {
      const { ArtifactsController } = L('modules/artifacts/artifacts.controller.js');
      const qa = { id: 'qa', type: 'dynamic_mbz', storagePath: 'qa-internal/o/x.mbz', metadata: { packageKind: 'qa_preview' } };
      const dg = { id: 'dg', type: 'dynamic_mbz', storagePath: 'qa-internal/o/y.mbz', metadata: { packageKind: 'degraded' } };
      const old = { id: 'b1', type: 'dynamic_mbz', storagePath: 'o/z.mbz', metadata: { pendingVideos: [{}] } };
      const fin = { id: 'f', type: 'dynamic_mbz', storagePath: 'o/f.mbz', metadata: {} };
      const all = [qa, dg, old, fin];
      const svc = { async findAll() { return all; }, async findOne(id) { return all.find((a) => a.id === id); }, async getDownloadUrl() { return { url: 'u' }; } };
      const ctl = new ArtifactsController(svc);
      const owner = { id: OWNER, email: 'owner@cursia.test' };
      eq((await ctl.findAll(owner)).data.map((a) => a.id), ['b1', 'f'], 'listado del dueño');
      eq((await ctl.findAll({ id: OWNER, email: ADMIN.email })).data.map((a) => a.id), ['qa', 'dg', 'b1', 'f'], 'listado del admin');
      await rejectsRe(ctl.findOne('qa', owner), /not found/i, 'detalle QA al dueño', 404);
      eq((await ctl.findOne('b1', owner)).data.storagePath, 'o/z.mbz', 'paquete anterior: detalle intacto');
      eq((await ctl.findOne('qa', { id: OWNER, email: ADMIN.email })).data.id, 'qa', 'admin');
      const QP = L('modules/dynamic-packaging/qa-package.js');
      eq(QP.QA_INTERNAL_STORAGE_PREFIX, 'qa-internal', 'prefijo interno (≠ uid del dueño: ninguna política own-folder lo cubre)');
      assert(!/^[0-9a-f]{8}-/.test(QP.QA_INTERNAL_STORAGE_PREFIX), 'el prefijo nunca es un uid');
    });

    await check('dod', 'fix round 3 N3: con un paquete FINAL completado y un job QA más nuevo, el dueño ve (y descarga) el final; el admin ve el QA', async () => {
      const R = await finishedRun('DoD N3', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      eq(await recompute(R.runId), 'completed', 'run completed');
      const run = await jobOf(R.runId);
      const mk = async (input, os) => (await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
         values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [OWNER, R.cid, JSON.stringify({ runId: R.runId, manifestId: Number(run.input_payload.manifestId), blueprintNumber: 1, ...input }), JSON.stringify(os)]))[0].id;
      const finArt = crypto.randomUUID();
      await mk({}, { artifactId: finArt, sourceIdsHash: 'f0'.repeat(32), builderVersion: '3.6.0' });
      await new Promise((r) => setTimeout(r, 20));
      await mk({ packageKind: 'degraded' }, { artifactId: crypto.randomUUID(), sourceIdsHash: 'd0'.repeat(32), builderVersion: '3.6.0', packageKind: 'degraded', deliverable: false });
      const signer = { async getDownloadUrl(id) { return { url: `https://signed.invalid/${id}` }; } };
      const pk = new PackagingService(ds, manifests, signer);
      const own = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: 'owner@cursia.test' });
      eq([own.packageKind, own.deliverable, own.artifactId, !!own.downloadUrl, own.downloadRestricted], ['final', true, finArt, true, undefined], 'dueño ve el final');
      const adm = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: ADMIN.email });
      eq(adm.packageKind, 'degraded', 'admin ve el QA más nuevo');
    });

    await check('dod', 'fix round 3 N4 + follow-up R7: v1/v2 nunca dan un paquete FINAL sin la generación completa (409 preview_not_deliverable al dueño y a un admin SIN el escape); un SUPER_ADMIN CON el escape de QA arma un paquete QA (vista previa → qa_preview; sin validar → degraded), nunca final; el empaque automático tampoco', async () => {
      const R = await finishedRun('DoD N4', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      eq(await recompute(R.runId), 'completed', 'precondición');
      const pres = await latest(R.runId, `presentation:${R.c1}`);
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || '{"mock":true}'::jsonb where id = $1`, [pres.id]);
      const job = await jobOf(R.runId);
      // Mismo run, por la rama v1/v2 de assertRunReady (rulesVersion 2): la completitud igual se exige.
      const v2 = { rulesVersion: 2, manifest: R.manifest.manifest ?? R.manifest };
      await rejectsRe(packaging.assertRunReady(job, v2, OWNER_NOT_ADMIN), /preview_not_deliverable/, 'v2 incompleto, dueño', 409);
      const prevV = process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      delete process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
      try {
        await rejectsRe(packaging.assertRunReady(job, v2, { email: ADMIN.email }), /preview_not_deliverable/, 'v2 incompleto, admin sin escape', 409);
      } finally {
        process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = prevV;
      }
      eq(await packaging.assertRunReady(job, v2, { email: ADMIN.email }), 'qa_preview', 'R7: admin + escape → QA de vista previa');
      // Sin validar (no de vista previa): course_intro completado DESPUÉS de la validación sin v3Validation.
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'mock' where id = $1`, [pres.id]);
      const ci = (await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'course_intro'`, [R.runId]))[0];
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'v3Validation', finished_at = now() where id = $1`, [ci.id]);
      eq(await packaging.assertRunReady(job, v2, { email: ADMIN.email }), 'degraded', 'R7: admin + escape, sin validar → degradado (QA)');
      await rejectsRe(packaging.assertRunReady(job, v2, OWNER_NOT_ADMIN), /preview_not_deliverable/, 'sin validar, dueño', 409);
    });

    // ════ 10. DoD follow-up (R1, R3, R4, R7) ═══════════════════════════════════
    await check('dod', 'follow-up R7 (worker v1/v2): un job QA arma el .mbz con el aviso QA (qaPreviewNotice), nombre QA-VISTA-PREVIA-…, bajo qa-internal/ y declarado (packageKind, deliverable:false) en metadata y resumen; nunca reutiliza el .mbz final (ni el final al QA); un job final sale como siempre', async () => {
      const PW = L('workers/dynamic-package-worker.js');
      const reuseKey = L('modules/dynamic-packaging/packaging-reuse-key.js');
      const { DYNAMIC_MBZ_BUILDER_VERSION } = L('package/dynamic-mbz-builder.js');
      const RESOLVED = new Map([['content_cap1', [{ artifactId: 'bbbb', type: 'dynamic_content_md' }]], ['scorm_cap1', [{ artifactId: 'aaaa', type: 'dynamic_scorm_html' }]]]);
      const hash = reuseKey.packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb'], '4.1');
      const mkDs = () => {
        const st = { completed: [], failed: [] };
        return {
          st,
          async query(sql, params) {
            if (/set lease_until/.test(sql)) return [{ id: params[0] }];
            if (/select input_payload from public\.production_jobs/.test(sql)) return [{ input_payload: {} }];
            if (/set status = 'completed'/.test(sql)) { st.completed.push(JSON.parse(params[2])); return [{ id: params[0] }]; }
            if (/set status = 'failed'/.test(sql)) { st.failed.push(params[2]); return []; }
            return [];
          },
          createQueryRunner() { return { async connect() {}, async release() {}, async query() { return [{}]; } }; },
        };
      };
      const runJob = async (input, existing = []) => {
        const dsF = mkDs();
        const uploads = [];
        const built = [];
        const silent = { log() {}, warn() {}, error() {} };
        const deps = {
          dataSource: dsF,
          artifacts: { async findAll() { return existing; }, async uploadBufferArtifact(i) { uploads.push(i); return { id: `art-${uploads.length}` }; } },
          manifests: { async getById() { return { id: 1, blueprintNumber: 1, rulesVersion: 2, manifest: { items: [] } }; } },
          blueprints: { async getByNumber() { return { snapshot: {} }; } },
          buildPlan: () => ({ planVersion: 1, manifestId: 1, course: { id: 1, title: 'x', summary: null }, sections: [], modules: [], totals: {} }),
          resolveArtifacts: async () => RESOLVED,
          loadText: async () => '', parseVideo: () => ({ url: '', videogenJobId: '' }),
          buildMbz: async (i) => { built.push(i); return Buffer.from('mbz'); },
          logger: silent, workerId: 'w', leaseSeconds: 60, heartbeatMs: 999999,
        };
        await PW.processItem(deps, { id: 'job-1', owner_id: 'owner-1', course_id: 1, frontend_course_id: 'fc', worker_status: 'running', status: 'running',
          input_payload: { runId: 'run-1', manifestId: 1, blueprintNumber: 1, ...input }, output_summary: {}, attempt_count: 1, max_attempts: 3 });
        return { dsF, uploads, built };
      };
      const qa = await runJob({ packageKind: 'qa_preview' });
      eq([qa.built.length, qa.built[0].qaPreviewNotice, qa.uploads.length], [1, true, 1], 'QA: build con aviso');
      const u = qa.uploads[0];
      assert(u.storagePath.startsWith('qa-internal/owner-1/') && u.filename === `QA-VISTA-PREVIA-${hash}.mbz` && u.storagePath.endsWith(`/QA-VISTA-PREVIA-${hash}.mbz`), `QA: ruta ${u.storagePath} ${u.filename}`);
      eq([u.metadata.packageKind, u.metadata.deliverable, qa.dsF.st.completed[0].packageKind, qa.dsF.st.completed[0].deliverable], ['qa_preview', false, 'qa_preview', false], 'QA declarado');
      const fin = await runJob({});
      eq(['qaPreviewNotice' in fin.built[0], fin.uploads[0].storagePath, fin.uploads[0].filename, 'packageKind' in fin.uploads[0].metadata, 'packageKind' in fin.dsF.st.completed[0]],
        [false, `owner-1/dynamic/fc/1/dynamic_mbz/run-1/${hash}.mbz`, `${hash}.mbz`, false, false], 'final: como siempre');
      const finalArt = { id: 'final-old', metadata: { runId: 'run-1', sourceIdsHash: hash, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION, moodleVersion: '4.1' } };
      const qaArt = { id: 'qa-old', metadata: { ...finalArt.metadata, packageKind: 'degraded', deliverable: false } };
      const qa2 = await runJob({ packageKind: 'degraded' }, [finalArt]);
      eq([qa2.built.length, qa2.uploads.length], [1, 1], 'un QA nunca reutiliza el .mbz final');
      const qa3 = await runJob({ packageKind: 'degraded' }, [finalArt, qaArt]);
      eq([qa3.built.length, qa3.dsF.st.completed[0].artifactId, qa3.dsF.st.completed[0].packageKind], [0, 'qa-old', 'degraded'], 'QA reutiliza su propio .mbz QA');
      const fin2 = await runJob({}, [qaArt]);
      eq(fin2.built.length, 1, 'el final nunca reutiliza un .mbz QA');
      const fin3 = await runJob({}, [qaArt, finalArt]);
      eq([fin3.built.length, fin3.dsF.st.completed[0].artifactId], [0, 'final-old'], 'el final reutiliza el final');
    });

    await check('dod', 'follow-up R7 (builder v1/v2): qaPreviewNotice → aviso «QA — vista previa, no entregable» al inicio de la bienvenida y sufijo en el nombre del curso; ausente/false → sin rastro de QA (mismo course.xml y misma bienvenida)', async () => {
      const JSZip = require('jszip');
      const { buildDynamicMbz } = L('package/dynamic-mbz-builder.js');
      const plan = { planVersion: 1, manifestId: 1, rulesVersion: 1, course: { id: 1, title: 'Curso R7', summary: null }, sections: [{ kind: 'welcome', sectionNum: 0, title: 'Bienvenida' }], modules: [], totals: { modules: 0, chapters: 0, scorms: 0, videos: 0, exams: 0 } };
      const contents = { contentMd: new Map(), scorm: new Map(), examGift: new Map(), videos: new Map() };
      const read = async (opts) => {
        const z = await JSZip.loadAsync(await buildDynamicMbz({ plan, contents, ...opts }));
        const course = await z.file('course/course.xml').async('string');
        let welcome = '';
        for (const f of Object.keys(z.files).filter((x) => /^activities\/label_\d+\/label\.xml$/.test(x))) {
          const t = await z.file(f).async('string');
          if (/Bienvenida al Curso/.test(t)) welcome = t;
        }
        const norm = (x) => x.replace(/<(timecreated|timemodified|startdate)>\d+</g, '<$1>T<');
        return { course: norm(course), welcome: norm(welcome) };
      };
      const def = await read({});
      const off = await read({ qaPreviewNotice: false });
      const on = await read({ qaPreviewNotice: true });
      eq([off.course === def.course, off.welcome === def.welcome, /QA — vista previa/.test(def.course + def.welcome)], [true, true, false], 'sin QA: igual que siempre');
      assert(/<fullname>Curso R7 \[QA — vista previa, no entregable\]<\/fullname>/.test(on.course), `fullname QA: ${on.course.match(/<fullname>[^<]*/)}`);
      assert(/QA — vista previa, no entregable/.test(on.welcome) && /copia interna de control de calidad/.test(on.welcome), 'aviso visible en la bienvenida');
      assert(on.welcome.indexOf('QA — vista previa') < on.welcome.indexOf('Curso R7'), 'el aviso va primero');
    });

    await check('dod', 'follow-up R1: un re-armado FINAL fallido (p.ej. builder nuevo) NO le oculta al dueño el paquete final anterior: GET …/package le sigue dando ese .mbz (URL), marcado no vigente (stale, newerAttemptFailed) y nunca «completo»; el admin ve el intento fallido', async () => {
      const R = await finishedRun('DoD R1', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      eq(await recompute(R.runId), 'completed', 'run completed');
      const run = await jobOf(R.runId);
      const mk = async (status, os, err = null) => (await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result, error_message)
         values ($1, $2, 'dynamic_package', $3::text, $3::text, 'dynamic_package', $4::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, $6) returning id`,
        [OWNER, R.cid, status, JSON.stringify({ runId: R.runId, manifestId: Number(run.input_payload.manifestId), blueprintNumber: 1, auto: true }), JSON.stringify(os), err]))[0].id;
      const prevArt = crypto.randomUUID();
      await mk('completed', { artifactId: prevArt, sourceIdsHash: 'p0'.repeat(32), builderVersion: '3.0.0' });
      await new Promise((r) => setTimeout(r, 20));
      await mk('failed', {}, 'MBZ_V3_VALIDATION_FAILED: simulado');
      const signer = { async getDownloadUrl(id) { return { url: `https://signed.invalid/${id}` }; } };
      const pk = new PackagingService(ds, manifests, signer);
      const own = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, OWNER_NOT_ADMIN);
      eq([own.status, own.artifactId, own.downloadUrl, own.stale, /^builder_changed/.test(own.staleReason), own.newerAttemptFailed, own.complete, own.deliverable, own.error],
        ['completed', prevArt, `https://signed.invalid/${prevArt}`, true, true, 'failed', false, true, undefined], 'dueño: paquete anterior, no vigente');
      const adm = await pk.getPackageStatus(R.cid, OWNER, 1, R.runId, { id: OWNER, email: ADMIN.email });
      eq([adm.status, adm.artifactId, adm.newerAttemptFailed, /simulado/.test(adm.error)], ['failed', undefined, undefined, true], 'admin: el intento fallido');
      // Sin paquete final anterior: el dueño ve el fallo como siempre.
      const R2 = await finishedRun('DoD R1 sin anterior', { videoMode: 'real', providerModes: { presentation: 'real', audio: 'real' }, videoItemMode: 'real' });
      await recompute(R2.runId);
      const run2 = await jobOf(R2.runId);
      await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
        values ($1, $2, 'dynamic_package', 'failed', 'failed', 'dynamic_package', $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [OWNER, R2.cid, JSON.stringify({ runId: R2.runId, manifestId: Number(run2.input_payload.manifestId), blueprintNumber: 1 })]);
      const own2 = await pk.getPackageStatus(R2.cid, OWNER, 1, R2.runId, OWNER_NOT_ADMIN);
      eq([own2.status, own2.newerAttemptFailed], ['failed', undefined], 'sin anterior: el fallo');
    });

    await check('dod', 'follow-up R3: el RunDto del DUEÑO (RunsController, cualquier respuesta con `completion`, también `{run}`) no lleva el mensaje de admin del bloqueo del paquete (solo el código); un SUPER_ADMIN recibe el detalle completo; la respuesta original no se muta', async () => {
      const { OwnerSafeRunInterceptor, redactRunPayloadForOwner } = L('modules/dynamic-generation/owner-safe-run.interceptor.js');
      const { of, lastValueFrom } = require('rxjs');
      const blocked = { code: 'youtube_delivery_incomplete', message: 'youtube_delivery_incomplete: … missingJson=["video:x:missing_youtube_url"]' };
      const completion = () => ({ state: 'needs_attention', adminActions: [{ code: 'resolve_youtube', itemKey: 'video:x', reason: 'youtube_delivery_incomplete' }],
        packageJob: { status: 'failed', autoRetryPending: false, auto: true, blocked: { ...blocked } } });
      const dto = { id: 'r', courseContext: { a: 1 }, items: [{ itemKey: 'video:x' }], completion: completion() };
      const wrapped = { created: false, reopened: false, run: { id: 'r', completion: completion() } };
      const ctx = (email) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { id: OWNER, email } }) }) });
      const icp = new OwnerSafeRunInterceptor();
      const viaOwner = await lastValueFrom(icp.intercept(ctx('owner@cursia.test'), { handle: () => of(dto) }));
      eq(viaOwner.completion.packageJob.blocked, { code: 'youtube_delivery_incomplete', message: null }, 'dueño: solo el código');
      eq([viaOwner.completion.state, viaOwner.completion.adminActions.length, viaOwner.completion.packageJob.status, viaOwner.courseContext, viaOwner.items], ['needs_attention', 1, 'failed', { a: 1 }, [{ itemKey: 'video:x' }]], 'resto intacto');
      eq(dto.completion.packageJob.blocked.message, blocked.message, 'original sin mutar');
      const wOwner = await lastValueFrom(icp.intercept(ctx('owner@cursia.test'), { handle: () => of(wrapped) }));
      eq(wOwner.run.completion.packageJob.blocked.message, null, '{run}: también');
      const viaAdmin = await lastValueFrom(icp.intercept(ctx('Admin@Cursia.test'), { handle: () => of(dto) }));
      eq(viaAdmin.completion.packageJob.blocked.message, blocked.message, 'admin: detalle completo');
      const noUser = await lastValueFrom(icp.intercept({ switchToHttp: () => ({ getRequest: () => ({}) }) }, { handle: () => of(dto) }));
      eq(noUser.completion.packageJob.blocked.message, null, 'sin usuario: redactado');
      eq(redactRunPayloadForOwner(null), null, 'null');
      eq(redactRunPayloadForOwner({ completion: { state: 'complete', packageJob: { status: 'completed' } } }), { completion: { state: 'complete', packageJob: { status: 'completed' } } }, 'sin bloqueo: igual');
      // El controller está decorado con el interceptor.
      const { RunsController } = L('modules/dynamic-generation/runs.controller.js');
      const meta = Reflect.getMetadata('__interceptors__', RunsController) || [];
      assert(meta.includes(OwnerSafeRunInterceptor), 'RunsController usa OwnerSafeRunInterceptor');
    });

    await check('dod', 'follow-up fix round 1 m2: GET /jobs y /jobs/:id no le muestran a un no admin el mensaje ni los faltantes del bloqueo del paquete (output_summary.autoPackage.blocked): solo el código; un SUPER_ADMIN ve todo; otras filas intactas y sin mutar', async () => {
      const { ProductionJobsController } = L('modules/production-jobs/production-jobs.controller.js');
      const blockedRun = () => ({ id: 'r', executionMode: 'dynamic_generation', steps: [{ id: 's' }],
        outputSummary: { x: 1, autoPackage: { eligibleAt: '2026-10-01T00:00:00Z', blocked: { code: 'youtube_delivery_incomplete', message: 'youtube_delivery_incomplete: … missingJson=["video:x:missing_youtube_url"]', missing: ['video:x:missing_youtube_url'], at: '2026-10-01T00:01:00Z' } } } });
      const legacy = { id: 'l', executionMode: 'legacy', outputSummary: { autoPackage: { blocked: { message: 'no es un run dinámico' } } } };
      const rows = [blockedRun(), legacy];
      const svc = { async findAll() { return rows; }, async findOne(id) { return rows.find((r) => r.id === id); } };
      const ctl = new ProductionJobsController(svc);
      const owner = { id: OWNER, email: 'owner@cursia.test' };
      const list = (await ctl.findAll(owner)).data.jobs;
      eq(list[0].outputSummary.autoPackage, { eligibleAt: '2026-10-01T00:00:00Z', blocked: { code: 'youtube_delivery_incomplete', at: '2026-10-01T00:01:00Z', message: null } }, 'listado: solo el código');
      eq([list[0].outputSummary.x, list[0].steps, list[1]], [1, [{ id: 's' }], legacy], 'resto intacto');
      eq((await ctl.findOne('r', owner)).data.outputSummary.autoPackage.blocked.message, null, 'detalle: sin el mensaje');
      assert(/missingJson/.test(rows[0].outputSummary.autoPackage.blocked.message), 'la fila original no se muta');
      const admin = { id: OWNER, email: ADMIN.email };
      eq((await ctl.findOne('r', admin)).data.outputSummary.autoPackage.blocked.missing, ['video:x:missing_youtube_url'], 'admin: detalle completo');
      eq((await ctl.findAll(admin)).data.jobs[0], rows[0], 'admin: fila cruda');
    });

    await check('dod', 'follow-up R4: DELETE /artifacts/:id de un .mbz QA / degradado NUEVO → 404 para un no admin (ni la fila ni el objeto qa-internal/ se borran); un SUPER_ADMIN sí lo borra; un .mbz anterior / final del dueño se borra como siempre', async () => {
      const { ArtifactsService } = L('modules/artifacts/artifacts.service.js');
      const { ArtifactsController } = L('modules/artifacts/artifacts.controller.js');
      const deleted = [];
      const realFetchLocal = global.fetch;
      global.fetch = async (u, o) => { if (o && o.method === 'DELETE') { deleted.push(String(u)); return { ok: true, status: 200 }; } return realFetchLocal(u, o); };
      try {
        const svc = new ArtifactsService({ manager: { connection: ds } }, { get: (k) => ({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-local' })[k] });
        const ins = async (pathS, meta) => (await ds.query(
          `insert into public.artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata)
           values ($1, '1', 'dynamic_mbz', 'supabase', 'cursia-artifacts', $2, 'f.mbz', 'application/vnd.moodle.backup', $3::jsonb) returning id`,
          [OWNER, pathS, JSON.stringify(meta)]))[0].id;
        const qaId = await ins(`qa-internal/${OWNER}/dynamic/1/1/dynamic_mbz/r/QA-VISTA-PREVIA-x.mbz`, { packageKind: 'qa_preview', deliverable: false });
        const ctl = new ArtifactsController(svc);
        await rejectsRe(ctl.remove(qaId, OWNER_NOT_ADMIN), /not found/i, 'dueño', 404);
        eq([(await ds.query(`select count(*)::int n from public.artifacts where id = $1`, [qaId]))[0].n, deleted.length], [1, 0], 'nada borrado');
        // Fix round 1 (m3): el SUPER_ADMIN NO es el dueño del curso (caso real: el QA es del curso del cliente).
        const ADMIN_OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: ADMIN.email };
        await ctl.remove(qaId, ADMIN_OTHER);
        eq([(await ds.query(`select count(*)::int n from public.artifacts where id = $1`, [qaId]))[0].n, deleted.length, /qa-internal/.test(deleted[0] || '')], [0, 1, true], 'un admin (no dueño) lo borra');
        // ... pero solo los QA / degradados: cualquier otro artifact del cliente sigue siendo del dueño (404).
        const otherFin = await ins(`${OWNER}/dynamic/1/1/dynamic_mbz/r/z.mbz`, {});
        await rejectsRe(ctl.remove(otherFin, ADMIN_OTHER), /not found/i, 'admin no dueño, artifact final del cliente', 404);
        eq((await ds.query(`select count(*)::int n from public.artifacts where id = $1`, [otherFin]))[0].n, 1, 'el final del cliente sigue');
        const finId = await ins(`${OWNER}/dynamic/1/1/dynamic_mbz/r/y.mbz`, {});
        await ctl.remove(finId, OWNER_NOT_ADMIN);
        eq((await ds.query(`select count(*)::int n from public.artifacts where id = $1`, [finId]))[0].n, 0, 'final del dueño: borrado como siempre');
      } finally {
        global.fetch = realFetchLocal;
      }
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
