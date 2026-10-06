#!/usr/bin/env node
/* eslint-disable no-console */
// LOOP 7 — consistencia del flujo «Cursia recomienda» → Ajustar → Aplicar → Blueprint → Manifest (pura, USD 0).
//
//   LF1 reglas de actividad: una sola fuente para el próximo Manifest (Manifest previo del curso > config; sin tabla
//       de Manifests → config; valor guardado inválido → error)
//   LF2 guarda de la tarjeta: horas y conteos del distribuidor = Manifest materializado en 32/48/64/96 h × reglas 0/1/2
//       (sin error); una diferencia → DISTRIBUTION_MODEL_MISMATCH visible
//   LF3 «Ajustar» después de aplicar: si el diseño vigente ya cumple, la propuesta lo DICE (no queda un «ya aplicado»
//       mudo con preferencias nuevas)
//   LF5 costo: desglose por categoría = total; tarifas provisionales y supuestos explícitos (nunca falsa precisión)
//   LF4 0 llamadas de red
//
// Uso: node scripts/check-loop7-flow-consistency.js [path/to/dist]
'use strict';
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  globalThis.fetch = deny('fetch');
}
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const load = (rel) => require(path.join(distRoot, rel));
const CFG = load('modules/generation-manifests/manifest-rules-config.js');
const DR = load('modules/pedagogy/dry-run.js');
const A = load('modules/academic-context/index.js');
const SNAP = load('modules/course-blueprints/blueprint-snapshot.js');
const F = require('./lib/academic-fixtures.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

(async () => {
  await check('LF1 reglas de actividad: Manifest previo del curso > config; sin tabla → config; inválido → error', async () => {
    const q = (table, rows) => ({ query: async (sql) => (/to_regclass/.test(sql) ? [{ ok: table }] : rows) });
    const env2 = { DYNAMIC_ACTIVITY_TYPE_RULES: '2' };
    eq(await CFG.activityTypeRulesForNextManifest(q(false, []), 1, env2), 2, 'sin tabla de Manifests → config');
    eq(await CFG.activityTypeRulesForNextManifest(q(true, []), 1, env2), 2, 'curso sin Manifest v3 → config');
    eq(await CFG.activityTypeRulesForNextManifest(q(true, [{ id: 9, activity_type_rules: 1 }]), 1, env2), 1, 'el marcador del último Manifest manda');
    eq(await CFG.activityTypeRulesForNextManifest(q(true, [{ id: 9, activity_type_rules: null }]), 1, env2), 0, 'Manifest previo sin marcador → 0');
    let err = null;
    try { await CFG.activityTypeRulesForNextManifest(q(true, [{ id: 9, activity_type_rules: 7 }]), 1, env2); } catch (e) { err = e.message; }
    assert(err && /inválido/.test(err), 'marcador inválido → error');
  });

  const ctx = (await A.extractAcademicContext([{ name: 'm.docx', data: await F.fixture('consistent', 'docx') }])).context;
  const prop = A.proposeStructureFromContext(ctx);
  let n = 0;
  const id = () => `00000000-0000-4000-b000-${String(++n).padStart(12, '0')}`;
  const modules = [];
  const chapters = [];
  prop.modules.forEach((m, mi) => {
    const mid = id();
    modules.push({ id: mid, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: true });
    m.chapters.forEach((c, ci) => chapters.push({ id: id(), module_id: mid, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: true, activity_enabled: true, outcome_ids: c.outcomeIds }));
  });
  const structure = SNAP.buildBlueprintSnapshotV2({ id: 7001, title: 'Contabilidad de Costos', finalExam: true, activityEngine: 'h5p', reviewCards: true, academicContext: A.academicBlueprintContext(ctx) }, modules, chapters);
  const profileOf = (hours, extra = {}) => ({ ...A.suggestProfileFromContext(ctx, null).profile, primaryApproach: 'competencias', secondaryApproaches: [], targetHours: hours, ...extra });

  await check('LF2 la tarjeta = el Manifest materializado (horas y conteos) en 32/48/64/96 h × reglas 0/1/2; una diferencia es un error visible', () => {
    for (const h of [32, 48, 64, 96]) {
      for (const atr of [0, 1, 2]) {
        const d = DR.runPedagogyDryRun({ structure, profile: profileOf(h), activityTypeRules: atr }).distribution;
        eq(d.materialized.manifestErrors, [], `${h} h / reglas ${atr}: sin errores`);
        eq(d.estimatedHours, d.materialized.generableHours, `${h} h / reglas ${atr}: horas de la tarjeta = Manifest`);
        const t = d.materialized.totals;
        eq([d.counts.chapters, d.counts.videoChapters, d.counts.applicationActivities, d.counts.evaluations], [t.experienceCount, t.videoCount, t.applicationActivityCount, t.examCount + t.finalExamCount], `${h} h / reglas ${atr}: conteos`);
      }
    }
    const d = DR.runPedagogyDryRun({ structure, profile: profileOf(64), activityTypeRules: 2 }).distribution;
    const fake = { manifest: { totals: { ...d.materialized.totals, videoCount: d.materialized.totals.videoCount + 1 } }, studyTime: { courseEstimatedHours: d.estimatedHours + 0.5 } };
    const errs = DR.distributionModelMismatch(d, fake);
    assert(errs.length === 1 && errs[0].code === 'DISTRIBUTION_MODEL_MISMATCH' && /horas/.test(errs[0].message) && /capítulos con video/.test(errs[0].message), `diferencia detectada: ${JSON.stringify(errs)}`);
  });

  await check('LF3 «Ajustar» después de aplicar un diseño que ya cumple: la propuesta lo explica (0 cambios no es un silencio)', () => {
    const d1 = DR.runPedagogyDryRun({ structure, profile: profileOf(64), activityTypeRules: 2 }).distribution;
    const applied = DR.materializeDistribution(structure, d1);
    const d2 = DR.runPedagogyDryRun({ structure: applied, profile: profileOf(64, { designPreferences: { emphasis: 'depth' } }), activityTypeRules: 2 }).distribution;
    eq(d2.changes.length, 0, 'el diseño vigente ya cumple: 0 cambios');
    assert(d2.recommendations.some((r) => /ya cumple/.test(r) && /no quita capítulos/.test(r)), `la propuesta explica por qué no cambia: ${JSON.stringify(d2.recommendations)}`);
  });

  await check('LF5 costo: desglose audiovisual / Actividades de Aplicación / texto = total; tarifas provisionales y supuestos visibles', () => {
    const d = DR.runPedagogyDryRun({ structure, profile: profileOf(64), activityTypeRules: 2 }).distribution;
    const pv = d.materialized.providers;
    const sum = Number(pv.byCategory.audiovisual) + Number(pv.byCategory.application) + Number(pv.byCategory.text);
    assert(Math.abs(sum - Number(pv.estimateUsd.expected)) < 0.03, `categorías ${JSON.stringify(pv.byCategory)} = total ${pv.estimateUsd.expected}`);
    assert(Number(pv.byCategory.application) > 0 && Number(pv.byCategory.audiovisual) > Number(pv.byCategory.application), 'las Actividades de Aplicación aparte del audiovisual');
    assert(pv.unverifiedProviders.includes('gamma') && pv.assumptions.some((x) => /Tarifa provisional/.test(x) && /gamma/.test(x)), `Gamma provisional: ${pv.unverifiedProviders}`);
    assert(pv.assumptions.some((x) => /Sonnet 4\.6/.test(x)) && pv.assumptions.some((x) => /estimación/i.test(x)), 'supuestos del modelo y del uso');
    assert(Number(pv.estimateUsd.min) < Number(pv.estimateUsd.expected) && Number(pv.estimateUsd.expected) < Number(pv.estimateUsd.max), 'rango min < esperado < max');
  });

  await check('LF4 0 llamadas de red', () => eq(netAttempts, [], 'red'));

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
