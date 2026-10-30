#!/usr/bin/env node
/* eslint-disable no-console */
// r79.2 · §13.7: ejemplos de 20, 60 y 100 h, con y sin el microcurrículo de 6 contenidos, a los MISMOS presupuestos que r79.1
// (+ los nuevos puntos de equilibrio), ANTES (r79.1: build de staging 537666c) y DESPUÉS (r79.2: Actividades de 30/60/90/120
// proporcionales). Ambos lados con la palanca de tipos. Imprime Markdown. USD 0: dry-run puro con el seed (Gamma provisional).
//
// Uso: node scripts/r79-2-budget-examples.js <dist de r79.1 (antes)> [dist de r79.2 (después) = dist]
'use strict';
const path = require('path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!args[0]) { console.error('uso: node scripts/r79-2-budget-examples.js <dist-antes> [dist-después]'); process.exit(2); }
const BEFORE = path.resolve(args[0]);
const AFTER = path.resolve(args[1] || 'dist');
const load = (d) => ({ P: require(path.join(d, 'modules/pedagogy/index.js')), F: require(path.join(d, 'modules/course-design/budget-fit.js')) });
const Bf = load(BEFORE);
const Af = load(AFTER);

const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
const course = (mods, chs) => ({ course: { title: 'Seguridad y salud en el trabajo', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], objective: 'Aplicar procedimientos de prevención', examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: tema ${j + 1}`, objective: 'Analizar riesgos y proponer controles' })) })) });
const profile = (h) => ({ pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' }, learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended' } });
const DOC6 = { sources: { chapters: 'REQ-contenidos' }, modulesFixed: 3, contentChaptersPerModule: { min: 2 } };
const LEV_R79 = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false } };
const LEV_R791 = { ...LEV_R79, activityKinds: { base: 'none', locked: false } };
const CASES = [
  { h: 20, name: 'Sin documento · 3 módulos × 2 capítulos', s: () => course(3, 2), doc: null, budgets: [15, 30, 60] },
  { h: 20, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [15, 30, 60] },
  { h: 60, name: 'Sin documento · 6 módulos × 1 capítulo', s: () => course(6, 1), doc: null, budgets: [35, 62, 66, 90] },
  { h: 60, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [35, 60, 90] },
  { h: 100, name: 'Sin documento · 8 módulos × 2 capítulos', s: () => course(8, 2), doc: null, budgets: [60, 85, 88, 150] },
  { h: 100, name: 'Microcurrículo con 6 contenidos (3 × 2)', s: () => course(3, 2), doc: DOC6, budgets: [60, 90, 150] },
];
const usd = (x) => `USD ${Number(x).toFixed(2).replace('.', ',')}`;
const hh = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const STATUS = { fits: 'Cabe', does_not_fit: 'No cabe', impossible: 'Imposible' };
const KIND_SHORT = { case_study: 'caso', integrative_project: 'proyecto', formative_feedback: 'retro' };
function structureOf(d) {
  const s = d.structure;
  const tiers = Object.entries(s.applicationTiers).map(([t, n]) => `${n}×${t}`).join(' + ') || '—';
  const kinds = s.applicationKinds ? Object.entries(s.applicationKinds).map(([k, n]) => `${n} ${KIND_SHORT[k]}`).join(', ') : '';
  return `${s.modules} × [${s.contentByModule.join(',')}] = ${s.contentChapters} contenido · ${s.practiceChapters} práctica · AA ${s.applicationActivities} (${tiers} min)${kinds ? ` · tipos: ${kinds}` : ''} · guiados ${s.guidedPractices ? `${s.guidedPractices} (${hh(s.guidedPracticeMinutes / 60)} h)` : '—'} · ${s.videoChapters} videos`;
}
const quality = (d) => `${d.quality.score.toFixed(2).replace('.', ',')} (exposición ${d.quality.contentExposure}, video ${d.quality.videoCoverage}, AA cortas ${d.quality.shortActivities}, guiados ${d.quality.guidedShare}${d.quality.kindFit !== undefined ? `, tipos ${d.quality.kindFit}` : ''})`;
const fit = (L, c, h, b, lev) => L.F.fitDesignToBudget({ base: { structure: c.s(), profile: profile(h), activityTypeRules: 2, ...(c.doc ? { requirementConstraints: c.doc } : {}) }, budgetUsd: b, levers: lev });
const shown = (r) => r.chosen || (r.alternatives.find((a) => a.kind === 'hours_at_budget') || {}).design || null;
const summary = (r) => {
  const alts = r.alternatives.map((a) => (a.kind === 'hours_at_budget' ? `${hh(a.adjust.targetHours)} h con ${usd(a.adjust.productionBudgetUsd)}` : a.kind === 'budget_for_hours' ? `${hh(r.targetHours)} h desde ${usd(a.adjust.productionBudgetUsd)}` : `mínimo de la estructura ${usd(a.adjust.productionBudgetUsd)}`));
  return r.status === 'fits' ? `**Cabe** · ${hh(r.chosen.estimatedHours)} h · esperado ${usd(r.chosen.cost.expected)}` : `**${STATUS[r.status]}** · ${alts.join(' · ') || '—'}${r.minimumExplanation ? ` · mínimo ${usd(r.minimumExplanation.minimumUsd)}` : ''}`;
};

const out = [];
const perf = [];
out.push('## r79.2 · Actividades de 30/60/90/120 min proporcionales (antes = r79.1, después = r79.2)');
out.push('');
out.push(`Generado con \`node scripts/r79-2-budget-examples.js\` (antes = build de r79.1 en staging, \`537666c\`; después = r79.2). Mismos cursos sintéticos, mismas reglas (cabe si esperado × 1,10 ≤ presupuesto), palanca de tipos en los dos lados, USD 0, seed versionado, **Gamma provisional**. Se agregan USD 66 (60 h) y USD 88 (100 h): los nuevos puntos donde el ajuste vuelve a caber.`);
out.push('');
out.push('**Qué cambia en r79.2**');
out.push('');
out.push('- **Especificación proporcional** de la Actividad de Aplicación de siempre (mismos minutos, más trabajo real): 30 min igual (6–7 ejercicios) · 60 min 8–10 ejercicios + 1 ejemplo resuelto + 3 consignas + **2 hitos** + 4 criterios · 90 min 11–13 + 1 ejemplo + 5 consignas + **3 hitos** · 120 min 14–16 + 1 ejemplo + 5 consignas + **4 hitos**; pisos de minutos del taller y de los ejercicios. Trabajo especificado (modelo de trabajo v1): 43 / 79,5 / 111 / 134 min típicos; densidad ≥ 0,9 × la del nivel anterior en los cuatro niveles (candado activo en todos).');
out.push('- **Las horas no cambian** (mismos niveles, mismos minutos: no se infla nada). Sube el costo del generador: 9 / 12 / 15 unidades de salida (antes 7 / 9 / 11); los tipos nuevos nunca menos que la de siempre del mismo nivel (proyecto 90/120 = 12/15; retroalimentación 60/90/120 = 9/12/15).');
out.push('');
const headline = [];
for (const c of CASES) {
  out.push(`### ${c.h} h · ${c.name}`);
  out.push('');
  const ref0 = fit(Bf, c, c.h, 5000, LEV_R791);
  const ref1 = fit(Af, c, c.h, 5000, LEV_R791);
  out.push('**Diseño de siempre (sin presupuesto, palanca de tipos):**');
  out.push('');
  out.push(`- Antes (r79.1): ${ref0.chosen ? `${hh(ref0.chosen.estimatedHours)} h · ${structureOf(ref0.chosen)} · esperado ${usd(ref0.chosen.cost.expected)}` : `no llega a ${c.h} h con esta estructura (sin rellenar)`}`);
  out.push(`- Después (r79.2): ${ref1.chosen ? `${hh(ref1.chosen.estimatedHours)} h · ${structureOf(ref1.chosen)} · esperado ${usd(ref1.chosen.cost.expected)}` : `no llega a ${c.h} h con esta estructura (sin rellenar)`}`);
  out.push('');
  out.push('| Presupuesto | Antes (r79.1) | Después (r79.2) | Calidad antes → después | Horas antes → después | Esperado antes → después |');
  out.push('|---|---|---|---|---|---|');
  for (const b of c.budgets) {
    const t0 = Date.now();
    const r0 = fit(Bf, c, c.h, b, LEV_R791);
    const ms0 = Date.now() - t0;
    const t1 = Date.now();
    const r1 = fit(Af, c, c.h, b, LEV_R791);
    const ms1 = Date.now() - t1;
    perf.push({ c: `${c.h} h · ${c.name} · ${usd(b)}`, s0: r0.status, s1: r1.status, ms0, ms1 });
    const d0 = shown(r0);
    const d1 = shown(r1);
    out.push(`| ${usd(b)} | ${summary(r0)} | ${summary(r1)} | ${d0 ? quality(d0) : '—'} → ${d1 ? quality(d1) : '—'} | ${d0 ? hh(d0.estimatedHours) : '—'} → ${d1 ? hh(d1.estimatedHours) : '—'} | ${d0 ? usd(d0.cost.expected) : '—'} → ${d1 ? usd(d1.cost.expected) : '—'} |`);
    if (d1) out.push(`|  | ${d0 ? structureOf(d0) : ''} | ${structureOf(d1)} |  |  |  |`);
    headline.push({ case: `${c.h} h · ${c.name}`, budget: b, before: summary(r0).replace(/\*\*/g, ''), after: summary(r1).replace(/\*\*/g, ''), q0: d0 ? d0.quality.score : null, q1: d1 ? d1.quality.score : null });
  }
  out.push('');
  // Detalle del primer «Cabe» con tipos: por qué cada tipo.
  const firstFit = c.budgets.map((b) => fit(Af, c, c.h, b, LEV_R791)).find((r) => r.status === 'fits' && r.chosen && Object.keys(r.chosen.structure.applicationKinds || {}).length);
  if (firstFit) {
    out.push(`Con ${usd(firstFit.budgetUsd)} (r79.2), por qué este diseño:`);
    out.push('');
    for (const x of firstFit.reasons) out.push(`- ${x}`);
    out.push('');
  }
}
out.push('### Rendimiento de la búsqueda r79.2 (mismo proceso, ms)');
out.push('');
out.push('| Caso | Estado antes → después | Antes (r79.1) | Después (r79.2) |');
out.push('|---|---|---|---|');
for (const p of perf) out.push(`| ${p.c} | ${STATUS[p.s0]} → ${STATUS[p.s1]} | ${p.ms0} | ${p.ms1} |`);
out.push('');
console.log(out.join('\n'));
if (process.argv.includes('--json')) console.error(JSON.stringify({ headline, perf }, null, 1));
