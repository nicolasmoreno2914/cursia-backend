#!/usr/bin/env node
/* eslint-disable */
// r61 (F) — autoverificación del MODELAB (USD 0, sin red). Requiere `npm run build` y CURSIA_FRONTEND_REPO (fixtures H5P).
//   ML1 contrato de API por modelo (lint) según la documentación oficial; los brazos de la Fase 1 pasan el lint
//   ML2 precios: el código de FinOps del producto reproduce el ledger de #1353; tramos de Haiku 5.5; caché 0,05× de S5.5
//   ML3 proyección: Sonnet 4.6 sin fixes reproduce el total Anthropic de #1353 (32,13)
//   ML4 guardia de presupuesto: cota que no cabe → BUDGET_EXCEEDED; chequeo previo → BUDGET_PREFLIGHT_EXCEEDED
//   ML5 modo real: sin --approved-budget-usd / --api-key-env / variable definida → se niega; el código nunca lee .env
//   ML6 dry-run de punta a punta (mismo motor del producto): brazos con su modelo, réplicas, veredictos, 0 red
//   ML7 truncado: un max_tokens chico llega al ejecutor como stop_reason=max_tokens y cuenta como falla/reintento
//   ML8 «cambio solo de env» en S5.5 (sin thinking) = pensamiento adaptativo → más salida simulada que between_tools
//   ML9  (review I1) informe SIEMPRE: error inesperado → resultados parciales con gasto/llamadas/respuestas; SIGINT → informe
//   ML10 (review I2) ledger acumulado entre corridas: gasto previo + reservas huérfanas al peor caso; agotado → se niega
//   ML11 (review I3/I6) errores transitorios: reintento explícito con reserva por intento, nunca respuesta ni falla del brazo
//   ML12 (review I5) 4xx inesperado → ARM_REQUEST_REJECTED aborta la corrida (con informe); humo por brazo antes de gastar
//   ML13 (review I7/M3) regla go/no-go estricta con faltantes + compuerta del factor del tokenizer
//   ML14 (review I8) `decide` offline sobre una corrida guardada (USD 0)
//   ML15 (review I9) costo en frío: igual entre réplicas aunque la caché esté tibia
// Todo corre bajo la barrera de red del repo (review M6): un intento de red hace fallar el check.
'use strict';
const fs = require('fs');
const path = require('path');
require(path.resolve(__dirname, '..', '..', 'node_modules', 'reflect-metadata'));
const M = require('./lib/models');
const CAT = require('./lib/catalog');
const P = require('./lib/project');
const RN = require('./lib/runner');
const E = require('./lib/experiment');
const CL = require('./lib/clients');
const { BudgetGuard, assertPreflight, readLedger, ledgerPath } = require('./lib/budget');
const os = require('os');
const NG = require(path.resolve(__dirname, '..', 'lib', 'netguard'));
const BARRIER = NG.installNetworkBarrier({ label: 'check-modelab' });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-modelab-'));

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const FE = process.env.CURSIA_FRONTEND_REPO;
let ok = 0, bad = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { bad++; console.error(`❌ ${name}\n   ${String(e && e.stack || e).split('\n').slice(0, 5).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);
const codes = (b) => M.lintBody(b).map((x) => x.code);
const base = { model: 'claude-sonnet-4-6', max_tokens: 8000, system: 's', messages: [{ role: 'user', content: 'u' }] };

(async () => {
  await check('ML1 lint del contrato por modelo', () => {
    assert(codes({ ...base, model: 'claude-sonnet-5-5', thinking: { type: 'disabled' } }).includes('THINKING_TYPE_400'), 'S5.5 disabled');
    assert(codes({ ...base, model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' }, output_config: { effort: 'xhigh' } }).includes('BETWEEN_TOOLS_EFFORT_400'), 'between_tools xhigh');
    assert(codes({ ...base, model: 'claude-sonnet-5-5', thinking: { type: 'between_tools', display: 'summarized' } }).includes('BETWEEN_TOOLS_FIELDS_400'), 'between_tools + display');
    assert(codes({ ...base, model: 'claude-sonnet-5-5', thinking: { type: 'enabled', budget_tokens: 2000 } }).includes('BUDGET_TOKENS_400'), 'budget_tokens');
    assert(codes({ ...base, model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'max' } }).includes('DISABLED_EFFORT_400'), 'haiku disabled max');
    assert(codes({ ...base, model: 'claude-haiku-5-5', temperature: 0.7 }).includes('SAMPLING_400'), 'temperature');
    assert(codes({ ...base, model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '{' }] }).includes('PREFILL_400'), 'prefill');
    assert(codes({ ...base, model: 'claude-sonnet-4-6', output_config: { effort: 'xhigh' } }).includes('EFFORT_LEVEL_400'), '4.6 xhigh');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/phase1.json'), 'utf8'));
    for (const arm of cfg.arms) { const a = M.adaptBody({ ...base, temperature: 1 }, arm); assert(!M.lintBody(a).length, `${arm.id} lint: ${codes(a)}`); assert(a.temperature === undefined, 'sin muestreo'); }
    const b = M.adaptBody(base, cfg.arms.find((x) => x.id === 'B-s55'));
    assert(b.max_tokens === 10800 && b.thinking.type === 'between_tools' && b.output_config.effort === 'medium', `B: ${JSON.stringify(b)}`);
    assert(M.effectiveThinking({ ...base, model: 'claude-sonnet-5-5' }) === 'adaptive' && M.effectiveThinking(base) === 'off', 'thinking por defecto');
  });

  await check('ML2 precios con el código de FinOps (ledger #1353, tramos Haiku, caché S5.5)', () => {
    near(Number(CAT.priceCall(DIST, 'claude-sonnet-4-6', { input_tokens: 50550, output_tokens: 73422 })), 1.2530, 0.0005, 'content #1353');
    near(Number(CAT.priceCall(DIST, 'claude-sonnet-4-6', { input_tokens: 188451, output_tokens: 587873, cache_read_input_tokens: 1938233, cache_creation_input_tokens: 294225 })), 11.0683, 0.001, 'exam #1353');
    near(Number(CAT.priceCall(DIST, 'claude-sonnet-5-5', { cache_read_input_tokens: 1e6 })), 0.10, 1e-9, 'S5.5 cache read 0,05×');
    near(Number(CAT.priceCall(DIST, 'claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1e6 })), 0.51, 1e-9, 'Haiku ≤100k');
    near(Number(CAT.priceCall(DIST, 'claude-haiku-5-5', { input_tokens: 90000, cache_read_input_tokens: 20000, output_tokens: 1e6 })), 0.045 + 0.001 + 2.5, 1e-9, 'Haiku >100k cuenta la caché');
  });

  await check('ML3 proyección: S4.6 sin fixes = ledger Anthropic #1353', () => {
    near(P.projectCourse('M', () => 'claude-sonnet-4-6', 1, { fixes: false }).llmUsd, 32.13, 0.01, 'M');
    near(P.projectCourse('S', () => 'claude-sonnet-4-6', 1, { fixes: false }).llmUsd, 0.50, 0.01, 'S');
  });

  await check('ML4 guardia de presupuesto', () => {
    const g = new BudgetGuard(1);
    const r = g.reserve(0.6); g.settle(r, 0.5);
    let e = null; try { g.reserve(0.6); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_EXCEEDED', 'debió abortar');
    e = null; try { assertPreflight(4.5, 5, 1.25); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_PREFLIGHT_EXCEEDED', 'preflight');
    e = null; try { assertPreflight(3, 5, 1.25, 2); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_PREFLIGHT_EXCEEDED', 'preflight descuenta el gasto previo');
  });

  await check('ML5 modo real se niega sin presupuesto/clave; nunca lee .env', async () => {
    const { execFileSync } = require('child_process');
    const run = (args, env = {}) => { try { execFileSync(process.execPath, [path.join(__dirname, 'modelab.js'), ...args], { env: { ...process.env, MODELAB_TEST_KEY: '', ...env }, stdio: 'pipe' }); return ''; } catch (x) { return String(x.stderr); } };
    assert(/approved-budget-usd/.test(run(['run', '--real', '--api-key-env=MODELAB_TEST_KEY'])), 'sin presupuesto');
    assert(/api-key-env/.test(run(['run', '--real', '--approved-budget-usd=3'])), 'sin variable');
    assert(/no está definida/.test(run(['run', '--real', '--approved-budget-usd=3', '--api-key-env=MODELAB_TEST_KEY'])), 'variable vacía');
    assert(/> 10 USD/.test(run(['run', '--real', '--approved-budget-usd=50', '--api-key-env=MODELAB_TEST_KEY'])), 'tope duro');
    assert(/> 10 USD/.test(run(['run', '--real', '--approved-budget-usd=50', '--allow-budget-over-10', '--api-key-env=MODELAB_TEST_KEY'])), 'el tope no tiene bypass (I4)');
    assert(/--out=DIR estable/.test(run(['run', '--real', '--approved-budget-usd=3', '--api-key-env=MODELAB_TEST_KEY'], { MODELAB_TEST_KEY: 'sk-test-not-a-real-key' })), 'modo real exige --out estable (ledger)');
    process.env.MODELAB_FAKE_KEY = 'sk-test-not-a-real-key';
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example.com';
    let eb = null; try { CL.createRealClient({ apiKeyEnv: 'MODELAB_FAKE_KEY' }); } catch (x) { eb = x; }
    delete process.env.ANTHROPIC_BASE_URL;
    assert(eb && /ANTHROPIC_BASE_URL/.test(eb.message), 'base URL ajena rechazada (M8)');
    const csrc = fs.readFileSync(path.join(__dirname, 'lib/clients.js'), 'utf8');
    assert(/maxRetries: 0/.test(csrc) && /baseURL: ANTHROPIC_API_BASE/.test(csrc), 'SDK sin reintentos y con base URL fija (I3/M8)');
    delete process.env.MODELAB_FAKE_KEY;
    let e = null; try { CL.createRealClient({ apiKeyEnv: 'MODELAB_DEFINITELY_UNSET' }); } catch (x) { e = x; }
    assert(e, 'cliente real sin variable');
    for (const f of fs.readdirSync(path.join(__dirname, 'lib')).map((x) => path.join(__dirname, 'lib', x)).concat([path.join(__dirname, 'modelab.js')])) {
      const src = fs.readFileSync(f, 'utf8');
      assert(!/require\(['"]dotenv|readFileSync\([^)]*\.env|['"]\.env['"]/.test(src), `${path.basename(f)} no debe leer .env`);
    }
  });

  await check('ML6 dry-run de punta a punta (motor del producto, sin red)', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/phase1.json'), 'utf8'));
    cfg.components = [
      { component: 'video_interactions', input: 'S-1510like', chapters: [{ m: 0, c: 0 }], arms: ['A-s46', 'B-s55', 'C-h55'], runs: 2 },
      { component: 'audiobook_chapter', input: 'S-1510like', chapters: [{ m: 0, c: 0 }], arms: ['A-s46', 'C-h55'], runs: 1 },
    ];
    const res = await E.runExperiment({ config: cfg, distRoot: DIST, feRoot: FE, real: false, clientFactory: () => CL.createMockClient() });
    assert(!res.aborted, `abortado ${JSON.stringify(res.aborted)}`);
    const vi = res.components.find((c) => c.component === 'video_interactions');
    assert(vi.arms['B-s55'].completed === 2 && vi.arms['A-s46'].completed === 2, 'VI completados');
    assert(['PENDING_RUBRIC', 'GO', 'NO_GO'].includes(vi.decisions['B-s55'].verdict), 'veredicto');
    const armCalls = res.calls.filter((c) => c.phase === 'arm' && c.arm === 'C-h55');
    assert(armCalls.length && armCalls.every((c) => c.model === 'claude-haiku-5-5' && c.thinking === 'off'), 'C usa Haiku sin thinking');
    assert(res.calls.filter((c) => c.phase === 'dependencies').every((c) => c.model === 'claude-sonnet-4-6'), 'dependencias con el baseline');
    assert(res.budget.spentUsd > 0 && res.budget.spentUsd < 1, 'gasto simulado contabilizado');
    const jp = E.judgePackets(res, cfg);
    assert(jp.packets.length >= 2 && jp.key.length === jp.packets.length && jp.packets.every((p) => !('arm' in p)), 'paquetes ciegos');
    const rub = E.rubricFromScores(jp.packets.map((p) => ({ id: p.id, component: p.component, X: 4, Y: 4 })), jp.key);
    assert(typeof rub.video_interactions['A-s46'] === 'number', 'rúbrica importada');
  });

  await check('ML7 truncado por max_tokens llega al ejecutor', async () => {
    const cfg = E.loadInput({ source: 'commercial-simulation', fixtureId: '1x1-sin-examenes' });
    const arm = { id: 'T', model: 'claude-sonnet-5-5', thinking: 'between_tools', effort: 'low', maxTokensFactor: 1, maxTokensCap: 40 };
    const r = await RN.runArm({ distRoot: DIST, feRoot: FE, cfg, select: [{ type: 'course_intro' }], arm, client: CL.createMockClient(), guard: new BudgetGuard(1) });
    assert(r.calls.some((c) => c.stopReason === 'max_tokens'), 'hubo max_tokens');
    assert(r.res.items[Object.keys(r.res.items).find((k) => r.res.items[k].type === 'course_intro')].status === 'failed' || r.calls.some((c) => c.callRole !== 'main'), 'el ejecutor reaccionó (falla o reintento)');
    let e = null;
    try { await RN.runArm({ distRoot: DIST, feRoot: FE, cfg, select: [{ type: 'course_intro' }], arm: { id: 'A', model: 'claude-sonnet-4-6' }, client: CL.createMockClient(), guard: new BudgetGuard(0.0001) }); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_EXCEEDED', 'guardia corta antes de llamar');
  });

  await check('ML8 S5.5 sin thinking explícito = adaptativo (más salida) vs between_tools', async () => {
    const cfg = E.loadInput({ source: 'commercial-simulation', fixtureId: '1x1-sin-examenes' });
    const run = (thinking) => RN.runArm({ distRoot: DIST, feRoot: FE, cfg, select: [{ type: 'course_intro' }], arm: { id: thinking, model: 'claude-sonnet-5-5', thinking, maxTokensFactor: 1.35 }, client: CL.createMockClient(), guard: new BudgetGuard(1) });
    const a = await run('omit'); const b = await run('between_tools');
    const out = (r) => r.calls.reduce((s, c) => s + c.usage.output_tokens, 0);
    assert(a.calls[0].thinking === 'adaptive' && b.calls[0].thinking === 'off', 'thinking efectivo');
    assert(out(a) > out(b), `salida ${out(a)} > ${out(b)}`);
  });


  const smallCfg = () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/phase1.json'), 'utf8'));
    cfg.components = [{ component: 'video_interactions', input: 'S-1510like', chapters: [{ m: 0, c: 0 }], arms: ['A-s46', 'B-s55', 'C-h55'], runs: 2 }];
    return cfg;
  };

  await check('ML9 informe SIEMPRE: error inesperado y SIGINT dejan gasto, llamadas y respuestas', async () => {
    const cfg = smallCfg();
    let n = 0;
    const mock = CL.createMockClient();
    const boom = { ...mock, providerRef: mock.providerRef, async call(a, o) { if (++n === 10) throw new TypeError('falla inesperada simulada'); return mock.call(a, o); } };
    const answers = [];
    const ledgerFile = path.join(TMP, 'ml9-ledger.jsonl');
    const res = await E.runExperiment({ config: cfg, distRoot: DIST, feRoot: FE, real: false, ledgerFile, onAnswer: (x) => answers.push(x), clientFactory: () => boom });
    assert(res.aborted && res.aborted.code === 'ERROR' && /inesperada/.test(res.aborted.message), `abortado: ${JSON.stringify(res.aborted)}`);
    assert(res.calls.length >= 9 && answers.length >= 8, `parciales: ${res.calls.length} llamadas, ${answers.length} respuestas`);
    assert(res.budget && res.budget.calls === res.calls.length && res.budget.spentUsd > 0, 'snapshot del presupuesto');
    const led = readLedger(ledgerFile);
    near(led.spentUsd, res.budget.spentUsd, 1e-6, 'el ledger cuadra con el guard (la llamada que lanzó queda al peor caso)');
    // SIGINT al CLI a mitad de la corrida → modelab-run.json parcial con aborted=SIGNAL.
    const { spawn } = require('child_process');
    const out = path.join(TMP, 'ml9-sigint');
    const child = spawn(process.execPath, [path.join(__dirname, 'modelab.js'), 'run', '--dry-run', `--out=${out}`], { env: { ...process.env, MODELAB_DRYRUN_DELAY_MS: '150' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((ok, ko) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; if (/dependencias congeladas/.test(buf) && !child.killed) child.kill('SIGINT'); });
      child.on('exit', ok); child.on('error', ko);
      setTimeout(() => { child.kill('SIGKILL'); ko(new Error('timeout')); }, 120000);
    });
    const rj = JSON.parse(fs.readFileSync(path.join(out, 'modelab-run.json'), 'utf8'));
    assert(rj.aborted && rj.aborted.code === 'SIGNAL' && rj.calls.length > 0 && rj.budget.totalSpentUsd > 0, `informe por señal: ${JSON.stringify(rj.aborted)}`);
  });

  await check('ML10 ledger acumulado entre corridas (presupuesto por experimento)', async () => {
    const f = ledgerPath(TMP, 'ml10', 'real');
    const g1 = new BudgetGuard(1, { ledgerFile: f, runId: 'r1' });
    const a = g1.reserve(0.3); g1.settle(a, 0.25);
    g1.reserve(0.2); // reserva sin liquidar (caída a mitad de llamada) → peor caso
    const led = readLedger(f);
    near(led.spentUsd, 0.45, 1e-9, 'previo = liquidado + reserva huérfana');
    assert(led.orphanReserves === 1, 'reserva huérfana');
    const g2 = new BudgetGuard(1, { ledgerFile: f, runId: 'r2' });
    let e = null; try { g2.reserve(0.6); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_EXCEEDED', 'la 2.ª corrida ve lo gastado antes');
    const b = g2.reserve(0.5); g2.settle(b, 0.55);
    e = null; try { new BudgetGuard(1, { ledgerFile: f, runId: 'r3' }); } catch (x) { e = x; }
    assert(e && e.code === 'BUDGET_EXHAUSTED', 'agotado → se niega a arrancar');
    // Modo real con gasto previo y sin --resume → se niega (sin llamar).
    const f2 = path.join(TMP, 'ml10b.jsonl');
    const g = new BudgetGuard(5, { ledgerFile: f2, runId: 'x' }); g.settle(g.reserve(0.1), 0.1);
    const res = await E.runExperiment({ config: smallCfg(), distRoot: DIST, feRoot: FE, real: true, approvedBudgetUsd: 5, ledgerFile: f2, clientFactory: () => { throw new Error('no debe construirse'); } });
    assert(res.aborted && res.aborted.code === 'BUDGET_PRIOR_SPEND', `previo sin --resume: ${JSON.stringify(res.aborted)}`);
  });

  await check('ML11 transitorios: reintento explícito con reserva por intento; agotado → aborta, nunca respuesta', async () => {
    const cfg = E.loadInput({ source: 'commercial-simulation', fixtureId: '1x1-sin-examenes' });
    const arm = { id: 'B', model: 'claude-sonnet-5-5', thinking: 'between_tools', effort: 'medium', maxTokensFactor: 1.35 };
    const lf = path.join(TMP, 'ml11.jsonl');
    const g = new BudgetGuard(1, { ledgerFile: lf });
    const flaky = CL.createMockClient({ inject: (i) => (i <= 2 ? { status: i === 1 ? 529 : 503 } : null) });
    const r = await RN.runArm({ distRoot: DIST, feRoot: FE, cfg, select: [{ type: 'course_intro' }], arm, client: flaky, guard: g, backoffMs: 0 });
    const infra = r.calls.filter((c) => c.infra);
    assert(infra.length === 2 && infra[0].usd === 0 && infra[1].usd === infra[1].upperUsd, `529 sin cargo, 503 al peor caso: ${JSON.stringify(infra.map((c) => [c.stopReason, c.usd]))}`);
    assert(r.res.ok, 'el ítem se completa tras los reintentos (no es falla del brazo)');
    const lines = fs.readFileSync(lf, 'utf8').trim().split('\n').map(JSON.parse);
    assert(lines.filter((l) => l.kind === 'reserve').length === r.calls.length, 'una reserva por intento');
    const dead = CL.createMockClient({ inject: () => ({ status: 503 }) });
    let e = null; try { await RN.runArm({ distRoot: DIST, feRoot: FE, cfg, select: [{ type: 'course_intro' }], arm, client: dead, guard: new BudgetGuard(5), backoffMs: 0 }); } catch (x) { e = x; }
    assert(e && e.code === 'INFRA_RETRIES_EXHAUSTED', `agotado: ${e && e.code}`);
    assert(dead.calls === RN.TRANSIENT_MAX_ATTEMPTS, `intentos acotados: ${dead.calls}`);
  });

  await check('ML12 4xx inesperado aborta (con informe) y el humo va antes de gastar en el brazo', async () => {
    const cfg = smallCfg();
    const bad = CL.createMockClient({ inject: (i, adapted) => (adapted.model === 'claude-haiku-5-5' ? { status: 400, type: 'invalid_request_error', message: 'thinking.type: combinación no permitida' } : null) });
    const res = await E.runExperiment({ config: cfg, distRoot: DIST, feRoot: FE, real: false, clientFactory: () => bad });
    assert(res.aborted && res.aborted.code === 'ARM_REQUEST_REJECTED' && /combinación no permitida/.test(res.aborted.message), `abortado: ${JSON.stringify(res.aborted)}`);
    assert(res.calls.every((c) => c.phase === 'smoke'), 'abortó en el HUMO: ni dependencias ni brazos pagados');
    assert(res.smoke.length >= 2 && res.calls.some((c) => c.callRole === 'smoke' && c.maxTokens === E.SMOKE_MAX_TOKENS), 'humo con max_tokens chico');
  });

  await check('ML13 go/no-go estricto con faltantes + compuerta del tokenizer', () => {
    const crit = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/phase1.json'), 'utf8')).successCriteria;
    const A = { armId: 'A', model: 'claude-sonnet-4-6', firstPassValidity: 0.9, hardFailures: 0, truncations: 0, refusals: 0, jsonInvalid: 0, usdPerValidItemCold: 0.1, answerLongestShare: 0.2 };
    const B = { ...A, armId: 'B', model: 'claude-sonnet-5-5', usdPerValidItemCold: 0.08 };
    const tk = { 'claude-sonnet-5-5': { factor: 1.28 } };
    const rub = { x: { A: 4, B: 4 } };
    const v = (arm, base = A, t = tk, r = rub) => E.decide('x', base, arm, r, crit, t).verdict;
    assert(v(B) === 'GO', 'todo OK = GO');
    assert(v({ ...B, firstPassValidity: null }) === 'NO_GO', '1.ª pasada faltante');
    assert(v({ ...B, answerLongestShare: null }) === 'NO_GO', 'sesgo faltante en un brazo');
    assert(v({ ...B, answerLongestShare: null }, { ...A, answerLongestShare: null }) === 'GO', 'sin MC en ambos = n/a');
    assert(v({ ...B, answerLongestShare: 0.35 }) === 'NO_GO', 'sesgo sube');
    assert(v({ ...B, usdPerValidItemCold: null }) === 'NO_GO', 'costo faltante');
    assert(v({ ...B, usdPerValidItemCold: 0.095 }) === 'NO_GO', 'ahorro < 10 %');
    assert(v(B, A, {}) === 'PENDING_TOKENIZER', 'factor faltante');
    assert(v(B, A, { 'claude-sonnet-5-5': { factor: 1.4 } }) === 'NO_GO', 'factor > 1,35');
    assert(v(B, A, tk, null) === 'PENDING_RUBRIC', 'sin rúbrica');
    assert(v(B, A, tk, { x: { A: 4, B: 3.7 } }) === 'NO_GO', 'rúbrica cae > 0,25');
    assert(v({ ...B, model: 'claude-haiku-5-5', usdPerValidItemCold: 0.005 }, A, {}) === 'GO', 'Haiku sin compuerta de tokenizer');
    assert(v({ ...B, truncations: 1 }) === 'NO_GO', 'truncado nuevo');
  });

  await check('ML14 decide offline sobre una corrida guardada (USD 0)', async () => {
    const { execFileSync } = require('child_process');
    const out = path.join(TMP, 'ml14');
    const cfgFile = path.join(TMP, 'ml14-cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify(smallCfg()));
    execFileSync(process.execPath, [path.join(__dirname, 'modelab.js'), 'run', '--dry-run', `--config=${cfgFile}`, `--out=${out}`], { env: process.env, stdio: 'pipe' });
    const runJ = JSON.parse(fs.readFileSync(path.join(out, 'modelab-run.json'), 'utf8'));
    const before = runJ.budget.totalSpentUsd;
    const packets = fs.readFileSync(path.join(out, 'judge-packets.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(packets.length && packets.every((p) => !/claude-|sonnet|haiku/i.test(p.X + p.Y)), 'paquetes sin nombres de modelo (M5)');
    fs.writeFileSync(path.join(out, 'scores.json'), JSON.stringify(packets.map((p) => ({ id: p.id, component: 'otro', X: 4, Y: 4 }))));
    execFileSync(process.execPath, [path.join(__dirname, 'modelab.js'), 'decide', `--run=${path.join(out, 'modelab-run.json')}`, `--rubric=${path.join(out, 'scores.json')}`, `--judge-key=${path.join(out, 'judge-key.json')}`], { env: process.env, stdio: 'pipe' });
    const d = JSON.parse(fs.readFileSync(path.join(out, 'modelab-decision.json'), 'utf8'));
    const vi = d.components.find((c) => c.component === 'video_interactions');
    assert(vi && typeof d.rubric.video_interactions['A-s46'] === 'number', 'el componente sale de la clave, no del archivo (M4)');
    assert(['GO', 'NO_GO', 'PENDING_TOKENIZER'].includes(vi.decisions['C-h55'].verdict) && vi.decisions['C-h55'].pass.rubric === true, `rúbrica aplicada: ${JSON.stringify(vi.decisions['C-h55'])}`);
    const after = JSON.parse(fs.readFileSync(path.join(out, 'modelab-run.json'), 'utf8')).budget.totalSpentUsd;
    const ledgerAfter = readLedger(ledgerPath(out, 'r61-phase1', 'dry-run')).spentUsd;
    assert(after === before, 'decide no reescribe el gasto');
    near(ledgerAfter, before, 1e-6, 'decide no toca el ledger');
  });

  await check('ML15 costo en frío independiente del estado de la caché', async () => {
    const cfg = smallCfg();
    cfg.components = [{ component: 'video_interactions', input: 'M-sim', chapters: [{ m: 0, c: 0 }], arms: ['A-s46', 'B-s55'], runs: 2 }];
    const res = await E.runExperiment({ config: cfg, distRoot: DIST, feRoot: FE, real: false, clientFactory: () => CL.createMockClient() });
    assert(!res.aborted, JSON.stringify(res.aborted));
    const runs = res.components[0].runsDetail['A-s46'];
    const warm = res.calls.filter((c) => c.phase === 'arm' && c.usage && c.usage.cache_read_input_tokens > 0);
    assert(warm.length && warm.every((c) => c.usdCold > c.usd), 'hay llamadas con caché tibia (el humo y la réplica anterior la calientan) y su costo en frío es mayor');
    near(runs[1].usdCold, runs[0].usdCold, 1e-9, 'el costo en frío es el mismo');
    assert(res.calls.every((c) => c.usdCold + 1e-12 >= c.usd), 'frío ≥ real');
  });

  await check('M6 barrera de red activa y sin intentos', async () => {
    let e = null; try { await fetch('https://api.anthropic.com/v1/messages'); } catch (x) { e = x; }
    assert(e && e.code === NG.NETWORK_BLOCKED, 'fetch bloqueado');
    assert(BARRIER.attempts.length === 1, `solo el intento de prueba: ${JSON.stringify(BARRIER.attempts)}`);
  });
  console.log(`\n${ok} ok, ${bad} fallos`);
  process.exitCode = bad ? 1 : 0;
})();
