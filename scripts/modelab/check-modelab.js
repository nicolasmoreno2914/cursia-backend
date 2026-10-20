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
const { BudgetGuard, assertPreflight } = require('./lib/budget');

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
  });

  await check('ML5 modo real se niega sin presupuesto/clave; nunca lee .env', async () => {
    const { execFileSync } = require('child_process');
    const run = (args, env = {}) => { try { execFileSync(process.execPath, [path.join(__dirname, 'modelab.js'), ...args], { env: { ...process.env, ...env, MODELAB_TEST_KEY: '' }, stdio: 'pipe' }); return ''; } catch (x) { return String(x.stderr); } };
    assert(/approved-budget-usd/.test(run(['run', '--real', '--api-key-env=MODELAB_TEST_KEY'])), 'sin presupuesto');
    assert(/api-key-env/.test(run(['run', '--real', '--approved-budget-usd=3'])), 'sin variable');
    assert(/no está definida/.test(run(['run', '--real', '--approved-budget-usd=3', '--api-key-env=MODELAB_TEST_KEY'])), 'variable vacía');
    assert(/> 10 USD/.test(run(['run', '--real', '--approved-budget-usd=50', '--api-key-env=MODELAB_TEST_KEY'])), 'tope duro');
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

  console.log(`\n${ok} ok, ${bad} fallos`);
  process.exitCode = bad ? 1 : 0;
})();
