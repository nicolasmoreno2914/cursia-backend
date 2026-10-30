#!/usr/bin/env node
/* eslint-disable no-console */
// r79.2 · §13.2, §13.6, §13.7 — optimizador y Actividades proporcionales. Puro: sin IA, sin red, sin base. USD 0.
//
//   PJ1 proyecto integrador SÍ: módulos con ≥ 2 contenidos cuyos objetivos y resultados piden DISEÑAR / ELABORAR (síntesis,
//       producción) → el diseño con tipos «automático» elige un proyecto integrador (regla K2) en el primer capítulo de
//       práctica del módulo, nivel 90/120, con su motivo
//   PJ2 control NO: el mismo curso con objetivos y resultados de RECONOCER / IDENTIFICAR / DESCRIBIR → ningún proyecto
//   PJ3 horas y costo coherentes: con y sin tipos, mismas horas, mismas Actividades y minutos; costo con proyecto ≥ sin él
//       (el proyecto no es más barato que la Actividad de siempre del mismo nivel) y la diferencia sale SOLO de Anthropic
//   PJ4 lo mismo dentro del ajuste al presupuesto (palanca de tipos): con presupuesto holgado, proyecto en PJ1 y no en PJ2
//   OP1 candado de proporcionalidad: TODOS los niveles de TODOS los tipos tienen candado y lo pasan; con la especificación
//       anterior (v1: 30 y 60 pedían lo mismo) el optimizador NO elige 60/90/120 (más minutos sin más trabajo = cerrado)
//   OP2 20 / 60 / 100 h × (sin documento | microcurrículo de 6 contenidos) × 3 presupuestos × tipos ninguno/auto: en TODO
//       diseño devuelto (elegido y alternativas) ningún capítulo de contenido existente u obligatorio desaparece, cada
//       concepto obligatorio conserva su capítulo teórico, las horas no superan la meta + tolerancia (sin inflar), los
//       ejercicios guiados ≤ 30 %, y cada Actividad usa un nivel abierto por el candado (re-verificado capítulo a capítulo
//       sobre la distribución reproducida con las preferencias elegidas: misma huella)
//   OP3 con las Actividades proporcionales la práctica sigue costando mucho menos que un capítulo de contenido (por item)
//
// Uso: npm run build && node scripts/check-r79-2-optimizer.js [path/to/dist]
'use strict';
const path = require('path');
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  globalThis.fetch = deny('fetch');
}
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (r) => require(path.join(distRoot, r));
const P = L('modules/pedagogy/index.js');
const F = L('modules/course-design/budget-fit.js');
const K = L('modules/course-shell/application-kinds.js');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✅ ${name}`); } catch (e) { failures++; console.log(`  ❌ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
const course = (mods, chs, objective) => ({ course: { title: 'Seguridad y salud en el trabajo', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], objective: objective(i, -1), examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: tema ${j + 1}`, objective: objective(i, j) })) })) });
const learner = { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' };
const profile = (h, outcomes, dp = {}) => ({ pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner, learningOutcomes: outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended', ...dp } });
// Síntesis / producción (Bloom crear): diseñar, elaborar, formular.
const CREATE = {
  objective: (i, j) => (j < 0 ? 'Diseñar el plan de prevención del área' : j === 0 ? `Elaborar la matriz de ${TOPICS[i].toLowerCase()} de una tarea real` : `Diseñar un plan de controles para ${TOPICS[i].toLowerCase()}`),
  outcomes: { know: ['Los tipos de riesgo'], do: ['Diseñar un plan de prevención para su área', 'Elaborar un informe de evaluación de riesgos'], competencies: ['Formula planes de prevención para su área'] },
};
// Control: reconocer / identificar / describir (sin crear ni producir).
const RECALL = {
  objective: (i, j) => (j < 0 ? 'Reconocer los elementos de la prevención' : j === 0 ? `Identificar los conceptos de ${TOPICS[i].toLowerCase()}` : `Describir los tipos de ${TOPICS[i].toLowerCase()}`),
  outcomes: { know: ['Los tipos de riesgo'], do: ['Identificar los riesgos de su área', 'Reconocer los elementos de protección'], competencies: ['Reconoce los riesgos de su área'] },
};
const dry = (st, h, oc, dp) => P.runPedagogyDryRun({ structure: st, profile: profile(h, oc, dp), activityTypeRules: 2 }).distribution;
const chaptersOf = (d) => d.modules.flatMap((m) => m.chapters.map((c) => ({ ...c, moduleId: m.id })));
const projects = (d) => chaptersOf(d).filter((c) => c.applicationKind === 'integrative_project');
const usdOf = (d) => Number(d.materialized.providers.estimateUsd.expected);

console.log('r79.2 · Optimizador, proyecto integrador y Actividades proporcionales');

const H = 60;
const pj = {};
for (const [name, spec] of [['create', CREATE], ['recall', RECALL]]) {
  const st = () => course(3, 2, spec.objective);
  pj[name] = { st, spec, none: dry(st(), H, spec.outcomes, {}), auto: dry(st(), H, spec.outcomes, { activityKinds: 'auto' }) };
}

check('PJ1 proyecto integrador SÍ cuando los objetivos y resultados piden diseñar / elaborar', () => {
  const d = pj.create.auto;
  const ps = projects(d);
  assert(ps.length >= 1, `sin proyecto: ${JSON.stringify(d.activityKinds && d.activityKinds.counts)}`);
  for (const p of ps) {
    const m = d.modules.find((x) => x.id === p.moduleId);
    const firstPractice = m.chapters.find((c) => c.kind === 'practice');
    assert(firstPractice && firstPractice.id === p.id, `${p.id}: el proyecto va en el primer capítulo de práctica`);
    assert(m.chapters.filter((c) => c.kind === 'content').length >= 2, `${p.id}: el módulo tiene ≥ 2 contenidos`);
    assert([90, 120].includes(p.applicationMinutes), `${p.id}: nivel ${p.applicationMinutes}`);
    const dec = d.activityKinds.decisions.find((x) => x.chapterId === p.id);
    assert(dec && dec.ruleId === 'K2' && /crear o producir/.test(dec.reason), `${p.id}: motivo ${dec && dec.reason}`);
  }
  console.log(`      ${ps.length} proyecto(s): ${ps.map((p) => `${p.id} ${p.applicationMinutes} min`).join(', ')}`);
});

check('PJ2 control: sin señal de síntesis/producción, ningún proyecto integrador', () => {
  eq(projects(pj.recall.auto).length, 0, 'proyectos en el curso de control');
  assert(!pj.recall.auto.activityKinds.decisions.some((x) => x.kind === 'integrative_project'), 'decisión de proyecto en el control');
});

check('PJ3 horas y costo coherentes con y sin tipos (el proyecto no agrega horas ni abarata)', () => {
  for (const name of ['create', 'recall']) {
    const { none, auto } = pj[name];
    eq(auto.estimatedHours, none.estimatedHours, `${name}: horas`);
    eq([auto.counts.applicationActivities, auto.counts.applicationMinutes, auto.counts.chapters], [none.counts.applicationActivities, none.counts.applicationMinutes, none.counts.chapters], `${name}: Actividades, minutos y capítulos`);
    eq(chaptersOf(auto).map((c) => [c.id, c.applicationMinutes]), chaptersOf(none).map((c) => [c.id, c.applicationMinutes]), `${name}: mismos niveles por capítulo`);
    assert(usdOf(auto) >= usdOf(none) - 1e-9, `${name}: con tipos ${usdOf(auto)} < sin tipos ${usdOf(none)}`);
    const bp = (d) => d.materialized.providers.estimateUsd.byProvider || {};
    for (const prov of Object.keys({ ...bp(none), ...bp(auto) })) if (prov !== 'anthropic') eq(bp(auto)[prov], bp(none)[prov], `${name}: ${prov} igual`);
  }
  console.log(`      create: ${pj.create.none.estimatedHours} h · USD ${usdOf(pj.create.none).toFixed(2)} → ${usdOf(pj.create.auto).toFixed(2)} con tipos · recall: USD ${usdOf(pj.recall.none).toFixed(2)} → ${usdOf(pj.recall.auto).toFixed(2)}`);
});

const LEVERS = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false }, activityKinds: { base: 'none', locked: false } };
check('PJ4 dentro del ajuste al presupuesto: proyecto en el curso que lo justifica, no en el control', () => {
  for (const [name, want] of [['create', true], ['recall', false]]) {
    // 40 h: lo que un curso de 3 × 2 alcanza sin relleno (a 60 h no llega: «No cabe» por horas, no por presupuesto).
    const r = F.fitDesignToBudget({ base: { structure: pj[name].st(), profile: profile(40, pj[name].spec.outcomes), activityTypeRules: 2 }, budgetUsd: 500, levers: LEVERS });
    assert(r.status === 'fits', `${name}: ${r.status}`);
    const n = r.chosen.structure.applicationKinds.integrative_project || 0;
    assert(want ? n >= 1 : n === 0, `${name}: proyectos ${n} (${JSON.stringify(r.chosen.structure.applicationKinds)})`);
  }
});

check('OP1 candado en todos los niveles y tipos; con la especificación anterior el optimizador no elige 60/90/120', () => {
  const lock = K.applicationTierLock();
  for (const r of lock) assert(r.enforced && r.proportional && r.selectable, `${r.kind} ${r.minutes}: ${JSON.stringify(r)}`);
  const legacy = K.applicationTierLock((k, m) => (k === 'standard' ? K.specifiedWorkMinutes(k, m, 1) : K.specifiedWorkMinutes(k, m)));
  const closed = legacy.filter((r) => r.kind === 'standard' && !r.selectable).map((r) => r.minutes);
  eq(closed, [60, 90, 120], 'v1: niveles cerrados');
  for (const [st, h] of [[course(3, 2, CREATE.objective), 20], [course(6, 1, CREATE.objective), 60], [course(8, 2, CREATE.objective), 100]]) {
    const d = P.runPedagogyDryRun({ structure: st, profile: profile(h, CREATE.outcomes), activityTypeRules: 2, tierLock: legacy }).distribution;
    const used = [...new Set(chaptersOf(d).filter((c) => c.applicationMinutes !== null).map((c) => c.applicationMinutes))];
    assert(used.every((m) => m === 30), `${h} h con el candado v1: niveles ${used}`);
    const r = F.fitDesignToBudget({ base: { structure: st, profile: profile(h, CREATE.outcomes), activityTypeRules: 2 }, budgetUsd: 5000, levers: LEVERS, tierLock: legacy });
    for (const dz of [r.chosen, ...r.alternatives.map((a) => a.design)].filter(Boolean)) {
      const tiers = Object.keys(dz.structure.applicationTiers).map(Number);
      assert(tiers.every((m) => m === 30), `${h} h ajuste con el candado v1: ${tiers}`);
    }
  }
});

const DOC6 = { sources: { chapters: 'REQ-contenidos' }, modulesFixed: 3, contentChaptersPerModule: { min: 2 } };
const CASES = [
  { h: 20, s: () => course(3, 2, CREATE.objective), doc: null, budgets: [15, 30, 60] },
  { h: 20, s: () => course(3, 2, CREATE.objective), doc: DOC6, budgets: [15, 30, 60] },
  { h: 60, s: () => course(6, 1, CREATE.objective), doc: null, budgets: [35, 66, 90] },
  { h: 60, s: () => course(3, 2, CREATE.objective), doc: DOC6, budgets: [35, 60, 90] },
  { h: 100, s: () => course(8, 2, CREATE.objective), doc: null, budgets: [60, 88, 150] },
  { h: 100, s: () => course(3, 2, CREATE.objective), doc: DOC6, budgets: [60, 90, 150] },
];
check('OP2 20/60/100 h × documento × presupuesto × tipos: nunca se pierde contenido obligatorio ni se inflan horas', () => {
  const summary = [];
  let verified = 0;
  for (const c of CASES) {
    const base = c.s();
    const baseIds = base.modules.flatMap((m) => m.chapters.map((x) => x.id));
    const mandatory = c.doc ? 6 : 0;
    for (const usd of c.budgets) {
      for (const kinds of ['none', 'auto']) {
        const lev = { ...LEVERS, activityKinds: { base: kinds, locked: false } };
        const inp = { structure: c.s(), profile: profile(c.h, CREATE.outcomes), activityTypeRules: 2, ...(c.doc ? { requirementConstraints: c.doc } : {}) };
        const r = F.fitDesignToBudget({ base: inp, budgetUsd: usd, levers: lev });
        // El «mínimo de la estructura» es informativo (sin botón, sin meta de horas): sus horas son las de la estructura base.
        const designs = [r.chosen, ...r.alternatives.filter((a) => a.kind !== 'minimum_budget').map((a) => a.design)].filter(Boolean);
        for (const d of designs) {
          const tag = `${c.h} h ${c.doc ? 'doc6' : 'sin doc'} USD ${usd} ${kinds} → ${d.targetHours} h`;
          assert(d.structure.contentChapters >= Math.max(mandatory, baseIds.length), `${tag}: ${d.structure.contentChapters} contenidos < ${Math.max(mandatory, baseIds.length)}`);
          if (c.doc) assert(d.structure.contentByModule.every((n) => n >= 2), `${tag}: un módulo con < 2 contenidos obligatorios ${d.structure.contentByModule}`);
          const tol = Math.max(1, d.targetHours * 0.05);
          assert(d.estimatedHours <= d.targetHours + tol + 1e-9, `${tag}: ${d.estimatedHours} h > meta ${d.targetHours} + ${tol}`);
          assert(d.quality.guidedShare <= 0.3 + 1e-9, `${tag}: guiados ${d.quality.guidedShare}`);
          for (const t of Object.keys(d.structure.applicationTiers)) assert(K.isTierSelectable('standard', Number(t)), `${tag}: nivel ${t} cerrado`);
        }
        // Capítulo a capítulo: la distribución reproducida con las preferencias elegidas da la MISMA huella.
        if (r.chosen) {
          const p = r.chosen.preferences;
          const dp = { audiovisual: p.audiovisual, ...(p.guidedPractice === 'none' ? { guidedPractice: 'none' } : {}), ...(p.emphasis !== 'balanced' ? { emphasis: p.emphasis } : {}), ...(p.maxContentChaptersPerModule !== null ? { maxContentChaptersPerModule: p.maxContentChaptersPerModule } : {}), ...(p.activityKinds === 'auto' ? { activityKinds: 'auto' } : {}) };
          const dist = P.runPedagogyDryRun({ ...inp, structure: c.s(), profile: profile(r.chosen.targetHours, CREATE.outcomes, dp) }).distribution;
          if (dist.proposalSha256 === r.chosen.proposalSha256) {
            verified++;
            const chs = chaptersOf(dist);
            for (const id of baseIds) assert(chs.some((x) => x.id === id && x.kind === 'content'), `${c.h} h USD ${usd}: el capítulo teórico ${id} desapareció`);
            for (const x of chs) if (x.applicationMinutes !== null && !x.applicationPinned) assert(K.isTierSelectable(x.applicationKind || 'standard', x.applicationMinutes), `${x.id}: ${x.applicationKind || 'standard'} ${x.applicationMinutes} cerrado`);
          }
        }
        summary.push(`${c.h}/${c.doc ? 'doc' : '-'}/${usd}/${kinds}:${r.status}`);
      }
    }
  }
  assert(verified >= 6, `pocas distribuciones re-verificadas capítulo a capítulo (${verified})`);
  console.log(`      ${summary.length} combinaciones · ${verified} re-verificadas capítulo a capítulo · ${summary.join(' ')}`);
});

check('OP3 la práctica sigue costando mucho menos que un capítulo de contenido (medición directa por item, r79.2)', () => {
  const r = F.fitDesignToBudget({ base: { structure: course(6, 1, CREATE.objective), profile: profile(60, CREATE.outcomes), activityTypeRules: 2 }, budgetUsd: 5000, levers: LEVERS });
  const c = r.chosen.costByItemType;
  const avg = (k) => (c[k] ? Number(c[k].expected) / c[k].items : 0);
  const practice = avg('experience') + avg('activity') + avg('application_activity');
  const content = avg('content') + avg('presentation') + avg('audiobook_chapter') + practice;
  assert(practice < 0.6 * content, `práctica USD ${practice.toFixed(2)} vs contenido USD ${content.toFixed(2)}`);
  console.log(`      práctica ≈ USD ${practice.toFixed(2)} · contenido (sin video) ≈ USD ${content.toFixed(2)} (${(practice / content).toFixed(2)}×)`);
});

eq(netAttempts, [], 'red');
console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
