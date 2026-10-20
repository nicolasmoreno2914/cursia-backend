#!/usr/bin/env node
/* eslint-disable */
// r62 (M) — PRUEBA INTEGRAL DE AUTONOMÍA, offline y a USD 0.
//
// Pregunta: desde la configuración inicial de un curso S y UNA sola autorización de presupuesto, ¿Cursia genera todos
// los componentes, se recupera sola de fallas inyectadas, valida, empaqueta (dynamic_mbz + validateMbzV3) y entrega un
// .mbz válido SIN ninguna acción humana/admin posterior al inicio?
//
// Corre el código REAL (dist/): app Nest (scheduler, auto-healer, FinOps, completion), dynamic-llm-worker,
// dynamic-provider-worker (Gamma/TTS/guion del audiolibro), dynamic-item-worker (Videogen + YouTube) y
// dynamic-package-worker, como procesos hijos, sobre un PG16 DESCARTABLE con las migraciones reales (la misma secuencia
// que test/e2e-v2/run-e2e.sh + run-pause + rel-exec-lease, como staging). Solo los PROVEEDORES son falsos (los de
// test/e2e-v2: Anthropic SSE con el LLM falso v3, Gamma/OpenAI/Anthropic de fakes.js, Videogen, Storage y Google), y
// delante de cada uno va un proxy de fallas (scripts/lib/r62-fault-proxy.js) que cuenta las llamadas PAGADAS por clave
// lógica. netguard en todos los procesos (NODE_OPTIONS) y en este: toda conexión fuera de 127.0.0.1 se bloquea.
// Puertos libres al azar (nunca 5570 / 8099 / 55491 / 38471); datos en un directorio sin los patrones que limpia gate.sh.
//
// Flujo por escenario (curso S nuevo, workers nuevos):
//   1. configuración inicial por HTTP (estructura, perfiles, diseño conservado, Blueprint, Manifest v3);
//   2. UNA autorización: estimate-preview → approve-and-start (SUPER_ADMIN, con la política del curso);
//   3. fallas inyectadas (proxy / matar workers / interrumpir todo y reanudar);
//   4. espera SIN tocar nada hasta: run completed + paquete final automático completed + .mbz descargado con el
//      sha que aprobó validateMbzV3 (metadata.validatedSha256 del artifact) y moodle_backup.xml;
//   5. si se ESTANCA (nada que el sistema vaya a hacer solo: partes fallidas sin recuperación automática pendiente, run
//      pausado/fallado, paquete fallado) o pasa el tope de tiempo, un «operador» aplica la acción de admin documentada
//      (conciliar la reserva con la verdad del proxy, retry / resubmitProvider / resubmitVideo, resume, package) y la
//      CUENTA como intervención. Así se mide cuántas hacen falta para terminar y si el .mbz se entrega igual.
//
// Mide por escenario: interventions, estado final del run y de las partes, .mbz entregado, llamadas pagadas
// duplicadas (por clave lógica), ledger ≤ autorizado, reservas abiertas/huérfanas, tiempo. Imprime la tabla y sale
// rc≠0 si algún escenario necesitó una intervención (no hay excepciones justificadas registradas: JUSTIFIED = {}).
// Que escenarios fallen sobre staging es un RESULTADO: no se ablandan.
//
// Uso: npm run build && node scripts/check-r62-autonomy-e2e.js [--dist=dist] [--fe=<campuscloud-gen>] [--out=<dir>]
//        [--only=<regex>] [--parallel=N] [--label=<texto>]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ARGV = process.argv.slice(2);
const arg = (k, d) => { const a = ARGV.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(arg('dist', path.join(REPO, 'dist')));
const E2E = path.join(REPO, 'test/e2e-v2');
const FE = path.resolve(arg('fe', process.env.CURSIA_FRONTEND_REPO || path.join(os.homedir(), 'cursia-test-env/work/r62/fe-now')));
const LABEL = arg('label', path.basename(REPO));
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'cursia-test-env/work/r62/M-e2e-out', `${LABEL}-${Date.now()}`)));
const ONLY = arg('only', null) ? new RegExp(arg('only')) : null;
const PARALLEL = Math.max(1, Number(arg('parallel', '1')) || 1);
const JSON_OUT = arg('json-out', null);
fs.mkdirSync(OUT, { recursive: true });
const NET_LOG = path.join(OUT, 'net-violations.log');
if (!fs.existsSync(NET_LOG)) fs.writeFileSync(NET_LOG, '');
require('./lib/netguard').installSocketGuard({ allowLoopback: true, logFile: NET_LOG });

const R = (m) => require(path.join(REPO, 'node_modules', m));
const D = (p) => require(path.join(DIST, p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shaHex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'check.log'), s + '\n'); };

// Sin excepciones registradas: toda intervención cuenta como innecesaria (rc≠0).
const JUSTIFIED = {};

// ─── escenarios ──────────────────────────────────────────────────────────────
// Marcadores de prompts del LLM falso v3 (llm-v3.js / e2e-v3 E24).
const CH1 = 'Cebado de la bomba';
const CH2 = 'Arranque y parada';
const isContent = (t, n, title) => t.includes(`Genera el CAPÍTULO ${n} COMPLETO: "${title}"`);
const isExperience = (t) => t.includes('Genera la EXPERIENCIA del capítulo');
const SPEECH = (i) => i.method === 'POST' && i.path === '/v1/audio/speech';
const GAMMA_POST = (i) => i.method === 'POST' && i.path === '/generations';
const GAMMA_GET = (i) => i.method === 'GET' && /^\/generations\/[^/]+$/.test(i.path);
const LLM_POST = (i) => i.method === 'POST' && i.path === '/v1/messages';
const VG_STATUS = (i) => i.method === 'GET' && /^\/api\/external\/videos\/[^/]+\/status$/.test(i.path);

const SCENARIOS = [
  { id: 'baseline', what: 'sin fallas (control)', setup() {} },
  {
    id: 'anthropic_529_429_500', what: 'Anthropic 529 ×2 (Libro cap. 1), 429 + retry-after (experiencia), 500 (interacciones del video)',
    setup({ P }) {
      P.llm.rule('529', (i) => LLM_POST(i) && isContent(i.text, 1, CH1), 529, { times: 2 });
      P.llm.rule('429', (i) => LLM_POST(i) && isExperience(i.text), 429, { times: 1, headers: { 'retry-after': '2' } });
      P.llm.rule('500', (i) => LLM_POST(i) && i.text.includes('Puntos de pausa (fijos'), 500, { times: 1 });
    },
  },
  {
    id: 'anthropic_timeout', what: 'Anthropic: la experiencia se procesa (cobrada) y la respuesta nunca llega → timeout de inactividad',
    setup({ P }) { P.llm.rule('timeout', (i) => LLM_POST(i) && isExperience(i.text), 'forward_hang', { times: 1 }); },
  },
  {
    id: 'tts_500', what: 'OpenAI TTS: 500 en la 2.ª síntesis',
    setup({ P }) { P.prov.rule('tts500', (i) => SPEECH(i) && i.n === 2, 500, { times: 1 }); },
  },
  {
    id: 'tts_timeout_segment', what: 'OpenAI TTS: la 2.ª síntesis se procesa (cobrada) y no responde → timeout del cliente',
    setup({ P }) { P.prov.rule('ttsTimeout', (i) => SPEECH(i) && i.n === 2, 'forward_hang', { times: 1 }); },
  },
  {
    id: 'tts_hang', what: 'OpenAI TTS: la 3.ª síntesis cuelga sin procesarse (no cobrada; el cliente no lo sabe)',
    setup({ P }) { P.prov.rule('ttsHang', (i) => SPEECH(i) && i.n === 3, 'hang', { times: 1 }); },
  },
  {
    id: 'videogen_fail_prerender', what: 'Videogen: el job falla antes del render (status failed, progress 0)',
    setup({ P }) {
      P.vg.rule('vgFail', (i) => VG_STATUS(i), 'rewrite', { times: 1, fn: (j) => ({ ...j, status: 'failed', progress: 0, download_url: null, error: 'script_failed: falla antes del render (r62)' }) });
    },
  },
  {
    id: 'videogen_never_finishes', what: 'Videogen: el primer job nunca termina (processing para siempre)',
    capMs: 12 * 60_000,
    setup({ P, S }) {
      S.stuckJob = null;
      P.vg.rule('vgStuck', (i) => {
        if (!VG_STATUS(i)) return false;
        const id = i.path.split('/')[4];
        if (!S.stuckJob) S.stuckJob = id;
        return id === S.stuckJob;
      }, 'rewrite', { times: Infinity, fn: (j) => ({ ...j, status: 'processing', progress: 50, download_url: null, duration_seconds: undefined }) });
    },
  },
  {
    id: 'gamma_error', what: 'Gamma: 500 en la 1.ª creación de presentación',
    setup({ P }) { P.prov.rule('gamma500', (i) => GAMMA_POST(i) && i.n === 1, 500, { times: 1 }); },
  },
  {
    id: 'econnreset', what: 'ECONNRESET: 3.ª llamada a Anthropic, 1.er poll de Gamma, 1.er poll de Videogen y 1.ª síntesis TTS',
    setup({ P }) {
      P.llm.rule('rstLlm', (i) => LLM_POST(i) && i.n === 3, 'reset', { times: 1 });
      P.prov.rule('rstGammaGet', (i) => GAMMA_GET(i) && i.n === 1, 'reset', { times: 1 });
      P.vg.rule('rstVg', (i) => VG_STATUS(i) && i.n === 1, 'reset', { times: 1 });
      P.prov.rule('rstTts', (i) => SPEECH(i) && i.n === 1, 'reset', { times: 1 });
    },
  },
  {
    id: 'worker_restart', what: 'kill -9 del dynamic-provider-worker (hospeda el worker de IA) con el Libro cap. 2 en vuelo y, después, con una síntesis TTS en vuelo; procesos nuevos toman la lease',
    setup({ P }) {
      P.llm.rule('inflightLlm', (i) => LLM_POST(i) && isContent(i.text, 2, CH2), 'delay', { times: 1, ms: 25_000 });
      P.prov.rule('inflightTts', (i) => SPEECH(i) && i.n === 2, 'delay', { times: 1, ms: 20_000 });
    },
    async tick(ctx) {
      const { P, S, stack } = ctx;
      const pend = (p, rule) => p.st.calls.some((c) => c.rule === rule && c.outcome === 'pending' && Date.now() - c.at > 2000);
      if (!S.killedLlm && pend(P.llm, 'inflightLlm')) {
        S.killedLlm = true;
        S.llmVictim = `${stack.workers.provider.label}-llm`;
        log(`  ↯ kill -9 ${stack.workers.provider.label} (Libro cap. 2 en vuelo en ${S.llmVictim})`);
        await stack.killWorker('provider');
        await stack.spawnWorker('provider', 'b');
      }
      if (!S.killedProv && pend(P.prov, 'inflightTts')) {
        S.killedProv = true;
        S.provVictim = stack.workers.provider.label;
        log(`  ↯ kill -9 ${S.provVictim} (síntesis TTS en vuelo)`);
        await stack.killWorker('provider');
        await stack.spawnWorker('provider', S.killedLlm ? 'c' : 'b');
      }
    },
    async verify(ctx, rows) {
      const { S } = ctx;
      const content2 = rows.find((r) => r.type === 'content' && r.chapter_id === ctx.course.mods[0].chapters[1].id);
      const audio = rows.filter((r) => ['audio_welcome', 'audiobook_chapter'].includes(r.type));
      return {
        llmTakeover: S.killedLlm ? (content2 && content2.status === 'completed' && content2.worker_id !== S.llmVictim ? `ok (${content2.worker_id})` : `NO (${content2 && content2.status}/${content2 && content2.worker_id})`) : 'no se disparó',
        provTakeover: S.killedProv ? audio.map((r) => `${r.type}:${r.status}/${r.worker_id}`).join(' ') : 'no se disparó',
      };
    },
  },
  {
    id: 'lease_takeover_alive', what: 'el proceso del worker de IA se congela (SIGSTOP) con el Libro cap. 2 en vuelo, pierde la lease, otro proceso la toma y el primero revive (SIGCONT) con la respuesta',
    // Inactividad del stream holgada (60 s) solo acá: lo que se prueba es la toma de la lease con A vivo, no el timeout.
    env: { DYNAMIC_LLM_WORKER_IDLE_MS: '60000' },
    setup({ P }) { P.llm.rule('inflightLlm', (i) => LLM_POST(i) && isContent(i.text, 2, CH2), 'delay', { times: 1, ms: 5_000 }); },
    async tick(ctx) {
      const { P, S, stack } = ctx;
      if (!S.frozen && P.llm.st.calls.some((c) => c.rule === 'inflightLlm' && c.outcome === 'pending' && Date.now() - c.at > 2000)) {
        S.frozen = stack.workers.provider;
        S.frozenAt = Date.now();
        S.llmVictim = `${S.frozen.label}-llm`;
        log(`  ↯ SIGSTOP ${S.frozen.label} (Libro cap. 2 en vuelo); proceso nuevo`);
        S.frozen.kill('SIGSTOP');
        await stack.spawnWorker('provider', 'b');
      }
      if (S.frozen && !S.resumed && Date.now() - S.frozenAt > 25_000) {
        S.resumed = true;
        log(`  ↯ SIGCONT ${S.frozen.label}`);
        S.frozen.kill('SIGCONT');
      }
    },
    async verify(ctx, rows) {
      const { S } = ctx;
      const content2 = rows.find((r) => r.type === 'content' && r.chapter_id === ctx.course.mods[0].chapters[1].id);
      return { llmTakeover: S.frozen ? `${content2 && content2.status}/${content2 && content2.worker_id} (víctima ${S.llmVictim})` : 'no se disparó' };
    },
  },
  {
    id: 'run_interrupt_resume', what: 'interrupción del run completo (kill -9 de app + todos los workers con 5+ partes hechas) y reanudación (procesos nuevos)',
    async tick(ctx) {
      const { S, stack } = ctx;
      if (S.interrupted) return;
      const [r] = await ctx.q(`select count(*) filter (where status = 'completed')::int done, count(*) filter (where status = 'running')::int running from public.generation_item_runs where job_id = $1`, [ctx.runId]);
      if (r && r.done >= 5 && r.running >= 1) {
        S.interrupted = true;
        log(`  ↯ interrupción total (done=${r.done}, running=${r.running})`);
        await stack.killAll();
        await sleep(5000);
        await stack.startApp();
        for (const k of ['provider', 'item', 'package']) await stack.spawnWorker(k, 'r');
      }
    },
  },
  {
    id: 'uncertain_billing', what: 'facturación incierta: el proveedor procesa (cobra) y la conexión se corta antes de entregar (Libro cap. 1 en Anthropic; 2.ª síntesis TTS)',
    setup({ P }) {
      P.llm.rule('uncLlm', (i) => LLM_POST(i) && isContent(i.text, 1, CH1), 'forward_reset', { times: 1 });
      P.prov.rule('uncTts', (i) => SPEECH(i) && i.n === 2, 'forward_reset', { times: 1 });
    },
  },
];

// ─── orquestador paralelo (procesos hijos con --only + --json-out) ────────────
if (PARALLEL > 1 && !JSON_OUT) {
  (async () => {
    const list = SCENARIOS.filter((s) => !ONLY || ONLY.test(s.id));
    const shards = Array.from({ length: PARALLEL }, () => []);
    list.forEach((s, i) => shards[i % PARALLEL].push(s.id));
    log(`r62 autonomía: ${list.length} escenarios en ${PARALLEL} pilas paralelas (${LABEL})`);
    const results = [];
    await Promise.all(shards.filter((s) => s.length).map((ids, k) => new Promise((resolve) => {
      const jo = path.join(OUT, `shard-${k}.json`);
      const child = spawn(process.execPath, [__filename, `--dist=${DIST}`, `--fe=${FE}`, `--out=${path.join(OUT, `shard-${k}`)}`, `--only=^(${ids.join('|')})$`, `--json-out=${jo}`, `--label=${LABEL}`], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      const lf = fs.openSync(path.join(OUT, `shard-${k}.log`), 'a');
      child.stdout.on('data', (d) => { fs.writeSync(lf, d); process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `[s${k}] ${l}`).join('\n') + '\n'); });
      child.stderr.on('data', (d) => fs.writeSync(lf, d));
      child.on('exit', () => { try { results.push(...JSON.parse(fs.readFileSync(jo, 'utf8'))); } catch (e) { results.push(...ids.map((id) => ({ id, error: `shard ${k} sin resultados: ${e.message}` }))); } resolve(); });
    })));
    const ordered = list.map((s) => results.find((r) => r.id === s.id) || { id: s.id, error: 'sin resultado' });
    finish(ordered);
  })().catch((e) => { console.error(e); process.exit(2); });
  return;
}

// ─── pila: PG16 + fakes + proxies + app + workers ─────────────────────────────
async function freePort() {
  for (;;) {
    const p = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
    if (![5570, 8099, 55491, 38471, 38478].includes(p)) return p;
  }
}
const PGBIN = process.env.PGBIN || '/opt/homebrew/bin';

async function setupDb(dataDir, port) {
  const logDir = path.join(OUT, 'db-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const run = (label, cmd, args, env = {}) => {
    const r = spawnSync(cmd, args, { cwd: REPO, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', ...env }, encoding: 'utf8' });
    fs.writeFileSync(path.join(logDir, `${label}.log`), `${r.stdout || ''}\n${r.stderr || ''}`);
    if (r.status !== 0) throw new Error(`${label} falló (rc ${r.status}): ${(r.stderr || r.stdout || '').slice(-600)}`);
  };
  fs.rmSync(dataDir, { recursive: true, force: true });
  run('initdb', `${PGBIN}/initdb`, ['-D', dataDir, '--locale=C', '-U', 'postgres', '-A', 'trust']);
  run('pg_ctl-start', `${PGBIN}/pg_ctl`, ['-D', dataDir, '-o', `-p ${port} -c unix_socket_directories='' -c listen_addresses='127.0.0.1' -c max_connections=300`, '-l', path.join(logDir, 'pg.log'), '-w', 'start']);
  run('createdb', `${PGBIN}/createdb`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'v2db']);
  run('role', `${PGBIN}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'v2db', '-qc', 'create role "postgres.e2elocaltest" superuser login']);
  const node = process.execPath;
  const schemaEnv = { NODE_PATH: path.join(REPO, 'node_modules'), BUILD_DIR: DIST, REPO, PGPORT_T: String(port), NODE_ENV: 'production' };
  run('setup-base', node, [path.join(E2E, 'setup-schema.js'), 'base'], schemaEnv);
  const dbEnv = { DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'v2db', DB_SSL: 'false', NODE_PATH: path.join(REPO, 'node_modules') };
  run('migrate-jobs', node, ['scripts/migrate-production-jobs-constraints.js'], dbEnv);
  run('setup-sql', node, [path.join(E2E, 'setup-schema.js'), 'sql'], schemaEnv);
  const stg = { ...dbEnv, MIGRATION_ENV: 'staging', DB_USER: 'postgres.e2elocaltest' };
  // Misma secuencia que test/e2e-v2/run-e2e.sh + run-pause y rel-exec-lease (staging los tiene).
  for (const s of ['migrate-dynamic-generation-v2', 'migrate-invalidation', 'migrate-v21-manifest-v3', 'verify-v21-manifest-v3-schema', 'migrate-application-activities',
    'verify-application-activities-schema', 'migrate-guided-practice', 'verify-guided-practice-schema', 'migrate-v21-finops', 'verify-v21-finops-schema', 'migrate-rel-recovery',
    'verify-rel-recovery-schema', 'migrate-llm-worker-presence', 'migrate-rel-exec-lease', 'migrate-run-pause']) run(s, node, [`scripts/${s}.js`], stg);
}

async function createStack(name) {
  const S = { name, children: new Set() };
  S.pgPort = await freePort();
  S.appPort = await freePort();
  S.dataDir = path.join(OUT, `r62m-db-${name}`);
  S.dir = path.join(OUT, `stack-${name}`);
  fs.mkdirSync(S.dir, { recursive: true });
  const tls = path.join(S.dir, 'tls');
  fs.mkdirSync(tls, { recursive: true });
  const o = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tls}/key.pem`, '-out', `${tls}/cert.pem`, '-days', '2', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' });
  if (o.status !== 0) throw new Error('openssl falló');
  log(`[${name}] PG16 descartable en 127.0.0.1:${S.pgPort}, app en :${S.appPort}`);
  await setupDb(S.dataDir, S.pgPort);
  const { Client } = R('pg');
  S.db = new Client({ host: '127.0.0.1', port: S.pgPort, user: 'postgres', database: 'v2db' });
  await S.db.connect();
  S.q = async (sql, params) => (await S.db.query(sql, params)).rows;

  const { startFakes, startProviderFakes } = require(path.join(E2E, 'fakes.js'));
  const { startAnthropicSseFake } = require(path.join(E2E, 'anthropic-sse-fake.js'));
  const { createLlm } = require(path.join(E2E, 'llm.js'));
  const { createLlmV3 } = require(path.join(E2E, 'llm-v3.js'));
  const { makeFront } = require(path.join(E2E, 'front.js'));
  const { startFaultProxy } = require('./lib/r62-fault-proxy');
  const KEYS = { gamma: 'fake-gamma-key-r62-local', openai: 'fake-openai-key-r62-local', anthropic: 'fake-anthropic-key-r62-local', videogen: 'fake-videogen-key-r62-local' };
  S.KEYS = KEYS;
  S.fakes = await startFakes({ tlsDir: tls, videogenKey: KEYS.videogen });
  const SMM = D('package/v3/synthetic-media.js');
  S.pfakes = startProviderFakes({ gammaKey: KEYS.gamma, openaiKey: KEYS.openai, anthropicKey: KEYS.anthropic, makePdf: SMM.syntheticPdf, makeMp3: SMM.syntheticMp3 });
  S.purls = await S.pfakes.listen();
  S.front = { fixtures: null };
  const llmBase = createLlm({ getFixtures: () => S.frontSandbox.SV2_PREVIEW_FIXTURES, getSplit: (n) => S.frontSandbox.dynExamQuestionSplit(n) });
  const H5P2_FIXTURE = path.join(FE, 'fixtures/h5p2/fake-llm-h5p2.json');
  const H5P2 = fs.existsSync(H5P2_FIXTURE) ? JSON.parse(fs.readFileSync(H5P2_FIXTURE, 'utf8')) : null;
  S.llm = createLlmV3({ base: llmBase, examBankContract: D('modules/course-shell/exam-bank.js'), h5p2: H5P2 });
  S.sse = await startAnthropicSseFake(S.llm);
  S.P = {
    // Anthropic: un solo host como en staging; el pedido en streaming (worker de IA) va al falso SSE con el LLM falso
    // v3 y el no-streaming (guion del audiolibro) al falso de fakes.js.
    llm: await startFaultProxy('anthropic', (i) => { try { return JSON.parse(i.raw || '{}').stream === true ? S.sse.url : S.purls.anthropicUrl; } catch { return S.purls.anthropicUrl; } }),
    prov: await startFaultProxy('gamma-openai', S.purls.gammaUrl),
    vg: await startFaultProxy('videogen', S.fakes.videogenUrl),
  };
  S.OWNER = crypto.randomUUID();
  S.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  S.YT_SECRET = crypto.randomBytes(32).toString('hex');
  S.LLM_SINCE = new Date(Date.now() - 1000).toISOString();
  const jwt = R('jsonwebtoken');
  S.TOKEN = jwt.sign({ sub: S.OWNER, email: 'r62-owner@example.com', role: 'authenticated', aud: 'authenticated', user_metadata: { email_verified: true } }, S.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' });
  S.frontSandbox = makeFront({ feRoot: FE, backendUrl: `http://127.0.0.1:${S.appPort}`, storageUrl: S.fakes.storageUrl, token: S.TOKEN, ownerId: S.OWNER, llm: S.llm, logFile: path.join(S.dir, 'front.log'), netViolations: [] });
  const tplIds = S.frontSandbox.SCORM_V2_TEMPLATES.map((t) => t.id);
  S.templates = tplIds.filter((t) => S.frontSandbox.scormV2ValidateRoomData(t, JSON.parse(JSON.stringify(S.frontSandbox.SV2_PREVIEW_FIXTURES[t]))).ok);

  S.baseEnv = () => ({
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    NODE_ENV: 'production', NODE_PATH: path.join(REPO, 'node_modules'),
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(E2E, 'netguard.js'))} --require ${JSON.stringify(path.join(E2E, 'google-fake-redirect.js'))}`,
    E2E_NET_LOG: NET_LOG, E2E_GOOGLE_FAKE_BASE: S.fakes.googleUrl,
    DB_HOST: '127.0.0.1', DB_PORT: String(S.pgPort), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'v2db', DB_SSL: 'false',
    SUPABASE_URL: S.fakes.storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-local-only', SUPABASE_JWT_SECRET: S.JWT_SECRET,
    DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_MANIFEST_RULES_VERSION: '3',
    DYNAMIC_REAL_VIDEO_OWNERS: S.OWNER, DYNAMIC_V2_ALLOWED_OWNERS: S.OWNER,
    DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', DYNAMIC_ALLOW_PROVIDER_MOCK: 'true',
    DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', SUPER_ADMIN_EMAILS: 'r62-owner@example.com',
    YOUTUBE_TOKEN_SECRET: S.YT_SECRET, YOUTUBE_CLIENT_ID: 'fake-client-id', YOUTUBE_CLIENT_SECRET: 'fake-client-secret',
    VIDEOGEN_API_URL: S.P.vg.url, VIDEOGEN_API_KEY: KEYS.videogen,
    GAMMA_API_KEY: KEYS.gamma, GAMMA_API_BASE_URL: S.P.prov.url,
    GAMMA_THEME_V21_LIGHT_DEFAULT: 'e2e-theme-light', GAMMA_THEME_V21_DARK_DEFAULT: 'e2e-theme-dark',
    OPENAI_API_KEY: KEYS.openai, OPENAI_API_BASE_URL: `${S.P.prov.url}/v1`,
    ANTHROPIC_API_KEY: KEYS.anthropic, ANTHROPIC_API_BASE_URL: S.P.llm.url,
    DYNAMIC_GAMMA_POLL_MS: '200',
    // Compresión de tiempos (solo cadencias y timeouts por llamada; las reglas/backoffs del producto quedan como están).
    PROVIDER_CALL_TIMEOUT_MS: '8000', DYNAMIC_AUTO_HEAL_INTERVAL_MS: '5000',
    DYNAMIC_LLM_WORKER_ENABLED: 'true', DYNAMIC_LLM_WORKER_SINCE: S.LLM_SINCE,
  });
  const spawnProc = (label, script, env) => {
    const logFile = path.join(S.dir, `${label}.log`);
    const fd = fs.openSync(logFile, 'a');
    const ch = spawn(process.execPath, [path.join(DIST, script)], { cwd: S.dir, env, stdio: ['ignore', fd, fd] });
    ch.label = label; ch.logFile = logFile; ch.exited = null;
    ch.on('exit', (code, sig) => { ch.exited = { code, sig }; S.children.delete(ch); });
    S.children.add(ch);
    return ch;
  };
  S.seq = 0;
  S.workers = {};
  S.startApp = async () => {
    const ch = spawnProc(`app-${++S.seq}`, 'main.js', { ...S.baseEnv(), PORT: String(S.appPort) });
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      if (ch.exited) throw new Error(`app terminó al arrancar: ${JSON.stringify(ch.exited)} (${ch.logFile})`);
      try { const r = await fetch(`http://127.0.0.1:${S.appPort}/health`); if (r.ok) { S.app = ch; return ch; } } catch {}
      await sleep(250);
    }
    throw new Error('app sin /health en 90 s');
  };
  S.workerSpec = (kind, id) => {
    const b = S.baseEnv();
    // Topología de staging (Loop 6): el worker de IA corre HOSPEDADO en el dynamic-provider-worker (un proceso). Su
    // executorId es DYNAMIC_LLM_WORKER_ID (= `<id>-llm`). Los demás procesos no lo hospedan.
    if (kind === 'provider') return ['workers/dynamic-provider-worker.js', { ...b, DYNAMIC_PROVIDER_WORKER_ID: id, DYNAMIC_PROVIDER_WORKER_POLL_MS: '400', DYNAMIC_PROVIDER_WORKER_LEASE_SECONDS: '20',
      ANTHROPIC_BASE_URL_IS_REAL_PROVIDER: 'true', DYNAMIC_LLM_WORKER_ID: `${id}-llm`,
      DYNAMIC_LLM_WORKER_POLL_MS: '300', DYNAMIC_LLM_WORKER_LEASE_SECONDS: '15', DYNAMIC_LLM_WORKER_HEARTBEAT_MS: '3000', DYNAMIC_LLM_WORKER_IDLE_MS: '20000',
      DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS: '60000', DYNAMIC_LLM_WORKER_CONCURRENCY: '2', DYNAMIC_LLM_WORKER_BACKOFF_MS: '20', DYNAMIC_WORKER_DRAIN_TIMEOUT_MS: '30000' }];
    if (kind === 'item') return ['workers/dynamic-item-worker.js', { ...b, DYNAMIC_LLM_WORKER_ENABLED: 'false', DYNAMIC_ITEM_WORKER_ID: id, DYNAMIC_ITEM_WORKER_POLL_MS: '400', DYNAMIC_ITEM_WORKER_VIDEO_POLL_MS: '300',
      DYNAMIC_ITEM_WORKER_HEARTBEAT_MS: '5000', DYNAMIC_ITEM_WORKER_LEASE_SECONDS: '20', DYNAMIC_ITEM_WORKER_VIDEO_TIMEOUT_MIN: '1', DYNAMIC_YOUTUBE_UPLOAD_RETRY_BASE_MS: '50', NODE_TLS_REJECT_UNAUTHORIZED: '0' }];
    if (kind === 'package') return ['workers/dynamic-package-worker.js', { ...b, DYNAMIC_LLM_WORKER_ENABLED: 'false', DYNAMIC_PACKAGE_WORKER_ID: id, DYNAMIC_PACKAGE_WORKER_POLL_MS: '400' }];
    throw new Error(kind);
  };
  S.spawnWorker = async (kind, suffix) => {
    const id = `r62-${kind}-${S.scen || 'x'}-${suffix}`;
    const [script, env0] = S.workerSpec(kind, id);
    const env = { ...env0, ...(S.envOverride || {}) };
    const ch = spawnProc(id, script, env);
    S.workers[kind] = ch;
    return ch;
  };
  S.killWorker = async (kind) => {
    const ch = S.workers[kind];
    if (!ch || ch.exited) return;
    ch.kill('SIGKILL');
    const t0 = Date.now();
    while (!ch.exited && Date.now() - t0 < 5000) await sleep(50);
  };
  S.stopWorker = async (kind, timeoutMs = 15000) => {
    const ch = S.workers[kind];
    if (!ch || ch.exited) return;
    ch.kill('SIGTERM');
    const t0 = Date.now();
    while (!ch.exited && Date.now() - t0 < timeoutMs) await sleep(100);
    if (!ch.exited) { ch.kill('SIGKILL'); await sleep(300); }
  };
  S.killAll = async () => {
    for (const ch of [...S.children]) ch.kill('SIGKILL');
    const t0 = Date.now();
    while (S.children.size && Date.now() - t0 < 5000) await sleep(50);
  };
  S.api = async (method, p, body) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${S.TOKEN}` };
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${S.appPort}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, data: json && json.data !== undefined ? json.data : null, error: json && (json.error || json.message), raw: json };
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(1000); // la app puede estar reiniciándose (escenario de interrupción)
      }
    }
  };
  S.teardown = async () => {
    await S.killAll();
    try { await S.db.end(); } catch {}
    spawnSync(`${PGBIN}/pg_ctl`, ['-D', S.dataDir, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    for (const p of Object.values(S.P)) await p.close().catch(() => {});
    await S.sse.close().catch(() => {});
    await S.pfakes.close().catch(() => {});
    await S.fakes.close().catch(() => {});
    fs.rmSync(S.dataDir, { recursive: true, force: true });
  };

  await S.startApp();
  // Conexión YouTube del owner (refresh token cifrado con el AES-256-GCM real) + Google falso.
  process.env.YOUTUBE_TOKEN_SECRET = S.YT_SECRET;
  const { YoutubeTokenService } = D('youtube/youtube-token.service.js');
  const tks = new YoutubeTokenService();
  tks.onModuleInit();
  const enc = tks.encryptRefreshToken('fake-refresh-token-r62');
  await S.q(`insert into public.youtube_connections (user_id, user_email, channel_id, channel_title, encrypted_refresh_token, token_iv, scopes, status, connected_at)
             values ($1, 'r62-owner@example.com', 'UCr62Channel000000000000', 'Canal r62', $2, $3, 'youtube.upload,youtube.readonly', 'active', now())`, [S.OWNER, enc.encrypted, enc.iv]);
  S.fakes.google.refresh.set('fake-refresh-token-r62', 'fake-access-token-r62');
  S.fakes.google.channels.set('fake-access-token-r62', { id: 'UCr62Channel000000000000', title: 'Canal r62 (fake)', thumb: 'https://yt3.fake/r62.jpg' });
  S.fakes.google.fixedVideoId = 'IdwOipZAeqY';
  return S;
}

// ─── curso S (configuración inicial) ─────────────────────────────────────────
const CTX = { sector: 'Minería', pais: 'Chile', ciudad: 'Antofagasta', contexto: 'Técnicos de mantenimiento de planta concentradora', nivel: 'Intermedio', tono: 'cercano y técnico', obj: 'Formar técnicos que mantengan sistemas hidráulicos', comp: 'Diagnostica y mantiene sistemas hidráulicos' };
function courseS(scen) {
  return { key: scen, title: `[R62 ${scen}] Puesta en marcha de bombas`, theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', modules: [
    { title: 'Puesta en marcha de bombas', objective: 'Poner en marcha bombas centrífugas con seguridad', exam: true, chapters: [
      { title: CH1, v: true, a: true, app: 60, objective: 'Cebar una bomba centrífuga antes del arranque' },
      { title: CH2, v: false, a: true, objective: 'Arrancar y detener la bomba siguiendo el procedimiento' },
    ] }] };
}
async function createCourse(S, C) {
  const { keepTeacherDesign } = require(path.join(E2E, 'design-approval.js'));
  const api = S.api;
  const c = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: C.title });
  if (c.status !== 201) throw new Error(`POST /courses/dynamic ${c.status} ${c.error}`);
  const courseId = Number(c.data.id);
  let st = (await api('GET', `/courses/${courseId}/modules`)).data;
  let counter = st.structureVersionCounter;
  for (const m of st.modules) counter = (await api('DELETE', `/courses/${courseId}/modules/${m.id}`, { expectedCounter: counter })).data.structureVersionCounter;
  const setg = await api('PATCH', `/courses/${courseId}/structure-settings`, { finalExam: C.finalExam, activityEngine: C.engine, expectedCounter: counter });
  if (setg.status !== 200) throw new Error(`structure-settings ${setg.status} ${setg.error}`);
  counter = setg.data.structureVersionCounter;
  for (const ms of C.modules) {
    const cm = await api('POST', `/courses/${courseId}/modules`, { title: ms.title, objective: ms.objective, examEnabled: ms.exam, expectedCounter: counter });
    if (cm.status !== 201) throw new Error(`POST module ${cm.status} ${cm.error}`);
    counter = cm.data.structureVersionCounter;
    const mid = cm.data.module.id;
    const auto = cm.data.module.chapters || [];
    for (let i = 0; i < ms.chapters.length; i++) {
      const cs = ms.chapters[i];
      const body = { title: cs.title, objective: cs.objective, videoEnabled: cs.v, activityEnabled: cs.a, expectedCounter: counter };
      if (cs.app) body.applicationMinutes = cs.app;
      const isAuto = i === 0 && auto.length === 1;
      const r = isAuto ? await api('PATCH', `/courses/${courseId}/modules/${mid}/chapters/${auto[0].id}`, body) : await api('POST', `/courses/${courseId}/modules/${mid}/chapters`, body);
      if (![200, 201].includes(r.status)) throw new Error(`capítulo ${cs.title}: ${r.status} ${r.error}`);
      counter = r.data.structureVersionCounter;
    }
  }
  st = (await api('GET', `/courses/${courseId}/modules`)).data;
  const mods = st.modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title })) }));
  const A = D('modules/course-profiles/course-profiles.js');
  const pa = await api('POST', `/courses/${courseId}/profiles/assessment`, { data: { ...A.defaultAssessmentProfile({ finalExam: C.finalExam }), passingGrade: C.passing } });
  if (pa.status !== 201) throw new Error(`profiles/assessment ${pa.status} ${pa.error}`);
  const pp = await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { ...C.theme, brandSeed: null, themeVersion: 1 } });
  if (pp.status !== 201) throw new Error(`profiles/presentation ${pp.status} ${pp.error}`);
  await keepTeacherDesign(api, courseId, C.key);
  st = (await api('GET', `/courses/${courseId}/modules`)).data;
  const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
  if (lock.status !== 201) throw new Error(`lock ${lock.status} ${lock.error}`);
  const n = lock.data.blueprint.blueprintNumber;
  const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
  if (man.status !== 201) throw new Error(`manifest ${man.status} ${man.error}`);
  const llm = S.llm;
  llm.st.courseId = courseId;
  llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
  for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
  return { courseId, n, mods, manifest: man.data.manifest };
}

// ─── observación ─────────────────────────────────────────────────────────────
const AUTO_RECOVERY = new Set(['executor_retry', 'auto_heal', 'safe_auto_retry', 'ambiguous_audio_resubmit', 'auto_regenerate']);
async function snapshot(S, ctx) {
  const run = await S.api('GET', `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs/${ctx.runId}`);
  const [job] = await S.q(`select worker_status, output_summary from public.production_jobs where id = $1`, [ctx.runId]);
  const pkgs = await S.q(`select id, worker_status, input_payload, output_summary, error_message from public.production_jobs where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 order by created_at`, [ctx.runId]);
  const items = (run.data && run.data.items) || [];
  return { run: run.data, runStatus: job && job.worker_status, pause: job && job.output_summary && job.output_summary.pause, items, pkgs };
}
/** ¿Hay algo que el sistema vaya a hacer SOLO? (si no, el run está estancado y solo una persona lo destraba). */
function autonomousWork(snap) {
  // Un run `failed` puede tener partes que el auto-healer va a reabrir solo (p. ej. ambiguous_audio_resubmit): se mira cada parte.
  if (['paused', 'cancelled', 'fatal', 'stopped'].includes(snap.runStatus)) return { pending: false, why: `run ${snap.runStatus}` };
  const byKey = new Map(snap.items.map((i) => [i.itemKey, i]));
  const doomed = new Set();
  for (const i of snap.items) {
    if (i.status !== 'failed' && i.status !== 'cancelled') continue;
    const rec = i.recovery || {};
    const auto = AUTO_RECOVERY.has(rec.currentRecovery) && (rec.maxRounds === null || rec.maxRounds === undefined || Number(rec.round || 0) < Number(rec.maxRounds));
    if (!auto) doomed.add(i.itemKey);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of snap.items) if (!doomed.has(i.itemKey) && i.status !== 'completed' && (i.dependsOn || []).some((d) => doomed.has(d))) { doomed.add(i.itemKey); grew = true; }
  }
  const live = snap.items.filter((i) => i.status !== 'completed' && !doomed.has(i.itemKey));
  if (live.length) return { pending: true, why: `${live.length} partes en curso/cola/recuperación automática` };
  if (doomed.size) return { pending: false, why: `partes que esperan a una persona: ${[...doomed].join(', ')}` };
  // Todo completo: empaque.
  const last = snap.pkgs[snap.pkgs.length - 1];
  if (snap.runStatus === 'completed' && last && last.worker_status === 'failed') return { pending: false, why: `paquete fallido: ${(last.error_message || '').slice(0, 160)}` };
  if (snap.runStatus === 'preview') return { pending: false, why: 'run en vista previa (no entregable)' };
  if (snap.runStatus === 'failed') return { pending: false, why: 'run failed sin partes pendientes' };
  return { pending: true, why: 'empaque/cierre en curso' };
}

// ─── operador (intervención humana/admin, contada) ────────────────────────────
async function operatorAct(S, ctx, snap, reason) {
  const actions = [];
  const base = `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs/${ctx.runId}`;
  const record = (what, r) => { const a = { at: Date.now() - ctx.t0, what, status: r && r.status, error: r && r.error ? String(r.error).slice(0, 200) : null, reason }; actions.push(a); log(`  👤 intervención: ${what} → ${a.status}${a.error ? ` (${a.error})` : ''}`); return a; };
  if (snap.runStatus === 'paused') { record('resume del run', await S.api('POST', `${base}/resume`, {})); return actions; }
  // Reservas pendientes de las partes fallidas: se concilian con la VERDAD del proxy (¿el proveedor la cobró?).
  const failed = snap.items.filter((i) => i.status === 'failed' || i.status === 'cancelled');
  for (const it of failed) {
    const pend = await S.q(`select e.idempotency_key k from public.generation_cost_events e
        where (e.metadata->>'reservation') = 'true' and e.run_id = $1 and e.item_key = $2
          and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`, [ctx.runId, it.itemKey]).catch(() => []);
    for (const p of pend) {
      const kind = /^reservation:(\w[\w-]*):/.exec(p.k);
      const ep = kind && kind[1] === 'llm' ? '/finops/llm-worker-reservations/reconcile' : kind && kind[1] === 'tts' ? '/finops/tts-reservations/reconcile' : kind && kind[1] === 'videogen' ? `/admin/dynamic-runs/${ctx.runId}/videogen-reservations/reconcile` : null;
      if (!ep) continue;
      // Verdad del proxy: si el proveedor de esa reserva cobró alguna llamada sin entregar → charged; si solo hubo
      // rechazos/cortes/cuelgues sin procesar → not_charged.
      const kindOf = { llm: 'anthropic', tts: 'openai_tts', videogen: 'videogen', gamma: 'gamma' }[kind[1]];
      const calls = Object.values(S.P).flatMap((x) => x.st.calls.filter((c) => c.scenario === S.scen && c.kind === kindOf && c.rule));
      const outcome = calls.some((c) => c.outcome === 'served_lost') || !calls.length ? 'charged' : 'not_charged';
      record(`conciliar ${p.k.slice(0, 60)}… (${outcome})`, await S.api('POST', ep, { reservationKey: p.k, outcome, reason: `r62: decisión con la verdad del proxy (${outcome})` }));
    }
    const flags = it.type === 'video' ? [{ resubmitVideo: true }, {}] : ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(it.type) ? [{ resubmitProvider: true }, {}] : [{}];
    for (const f of flags) {
      const r = await S.api('POST', `${base}/items/${encodeURIComponent(it.itemKey)}/retry`, f);
      record(`retry ${it.itemKey.split(':')[0]} ${JSON.stringify(f)} [${String(it.error || '').split(':')[0]}]`, r);
      if (r.status >= 200 && r.status < 300) break;
    }
  }
  const last = snap.pkgs[snap.pkgs.length - 1];
  if (!failed.length && snap.runStatus === 'completed' && (!last || last.worker_status === 'failed')) record('POST package (manual)', await S.api('POST', `${base}/package`));
  if (!actions.length && snap.runStatus === 'failed') record('(sin acción documentada: run failed)', { status: 0 });
  return actions;
}

// ─── un escenario ────────────────────────────────────────────────────────────
async function runScenario(S, sc) {
  const { duplicateReport } = require('./lib/r62-fault-proxy');
  S.scen = sc.id;
  S.envOverride = sc.env || null;
  for (const p of Object.values(S.P)) p.reset(sc.id);
  S.llm.st.invalidSent = {}; S.llm.st.retriesSeen = {}; S.llm.st.unknown = [];
  S.llm.st.tag = sc.id;
  for (const k of ['provider', 'item', 'package']) await S.spawnWorker(k, 'a');
  const res = { id: sc.id, what: sc.what, interventions: 0, actions: [], notes: [] };
  const ctx = { P: S.P, S: {}, stack: S, q: S.q };
  try {
    const C = courseS(sc.id);
    ctx.course = await createCourse(S, C);
    // Política del curso (configuración inicial; sin ella approve-and-start falla cerrado).
    await S.q(`insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
               values ('course', $1, 1, $2::jsonb, true, 'BLOCK', 'r62-setup')`, [String(ctx.course.courseId), JSON.stringify({ maxCostPerRun: 60, maxCostPerCourse: 60 })]);
    // Presencia del worker de IA antes de crear el run (como en staging: el worker vive desde antes).
    const tw = Date.now();
    while (Date.now() - tw < 60_000) {
      const p = await S.q(`select 1 from public.llm_worker_presence where worker_id like $1 and last_seen > now() - interval '60 seconds'`, [`r62-provider-${sc.id}-%-llm`]);
      if (p.length) break;
      await sleep(300);
    }
    const ctxRun = { nombre: C.title, ...CTX, scormTemplateIds: S.templates, videoMode: 'real' };
    const runsBase = `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs`;
    if (sc.setup) sc.setup(ctx);
    const est = await S.api('POST', `${runsBase}/estimate-preview`, ctxRun);
    if (est.status !== 200) throw new Error(`estimate-preview ${est.status} ${est.error}`);
    const start = await S.api('POST', `${runsBase}/approve-and-start`, { ...ctxRun, estimateHash: est.data.estimateHash });
    if (start.status !== 201) throw new Error(`approve-and-start ${start.status} ${start.error}`);
    ctx.runId = start.data.run.id;
    ctx.t0 = Date.now();
    res.runId = ctx.runId;
    res.authorized = start.data.approval && start.data.approval.amount;
    res.estimate = est.data.estimate ? { expected: est.data.estimate.expected, max: est.data.estimate.max } : null;
    log(`[${sc.id}] run ${ctx.runId} autorizado USD ${res.authorized} (esperado ${res.estimate && res.estimate.expected}, máx ${res.estimate && res.estimate.max})`);

    const CAP = sc.capMs || 25 * 60_000;
    const STALL_MS = 20_000;
    const MAX_INTERVENTION_ROUNDS = 6;
    let stallSince = null;
    let lastSig = '';
    let lastChange = Date.now();
    let rounds = 0;
    let capHit = false;
    let delivered = null;
    for (;;) {
      if (sc.tick) await sc.tick(ctx);
      const snap = await snapshot(S, ctx);
      const sig = JSON.stringify([snap.runStatus, snap.items.map((i) => [i.itemKey, i.status, i.attemptCount, i.updatedAt]), snap.pkgs.map((p) => p.worker_status)]);
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
      const last = snap.pkgs[snap.pkgs.length - 1];
      if (snap.runStatus === 'completed' && last && last.worker_status === 'completed' && last.output_summary && last.output_summary.artifactId) {
        delivered = await fetchMbz(S, ctx, last);
        break;
      }
      const w = autonomousWork(snap);
      const elapsed = Date.now() - ctx.t0;
      const quietMs = Date.now() - lastChange;
      let act = false;
      if (!w.pending) { stallSince = stallSince || Date.now(); if (Date.now() - stallSince > STALL_MS) act = `estancado: ${w.why}`; } else stallSince = null;
      if (!act && elapsed > CAP + rounds * 8 * 60_000) { act = `tope de tiempo (${Math.round(elapsed / 60000)} min) sin terminar: ${w.why}`; capHit = true; }
      if (!act && quietMs > 10 * 60_000) act = `10 min sin ningún cambio: ${w.why}`;
      if (act) {
        if (rounds >= MAX_INTERVENTION_ROUNDS) { res.notes.push(`se abandona tras ${rounds} rondas de intervención: ${act}`); break; }
        rounds++;
        log(`[${sc.id}] ${act}`);
        const forced = snap.items.filter((i) => i.status !== 'completed');
        if (capHit && !snap.items.some((i) => i.status === 'failed')) {
          let anyOk = false;
          // Tope de tiempo con partes que siguen «en recuperación» sin terminar nunca (p. ej. video_timeout gratis por 3 h):
          // la persona tendría que forzar el reenvío.
          for (const it of forced.filter((i) => i.type === 'video' || ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(i.type))) {
            const r = await S.api('POST', `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs/${ctx.runId}/items/${encodeURIComponent(it.itemKey)}/retry`, it.type === 'video' ? { resubmitVideo: true } : { resubmitProvider: true });
            const a = { at: Date.now() - ctx.t0, what: `retry forzado ${it.itemKey.split(':')[0]} (${it.status}, ${String(it.error || '').split(':')[0]})`, status: r.status, error: r.error ? String(r.error).slice(0, 200) : null, reason: act };
            res.actions.push(a); log(`  👤 intervención: ${a.what} → ${a.status}${a.error ? ` (${a.error})` : ''}`);
            if (r.status >= 200 && r.status < 300) anyOk = true;
          }
          if (!anyOk) {
            // Ninguna acción de admin disponible sobre una parte que nunca termina: solo queda cancelar el run.
            res.notes.push(`${act}: ninguna acción de admin disponible (retry → 409 mientras la parte sigue «running»); se abandona sin entregar`);
            res.noActionAvailable = true;
            break;
          }
        } else res.actions.push(...(await operatorAct(S, ctx, snap, act)));
        stallSince = null; lastChange = Date.now();
        res.stalls = (res.stalls || []).concat([{ at: Date.now() - ctx.t0, why: act, items: snap.items.filter((i) => i.status !== 'completed').map((i) => ({ key: i.itemKey.split(':')[0], st: i.status, err: String(i.error || '').slice(0, 140), rec: i.recovery && i.recovery.currentRecovery, cls: i.recovery && i.recovery.class })) }]);
      }
      await sleep(1000);
    }
    res.ms = Date.now() - ctx.t0;
    res.interventions = res.actions.filter((a) => a.status >= 200 && a.status < 300).length;
    res.failedActions = res.actions.filter((a) => !(a.status >= 200 && a.status < 300)).length;
    res.delivered = !!(delivered && delivered.ok);
    res.mbz = delivered;
    // Estado final.
    const snap = await snapshot(S, ctx);
    res.runStatus = snap.runStatus;
    res.items = snap.items.map((i) => ({ key: i.itemKey.split(':')[0], status: i.status, attempts: i.attemptCount, error: i.error ? String(i.error).slice(0, 160) : null, worker: (i.outputSummary && i.outputSummary.generatedBy) || null }));
    const rows = await S.q(`select item_key, type, status, worker_id, chapter_id, attempt_count from public.generation_item_runs where job_id = $1`, [ctx.runId]);
    res.workersSeen = [...new Set(rows.map((r) => r.worker_id).filter(Boolean))].sort();
    res.itemsCompleted = rows.filter((r) => r.status === 'completed').length;
    res.itemsTotal = rows.length;
    res.itemTypes = [...new Set(rows.map((r) => r.type))].sort();
    if (sc.verify) res.verify = await sc.verify(ctx, rows);
    // FinOps: ledger ≤ autorizado; reservas abiertas / huérfanas.
    const [led] = await S.q(`select coalesce(sum(amount),0)::float8 committed,
        coalesce(sum(amount) filter (where coalesce(metadata->>'reservation','false') <> 'true' and event_kind = 'CHARGE'),0)::float8 charges
        from public.generation_cost_events where run_id = $1`, [ctx.runId]);
    const auths = await S.q(`select authorized_budget::float8 b, decision from public.cost_budget_authorizations where run_id = $1 or (course_id = $2 and run_id is null) order by created_at`, [ctx.runId, ctx.course.courseId]);
    res.ledger = { committedUsd: led.committed, authorizedUsd: res.authorized !== null && res.authorized !== undefined ? Number(res.authorized) : (auths.length ? auths[auths.length - 1].b : null), authorizations: auths.map((a) => `${a.decision}:${a.b}`) };
    res.ledger.withinAuthorized = res.ledger.authorizedUsd === null ? null : res.ledger.committedUsd <= res.ledger.authorizedUsd + 1e-9;
    const open = await S.q(`select e.idempotency_key k, e.amount::float8 amount, e.item_key, g.status item_status, g.error item_error
        from public.generation_cost_events e left join public.generation_item_runs g on g.job_id = e.run_id and g.item_key = e.item_key
        where e.run_id = $1 and (e.metadata->>'reservation') = 'true' and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`, [ctx.runId]);
    res.openReservations = open.map((o) => ({ key: o.k.split(':').slice(0, 2).join(':'), item: String(o.item_key || '').split(':')[0], itemStatus: o.item_status, usd: o.amount, clear: o.item_status === 'failed' && /reconcil|pending_review|ambiguous|hold/i.test(String(o.item_error || '')) }));
    res.orphanReservations = res.openReservations.filter((o) => !o.clear).length;
    // Llamadas pagadas duplicadas (por clave lógica, en los 3 proxies).
    const calls = Object.values(S.P).flatMap((p) => p.st.calls.filter((c) => c.scenario === sc.id));
    const dr = duplicateReport(calls);
    res.paidCalls = dr.paidCalls;
    res.duplicatePaid = dr.dup;
    res.ambiguousThenPaid = dr.ambiguousThenPaid;
    const inj = new Map();
    for (const c of calls.filter((x) => x.rule)) inj.set(`${c.rule}:${c.outcome}`, (inj.get(`${c.rule}:${c.outcome}`) || 0) + 1);
    res.injected = [...inj].map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
    res.calls = calls.filter((c) => c.kind).map((c) => ({ t: c.at - ctx.t0, kind: c.kind, key: c.key, outcome: c.outcome, rule: c.rule || null, ms: c.end ? c.end - c.at : null, snippet: c.snippet.slice(0, 120) }));
    const blocked = fs.readFileSync(NET_LOG, 'utf8').trim();
    res.netViolations = blocked ? blocked.split('\n').length : 0;
  } catch (e) {
    res.error = String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
    log(`[${sc.id}] ERROR ${res.error}`);
  } finally {
    // Cierre: run cancelado si quedó vivo (no contamina el siguiente escenario) y workers nuevos para el próximo.
    if (ctx.runId && res.runStatus && !['completed', 'cancelled', 'failed'].includes(res.runStatus)) {
      await S.api('POST', `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs/${ctx.runId}/cancel`).catch(() => null);
    }
    for (const k of ['provider', 'item', 'package']) await S.stopWorker(k, 8000);
    if (S.app && S.app.exited) await S.startApp().catch(() => null);
    fs.writeFileSync(path.join(OUT, `scenario-${sc.id}.json`), JSON.stringify(res, null, 1));
  }
  return res;
}

async function fetchMbz(S, ctx, job) {
  const st = await S.api('GET', `/courses/${ctx.course.courseId}/blueprints/${ctx.course.n}/manifest/runs/${ctx.runId}/package`);
  const out = { jobId: job.id, deliverable: st.data && st.data.deliverable, ok: false };
  if (!(st.data && st.data.downloadUrl)) { out.why = `sin downloadUrl (${st.status} ${st.error})`; return out; }
  const buf = Buffer.from(await (await fetch(st.data.downloadUrl)).arrayBuffer());
  const file = path.join(OUT, `${S.scen}.mbz`);
  fs.writeFileSync(file, buf);
  const [art] = await S.q(`select metadata from public.artifacts where id = $1`, [job.output_summary.artifactId]);
  const validated = art && art.metadata && art.metadata.validatedSha256;
  const JSZip = R('jszip');
  let zipOk = false;
  try { const z = await JSZip.loadAsync(buf); zipOk = !!z.file('moodle_backup.xml') && !!z.file('files.xml'); } catch {}
  Object.assign(out, { bytes: buf.length, sha256: shaHex(buf), validatedSha256: validated || null, validateMbzV3: !!validated && validated === shaHex(buf), zipOk, file });
  out.ok = out.deliverable === true && out.validateMbzV3 && zipOk;
  if (!out.ok) out.why = `deliverable=${out.deliverable} validateMbzV3=${out.validateMbzV3} zip=${zipOk}`;
  return out;
}

// ─── tabla + salida ──────────────────────────────────────────────────────────
function finish(results) {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const lines = [];
  lines.push(`\nr62 autonomía E2E — ${LABEL} — ${new Date().toISOString()}`);
  lines.push(`${pad('escenario', 26)} ${pad('interv', 6)} ${pad('run', 10)} ${pad('partes', 7)} ${pad('.mbz', 5)} ${pad('dupPag', 6)} ${pad('amb→pag', 7)} ${pad('ledger≤aut', 18)} ${pad('resAb/huérf', 11)} ${pad('min', 5)}`);
  for (const r of results) {
    if (r.error && !r.runStatus) { lines.push(`${pad(r.id, 26)} ERROR ${r.error.slice(0, 160)}`); continue; }
    const led = r.ledger ? `${r.ledger.withinAuthorized ? 'sí' : 'NO'} ${r.ledger.committedUsd.toFixed(2)}/${r.ledger.authorizedUsd}` : '?';
    lines.push(`${pad(r.id, 26)} ${pad(r.interventions, 6)} ${pad(r.runStatus, 10)} ${pad(`${r.itemsCompleted}/${r.itemsTotal}`, 7)} ${pad(r.delivered ? 'sí' : 'NO', 5)} ${pad((r.duplicatePaid || []).length, 6)} ${pad((r.ambiguousThenPaid || []).length, 7)} ${pad(led, 18)} ${pad(`${(r.openReservations || []).length}/${r.orphanReservations}`, 11)} ${pad(((r.ms || 0) / 60000).toFixed(1), 5)}`);
  }
  lines.push('\nDetalle:');
  for (const r of results) {
    lines.push(`- ${r.id}: ${r.what || ''}`);
    if (r.error) lines.push(`    error: ${r.error.slice(0, 400)}`);
    if (r.injected && r.injected.length) lines.push(`    inyectado: ${r.injected.join(', ')}`);
    for (const a of r.actions || []) lines.push(`    👤 ${a.what} → ${a.status}${a.error ? ` ${a.error}` : ''}  [${a.reason}]`);
    for (const s of r.stalls || []) lines.push(`    ⏸ ${Math.round(s.at / 1000)} s: ${s.why} :: ${s.items.map((i) => `${i.key}/${i.st}/${i.rec}/${i.err.split(':')[0]}`).join('; ')}`);
    for (const d of r.duplicatePaid || []) lines.push(`    💸 cobro duplicado ${d.kind} ×${d.billed} (${d.outcomes.join('→')}) «${d.snippet}»`);
    for (const d of r.ambiguousThenPaid || []) lines.push(`    ⚠️ ambiguo y reenviado ${d.kind} (${d.outcomes.join('→')})`);
    for (const o of r.openReservations || []) lines.push(`    🧾 reserva abierta ${o.key} (${o.item}, parte ${o.itemStatus}, USD ${o.usd})${o.clear ? '' : ' HUÉRFANA'}`);
    if (r.verify) lines.push(`    verificación: ${JSON.stringify(r.verify)}`);
    if (r.mbz && !r.delivered) lines.push(`    .mbz: ${r.mbz.why || JSON.stringify(r.mbz).slice(0, 200)}`);
    for (const n of r.notes || []) lines.push(`    nota: ${n}`);
    const bad = (r.items || []).filter((i) => i.status !== 'completed');
    if (bad.length) lines.push(`    partes no completas: ${bad.map((i) => `${i.key}/${i.status}/${String(i.error || '').split(':')[0]}`).join('; ')}`);
    if (r.netViolations) lines.push(`    ❌ netguard: ${r.netViolations} conexiones bloqueadas fuera de 127.0.0.1`);
  }
  const unnecessary = results.filter((r) => r.error || !r.delivered || (r.interventions > 0 && !JUSTIFIED[r.id]));
  const dups = results.reduce((n, r) => n + (r.duplicatePaid || []).length, 0);
  const okN = results.filter((r) => !r.error && r.delivered && r.interventions === 0).length;
  lines.push(`\nRESULTADO ${LABEL}: ${okN}/${results.length} escenarios autónomos (0 intervenciones y .mbz entregado); ${unnecessary.length} con intervención/sin entrega; ${dups} cobros duplicados por clave lógica`);
  const txt = lines.join('\n');
  console.log(txt);
  fs.writeFileSync(path.join(OUT, 'results.txt'), txt + '\n');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(unnecessary.length ? 1 : 0);
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(path.join(DIST, 'main.js'))) { console.error(`❌ falta ${DIST}/main.js (npm run build)`); process.exit(2); }
  if (!fs.existsSync(path.join(FE, 'src/js/45-dynamic-generation-executor.js'))) { console.error(`❌ frontend no encontrado en ${FE} (--fe=)`); process.exit(2); }
  const list = SCENARIOS.filter((s) => !ONLY || ONLY.test(s.id));
  const stack = await createStack(`${process.pid}`);
  const results = [];
  try {
    for (const sc of list) {
      log(`══ ${sc.id}: ${sc.what}`);
      const r = await runScenario(stack, sc);
      log(`── ${sc.id}: interventions=${r.interventions} delivered=${r.delivered} run=${r.runStatus} ${((r.ms || 0) / 60000).toFixed(1)} min`);
      results.push(r);
    }
  } finally {
    await stack.teardown().catch((e) => log(`teardown: ${e.message}`));
  }
  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(results)); process.exit(0); }
  finish(results);
})().catch((e) => { console.error(e); process.exit(2); });
