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

function planCost(cfg) {
  const arms = new Map(cfg.arms.map((a) => [a.id, a]));
  const lines = [];
  const depChapters = new Set();
  for (const g of cfg.components) {
    const n = g.chapters ? g.chapters.length : g.modules ? g.modules.length : 1;
    for (const id of g.arms) {
      const a = arms.get(id);
      lines.push({ component: g.component, arm: id, items: n, runs: g.runs || cfg.runsPerArm, usd: evidenceItemUsd(g.component, a.model) * n * (g.runs || cfg.runsPerArm) });
    }
    if (g.component !== 'content') for (const ch of g.chapters || []) depChapters.add(`${g.input}|${ch.m}.${ch.c}`);
  }
  const base = arms.get(cfg.frozenDependenciesArm);
  const deps = depChapters.size * evidenceItemUsd('content', base.model) + cfg.inputs.length * evidenceItemUsd('course_plan', base.model);
  const total = lines.reduce((s, l) => s + l.usd, 0) + deps;
  return { lines, depsUsd: deps, totalUsd: total };
}

async function freezeDependencies(o, inputCfg, groups, client, guard, log) {
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
  const r = await RN.runArm({ distRoot: o.distRoot, feRoot: o.feRoot, cfg: inputCfg, select: depKeys.map((key) => ({ key })), arm: o.depArm, client, guard });
  const failed = depKeys.filter((k) => !r.res.items[k] || r.res.items[k].status !== 'completed');
  if (failed.length) throw new Error(`modelab: dependencias sin completar con ${o.depArm.id}: ${failed.join(', ')}`);
  log(`  dependencias congeladas (${depKeys.length}) con ${o.depArm.id}: ${r.calls.length} llamadas, USD ${r.calls.reduce((s, c) => s + c.usd, 0).toFixed(4)}`);
  return { approved: RN.exportApproved(r.res, depKeys), targetsByGroup, depCalls: r.calls, prep: r.res.prep };
}

function aggregate(runs) {
  // runs: [{grade(per type), calls, hardFailures}] de un (componente, brazo).
  const n = runs.length;
  const avg = (f) => { const v = runs.map(f).filter((x) => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000 : null; };
  return {
    runs: n,
    items: runs.reduce((s, r) => s + r.items, 0),
    completed: runs.reduce((s, r) => s + r.completed, 0),
    firstPassValidity: avg((r) => r.firstPassValidity),
    retriesPerItem: avg((r) => r.retriesPerItem),
    hardFailures: runs.reduce((s, r) => s + r.hardFailures, 0),
    truncations: runs.reduce((s, r) => s + r.truncations, 0),
    refusals: runs.reduce((s, r) => s + r.refusals, 0),
    jsonInvalid: runs.reduce((s, r) => s + (r.jsonInvalid || 0), 0),
    usd: Math.round(runs.reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6,
    usdPerValidItem: (() => { const c = runs.reduce((s, r) => s + r.completed, 0); return c ? Math.round(runs.reduce((s, r) => s + r.usd, 0) / c * 1e6) / 1e6 : null; })(),
    answerLongestShare: avg((r) => r.quality && r.quality.answerLengthBias.share),
    repetitionRatio: avg((r) => r.quality && r.quality.repetition.ratio),
    languageHitsPer100Sentences: avg((r) => r.quality && r.quality.editorial.sentences ? (r.quality.editorial.VOSEO + r.quality.editorial.VOSOTROS + r.quality.editorial.REGIONAL + r.quality.editorial.ENGLISH_SENTENCES) * 100 / r.quality.editorial.sentences : 0),
    editorialMarkers: runs.reduce((s, r) => s + (r.quality ? r.quality.editorial.EDITORIAL_MARKERS : 0), 0),
    latencyMsP50: (() => { const l = runs.flatMap((r) => r.latencies).filter((x) => typeof x === 'number').sort((a, b) => a - b); return l.length ? l[Math.floor(l.length / 2)] : null; })(),
  };
}

/** Regla go/no-go (criterios de B-model-audit §6). `rubric`: {component: {armId: meanScore}} (opcional). */
function decide(component, base, arm, rubric, crit) {
  const reasons = [];
  const pass = { firstPass: null, hardFailures: null, saving: null, rubric: null };
  if (base.firstPassValidity !== null && arm.firstPassValidity !== null) {
    pass.firstPass = arm.firstPassValidity >= base.firstPassValidity - crit.firstPassMaxDrop;
    if (!pass.firstPass) reasons.push(`validez 1.ª pasada ${arm.firstPassValidity} < ${base.firstPassValidity} − ${crit.firstPassMaxDrop}`);
  }
  const newHard = (arm.hardFailures + arm.truncations + arm.refusals + arm.jsonInvalid) - (base.hardFailures + base.truncations + base.refusals + base.jsonInvalid);
  pass.hardFailures = newHard <= 0;
  if (!pass.hardFailures) reasons.push(`${newHard} falla(s) dura(s) nuevas (fallas/truncados/refusal/JSON)`);
  if (base.usdPerValidItem && arm.usdPerValidItem !== null) {
    const saving = 1 - arm.usdPerValidItem / base.usdPerValidItem;
    pass.saving = saving >= crit.minSavingPerValidItem;
    if (!pass.saving) reasons.push(`ahorro por ítem válido ${(saving * 100).toFixed(1)} % < ${crit.minSavingPerValidItem * 100} %`);
  } else { pass.saving = false; reasons.push('sin ítems válidos para medir el ahorro'); }
  if (arm.answerLongestShare !== null && base.answerLongestShare !== null && arm.answerLongestShare > base.answerLongestShare + crit.answerBiasMaxRise) {
    reasons.push(`sesgo de largo de la correcta sube ${base.answerLongestShare}→${arm.answerLongestShare}`);
    pass.firstPass = pass.firstPass && false;
  }
  const r = rubric && rubric[component];
  if (r && typeof r[arm.armId] === 'number' && typeof r[base.armId] === 'number') {
    pass.rubric = r[arm.armId] >= r[base.armId] - crit.rubricMaxDrop;
    if (!pass.rubric) reasons.push(`rúbrica ${r[arm.armId]} < ${r[base.armId]} − ${crit.rubricMaxDrop}`);
  }
  const det = pass.firstPass !== false && pass.hardFailures && pass.saving;
  const verdict = !det ? 'NO_GO' : pass.rubric === null ? 'PENDING_RUBRIC' : pass.rubric ? 'GO' : 'NO_GO';
  return { verdict, pass, reasons };
}

async function runExperiment(o) {
  const cfg = o.config;
  const log = o.log || (() => {});
  const plan = planCost(cfg);
  const approvedUsd = o.real ? o.approvedBudgetUsd : (cfg.approvedBudgetUsd ?? 5);
  const preflight = assertPreflight(plan.totalUsd, approvedUsd, cfg.preflightMargin || 1.25);
  log(`plan: proyección por evidencia USD ${plan.totalUsd.toFixed(3)} (con margen ${preflight.withMarginUsd.toFixed(3)}) ≤ aprobado ${approvedUsd}`);
  const guard = new BudgetGuard(approvedUsd, { label: o.real ? 'modelab-real' : 'modelab-dry-run' });
  const client = o.clientFactory();
  const arms = new Map(cfg.arms.map((a) => [a.id, a]));
  const results = { experiment: cfg.id, mode: o.real ? 'real' : 'dry-run', startedAt: o.now || null, plan, preflight, inputs: {}, components: [], calls: [], budget: null, aborted: null };
  try {
    for (const inp of cfg.inputs) {
      const inputCfg = loadInput(inp);
      const groups = cfg.components.filter((g) => g.input === inp.id);
      if (!groups.length) continue;
      log(`entrada ${inp.id} (${inputCfg.id}, courseId ${inputCfg.courseId})`);
      const fz = await freezeDependencies({ ...o, depArm: arms.get(cfg.frozenDependenciesArm) }, inputCfg, groups, client, guard, log);
      results.calls.push(...fz.depCalls.map((c) => ({ ...c, phase: 'dependencies', input: inp.id })));
      results.inputs[inp.id] = { fixture: inputCfg.id, courseId: inputCfg.courseId, frozenDependencies: Object.keys(fz.approved), frozenSha256: Object.fromEntries(Object.entries(fz.approved).map(([k, v]) => [k, v.artifacts.map((a) => a.sha256)])) };
      for (const g of groups) {
        const { targets, content } = fz.targetsByGroup.get(g);
        const perArm = {};
        const runsN = g.runs || cfg.runsPerArm;
        for (let run = 1; run <= runsN; run++) {
          const order = g.arms.slice(run - 1).concat(g.arms.slice(0, run - 1)); // rota el orden por réplica
          for (const armId of order) {
            const arm = arms.get(armId);
            let row;
            if (g.component === 'audiobook_chapter') {
              const outs = [];
              for (const key of content) {
                const ap = fz.approved[key];
                const md = ap.artifacts.find((a) => a.type === 'dynamic_content_md').content;
                const flat = fz.prep.structure.modules.flatMap((m) => m.chapters);
                const idx = flat.findIndex((c) => key.endsWith(c.id));
                const ch = flat[idx] || { id: key, title: key };
                outs.push(await AB.runAudiobookChapter({ distRoot: o.distRoot, arm, client, guard, contentMarkdown: md, courseTitle: inputCfg.title, chapterNumber: idx + 1, chapterTitle: ch.title, chapterId: ch.id, pais: (inputCfg.context && inputCfg.context.pais) || null }));
              }
              const calls = outs.flatMap((x) => x.calls);
              results.calls.push(...calls.map((c) => ({ ...c, phase: 'arm', input: inp.id, arm: armId, run })));
              row = {
                items: outs.length, completed: outs.filter((x) => x.ok).length, firstPassValidity: outs.length ? outs.filter((x) => x.firstPassValid).length / outs.length : null,
                retriesPerItem: outs.length ? (outs.reduce((s, x) => s + x.continued + x.condensed, 0)) / outs.length : null,
                hardFailures: outs.reduce((s, x) => s + x.failures.length + (x.repetition.idxs.length ? 1 : 0), 0),
                truncations: calls.filter((c) => c.stopReason === 'max_tokens').length, refusals: calls.filter((c) => c.stopReason === 'refusal').length, jsonInvalid: 0,
                usd: outs.reduce((s, x) => s + x.usd, 0), latencies: calls.map((c) => c.latencyMs),
                detail: outs.map((x) => ({ itemKey: x.itemKey, ok: x.ok, sections: x.sections, failures: x.failures, meanRatio: x.meanRatio, continued: x.continued, condensed: x.condensed, repetition: x.repetition.detail, quality: x.quality })),
              };
              row.quality = mergeQuality(outs.map((x) => x.quality));
              row.docs = outs.map((x) => ({ itemKey: x.itemKey, text: x.texts.join('\n\n') }));
            } else {
              const r = await RN.runArm({ distRoot: o.distRoot, feRoot: o.feRoot, cfg: inputCfg, select: targets.map((key) => ({ key })), approved: pickApproved(fz.approved, targets), arm, client, guard });
              results.calls.push(...r.calls.map((c) => ({ ...c, phase: 'arm', input: inp.id, arm: armId, run })));
              const gr = G.gradeArmRun(o.distRoot, r.res, targets, r.calls)[g.component] || { items: 0 };
              row = {
                items: gr.items, completed: gr.completed, firstPassValidity: gr.firstPassValidity, retriesPerItem: gr.retriesPerItem,
                hardFailures: gr.hardFailures ? gr.hardFailures.length : 0, truncations: r.calls.filter((c) => c.stopReason === 'max_tokens').length,
                refusals: r.calls.filter((c) => c.stopReason === 'refusal').length, jsonInvalid: gr.jsonInvalid || 0, usd: r.calls.reduce((s, c) => s + c.usd, 0),
                quality: gr.quality, latencies: r.calls.map((c) => c.latencyMs), rounds: r.rounds, orphanCalls: r.orphanCalls,
                failures: gr.hardFailures, docs: targets.filter((k) => r.res.items[k] && r.res.items[k].status === 'completed').map((k) => ({ itemKey: k, text: r.res.items[k].artifacts.map((a) => r.res.artifactText(a.id)).join('\n') })),
              };
            }
            (perArm[armId] = perArm[armId] || []).push(row);
            log(`  ${g.component} · ${armId} · réplica ${run}: ${row.completed}/${row.items} válidos, 1.ª pasada ${row.firstPassValidity}, USD ${row.usd.toFixed(4)}`);
          }
        }
        const agg = {};
        for (const [armId, runs] of Object.entries(perArm)) agg[armId] = { armId, model: arms.get(armId).model, ...aggregate(runs) };
        const baseId = g.baseline || cfg.baselineArm;
        const decisions = {};
        for (const armId of g.arms) if (armId !== baseId && agg[baseId]) decisions[armId] = decide(g.component, agg[baseId], agg[armId], o.rubric, cfg.successCriteria);
        results.components.push({ component: g.component, input: inp.id, targets: g.component === 'audiobook_chapter' ? content : targets, arms: agg, decisions, runsDetail: perArm });
      }
    }
  } catch (e) {
    if (e && (e.code === 'BUDGET_EXCEEDED' || e.code === 'ARM_REQUEST_INVALID')) results.aborted = { code: e.code, message: e.message };
    else throw e;
  }
  results.budget = guard.snapshot();
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
          packets.push({ id, component: c.component, itemKey: d.itemKey, rubric: cfg.rubric.criteria.map((x) => x.id), X: flip ? d.text : bd.text, Y: flip ? bd.text : d.text });
          key.push({ id, X: flip ? armId : baseId, Y: flip ? baseId : armId });
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
  for (const s of scores) {
    const k = byId.get(s.id);
    if (!k) continue;
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

module.exports = { runExperiment, planCost, decide, aggregate, judgePackets, rubricFromScores, evidenceItemUsd, loadInput };
