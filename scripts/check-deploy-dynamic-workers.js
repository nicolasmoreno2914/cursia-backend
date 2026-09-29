#!/usr/bin/env node
/* eslint-disable */
// HD-6 (decisión del owner, pre-aceptación V2) — los workers dinámicos
// (dynamic-item-worker, dynamic-package-worker) corren en PRODUCCIÓN bajo PM2
// igual que los demás workers, y son inofensivos mientras
// DYNAMIC_COURSE_STRUCTURE no sea exactamente 'true'.
//
// (a) Workflows (estático, sin red salvo un `git fetch` de origin/main si falta):
//     - deploy.yml y deploy-staging.yml arrancan/recargan AMBOS workers con
//       ensure_pm2_process (pm2 restart --update-env | pm2 start npm -- run
//       <script>) en el MISMO step y el mismo bloque que los demás workers;
//       nombres: cursia-dynamic-{item,package}-worker (+ -staging en staging).
//     - deploy.yml == deploy.yml de origin/main + EXACTAMENTE las 2 líneas de
//       los workers (nada más cambió). Base configurable con
//       DEPLOY_YML_BASE_REF (default origin/main). Si la base ya las contiene
//       (post-merge), la comparación es por identidad.
//     - El script remoto (entre comillas simples) de ambos steps de deploy
//       parsea con `bash -n` (una comilla simple suelta lo cortaría).
//     - Staging: el bloque [0b] de flags es idempotente y solo imprime nombres
//       de clave (se ejecuta de verdad contra un .env temporal, dos veces).
// (b) Workers COMPILADOS (dist/) como procesos hijos contra un Postgres FALSO
//     (servidor TCP que habla el protocolo de wire mínimo y registra queries):
//     - flag ausente / 'false': log claro, vivo e inactivo, 0 conexiones, 0
//       queries (0 claims), SIGTERM → exit 0.
//     - flag 'true': conecta y ejecuta SU query de claim (item: candidato de
//       generation_item_runs de runs dynamic_generation; package: production_jobs
//       FOR UPDATE OF j SKIP LOCKED) contra la DB falsa (sin filas → idle),
//       SIGTERM → exit 0.
//
// Usage: node scripts/check-deploy-dynamic-workers.js [path/to/dist]

const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const PROD_WF = '.github/workflows/deploy.yml';
const STAGING_WF = '.github/workflows/deploy-staging.yml';
// `claim`: la query con la que cada worker intenta reclamar trabajo (SchedulerService.claimNextItem
// global: candidato de generation_item_runs de runs dynamic_generation activos; dynamic-package-worker:
// production_jobs FOR UPDATE SKIP LOCKED).
const WORKERS = [
  {
    script: 'dynamic-item-worker.js', npm: 'start:dynamic-item-worker', pm2: 'cursia-dynamic-item-worker',
    claim: (q) => /from public\.generation_item_runs g/.test(q) && /pj\.execution_mode = 'dynamic_generation'/.test(q),
  },
  {
    script: 'dynamic-package-worker.js', npm: 'start:dynamic-package-worker', pm2: 'cursia-dynamic-package-worker',
    claim: (q) => /for update of j skip locked/i.test(q),
  },
  // V2.1 RF-b: worker de proveedores v3 (presentation / audio_*), mismo claim global del scheduler.
  {
    script: 'dynamic-provider-worker.js', npm: 'start:dynamic-provider-worker', pm2: 'cursia-dynamic-provider-worker',
    claim: (q) => /from public\.generation_item_runs g/.test(q) && /pj\.execution_mode = 'dynamic_generation'/.test(q),
    // Calibración #2: además de DYNAMIC_COURSE_STRUCTURE, reclama solo con su propio flag encendido.
    onEnv: { DYNAMIC_PROVIDER_WORKER_ENABLED: 'true' },
  },
];
const PROD_ADDED_LINES = WORKERS.map((w) => `               ensure_pm2_process ${w.pm2} ${w.npm}`);
const OWNER = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
const IPV4_RE = /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Workflows
// ─────────────────────────────────────────────────────────────────────────────
function readWf(rel) { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); }

/** Steps de un workflow: [{ name, text }] (bloques "      - name:" del único job). */
function stepsOf(text) {
  const lines = text.split('\n');
  const steps = [];
  let cur = null;
  for (const line of lines) {
    const m = /^      - name: (.*)$/.exec(line);
    if (m) { cur = { name: m[1].trim(), lines: [line] }; steps.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return steps.map((s) => ({ name: s.name, text: s.lines.join('\n') }));
}

/** El script remoto de un step "ssh … '<script>'" con los secrets reemplazados por un placeholder. */
function remoteScriptOf(stepText) {
  const start = stepText.indexOf("'set -e");
  assert(start >= 0, "no se encontró el script remoto ('set -e …') en el step");
  const end = stepText.lastIndexOf("'");
  assert(end > start, 'script remoto sin comilla de cierre');
  let body = stepText.slice(start + 1, end);
  // `'"${{ secrets.X }}"'` = cerrar comilla, secret, reabrir → placeholder de ruta.
  body = body.replace(/'"\$\{\{ secrets\.[A-Z_]+ \}\}"'/g, '/tmp/vps-path');
  assert(!body.includes("'"), 'el script remoto contiene una comilla simple suelta (cortaría el string de ssh)');
  // Quitar la indentación YAML (15 espacios en ambos workflows).
  return body.split('\n').map((l) => l.replace(/^ {15}/, '')).join('\n');
}

function pm2StepOf(text, wfName) {
  const steps = stepsOf(text).filter((s) => /ensure_pm2_process\s+cursia-/.test(s.text));
  eq(steps.length, 1, `${wfName}: steps que arrancan procesos PM2`);
  return steps[0];
}

function assertWorkersInStep(step, suffix, wfName) {
  const script = remoteScriptOf(step.text);
  // Definición de ensure_pm2_process: restart --update-env si existe, si no pm2 start npm -- run <script>.
  const def = /ensure_pm2_process\(\) \{([\s\S]*?)\n\}/.exec(script);
  assert(def, `${wfName}: falta la definición de ensure_pm2_process() en el step "${step.name}"`);
  assert(/sudo pm2 describe "\$name"/.test(def[1]), `${wfName}: ensure_pm2_process no usa pm2 describe`);
  assert(/sudo pm2 restart "\$name" --update-env/.test(def[1]), `${wfName}: ensure_pm2_process no recarga con --update-env`);
  assert(/sudo pm2 start npm --name "\$name" -- run "\$start_script"/.test(def[1]), `${wfName}: ensure_pm2_process no arranca con pm2 start npm -- run`);
  const calls = script.split('\n').filter((l) => /^ensure_pm2_process /.test(l));
  const fullIdx = calls.indexOf(`ensure_pm2_process cursia-full-worker${suffix} start:full-worker`);
  assert(fullIdx >= 0, `${wfName}: no se encontró el full-worker (referencia del bloque de workers)`);
  for (const w of WORKERS) {
    const want = `ensure_pm2_process ${w.pm2}${suffix} ${w.npm}`;
    eq(calls.filter((c) => c === want).length, 1, `${wfName}: "${want}" (una sola vez)`);
    assert(calls.indexOf(want) > fullIdx, `${wfName}: "${want}" debe ir en el bloque de workers, después del full-worker`);
  }
  // Mismo bloque: justo antes de `pm2 save` (se guardan con el resto).
  const lines = script.split('\n');
  const saveIdx = lines.indexOf('sudo pm2 save');
  assert(saveIdx > 0, `${wfName}: falta sudo pm2 save`);
  for (const w of WORKERS) {
    const i = lines.indexOf(`ensure_pm2_process ${w.pm2}${suffix} ${w.npm}`);
    assert(i >= 0 && i < saveIdx, `${wfName}: ${w.pm2}${suffix} debe arrancarse antes de "sudo pm2 save"`);
  }
  // Nombres PM2 coherentes: sin sufijo en prod, todos con -staging en staging.
  for (const c of calls) {
    const name = c.split(/\s+/)[1];
    if (suffix) assert(name.endsWith('-staging'), `${wfName}: ${name} sin sufijo -staging`);
    else assert(!/staging/.test(name), `${wfName}: ${name} con sufijo de staging en producción`);
  }
  // Los scripts npm existen y apuntan al worker compilado.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const w of WORKERS) eq(pkg.scripts[w.npm], `node dist/workers/${w.script}`, `package.json ${w.npm}`);
  return script;
}

function bashSyntaxOk(script, label) {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert(r.status === 0, `${label}: bash -n falló:\n${r.stderr}`);
}

function gitShow(ref, rel) {
  return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function baseDeployYml() {
  const ref = process.env.DEPLOY_YML_BASE_REF || 'origin/main';
  try {
    return { ref, text: gitShow(ref, PROD_WF) };
  } catch (e) {
    if (ref !== 'origin/main') throw new Error(`no se pudo leer ${PROD_WF} en ${ref}: ${e.message}`);
    // Checkout superficial de CI: traer solo main.
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ref, text: gitShow(ref, PROD_WF) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres falso (protocolo de wire mínimo) — registra conexiones y queries
// ─────────────────────────────────────────────────────────────────────────────
function msg(type, body) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), len, body]);
}
const cstr = (s) => Buffer.from(s + '\0');
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function rowDescription(names) {
  const parts = [int16(names.length)];
  for (const n of names) parts.push(cstr(n), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0));
  return msg('T', Buffer.concat(parts));
}
function dataRow(values) {
  const parts = [int16(values.length)];
  for (const v of values) { const b = Buffer.from(String(v)); parts.push(int32(b.length), b); }
  return msg('D', Buffer.concat(parts));
}
/** Filas sintéticas para las pocas queries de arranque que las necesitan (versión del server). */
function syntheticRows(sql) {
  const q = sql.trim().replace(/;$/, '');
  const show = /^show\s+([a-z_]+)$/i.exec(q);
  if (show) {
    const key = show[1].toLowerCase();
    const val = key === 'server_version' ? '16.4' : key === 'search_path' ? 'public' : 'on';
    return { cols: [key], rows: [[val]] };
  }
  if (/^select\s+version\(\)/i.test(q)) return { cols: ['version'], rows: [['PostgreSQL 16.4 (fake)']] };
  if (/current_schema\(\)/i.test(q)) return { cols: ['current_schema'], rows: [['public']] };
  if (/current_database\(\)/i.test(q)) return { cols: ['current_database'], rows: [['fake']] };
  return null;
}
function tagOf(sql) {
  const w = (sql.trim().split(/\s+/)[0] || '').toUpperCase();
  if (w === 'SELECT' || w === 'WITH' || w === 'SHOW') return 'SELECT 0';
  if (w === 'INSERT') return 'INSERT 0 0';
  if (w === 'UPDATE' || w === 'DELETE') return `${w} 0`;
  return w || 'EMPTY';
}

/** ErrorResponse de Postgres (42P01 = undefined_table). */
function errorResponse(code, message) {
  return msg('E', Buffer.concat([
    Buffer.from('S'), cstr('ERROR'), Buffer.from('V'), cstr('ERROR'),
    Buffer.from('C'), cstr(code), Buffer.from('M'), cstr(message), Buffer.from([0]),
  ]));
}

/** `failRelation(sql)` → nombre de relación a reportar como inexistente (42P01), o null. */
async function startFakePg({ failRelation } = {}) {
  const state = { connections: 0, queries: [], failed: 0 };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    state.connections++;
    sockets.add(sock);
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let started = false;
    let lastParsed = '';
    let inError = false;
    const results = (sql) => {
      const syn = syntheticRows(sql);
      if (!syn) return [msg('C', cstr(tagOf(sql)))];
      return [...syn.rows.map(dataRow), msg('C', cstr(`SELECT ${syn.rows.length}`))];
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) { sock.write('N'); continue; } // SSLRequest → sin SSL
          started = true;
          sock.write(Buffer.concat([
            msg('R', int32(0)),
            msg('S', Buffer.concat([cstr('server_version'), cstr('16.4')])),
            msg('S', Buffer.concat([cstr('client_encoding'), cstr('UTF8')])),
            msg('K', Buffer.concat([int32(4242), int32(1)])),
            msg('Z', Buffer.from('I')),
          ]));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === 'Q') {
          const sql = body.toString('utf8').replace(/\0$/, '');
          state.queries.push(sql);
          const rel = failRelation && failRelation(sql);
          if (rel) {
            state.failed++;
            sock.write(Buffer.concat([errorResponse('42P01', `relation "${rel}" does not exist`), msg('Z', Buffer.from('I'))]));
            continue;
          }
          const syn = syntheticRows(sql);
          const out = syn ? [rowDescription(syn.cols)] : [];
          sock.write(Buffer.concat([...out, ...results(sql), msg('Z', Buffer.from('I'))]));
        } else if (type === 'P') {
          const nameEnd = body.indexOf(0);
          const qEnd = body.indexOf(0, nameEnd + 1);
          lastParsed = body.subarray(nameEnd + 1, qEnd).toString('utf8');
          state.queries.push(lastParsed);
          const rel = failRelation && failRelation(lastParsed);
          if (rel) {
            // Como Postgres real: error en Parse y se descarta todo hasta Sync.
            state.failed++;
            inError = true;
            sock.write(errorResponse('42P01', `relation "${rel}" does not exist`));
            continue;
          }
          sock.write(msg('1', Buffer.alloc(0)));
        } else if (inError && type !== 'S' && type !== 'X') {
          continue;
        } else if (type === 'B') {
          sock.write(msg('2', Buffer.alloc(0)));
        } else if (type === 'D') {
          const syn = syntheticRows(lastParsed);
          sock.write(syn ? rowDescription(syn.cols) : msg('n', Buffer.alloc(0)));
        } else if (type === 'E') {
          sock.write(Buffer.concat(results(lastParsed)));
        } else if (type === 'S') {
          inError = false;
          sock.write(msg('Z', Buffer.from('I')));
        } else if (type === 'C') {
          sock.write(msg('3', Buffer.alloc(0)));
        } else if (type === 'X') {
          sock.end();
          return;
        }
        // 'H' (Flush) y otros: sin respuesta.
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    port: server.address().port,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

async function runWorker(script, env, { waitMs, until, failRelation } = {}) {
  const pg = await startFakePg({ failRelation });
  const childEnv = {
    ...process.env,
    ...env,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(pg.port),
    DB_SSL: 'false',
    NODE_ENV: 'production',
  };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  // cwd temporal: el ConfigModule no debe leer ningún .env del repo.
  const child = spawn(process.execPath, [path.join(distRoot, 'workers', script)], {
    cwd: os.tmpdir(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exited = null;
  const exitP = new Promise((r) => child.on('exit', (code, signal) => { exited = { code, signal }; r(exited); }));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && exited === null) {
    if (until && until(pg.state)) break;
    await sleep(100);
  }
  if (!until) await sleep(Math.max(0, deadline - Date.now()));
  const aliveAfterWait = exited === null;
  const snapshot = { connections: pg.state.connections, queries: pg.state.queries.slice(), failed: pg.state.failed };
  let termExit = exited;
  if (aliveAfterWait) {
    child.kill('SIGTERM');
    termExit = await Promise.race([exitP, sleep(10000).then(() => null)]);
    if (!termExit) { child.kill('SIGKILL'); await exitP; }
  }
  pg.close();
  return { output, aliveAfterWait, ...snapshot, termExit };
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const prodText = readWf(PROD_WF);
  const stagingText = readWf(STAGING_WF);

  await check('(a) deploy.yml: arranca/recarga cursia-dynamic-{item,package,provider}-worker con PM2 en el step de los workers', () => {
    const step = pm2StepOf(prodText, 'deploy.yml');
    const script = assertWorkersInStep(step, '', 'deploy.yml');
    bashSyntaxOk(script, 'deploy.yml (script remoto)');
  });

  await check('(a) deploy-staging.yml: arranca/recarga los 3 workers dinámicos -staging con PM2 en el step de los workers', () => {
    const step = pm2StepOf(stagingText, 'deploy-staging.yml');
    const script = assertWorkersInStep(step, '-staging', 'deploy-staging.yml');
    bashSyntaxOk(script, 'deploy-staging.yml (script remoto)');
  });

  await check(`(a) deploy.yml = base (origin/main) + EXACTAMENTE las ${PROD_ADDED_LINES.length} líneas de los workers dinámicos (ningún otro step cambió)`, () => {
    const { ref, text: base } = baseDeployYml();
    const cur = prodText.split('\n');
    // M6 (integral-review): el único otro cambio permitido es quitar IPs de los
    // COMENTARIOS (placeholder <VPS_HOST>); el host real sale del secret VPS_HOST.
    const baseLines = base.split('\n').map((l) => (/^\s*#/.test(l) ? l.replace(IPV4_RE, '<VPS_HOST>') : l));
    const baseHas = PROD_ADDED_LINES.every((l) => baseLines.includes(l));
    if (baseHas) {
      eq(cur.join('\n') === baseLines.join('\n'), true, `deploy.yml difiere de ${ref} (que ya incluye los workers)`);
      return;
    }
    // V2.1 RF-b: la base puede traer ya un subconjunto de los workers (p.ej. item +
    // package tras su merge): se quitan de la base y se re-insertan TODOS, en
    // orden, justo después del full-worker.
    const anchor = '               ensure_pm2_process cursia-full-worker start:full-worker';
    const baseRest = baseLines.filter((l) => !PROD_ADDED_LINES.includes(l));
    const idx = baseRest.indexOf(anchor);
    assert(idx >= 0, `${ref}: no se encontró la línea del full-worker (ancla)`);
    const expected = [...baseRest.slice(0, idx + 1), ...PROD_ADDED_LINES, ...baseRest.slice(idx + 1)];
    if (cur.join('\n') !== expected.join('\n')) {
      const diffAt = cur.findIndex((l, i) => l !== expected[i]);
      throw new Error(
        `deploy.yml no es ${ref} + las ${PROD_ADDED_LINES.length} líneas esperadas (primera diferencia en la línea ${diffAt + 1}: ` +
          `got ${JSON.stringify(cur[diffAt])}, want ${JSON.stringify(expected[diffAt])})`,
      );
    }
  });

  await check('(M6) deploy.yml / deploy-staging.yml sin IPs públicas versionadas (el host viene del secret VPS_HOST)', () => {
    for (const [name, text] of [['deploy.yml', prodText], ['deploy-staging.yml', stagingText]]) {
      const hits = text.split('\n').filter((l) => { IPV4_RE.lastIndex = 0; return IPV4_RE.test(l); });
      eq(hits, [], `${name}: líneas con IPv4`);
    }
  });

  await check('(a) deploy-staging.yml [0b]: flags V2 idempotentes (rules v3 exacto), nunca imprime KEY=VALUE ni toca los proveedores', () => {
    const script = remoteScriptOf(pm2StepOf(stagingText, 'deploy-staging.yml').text);
    const lines = script.split('\n');
    const fnStart = lines.findIndex((l) => l.startsWith('_Q_CR='));
    const fnEnd = lines.findIndex((l) => l.startsWith('ensure_pm2_process() {'));
    const flagsStart = lines.findIndex((l) => l.startsWith('echo "━━━ [0b]'));
    const flagsEnd = lines.findIndex((l) => l.startsWith('echo "━━━ [1/6]'));
    assert(fnStart >= 0 && fnEnd > fnStart && flagsStart > fnEnd && flagsEnd > flagsStart, 'no se pudo aislar el bloque de flags');
    const block = [...lines.slice(fnStart, fnEnd), ...lines.slice(flagsStart, flagsEnd)].join('\n');
    for (const needle of [
      `ensure_env_list_contains DYNAMIC_V2_ALLOWED_OWNERS ${OWNER}`,
      `ensure_env_list_contains DYNAMIC_REAL_VIDEO_OWNERS ${OWNER}`,
      'ensure_env_default_if_absent DYNAMIC_VIDEO_DELIVERY youtube',
      // Aceptación rv3 (autorizado por Nicolás): valor EXACTO 3, no solo default.
      'ensure_env_exact DYNAMIC_MANIFEST_RULES_VERSION 3',
      'ensure_env_flag_true DYNAMIC_COURSE_STRUCTURE',
    ]) assert(block.includes(needle), `falta: ${needle}`);
    assert(!/(ensure_\w+|printf[^\n]*>>\s*\.env)[^\n]*DYNAMIC_COHERENCE_LLM/.test(block), 'DYNAMIC_COHERENCE_LLM no debe escribirse');
    // 2026-09-29 (autorizado por Nicolás): staging queda operativo, el deploy deja el worker ENCENDIDO.
    assert(!/DYNAMIC_PROVIDER_WORKER_ENABLED\s+false/.test(block), 'el deploy de staging ya no apaga el worker');
    assert(block.includes('ensure_env_exact DYNAMIC_PROVIDER_WORKER_ENABLED true'), 'el deploy lo deja explícitamente en true');
    const SECRET = 'valor-secreto-no-imprimir-123';
    const scenarios = [
      { label: '.env mínimo', env: `NODE_ENV=production\nSUPABASE_SERVICE_KEY=${SECRET}\n` },
      {
        label: '.env con valores manuales',
        env: `NODE_ENV=production\nSUPABASE_SERVICE_KEY=${SECRET}\nDYNAMIC_V2_ALLOWED_OWNERS=11111111-2222-4333-8444-555555555555\nDYNAMIC_VIDEO_DELIVERY=videogen_direct\nDYNAMIC_MANIFEST_RULES_VERSION=1\n`,
      },
    ];
    for (const sc of scenarios) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd6-env-'));
      try {
        fs.writeFileSync(path.join(dir, '.env'), sc.env);
        const run = () => spawnSync('bash', ['-c', `set -e\n${block}`], { cwd: dir, encoding: 'utf8' });
        const r1 = run();
        assert(r1.status === 0, `${sc.label}: bloque falló: ${r1.stderr}`);
        const after1 = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        const r2 = run();
        assert(r2.status === 0, `${sc.label}: 2ª corrida falló: ${r2.stderr}`);
        const after2 = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        eq(after2, after1, `${sc.label}: no idempotente`);
        for (const out of [r1.stdout + r1.stderr, r2.stdout + r2.stderr]) {
          assert(!out.includes(SECRET), `${sc.label}: imprimió un valor del .env`);
          assert(!/=/.test(out.replace(/^.*━━━.*$/gm, '')), `${sc.label}: imprimió un KEY=VALUE:\n${out}`);
        }
        const kv = Object.fromEntries(after2.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
        eq(kv.DYNAMIC_COURSE_STRUCTURE, 'true', `${sc.label}: DYNAMIC_COURSE_STRUCTURE`);
        assert(kv.DYNAMIC_V2_ALLOWED_OWNERS.split(',').includes(OWNER), `${sc.label}: DYNAMIC_V2_ALLOWED_OWNERS sin el owner`);
        assert(kv.DYNAMIC_REAL_VIDEO_OWNERS.split(',').includes(OWNER), `${sc.label}: DYNAMIC_REAL_VIDEO_OWNERS sin el owner`);
        assert(!('DYNAMIC_COHERENCE_LLM' in kv), `${sc.label}: DYNAMIC_COHERENCE_LLM se agregó`);
        eq(kv.SUPABASE_SERVICE_KEY, SECRET, `${sc.label}: otra clave alterada`);
        if (sc.label === '.env mínimo') {
          eq(kv.DYNAMIC_VIDEO_DELIVERY, 'youtube', 'default DYNAMIC_VIDEO_DELIVERY');
          eq(kv.DYNAMIC_MANIFEST_RULES_VERSION, '3', 'DYNAMIC_MANIFEST_RULES_VERSION agregado en 3');
        } else {
          eq(kv.DYNAMIC_VIDEO_DELIVERY, 'videogen_direct', 'valor manual respetado');
          eq(kv.DYNAMIC_MANIFEST_RULES_VERSION, '3', 'rv3: el valor anterior (1) se reemplaza por 3');
          assert(fs.existsSync(path.join(dir, '.env.bak')), 'backup del .env');
          eq(kv.DYNAMIC_V2_ALLOWED_OWNERS, `11111111-2222-4333-8444-555555555555,${OWNER}`, 'lista extendida (no reemplazada)');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // V2.1: FinOps + proveedores de STAGING. Aislamiento fuerte (decisión de Nicolás): el deploy de staging
  // nunca lee el .env de producción, nunca copia claves desde producción ni imprime fragmentos de secretos.
  await check('(a) deploy-staging.yml [0c]: aislamiento — sin .env de producción, sin VPS_PATH de producción, sin copiar claves ni imprimir fragmentos', () => {
    const step = pm2StepOf(stagingText, 'deploy-staging.yml').text;
    assert(!/secrets\.VPS_PATH\s*\}\}/.test(stagingText), 'el workflow de staging no debe usar secrets.VPS_PATH (producción)');
    for (const re of [/PROD_ENV_FILE/, /reuse_from_production/, /inventory_production/, /_mask\b/, /sudo -n grep/, /\$\{v: -4\}/]) {
      assert(!re.test(step), `lógica de producción/fragmentos presente: ${re}`);
    }
  });

  await check('(a) deploy-staging.yml [0c]: FinOps token por stdin (nunca impreso), worker de proveedores en true, idempotente, solo .env de staging', () => {
    const script = remoteScriptOf(pm2StepOf(stagingText, 'deploy-staging.yml').text);
    const lines = script.split('\n');
    const fnStart = lines.findIndex((l) => l.startsWith('_Q_CR='));
    const fnEnd = lines.findIndex((l) => l.startsWith('ensure_pm2_process() {'));
    const flagsStart = lines.findIndex((l) => l.startsWith('echo "━━━ [0b]'));
    const flagsEnd = lines.findIndex((l) => l.startsWith('echo "━━━ [1/6]'));
    const block = [...lines.slice(fnStart, fnEnd), ...lines.slice(flagsStart, flagsEnd)].join('\n');
    assert(/IFS= read -r _FIT/.test(script), 'el token se lee de stdin');
    assert(/printf "%s\\n" "\$FINOPS_INGEST_TOKEN_STAGING" \| ssh/.test(stagingText), 'el token viaja por stdin del ssh');
    const TOKEN = 'finops-token-SECRET-6666';
    const STG = { VG: 'vg-staging-SECRET-4444', DB: 'db-pass-SECRET-7777' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v21-provcfg-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), `NODE_ENV=production\nDB_PASS=${STG.DB}\nVIDEOGEN_API_KEY=${STG.VG}\nDYNAMIC_PROVIDER_WORKER_ENABLED=true\n`);
      const run = (fit) => spawnSync('bash', ['-c', `set -e\n_FIT=${fit}\n${block}`], { cwd: dir, encoding: 'utf8' });
      const r1 = run(TOKEN);
      assert(r1.status === 0, `bloque falló: ${r1.stderr}`);
      const out = r1.stdout + r1.stderr;
      for (const v of [TOKEN, STG.VG, STG.DB]) assert(!out.includes(v), `imprimió un secreto: ${v}`);
      assert(!/=/.test(out.replace(/^.*━━━.*$/gm, '')), `imprimió un KEY=VALUE:\n${out}`);
      const kv = Object.fromEntries(fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      eq(kv.FINOPS_INGEST_TOKEN, TOKEN, 'token escrito');
      eq(kv.DYNAMIC_PROVIDER_WORKER_ENABLED, 'true', 'worker de proveedores encendido');
      eq(kv.VIDEOGEN_API_KEY, STG.VG, 'claves de staging intactas');
      for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GAMMA_API_KEY']) assert(!(k in kv), `no debe agregar ${k}`);
      eq([kv.GAMMA_THEME_V21_LIGHT_DEFAULT, kv.GAMMA_THEME_V21_DARK_DEFAULT], ['default-light', 'default-dark'], 'temas Gamma por defecto');
      const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      const r2 = run(TOKEN);
      assert(r2.status === 0, r2.stderr);
      eq(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, 'idempotente');
      const r3 = run('');
      assert(r3.status === 0 && /FINOPS_INGEST_TOKEN: sin valor/.test(r3.stdout), 'sin secret de GitHub: no toca el token');
      eq(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, 'sin secret: .env igual');
      // Un tema puesto a mano no se pisa.
      fs.writeFileSync(path.join(dir, '.env'), before.replace('GAMMA_THEME_V21_LIGHT_DEFAULT=default-light', 'GAMMA_THEME_V21_LIGHT_DEFAULT=manual-theme'));
      assert(run(TOKEN).status === 0, 'corrida con tema manual');
      assert(/GAMMA_THEME_V21_LIGHT_DEFAULT=manual-theme/.test(fs.readFileSync(path.join(dir, '.env'), 'utf8')), 'tema manual respetado');
      // Aunque alguien lo haya apagado (worker_off), un deploy lo vuelve a true (una sola línea).
      fs.writeFileSync(path.join(dir, '.env'), fs.readFileSync(path.join(dir, '.env'), 'utf8').replace(/^DYNAMIC_PROVIDER_WORKER_ENABLED=.*$/m, 'DYNAMIC_PROVIDER_WORKER_ENABLED=false'));
      assert(run(TOKEN).status === 0, 'deploy con worker apagado');
      eq((fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/^DYNAMIC_PROVIDER_WORKER_ENABLED=(.*)$/m) || [])[1], 'true', 'deploy → worker true');
      eq((fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/^DYNAMIC_PROVIDER_WORKER_ENABLED=/gm) || []).length, 1, 'una sola línea del flag');
      const kv2 = Object.fromEntries(fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      eq([kv2.DB_POOL_MAX, kv2.DB_POOL_MAX_WORKER, kv2.DB_POOL_IDLE_MS_WORKER], ['2', '1', '1000'], 'pool de staging (EMAXCONNSESSION)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('deploy-staging.yml job `calibration`: plano de control SIN deploy (sin rsync / npm / migraciones / reinicio de los 11); inputs validados en el runner y por stdin; worker_on/off reinicia SOLO API + worker de proveedores; el job de deploy no corre en un dispatch de calibración', () => {
    const noComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const all = noComments(stagingText);
    const calText = all.slice(all.indexOf('\n  calibration:\n'));
    const deployJob = all.slice(all.indexOf('\n  deploy:\n'), all.indexOf('\n  calibration:\n'));
    assert(calText.length > 100 && deployJob.length > 100, 'dos jobs: deploy y calibration');
    assert(/^\s*group: deploy-staging\s*$/m.test(all), 'grupo de concurrencia único (deploy y calibración nunca a la vez)');
    assert(/if: github\.event_name == 'workflow_dispatch' && inputs\.calibration_action != 'none'/.test(calText), 'calibration solo en dispatch con acción');
    assert(/if: github\.event_name == 'push' \|\| inputs\.calibration_action == 'none'/.test(deployJob), 'deploy solo en push o dispatch none');
    assert(/environment: staging/.test(calText) && !/secrets\.VPS_PATH\s*\}\}/.test(all), 'solo staging');
    for (const bad of [/rsync/, /npm (ci|install)/, /migrate-/, /ensure_pm2_process/, /pm2 restart all/, /npm run build/]) assert(!bad.test(calText), `el job calibration no despliega: ${bad}`);
    const restarts = [...calText.matchAll(/pm2 restart (\S+)/g)].map((m) => m[1]).sort();
    eq(restarts, ['cursia-backend-staging', 'cursia-dynamic-provider-worker-staging'], 'solo los 2 procesos que leen el flag');
    assert(/options: \['none', 'report', 'preflight', 'policy', 'authorize', 'reconcile_charged_dry', 'reconcile_charged', 'worker_on', 'worker_off', 'titles_dry', 'titles_apply'\]/.test(all), 'acciones');
    assert(calText.includes('case "$CAL_COURSE" in "") ;; *[!0-9]*)'), 'curso validado en el runner');
    const remote = calText.slice(calText.indexOf("'set -e"), calText.lastIndexOf("'")).replace(`'"\${{ secrets.VPS_PATH_STAGING }}"'`, 'STAGING_DIR');
    assert(!/inputs\./.test(remote) && !remote.slice(1).includes("'"), 'ningún input interpolado ni comilla simple en el script remoto');
    for (const a of ['policy', 'authorize "$_COURSE"', 'report "$_COURSE"', 'worker "$_MODE"', 'titles_dry "$_COURSE"', 'titles_apply "$_COURSE"']) assert(remote.includes(`node scripts/staging-v21-calibration.js ${a}`), `acción ${a}`);
    assert(!/_CAL_|CAL_ACTION|inputs\.calibration/.test(deployJob.replace(/^\s*if:.*$/m, '')), 'el job de deploy no lee inputs de calibración');
    assert(!fs.existsSync(path.join(repoRoot, '.github/workflows/staging-calibration.yml')), 'sin workflow solo-dispatch no registrado');
    const C = require(path.resolve('scripts/staging-v21-calibration.js'));
    const pol = { limits: { maxCostPerRun: '10', maxCostPerCourse: '15', monthlyCapStaging: '50' }, on_exceed: 'ADMIN_APPROVAL', require_human_approval_for_real_spend: true };
    assert(C.policyMatches(pol), 'política aprobada reconocida');
    assert(C.policyMatches({ ...pol, limits: { maxCostPerRun: 10, maxCostPerCourse: '15.00', monthlyCapStaging: '50' } }), 'numérico equivalente');
    assert(!C.policyMatches({ ...pol, on_exceed: 'BLOCK' }) && !C.policyMatches({ ...pol, limits: { ...pol.limits, maxCostPerRun: '11' } }) && !C.policyMatches(null), 'otra política ≠ aprobada');
    assert(!C.policyMatches({ ...pol, limits: { ...pol.limits, maxCostPerProvider: { gamma: '1' } } }), 'claves extra ≠ aprobada');
    const course = { title: '[CALIBRATION V2.1] Provider Cost Verification' };
    const est = { totals: { expected: '2.32', max: '5.41' } };
    const base = { course, estimate: est, existingApprovals: 0, monthSpent: '0', policy: pol };
    assert(C.decideAuthorization(base).ok, 'caso aprobado');
    for (const [label, over, re] of [
      ['curso ajeno', { course: { title: 'Curso real' } }, /no es de calibración/],
      ['sin curso', { course: undefined }, /no existe/],
      ['segunda aprobación', { existingApprovals: 1 }, /solo se autoriza UNA/],
      ['sin estimado', { estimate: null }, /no hay un estimado/],
      ['max > 8', { estimate: { totals: { expected: '5', max: '8.01' } } }, /supera la aprobación/],
      ['tope mensual', { monthSpent: '42.5' }, /tope mensual/],
      ['política distinta', { policy: { ...pol, on_exceed: 'BLOCK' } }, /política global vigente no es la aprobada/],
    ]) {
      const d = C.decideAuthorization({ ...base, ...over });
      assert(!d.ok && re.test(d.reason), `${label}: ${JSON.stringify(d)}`);
    }
    assert(C.decideAuthorization({ ...base, monthSpent: '42' }).ok, '42 + 8 = 50 cabe justo');
    // Calibración #2: "[CALIBRATION V2.1 #2] …" es de calibración; variantes parecidas no.
    assert(C.decideAuthorization({ ...base, course: { title: '[CALIBRATION V2.1 #2] Provider Cost Verification' } }).ok, 'título con número de calibración');
    for (const bad of ['[CALIBRATION V2.1 #x] A', '[CALIBRATION V2.1#2] A', 'CALIBRATION V2.1 #2 A', '[CALIBRATION V2.10] A']) {
      assert(!C.decideAuthorization({ ...base, course: { title: bad } }).ok, `rechaza "${bad}"`);
    }
    eq(C.APPROVED.calibrationAuthorization, '8', 'aprobación de 8 USD');
    const g = spawnSync(process.execPath, [path.resolve('scripts/staging-v21-calibration.js'), 'policy'], { env: { PATH: process.env.PATH, MIGRATION_ENV: 'staging', DB_HOST: 'db.hriwbakbuypaiovvvkqh.supabase.co', DB_USER: 'x' }, cwd: os.tmpdir(), encoding: 'utf8' });
    eq(g.status, 1, 'guard de producción');
    const n = spawnSync(process.execPath, [path.resolve('scripts/staging-v21-calibration.js'), 'policy'], { env: { PATH: process.env.PATH, DB_HOST: 'db.abc.supabase.co' }, cwd: os.tmpdir(), encoding: 'utf8' });
    eq(n.status, 1, 'sin MIGRATION_ENV=staging no corre');
    const bad = spawnSync(process.execPath, [path.resolve('scripts/staging-v21-calibration.js'), 'authorize', '1;drop'], { env: { PATH: process.env.PATH, MIGRATION_ENV: 'staging', DB_HOST: 'db.abc.supabase.co' }, cwd: os.tmpdir(), encoding: 'utf8' });
    assert(bad.status === 1 && /courseId inválido/.test(bad.stderr), 'courseId validado en el script');
    // worker on/off: SOLO esa clave del .env, atómico, con backup y sin imprimir otros valores.
    const SECRET = 'db-pass-SECRET-9191';
    const tmpW = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-worker-'));
    try {
      fs.writeFileSync(path.join(tmpW, '.env'), `NODE_ENV=production\nDB_PASS=${SECRET}\nDYNAMIC_PROVIDER_WORKER_ENABLED=false\nOTHER=1\n`);
      const w = (mode) => spawnSync(process.execPath, [path.resolve('scripts/staging-v21-calibration.js'), 'worker', mode], { env: { PATH: process.env.PATH, MIGRATION_ENV: 'staging', DB_HOST: 'db.abcstaging.supabase.co' }, cwd: tmpW, encoding: 'utf8' });
      const on = w('on');
      assert(on.status === 0 && /false → true/.test(on.stdout) && !(on.stdout + on.stderr).includes(SECRET), `on: ${on.stdout}${on.stderr}`);
      const txt = fs.readFileSync(path.join(tmpW, '.env'), 'utf8');
      eq(txt, `NODE_ENV=production\nDB_PASS=${SECRET}\nDYNAMIC_PROVIDER_WORKER_ENABLED=true\nOTHER=1\n`, '.env: solo cambia el flag');
      assert(fs.existsSync(path.join(tmpW, '.env.bak')), 'backup');
      assert(/ya vale true/.test(w('on').stdout), 'idempotente');
      assert(w('off').status === 0 && /DYNAMIC_PROVIDER_WORKER_ENABLED=false/.test(fs.readFileSync(path.join(tmpW, '.env'), 'utf8')), 'off');
      assert(w('maybe').status === 1, 'modo inválido');
      const guard = spawnSync(process.execPath, [path.resolve('scripts/staging-v21-calibration.js'), 'worker', 'on'], { env: { PATH: process.env.PATH, MIGRATION_ENV: 'staging', DB_HOST: 'db.hriwbakbuypaiovvvkqh.supabase.co' }, cwd: tmpW, encoding: 'utf8' });
      eq(guard.status, 1, 'guard de producción también para worker');
    } finally {
      fs.rmSync(tmpW, { recursive: true, force: true });
    }
    eq(C.setEnvKeyText('A=1\n', 'K', 'true'), { text: 'A=1\nK=true\n', before: null }, 'agrega');
    let dupThrew = false;
    try { C.setEnvKeyText('K=1\nK=2\n', 'K', 'true'); } catch { dupThrew = true; }
    assert(dupThrew, 'clave duplicada → no se toca');
    // Resumen FinOps: reservas liquidadas netean 0, pendientes = cargos finales pending + reservas sin liquidar.
    const ev = [
      { id: 'r1', event_kind: 'CHARGE', provider: 'openai', amount: '0.02', metadata: { reservation: true }, measurement_status: 'pending', run_id: 'x', item_run_id: 'y', call_role: 'main', attempt: 1 },
      { id: 'a1', corrects_event_id: 'r1', event_kind: 'ADJUSTMENT', provider: 'openai', amount: '-0.02', metadata: {}, run_id: 'x', item_run_id: 'y' },
      { id: 'c1', event_kind: 'CHARGE', provider: 'openai', amount: '0.0147', metadata: {}, measurement_status: 'final', run_id: 'x', item_run_id: 'y', call_role: 'main', attempt: 1 },
      { id: 'r2', event_kind: 'CHARGE', provider: 'gamma', amount: '1.0', metadata: { reservation: true }, measurement_status: 'pending', run_id: 'x', item_run_id: 'z', call_role: 'main', attempt: 1 },
      { id: 'c2', event_kind: 'CHARGE', provider: 'anthropic', amount: '0.01', metadata: {}, measurement_status: 'final', run_id: null, item_run_id: null, call_role: 'main', attempt: 1 },
    ];
    // Review I2: la consulta del reporte DEBE traer metadata (si no, las reservas se cuentan como operaciones).
    const reportSrc = fs.readFileSync(path.resolve('scripts/staging-v21-calibration.js'), 'utf8');
    const evQuery = reportSrc.slice(reportSrc.indexOf('select id, corrects_event_id, event_kind'), reportSrc.indexOf('from public.generation_cost_events where course_id = $1 order by created_at'));
    assert(/\bmetadata\b/.test(evQuery) && /corrects_event_id/.test(evQuery) && /call_role/.test(evQuery), 'la consulta de eventos del reporte trae metadata / corrects_event_id / call_role');
    const sm = C.summarizeEvents(ev);
    eq([sm.byProvider.openai.finalCharges, Number(sm.byProvider.openai.net.toFixed(4)), sm.byProvider.gamma.reservationsPending, sm.pending, sm.unattributed], [1, 0.0147, 1, 1, 1], 'resumen');
    // R14: package.build se atribuye a nivel RUN por diseño (RF-b): con run_id y sin item_run NO es "sin atribuir".
    const smPkg = C.summarizeEvents([{ id: 'p1', event_kind: 'CHARGE', provider: 'cursia', operation: 'package.build', amount: '0', metadata: {}, measurement_status: 'final', run_id: 'x', item_run_id: null, call_role: 'main', attempt: 1 }]);
    eq([smPkg.unattributed, smPkg.runLevel], [0, 1], 'package.build a nivel run');
    eq(C.summarizeEvents([{ id: 'p3', event_kind: 'CHARGE', provider: 'openai', operation: 'package.build', amount: '0', metadata: {}, measurement_status: 'final', run_id: 'x', item_run_id: null, call_role: 'main', attempt: 1 }]).unattributed, 1, 'solo el package.build de cursia');
    const smNoRun = C.summarizeEvents([{ id: 'p2', event_kind: 'CHARGE', provider: 'cursia', operation: 'package.build', amount: '0', metadata: {}, measurement_status: 'final', run_id: null, item_run_id: null, call_role: 'main', attempt: 1 }]);
    eq(smNoRun.unattributed, 1, 'package.build sin run sí es sin atribuir');
  });

  await check('calibración R14: reconcile_charged concilia COMO COBRADA solo reservas ambiguas ya reemplazadas por un reenvío liquidado (run terminado); nunca llama al proveedor', () => {
    const all = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-staging.yml'), 'utf8');
    const calText = all.slice(all.indexOf('\n  calibration:\n'));
    assert(/options: \[[^\]]*'reconcile_charged'[^\]]*\]/.test(all), 'acción en el dispatch');
    assert(/reconcile_charged\) MIGRATION_ENV=staging node scripts\/staging-v21-calibration\.js reconcile_charged "\$_COURSE"/.test(calText), 'acción remota');
    assert(/\[ "\$CAL_ACTION" = reconcile_charged \]/.test(calText) && /\[ "\$CAL_ACTION" = reconcile_charged_dry \]/.test(calText), 'exige course_id');
    assert(/reconcile_charged_dry\) MIGRATION_ENV=staging node scripts\/staging-v21-calibration\.js reconcile_charged_dry "\$_COURSE" ;;/.test(calText), 'dry-run remoto (solo lectura)');
    const C = require(path.resolve('scripts/staging-v21-calibration.js'));
    const IR = 'a2437047-ae33-441a-b978-d3092b30857f';
    const res = { id: 'res1', idempotency_key: `reservation:tts:${IR}:g1:a1:chunk0`, event_kind: 'CHARGE', provider: 'openai', amount: '0.0140000000', metadata: { reservation: true }, measurement_status: 'pending', run_id: 'run1', item_run_id: IR, attempt: 1 };
    const later = { id: 'fin2', event_kind: 'CHARGE', provider: 'openai', amount: '0.0144', metadata: {}, measurement_status: 'final', run_id: 'run1', item_run_id: IR, attempt: 2 };
    const itemRuns = { [IR]: { status: 'completed', ack: 1, humanResubmits: 1 } };
    const jobs = { run1: { status: 'completed' } };
    const ok = C.selectChargedReconciliations([res, later], itemRuns, jobs);
    eq([ok.eligible.map((e) => e.idempotency_key), ok.skipped.length], [[res.idempotency_key], 0], 'caso real #241');
    for (const [label, evs, irs, js, re] of [
      ['run activo', [res, later], itemRuns, { run1: { status: 'running' } }, /run no terminado/],
      ['item no completado', [res, later], { [IR]: { status: 'failed', ack: 1, humanResubmits: 1 } }, jobs, /item no completado/],
      ['sin decisión humana (sin resubmit)', [res, later], { [IR]: { status: 'completed', ack: 0, humanResubmits: 0 } }, jobs, /sin decisión humana/],
      ['ack escrito por el worker (sin previousExternals)', [res, later], { [IR]: { status: 'completed', ack: 1, humanResubmits: 0 } }, jobs, /sin decisión humana/],
      ['cargo final del mismo intento (crash entre escrituras)', [res, { ...later, id: 'fin1', attempt: 1 }, later], itemRuns, jobs, /contaría doble/],
      ['decisión que no cubre el intento', [{ ...res, attempt: 2 }, { ...later, attempt: 3 }], itemRuns, jobs, /sin decisión humana/],
      ['reenvío en otro item_run', [res, { ...later, item_run_id: 'otro' }], itemRuns, jobs, /sin reenvío liquidado/],
      ['reenvío con el mismo intento', [res, { ...later, attempt: 1 }], itemRuns, jobs, /contaría doble/],
      ['monto NaN', [{ ...res, amount: 'abc' }, later], itemRuns, jobs, /tope/],
      ['monto negativo', [{ ...res, amount: '-0.01' }, later], itemRuns, jobs, /tope/],
      ['sin reenvío liquidado', [res], itemRuns, jobs, /sin reenvío liquidado/],
      ['reenvío de otro proveedor', [res, { ...later, provider: 'anthropic' }], itemRuns, jobs, /sin reenvío liquidado/],
      ['reenvío pendiente', [res, { ...later, measurement_status: 'pending' }], itemRuns, jobs, /sin reenvío liquidado/],
      ['monto sobre el tope', [{ ...res, amount: '0.75' }, later], itemRuns, jobs, /tope/],
    ]) {
      const s = C.selectChargedReconciliations(evs, irs, js);
      assert(s.eligible.length === 0 && s.skipped.length === 1 && re.test(s.skipped[0].reason), `${label}: ${JSON.stringify(s)}`);
    }
    // review R3: TTS multi-chunk — cargos finales de chunks HERMANOS del mismo intento no bloquean.
    const resC3 = { ...res, id: 'resC3', idempotency_key: `reservation:tts:${IR}:g1:a1:chunk3`, metadata: { reservation: true, callTag: 'chunk3' } };
    const sib = [0, 1, 2].map((n) => ({ ...later, id: 'sib' + n, attempt: 1, metadata: { chunk: n } }));
    eq(C.selectChargedReconciliations([resC3, ...sib, later], itemRuns, jobs).eligible.map((e) => e.id), ['resC3'], 'chunks hermanos no bloquean');
    eq(C.selectChargedReconciliations([resC3, { ...later, id: 'same3', attempt: 1, metadata: { chunk: 3 } }, later], itemRuns, jobs).skipped.map((e) => e.reason.includes('doble')), [true], 'mismo chunk sí bloquea');
    const pendAdj = C.selectChargedReconciliations([res, { ...later, measurement_status: 'pending' }, { id: 'adj2', corrects_event_id: 'fin2', event_kind: 'ADJUSTMENT', provider: 'openai', amount: '0' }], itemRuns, jobs);
    eq(pendAdj.eligible.length, 1, 'reenvío registrado pending y luego liquidado cuenta como reemplazo');
    const IR2 = 'b0000000-0000-4000-8000-000000000002';
    const two = C.selectChargedReconciliations([res, later, { ...res, id: 'res2', idempotency_key: `reservation:tts:${IR2}:g1:a1:chunk0`, item_run_id: IR2 }], { ...itemRuns, [IR2]: { status: 'completed', ack: 1, humanResubmits: 1 } }, jobs);
    eq([two.eligible.map((e) => e.id), two.skipped.map((e) => e.id)], [['res1'], ['res2']], 'dos reservas: solo la reemplazada');
    eq(C.selectChargedReconciliations([{ ...res, measurement_status: 'final' }, later], itemRuns, jobs), { eligible: [], skipped: [] }, 'reserva no pendiente: ignorada');
    const settled = C.selectChargedReconciliations([res, later, { id: 'adj', corrects_event_id: 'res1', event_kind: 'ADJUSTMENT', provider: 'openai', amount: '0' }], itemRuns, jobs);
    eq([settled.eligible.length, settled.skipped.length], [0, 0], 'ya liquidada: ni elegible ni omitida');
    const src = fs.readFileSync(path.resolve('scripts/staging-v21-calibration.js'), 'utf8');
    assert(/previousExternals/.test(src) && /archivedAt/.test(src), 'la consulta trae la evidencia del resubmit humano');
    assert(/reconcileReservationAsCharged/.test(src) && !/fetch\(|https?:\/\/api\.(openai|anthropic)/.test(src), 'usa el ledger; ninguna llamada a proveedores');
  });

  await check('preflight-v21-providers: READY / MISSING_CONFIG por proveedor sobre el .env de staging, sin imprimir valores; guard de producción', () => {
    assert(/preflight-v21-providers\.js/.test(stagingText), 'el deploy corre el preflight');
    const S = { O: 'sk-o-SECRET-1', A: 'sk-a-SECRET-2', G: 'g-SECRET-3', V: 'v-SECRET-4', Y: 'y-SECRET-5', F: 'f-SECRET-6' };
    const base = { PATH: process.env.PATH, MIGRATION_ENV: 'staging' };
    const full = { ...base, OPENAI_API_KEY: S.O, ANTHROPIC_API_KEY: S.A, GAMMA_API_KEY: S.G, GAMMA_THEME_V21_LIGHT_DEFAULT: 'l', GAMMA_THEME_V21_DARK_DEFAULT: 'd',
      VIDEOGEN_API_KEY: S.V, YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: S.Y, YOUTUBE_REDIRECT_URI: 'https://x/cb', YOUTUBE_TOKEN_SECRET: S.Y, FINOPS_INGEST_TOKEN: S.F, DYNAMIC_PROVIDER_WORKER_ENABLED: 'false' };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v21-pf-'));
    try {
      fs.symlinkSync(path.resolve(distRoot), path.join(tmp, 'dist'));
      const pf = (env) => spawnSync(process.execPath, [path.resolve('scripts/preflight-v21-providers.js')], { cwd: tmp, env, encoding: 'utf8' });
      const ok = pf(full);
      const outOk = ok.stdout + ok.stderr;
      for (const name of ['Gamma', 'OpenAI TTS', 'Anthropic', 'Videogen', 'YouTube', 'FinOps']) assert(new RegExp(`✓ ${name}: READY`).test(outOk), `${name} READY:\n${outOk}`);
      for (const v of Object.values(S)) assert(!outOk.includes(v), `imprimió un secreto: ${v}`);
      const miss = pf({ ...base, VIDEOGEN_API_KEY: S.V });
      const outMiss = miss.stdout + miss.stderr;
      for (const name of ['Gamma', 'OpenAI TTS', 'Anthropic', 'YouTube', 'FinOps']) assert(new RegExp(`✗ ${name}: MISSING_CONFIG`).test(outMiss), `${name} MISSING:\n${outMiss}`);
      assert(/✓ Videogen: READY/.test(outMiss) && /falta ANTHROPIC_API_KEY/.test(outMiss) && /falta GAMMA_API_KEY/.test(outMiss), outMiss);
      assert(!outMiss.includes(S.V), 'imprimió la clave de Videogen');
      assert(/GET \/themes/.test(fs.readFileSync('scripts/preflight-v21-providers.js', 'utf8')) && !/readFileSync\([^)]*VPS_PATH/.test(fs.readFileSync('scripts/preflight-v21-providers.js', 'utf8')), 'discovery read-only, sin producción');
      const guard = pf({ ...base, DB_HOST: 'db.hriwbakbuypaiovvvkqh.supabase.co', DB_USER: 'x' });
      eq(guard.status, 1, 'guard de producción');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── (b) workers compilados ────────────────────────────────────────────────
  for (const w of WORKERS) {
    assert(fs.existsSync(path.join(distRoot, 'workers', w.script)), `falta ${w.script} compilado en ${distRoot} (¿npm run build?)`);
    for (const flag of [undefined, 'false']) {
      const label = flag === undefined ? 'ausente' : `"${flag}"`;
      await check(`(b) ${w.script} con DYNAMIC_COURSE_STRUCTURE ${label}: inactivo, 0 conexiones/0 queries (0 claims), sin restart, SIGTERM → exit 0`, async () => {
        const r = await runWorker(w.script, { DYNAMIC_COURSE_STRUCTURE: flag }, { waitMs: 3500 });
        assert(/DYNAMIC_COURSE_STRUCTURE desactivado: el worker no reclama jobs/.test(r.output), `sin log claro:\n${r.output}`);
        assert(r.aliveAfterWait, `el proceso terminó solo (loop de restart en PM2): ${JSON.stringify(r.termExit)}\n${r.output}`);
        eq(r.connections, 0, 'conexiones a la DB');
        eq(r.queries.length, 0, 'queries (claims)');
        assert(r.termExit && r.termExit.code === 0, `SIGTERM: ${JSON.stringify(r.termExit)}`);
      });
    }
    await check(`(b) ${w.script} con DYNAMIC_COURSE_STRUCTURE=true: conecta y ejecuta su query de claim contra la DB falsa (sin filas → idle); SIGTERM → exit 0`, async () => {
      const r = await runWorker(w.script, { DYNAMIC_COURSE_STRUCTURE: 'true', ...(w.onEnv || {}) }, {
        waitMs: 20000,
        until: (st) => st.queries.some(w.claim),
      });
      assert(!/el worker no reclama jobs/.test(r.output), 'no debería quedar inactivo');
      assert(r.connections > 0, `no conectó a la DB:\n${r.output}`);
      assert(r.queries.some(w.claim), `no intentó reclamar (queries: ${JSON.stringify(r.queries.map((q) => q.slice(0, 80)))})\n${r.output.slice(-2000)}`);
      assert(r.aliveAfterWait, `el proceso terminó solo: ${JSON.stringify(r.termExit)}\n${r.output.slice(-2000)}`);
      assert(r.termExit && r.termExit.code === 0, `SIGTERM: ${JSON.stringify(r.termExit)}\n${r.output.slice(-2000)}`);
    });
  }

  // ── Calibración #2: el worker de proveedores reales respeta SU flag (apagado = 0 conexiones, 0 claims) ──
  for (const flag of [undefined, 'false', 'TRUE']) {
    await check(`(b) dynamic-provider-worker.js con DYNAMIC_PROVIDER_WORKER_ENABLED ${flag === undefined ? 'ausente' : `"${flag}"`} (y DYNAMIC_COURSE_STRUCTURE=true): inactivo, 0 conexiones / 0 claims — apagar el worker detiene el gasto de Gamma/TTS de runs activos`, async () => {
      const r = await runWorker('dynamic-provider-worker.js', { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_PROVIDER_WORKER_ENABLED: flag }, { waitMs: 3500 });
      assert(/DYNAMIC_PROVIDER_WORKER_ENABLED≠true: el worker de proveedores reales no reclama items/.test(r.output), `sin log claro:\n${r.output}`);
      assert(r.aliveAfterWait, `el proceso terminó solo: ${JSON.stringify(r.termExit)}`);
      eq([r.connections, r.queries.length], [0, 0], 'conexiones / queries');
      assert(r.termExit && r.termExit.code === 0, `SIGTERM: ${JSON.stringify(r.termExit)}`);
    });
  }

  // ── M5: flag ON antes de migrar (esquema V2 ausente → 42P01) ──────────────
  for (const w of WORKERS) {
    await check(`(M5) ${w.script} flag ON + esquema V2 ausente (42P01 en su claim): error claro UNA vez, sin crash-loop, re-chequeo con backoff; SIGTERM → exit 0`, async () => {
      const r = await runWorker(w.script, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_WORKER_SCHEMA_RECHECK_MS: '1500', ...(w.onEnv || {}) }, {
        waitMs: 20000,
        failRelation: (q) => (w.claim(q) ? (/generation_item_runs/.test(q) ? 'public.generation_item_runs' : 'public.production_jobs') : null),
        until: (st) => st.failed >= 3,
      });
      assert(r.aliveAfterWait, `el proceso terminó solo (crash-loop en PM2): ${JSON.stringify(r.termExit)}\n${r.output.slice(-2500)}`);
      assert(r.failed >= 3, `no re-chequeó con backoff (claims fallidos: ${r.failed})\n${r.output.slice(-2000)}`);
      const logged = (r.output.match(/esquema V2 ausente/g) || []).length;
      eq(logged, 1, 'el error de esquema ausente se loguea UNA vez');
      assert(/42P01/.test(r.output) && /migraciones/.test(r.output), `el error no es claro:\n${r.output.slice(-2000)}`);
      assert(r.termExit && r.termExit.code === 0, `SIGTERM: ${JSON.stringify(r.termExit)}`);
    });
  }

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
