#!/usr/bin/env node
/* eslint-disable no-console */
// r79 · condición 10: ejemplos comparativos de cursos de 20, 60 y 100 h (sintéticos), con y sin un microcurrículo que fija
// 6 contenidos, cada uno con 3 presupuestos. Imprime Markdown (USD 0: dry-run puro con los precios del seed versionado,
// los mismos que tiene el catálogo de staging salvo que el SuperAdmin cargue el precio real de Gamma).
//
// Uso: node scripts/r79-budget-examples.js [path/to/dist] > validation/r79-presupuesto/02-ejemplos.md
'use strict';
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
const F = require(path.join(distRoot, 'modules/course-design/budget-fit.js'));

const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
const course = (mods, chs) => ({ course: { title: 'Seguridad y salud en el trabajo', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], objective: 'Aplicar procedimientos de prevención', examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: tema ${j + 1}`, objective: 'Analizar riesgos y proponer controles' })) })) });
const profile = (h) => ({ pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' }, learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended' } });
// Microcurrículo sintético: 3 unidades × 2 contenidos obligatorios = 6 (Cursia puede profundizar, nunca quitar).
const DOC6 = { sources: { chapters: 'REQ-contenidos' }, modulesFixed: 3, contentChaptersPerModule: { min: 2 } };
const LEVERS = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false } };
const CASES = [
  { h: 20, name: 'Sin documento · 3 módulos × 2 capítulos', s: () => course(3, 2), doc: null, budgets: [15, 30, 60] },
  { h: 20, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [15, 30, 60] },
  { h: 60, name: 'Sin documento · 6 módulos × 1 capítulo', s: () => course(6, 1), doc: null, budgets: [35, 62, 90] },
  { h: 60, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [35, 60, 90] },
  { h: 100, name: 'Sin documento · 8 módulos × 2 capítulos', s: () => course(8, 2), doc: null, budgets: [60, 85, 150] },
  { h: 100, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [60, 90, 150] },
];
const usd = (x) => `USD ${Number(x).toFixed(2).replace('.', ',')}`;
const hh = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const STATUS = { fits: 'Cabe', does_not_fit: 'No cabe', impossible: 'Imposible' };
function structureOf(d) {
  const s = d.structure;
  const tiers = Object.entries(s.applicationTiers).map(([t, n]) => `${n}×${t}`).join(' + ') || '—';
  return `${s.modules} × [${s.contentByModule.join(',')}] contenido = ${s.contentChapters} · ${s.practiceChapters} práctica · AA ${s.applicationActivities} (${tiers} min) · guiados ${s.guidedPractices ? `${s.guidedPractices} (${hh(s.guidedPracticeMinutes / 60)} h)` : '—'} · ${s.videoChapters} videos · ${s.moduleExams + (s.finalExam ? 1 : 0)} exámenes`;
}
function costOf(d) {
  const c = d.cost.byCategory || {};
  return `esperado ${usd(d.cost.expected)} · máx ${usd(d.cost.max)} · audiovisual ${usd(c.audiovisual || 0)} · aplicación ${usd(c.application || 0)} · texto ${usd(c.text || 0)}`;
}
const out = [];
out.push('# r79 · Ejemplos comparativos: 20, 60 y 100 h');
out.push('');
out.push('Generado con `node scripts/r79-budget-examples.js` (rama `feat/r79-budget-fit`). Cursos **sintéticos**, USD 0, sin IA. Precios: los del seed versionado (`pricing-seed.v1`), que hoy son los del catálogo de staging; **Gamma figura con el precio provisional** (sin verificar) hasta que el SuperAdmin cargue el real. Por eso todas las cifras que incluyen presentaciones son una «estimación provisional (precio de Gamma sin verificar)».');
out.push('');
out.push('Regla de comparación (D1): cabe si **esperado × 1,10 ≤ presupuesto**. Enfoque: competencias. Video de base: «Recomendado». «Diseño de siempre» = lo que Cursia propone hoy sin presupuesto.');
out.push('');
out.push('Leyenda de la estructura: `módulos × [contenidos por módulo]` · capítulos de práctica · Actividades de Aplicación (AA) por nivel · ejercicios guiados · videos · exámenes (por módulo + final).');
out.push('');
for (const c of CASES) {
  out.push(`## ${c.h} h · ${c.name}`);
  out.push('');
  const plain = P.runPedagogyDryRun({ structure: c.s(), profile: profile(c.h), activityTypeRules: 2, pricing: P.seedPricing(), ...(c.doc ? { requirementConstraints: c.doc } : {}) }).distribution;
  const ref = F.fitDesignToBudget({ base: { structure: c.s(), profile: profile(c.h), activityTypeRules: 2, ...(c.doc ? { requirementConstraints: c.doc } : {}) }, budgetUsd: 5000, levers: LEVERS });
  out.push(`**Diseño de siempre (sin presupuesto):** ${hh(plain.estimatedHours)} h (${plain.status}) · ${ref.chosen ? structureOf(ref.chosen) + ' · ' + costOf(ref.chosen) : `no llega a ${c.h} h con esta estructura (sin rellenar)`}`);
  out.push('');
  out.push('| Presupuesto | Resultado | Horas | Estructura | Costo (esperado / máx / por categoría) |');
  out.push('|---|---|---|---|---|');
  const notFit = [];
  for (const b of c.budgets) {
    const t0 = Date.now();
    const r = F.fitDesignToBudget({ base: { structure: c.s(), profile: profile(c.h), activityTypeRules: 2, ...(c.doc ? { requirementConstraints: c.doc } : {}) }, budgetUsd: b, levers: LEVERS });
    const ms = Date.now() - t0;
    if (r.status === 'fits') {
      const d = r.chosen;
      const how = d.preferences.maxContentChaptersPerModule !== null ? ` (ajuste: hasta ${d.preferences.maxContentChaptersPerModule} contenidos por módulo${d.preferences.audiovisual !== 'recommended' ? `, video «${d.preferences.audiovisual}»` : ''})` : ' (el diseño de siempre)';
      out.push(`| ${usd(b)} | **Cabe**${how} | ${hh(d.estimatedHours)} | ${structureOf(d)} | ${costOf(d)} |`);
    } else {
      const alts = r.alternatives.map((a) => `${a.kind === 'hours_at_budget' ? `≈ ${hh(a.adjust.targetHours)} h con ${usd(b)}` : a.kind === 'budget_for_hours' ? `${c.h} h desde ${usd(a.adjust.productionBudgetUsd)}` : `mínimo de la estructura ${usd(a.adjust.productionBudgetUsd)}`}`).join(' · ');
      const why = r.reason === 'hours_unreachable' ? ' (la estructura no llega a las horas sin rellenar)' : r.reason === 'document_requirements' ? ' (lo exige el documento)' : r.reason === 'structure_minimum' ? ' (mínimo de la estructura)' : '';
      const min = r.minimumExplanation ? (r.minimumExplanation.basis === 'target_hours' ? `mínimo viable para ${c.h} h: ${usd(r.minimumExplanation.minimumUsd)}` : `mínimo de la estructura (≈ ${hh(r.minimumExplanation.estimatedHours)} h): ${usd(r.minimumExplanation.minimumUsd)}`) : '—';
      out.push(`| ${usd(b)} | **${STATUS[r.status]}**${why} | — | Alternativas: ${alts || '—'} | ${min} |`);
      notFit.push({ b, r });
    }
    process.stderr.write(`${c.h} h ${c.name} USD ${b}: ${r.status} (${ms} ms, ${r.candidatesEvaluated} candidatos)\n`);
  }
  out.push('');
  for (const { b, r } of notFit) {
    const m = r.minimumExplanation;
    if (!m) continue;
    out.push(`**${usd(b)} → ${STATUS[r.status]}.** ${r.message}`);
    out.push('');
    out.push(`Opción académicamente viable más económica para ${m.basis === 'target_hours' ? `${hh(m.targetHours)} h` : 'la estructura mínima'}: **${usd(m.minimumUsd)}** (esperado ${usd(m.expectedUsd)} + margen ${Math.round(m.margin * 100)} %, ≈ ${hh(m.estimatedHours)} h). Factores:`);
    out.push('');
    for (const f of m.factors) out.push(`- ${f.label}: ${usd(f.usd)}`);
    for (const a of r.alternatives) if (a.kind !== 'minimum_budget') out.push(`- Alternativa «${a.kind === 'hours_at_budget' ? 'horas que alcanzan' : 'presupuesto mínimo'}»: ${a.text} Estructura: ${structureOf(a.design)}.`);
    out.push('');
  }
}
console.log(out.join('\n'));
