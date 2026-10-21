#!/usr/bin/env node
/* eslint-disable */
// Review r1 (REVIEW-r1.md) — arreglos I-1..I-3 y M-1..M-7 (USD 0, sin red, sin proveedores).
//
// Parte pura (siempre; --pure-only para CI):
//   [I-1] ruta de rebuild `<clave>.<sha16>.mbz`, reuse acepta canónica o variante, `object_missing` (404/400) vs
//         `download_failed` (transitorio), clasificación A de PACKAGE_REUSE_VERIFY_UNAVAILABLE / PACKAGE_OBJECT_CONFLICT;
//   [I-3] /youtube/upload-from-url en dry-run: solo sintaxis (preflight-test.local pasa) con la barrera de red ESTRICTA
//         (0 intentos: ni DNS); sin dry-run el mismo host se rechaza por la lista blanca antes de cualquier DNS;
//   [M-1] procedencia del texto: URL base no oficial de Anthropic → worker `mock`; ejecutor del navegador/vendor
//         (`window.CURSIA_LLM_MODE` / `api.__cursiaLlmMode`) → metadata + resumen;
//   [M-2] worker on/off cambia JUNTOS el worker de proveedores y el de IA (también tras un deploy con HOLD);
//   [M-3] reanudación H4: solo bloquea con proveedores pagados reales pendientes;
//   [M-4] verificación de email de admin: sin fila en auth.users (o ilegible) → claim del JWT; fila sin confirmar → 403;
//   [M-6] Q7 no medido = pass null (neutral) y compareQualityReports no lo trata como «dejó de pasar».
// Parte DB (default; PG16 desechable en puerto libre ≠ 5570 / 8099; Storage falso en memoria):
//   [I-1] paquete entregado A (sin checksum, pre-r58) + job nuevo → los bytes de A quedan intactos y el rebuild va a una
//         ruta NUEVA con un row nuevo; un job siguiente reutiliza el rebuild; Storage 503 al verificar → (r62 K4) el job
//         reconstruye en otra ruta nueva sin tocar A ni el rebuild anterior (antes: job fallido
//         PACKAGE_REUSE_VERIFY_UNAVAILABLE); carrera sobre una ruta referenciada →
//         PACKAGE_OBJECT_CONFLICT sin tocar el objeto; M-7: el claim de la Actividad de Aplicación lee el perfil de
//         evaluación congelado al crear el run.
//
// Usage: npm run build && node scripts/check-r58-review-r1.js [--pure-only] [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const vm = require('vm');
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
Logger.overrideLogger({ log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });
const NG = require('./lib/netguard');

// Sin red: fetch solo hacia el Storage falso en memoria (host reservado .test, nunca sale del proceso).
const FAKE_SUPABASE = 'https://storage.r58r1.test';
const storage = { objects: new Map(), getStatus: null, calls: [] };
global.fetch = async (u, init = {}) => {
  const s = String(u);
  if (!s.startsWith(FAKE_SUPABASE + '/storage/v1/object/')) throw new Error(`NETWORK FORBIDDEN in check: ${s}`);
  const method = (init.method || 'GET').toUpperCase();
  storage.calls.push({ method, url: s });
  const m = s.match(/\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/);
  const key = `${m[1]}/${decodeURIComponent(m[2]).split('/').map(decodeURIComponent).join('/')}`;
  if (method === 'POST') {
    const upsert = (init.headers || {})['x-upsert'] !== 'false';
    if (storage.objects.has(key) && !upsert) return new Response(JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }), { status: 400 });
    storage.objects.set(key, Buffer.from(init.body));
    return new Response(JSON.stringify({ Key: key }), { status: 200 });
  }
  if (method === 'HEAD') {
    const o = storage.objects.get(key);
    return o ? new Response(null, { status: 200, headers: { 'content-length': String(o.length) } }) : new Response(null, { status: 404 });
  }
  if (storage.getStatus) return new Response('unavailable', { status: storage.getStatus });
  const o = storage.objects.get(key);
  return o ? new Response(o, { status: 200 }) : new Response('not found', { status: 404 });
};

const RV = loadDist('modules/dynamic-packaging/package-reuse-verify.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const G = loadDist('config/provider-base-url-guard.js');
const LW = loadDist('workers/dynamic-llm-worker.js');
const RC = loadDist('modules/dynamic-generation/run-completion.js');
const PROD_REF = loadDist('modules/dynamic-generation/dynamic-video-delivery.js').PRODUCTION_SUPABASE_REF;
const RB = loadDist('modules/finops/run-budget.js');
const QB = loadDist('modules/quality/quality-battery.js');

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
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsWith(p, re, m) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err && re.test(String(err.message || '') + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '')), `${m}: ${err ? err.message : 'no lanzó'}`);
  return err;
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  console.log('\n=== I-1: nunca se sobrescribe un paquete entregado ===');
  const EXP = { ownerId: 'o1', courseId: 'fc', manifestId: 7, runId: 'r1', sourceIdsHash: 'h1', qa: false };
  const CANON = 'o1/dynamic/fc/7/dynamic_mbz/r1/h1.mbz';
  await check('I-1 ruta de rebuild = misma carpeta + `<clave>.<sha16>.mbz`; el reuse acepta la canónica o esa variante y nada más', () => {
    const s = 'ab'.repeat(32);
    eq(RV.rebuildDynamicMbzPath(CANON, s), `o1/dynamic/fc/7/dynamic_mbz/r1/h1.${s.slice(0, 16)}.mbz`, 'rebuild');
    assert(RV.isCanonicalDynamicMbzPath(CANON, EXP) && RV.isCanonicalDynamicMbzPath(RV.rebuildDynamicMbzPath(CANON, s), EXP), 'canónica + variante');
    for (const bad of [`${CANON}x`, 'o1/dynamic/fc/7/dynamic_mbz/r1/h1.ABCDEF0123456789.mbz', 'o1/dynamic/fc/7/dynamic_mbz/r1/h1.0123.mbz',
      'o1/dynamic/fc/7/dynamic_mbz/r1/h1.0123456789abcdef.0123456789abcdef.mbz', 'o1/dynamic/fc/7/dynamic_mbz/r2/h1.mbz', null]) {
      assert(!RV.isCanonicalDynamicMbzPath(bad, EXP), `rechaza ${bad}`);
    }
    let threw = false; try { RV.rebuildDynamicMbzPath(CANON, 'xyz'); } catch { threw = true; }
    assert(threw, 'sha inválido → lanza');
  });
  await check('I-1 chooseDynamicMbzUploadPath: canónica libre → canónica; referenciada por un artifact → variante con el sha del build', async () => {
    const s = 'cd'.repeat(32);
    eq(await RV.chooseDynamicMbzUploadPath({ async isStoragePathReferenced() { return false; } }, CANON, s), { storagePath: CANON, rebuilt: false }, 'libre');
    const seen = [];
    eq(await RV.chooseDynamicMbzUploadPath({ async isStoragePathReferenced(b, p) { seen.push([b, p]); return true; } }, CANON, s), { storagePath: RV.rebuildDynamicMbzPath(CANON, s), rebuilt: true }, 'referenciada');
    eq(seen, [['cursia-artifacts', CANON]], 'consulta bucket + ruta canónica');
  });
  await check('I-1 verificación del candidato: 404/400 → object_missing (se reconstruye); otro fallo de Storage → download_failed (transitorio)', async () => {
    const bytes = Buffer.from('x');
    const row = { id: 'a', storageBucket: 'cursia-artifacts', storagePath: CANON, checksumSha256: sha(bytes), metadata: {} };
    const dl = (msg) => ({ async downloadStorageObject() { throw new Error(msg); } });
    eq(await RV.verifyReusableDynamicMbz(dl('Supabase Storage download failed: 404 cursia-artifacts/x'), row, EXP, { requireValidated: false }), { ok: false, reason: 'object_missing' }, '404');
    eq(await RV.verifyReusableDynamicMbz(dl('Supabase Storage download failed: 400 cursia-artifacts/x'), row, EXP, { requireValidated: false }), { ok: false, reason: 'object_missing' }, '400');
    for (const m of ['Supabase Storage download failed: 503 cursia-artifacts/x', 'The operation was aborted due to timeout', 'fetch failed']) {
      eq(await RV.verifyReusableDynamicMbz(dl(m), row, EXP, { requireValidated: false }), { ok: false, reason: 'download_failed' }, m);
    }
    const variant = { ...row, storagePath: RV.rebuildDynamicMbzPath(CANON, sha(bytes)) };
    eq(await RV.verifyReusableDynamicMbz({ async downloadStorageObject() { return bytes; } }, variant, EXP, { requireValidated: false }), { ok: true }, 'variante reutilizable');
  });
  await check('I-1 clasificación: PACKAGE_REUSE_VERIFY_UNAVAILABLE y PACKAGE_OBJECT_CONFLICT → clase A (package_transient, repackage), clasificados', () => {
    for (const code of ['PACKAGE_REUSE_VERIFY_UNAVAILABLE', 'PACKAGE_OBJECT_CONFLICT']) {
      assert(FC.isFailureCodeClassified(code), `${code} clasificado`);
      const v = FC.classifyFailure({ error: `${code}: detalle`, source: 'package_worker' });
      eq([v.class, v.strategy, v.ruleId ?? v.rule ?? 'package_transient'], ['A', 'repackage', 'package_transient'], code);
    }
  });

  console.log('\n=== I-3: dry-run de upload-from-url sin red ===');
  await check('I-3 dry-run con https://preflight-test.local (preflight del frontend) → OK con la barrera ESTRICTA (0 intentos de red, ni DNS); sin dry-run → download_url_not_allowed por la lista blanca, sin DNS', async () => {
    const { YoutubeController } = loadDist('youtube/youtube.controller.js');
    const yc = new YoutubeController({ async getConnection() { return { status: 'active', channelId: 'UC1', channelTitle: 'Canal' }; } }, {}, { async uploadFromUrl() { throw new Error('no debe subir'); } });
    const body = { dryRun: true, download_url: 'https://preflight-test.local/dummy-video.mp4', title: 'Preflight', privacy_status: 'unlisted', chapter_number: 1 };
    const savedFetch = global.fetch;
    const b = NG.installNetworkBarrier({ label: 'r58-r1-I3' });
    try {
      await withEnv({ SUPABASE_URL: 'https://proj.supabase.co', VIDEOGEN_API_URL: 'https://videosb.nomaddi.com', YOUTUBE_UPLOAD_ALLOWED_HOSTS: undefined }, async () => {
        const r = await yc.uploadFromUrl({ id: 'u1' }, body);
        eq([r.dry_run, r.video_id, r.chapter_number], [true, 'dry_test_ok', 1], 'dry-run OK');
        const viaHeader = await yc.uploadFromUrl({ id: 'u1' }, { ...body, dryRun: undefined }, 'true');
        eq(viaHeader.dry_run, true, 'dry-run por header');
        // QA dry-run (29-qa-dry-run.js): host real de Videogen → tampoco consulta DNS.
        eq((await yc.uploadFromUrl({ id: 'u1' }, { ...body, download_url: 'https://videosb.nomaddi.com/dry-run/cap1.mp4' })).dry_run, true, 'QA dry-run');
        eq(b.attempts, [], 'cero intentos de red en dry-run (sin DNS)');
        // La sintaxis sigue validándose en dry-run.
        for (const u of ['http://preflight-test.local/x.mp4', 'https://u:p@preflight-test.local/x.mp4', 'nada-de-url']) {
          await rejectsWith(yc.uploadFromUrl({ id: 'u1' }, { ...body, download_url: u }), /download_url|https|credenciales|inválida|requerido/, `dry-run sintaxis ${u}`);
        }
        // Sin dry-run: el host del preflight no está en la lista blanca → rechazo ANTES de resolver.
        await rejectsWith(yc.uploadFromUrl({ id: 'u1' }, { ...body, dryRun: false }), /download_url_not_allowed/, 'real: host fuera de la lista');
        eq(b.attempts, [], 'el rechazo por lista blanca no consulta DNS');
      });
    } finally { b.uninstall(); global.fetch = savedFetch; }
    const fe = path.resolve(REPO, '..', 'fe', 'src', 'js', '30-ve-preflight.js');
    if (fs.existsSync(fe)) assert(fs.readFileSync(fe, 'utf8').includes("download_url:   'https://preflight-test.local/dummy-video.mp4'") && /dryRun:\s+true/.test(fs.readFileSync(fe, 'utf8')), 'el preflight del frontend sigue mandando ese host en dry-run');
  });

  console.log('\n=== M-1: procedencia del texto de IA ===');
  await check('M-1 anthropicLlmModeForBaseUrl / workerLlmMode: oficial o ausente → real; fake local / http / otro host / puerto → mock; explícito gana', () => {
    for (const u of [undefined, '', '  ', 'https://api.anthropic.com', 'https://api.anthropic.com/', 'https://API.anthropic.com/v1']) eq(G.anthropicLlmModeForBaseUrl(u), 'real', `real ${u}`);
    for (const u of ['http://127.0.0.1:8787', 'https://api.anthropic.com.evil.test', 'https://api.anthropic.com:8443', 'http://api.anthropic.com', 'nota-una-url', 'https://u:p@api.anthropic.com']) eq(G.anthropicLlmModeForBaseUrl(u), 'mock', `mock ${u}`);
    eq([LW.workerLlmMode({ baseUrl: 'https://api.anthropic.com' }), LW.workerLlmMode({ baseUrl: 'http://127.0.0.1:1' }), LW.workerLlmMode({ baseUrl: 'https://api.anthropic.com', llmMode: 'replay' })], ['real', 'mock', 'replay'], 'worker');
    const src = fs.readFileSync(path.join(REPO, 'src/workers/dynamic-llm-worker.ts'), 'utf8');
    assert(/llmMode: anthropicLlmModeForBaseUrl\(process\.env\.ANTHROPIC_API_BASE_URL, process\.env\)/.test(src), 'el loop deriva el modo de la URL base (+ flag de proveedor real)');
    assert(/generatedBy: 'llm-worker', \.\.\.\(llmMode !== 'real' \? \{ llmMode \} : \{\}\)/.test(src), 'el resumen del complete lleva llmMode no real');
    assert(/\.\.\.\(workerLlmMode\(deps\) !== 'real' \? \{ llmMode: workerLlmMode\(deps\) \} : \{\}\)/.test(src), 'la metadata del artifact lleva llmMode no real');
  });
  await check('r2 m4 ANTHROPIC_BASE_URL_IS_REAL_PROVIDER: override + flag → real (fuera de prod); sin flag → mock; prod sin escape o http → mock (flag ignorado)', () => {
    const FAKE = 'http://127.0.0.1:8787';
    const PROXY = 'https://llm-gw.example.test';
    const F = G.ANTHROPIC_BASE_URL_IS_REAL_PROVIDER_ENV;
    eq(F, 'ANTHROPIC_BASE_URL_IS_REAL_PROVIDER', 'nombre');
    const prod = { SUPABASE_URL: `https://${PROD_REF}.supabase.co` };
    const cases = [
      [FAKE, undefined, 'mock'], [FAKE, {}, 'mock'], [FAKE, { [F]: 'false' }, 'mock'], [FAKE, { [F]: '1' }, 'mock'], [FAKE, { [F]: 'TRUE' }, 'mock'],
      [FAKE, { [F]: 'true' }, 'real'], [PROXY, { [F]: 'true' }, 'real'],
      [PROXY, { ...prod, [F]: 'true' }, 'mock'], // producción sin el escape: ignorado
      [PROXY, { ...prod, [F]: 'true', ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION: 'true' }, 'real'],
      [FAKE, { ...prod, [F]: 'true', ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION: 'true' }, 'mock'], // http en producción: nunca real
      [PROXY, { ...prod, ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION: 'true' }, 'mock'], // el escape solo NO declara real
      ['https://api.anthropic.com', {}, 'real'], [undefined, { [F]: 'true' }, 'real'],
    ];
    for (const [u, env, want] of cases) eq(G.anthropicLlmModeForBaseUrl(u, env), want, `${u} ${JSON.stringify(env)}`);
  });
  await check('r2 m4 camino de decisión (E24e vs fake sin flag): modo del worker → output_summary → classifyRunItems/evaluateRunCompletion', () => {
    const FAKE = 'http://127.0.0.1:8787';
    const manifest = { rulesVersion: 2, items: [{ key: 'content:a', type: 'content' }, { key: 'exam:m', type: 'exam' }, { key: 'final_exam:f', type: 'final_exam' }] };
    const job = { input_payload: {}, worker_status: 'completed', status: 'completed' };
    const run = (env) => {
      // = runLlmWorkerLoop: deps.llmMode = anthropicLlmModeForBaseUrl(URL, env); processLlmItem: resumen con llmMode si no es real.
      const mode = LW.workerLlmMode({ baseUrl: FAKE, llmMode: G.anthropicLlmModeForBaseUrl(FAKE, env) });
      const summary = { generatedBy: 'llm-worker', ...(mode !== 'real' ? { llmMode: mode } : {}) };
      const rows = manifest.items.map((it) => ({ item_key: it.key, status: 'completed', output_summary: summary, finished_at: new Date().toISOString() }));
      const cls = RC.classifyRunItems(job, new Map(rows.map((r) => [r.item_key, r])), manifest);
      return { mode, classes: [...new Set(cls.values())], complete: RC.evaluateRunCompletion(job, rows, manifest, null, {}).generationComplete };
    };
    eq(run({ ANTHROPIC_BASE_URL_IS_REAL_PROVIDER: 'true' }), { mode: 'real', classes: ['done'], complete: true }, 'E24e (worker 3 con el flag): final posible');
    eq(run({}), { mode: 'mock', classes: ['preview'], complete: false }, 'fake sin flag: vista previa, nunca final (R2)');
    const e2e = fs.readFileSync(path.join(REPO, 'test/e2e-v2/e2e-v3.js'), 'utf8');
    const flagged = e2e.split('\n').filter((l) => l.includes("ANTHROPIC_BASE_URL_IS_REAL_PROVIDER: 'true'"));
    assert(flagged.length === 1 && /spawnProc\('llm-worker-3'/.test(flagged[0]), 'e2e: solo el worker 3 (E24e/E24s) declara la IA falsa como proveedor real');
    assert(!/ANTHROPIC_BASE_URL_IS_REAL_PROVIDER/.test(e2e.slice(e2e.indexOf('const wEnv = (id) =>'), e2e.indexOf('const waitFor = async (label'))), 'e2e: wEnv base sin el flag');
    assert(/E24g: override sin el flag de proveedor real → llmMode=mock/.test(e2e), 'e2e: E24g verifica el lado mock');
  });
  await check('M-1 ejecutor del navegador (vendor, mismo archivo que el frontend): sin marca → real; CURSIA_LLM_MODE / api.__cursiaLlmMode → mock|replay; valores raros → real; metadata + resumen cableados', () => {
    const file = path.join(REPO, 'vendor/dynamic-executor/45-dynamic-generation-executor.js');
    const code = fs.readFileSync(file, 'utf8');
    const mode = (setup) => {
      const ctx = { console: { log() {}, warn() {}, error() {} } };
      ctx.window = ctx;
      setup(ctx);
      vm.createContext(ctx);
      vm.runInContext(code, ctx);
      return ctx._dynExecutorLlmMode();
    };
    eq(mode(() => {}), 'real', 'sin marca');
    eq(mode((c) => { c.CURSIA_LLM_MODE = 'mock'; }), 'mock', 'window mock');
    eq(mode((c) => { c.CURSIA_LLM_MODE = 'replay'; }), 'replay', 'window replay');
    eq(mode((c) => { c.CURSIA_LLM_MODE = 'MOCK'; }), 'real', 'mayúsculas no cuentan');
    eq(mode((c) => { c.api = function () {}; c.api.__cursiaLlmMode = 'mock'; }), 'mock', 'api marcado');
    eq(mode((c) => { c.api = function () {}; c.api.__cursiaLlmMode = 'fake'; }), 'real', 'marca desconocida');
    assert(/var llmMode = _dynExecutorLlmMode\(\);\s*if \(llmMode !== 'real'\) meta\.llmMode = llmMode;/.test(code), 'uploadClaimedArtifact marca la metadata');
    assert(/var execLlmMode = _dynExecutorLlmMode\(\);\s*if \(execLlmMode !== 'real'\) summary\.llmMode = execLlmMode;/.test(code), 'el complete marca el resumen');
    const fe = path.resolve(REPO, '..', 'fe', 'src', 'js', '45-dynamic-generation-executor.js');
    if (fs.existsSync(fe)) eq(sha(fs.readFileSync(fe)), sha(Buffer.from(code)), 'vendor = frontend');
  });

  console.log('\n=== M-2: worker on/off consistente ===');
  await check('M-2 workerEnvText: off apaga proveedores + IA + HOLD; on enciende ambos (también tras un deploy con HOLD que dejó la IA en false); idempotente; el deploy y la acción cubren ambos', () => {
    const C = require('./staging-v21-calibration.js');
    eq(C.WORKER_TOGGLE_KEYS, ['DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_LLM_WORKER_ENABLED'], 'claves');
    const off = C.workerEnvText('A=1\nDYNAMIC_PROVIDER_WORKER_ENABLED=true\nDYNAMIC_LLM_WORKER_ENABLED=true\n', 'off');
    eq(off.text, 'A=1\nDYNAMIC_PROVIDER_WORKER_ENABLED=false\nDYNAMIC_LLM_WORKER_ENABLED=false\nDYNAMIC_WORKERS_HOLD=true\n', 'off');
    eq(off.changes.map((c) => c.key), ['DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_LLM_WORKER_ENABLED', 'DYNAMIC_WORKERS_HOLD'], 'cambios off');
    // Lo que deja un deploy con HOLD: ambos en false + HOLD=true. worker_on levanta los dos y el HOLD.
    const afterDeploy = 'DYNAMIC_PROVIDER_WORKER_ENABLED=false\nDYNAMIC_WORKERS_HOLD=true\nDYNAMIC_LLM_WORKER_ENABLED=false\n';
    const on = C.workerEnvText(afterDeploy, 'on');
    eq(on.text, 'DYNAMIC_PROVIDER_WORKER_ENABLED=true\nDYNAMIC_WORKERS_HOLD=false\nDYNAMIC_LLM_WORKER_ENABLED=true\n', 'on tras deploy con HOLD');
    eq(C.workerEnvText(on.text, 'on').changes, [], 'idempotente');
    eq(C.workerEnvText('X=1\n', 'on').text, 'X=1\nDYNAMIC_PROVIDER_WORKER_ENABLED=true\nDYNAMIC_LLM_WORKER_ENABLED=true\n', 'on sin HOLD: no lo crea');
    let threw = false; try { C.workerEnvText('', 'maybe'); } catch { threw = true; }
    assert(threw, 'modo inválido');
    const wf = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
    assert(/ensure_env_exact DYNAMIC_PROVIDER_WORKER_ENABLED "\$_DYN_WORKERS"/.test(wf) && /ensure_env_exact DYNAMIC_LLM_WORKER_ENABLED "\$_DYN_WORKERS"/.test(wf), 'el deploy respeta el HOLD para ambos');
    assert(/staging-v21-calibration\.js worker "\$_MODE"\s*\n\s*sudo pm2 restart cursia-dynamic-provider-worker-staging --update-env/.test(wf), 'la acción reinicia el proceso que hospeda ambos workers');
  });

  console.log('\n=== M-3: reanudación H4 solo con pagados reales pendientes ===');
  await check('M-3 pendingPendingPaidRealProviders: lo que falta decide (video/presentación/audio reales); LLM, mock o ya generados → ninguno', () => {
    const items = [
      { key: 'content:c1', type: 'content', chapterId: 'c1', moduleId: 'm' },
      { key: 'video:c1', type: 'video', chapterId: 'c1', moduleId: 'm' },
      { key: 'presentation:c1', type: 'presentation', chapterId: 'c1', moduleId: 'm' },
      { key: 'audio_welcome', type: 'audio_welcome' },
    ];
    const real = RB.runSpendModes('real', null);
    eq(RB.pendingPaidRealProviders(items, new Map(), real), ['gamma', 'openai', 'videogen'], 'nada generado');
    const st = new Map([['video:c1', 'completed'], ['presentation:c1', 'completed'], ['audio_welcome', 'cancelled'], ['content:c1', 'failed']]);
    eq(RB.pendingPaidRealProviders(items, st, real), [], 'solo queda IA');
    eq(RB.pendingPaidRealProviders(items, new Map([['video:c1', 'completed']]), RB.runSpendModes('mock', { presentation: 'mock', audio: 'mock' })), [], 'todo mock');
    eq(RB.pendingPaidRealProviders(items, new Map([['presentation:c1', 'running']]), RB.runSpendModes('mock', null)), ['gamma', 'openai'], 'video mock, Gamma/TTS reales pendientes');
  });

  console.log('\n=== M-4: verificación de email de administradores ===');
  await check('M-4 guard: sin fila en auth.users → claim del JWT (true pasa, ausente niega); auth.users ilegible → claim; fila existente sin confirmar → 403 aunque el claim diga true', async () => {
    const { SupabaseJwtGuard, resetAdminVerifiedCacheForTests } = loadDist('auth/supabase-jwt.guard.js');
    const jwt = require('jsonwebtoken');
    const SECRET = 'test-hs256-secret-r58-r1';
    const ADMIN = 'admin@cursia.test';
    const ID = '22222222-3333-4444-8555-666666666666';
    const ctx = (claims) => { const req = { headers: { authorization: 'Bearer ' + jwt.sign({ sub: ID, email: ADMIN, ...claims }, SECRET, { expiresIn: 600 }) } }; return { req, c: { switchToHttp: () => ({ getRequest: () => req }) } }; };
    await withEnv({ SUPABASE_JWT_SECRET: SECRET, SUPER_ADMIN_EMAILS: ADMIN, SUPER_ADMIN_USER_IDS: undefined, SUPER_ADMIN_EMAIL_VERIFICATION: undefined }, async () => {
      const run = async (ds, claims) => { resetAdminVerifiedCacheForTests(); const a = ctx(claims); try { return await new SupabaseJwtGuard(ds).canActivate(a.c); } catch (e) { return (e.getResponse && e.getResponse().code) || e.message; } };
      const noRow = { async query() { return []; } };
      const unreadable = { async query() { throw new Error('permission denied for schema auth'); } };
      const unconfirmed = { async query() { return [{ email: ADMIN, confirmed: false }]; } };
      const confirmed = { async query() { return [{ email: ADMIN, confirmed: true }]; } };
      eq(await run(noRow, { email_verified: true }), true, 'sin fila + claim true');
      eq(await run(noRow, { user_metadata: { email_verified: true } }), true, 'sin fila + user_metadata');
      eq(await run(noRow, {}), 'admin_email_unverified', 'sin fila y sin claim');
      eq(await run(noRow, { email_verified: false }), 'admin_email_unverified', 'sin fila + claim false');
      eq(await run(unreadable, { email_verified: true }), true, 'ilegible + claim true');
      eq(await run(unreadable, {}), 'admin_email_unverified', 'ilegible sin claim');
      eq(await run(unconfirmed, { email_verified: true }), 'admin_email_unverified', 'fila sin confirmar niega aunque el claim diga true');
      eq(await run(confirmed, {}), true, 'fila confirmada');
    });
  });

  console.log('\n=== M-6: Q7 no medido = neutral ===');
  await check('M-6 Q7 no medido: pass null (ni aprobado ni fallido), report.pass intacto; compareQualityReports: medido → no medido = «sin datos», nunca «dejó de pasar»', () => {
    const chapters = [{ id: 'c1', moduleId: 'm', title: 'Uno' }, { id: 'c2', moduleId: 'm', title: 'Dos' }];
    const base = { chapters, outcomes: [], competencies: [], manifestItems: [], artifactTypesByItem: {}, chapterMd: { c1: 'texto uno', c2: 'texto dos' }, examBanks: {} };
    const measured = QB.runQualityBattery({ ...base, contextSummaries: { c1: { concepts_introduced: ['costo unitario'], concepts_assumed: [] }, c2: { concepts_introduced: [], concepts_assumed: ['costo unitario'] } } });
    const notMeasured = QB.runQualityBattery({ ...base, contextSummaries: {} });
    const q7 = (r) => r.checks.find((c) => c.id === 'Q7');
    eq([q7(measured).pass, q7(notMeasured).pass, q7(notMeasured).status, notMeasured.pass === measured.pass], [true, null, 'not_measured', true], 'Q7');
    const reg = QB.compareQualityReports(measured, notMeasured).filter((x) => x.id === 'Q7');
    eq(reg.map((x) => x.why), ['sin datos'], 'regresión «sin datos» (no «dejó de pasar»)');
    eq(QB.compareQualityReports(notMeasured, measured).filter((x) => x.id === 'Q7'), [], 'no medido → medido: sin regresión');
    const doc = fs.readFileSync(path.join(REPO, 'docs/v21/quality-reports.md'), 'utf8');
    assert(/NUMERIC_WINDOW_CONFLICT/.test(doc) && /needs_human_review/.test(doc) && /Canonical/.test(doc) && /`pass: null`/.test(doc), 'documentado: severidad, formato canónico y pass neutral');
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
      srv.close(() => ([5570, 5580, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '33333333-4444-4555-8666-777777777777';

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
  const W = loadDist('workers/dynamic-package-worker.js');
  const { DYNAMIC_MBZ_BUILDER_VERSION } = loadDist('package/dynamic-mbz-builder.js');
  const reuse = loadDist('modules/dynamic-packaging/packaging-reuse-key.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58r1-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58r1-cwd-'));
  const ROLE = 'postgres.r58r1local01';
  const DB = 'r58r1db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
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
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 4 } });
    await ds.initialize();
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => ({ SUPABASE_URL: FAKE_SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only' })[k] });
    const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'r58 review r1', 'dynamic') returning id`, [OWNER]);
    const CID = course.id;
    const FC_ID = String(CID); // sin frontend_course_id → artifactCourseId = course_id
    const RUN = crypto.randomUUID();
    // El run (dynamic_generation) que se empaqueta: el worker lee su input_payload (entrega de videos).
    await ds.query(`insert into public.production_jobs (id, owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
      values ($1, $2, $3, 'dynamic_generation', 'completed', 'completed', 'dynamic_generation', 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`, [RUN, OWNER, CID]);
    const KEY = reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb']);
    const CANONICAL = `${OWNER}/dynamic/${FC_ID}/1/dynamic_mbz/${RUN}/${KEY}.mbz`;
    const objKey = (p) => `cursia-artifacts/${p}`;
    const RESOLVED = new Map([['content_cap1', [{ artifactId: 'bbbb', type: 'dynamic_content_md' }]], ['scorm_cap1', [{ artifactId: 'aaaa', type: 'dynamic_scorm_html' }]]]);
    const STUB_PLAN = { planVersion: 1, manifestId: 1, course: { id: 1, title: 'x', summary: null }, sections: [], modules: [], totals: { modules: 0, chapters: 0, scorms: 0, videos: 0, exams: 0 } };
    let buildN = 0;
    const builds = [];
    const deps = {
      dataSource: ds,
      artifacts,
      manifests: { async getById() { return { id: 1, blueprintNumber: 1, rulesVersion: 1, manifest: { items: [] } }; } },
      blueprints: { async getByNumber() { return { snapshot: {} }; } },
      buildPlan: () => STUB_PLAN,
      resolveArtifacts: async () => RESOLVED,
      loadText: async () => '',
      parseVideo: () => ({ url: '', videogenJobId: '' }),
      buildMbz: async () => { buildN++; const b = Buffer.from(`mbz-build-${buildN}-${Date.now()}`); builds.push(b); return b; },
      logger: { log() {}, warn() {}, error() {} },
      workerId: 'w-r58-r1',
      leaseSeconds: 60,
      heartbeatMs: 999999,
    };
    const newJob = async () => {
      const [j] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result, worker_id)
         values ($1, $2, 'dynamic_package', 'running', 'running', 'dynamic_package', 0, $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4) returning id`,
        [OWNER, CID, JSON.stringify({ runId: RUN, manifestId: 1, blueprintNumber: 1 }), deps.workerId]);
      return { id: j.id, owner_id: OWNER, course_id: CID, frontend_course_id: null, worker_status: 'running', status: 'running', input_payload: { runId: RUN, manifestId: 1, blueprintNumber: 1 }, output_summary: {}, attempt_count: 1, max_attempts: 3 };
    };
    const jobRow = async (id) => (await ds.query(`select worker_status, error_message, output_summary from public.production_jobs where id = $1`, [id]))[0];
    const mbzRows = async () => ds.query(`select id, storage_path, checksum_sha256 from public.artifacts where type = 'dynamic_mbz' and owner_id = $1 order by created_at, id`, [OWNER]);

    const DELIVERED = Buffer.from('DELIVERED-PACKAGE-A (pre-r58, sin checksum)');
    let rebuiltPath = null;
    await check('DB I-1 paquete entregado A (row pre-r58 sin checksum en la ruta canónica) + job nuevo → los bytes de A quedan INTACTOS; el rebuild va a `<clave>.<sha16>.mbz` con un row nuevo', async () => {
      storage.objects.set(objKey(CANONICAL), DELIVERED);
      const [a] = await ds.query(
        `insert into public.artifacts (owner_id, course_id, type, storage_path, storage_bucket, filename, mime_type, size_bytes, metadata)
         values ($1, $2, 'dynamic_mbz', $3, 'cursia-artifacts', $4, 'application/vnd.moodle.backup', $5, $6::jsonb) returning id`,
        [OWNER, FC_ID, CANONICAL, `${KEY}.mbz`, DELIVERED.length, JSON.stringify({ runId: RUN, manifestId: 1, sourceIdsHash: KEY, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION })]);
      // Un job final posterior que falló (el escenario de la revisión): no cambia nada para el job nuevo.
      await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result, error_message)
        values ($1, $2, 'dynamic_package', 'failed', 'failed', 'dynamic_package', 0, $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'build falló (simulado)')`, [OWNER, CID, JSON.stringify({ runId: RUN, manifestId: 1, blueprintNumber: 1 })]);
      const job = await newJob();
      await W.processItem(deps, job);
      const jr = await jobRow(job.id);
      eq([jr.worker_status, jr.output_summary.reused], ['completed', false], `job completado con rebuild (${jr.error_message})`);
      assert(storage.objects.get(objKey(CANONICAL)).equals(DELIVERED), 'los bytes entregados de A siguen intactos');
      const rows = await mbzRows();
      eq(rows.length, 2, 'row nuevo (A conservado)');
      eq(rows[0].id, a.id, 'A sigue primero y apunta a su ruta');
      eq(rows[0].storage_path, CANONICAL, 'A: ruta canónica');
      rebuiltPath = rows[1].storage_path;
      eq(rebuiltPath, RV.rebuildDynamicMbzPath(CANONICAL, sha(builds[0])), 'rebuild en la ruta nueva');
      assert(storage.objects.get(objKey(rebuiltPath)).equals(builds[0]), 'bytes del rebuild en la ruta nueva');
      eq([rows[1].checksum_sha256, jr.output_summary.artifactId], [sha(builds[0]), rows[1].id], 'checksum del servidor + artifact del job');
      assert(!storage.calls.some((c) => c.method === 'POST' && c.url.endsWith(encodeURIComponent(`${KEY}.mbz`))), 'ningún POST a la ruta de A');
    });

    await check('DB I-1 job siguiente: reutiliza el rebuild verificado (variante de ruta + checksum + bytes), sin construir ni subir', async () => {
      const before = buildN;
      const posts = storage.calls.filter((c) => c.method === 'POST').length;
      const job = await newJob();
      await W.processItem(deps, job);
      const jr = await jobRow(job.id);
      const rows = await mbzRows();
      eq([jr.worker_status, jr.output_summary.reused, jr.output_summary.artifactId], ['completed', true, rows[1].id], 'reutilizado');
      eq([buildN, storage.calls.filter((c) => c.method === 'POST').length, rows.length], [before, posts, 2], 'sin build / upload / row');
    });

    // r62 (K4): un fallo transitorio de Storage al verificar el candidato ya no hace FALLAR el job (antes:
    // PACKAGE_REUSE_VERIFY_UNAVAILABLE → 5 rondas → retry_package manual). Como desde 26890be el rebuild nunca pisa un objeto
    // referenciado, el job reconstruye en una ruta NUEVA (`<clave>.<sha16>.mbz`) y deja intactos A y el rebuild anterior.
    await check('DB I-1/r62 K4 Storage 503 al verificar el candidato (download_failed) → el job NO falla: reconstruye en una ruta NUEVA (sha del build), row nuevo; A y el rebuild anterior intactos (ningún POST a sus rutas)', async () => {
      const before = buildN;
      const rowsBefore = (await mbzRows()).length;
      storage.getStatus = 503;
      let jr;
      let postsDuring;
      const callsBefore = storage.calls.length;
      try {
        const job = await newJob();
        await W.processItem(deps, job);
        jr = await jobRow(job.id);
      } finally { storage.getStatus = null; postsDuring = storage.calls.slice(callsBefore).filter((c) => c.method === 'POST'); }
      eq([jr.worker_status, jr.output_summary.reused], ['completed', false], 'job completado con un rebuild');
      eq(buildN, before + 1, 'un build');
      const rows = await mbzRows();
      eq(rows.length, rowsBefore + 1, 'un row nuevo');
      const fresh = builds[builds.length - 1];
      const freshPath = RV.rebuildDynamicMbzPath(CANONICAL, sha(fresh));
      assert(freshPath !== rebuiltPath && freshPath !== CANONICAL, 'ruta nueva');
      assert(storage.objects.get(objKey(freshPath)).equals(fresh), 'bytes del rebuild en la ruta nueva');
      eq(jr.output_summary.artifactId, rows[rows.length - 1].id, 'artifact del job = row nuevo');
      // r62 review M3: el row nuevo lleva el checksum del servidor de los bytes del rebuild (lo exige el próximo reuse).
      eq([rows[rows.length - 1].checksum_sha256, rows[rows.length - 1].storage_path], [sha(fresh), freshPath], 'checksum y ruta del row nuevo');
      assert(!postsDuring.some((c) => c.url.endsWith(encodeURIComponent(`${KEY}.mbz`)) || c.url.endsWith(encodeURIComponent(rebuiltPath.split('/').pop()))), 'ningún POST a las rutas referenciadas');
      assert(storage.objects.get(objKey(CANONICAL)).equals(DELIVERED) && storage.objects.get(objKey(rebuiltPath)).equals(builds[0]), 'objetos entregados intactos');
      const v = FC.classifyFailure({ error: 'PACKAGE_REUSE_VERIFY_UNAVAILABLE: x', source: 'package_worker' });
      eq([v.class, v.strategy], ['A', 'repackage'], 'el código sigue clasificado A (compatibilidad de logs/jobs viejos)');
    });

    await check('DB I-1 guarda de putStorageObject: ruta referenciada por un artifact con OTROS bytes → PACKAGE_OBJECT_CONFLICT sin sobrescribir; un objeto HUÉRFANO (sin row) sí se reemplaza; mismos bytes → se adoptan', async () => {
      const up = (p, buf) => artifacts.uploadBufferArtifact({ ownerId: OWNER, courseId: FC_ID, type: 'dynamic_mbz', filename: 'x.mbz', storagePath: p, buffer: buf, mimeType: 'application/vnd.moodle.backup', upsert: false, adoptExistingOnConflict: true, replaceUnverifiedOnConflict: true, metadata: {} });
      await rejectsWith(up(CANONICAL, Buffer.from('OTRO BUILD')), /^PACKAGE_OBJECT_CONFLICT:/, 'referenciada');
      assert(storage.objects.get(objKey(CANONICAL)).equals(DELIVERED), 'A intacto tras el conflicto');
      // Con Storage sin poder leer el objeto referenciado: tampoco se pisa.
      storage.getStatus = 503;
      try { await rejectsWith(up(CANONICAL, Buffer.from('OTRO BUILD 2')), /^PACKAGE_OBJECT_CONFLICT:.*no se pudo leer/, 'referenciada e ilegible'); } finally { storage.getStatus = null; }
      assert(storage.objects.get(objKey(CANONICAL)).equals(DELIVERED), 'A intacto (ilegible)');
      const orphan = `${OWNER}/dynamic/${FC_ID}/1/dynamic_mbz/${RUN}/orphan.mbz`;
      storage.objects.set(objKey(orphan), Buffer.from('HUÉRFANO (crash entre Storage y el insert)'));
      const row = await up(orphan, Buffer.from('BUILD VALIDADO'));
      eq([storage.objects.get(objKey(orphan)).toString(), row.checksumSha256], ['BUILD VALIDADO', sha(Buffer.from('BUILD VALIDADO'))], 'huérfano reemplazado');
      const same = await up(orphan, Buffer.from('BUILD VALIDADO'));
      eq((same.metadata || {}).adoptedExistingObject, true, 'mismos bytes → adoptado aunque esté referenciado (no se pisa nada)');
      eq(await artifacts.isStoragePathReferenced('cursia-artifacts', CANONICAL), true, 'referenciada');
      eq(await artifacts.isStoragePathReferenced('otro-bucket', CANONICAL), false, 'el bucket cuenta');
    });

    await check('DB M-7 claim de la Actividad de Aplicación: archivos del perfil de evaluación CONGELADO al crear el run (no una versión posterior)', async () => {
      const ch = crypto.randomUUID();
      const prof = (title) => JSON.stringify({ practiceResources: [{ id: 'datos', chapterId: ch, title, instructions: 'Usa la hoja.', relation: 'application', source: { kind: 'table', format: 'xlsx', filename: 'ventas.xlsx' } }] });
      await ds.query(`insert into public.course_profiles (course_id, kind, version, data, sha256, created_at) values ($1, 'assessment', 1, $2::jsonb, $3, now() - interval '2 hours')`, [CID, prof('v1 congelado'), 'a'.repeat(64)]);
      const [job] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result, created_at)
        values ($1, $2, 'dynamic_generation', 'running', 'running', 'dynamic_generation', 0, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now() - interval '1 hour') returning id`, [OWNER, CID]);
      await ds.query(`insert into public.course_profiles (course_id, kind, version, data, sha256) values ($1, 'assessment', 2, $2::jsonb, $3)`, [CID, prof('v2 editado después'), 'b'.repeat(64)]);
      const svc = Object.create(SchedulerService.prototype);
      const files = await svc.practiceFilesForChapter(ds, job.id, ch);
      eq(files.map((f) => f.title), ['v1 congelado'], 'versión congelada');
      const [late] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
        values ($1, $2, 'dynamic_generation', 'running', 'running', 'dynamic_generation', 0, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`, [OWNER, CID]);
      eq((await svc.practiceFilesForChapter(ds, late.id, ch)).map((f) => f.title), ['v2 editado después'], 'un run nuevo ve la versión vigente');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
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
