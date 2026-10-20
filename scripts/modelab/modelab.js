#!/usr/bin/env node
/* eslint-disable */
// r61 (F) — MODELAB: evaluación de modelos (Sonnet 4.6 vs Sonnet 5.5 vs Haiku 5.5) para Cursia V2, reproducible.
//
//   node scripts/modelab/modelab.js project  [--out=DIR]                  proyección de costo S/M/L + riesgo de truncado (USD 0)
//   node scripts/modelab/modelab.js baseline [--out=DIR] [--package-dir=]  baseline determinista offline (USD 0)
//   node scripts/modelab/modelab.js plan     [--config=FILE]               costo previo del experimento (por evidencia)
//   node scripts/modelab/modelab.js run --dry-run [--config=FILE] [--out=DIR]
//        corrida COMPLETA sin red: mismo motor (driver offline + ejecutor + validadores), LLM falso + uso simulado
//   node scripts/modelab/modelab.js capture --dry-run|--real --api-key-env=VAR [--out=DIR]
//        pedidos reales del ejecutor por componente; en --real cuenta tokens con count_tokens (GRATIS) por modelo
//   node scripts/modelab/modelab.js run --real --approved-budget-usd=N --api-key-env=VAR [--config=FILE] [--rubric=scores.json --judge-key=key.json]
//        llamadas REALES (SDK oficial). Exige presupuesto aprobado explícito y el NOMBRE de la variable con la clave;
//        nunca lee .env. Aborta antes de empezar si la proyección × margen supera lo aprobado, y en cualquier llamada
//        cuya cota superior no quepa.
//
// Requiere `npm run build` (usa dist/) y las fixtures H5P v2 del frontend (CURSIA_FRONTEND_REPO, como el driver).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
require(path.resolve(__dirname, '..', '..', 'node_modules', 'reflect-metadata'));
const P = require('./lib/project');
const B = require('./lib/baseline');
const E = require('./lib/experiment');
const CL = require('./lib/clients');
const M = require('./lib/models');
const RN = require('./lib/runner');
const { BudgetGuard } = require('./lib/budget');
const R = require('./lib/report');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const HARD_MAX_BUDGET_USD = 10;

function args() {
  const a = { _: [] };
  for (const x of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(x);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2]; else a._.push(x);
  }
  return a;
}
function outDir(a, name) {
  const d = a.out ? path.resolve(a.out) : fs.mkdtempSync(path.join(os.tmpdir(), `modelab-${name}-`));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function write(dir, base, obj, md) {
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(obj, null, 2));
  fs.writeFileSync(path.join(dir, `${base}.md`), md);
  console.log(`→ ${path.join(dir, base)}.{json,md}`);
}
function feRoot() { return process.env.CURSIA_FRONTEND_REPO || [path.join(ROOT, '..', 'fe'), path.join(ROOT, '..', 'campuscloud-gen')].find((p) => fs.existsSync(p)); }
function loadConfig(a) { return JSON.parse(fs.readFileSync(path.resolve(a.config || path.join(__dirname, 'config/phase1.json')), 'utf8')); }

/** Modo real: validaciones duras ANTES de construir cualquier cliente. */
function realGuards(a, { needBudget }) {
  if (a['dry-run']) throw new Error('modelab: --real y --dry-run son excluyentes');
  if (!a['api-key-env'] || a['api-key-env'] === true) throw new Error('modelab: el modo real exige --api-key-env=NOMBRE_DE_VARIABLE (la clave la provee el operador en el entorno de esta corrida)');
  if (needBudget) {
    const b = Number(a['approved-budget-usd']);
    if (!(a['approved-budget-usd'] !== undefined && Number.isFinite(b) && b > 0)) throw new Error('modelab: el modo real exige --approved-budget-usd=N (USD > 0) aprobado explícitamente');
    if (b > HARD_MAX_BUDGET_USD && !a['allow-budget-over-10']) throw new Error(`modelab: presupuesto ${b} > ${HARD_MAX_BUDGET_USD} USD; requiere --allow-budget-over-10`);
    return b;
  }
  return 0;
}

async function cmdCapture(a) {
  // Pedidos EXACTOS del ejecutor por componente (entrada M-sim): una corrida con el brazo baseline y el cliente mock.
  const cfg = E.loadInput({ source: 'commercial-simulation', fixtureId: a.fixture || 'B-M' });
  const types = (a.types ? String(a.types).split(',') : ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'activity', 'video_interactions', 'application_activity', 'guided_practice', 'exam', 'final_exam']);
  const bodies = [];
  const mock = CL.createMockClient();
  const capt = { ...mock, providerRef: mock.providerRef, async call(adapted, original) { bodies.push({ original }); return mock.call(adapted, original); } };
  const real = a.real ? (realGuards(a, { needBudget: false }), CL.createRealClient({ apiKeyEnv: a['api-key-env'] })) : null;
  const guard = new BudgetGuard(1e9, { label: 'capture-mock' }); // mock: sin gasto real
  const arm = { id: 'capture', model: 'claude-sonnet-4-6', thinking: 'off' };
  const rows = [];
  for (const t of types) {
    const before = bodies.length;
    const sel = t === 'exam' ? [{ type: t, module: 0 }] : ['course_plan', 'course_intro', 'final_exam'].includes(t) ? [{ type: t }] : t === 'module_intro' || t === 'application_activity' ? [{ type: t, module: 0 }] : [{ type: t, chapter: { m: 0, c: 0 } }];
    let r;
    try { r = await RN.runArm({ distRoot: DIST, feRoot: feRoot(), cfg, select: sel, arm, client: capt, guard }); } catch (e) { rows.push({ type: t, error: String(e.message || e).slice(0, 200) }); continue; }
    const mine = r.calls.map((c, i) => ({ c, b: bodies[before + i] })).filter((x) => x.c.componentType === t);
    for (const { c, b } of mine) {
      const body = b.original;
      const chars = JSON.stringify(body.system || '').length + JSON.stringify(body.messages).length;
      const row = { type: t, callRole: c.callRole, maxTokens: body.max_tokens, promptChars: chars, cached: JSON.stringify(body.messages).includes('cache_control'), lint: {} };
      for (const armDef of loadConfig(a).arms) row.lint[armDef.id] = M.lintBody(M.adaptBody(body, armDef)).map((l) => l.code);
      if (real) {
        for (const model of ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
          const ct = await real.countTokens({ ...body, model });
          row[`tokens_${model}`] = ct.input_tokens;
        }
        row.factor_s55 = Math.round(row['tokens_claude-sonnet-5-5'] / row['tokens_claude-sonnet-4-6'] * 1000) / 1000;
        row.factor_h55 = Math.round(row['tokens_claude-haiku-5-5'] / row['tokens_claude-sonnet-4-6'] * 1000) / 1000;
      }
      rows.push(row);
    }
  }
  const out = { mode: real ? 'real-count-tokens (gratis)' : 'dry-run', fixture: cfg.id, note: 'Prompts del LLM falso: el SYSTEM y la estructura son los reales del ejecutor; el contenido de dependencias es sintético. El factor del tokenizer medido aquí aplica a la ENTRADA; la salida se mide en la Fase 1.', rows };
  write(outDir(a, 'capture'), 'modelab-capture', out, R.renderCapture(out));
}

async function main() {
  const a = args();
  const cmd = a._[0];
  if (cmd === 'project') {
    const out = { generatedBy: 'modelab project', factors: [1.15, 1.3, 1.4], costTable: P.costTable(), perComponentM: P.perComponentM(1.3), truncation: P.truncationRisk(), nonLlmUsd: P.NON_LLM_USD };
    write(outDir(a, 'project'), 'modelab-projection', out, R.renderProjection(out));
    return;
  }
  if (cmd === 'baseline') {
    const out = B.buildBaseline(DIST, { packageDir: a['package-dir'] });
    write(outDir(a, 'baseline'), 'modelab-baseline', out, R.renderBaseline(out));
    return;
  }
  if (cmd === 'plan') {
    const cfg = loadConfig(a);
    const p = E.planCost(cfg);
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  if (cmd === 'capture') return cmdCapture(a);
  if (cmd === 'run') {
    const cfg = loadConfig(a);
    const real = !!a.real;
    if (!real && !a['dry-run']) throw new Error('modelab run: elegir --dry-run (sin red) o --real (con presupuesto)');
    const approved = real ? realGuards(a, { needBudget: true }) : null;
    // La clave se valida ANTES de cualquier otro trabajo (falla temprano y explícito).
    const realClient = real ? CL.createRealClient({ apiKeyEnv: a['api-key-env'] }) : null;
    let rubric = null;
    if (a.rubric && a['judge-key']) rubric = E.rubricFromScores(JSON.parse(fs.readFileSync(a.rubric, 'utf8')), JSON.parse(fs.readFileSync(a['judge-key'], 'utf8')));
    const dir = outDir(a, real ? 'real' : 'dryrun');
    const t0 = Date.now();
    const res = await E.runExperiment({
      config: cfg, distRoot: DIST, feRoot: feRoot(), real, approvedBudgetUsd: approved, rubric,
      clientFactory: () => (real ? realClient : CL.createMockClient({ tokenizerFactor: Number(a['tokenizer-factor'] || M.TOKENIZER_FACTOR_DEFAULT) })),
      log: (m) => console.log(m),
    });
    res.elapsedMs = Date.now() - t0;
    const jp = E.judgePackets(res, cfg);
    fs.writeFileSync(path.join(dir, 'judge-packets.jsonl'), jp.packets.map((p) => JSON.stringify(p)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'judge-key.json'), JSON.stringify(jp.key, null, 2));
    const slim = { ...res, components: res.components.map((c) => ({ ...c, runsDetail: Object.fromEntries(Object.entries(c.runsDetail).map(([k, v]) => [k, v.map((r) => ({ ...r, docs: (r.docs || []).map((d) => ({ itemKey: d.itemKey, chars: d.text.length })) }))])) })) };
    write(dir, 'modelab-run', slim, R.renderRun(slim, cfg));
    console.log(`paquetes ciegos para rúbrica: ${jp.packets.length} (judge-packets.jsonl; la clave va aparte en judge-key.json)`);
    if (res.aborted) { console.error(`ABORTADO: ${res.aborted.message}`); process.exitCode = 2; }
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n'));
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => { console.error(`modelab: ${e && e.message ? e.message : e}`); process.exitCode = 1; });
