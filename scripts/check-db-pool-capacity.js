#!/usr/bin/env node
/* eslint-disable */
// V2.1 calibración #2 — capacidad del pool de Postgres de STAGING (EMAXCONNSESSION).
//
// Parte pura (CI: --pure-only): lee los procesos PM2 REALES de deploy-staging.yml, los
// valores de pool que el deploy fija en el .env de staging, y calcula con
// dist/database/db-pool-config.js el máximo teórico de clientes. Exige headroom para
// migraciones del deploy, preflight y operaciones administrativas / FinOps (report).
//
// Parte DB (local): Postgres 16 desechable limitado a 15 clientes (como el pooler de
// Supabase en modo sesión). 11 pools (mismo `pg.Pool` que usa TypeORM) con la config
// calculada, workers polleando + heartbeats, ráfagas de la API (incluye ingest FinOps),
// una migración en transacción y un report, TODO concurrente. Mide el pico y los
// errores "too many clients" (53300 = EMAXCONNSESSION del pooler). También muestra que
// la config anterior (max 5, idle 20 s en los 11 procesos) sí agota el cupo.
//
// Uso: node scripts/check-db-pool-capacity.js [--pure-only]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const SESSION_LIMIT = 15;
const HEADROOM = { deployMigration: 1, preflightOrAdmin: 1, reportOrFinopsAdmin: 1 };
const HEADROOM_TOTAL = Object.values(HEADROOM).reduce((a, b) => a + b, 0);

let passes = 0;
let failures = 0;
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const A = JSON.stringify(a); const B = JSON.stringify(b); if (A !== B) throw new Error(`${m}: esperado ${B}, encontrado ${A}`); }
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`); }
}

const REPO = path.resolve(__dirname, '..');
const { dbPoolConfig } = require(path.join(REPO, 'dist/database/db-pool-config.js'));

/** Procesos PM2 de staging + el .env de pool que fija el deploy. */
function stagingProcesses() {
  const yml = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const procs = [...yml.matchAll(/^\s*ensure_pm2_process (\S+) (\S+)\s*$/gm)].map((m) => {
    const cmd = pkg.scripts[m[2]];
    const entry = (cmd || '').split(/\s+/)[1];
    return { name: m[1], script: m[2], entry };
  });
  // R16 (#1): los workers dinámicos se arrancan con node directo (ensure_pm2_drain_worker <nombre> <entry>).
  for (const m of yml.matchAll(/^\s*ensure_pm2_drain_worker (\S+) (\S+)\s*$/gm)) procs.push({ name: m[1], script: null, entry: m[2] });
  const env = {};
  for (const m of yml.matchAll(/^\s*ensure_env_(?:exact|default_if_absent) (DB_POOL_\w+) (\S+)\s*$/gm)) env[m[1]] = m[2];
  return { procs, env };
}

function budgetOf(procs, env) {
  const rows = procs.map((p) => ({ ...p, ...dbPoolConfig(env, path.join('/srv', p.entry || 'x')) }));
  return { rows, total: rows.reduce((a, r) => a + r.max, 0) };
}

(async () => {
  const { procs, env } = stagingProcesses();

  await check(`puro: deploy-staging.yml levanta 11 procesos y fija el pool de staging (DB_POOL_MAX / _WORKER / _IDLE_MS_WORKER)`, () => {
    eq(procs.length, 11, 'procesos PM2');
    assert(procs.every((p) => p.entry && fs.existsSync(path.join(REPO, p.entry))), `entry compilado de cada proceso: ${JSON.stringify(procs)}`);
    eq(Object.keys(env).sort(), ['DB_POOL_IDLE_MS_WORKER', 'DB_POOL_MAX', 'DB_POOL_MAX_WORKER'], 'variables de pool en el deploy');
  });

  let staging;
  await check(`puro: máximo teórico con la config de staging ≤ ${SESSION_LIMIT} − headroom ${HEADROOM_TOTAL} (${Object.entries(HEADROOM).map(([k, v]) => `${k}=${v}`).join(', ')})`, () => {
    staging = budgetOf(procs, env);
    for (const r of staging.rows) console.log(`     ${r.name.padEnd(42)} ${r.role.padEnd(6)} max=${r.max} idle=${r.idleTimeoutMillis}ms`);
    console.log(`     máximo teórico = ${staging.total} / ${SESSION_LIMIT} (headroom ${SESSION_LIMIT - staging.total})`);
    eq(staging.rows.filter((r) => r.role === 'api').map((r) => r.name), ['cursia-backend-staging'], 'un solo proceso api');
    assert(staging.total + HEADROOM_TOTAL <= SESSION_LIMIT, `teórico ${staging.total} + headroom ${HEADROOM_TOTAL} > ${SESSION_LIMIT}`);
    assert(staging.rows.filter((r) => r.role === 'worker').every((r) => r.max === 1 && r.idleTimeoutMillis <= 2000), 'workers de polling: 1 cliente, se suelta rápido');
  });

  await check('puro: sin variables (producción) la config NO cambia (max 5, idle 20 s); la de antes en staging daba 55 > 15', () => {
    const prod = budgetOf(procs, {});
    assert(prod.rows.every((r) => r.max === 5 && r.idleTimeoutMillis === 20000), 'defaults intactos');
    eq(prod.total, 55, 'teórico anterior');
    assert(prod.total > SESSION_LIMIT, 'la config anterior excede el cupo del pooler');
  });

  await check('puro: valores inválidos fallan fuerte (nunca un pool silenciosamente enorme)', () => {
    for (const bad of ['0', '-1', 'x', '2.5', '99']) {
      let threw = false;
      try { dbPoolConfig({ DB_POOL_MAX: bad }, '/srv/dist/main.js'); } catch { threw = true; }
      assert(threw, `DB_POOL_MAX=${bad}`);
    }
  });

  if (PURE_ONLY) {
    console.log(`\n${passes} ok, ${failures} fail`);
    process.exit(failures ? 1 : 0);
  }

  // ═══ Parte DB: Postgres 16 limitado a 15 clientes ═══════════════════════════
  const pgBin = ['/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin', '/usr/local/opt/postgresql@16/bin']
    .find((d) => fs.existsSync(path.join(d, 'initdb')));
  if (!pgBin) {
    console.log('⚠️  sin PG16 local: se omite la parte DB');
    console.log(`\n${passes} ok, ${failures} fail`);
    process.exit(failures ? 1 : 0);
  }
  const { Pool, Client } = require('pg');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-pool-pg16-'));
  const env0 = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (bin, args) => spawnSync(path.join(pgBin, bin), args, { encoding: 'utf8', env: env0 });
  let r = run('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  if (r.status !== 0) throw new Error('initdb: ' + r.stderr);
  // 15 clientes para el rol de la app (+3 reservados para superusuario = el monitor).
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), `\nmax_connections = ${SESSION_LIMIT + 3}\nsuperuser_reserved_connections = 3\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  r = run('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'log'), '-w', 'start']);
  if (r.status !== 0) throw new Error('pg_ctl start: ' + r.stderr);
  const admin = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  try {
    await admin.connect();
    await admin.query(`create role app login password 'app'`);
    const conn = { host: '127.0.0.1', port, user: 'app', password: 'app', database: 'postgres' };

    /** Carga concurrente de `durationMs` con la config de pool dada. */
    async function load(rows, durationMs) {
      const errors = [];
      let peak = 0;
      const onErr = (who) => (e) => { errors.push(`${who}: ${e.code || ''} ${e.message}`); };
      const pools = rows.map((rw) => ({
        rw,
        pool: new Pool({ ...conn, max: rw.max, min: 0, idleTimeoutMillis: rw.idleTimeoutMillis, connectionTimeoutMillis: 10000, keepAlive: true }),
      }));
      for (const p of pools) p.pool.on('error', onErr(p.rw.name));
      const stopAt = Date.now() + durationMs;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const q = (p, sql) => p.pool.query(sql).catch(onErr(p.rw.name));
      const tasks = [];
      for (const p of pools) {
        if (p.rw.role === 'api') {
          // API: ráfagas de requests (polling del navegador, claims/heartbeats del ejecutor, ingest FinOps).
          tasks.push((async () => { while (Date.now() < stopAt) { await Promise.all(Array.from({ length: 25 }, () => q(p, 'select pg_sleep(0.03)'))); await sleep(300); } })());
        } else {
          // Worker: claim cada ~3 s; los dinámicos además procesan con heartbeats concurrentes.
          const active = /dynamic/.test(p.rw.name);
          tasks.push((async () => {
            await sleep(Math.floor(Math.random() * 1000));
            while (Date.now() < stopAt) {
              await q(p, 'select pg_sleep(0.02)');
              if (active) await Promise.all([q(p, 'select pg_sleep(0.2)'), q(p, 'select 1'), q(p, 'select 1')]);
              await sleep(3000);
            }
          })());
        }
      }
      // Deploy: migración en transacción (1 cliente) + report/admin (1 cliente), a mitad de la carga.
      tasks.push((async () => {
        await sleep(1500);
        const mig = new Client(conn);
        try { await mig.connect(); await mig.query('begin'); await mig.query('select pg_sleep(2)'); await mig.query('commit'); } catch (e) { onErr('migración')(e); } finally { await mig.end().catch(() => {}); }
      })());
      tasks.push((async () => {
        await sleep(2000);
        const rep = new Client(conn);
        try { await rep.connect(); for (let i = 0; i < 10; i++) await rep.query('select count(*) from pg_class'); } catch (e) { onErr('report')(e); } finally { await rep.end().catch(() => {}); }
      })());
      const monitor = (async () => {
        while (Date.now() < stopAt) {
          const [{ n }] = (await admin.query(`select count(*)::int n from pg_stat_activity where usename = 'app'`)).rows;
          peak = Math.max(peak, n);
          await sleep(100);
        }
      })();
      await Promise.all([...tasks, monitor]);
      await Promise.all(pools.map((p) => p.pool.end().catch(() => {})));
      return { errors, peak };
    }

    await check(`DB: config de staging + workers activos + migración + report + ráfagas de la API (FinOps) → 0 "too many clients", pico ≤ ${SESSION_LIMIT}`, async () => {
      const res = await load(staging.rows, 12_000);
      console.log(`     pico observado = ${res.peak} clientes; errores = ${res.errors.length}`);
      eq(res.errors.filter((e) => /53300|too many clients|remaining connection slots/i.test(e)), [], 'sin agotamiento');
      eq(res.errors, [], 'sin errores');
      assert(res.peak <= SESSION_LIMIT, `pico ${res.peak}`);
    });

    await check('DB (RED de referencia): la config ANTERIOR (max 5 / idle 20 s en los 11 procesos) con la misma carga agota el cupo', async () => {
      const old = budgetOf(procs, {});
      const res = await load(old.rows, 8_000);
      console.log(`     pico observado = ${res.peak}; errores de agotamiento = ${res.errors.filter((e) => /53300|too many clients|remaining connection slots/i.test(e)).length}`);
      assert(res.errors.some((e) => /53300|too many clients|remaining connection slots/i.test(e)), 'la config anterior debería agotar las 15 conexiones');
    });
  } finally {
    await admin.end().catch(() => {});
    run('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('Unexpected error:', err); process.exit(1); });
