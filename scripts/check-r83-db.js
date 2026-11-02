#!/usr/bin/env node
/* eslint-disable */
// r83 · Conexión a Postgres resistente al pooler de Supabase lleno (incidente 2026-11-02, curso 91: el worker de audio
// murió al arrancar con «(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15»).
// Contra el código COMPILADO en dist/ ("npm run build" antes). USD 0: sin proveedores; la parte DB usa un Postgres local
// desechable (initdb en un directorio temporal) detrás de un «pooler» falso que, como Supavisor en modo sesión, rechaza
// al cliente N+1 con EMAXCONNSESSION.
//
//   P1  clasificación de errores de conexión (pooler lleno / red transitoria / espera del pool local / otro)
//   P2  backoff exponencial con jitter acotado
//   P3  planes por rol (arranque api 180 s / worker 600 s; adquisición 15 s; 0 = apagado; inválido → error)
//   P4  DB_HOST_/DB_PORT_ por rol (modo transacción solo para workers) y application_name
//   P5  dbPoolConfig sin cambios (compatibilidad con check-db-pool-capacity.js)
//   P6  initializeWithBackoff con reloj falso: backoff en pooler lleno, tope, 10 × 3 s para otros errores, libera el pool fallido
//   P7  installAcquireRetry con driver falso: reintenta solo pooler lleno / red; nunca la espera local ni otros errores
//   S1  el código no usa funciones de SESIÓN (compatibilidad con el pooler en modo transacción, puerto 6543)
//   S2  database.module compilado usa dataSourceFactory + retryAttempts 1 + applicationName
//   D1  (Postgres local) arranque real con el pooler lleno 2,5 s → conecta con backoff; sin r83 falla al instante
//   D2  (Postgres local) consulta en caliente con el pooler lleno 1,5 s → la adquisición reintenta y la consulta pasa;
//       sin el reintento la misma consulta falla con EMAXCONNSESSION; application_name visible en pg_stat_activity
//
// Uso: node scripts/check-r83-db.js [path/to/dist] [--pure-only]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const DIST = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(REPO, 'dist'));
const D = (rel) => {
  try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
};
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };

const CFG = D('database/db-pool-config.js');
const RES = D('database/db-connect-resilience.js');

const W = '/srv/app/dist/workers/dynamic-provider-worker.js';
const A = '/srv/app/dist/main.js';
const EMAX = '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15';
const quietLogger = () => { const lines = []; return { lines, warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) }; };
function fakeClock() {
  const c = { t: 0, sleeps: [], now: () => c.t, sleep: async (ms) => { c.sleeps.push(ms); c.t += ms; }, rand: () => 1 };
  return c;
}

async function pure() {
  await check('P1 clasificación de errores de conexión', () => {
    const k = CFG.classifyDbConnectError;
    eq(k(new Error(EMAX)), 'pool_exhausted', 'EMAXCONNSESSION');
    eq(k(Object.assign(new Error('Max client connections reached'), { code: 'XX000' })), 'pool_exhausted', 'transacción');
    eq(k({ code: '53300', message: 'sorry, too many clients already' }), 'pool_exhausted', '53300');
    eq(k(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 'transient_network', 'ECONNRESET');
    eq(k(new Error('Connection terminated unexpectedly')), 'transient_network', 'terminated');
    eq(k(new Error('timeout exceeded when trying to connect')), 'local_pool_timeout', 'pg-pool');
    eq(k({ code: '28P01', message: 'password authentication failed for user "x"' }), 'other', 'credenciales');
    eq(k({ code: '42883', message: 'operator does not exist: uuid = text' }), 'other', 'SQL');
    eq(k(undefined), 'other', 'undefined');
  });

  await check('P2 backoff exponencial con jitter acotado', () => {
    const b = CFG.backoffDelayMs;
    eq([0, 1, 2, 3, 4, 5, 10].map((i) => b(i, 2000, 30000, () => 1)), [2000, 4000, 8000, 16000, 30000, 30000, 30000], 'máximo');
    eq([0, 1, 2, 5].map((i) => b(i, 2000, 30000, () => 0)), [1000, 2000, 4000, 15000], 'mínimo');
    for (let i = 0; i < 200; i++) { const v = b(i % 12, 250, 4000); assert(v >= 1 && v <= 4000, `fuera de rango ${v}`); }
  });

  await check('P3 planes por rol (arranque / adquisición)', () => {
    eq(CFG.dbBootstrapRetryPlan({}, W).maxMs, 600000, 'worker default');
    eq(CFG.dbBootstrapRetryPlan({}, A).maxMs, 180000, 'api default');
    eq(CFG.dbBootstrapRetryPlan({ DB_BOOTSTRAP_RETRY_MAX_MS_WORKER: '90000', DB_BOOTSTRAP_RETRY_MAX_MS: '5000' }, W).maxMs, 90000, 'worker env');
    eq(CFG.dbBootstrapRetryPlan({ DB_BOOTSTRAP_RETRY_MAX_MS_WORKER: '90000', DB_BOOTSTRAP_RETRY_MAX_MS: '5000' }, A).maxMs, 5000, 'api env');
    const p = CFG.dbBootstrapRetryPlan({}, W);
    eq([p.otherAttempts, p.otherDelayMs], [10, 3000], 'otros errores = TypeORM de siempre');
    eq(CFG.dbAcquireRetryPlan({}).maxMs, 15000, 'adquisición default');
    eq(CFG.dbAcquireRetryPlan({ DB_CONNECT_RETRY_MAX_MS: '0' }).maxMs, 0, 'apagado');
    let threw = false; try { CFG.dbAcquireRetryPlan({ DB_CONNECT_RETRY_MAX_MS: 'x' }); } catch { threw = true; }
    assert(threw, 'valor inválido debe fallar');
  });

  await check('P4 host/puerto por rol y application_name', () => {
    const env = { DB_HOST_WORKER: 'aws-0-x.pooler.supabase.com', DB_PORT_WORKER: '6543' };
    eq(CFG.dbConnectionOverrides(env, W), { role: 'worker', host: 'aws-0-x.pooler.supabase.com', port: 6543 }, 'worker');
    eq(CFG.dbConnectionOverrides(env, A), { role: 'api', host: null, port: null }, 'api no usa las del worker');
    eq(CFG.dbConnectionOverrides({ DB_PORT_API: '5432' }, A), { role: 'api', host: null, port: 5432 }, 'api propio');
    eq(CFG.dbConnectionOverrides({}, W), { role: 'worker', host: null, port: null }, 'sin variables');
    let threw = false; try { CFG.dbConnectionOverrides({ DB_PORT_WORKER: '70000' }, W); } catch { threw = true; }
    assert(threw, 'puerto inválido debe fallar');
    eq(CFG.dbApplicationName({}, W, 4242), 'cursia:dynamic-provider-worker:4242', 'worker');
    eq(CFG.dbApplicationName({}, A, 7), 'cursia:main:7', 'api');
    eq(CFG.dbApplicationName({ DB_APPLICATION_NAME: 'x'.repeat(100) }, A, 7).length, 63, 'tope 63');
  });

  await check('P5 dbPoolConfig sin cambios', () => {
    eq(CFG.dbPoolConfig({}, W), { role: 'worker', max: 5, idleTimeoutMillis: 20000 }, 'defaults');
    eq(CFG.dbPoolConfig({ DB_POOL_MAX: '3', DB_POOL_MAX_WORKER: '1', DB_POOL_IDLE_MS_WORKER: '1000' }, W), { role: 'worker', max: 1, idleTimeoutMillis: 1000 }, 'prod worker');
    eq(CFG.dbPoolConfig({ DB_POOL_MAX: '3', DB_POOL_MAX_WORKER: '1', DB_POOL_IDLE_MS_WORKER: '1000' }, A), { role: 'api', max: 3, idleTimeoutMillis: 20000 }, 'prod api');
  });

  await check('P6 initializeWithBackoff (reloj falso)', async () => {
    // a) pooler lleno 5 veces → conecta; cada intento fallido libera su pool
    let n = 0; const ended = [];
    const mk = (failTimes, err) => () => {
      const i = n++;
      const ds = { isInitialized: false, driver: { master: { end: async () => { ended.push(i); } } },
        initialize: async () => { if (i < failTimes) throw err; ds.isInitialized = true; return ds; }, destroy: async () => {} };
      return ds;
    };
    let clock = fakeClock(); let log = quietLogger();
    const plan = { role: 'worker', maxMs: 600000, baseMs: 2000, capMs: 30000, otherAttempts: 10, otherDelayMs: 3000 };
    const ds = await RES.initializeWithBackoff(mk(5, new Error(EMAX)), plan, log, clock);
    assert(ds.isInitialized, 'no inicializó');
    eq(clock.sleeps, [2000, 4000, 8000, 16000, 30000], 'backoff');
    eq(ended, [0, 1, 2, 3, 4], 'pools fallidos liberados');
    // b) pooler lleno siempre → se rinde al tope (no antes, no 10 × 3 s)
    n = 0; clock = fakeClock(); log = quietLogger();
    let threw = null; try { await RES.initializeWithBackoff(mk(1e9, new Error(EMAX)), { ...plan, maxMs: 120000 }, log, clock); } catch (e) { threw = e; }
    assert(threw && /EMAXCONNSESSION/.test(threw.message), 'debió relanzar el error original');
    eq(clock.t, 120000, 'esperó exactamente el tope');
    assert(n > 10 || clock.t > 30000, 'más paciencia que 10 × 3 s');
    // c) otro error (credenciales) → 10 intentos cada 3 s, como TypeORM antes
    n = 0; clock = fakeClock(); log = quietLogger();
    threw = null; try { await RES.initializeWithBackoff(mk(1e9, Object.assign(new Error('password authentication failed'), { code: '28P01' })), plan, log, clock); } catch (e) { threw = e; }
    assert(threw && threw.code === '28P01', 'credenciales relanzadas');
    eq(n, 10, 'intentos'); eq(clock.sleeps, Array(9).fill(3000), 'pausas');
  });


  await check('P7 installAcquireRetry (driver falso)', async () => {
    const mkDs = (errs) => {
      let i = 0;
      const ds = { driver: { obtainMasterConnection: async () => { const e = errs[i++]; if (e) throw e; return ['conn', 'release']; } } };
      ds.calls = () => i;
      return ds;
    };
    const plan = { maxMs: 15000, baseMs: 250, capMs: 4000 };
    // a) reintenta pooler lleno + red transitoria y devuelve la conexión
    let ds = mkDs([new Error(EMAX), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })]);
    let clock = fakeClock();
    assert(RES.installAcquireRetry(ds, plan, quietLogger(), clock), 'no se instaló');
    assert(!RES.installAcquireRetry(ds, plan, quietLogger(), clock), 'doble instalación');
    eq(await ds.driver.obtainMasterConnection(), ['conn', 'release'], 'conexión');
    eq(ds.calls(), 3, 'intentos'); eq(clock.sleeps, [250, 500], 'backoff');
    // b) espera del pool LOCAL y errores de otro tipo → se propagan sin reintentar
    for (const e of [new Error('timeout exceeded when trying to connect'), Object.assign(new Error('password authentication failed'), { code: '28P01' })]) {
      ds = mkDs([e]); clock = fakeClock(); RES.installAcquireRetry(ds, plan, quietLogger(), clock);
      let threw = null; try { await ds.driver.obtainMasterConnection(); } catch (x) { threw = x; }
      assert(threw === e, `debió propagar ${e.message}`); eq(ds.calls(), 1, 'sin reintento'); eq(clock.sleeps, [], 'sin espera');
    }
    // c) pooler lleno persistente → se rinde al tope con el error original
    ds = mkDs(Array(1000).fill(new Error(EMAX))); clock = fakeClock(); RES.installAcquireRetry(ds, plan, quietLogger(), clock);
    let threw = null; try { await ds.driver.obtainMasterConnection(); } catch (x) { threw = x; }
    assert(threw && /EMAXCONNSESSION/.test(threw.message), 'error original'); eq(clock.t, 15000, 'tope');
    // d) plan apagado → no toca el driver
    ds = mkDs([]); const orig = ds.driver.obtainMasterConnection;
    assert(!RES.installAcquireRetry(ds, { ...plan, maxMs: 0 }, quietLogger(), fakeClock()), 'apagado'); assert(ds.driver.obtainMasterConnection === orig, 'driver tocado');
  });

  await check('S1 sin funciones de SESIÓN (compatible con el pooler en modo transacción)', () => {
    const offenders = [];
    const SESSION_RE = /pg_advisory_lock\s*\(|pg_try_advisory_lock\s*\(|pg_advisory_unlock|\bLISTEN\s+\w|\bUNLISTEN\b|create\s+temp(orary)?\s+table|\bSET\s+(SESSION\s+)?(statement_timeout|lock_timeout|search_path|idle_in_transaction_session_timeout)\b|set_config\s*\([^)]*,\s*false\s*\)|\bDECLARE\s+\w+\s+CURSOR\b|\bPREPARE\s+\w+\s+(AS|\()/i;
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== 'scripts') walk(p); continue; }
        if (!/\.ts$/.test(f.name) || /\.spec\.ts$/.test(f.name)) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (SESSION_RE.test(line)) offenders.push(`${path.relative(REPO, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    };
    walk(path.join(REPO, 'src'));
    assert(offenders.length === 0, `funciones de sesión encontradas:\n   ${offenders.join('\n   ')}`);
  });

  await check('S2 database.module compilado usa la conexión resistente', () => {
    const js = fs.readFileSync(path.join(DIST, 'database/database.module.js'), 'utf8');
    assert(/dataSourceFactory/.test(js), 'sin dataSourceFactory');
    assert(/retryAttempts:\s*1\b/.test(js), 'Nest no debe sumar otra capa de reintentos');
    assert(/initializeWithBackoff/.test(js) && /installAcquireRetry/.test(js), 'sin backoff / reintento de adquisición');
    assert(/applicationName:/.test(js) && /dbConnectionOverrides/.test(js), 'sin application_name / overrides por rol');
  });
}

/* ───────────────────────────── Parte DB: Postgres local + «pooler» falso en modo sesión ───────────────────────────── */

function pgBin(name) {
  for (const d of ['/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/16/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const p = path.join(d, name); if (fs.existsSync(p)) return p;
  }
  return null;
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Pooler de mentira: como Supavisor en modo sesión, un cliente = una conexión al servidor; el N+1 recibe EMAXCONNSESSION. */
function fakeSessionPooler(upstreamPort) {
  const st = { limit: 15, active: 0, rejected: 0, server: null, port: 0 };
  const errorResponse = (msg) => {
    const fields = Buffer.concat([['S', 'FATAL'], ['V', 'FATAL'], ['C', 'XX000'], ['M', msg]].map(([k, v]) => Buffer.from(`${k}${v}\0`, 'utf8')).concat([Buffer.from([0])]));
    const head = Buffer.alloc(5); head.write('E', 0); head.writeInt32BE(fields.length + 4, 1);
    return Buffer.concat([head, fields]);
  };
  st.server = net.createServer((client) => {
    let buf = Buffer.alloc(0); let decided = false;
    client.on('error', () => {});
    client.on('data', function onData(chunk) {
      if (decided) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const len = buf.readInt32BE(0);
      if (buf.readInt32BE(4) === 80877103) { buf = buf.subarray(8); client.write('N'); if (buf.length < 8) return; } // SSLRequest → no
      if (buf.length < buf.readInt32BE(0)) return;
      decided = true; client.removeListener('data', onData);
      if (st.active >= st.limit) {
        st.rejected++;
        client.end(errorResponse(`(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: ${st.limit}`));
        return;
      }
      st.active++;
      let closed = false; const done = () => { if (!closed) { closed = true; st.active--; } };
      const up = net.connect(upstreamPort, '127.0.0.1', () => { up.write(buf); client.pipe(up); up.pipe(client); });
      up.on('error', () => client.destroy()); up.on('close', () => { done(); client.destroy(); });
      client.on('close', () => { done(); up.destroy(); });
      void len;
    });
  });
  return new Promise((res) => st.server.listen(0, '127.0.0.1', () => { st.port = st.server.address().port; res(st); }));
}

async function dbPart() {
  const initdb = pgBin('initdb'); const pgctl = pgBin('pg_ctl');
  if (!initdb || !pgctl) { console.log('⚠️  Parte DB omitida: no hay initdb/pg_ctl (Postgres 16) en este equipo'); return; }
  const { DataSource } = require(path.join(REPO, 'node_modules/typeorm'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r83-db-'));
  const data = path.join(dir, 'data'); const port = await freePort();
  let started = false; let pooler = null; const sources = [];
  try {
    const cenv = { ...process.env, LANG: 'C', LC_ALL: 'C' };
    const r1 = spawnSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8', env: cenv });
    if (r1.status !== 0) throw new Error(`initdb falló: ${r1.stderr}`);
    const r2 = spawnSync(pgctl, ['-D', data, '-l', path.join(dir, 'pg.log'), '-w', '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c max_connections=30`, 'start'], { encoding: 'utf8', env: cenv });
    if (r2.status !== 0) throw new Error(`pg_ctl start falló: ${r2.stderr}${r2.stdout}`);
    started = true;
    pooler = await fakeSessionPooler(port);
    const opts = (extra = {}, applicationName = 'cursia:check-r83:1') => ({
      type: 'postgres', host: '127.0.0.1', port: pooler.port, username: 'postgres', password: 'x', database: 'postgres',
      entities: [], synchronize: false, logging: false, applicationName,
      extra: { max: 1, min: 0, idleTimeoutMillis: 150, connectionTimeoutMillis: 5000, ...extra },
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await check('D1 arranque real con el pooler lleno 2,5 s: sin r83 falla al instante; con r83 conecta con backoff', async () => {
      pooler.limit = 0;
      const plain = new DataSource(opts());
      let threw = null; try { await plain.initialize(); } catch (e) { threw = e; }
      assert(threw && /EMAXCONNSESSION/.test(threw.message), `sin r83 debía fallar con EMAXCONNSESSION (fue: ${threw && threw.message})`);
      eq(CFG.classifyDbConnectError(threw), 'pool_exhausted', 'el error real de pg se clasifica como pooler lleno');
      const log = quietLogger(); const t0 = Date.now();
      setTimeout(() => { pooler.limit = 15; }, 2500);
      const ds = await RES.initializeWithBackoff(() => new DataSource(opts()), { role: 'worker', maxMs: 20000, baseMs: 200, capMs: 1000, otherAttempts: 10, otherDelayMs: 3000 }, log);
      sources.push(ds);
      const waited = Date.now() - t0;
      assert(ds.isInitialized && waited >= 2400 && waited < 8000, `esperó ${waited} ms`);
      assert(log.lines.some(([, m]) => /pool_exhausted/.test(m)), 'sin log de reintento');
      eq((await ds.query('select 1 as ok'))[0].ok, 1, 'consulta');
      // ningún intento fallido dejó conexiones abiertas: solo la del DataSource vivo (o ninguna si ya expiró por idle)
      await sleep(400);
      assert(pooler.active <= 1, `conexiones abiertas tras el arranque: ${pooler.active}`);
    });

    await check('D2 en caliente: la adquisición reintenta con el pooler lleno; sin r83 la consulta falla; application_name visible', async () => {
      pooler.limit = 15;
      const withRetry = new DataSource(opts({}, 'cursia:check-r83-retry:1')); await withRetry.initialize(); sources.push(withRetry);
      const noRetry = new DataSource(opts({}, 'cursia:check-r83-plain:1')); await noRetry.initialize(); sources.push(noRetry);
      assert(RES.installAcquireRetry(withRetry, { maxMs: 10000, baseMs: 100, capMs: 500 }, quietLogger()), 'no se instaló');
      await sleep(500); // idle 150 ms → ambos pools sueltan su conexión (como los workers de prod con idle 1000 ms)
      eq(pooler.active, 0, 'conexiones idle liberadas');
      pooler.limit = 0;
      let threw = null; try { await noRetry.query('select 1'); } catch (e) { threw = e; }
      assert(threw && /EMAXCONNSESSION/.test(threw.message), `sin r83 debía fallar (fue: ${threw && threw.message})`);
      setTimeout(() => { pooler.limit = 15; }, 1500);
      const t0 = Date.now();
      const rows = await withRetry.query(`select application_name from pg_stat_activity where pid = pg_backend_pid()`);
      const waited = Date.now() - t0;
      assert(waited >= 1400, `esperó ${waited} ms`);
      eq(rows[0].application_name, 'cursia:check-r83-retry:1', 'application_name');
      // una transacción con queryRunner también pasa por la adquisición con reintento
      await sleep(400); pooler.limit = 0; setTimeout(() => { pooler.limit = 15; }, 800);
      const qr = withRetry.createQueryRunner();
      try { await qr.connect(); await qr.startTransaction(); await qr.query('select 1'); await qr.commitTransaction(); } finally { await qr.release(); }
    });

    await check('D3 DatabaseModule real (Nest): arranca con el pooler lleno 2 s y deja instalado el reintento de adquisición', async () => {
      Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(pooler.port), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'postgres',
        DB_SSL: 'false', NODE_ENV: 'test', DB_BOOTSTRAP_RETRY_MAX_MS: '20000', DB_APPLICATION_NAME: 'cursia:check-r83-nest' });
      const { NestFactory } = require(path.join(REPO, 'node_modules/@nestjs/core'));
      const { DatabaseModule } = D('database/database.module.js');
      pooler.limit = 0; setTimeout(() => { pooler.limit = 15; }, 2000);
      const t0 = Date.now();
      const app = await NestFactory.createApplicationContext(DatabaseModule, { logger: false });
      try {
        const ds = app.get(DataSource);
        assert(Date.now() - t0 >= 1900, 'no esperó al pooler');
        assert(ds.driver.obtainMasterConnection.name === 'obtainMasterConnectionWithRetry', 'reintento de adquisición no instalado');
        const [r] = await ds.query(`select application_name from pg_stat_activity where pid = pg_backend_pid()`);
        eq(r.application_name, 'cursia:check-r83-nest', 'application_name');
      } finally { await app.close(); }
    });
  } finally {
    for (const ds of sources) { try { if (ds.isInitialized) await ds.destroy(); } catch {} }
    if (pooler) pooler.server.close();
    if (started) spawnSync(pgctl, ['-D', data, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  await pure();
  if (!PURE_ONLY) { try { await dbPart(); } catch (e) { fail++; console.log(`❌ parte DB: ${e && e.message}`); } }
  console.log(`\nr83 check: ${ok} OK, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
