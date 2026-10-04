#!/usr/bin/env node
/* eslint-disable */
// Motor pedagógico V1 — Fase 8: el MISMO curso con distintos enfoques, SOLO dry-run
// (perfil → reglas → Blueprint → Manifest). Sin red, sin proveedores, sin gasto.
//
// Usage: node scripts/pedagogy-compare.js [--json out.json] [--md out.md] [path/to/dist]
// Default: imprime el reporte en Markdown. Curso: scripts/fixtures/pedagogy/rcp-course.json.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const distArg = args.find((a, i) => !a.startsWith('--') && !['--json', '--md'].includes(args[i - 1]));
const REPO = path.resolve(__dirname, '..');
const dist = path.resolve(process.cwd(), distArg || 'dist');
const P = require(path.join(dist, 'modules/pedagogy/index.js'));
const FIX = path.join(REPO, 'scripts/fixtures/pedagogy');
const RCP = JSON.parse(fs.readFileSync(path.join(FIX, 'rcp-course.json'), 'utf8'));
const PF = JSON.parse(fs.readFileSync(path.join(FIX, 'profiles.json'), 'utf8'));

const V = (id) => P.PEDAGOGY_VALUE_LABELS[id] || id;
const SEC = (id) => P.PEDAGOGY_SECTION_LABELS[id] || id;
const usd = (x) => (x == null ? '—' : `USD ${Number(x).toFixed(2)}`);

function profileOf(key) {
  const p = PF.profiles[key];
  return {
    pedagogyProfileVersion: 1, primaryApproach: p.primaryApproach, secondaryApproaches: p.secondaryApproaches,
    learner: p.learner || PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
  };
}

function summarize(key, dr) {
  const ped = dr.pedagogical;
  const view = ped || dr.baseline;
  const acts = dr.chapters.filter((c) => c.activity.enabled);
  const typeCounts = {};
  for (const c of acts) typeCounts[c.activity.type] = (typeCounts[c.activity.type] || 0) + 1;
  return {
    key,
    approaches: dr.rules ? dr.rules.approaches.map((a) => `${a.id}${a.role === 'secondary' ? ` (sec. ${a.weight})` : ''}`).join(' + ') : '— (sin perfil: diseño estándar)',
    blueprintSha256: view.blueprintSha256,
    manifestSha256: view.manifestSha256,
    manifestErrors: view.manifestErrors.length,
    sequence: dr.chapters[0].sequence,
    moduleOpening: dr.modules[0].opening,
    moduleClosing: dr.modules[0].closing,
    objectivesStyle: dr.rules ? dr.rules.targets['objectives.style'] : null,
    contentType: dr.chapters[0].contentType,
    depth: dr.chapters[0].depth,
    videoStyle: dr.chapters.find((c) => c.video.enabled)?.video.style ?? null,
    videoInteractions: dr.chapters.find((c) => c.video.enabled)?.video.interactions ?? null,
    videosEnabled: dr.chapters.filter((c) => c.video.enabled).length,
    activityIntents: [...new Set(dr.chapters.map((c) => c.activity.intent).filter(Boolean))],
    activityTypes: dr.chapters.map((c) => c.activity.type),
    activityTypeCounts: typeCounts,
    scenario: dr.chapters[0].scenario,
    feedback: dr.chapters[0].feedback,
    assessment: dr.assessment,
    resources: dr.chapters[0].resources,
    structureChanges: dr.structureChanges.map((c) => `${c.field}:${c.from}→${c.to}${c.field === 'reviewCards' ? '' : ` «${c.title}»`}`),
    objectivesToReview: dr.objectives.filter((o) => !o.ok).map((o) => `${o.title}: «${o.verb}» → ${o.suggestion}`),
    totals: view.manifest.totals,
    estimateExpectedUsd: view.providers.estimateUsd ? view.providers.estimateUsd.expected : null,
    providers: Object.fromEntries(Object.entries(view.providers.byProvider).map(([p, v]) => [p, v.items])),
    itemsWithDesign: dr.diff.itemsWithDesign,
    providersCalled: dr.providersCalled,
    spendUsd: dr.spendUsd,
  };
}

const KEYS = ['competencias', 'problemas', 'experiencial', 'significativo', 'autodirigido'];
const COMBOS = ['competencias+experiencial', 'problemas+significativo+autodirigido'];
const base = summarize('estándar', P.runPedagogyDryRun({ structure: RCP, profile: null }));
const rows = KEYS.map((k) => summarize(k, P.runPedagogyDryRun({ structure: RCP, profile: profileOf(k) })));
const combos = COMBOS.map((k) => summarize(k, P.runPedagogyDryRun({ structure: RCP, profile: profileOf(k) })));
const all = [base, ...rows, ...combos];

// Diferencias: cuántos valores distintos toma cada dimensión entre los 5 enfoques.
const DIMS = {
  'Secuencia del capítulo': (r) => r.sequence.join('>'),
  'Apertura del módulo': (r) => r.moduleOpening,
  'Cierre del módulo': (r) => r.moduleClosing,
  'Estilo de objetivos': (r) => r.objectivesStyle,
  'Tipo de contenido': (r) => r.contentType,
  'Estilo de video': (r) => r.videoStyle,
  'Videos en el curso': (r) => String(r.videosEnabled),
  'Interacciones del video': (r) => r.videoInteractions,
  'Tipos de actividad': (r) => r.activityTypes.join(','),
  'Estrategia de evaluación': (r) => r.assessment.strategy,
  'Evaluación de módulo': (r) => r.assessment.examStyle,
  'Evaluación final': (r) => r.assessment.finalExamStyle,
  'Retroalimentación': (r) => `${r.feedback.mode}/${r.feedback.timing}`,
  'Escenarios': (r) => r.scenario.type,
  'Recursos': (r) => r.resources.join(','),
  'Blueprint (sha)': (r) => r.blueprintSha256,
  'Manifest (sha)': (r) => r.manifestSha256,
};
const distinct = Object.fromEntries(Object.entries(DIMS).map(([k, f]) => [k, new Set(rows.map(f)).size]));

const out = { course: RCP.course.title, structure: `${RCP.modules.length} módulos × ${RCP.modules.map((m) => m.chapters.length).join('/')} capítulos`, baseline: base, approaches: rows, combos, distinct,
  guarantees: { providersCalled: all.reduce((s, r) => s + r.providersCalled, 0), spendUsd: '0.00', manifestErrors: all.reduce((s, r) => s + r.manifestErrors, 0) } };
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 2));

const L = [];
L.push(`# Comparación pedagógica (dry-run) — «${out.course}»`);
L.push('');
L.push(`Estructura: ${out.structure}. Solo dry-run: perfil → reglas → Blueprint → Manifest. Llamadas a proveedores: **${out.guarantees.providersCalled}** · gasto: **USD ${out.guarantees.spendUsd}** · errores de validación del Manifest: **${out.guarantees.manifestErrors}**.`);
L.push('');
L.push('## Qué cambia entre los 5 enfoques');
L.push('');
L.push('| Dimensión | Valores distintos (de 5) |');
L.push('|---|---|');
for (const [k, n] of Object.entries(distinct)) L.push(`| ${k} | ${n} |`);
L.push('');
const head = ['', 'Estándar', ...rows.map((r) => r.key)];
L.push('## Diseño por enfoque');
L.push('');
L.push(`| ${head.join(' | ')} |`);
L.push(`|${head.map(() => '---').join('|')}|`);
const line = (label, f) => L.push(`| ${label} | ${[base, ...rows].map(f).join(' | ')} |`);
line('Secuencia', (r) => (r.sequence ? r.sequence.map(SEC).join(' → ') : 'estándar'));
line('Apertura / cierre de módulo', (r) => (r.moduleOpening ? `${V(r.moduleOpening)} / ${V(r.moduleClosing)}` : '—'));
line('Objetivos', (r) => (r.objectivesStyle ? V(r.objectivesStyle) : '—'));
line('Contenido', (r) => (r.contentType ? `${V(r.contentType)} (${V(r.depth)})` : '—'));
line('Video', (r) => (r.videoStyle ? `${V(r.videoStyle)} · ${r.videosEnabled}/9 · ${V(r.videoInteractions)}` : `${r.videosEnabled}/9`));
line('Actividades', (r) => Object.entries(r.activityTypeCounts).map(([t, n]) => `${V(t)} ×${n}`).join(', '));
line('Evaluación', (r) => (r.assessment ? `${V(r.assessment.strategy)}; módulo: ${V(r.assessment.examStyle)}; final: ${V(r.assessment.finalExamStyle)}` : 'estándar'));
line('Retroalimentación', (r) => (r.feedback ? `${V(r.feedback.mode)} (${V(r.feedback.timing).toLowerCase()})` : '—'));
line('Escenarios', (r) => (r.scenario ? `${V(r.scenario.type)}${r.scenario.branching ? ' · ramificados' : ''}` : '—'));
line('Recursos', (r) => (r.resources ? r.resources.map(V).join(', ') : '—'));
line('Cambios de estructura sugeridos', (r) => (r.structureChanges.length ? String(r.structureChanges.length) : '0'));
line('Trabajos del Manifest', (r) => String(r.totals.totalJobs));
line('Trabajos con diseño propio', (r) => String(r.itemsWithDesign));
line('Costo estimado (si se generara)', (r) => usd(r.estimateExpectedUsd));
line('Blueprint sha (12)', (r) => r.blueprintSha256.slice(0, 12));
L.push('');
L.push('## Combinaciones');
L.push('');
for (const r of combos) {
  L.push(`- **${r.approaches}**: secuencia ${r.sequence.map(SEC).join(' → ')}; actividades ${Object.entries(r.activityTypeCounts).map(([t, n]) => `${V(t)} ×${n}`).join(', ')}; evaluación ${V(r.assessment.strategy)}; ${r.structureChanges.length} cambio(s) sugerido(s); ${usd(r.estimateExpectedUsd)}.`);
}
L.push('');
L.push('## Objetivos que el enfoque marca para revisar (competencias)');
L.push('');
for (const o of rows[0].objectivesToReview) L.push(`- ${o}`);
const md = L.join('\n') + '\n';
if (opt('--md')) fs.writeFileSync(opt('--md'), md);
if (!opt('--md') && !opt('--json')) process.stdout.write(md);
else console.log(`✅ Reporte generado (${[opt('--md'), opt('--json')].filter(Boolean).join(', ')}). Proveedores llamados: ${out.guarantees.providersCalled}; gasto USD ${out.guarantees.spendUsd}.`);
