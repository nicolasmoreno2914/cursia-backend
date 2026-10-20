#!/usr/bin/env node
/* eslint-disable */
// T8 (factory mode, 2026-10-18) — guardia de congelamiento del deploy de staging.
//
//   [WF]  deploy-staging.yml: input `force_deploy` (no|yes, default no); el PRIMER paso del job deploy bloquea con
//         vars.DEPLOY_FREEZE=true salvo dispatch + force_deploy=yes (se ejecuta el bash del paso con cada combinación);
//         el paso de runs activos corre scripts/ops/check-active-runs.js en el VPS por stdin, DESPUÉS de Configure SSH
//         y ANTES del rsync y del reinicio/reload de PM2, sin `|| true` ni continue-on-error.
//   [PU]  scripts/ops/check-active-runs.js puro: decisión (matriz), args, .env, DEPLOY_FREEZE, colecta con un
//         query runner inyectable, render sin datos sensibles.
//   [PR]  proceso real por stdin (como en el deploy): error de conexión → exit 1 (fail closed); --force → 0.
//   [PG]  PG16 DESECHABLE (esquema legacy-baseline + CHECK ensanchado + generation_item_runs mínima): runs activos /
//         items reclamados / empaques activos → exit 2; pausado y lease vencido → solo info; libre → 0;
//         DEPLOY_FREEZE en el .env del cwd → 3; la base queda idéntica (solo lectura).
//
// 0 red externa (solo 127.0.0.1), 0 gasto. Usage: node scripts/check-deploy-freeze-guard.js [--pure-only]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const WF = path.join(REPO, '.github/workflows/deploy-staging.yml');
const SCRIPT = path.join(REPO, 'scripts/ops/check-active-runs.js');
const PURE_ONLY = process.argv.includes('--pure-only');
const G = require(SCRIPT);

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
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

// ════ [WF] workflow ═════════════════════════════════════════════════════════
async function workflowChecks() {
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(WF, 'utf8'));
  const steps = wf.jobs.deploy.steps;
  const idx = (pred, m) => { const i = steps.findIndex(pred); assert(i >= 0, `paso no encontrado: ${m}`); return i; };

  await check('[WF] YAML válido; input force_deploy (choice no|yes, default no) solo en workflow_dispatch', () => {
    const inp = wf.on.workflow_dispatch.inputs.force_deploy;
    eq([inp.type, inp.options, inp.default], ['choice', ['no', 'yes'], 'no'], 'force_deploy');
    assert(wf.on.push && !wf.on.push.inputs, 'push sin inputs');
  });

  await check('[WF] el PRIMER paso del job deploy es la guardia DEPLOY_FREEZE (vars.DEPLOY_FREEZE; FORCE solo por dispatch)', () => {
    const s = steps[0];
    assert(/DEPLOY_FREEZE/.test(s.name), `primer paso: ${s.name}`);
    eq(s.env.DEPLOY_FREEZE, '${{ vars.DEPLOY_FREEZE }}', 'lee la variable del repo/environment');
    eq(s.env.FORCE_DEPLOY, "${{ github.event_name == 'workflow_dispatch' && inputs.force_deploy || 'no' }}", 'force solo por dispatch');
    assert(!s['continue-on-error'], 'sin continue-on-error');
  });

  await check('[WF] bash de la guardia DEPLOY_FREEZE: true/TRUE/" true " bloquea (exit 1) salvo force=yes; vacío/false/otro pasa', () => {
    const run = steps[0].run;
    const cases = [
      [{ DEPLOY_FREEZE: 'true', FORCE_DEPLOY: 'no' }, 1], [{ DEPLOY_FREEZE: 'TRUE', FORCE_DEPLOY: 'no' }, 1], [{ DEPLOY_FREEZE: ' true ', FORCE_DEPLOY: 'no' }, 1],
      [{ DEPLOY_FREEZE: 'true', FORCE_DEPLOY: 'yes' }, 0], [{ DEPLOY_FREEZE: '', FORCE_DEPLOY: 'no' }, 0], [{ DEPLOY_FREEZE: 'false', FORCE_DEPLOY: 'no' }, 0],
      [{ DEPLOY_FREEZE: 'yes', FORCE_DEPLOY: 'no' }, 0],
    ];
    for (const [env, want] of cases) {
      const r = spawnSync('bash', ['-e', '-c', run], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
      eq(r.status, want, `DEPLOY_FREEZE=${JSON.stringify(env.DEPLOY_FREEZE)} force=${env.FORCE_DEPLOY}`);
      if (want === 1) assert(/::error::DEPLOY_FREEZE=true/.test(r.stdout), 'mensaje de error visible');
    }
  });

  await check('[WF] la guardia de runs activos corre check-active-runs.js en el VPS por stdin, después de Configure SSH y ANTES del rsync y del reinicio/reload de PM2; sin `|| true`', () => {
    const iGuard = idx((s) => typeof s.run === 'string' && s.run.includes('scripts/ops/check-active-runs.js'), 'guardia de runs activos');
    const iSsh = idx((s) => s.name === 'Configure SSH', 'Configure SSH');
    const iRsync = idx((s) => typeof s.run === 'string' && /\brsync\b/.test(s.run), 'rsync');
    const iPm2 = idx((s) => typeof s.run === 'string' && /pm2 reload|ensure_pm2_process/.test(s.run), 'reinicio PM2');
    const iOwn = idx((s) => /Fix VPS staging file ownership/.test(s.name), 'ownership');
    assert(iSsh < iGuard && iGuard < iOwn && iGuard < iRsync && iGuard < iPm2, `orden: ssh ${iSsh} guard ${iGuard} own ${iOwn} rsync ${iRsync} pm2 ${iPm2}`);
    const s = steps[iGuard];
    assert(/node - \$FORCE_ARG" < scripts\/ops\/check-active-runs\.js/.test(s.run), 'script por stdin con el arg de force');
    assert(/cd '\$DEPLOY_VPS_PATH_STAGING'/.test(s.run), 'corre en el directorio de staging (su .env y node_modules)');
    assert(!/\|\|\s*true/.test(s.run) && !s['continue-on-error'], 'un fallo aborta el deploy');
    assert(!/\$\{\{/.test(s.run), 'sin expresiones ${{ }} dentro del run (valores por env)');
    eq(s.env.FORCE_DEPLOY, "${{ github.event_name == 'workflow_dispatch' && inputs.force_deploy || 'no' }}", 'force solo por dispatch');
    assert(/FORCE_ARG="--force"/.test(s.run) && /\[ "\$FORCE_DEPLOY" = "yes" \]/.test(s.run), 'force=yes → --force');
    assert(!JSON.stringify(wf.jobs.calibration || {}).includes('check-active-runs'), 'el job de calibración (sin deploy) no la necesita');
  });

  // r61: producción porta la MISMA guardia (detalle en scripts/ci/check-prod-deploy-hardening.js).
  await check('[WF] deploy.yml (producción, r61): primer paso DEPLOY_FREEZE idéntico; check-active-runs por stdin en VPS_PATH (base de producción) antes del rsync y de PM2, con --legacy; sin `|| true`', () => {
    const prod = yaml.load(fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
    const ps = prod.jobs.deploy.steps;
    eq([ps[0].env.DEPLOY_FREEZE, ps[0].env.FORCE_DEPLOY], [steps[0].env.DEPLOY_FREEZE, steps[0].env.FORCE_DEPLOY], 'misma guardia');
    eq(prod.on.workflow_dispatch.inputs.force_deploy, wf.on.workflow_dispatch.inputs.force_deploy, 'mismo input force_deploy');
    const iG = ps.findIndex((x) => typeof x.run === 'string' && x.run.includes('< scripts/ops/check-active-runs.js'));
    const iR = ps.findIndex((x) => typeof x.run === 'string' && /\brsync -az/.test(x.run));
    const iI = ps.findIndex((x) => typeof x.run === 'string' && /prod-release\.sh install/.test(x.run));
    assert(iG > 0 && iG < iR && iR < iI, `orden guardia ${iG} rsync ${iR} install ${iI}`);
    assert(/cd '\$DEPLOY_VPS_PATH' && node - \$LEGACY_ARG \$FORCE_ARG"/.test(ps[iG].run) && !/\|\|\s*true/.test(ps[iG].run), ps[iG].run);
    assert(!/STAGING/.test(ps[iG].run + JSON.stringify(ps[iG].env)), 'nunca el directorio de staging');
  });
}

// ════ [PU] puro ═════════════════════════════════════════════════════════════
function fakeQuery(state) {
  const calls = [];
  const q = async (sql, params) => {
    calls.push(sql);
    assert(!/\b(insert|update|delete|alter|create|drop|truncate)\b/i.test(sql), `solo lectura: ${sql.slice(0, 80)}`);
    if (/to_regclass/.test(sql)) return [{ ok: state.tables.includes(params[0]) }];
    if (/course_full_generation/.test(sql)) {
      const act = (state.legacy || []).filter((r) => params[0].includes(r.worker_status));
      return /count\(\*\)/.test(sql) ? [{ n: act.length }] : act.filter((r) => r.leased);
    }
    if (/dynamic_generation/.test(sql) && /= any\(\$1/.test(sql)) return state.runs.filter((r) => params[0].includes(r.worker_status));
    if (/dynamic_package/.test(sql)) return state.pkgs.filter((r) => params[0].includes(r.worker_status));
    if (/worker_status = 'paused'/.test(sql)) return state.paused;
    if (/lease_until > now\(\)/.test(sql)) return state.claimed;
    if (/count\(\*\)/.test(sql)) return [{ n: state.stale }];
    throw new Error('sql inesperado: ' + sql.slice(0, 80));
  };
  q.calls = calls;
  return q;
}
const ALL_TABLES = ['public.production_jobs', 'public.generation_item_runs'];

async function pureChecks() {
  await check('[PU] decisión: libre 0 · activos 2 · DEPLOY_FREEZE 3 · error 1 (fail closed); --force siempre 0 con veredicto *_forced', () => {
    const idle = { activeRuns: [], claimedItems: [], activePackages: [] };
    const busy = { activeRuns: [{ id: 'r' }], claimedItems: [], activePackages: [] };
    eq([G.decide({ activity: idle }).code, G.decide({ activity: idle }).verdict], [0, 'clear'], 'libre');
    eq(G.decide({ activity: busy }).code, 2, 'run activo');
    eq(G.decide({ activity: { ...idle, claimedItems: [{}] } }).code, 2, 'item reclamado');
    eq(G.decide({ activity: { ...idle, activePackages: [{}] } }).code, 2, 'empaque activo');
    eq(G.decide({ activity: idle, frozen: true }).code, 3, 'congelado aun sin runs');
    eq(G.decide({ activity: null, error: 'ECONNREFUSED' }).code, 1, 'error → fail closed');
    for (const [o, v] of [[{ activity: busy }, 'busy_forced'], [{ activity: idle, frozen: true }, 'frozen_forced'], [{ activity: null, error: 'x' }, 'error_forced']]) {
      eq([G.decide({ ...o, force: true }).code, G.decide({ ...o, force: true }).verdict], [0, v], `force ${v}`);
    }
    eq(G.EXIT, { CLEAR: 0, ERROR: 1, BUSY: 2, FROZEN: 3 }, 'códigos');
  });

  await check('[PU] args y entorno: --json/--force/--env-file/--no-env-file; desconocido lanza; .env solo AGREGA claves (el entorno real gana); DEPLOY_FREEZE solo "true" (sin mayúsculas/espacios)', () => {
    eq(G.parseArgs(['--json', '--force']), { json: true, force: true, envFile: undefined, help: false, legacy: false, legacyBlock: false }, 'flags');
    eq([G.parseArgs(['--legacy']).legacy, G.parseArgs(['--legacy']).legacyBlock], [true, false], '--legacy');
    eq([G.parseArgs(['--legacy-block']).legacy, G.parseArgs(['--legacy-block']).legacyBlock], [true, true], '--legacy-block');
    eq(G.parseArgs(['--no-env-file']).envFile, null, 'sin .env');
    eq(G.parseArgs(['--env-file', '/x/.env']).envFile, '/x/.env', 'ruta');
    let err = null; try { G.parseArgs(['--write']); } catch (e) { err = e; } assert(err && /desconocido/.test(err.message), 'rechaza args desconocidos');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't8-env-'));
    try {
      const p = path.join(tmp, '.env');
      fs.writeFileSync(p, '# c\nDEPLOY_FREEZE="true"\nDB_HOST=db.x.supabase.co\nX=1\n');
      const env = G.mergeEnvFile({ DB_HOST: '127.0.0.1' }, p);
      eq([env.DEPLOY_FREEZE, env.DB_HOST, env.X], ['true', '127.0.0.1', '1'], 'merge');
      eq(G.mergeEnvFile({ A: '1' }, path.join(tmp, 'nope')), { A: '1' }, 'sin archivo');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    eq(['true', ' TRUE ', 'false', '1', '', undefined].map((v) => G.deployFrozen({ DEPLOY_FREEZE: v })), [true, true, false, false, false, false], 'DEPLOY_FREEZE');
  });

  await check('[PU] colecta con query runner inyectable: estados activos exactos; pausados e items con lease vencido solo informan; sin tablas V2 → nada que bloquear (con nota); solo SELECT', async () => {
    eq(G.ACTIVE_RUN_STATUSES, ['queued', 'running', 'retrying', 'waiting_external', 'pausing', 'cancelling'], 'estados de run activos');
    eq(G.ACTIVE_PACKAGE_STATUSES, ['queued', 'running', 'retrying'], 'estados de empaque activos');
    const state = {
      tables: ALL_TABLES,
      runs: [{ id: 'r1', course_id: 7, worker_status: 'running' }, { id: 'r2', course_id: 8, worker_status: 'completed' }],
      pkgs: [{ id: 'p1', run_id: 'r0', worker_status: 'queued' }, { id: 'p2', worker_status: 'failed' }],
      paused: [{ id: 'r3', course_id: 9, worker_status: 'paused', reason: 'stop_after_item' }],
      claimed: [{ id: 'i1', job_id: 'r1', item_key: 'video:x' }],
      stale: 2,
    };
    const q = fakeQuery(state);
    const a = await G.collectActivity(q);
    eq([a.activeRuns.map((r) => r.id), a.activePackages.map((r) => r.id), a.pausedRuns.map((r) => r.id), a.claimedItems.map((r) => r.id), a.staleItems], [['r1'], ['p1'], ['r3'], ['i1'], 2], 'colecta');
    const rep = await G.runGuard({ query: q, env: {} });
    eq([rep.code, rep.verdict], [2, 'busy'], 'activo → busy');
    const idle = await G.runGuard({ query: fakeQuery({ ...state, runs: [], pkgs: [], claimed: [] }), env: {} });
    eq([idle.code, idle.verdict, idle.activity.pausedRuns.length, idle.activity.staleItems], [0, 'clear', 1, 2], 'pausado + lease vencido no bloquean');
    const none = await G.runGuard({ query: fakeQuery({ ...state, tables: [] }), env: {} });
    eq([none.code, none.activity.notes.length > 0], [0, true], 'sin tablas');
    const noGir = await G.collectActivity(fakeQuery({ ...state, tables: ['public.production_jobs'] }));
    eq([noGir.claimedItems.length, noGir.activeRuns.length], [0, 1], 'sin generation_item_runs');
    const boom = await G.runGuard({ query: async () => { throw Object.assign(new Error('fallo postgres://u:secreto@h/db'), {}); }, env: {} });
    eq(boom.code, 1, 'error en la consulta → fail closed');
    assert(!/secreto/.test(boom.error), 'error redactado');
    const frozen = await G.runGuard({ query: fakeQuery({ ...state, runs: [], pkgs: [], claimed: [] }), env: { DEPLOY_FREEZE: 'true' } });
    eq(frozen.code, 3, 'DEPLOY_FREEZE');
  });

  await check('[PU] r61 jobs V1 (--legacy): solo informan por defecto; --legacy-block hace que los que tienen lease vigente bloqueen; sin el flag no se consultan (staging igual)', async () => {
    eq(G.ACTIVE_LEGACY_STATUSES, ['queued', 'running', 'retrying', 'waiting_external'], 'estados V1 activos');
    const state = { tables: ALL_TABLES, runs: [], pkgs: [], paused: [], claimed: [], stale: 0,
      legacy: [{ id: 'l1', course_id: 3, execution_mode: 'backend_audio', worker_status: 'running', leased: true }, { id: 'l2', worker_status: 'queued' }, { id: 'l3', worker_status: 'completed', leased: true }] };
    const plain = fakeQuery(state);
    const r0 = await G.runGuard({ query: plain, env: {} });
    eq([r0.code, r0.activity.legacy, plain.calls.some((c) => /course_full_generation/.test(c))], [0, undefined, false], 'sin flag: ni se consulta');
    const info = await G.runGuard({ query: fakeQuery(state), env: {}, legacy: true });
    eq([info.code, info.verdict, info.activity.legacy.active, info.activity.legacy.leased.map((x) => x.id)], [0, 'clear', 2, ['l1']], '--legacy informa');
    assert(/\(info\) jobs V1 del backend activos: 2 \(con lease vigente: 1\)/.test(G.render(info)) && /job l1 \(curso 3\) backend_audio running/.test(G.render(info)), G.render(info));
    const block = await G.runGuard({ query: fakeQuery(state), env: {}, legacyBlock: true });
    eq([block.code, block.verdict], [2, 'busy'], '--legacy-block bloquea');
    assert(/BLOQUEAN/.test(G.render(block)), 'render bloqueante');
    const forced = await G.runGuard({ query: fakeQuery(state), env: {}, legacyBlock: true, force: true });
    eq([forced.code, forced.verdict], [0, 'busy_forced'], 'force');
    const none = await G.runGuard({ query: fakeQuery({ ...state, legacy: [{ id: 'q', worker_status: 'queued' }] }), env: {}, legacyBlock: true });
    eq(none.code, 0, 'en cola sin lease no bloquea');
  });

  await check('[PU] render: ids, estados y conteos; instrucciones para forzar; nunca emails/títulos', () => {
    const txt = G.render({ verdict: 'busy', frozen: false, activity: { activeRuns: [{ id: 'r1', course_id: 7, worker_status: 'running', title: 'Curso secreto', email: 'a@b.c' }], claimedItems: [], activePackages: [], pausedRuns: [], staleItems: 0, notes: [] } });
    assert(/run r1 \(curso 7\) running/.test(txt) && /force_deploy=yes/.test(txt), txt);
    assert(!/secreto|a@b\.c/.test(txt), 'sin datos sensibles');
  });
}

// ════ [PR] proceso real por stdin ═══════════════════════════════════════════
function runStdin(args, env, cwd) {
  return spawnSync(process.execPath, ['-', ...args], { input: fs.readFileSync(SCRIPT), cwd: cwd || REPO, env: { PATH: process.env.PATH, NODE_PATH: path.join(REPO, 'node_modules'), ...env }, encoding: 'utf8', timeout: 60000 });
}
async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function processChecks() {
  await check('[PR] por stdin (como en el deploy): base inalcanzable → exit 1 (fail closed, deploy abortado); con --force → exit 0 (forzado)', async () => {
    const port = await freePort();
    const env = { DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'x', DB_PASS: 'x', DB_NAME: 'x' };
    let r = runStdin(['--no-env-file'], env);
    assert(r.status === 1 && /deploy freeze guard: error/.test(r.stdout) && /ECONNREFUSED/.test(r.stdout), `fail closed: ${r.status} ${r.stdout}${r.stderr}`);
    r = runStdin(['--no-env-file', '--force'], env);
    assert(r.status === 0 && /error_forced/.test(r.stdout), `force: ${r.status} ${r.stdout}`);
    r = runStdin(['--bogus'], env);
    eq(r.status, 1, 'arg desconocido');
  });
}

// ════ [PG] PG16 desechable ══════════════════════════════════════════════════
function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  return null;
}

async function dbChecks() {
  const pgBin = findPgBin();
  if (!pgBin) {
    console.log('⚠️  Postgres 16 no encontrado (PG_BIN): se omite la parte PG16');
    return;
  }
  const { Client } = require('pg');
  const pg = (bin, args) => spawnSync(path.join(pgBin, bin), args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' });
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-freeze-pg16-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-freeze-cwd-'));
  let started = false;
  let c = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout + (fs.existsSync(path.join(dataDir, 'server.log')) ? fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8').slice(-600) : ''));
    started = true;
    c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    await c.connect();
    await c.query(fs.readFileSync(path.join(REPO, 'scripts/prod/test/fixtures/legacy-baseline.sql'), 'utf8'));
    const PJC = require(path.join(REPO, 'scripts/lib/production-jobs-constraints.js'));
    for (const st of PJC.APPLY_STATEMENTS) await c.query(st);
    // generation_item_runs mínima con las columnas reales que lee la guardia (sin las FKs del esquema completo).
    await c.query(`create table public.generation_item_runs (
      id uuid primary key default gen_random_uuid(), job_id uuid not null references public.production_jobs(id) on delete cascade,
      item_key text not null, status text not null default 'pending', worker_id text, lease_until timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    await c.query(`create role guard_ro login password 'x'; grant usage on schema public to guard_ro; grant select on all tables in schema public to guard_ro;`);
    const env = { DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'guard_ro', DB_PASS: 'x', DB_NAME: 'postgres', DB_SSL: 'false' };
    const ins = async (mode, ws, extra = {}) => (await c.query(
      `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload, output_summary)
       values ('o', $1, $2, $3::text, $3::text, $4::jsonb, $5::jsonb) returning id`,
      [extra.course || 1, mode, ws, JSON.stringify(extra.input || {}), JSON.stringify(extra.out || {})])).rows[0].id;
    const snapshot = async () => JSON.stringify((await c.query(`select (select coalesce(json_agg(p order by p.id), '[]') from public.production_jobs p)::text as a,
      (select coalesce(json_agg(g order by g.id), '[]') from public.generation_item_runs g)::text as b`)).rows[0]);

    await check('[PG] base sin actividad dinámica (solo jobs legacy y runs terminados) → exit 0', async () => {
      await ins('backend_content', 'running');
      await ins('dynamic_generation', 'completed');
      await ins('dynamic_package', 'failed');
      const r = runStdin(['--no-env-file', '--json'], env, cwd);
      const rep = JSON.parse(r.stdout);
      eq([r.status, rep.verdict, rep.activity.activeRuns.length, rep.activity.activePackages.length], [0, 'clear', 0, 0], `libre ${r.stderr}`);
    });

    let RUN = null;
    await check('[PG] run activo + item reclamado + empaque activo → exit 2 con los ids; pausado y lease vencido solo informan; base idéntica (rol de solo SELECT, transacción read only)', async () => {
      RUN = await ins('dynamic_generation', 'running', { course: 42 });
      const paused = await ins('dynamic_generation', 'paused', { course: 43, out: { pause: { reason: 'stop_after_item' } } });
      const pkg = await ins('dynamic_package', 'queued', { course: 44, input: { runId: paused } });
      await c.query(`insert into public.generation_item_runs (job_id, item_key, status, worker_id, lease_until) values
        ($1, 'video:a', 'running', 'w1', now() + interval '5 minutes'), ($1, 'content:b', 'running', 'w2', now() - interval '1 hour'), ($1, 'content:c', 'completed', null, null)`, [RUN]);
      const before = await snapshot();
      const r = runStdin(['--no-env-file', '--json'], env, cwd);
      const rep = JSON.parse(r.stdout);
      eq([r.status, rep.verdict], [2, 'busy'], `busy ${r.stderr}`);
      eq([rep.activity.activeRuns.map((x) => x.id), rep.activity.claimedItems.map((x) => x.item_key), rep.activity.activePackages.map((x) => x.id)], [[RUN], ['video:a'], [pkg]], 'ids');
      eq([rep.activity.pausedRuns.map((x) => [x.id, x.reason]), rep.activity.staleItems], [[[paused, 'stop_after_item']], 1], 'info');
      const txt = runStdin(['--no-env-file'], env, cwd);
      assert(txt.status === 2 && /deploy ABORTADO/.test(txt.stdout) && txt.stdout.includes(RUN), txt.stdout);
      eq(await snapshot(), before, 'la base queda idéntica');
      const forced = runStdin(['--no-env-file', '--force'], env, cwd);
      assert(forced.status === 0 && /busy_forced/.test(forced.stdout), forced.stdout);
      await c.query(`update public.production_jobs set worker_status = 'completed', status = 'completed' where id = any($1::uuid[])`, [[pkg]]);
    });

    await check('[PG] cada condición bloquea sola: solo el item reclamado; solo un run en cola (queued/pausing/cancelling); cancelado no bloquea', async () => {
      await c.query(`update public.production_jobs set worker_status = 'completed', status = 'completed' where id = $1`, [RUN]);
      let r = runStdin(['--no-env-file', '--json'], env, cwd);
      eq([r.status, JSON.parse(r.stdout).activity.claimedItems.length], [2, 1], 'solo el item reclamado bloquea');
      await c.query(`update public.generation_item_runs set status = 'completed', lease_until = null`);
      r = runStdin(['--no-env-file'], env, cwd);
      eq(r.status, 0, 'libre');
      for (const ws of ['queued', 'pausing', 'cancelling', 'waiting_external', 'retrying']) {
        const id = await ins('dynamic_generation', ws);
        eq(runStdin(['--no-env-file'], env, cwd).status, 2, `run ${ws} bloquea`);
        await c.query(`update public.production_jobs set worker_status = 'cancelled', status = 'cancelled' where id = $1`, [id]);
      }
      eq(runStdin(['--no-env-file'], env, cwd).status, 0, 'cancelados no bloquean');
    });

    await check('[PG] DEPLOY_FREEZE=true en el .env del directorio (el .env del VPS) → exit 3 aun sin runs; el entorno real puede traer DB_*; --force → 0', async () => {
      fs.writeFileSync(path.join(cwd, '.env'), 'DEPLOY_FREEZE=true\n');
      let r = runStdin([], env, cwd);
      assert(r.status === 3 && /DEPLOY_FREEZE=true/.test(r.stdout), `frozen: ${r.status} ${r.stdout}${r.stderr}`);
      r = runStdin(['--force'], env, cwd);
      eq(r.status, 0, 'forzado');
      r = runStdin(['--no-env-file'], env, cwd);
      eq(r.status, 0, '--no-env-file ignora el .env');
      fs.writeFileSync(path.join(cwd, '.env'), `DB_HOST=127.0.0.1\nDB_PORT=${port}\nDB_USER=guard_ro\nDB_PASS=x\nDB_NAME=postgres\n`);
      r = runStdin([], {}, cwd);
      eq(r.status, 0, 'conexión desde el .env del cwd (como en el VPS)');
    });

    await check('[PG] r61 --legacy / --legacy-block contra PG16: job V1 con lease vigente informa (0) o bloquea (2); sin lease o terminado no; base idéntica', async () => {
      const id = await ins('backend_audio', 'running', { course: 77 });
      await c.query(`update public.production_jobs set lease_until = now() + interval '5 minutes' where id = $1`, [id]);
      await ins('backend_gamma', 'queued', { course: 78 });
      const before = await snapshot();
      let r = runStdin(['--no-env-file', '--json', '--legacy'], env, cwd);
      const rep = JSON.parse(r.stdout);
      eq([r.status, rep.activity.legacy.active >= 2, rep.activity.legacy.leased.map((x) => x.id)], [0, true, [id]], `info ${r.stderr}`);
      r = runStdin(['--no-env-file', '--legacy-block'], env, cwd);
      assert(r.status === 2 && /BLOQUEAN/.test(r.stdout) && r.stdout.includes(id), r.stdout);
      eq(await snapshot(), before, 'la guardia no escribe (base idéntica)');
      await c.query(`update public.production_jobs set lease_until = now() - interval '1 minute' where id = $1`, [id]);
      eq(runStdin(['--no-env-file', '--legacy-block'], env, cwd).status, 0, 'lease vencido no bloquea');
      eq(runStdin(['--no-env-file'], env, cwd).status, 0, 'sin flag (staging) no cambia');
      await c.query(`update public.production_jobs set lease_until = now() + interval '5 minutes' where id = $1`, [id]);
      await c.query(`update public.production_jobs set worker_status = 'completed', status = 'completed', lease_until = null where execution_mode like 'backend\\_%'`);
      eq(runStdin(['--no-env-file', '--legacy-block'], env, cwd).status, 0, 'terminados no bloquean');
    });
  } finally {
    try { if (c) await c.end(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

(async () => {
  await workflowChecks();
  await pureChecks();
  await processChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})();
