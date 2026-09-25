#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// Release-fix C1 — regresión PERMANENTE de "código nuevo contra esquema viejo"
// (y "código viejo contra esquema nuevo").
//
// El E2E arma su esquema con TypeORM `synchronize`, así que entities y esquema
// siempre coinciden y NUNCA puede detectar que el código de esta rama necesita
// columnas que producción todavía no tiene. Este test sí:
//
//   1. Levanta un Postgres 16 LOCAL Y DESECHABLE (initdb en un dir temporal,
//      127.0.0.1:55491, se destruye al final) y carga
//      scripts/prod/test/fixtures/legacy-baseline.sql (= producción pre-V2:
//      las 4 tablas compartidas con EXACTAMENTE las columnas de las entities
//      de `main`, y los CHECK de production_jobs de `main`).
//   2. Fidelidad del fixture: columnas de la base == columnas mapeadas por las
//      entities COMPILADAS de esta rama MENOS las columnas V2 conocidas.
//   3. Bootea las entities COMPILADAS (dist/**/*.entity.js) con un DataSource
//      TypeORM (synchronize: false, como producción) y corre consultas legacy
//      representativas sobre courses / course_versions / artifacts /
//      production_jobs → DEBEN FALLAR con 42703 (columna inexistente): es el
//      outage que C1 describe si se mergea antes de migrar.
//   4. Corre el runner REAL (scripts/prod/migrate-v2-production.js --apply,
//      override de tests) sobre esa base — sin correr antes
//      migrate-production-jobs-constraints.js: el runner lo hace él (paso 0).
//   5. Las mismas consultas DEBEN PASAR, más inserts dynamic en
//      production_jobs (CHECK ensanchado) y "toda columna mapeada por
//      cualquier entity existe".
//   6. Código VIEJO contra esquema NUEVO: el cambio en las tablas compartidas
//      es solo aditivo — ninguna columna borrada ni con tipo/nulabilidad
//      cambiada, ninguna columna nueva NOT NULL sin default, e INSERT/UPDATE
//      crudos con SOLO las columnas de `main` siguen funcionando.
//
// Requisitos: Postgres 16 (Homebrew o PG_BIN=<dir>), `npm ci` y `npm run build`.
//   node scripts/prod/test/run-legacy-app-compat-test.js
// Nunca toca Supabase: el entorno de los hijos se arma desde cero.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(REPO, 'dist');
const RUNNER = path.join(REPO, 'scripts/prod/migrate-v2-production.js');
const FIXTURE = path.join(__dirname, 'fixtures/legacy-baseline.sql');
const PG_PORT = Number(process.env.V2_TEST_COMPAT_PG_PORT || 55491);
const FAKE_REF = 'localprodlike0002';
const DB = 'legacyapp';

const SHARED_TABLES = ['courses', 'course_versions', 'artifacts', 'production_jobs'];
const SHARED_ENTITIES = { Course: 'courses', CourseVersion: 'course_versions', Artifact: 'artifacts', ProductionJob: 'production_jobs' };
// Columnas que las entities de esta rama agregan sobre las de `main`
// (git diff origin/main -- src/modules/{courses,course-versions,artifacts,production-jobs}/entities).
const V2_ENTITY_COLUMNS = {
  courses: ['structure_version', 'structure_version_counter', 'current_blueprint_id'],
  course_versions: ['locked_at'],
  artifacts: ['module_id', 'chapter_id', 'status', 'generated_with_version_id'],
  production_jobs: ['blueprint_version_id'],
};
const V2_TABLES = ['course_modules', 'course_chapters', 'course_blueprints', 'course_generation_manifests', 'generation_item_runs', 'generation_run_contexts'];
const OWNER = '00000000-0000-0000-0000-00000000aaaa';

// ── mini framework ─────────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '\n     ' + String(detail).split('\n').slice(0, 40).join('\n     ') : ''}`);
}
async function test(name, fn) {
  try { await fn(); record(name, true); } catch (err) { record(name, false, err && err.message ? err.message : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
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

// ── entities compiladas ────────────────────────────────────────────────────
function loadCompiledEntities() {
  if (!fs.existsSync(DIST)) throw new Error(`no existe ${DIST} — corré "npm run build" antes`);
  require(path.join(REPO, 'node_modules/reflect-metadata'));
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.entity.js')) files.push(p);
    }
  })(DIST);
  const byName = {};
  for (const f of files) Object.assign(byName, require(f));
  const classes = Object.values(byName).filter((v) => typeof v === 'function');
  return { byName, classes, files };
}

async function columnsOf(client, tables) {
  const { rows } = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])`,
    [tables],
  );
  const out = {};
  for (const t of tables) out[t] = {};
  for (const r of rows) out[r.table_name][r.column_name] = r;
  return out;
}

// Consultas legacy representativas (las que hacen los servicios/workers de
// `main` a través de TypeORM). Las escrituras corren en una transacción que
// SIEMPRE se revierte.
function legacyQueries(ds, E) {
  const inTx = async (fn) => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try { await fn(qr.manager); } finally { await qr.rollbackTransaction(); await qr.release(); }
  };
  return [
    { entity: 'Course', name: 'find({take:1})', fn: () => ds.getRepository(E.Course).find({ take: 1 }) },
    { entity: 'Course', name: 'findOne + leftJoinAndSelect versions (CoursesService.findOne)', fn: () =>
      ds.getRepository(E.Course).createQueryBuilder('course').leftJoinAndSelect('course.versions', 'versions')
        .where('course.id = :id', { id: 1 }).andWhere('course.owner_id = :o', { o: OWNER }).getOne() },
    { entity: 'Course', name: 'save() de un curso nuevo (POST /courses)', fn: () => inTx((m) =>
      m.save(m.create(E.Course, { title: 'compat', ownerId: OWNER, ownerEmail: 'a@b.c' }))) },
    { entity: 'CourseVersion', name: 'find({take:1})', fn: () => ds.getRepository(E.CourseVersion).find({ take: 1 }) },
    { entity: 'CourseVersion', name: 'save() de una versión nueva', fn: () => inTx((m) =>
      m.save(m.create(E.CourseVersion, { courseId: 1, versionNumber: 2, status: 'draft' }))) },
    { entity: 'Artifact', name: 'find({where:{ownerId}})', fn: () => ds.getRepository(E.Artifact).find({ where: { ownerId: OWNER }, take: 5 }) },
    { entity: 'Artifact', name: 'save() de un artifact legacy', fn: () => inTx((m) =>
      m.save(m.create(E.Artifact, { ownerId: OWNER, courseId: 'c-legacy-1', type: 'content_snapshot', storagePath: 'u/c/snap.json' }))) },
    { entity: 'ProductionJob', name: 'find({take:1})', fn: () => ds.getRepository(E.ProductionJob).find({ take: 1 }) },
    { entity: 'ProductionJob', name: 'save() de un job backend_content + update de worker_status', fn: () => inTx(async (m) => {
      const j = await m.save(m.create(E.ProductionJob, { ownerId: OWNER, courseId: 1, executionMode: 'backend_content', workerStatus: 'queued' }));
      await m.update(E.ProductionJob, { id: j.id }, { workerStatus: 'running' });
    }) },
  ];
}

async function runQueries(ds, E) {
  const out = [];
  for (const q of legacyQueries(ds, E)) {
    try { await q.fn(); out.push({ ...q, ok: true }); } catch (err) { out.push({ ...q, ok: false, code: err.code, message: err.message }); }
  }
  return out;
}

async function main() {
  const pgBin = findPgBin();
  const { Client } = require(path.join(REPO, 'node_modules/pg'));
  const { DataSource } = require(path.join(REPO, 'node_modules/typeorm'));
  const { byName: E, classes } = loadCompiledEntities();
  for (const n of Object.keys(SHARED_ENTITIES)) if (typeof E[n] !== 'function') throw new Error(`entity compilada ${n} no encontrada en dist/`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v2-compat-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v2-compat-cwd-'));
  const pgEnv = cleanEnv();
  let started = false;
  let ds = null;
  const withClient = async (fn) => {
    const c = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', database: DB });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };
  try {
    let r = spawnSync(path.join(pgBin, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { env: pgEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${PG_PORT} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start'], { env: pgEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`Postgres ${pgBin} en 127.0.0.1:${PG_PORT} (data ${dataDir})\n`);

    {
      const c = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', database: 'postgres' });
      await c.connect();
      await c.query(`create database ${DB}`);
      await c.end();
    }
    await withClient((c) => c.query(fs.readFileSync(FIXTURE, 'utf8')));

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: PG_PORT, username: 'postgres', database: DB, entities: classes, synchronize: false, logging: false });
    await ds.initialize();

    const before = await withClient((c) => columnsOf(c, SHARED_TABLES));

    await test('fidelidad del fixture: columnas legacy == entities compiladas de esta rama − columnas V2 (== entities de main)', async () => {
      const problems = [];
      for (const [ent, table] of Object.entries(SHARED_ENTITIES)) {
        const mapped = new Set(ds.getMetadata(E[ent]).columns.map((c) => c.databaseName));
        const expected = [...mapped].filter((c) => !V2_ENTITY_COLUMNS[table].includes(c)).sort();
        const actual = Object.keys(before[table]).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          problems.push(`${table}: esperado [${expected}] encontrado [${actual}]`);
        }
        for (const c of V2_ENTITY_COLUMNS[table]) if (!mapped.has(c)) problems.push(`${ent} ya no mapea ${c} — actualizar V2_ENTITY_COLUMNS`);
      }
      assert(problems.length === 0, problems.join('\n'));
    });

    const red = await runQueries(ds, E);
    await test('ANTES del runner: el código de esta rama FALLA con 42703 en las 4 tablas compartidas (el outage de C1)', async () => {
      const lines = red.map((q) => `${q.ok ? 'OK  ' : 'FAIL'} ${q.entity}.${q.name}${q.ok ? '' : ` → ${q.code} ${q.message}`}`);
      for (const ent of Object.keys(SHARED_ENTITIES)) {
        const failed42703 = red.filter((q) => q.entity === ent && !q.ok && q.code === '42703');
        assert(failed42703.length > 0, `${ent}: ninguna consulta falló con 42703 — el test ya no reproduce el esquema legacy\n${lines.join('\n')}`);
      }
      const otherFailures = red.filter((q) => !q.ok && q.code !== '42703');
      assert(otherFailures.length === 0, `fallas que no son 42703:\n${lines.join('\n')}`);
      console.log('     ' + lines.join('\n     '));
    });

    await test('runner --apply (override de tests) sobre la base legacy, SIN correr antes migrate-production-jobs-constraints.js → exit 0', async () => {
      const res = spawnSync(process.execPath, [RUNNER, '--apply', '--i-understand-this-mutates-production', '--test-allow-local-target'], {
        cwd: tmpCwd,
        env: cleanEnv({
          DB_HOST: '127.0.0.1', DB_PORT: PG_PORT, DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false',
          NODE_ENV: 'test', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, MIGRATION_ENV: 'production',
          CONFIRM_PRODUCTION_REF: FAKE_REF, CONFIRM_BACKUP_TAKEN: 'yes',
        }),
        encoding: 'utf8', timeout: 300000,
      });
      const out = (res.stdout || '') + (res.stderr || '');
      assert(res.status === 0, `exit ${res.status}\n${out.split('\n').slice(-30).join('\n')}`);
    });

    const green = await runQueries(ds, E);
    await test('DESPUÉS del runner: las mismas consultas legacy de las entities compiladas PASAN', async () => {
      const bad = green.filter((q) => !q.ok);
      assert(bad.length === 0, bad.map((q) => `${q.entity}.${q.name} → ${q.code} ${q.message}`).join('\n'));
    });

    await test('DESPUÉS del runner: production_jobs acepta dynamic_generation y dynamic_package (paso 0 del runner)', async () => {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        for (const mode of ['dynamic_generation', 'dynamic_package']) {
          await qr.manager.save(qr.manager.create(E.ProductionJob, { ownerId: OWNER, courseId: 1, executionMode: mode, workerStatus: 'queued', inputPayload: { probe: mode } }));
        }
      } finally { await qr.rollbackTransaction(); await qr.release(); }
    });

    await test('DESPUÉS del runner: toda columna mapeada por CUALQUIER entity compilada existe (tablas compartidas + V2)', async () => {
      const tables = [...new Set(ds.entityMetadatas.map((m) => m.tableName))];
      const cols = await withClient((c) => columnsOf(c, tables));
      // Solo tablas compartidas, V2 e institutions (FK de courses). Las demás
      // tablas legacy (usage_events, cost_rates, brand_profiles, …) tienen
      // entities idénticas a las de main y sus migraciones las corre
      // deploy.yml; el fixture no las reproduce al detalle.
      const checked = new Set([...SHARED_TABLES, ...V2_TABLES, 'institutions']);
      const problems = [];
      for (const m of ds.entityMetadatas) {
        if (!checked.has(m.tableName)) continue;
        const present = cols[m.tableName];
        if (!Object.keys(present).length) { problems.push(`falta la tabla ${m.tableName}`); continue; }
        for (const c of m.columns) if (!present[c.databaseName]) problems.push(`${m.tableName}.${c.databaseName} (${m.name})`);
      }
      for (const t of V2_TABLES) if (!ds.entityMetadatas.some((m) => m.tableName === t) && !Object.keys(cols[t] || {}).length) {
        const [{ present }] = await withClient(async (c) => (await c.query(`select to_regclass('public.' || $1) is not null as present`, [t])).rows);
        if (!present) problems.push(`falta la tabla V2 ${t}`);
      }
      assert(problems.length === 0, 'columnas faltantes: ' + problems.join(', '));
    });

    const after = await withClient((c) => columnsOf(c, SHARED_TABLES));
    await test('código VIEJO vs esquema NUEVO: tablas compartidas solo con cambios ADITIVOS (nada borrado ni cambiado; ninguna columna nueva NOT NULL sin default)', async () => {
      const problems = [];
      for (const t of SHARED_TABLES) {
        for (const [name, b] of Object.entries(before[t])) {
          const a = after[t][name];
          if (!a) { problems.push(`${t}.${name} BORRADA`); continue; }
          if (a.data_type !== b.data_type) problems.push(`${t}.${name} cambió de tipo ${b.data_type} → ${a.data_type}`);
          if (a.is_nullable !== b.is_nullable) problems.push(`${t}.${name} cambió nulabilidad ${b.is_nullable} → ${a.is_nullable}`);
          if ((a.column_default || null) !== (b.column_default || null)) problems.push(`${t}.${name} cambió default ${b.column_default} → ${a.column_default}`);
        }
        for (const [name, a] of Object.entries(after[t])) {
          if (before[t][name]) continue;
          if (a.is_nullable === 'NO' && a.column_default === null) problems.push(`${t}.${name} es NUEVA, NOT NULL y SIN default — rompe los INSERT del código de main`);
        }
      }
      assert(problems.length === 0, problems.join('\n'));
    });

    await test('código VIEJO vs esquema NUEVO: INSERT/UPDATE crudos con SOLO las columnas de main pasan en las 4 tablas; datos legacy intactos', async () => {
      await withClient(async (c) => {
        const counts = async () => (await c.query(`select (select count(*) from courses)::int a, (select count(*) from course_versions)::int b,
          (select count(*) from artifacts)::int c, (select count(*) from production_jobs)::int d,
          (select count(*) from courses where structure_version = 'legacy')::int legacy`)).rows[0];
        const c0 = await counts();
        assert(c0.a === 2 && c0.b === 2 && c0.c === 1 && c0.d === 2 && c0.legacy === 2, 'datos legacy: ' + JSON.stringify(c0));
        await c.query('begin');
        try {
          const course = await c.query(`insert into courses (owner_id, owner_email, title, status, metadata, created_at, updated_at)
                                         values ($1, 'a@b.c', 'viejo', 'draft', '{}', now(), now()) returning id, structure_version`, [OWNER]);
          assert(course.rows[0].structure_version === 'legacy', 'un curso creado por main debe quedar legacy: ' + course.rows[0].structure_version);
          await c.query(`insert into course_versions (course_id, version_number, status, snapshot_json, created_at) values ($1, 1, 'draft', '{}', now())`, [course.rows[0].id]);
          const art = await c.query(`insert into artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, mime_type, metadata, created_at, updated_at)
                                      values ($1, 'x', 'mbz_final', 'supabase', 'cursia-artifacts', 'u/x/final.mbz', 'application/zip', '{}', now(), now()) returning id`, [OWNER]);
          await c.query(`insert into production_jobs (owner_id, course_id, status, progress, retry_count, execution_mode, worker_status, input_payload, output_summary, content_snapshot_artifact_id, created_at, updated_at)
                         values ($1, $2, 'queued', 0, 0, 'backend_package', 'queued', '{}', '{}', $3, now(), now())`, [OWNER, course.rows[0].id, art.rows[0].id]);
          await c.query(`update production_jobs set worker_status = 'running', lease_until = now() + interval '1 minute' where owner_id = $1`, [OWNER]);
          await c.query(`update courses set title = title || ' (edit)', updated_at = now() where owner_id = $1`, [OWNER]);
          await c.query(`update artifacts set metadata = '{"k":1}', updated_at = now() where owner_id = $1`, [OWNER]);
        } finally {
          await c.query('rollback');
        }
        const c1 = await counts();
        assert(JSON.stringify(c0) === JSON.stringify(c1), 'la transacción revertida dejó filas');
      });
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    if (started) spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], { env: pgEnv });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log(`\n(Postgres detenido y ${dataDir} borrado)`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} ok, ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('❌ harness:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
