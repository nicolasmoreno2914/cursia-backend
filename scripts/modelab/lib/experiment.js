/* eslint-disable */
// r61 (F) — MODELAB · experimento A/B completo: plan → chequeo previo de presupuesto → dependencias congeladas →
// brazos × réplicas × componentes → calificación determinista → paquetes ciegos para rúbrica → regla go/no-go.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RN = require('./runner');
const AB = require('./audiobook');
const G = require('./grade');
const P = require('./project');
const { BudgetGuard, assertPreflight } = require('./budget');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SIM = require(path.join(ROOT, 'scripts/fixtures/commercial-simulation/courses.json'));
const DRIVER_TYPES = new Set(['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'activity', 'video_interactions', 'application_activity', 'guided_practice', 'exam', 'final_exam']);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function loadInput(inp) {
  if (inp.source === 'commercial-simulation') {
    const c = SIM.courses.find((x) => x.id === inp.fixtureId);
    if (!c) throw new Error(`modelab: fixture ${inp.fixtureId} no existe en commercial-simulation`);
    return JSON.parse(JSON.stringify(c));
  }
  if (inp.source === 'file') return JSON.parse(fs.readFileSync(path.resolve(ROOT, inp.path), 'utf8'));
  throw new Error(`modelab: fuente de entrada desconocida ${inp.source}`);
}

function selectorsOf(g) {
  const type = g.component === 'audiobook_chapter' ? 'content' : g.component;
  if (g.chapters) return g.chapters.map((ch) => ({ type, chapter: ch }));
  if (g.modules) return g.modules.map((m) => ({ type, module: m }));
  return [{ type }];
}

/** Proyección previa por evidencia (USD por ítem del ledger, factor peor 1,40). No depende del LLM falso. */
function evidenceItemUsd(component, model, factor = 1.4) {
  const ev = P.EVIDENCE_M[component];
  if (!ev) return 0;
  const t = P.componentTokens(component, 'M');
  const per = { in: t.in / perUnits(ev), out: t.out / perUnits(ev), cr: t.cr / perUnits(ev), cw: t.cw / perUnits(ev) };
  return P.usd(per, model, factor);
}
function perUnits(ev) { return ev.unit === 'chapter' ? 12 : ev.unit === 'module' ? 3 : 1; }

const SMOKE_MAX_TOKENS = 32;

/** USD previsto de UNA llamada de humo: la entrada media por llamada del componente a precio de escritura de caché + 32 de salida. */
function smokeCallUsd(component, model, factor = 1.4) {
  const ev = P.EVIDENCE_M[component];
  if (!ev) return 0;
  const perCallIn = (ev.in + ev.cr + ev.cw) / ev.calls;
  return P.usd({ in: 0, out: SMOKE_MAX_TOKENS, cr: 0, cw: perCallIn }, model, factor);
}

function planCost(cfg) {
  const arms = new Map(cfg.arms.map((a) => [a.id, a]));
  const lines = [];
  const depChapters = new Set();
  let smoke = 0;
  for (const g of cfg.components) {
    const n = g.chapters ? g.chapters.length : g.modules ? g.modules.length : 1;
    for (const id of g.arms) {
      const a = arms.get(id);
      lines.push({ component: g.component, arm: id, items: n, runs: g.runs || cfg.runsPerArm, usd: evidenceItemUsd(g.component, a.model) * n * (g.runs || cfg.runsPerArm) });
      smoke += smokeCallUsd(g.component, a.model);
    }
    if (g.component !== 'content') for (const ch of g.chapters || []) depChapters.add(`${g.input}|${ch.m}.${ch.c}`);
  }
  const base = arms.get(cfg.frozenDependenciesArm);
  const deps = depChapters.size * evidenceItemUsd('content', base.model) + cfg.inputs.length * evidenceItemUsd('course_plan', base.model);
  const total = lines.reduce((s, l) => s + l.usd, 0) + deps + smoke;
  return { lines, depsUsd: deps, smokeUsd: smoke, totalUsd: total };
}

/** Pedido representativo (ORIGINAL, receta del servidor) de la llamada principal de un componente: corrida offline mock. */
async function representativeBody(o, inputCfg, g) {
  if (g.component === 'audiobook_chapter') {
    const A = require(path.join(o.distRoot, 'workers/provider-real/audio-scripts.js'));
    const md = '## Bloque de prueba\n\n' + 'El compostaje doméstico transforma restos orgánicos en abono mediante la acción de microorganismos. '.repeat(12);
    const plan = A.planAudiobookSections(md);
    const pr = A.sectionNarrationPrompt({ courseTitle: inputCfg.title, chapterNumber: 1, chapterTitle: 'Capítulo de prueba', contentMarkdown: md }, plan.sections[0], plan.sections.length, null);
    return { model: 'claude-sonnet-4-6', max_tokens: pr.maxTokens, system: pr.system, messages: [{ role: 'user', content: pr.user }] };
  }
  const CL = require('./clients');
  const mock = CL.createMockClient();
  const bodies = [];
  const capt = { ...mock, providerRef: mock.providerRef, async call(adapted, original) { bodies.push(original); return mock.call(adapted, original); } };
  const r = await RN.runArm({ distRoot: o.distRoot, feRoot: o.feRoot, cfg: inputCfg, select: selectorsOf(g), arm: { id: 'probe', model: 'claude-sonnet-4-6', thinking: 'off' }, client: capt, guard: new BudgetGuard(1e9, { label: 'probe-offline' }) });
  const i = r.calls.findIndex((c) => c.componentType === g.component && c.callRole === 'main');
  if (i < 0) throw new Error(`modelab: sin llamada principal de ${g.component} para la llamada de humo`);
  return bodies[i];
}

/**
 * Review r61 I5: llamada de HUMO obligatoria por (componente, brazo) ANTES de gastar en dependencias o brazos: el pedido
 * real del componente adaptado al brazo con max_tokens chico, reservado en el presupuesto. Un 4xx aborta todo aquí.
 * Además (M3), count_tokens (gratis) del mismo pedido con el modelo del brazo y con Sonnet 4.6 → factor del tokenizer.
 */
async function smokePhase(o, cfg, arms, client, guard, common, results, log) {
  const factors = {};
  for (const inp of cfg.inputs) {
    const groups = cfg.components.filter((g) => g.input === inp.id);
    if (!groups.length) continue;
    const inputCfg = loadInput(inp);
    for (const g of groups) {
      const body = await representativeBody(o, inputCfg, g);
      for (const armId of g.arms) {
        const arm = arms.get(armId);
        const smokeArm = { ...arm, id: `${armId}#smoke`, maxTokensFactor: 1, maxTokensCap: SMOKE_MAX_TOKENS };
        const tags = { phase: 'smoke', input: inp.id, component: g.component, arm: armId, run: 0 };
        if (client.kind === 'mock') client.providerRef.provider = { name: 'smoke-stub', real: false, respond: () => ({ text: 'ok' }) };
        const { rec } = await RN.callThrough({ distRoot: o.distRoot, arm: smokeArm, client, guard, calls: [], ...common, tags }, body, { itemKey: `smoke:${g.component}`, componentType: g.component, callRole: 'smoke', requestHash: sha(JSON.stringify(body)) });
        let factor = null;
        if (client.countTokens && arm.model !== 'claude-sonnet-4-6') {
          const adapted = require('./models').adaptBody(body, arm);
          const [b46, bArm] = [await client.countTokens({ ...body, model: 'claude-sonnet-4-6' }), await client.countTokens(adapted)];
          factor = b46.input_tokens ? Math.round(bArm.input_tokens / b46.input_tokens * 1000) / 1000 : null;
          if (factor !== null) (factors[arm.model] = factors[arm.model] || []).push({ component: g.component, factor, tokens46: b46.input_tokens, simulated: !!(b46.simulated || bArm.simulated) });
        }
        results.smoke.push({ input: inp.id, component: g.component, arm: armId, model: arm.model, stopReason: rec.stopReason, usd: rec.usd, tokenizerFactor: factor });
      }
    }
  }
  // Factor ponderado por tokens de 4.6 (la ENTRADA real de cada componente).
  for (const [model, v] of Object.entries(factors)) {
    const w = v.reduce((s, x) => s + x.tokens46, 0);
    results.tokenizer[model] = { factor: w ? Math.round(v.reduce((s, x) => s + x.factor * x.tokens46, 0) / w * 1000) / 1000 : null, perComponent: v, simulated: v.some((x) => x.simulated) };
  }
  log(`  humo: ${results.smoke.length} llamadas OK; tokenizer ${JSON.stringify(Object.fromEntries(Object.entries(results.tokenizer).map(([m, t]) => [m, t.factor])))}`);
}

async function freezeDependencies(o, inputCfg, groups, client, guard, common, inpId, log) {
  // 1) Orden del sub-DAG con el LLM falso puro (sin brazo, sin costo) → dependencias = orden − objetivos.
  const D = require(path.join(ROOT, 'scripts/lib/offline-driver'));
  const allSel = groups.flatMap(selectorsOf);
  const probe = await D.runComponents(o.distRoot, inputCfg, { select: allSel, llm: { mode: 'fake' }, feRoot: o.feRoot });
  const targetsByGroup = new Map();
  const deps = new Set();
  for (const g of groups) {
    const p = await D.runComponents(o.distRoot, inputCfg, { select: selectorsOf(g), llm: { mode: 'fake' }, feRoot: o.feRoot });
    const targets = g.component === 'audiobook_chapter' ? [] : p.selection.selected;
    targetsByGroup.set(g, { targets, content: g.component === 'audiobook_chapter' ? p.selection.selected : [] });
    for (const k of p.selection.order) if (!targets.includes(k)) deps.add(k);
  }
  const depKeys = probe.selection.order.filter((k) => deps.has(k));
  // 2) Dependencias generadas UNA vez con el brazo congelado (en real: se pagan una vez) y exportadas como aprobadas.
  const r = await RN.runArm({ distRoot: o.distRoot, feRoot: o.feRoot, cfg: inputCfg, select: depKeys.map((key) => ({ key })), arm: o.depArm, client, guard, ...common, tags: { phase: 'dependencies', input: inpId, component: 'dependencies', arm: o.depArm.id, run: 0 } });
  const failed = depKeys.filter((k) => !r.res.items[k] || r.res.items[k].status !== 'completed');
  if (failed.length) throw Object.assign(new Error(`modelab: dependencias sin completar con ${o.depArm.id}: ${failed.join(', ')}`), { code: 'DEPENDENCIES_FAILED' });
  log(`  dependencias congeladas (${depKeys.length}) con ${o.depArm.id}: ${r.calls.length} llamadas, USD ${r.calls.reduce((s, c) => s + c.usd, 0).toFixed(4)}`);
  return { approved: RN.exportApproved(r.res, depKeys), targetsByGroup, depCalls: r.calls, prep: r.res.prep };
}

const sum = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function aggregate(runs) {
  const n = runs.length;
  const avg = (f) => { const v = runs.map(f).filter((x) => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000 : null; };
  const completed = sum(runs, (r) => r.completed);
  return {
    runs: n,
    items: sum(runs, (r) => r.items),
    completed,
    firstPassValidity: avg((r) => r.firstPassValidity),
    retriesPerItem: avg((r) => r.retriesPerItem),
    hardFailures: sum(runs, (r) => r.hardFailures),
    truncations: sum(runs, (r) => r.truncations),
    refusals: sum(runs, (r) => r.refusals),
    jsonInvalid: sum(runs, (r) => r.jsonInvalid),
    infraCalls: sum(runs, (r) => r.infraCalls),
    usd: r6(sum(runs, (r) => r.usd)),
    usdCold: r6(sum(runs, (r) => r.usdCold)),
    usdPerValidItem: completed ? r6(sum(runs, (r) => r.usd) / completed) : null,
    usdPerValidItemCold: completed ? r6(sum(runs, (r) => r.usdCold) / completed) : null,
    // null = no hay MC en este componente (p. ej. audiolibro, content, intros).
    answerLongestShare: avg((r) => r.quality && r.quality.answerLengthBias.share),
    repetitionRatio: avg((r) => r.quality && r.quality.repetition.ratio),
    languageHitsPer100Sentences: avg((r) => r.quality && r.quality.editorial.sentences ? (r.quality.editorial.VOSEO + r.quality.editorial.VOSOTROS + r.quality.editorial.REGIONAL + r.quality.editorial.ENGLISH_SENTENCES) * 100 / r.quality.editorial.sentences : 0),
    editorialMarkers: sum(runs, (r) => (r.quality ? r.quality.editorial.EDITORIAL_MARKERS : 0)),
    latencyMsP50: (() => { const l = runs.flatMap((r) => r.latencies || []).filter((x) => typeof x === 'number').sort((a, b) => a - b); return l.length ? l[Math.floor(l.length / 2)] : null; })(),
  };
}

/**
 * Regla go/no-go (criterios de B-model-audit §6 + review r61 I7/I9/M3). Estricta con los datos faltantes: una métrica
 * determinista ausente NUNCA aprueba (→ NO_GO con motivo «faltante»); la rúbrica ausente → PENDING_RUBRIC; el factor del
 * tokenizer medido ausente en un modelo con compuerta → PENDING_TOKENIZER. El ahorro se compara EN FRÍO (lecturas de caché
 * repreciadas como escritura) para que el estado de la caché entre réplicas no decida el veredicto.
 */
function decide(component, base, arm, rubric, crit, tokenizer) {
  const reasons = [];
  const pass = { firstPass: null, hardFailures: null, saving: null, bias: null, tokenizer: 'n/a', rubric: null };
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if (num(base.firstPassValidity) && num(arm.firstPassValidity)) {
    pass.firstPass = arm.firstPassValidity >= base.firstPassValidity - crit.firstPassMaxDrop;
    if (!pass.firstPass) reasons.push(`validez 1.ª pasada ${arm.firstPassValidity} < ${base.firstPassValidity} − ${crit.firstPassMaxDrop}`);
  } else { pass.firstPass = false; reasons.push('validez de 1.ª pasada faltante'); }
  const hard = (a) => [a.hardFailures, a.truncations, a.refusals, a.jsonInvalid];
  if (hard(base).every(num) && hard(arm).every(num)) {
    const newHard = hard(arm).reduce((x, y) => x + y, 0) - hard(base).reduce((x, y) => x + y, 0);
    pass.hardFailures = newHard <= 0;
    if (!pass.hardFailures) reasons.push(`${newHard} falla(s) dura(s) nuevas (fallas/truncados/refusal/JSON)`);
  } else { pass.hardFailures = false; reasons.push('conteo de fallas duras faltante'); }
  const bCost = num(base.usdPerValidItemCold) ? base.usdPerValidItemCold : null;
  const aCost = num(arm.usdPerValidItemCold) ? arm.usdPerValidItemCold : null;
  if (bCost && bCost > 0 && aCost !== null) {
    const saving = 1 - aCost / bCost;
    pass.saving = saving >= crit.minSavingPerValidItem;
    pass.savingValue = Math.round(saving * 1000) / 1000;
    if (!pass.saving) reasons.push(`ahorro en frío por ítem válido ${(saving * 100).toFixed(1)} % < ${crit.minSavingPerValidItem * 100} %`);
  } else { pass.saving = false; reasons.push('costo por ítem válido faltante (sin ítems válidos)'); }
  const bS = base.answerLongestShare, aS = arm.answerLongestShare;
  if (bS === null && aS === null) pass.bias = 'n/a';
  else if (num(bS) && num(aS)) {
    pass.bias = aS <= bS + crit.answerBiasMaxRise;
    if (!pass.bias) reasons.push(`sesgo de largo de la correcta sube ${bS}→${aS}`);
  } else { pass.bias = false; reasons.push('sesgo de largo faltante en un solo brazo'); }
  const gate = (crit.tokenizerGateModels || []).includes(arm.model);
  if (gate) {
    const t = tokenizer && tokenizer[arm.model];
    if (!t || !num(t.factor)) { pass.tokenizer = null; reasons.push('factor del tokenizer (count_tokens) faltante'); }
    else { pass.tokenizer = t.factor <= crit.maxTokenizerFactor; if (!pass.tokenizer) reasons.push(`factor del tokenizer ${t.factor} > ${crit.maxTokenizerFactor}`); if (t.simulated) reasons.push('factor del tokenizer SIMULADO (dry-run)'); }
  }
  const r = rubric && rubric[component];
  if (r && num(r[arm.armId]) && num(r[base.armId])) {
    pass.rubric = r[arm.armId] >= r[base.armId] - crit.rubricMaxDrop;
    if (!pass.rubric) reasons.push(`rúbrica ${r[arm.armId]} < ${r[base.armId]} − ${crit.rubricMaxDrop}`);
  }
  const ok = (v) => v === true || v === 'n/a';
  const det = ok(pass.firstPass) && ok(pass.hardFailures) && ok(pass.saving) && ok(pass.bias) && pass.tokenizer !== false;
  let verdict;
  if (!det) verdict = 'NO_GO';
  else if (pass.rubric === false) verdict = 'NO_GO';
  else if (pass.tokenizer === null) verdict = 'PENDING_TOKENIZER';
  else if (pass.rubric === null) verdict = 'PENDING_RUBRIC';
  else verdict = 'GO';
  return { verdict, pass, reasons };
}

function decideAll(results, rubric) {
  const cfg = results.config;
  for (const c of results.components) {
    const g = cfg.components.find((x) => x.component === c.component && x.input === c.input) || {};
    const baseId = g.baseline || cfg.baselineArm;
    c.decisions = {};
    for (const armId of Object.keys(c.arms)) if (armId !== baseId && c.arms[baseId]) c.decisions[armId] = decide(c.component, c.arms[baseId], c.arms[armId], rubric, cfg.successCriteria, results.tokenizer);
  }
  return results;
}

function rowFromCalls(calls) {
  return { truncations: calls.filter((c) => c.stopReason === 'max_tokens').length, refusals: calls.filter((c) => c.stopReason === 'refusal').length, infraCalls: calls.filter((c) => c.infra).length, usd: sum(calls, (c) => c.usd), usdCold: sum(calls, (c) => c.usdCold), latencies: calls.map((c) => c.latencyMs), resumedCalls: calls.filter((c) => c.resumed).length };
}

/**
 * Experimento completo. Siempre DEVUELVE resultados (también parciales): cualquier error queda en `aborted` con el gasto,
 * las llamadas y las respuestas registradas hasta ese momento (review r61 I1). `o.onResults(results, guard)` expone el
 * estado vivo (para el manejador de SIGINT/SIGTERM del CLI).
 */
async function runExperiment(o) {
  const cfg = o.config;
  const log = o.log || (() => {});
  const results = { experiment: cfg.id, mode: o.real ? 'real' : 'dry-run', config: cfg, startedAt: new Date().toISOString(), plan: null, preflight: null, inputs: {}, smoke: [], tokenizer: {}, components: [], calls: [], budget: null, aborted: null };
  let guard = null;
  try {
    results.plan = planCost(cfg);
    const approvedUsd = o.real ? o.approvedBudgetUsd : (cfg.approvedBudgetUsd ?? 5);
    guard = new BudgetGuard(approvedUsd, { label: o.real ? 'modelab-real' : 'modelab-dry-run', ledgerFile: o.ledgerFile || null });
    if (o.onResults) o.onResults(results, guard);
    if (o.real && guard.prior.spentUsd > 0 && !o.resume) {
      throw Object.assign(new Error(`ya hay ${guard.prior.spentUsd.toFixed(4)} USD gastados en ${o.ledgerFile}: relanzar con --resume (reutiliza lo pagado) o usar otro experimento`), { code: 'BUDGET_PRIOR_SPEND' });
    }
    // Con --resume, lo ya pagado (respuestas reutilizables) se descuenta de la proyección: no se vuelve a pagar.
    const resumedUsd = o.resume ? [...o.resume.values()].reduce((s, x) => s + (Number(x.usd) || 0), 0) : 0;
    results.preflight = assertPreflight(Math.max(0, results.plan.totalUsd - resumedUsd), approvedUsd, cfg.preflightMargin || 1.25, guard.prior.spentUsd);
    results.preflight.resumedUsd = resumedUsd;
    log(`plan: proyección USD ${results.plan.totalUsd.toFixed(3)} (× margen ${results.preflight.withMarginUsd.toFixed(3)}) ≤ disponible ${results.preflight.availableUsd.toFixed(3)} (aprobado ${approvedUsd}, gastado antes ${guard.prior.spentUsd.toFixed(4)})`);
    const client = o.clientFactory();
    const arms = new Map(cfg.arms.map((a) => [a.id, a]));
    const common = { sink: results.calls, resume: o.resume || null, onAnswer: o.onAnswer || null, backoffMs: o.backoffMs };
    await smokePhase(o, cfg, arms, client, guard, common, results, log);
    for (const inp of cfg.inputs) {
      const inputCfg = loadInput(inp);
      const groups = cfg.components.filter((g) => g.input === inp.id);
      if (!groups.length) continue;
      log(`entrada ${inp.id} (${inputCfg.id}, courseId ${inputCfg.courseId})`);
      const fz = await freezeDependencies({ ...o, depArm: arms.get(cfg.frozenDependenciesArm) }, inputCfg, groups, client, guard, common, inp.id, log);
      results.inputs[inp.id] = { fixture: inputCfg.id, courseId: inputCfg.courseId, frozenDependencies: Object.keys(fz.approved), frozenSha256: Object.fromEntries(Object.entries(fz.approved).map(([k, v]) => [k, v.artifacts.map((a) => a.sha256)])) };
      for (const g of groups) {
        const { targets, content } = fz.targetsByGroup.get(g);
        const perArm = {};
        const comp = { component: g.component, input: inp.id, targets: g.component === 'audiobook_chapter' ? content : targets, arms: {}, decisions: {}, runsDetail: perArm };
        results.components.push(comp);
        const runsN = g.runs || cfg.runsPerArm;
        for (let run = 1; run <= runsN; run++) {
          const order = g.arms.slice(run - 1).concat(g.arms.slice(0, run - 1)); // rota el orden por réplica
          for (const armId of order) {
            const arm = arms.get(armId);
            const tags = { phase: 'arm', input: inp.id, component: g.component, arm: armId, run };
            let row;
            if (g.component === 'audiobook_chapter') {
              const outs = [];
              for (const key of content) {
                const ap = fz.approved[key];
                const md = ap.artifacts.find((a) => a.type === 'dynamic_content_md').content;
                const flat = fz.prep.structure.modules.flatMap((m) => m.chapters);
                const idx = flat.findIndex((c) => key.endsWith(c.id));
                const ch = flat[idx] || { id: key, title: key };
                outs.push(await AB.runAudiobookChapter({ distRoot: o.distRoot, arm, client, guard, ...common, tags, contentMarkdown: md, courseTitle: inputCfg.title, chapterNumber: idx + 1, chapterTitle: ch.title, chapterId: ch.id, pais: (inputCfg.context && inputCfg.context.pais) || null }));
              }
              const calls = outs.flatMap((x) => x.calls);
              row = {
                items: outs.length, completed: outs.filter((x) => x.ok).length, firstPassValidity: outs.length ? outs.filter((x) => x.firstPassValid).length / outs.length : null,
                retriesPerItem: outs.length ? (outs.reduce((s, x) => s + x.continued + x.condensed, 0)) / outs.length : null,
                hardFailures: outs.reduce((s, x) => s + x.failures.length + (x.repetition.idxs.length ? 1 : 0), 0), jsonInvalid: 0,
                ...rowFromCalls(calls),
                detail: outs.map((x) => ({ itemKey: x.itemKey, ok: x.ok, sections: x.sections, failures: x.failures, meanRatio: x.meanRatio, continued: x.continued, condensed: x.condensed, repetition: x.repetition.detail, quality: x.quality })),
                quality: mergeQuality(outs.map((x) => x.quality)),
                docs: outs.map((x) => ({ itemKey: x.itemKey, text: x.texts.join('\n\n') })),
              };
            } else {
              const r = await RN.runArm({ distRoot: o.distRoot, feRoot: o.feRoot, cfg: inputCfg, select: targets.map((key) => ({ key })), approved: pickApproved(fz.approved, targets), arm, client, guard, ...common, tags });
              const gr = G.gradeArmRun(o.distRoot, r.res, targets, r.calls)[g.component] || { items: 0 };
              row = {
                items: gr.items, completed: gr.completed, firstPassValidity: gr.firstPassValidity, retriesPerItem: gr.retriesPerItem,
                hardFailures: gr.hardFailures ? gr.hardFailures.length : 0, jsonInvalid: gr.jsonInvalid || 0, ...rowFromCalls(r.calls),
                quality: gr.quality, rounds: r.rounds, orphanCalls: r.orphanCalls,
                failures: gr.hardFailures, docs: targets.filter((k) => r.res.items[k] && r.res.items[k].status === 'completed').map((k) => ({ itemKey: k, text: r.res.items[k].artifacts.map((a) => r.res.artifactText(a.id)).join('\n') })),
              };
            }
            (perArm[armId] = perArm[armId] || []).push(row);
            comp.arms[armId] = { armId, model: arm.model, ...aggregate(perArm[armId]) };
            log(`  ${g.component} · ${armId} · réplica ${run}: ${row.completed}/${row.items} válidos, 1.ª pasada ${row.firstPassValidity}, USD ${row.usd.toFixed(4)} (frío ${row.usdCold.toFixed(4)})`);
          }
        }
      }
    }
  } catch (e) {
    results.aborted = { code: (e && e.code) || 'ERROR', message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : null };
  } finally {
    results.budget = guard ? guard.snapshot() : null;
    results.finishedAt = new Date().toISOString();
    try { decideAll(results, o.rubric || null); } catch (e) { results.decideError = String(e.message || e); }
  }
  return results;
}

function pickApproved(approved, targets) {
  const out = {};
  for (const [k, v] of Object.entries(approved)) if (!targets.includes(k)) out[k] = v;
  return out;
}

function mergeQuality(qs) {
  const z = { docs: 0, words: 0, answerLengthBias: { mc: 0, share: null }, repetition: { shingles: 0, repeated: 0, ratio: 0 }, editorial: { sentences: 0, VOSEO: 0, VOSOTROS: 0, REGIONAL: 0, ENGLISH_SENTENCES: 0, EDITORIAL_MARKERS: 0 } };
  for (const q of qs) {
    z.docs += q.docs; z.words += q.words; z.repetition.shingles += q.repetition.shingles; z.repetition.repeated += q.repetition.repeated;
    for (const k of Object.keys(z.editorial)) z.editorial[k] += q.editorial[k] || 0;
  }
  z.repetition.ratio = z.repetition.shingles ? Math.round(z.repetition.repeated / z.repetition.shingles * 1000) / 1000 : 0;
  return z;
}

/** Review r61 M5: ningún id/nombre de modelo puede filtrarse a un paquete ciego. */
function redactModels(t) { return String(t).replace(/claude[-_][a-z0-9.\-]+/gi, '[MODELO]').replace(/\b(sonnet|haiku|opus|fable|anthropic)\b/gi, '[MODELO]'); }

/** Paquetes CIEGOS para rúbrica (juez LLM opcional u humano): pares baseline vs brazo con etiquetas al azar. */
function judgePackets(results, cfg, seed = 'modelab') {
  const packets = [];
  const key = [];
  for (const c of results.components) {
    const baseId = cfg.baselineArm;
    const base = c.runsDetail[baseId] || [];
    for (const [armId, runs] of Object.entries(c.runsDetail)) {
      if (armId === baseId) continue;
      runs.forEach((row, ri) => {
        const b = base[ri];
        if (!b) return;
        for (const d of row.docs || []) {
          const bd = (b.docs || []).find((x) => x.itemKey === d.itemKey);
          if (!bd) continue;
          const id = sha(`${seed}|${c.component}|${armId}|${ri}|${d.itemKey}`).slice(0, 16);
          const flip = parseInt(id.slice(0, 2), 16) % 2 === 1;
          packets.push({ id, component: c.component, itemKey: d.itemKey, rubric: cfg.rubric.criteria.map((x) => x.id), X: redactModels(flip ? d.text : bd.text), Y: redactModels(flip ? bd.text : d.text) });
          key.push({ id, component: c.component, itemKey: d.itemKey, X: flip ? armId : baseId, Y: flip ? baseId : armId });
        }
      });
    }
  }
  return { packets, key };
}

/** Importa puntajes (1–5) por paquete y los convierte en medias por componente × brazo (para `decide`). */
function rubricFromScores(scores, key) {
  const byId = new Map(key.map((k) => [k.id, k]));
  const acc = {};
  for (const s0 of scores) {
    const k = byId.get(s0.id);
    if (!k) continue;
    const s = { ...s0, component: k.component || s0.component }; // review r61 M4: el componente sale de la CLAVE, no del archivo de puntajes
    for (const side of ['X', 'Y']) {
      const v = s[side];
      if (typeof v !== 'number') continue;
      const a = ((acc[s.component] = acc[s.component] || {})[k[side]] = acc[s.component][k[side]] || []);
      a.push(v);
    }
  }
  const out = {};
  for (const [c, arms] of Object.entries(acc)) { out[c] = {}; for (const [a, v] of Object.entries(arms)) out[c][a] = Math.round(v.reduce((x, y) => x + y, 0) / v.length * 100) / 100; }
  return out;
}

module.exports = { runExperiment, planCost, decide, decideAll, aggregate, judgePackets, rubricFromScores, evidenceItemUsd, loadInput, redactModels, SMOKE_MAX_TOKENS };
