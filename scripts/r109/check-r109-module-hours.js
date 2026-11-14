#!/usr/bin/env node
/* eslint-disable no-console */
// r109 M4 · horas por módulo. Sin red, sin base y sin proveedores (USD 0): funciones puras de dist/.
//
//   MH1  el A1-A2 sintético (4 módulos, capítulos 4 / 7 / 4 / 5, horas 7 / 12 / 6 / 3): cada módulo dentro de ±10 % de sus
//        horas o con su estado y explicación por módulo; el total da 28 h ±10 %; versión factible (7 / 12 / 6 / 3,5): los cuatro
//   MH2  un módulo null se reparte el resto del total (uno y varios)
//   MH3  si la suma de las horas fijadas pasa del total, gana la suma, con aviso visible
//   MH4  un módulo con muy pocas horas para sus capítulos da un conflicto explícito (módulo y horas) en el diseño y en Verificación
//   MH5  SIN horas por módulo el resultado es idéntico al de origin/staging, byte a byte, en todos los fixtures del distribuidor
//   MH6  el lector entiende las tres frases del brief y no toma «20 horas de clase» (ni rangos) como horas de un módulo
//   MH7  la caja con horas por módulo reemplaza las del documento, con aviso; los módulos que la caja no menciona quedan sin horas
//   MH8  perfil: moduleTargetHours se valida, se redondea a 0,5 h y, sin horas por módulo, el perfil conserva su sha
//   MH9  dry-run de punta a punta: el diseño se reparte por módulo, el Manifest coincide, la huella de la propuesta cambia y el costo
//        se recalcula al cambiar las horas
//   MH10 Prebrief: el resumen dice las horas por módulo (y sin ellas, el resumen de siempre)
//   MH11 API: el DTO acepta moduleTargetHours; la respuesta de recommend trae moduleHours con el origen de cada módulo
//
// Uso: npm run build && node scripts/r109/check-r109-module-hours.js --ci [--dist dist] [--base <dist de origin/staging>]
//      node scripts/r109/check-r109-module-hours.js --bite          (cada mordida tiene que hacer fallar --ci)
//      node scripts/r109/check-r109-module-hours.js --write-golden --base <dist de origin/staging>
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const BASE = arg('--base', null) ? path.resolve(arg('--base')) : null;
const GOLDEN = path.join(REPO, 'scripts/fixtures/r109/module-hours-golden.json');

if (process.argv.includes('--bite')) {
  const bites = [
    { name: 'repartir con el total y no por módulo (ignora las horas por módulo)', file: 'modules/study-time/distributor.js', from: 'const byModule = distributeByModule(input);', to: 'const byModule = null;' },
    { name: 'ignorar null: el módulo sin horas desaparece del reparto', file: 'modules/study-time/distributor.js', from: 'const nullIdx = plan.fixed.map((h, i) => (h === null ? i : -1)).filter((i) => i >= 0);', to: 'const nullIdx = [];' },
    { name: 'la suma que pasa del total no cambia el total', file: 'modules/study-time/module-hours.js', from: 'if (sum > total) {', to: 'if (false) {' },
    { name: 'el módulo con muy pocas horas se da por cumplido (sin explicación)', file: 'modules/study-time/distributor.js', from: "if (Math.abs(est - target) <= target * module_hours_1.MODULE_HOURS_TOLERANCE_PCT + 1e-9)\n        return 'within_tolerance';", to: "return 'within_tolerance';" },
    { name: 'Verificación no dice qué módulo se queda corto', file: 'modules/course-design/design-verification.js', from: 'for (const m of bad) {', to: 'for (const m of []) {' },
    { name: 'las horas de componente («20 horas de clase») se toman como horas de un módulo', file: 'modules/academic-context/requirements/module-hours-reader.js', from: 'componentAfter(t, h.end)', to: 'false' },
    { name: 'la caja no reemplaza las horas por módulo del documento', file: 'modules/academic-context/requirements/requirements-box.js', from: '(boxModuleHours && moduleIndexOf(it) !== null ? boxModuleHours : undefined)', to: 'undefined' },
    { name: 'las horas por módulo no se redondean a 0,5 h', file: 'modules/study-time/module-hours.js', from: 'let h = Math.round(v * 2) / 2;', to: 'let h = v;' },
    { name: 'la caja sigue diciendo «próximamente» (no entiende «Módulo 2: 12 horas»)', file: 'modules/academic-context/requirements/requirements-extractor.js', from: 'const hits = (0, module_hours_reader_1.findModuleHoursIn)(sg.text, declarative);', to: 'const hits = [];' },
    { name: 'el resumen del Prebrief no dice las horas por módulo', file: 'modules/prebrief/prebrief-document.js', from: 'if (m.duration.moduleHours) {', to: 'if (false) {' },
    { name: 'un perfil con todo null guarda moduleTargetHours (el sha cambia sin horas por módulo)', file: 'modules/pedagogy/pedagogy-profile.js', from: 'while (out.length && out[out.length - 1] === null)', to: 'while (false)' },
  ];
  const tmp = fs.mkdtempSync(path.join(REPO, '.r109-bite-'));
  let code = 0;
  try {
    for (const b of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, b.file);
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes(b.from)) { console.log(`❌ mordida «${b.name}»: no encontré el código`); code = 1; continue; }
      fs.writeFileSync(f, src.split(b.from).join(b.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const bit = r.status !== 0 && /❌/.test(r.stdout || '');
      console.log(bit ? `✅ mordida «${b.name}»: el check FALLA (${((r.stdout || '').match(/❌ [^\n]*/g) || []).slice(0, 2).join(' · ').slice(0, 200)})` : `❌ mordida «${b.name}»: NO hizo fallar el check`);
      if (!bit) code = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

// ── Red bloqueada (USD 0) ──
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const loader = (root) => (rel) => { try { return require(path.join(root, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} de ${root} (¿npm run build?): ${e.message}`); process.exit(1); } };
const L = loader(DIST);
const clone = (o) => JSON.parse(JSON.stringify(o));
const within = (est, target, pct = 0.1) => Math.abs(est - target) <= target * pct + 1e-9;

const PF = require(path.join(REPO, 'scripts/fixtures/pedagogy/profiles.json'));
const RCP = require(path.join(REPO, 'scripts/fixtures/pedagogy/rcp-course.json'));
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
/** Estructura sintética: capítulos por módulo + qué lleva cada capítulo (video, actividad, examen del módulo). */
const struct = (counts, t = { video: true, activity: true, exam: true }) => ({
  course: { id: 1, title: 'A1-A2 sintético', finalExam: true, activityEngine: 'h5p', reviewCards: false },
  modules: counts.map((n, mi) => ({
    id: `m${mi + 1}`, title: `Módulo ${mi + 1}`, objective: 'Objetivo del módulo', examEnabled: t.exam,
    chapters: Array.from({ length: n }, (_, ci) => ({ id: `m${mi + 1}c${ci + 1}`, title: `Capítulo ${mi + 1}.${ci + 1}`, objective: 'Objetivo del capítulo', videoEnabled: t.video, activityEnabled: t.activity })),
  })),
});
const A1A2 = [4, 7, 4, 5];
const LIGHT = { video: false, activity: false, exam: false };

// ── Cargas ──
function distributors(root) {
  const R = loader(root);
  const ST = R('modules/study-time/index.js');
  const P = R('modules/pedagogy/index.js');
  const snap = (s) => P.snapshotFromStructure(clone(s));
  const rules = (k) => (k ? P.deriveDesignRules(profileOf(k)) : null);
  return { ST, P, snap, rules };
}
const D = distributors(DIST);
const dist = (counts, hours, moduleHours, o = {}) => D.ST.distributeCourseHours({
  snapshot: D.snap(struct(counts, o.toggles || LIGHT)), rules: D.rules(o.profile === undefined ? 'competencias' : o.profile), targetHours: hours, ...(moduleHours !== undefined ? { moduleHours } : {}), ...(o.opts || {}),
});

// ── Matriz de fixtures del distribuidor (SIN horas por módulo): la misma en staging y aquí ──
function matrix(root) {
  const { ST, P, snap, rules } = distributors(root);
  const structures = { rcp3x3: () => snap({ ...clone(RCP), course: { ...clone(RCP).course, reviewCards: true } }), a1a2: () => snap(struct(A1A2)), a1a2light: () => snap(struct(A1A2, LIGHT)), uno: () => snap(struct([6])) };
  const optionSets = {
    base: {},
    app: { preferences: { emphasis: 'application' } },
    depth: { preferences: { emphasis: 'depth', audiovisual: 'less' } },
    noapp: { preferences: { applicationActivities: 'none', guidedPractice: 'none' } },
    req: { requirements: { sources: {}, contentChaptersPerModule: { min: 3, max: 5 }, practicePerModule: { min: 1, max: 1 } } },
    fixedShape: { requirements: { sources: {}, noContentAdditions: true } },
    pins: { pins: { m1c1: { video: false, application: 60 } } },
    v1: { activityTypeRules: 1 },
  };
  const out = {};
  for (const [sn, mk] of Object.entries(structures)) {
    for (const prof of ['competencias', 'significativo', null]) {
      for (const h of [8, 20, 33, 50, 80]) {
        for (const [on, o] of Object.entries(optionSets)) {
          const key = `${sn}|${prof || 'sin'}|${h}|${on}`;
          try { out[key] = { input: { snapshot: mk(), rules: rules(prof), targetHours: h, ...clone(o) } }; } catch (e) { out[key] = { error: e.message }; }
        }
      }
    }
  }
  const run = (extra) => { const r = {}; for (const [k, v] of Object.entries(out)) { if (v.error) { r[k] = `ERR:${v.error}`; continue; } try { r[k] = sha(ST.distributeCourseHours({ ...v.input, ...(extra || {}) })); } catch (e) { r[k] = `ERR:${String(e.message).slice(0, 80)}`; } } return r; };
  // Dry-run completo (perfil + estructura) para algunos cursos, con y sin horas.
  const dry = {};
  for (const [h, extra] of [[20, {}], [33, {}], [28, {}], [50, { designPreferences: { emphasis: 'depth' } }]]) {
    dry[`dry|${h}|${JSON.stringify(extra)}`] = sha(P.runPedagogyDryRun({ structure: clone(RCP), profile: profileOf('competencias', { targetHours: h, ...extra }) }).distribution);
  }
  return { run, dry, ST, P };
}

const NOMH = [undefined, null, [], [null, null, null, null], [null]];

async function main() {
  // ── MH1 ──
  await check('MH1 A1-A2 (4/7/4/5 capítulos, 7/12/6/3 h): módulos dentro de ±10 % o con su estado y explicación; total 28 h ±10 %', () => {
    const r = dist(A1A2, 28, [7, 12, 6, 3]);
    const mh = r.moduleHours;
    assert(mh && mh.modules.length === 4, 'el resultado trae moduleHours con 4 módulos');
    eq(mh.modules.map((m) => m.targetHours), [7, 12, 6, 3], 'horas pedidas por módulo');
    for (const m of mh.modules) {
      const inBand = within(m.estimatedHours, m.targetHours);
      eq(m.status === 'within_tolerance', inBand, `módulo ${m.index}: el estado dice la verdad (${m.estimatedHours} h de ${m.targetHours} h)`);
      if (!inBand) {
        assert(['minimum_exceeds_target', 'cannot_reach_target', 'above_tolerance'].includes(m.status), `módulo ${m.index}: estado ${m.status}`);
        assert(m.explanation && m.explanation.includes(`módulo ${m.index}`) && m.explanation.includes(`${m.targetHours} h`), `módulo ${m.index}: explicación con módulo y horas: ${m.explanation}`);
      }
    }
    // Con la carga mínima de Cursia (libro + presentación + página por capítulo) un módulo de 5 capítulos no baja de ~3,4 h:
    // los tres primeros caen en su banda y el cuarto lo dice explícitamente (no se inventa un cumplimiento).
    eq(mh.modules.slice(0, 3).map((m) => m.status), ['within_tolerance', 'within_tolerance', 'within_tolerance'], 'módulos 1 a 3 dentro de ±10 %');
    assert(mh.modules[3].status !== 'within_tolerance' && mh.modules[3].explanation, 'módulo 4: 3 h para 5 capítulos no se alcanza y lo dice');
    assert(within(r.estimatedHours, 28), `total ${r.estimatedHours} h dentro de ±10 % de 28 h`);
    eq([r.targetHours, mh.totalAdjusted], [28, false], 'el total sigue siendo 28 h');
    // La suma de los módulos + los recursos del curso es el total del diseño.
    const sum = mh.modules.reduce((a, m) => a + m.estimatedHours, 0) + mh.courseOverheadHours;
    assert(Math.abs(sum - r.estimatedHours) <= 0.35, `módulos + recursos del curso = total (${sum.toFixed(2)} vs ${r.estimatedHours})`);
    // Versión factible: con 3,5 h el cuarto módulo también queda en su banda.
    const ok4 = dist(A1A2, 28.5, [7, 12, 6, 3.5]);
    eq(ok4.moduleHours.modules.map((m) => m.status), ['within_tolerance', 'within_tolerance', 'within_tolerance', 'within_tolerance'], '7 / 12 / 6 / 3,5: los cuatro módulos dentro de ±10 %');
    eq(ok4.status, 'within_tolerance', 'el diseño queda dentro');
    assert(within(ok4.estimatedHours, 28.5), 'total ±10 %');
    // Cada módulo se diseña dentro de SUS horas: conserva sus capítulos (el diseño puede sumar prácticas dentro del módulo).
    for (const [i, pm] of ok4.modules.entries()) {
      const own = pm.chapters.filter((c) => !c.proposed).map((c) => c.id);
      eq(own, Array.from({ length: A1A2[i] }, (_, k) => `m${i + 1}c${k + 1}`), `módulo ${i + 1}: conserva sus ${A1A2[i]} capítulos`);
    }
  });

  // ── MH2 ──
  await check('MH2 un módulo null se reparte el resto del total (uno y varios)', () => {
    const one = dist(A1A2, 28, [7, null, 6, 3.5]);
    eq(one.moduleHours.remainderHours, 11.5, 'quedan 28 − 16,5 h');
    const m2 = one.moduleHours.modules[1];
    eq([m2.source, m2.targetHours], ['remainder', null], 'el módulo 2 es «el resto»');
    assert(within(m2.estimatedHours, 11.5), `módulo 2: ${m2.estimatedHours} h dentro de ±10 % de 11,5 h`);
    assert(within(one.estimatedHours, 28), `total ${one.estimatedHours} h ±10 %`);
    const two = dist(A1A2, 28, [7, null, null, 3.5]);
    eq(two.moduleHours.remainderHours, 17.5, 'dos módulos sin horas: 28 − 10,5 h entre los dos');
    const sum = two.moduleHours.modules.filter((m) => m.source === 'remainder').reduce((a, m) => a + m.estimatedHours, 0);
    assert(within(sum, 17.5), `los dos módulos suman ${sum.toFixed(1)} h ±10 % de 17,5 h`);
    eq(two.moduleHours.modules.map((m) => m.source), ['fixed', 'remainder', 'remainder', 'fixed'], 'origen por módulo');
    // Todos null (o ninguno usable) = el reparto de siempre (sin la clave moduleHours).
    assert(dist(A1A2, 28, [null, null, null, null]).moduleHours === undefined, 'todo null: sin moduleHours');
    // Con un solo módulo con horas y el resto null.
    assert(within(dist(A1A2, 28, [null, 12, null, null]).moduleHours.modules[1].estimatedHours, 12), 'solo el módulo 2 con horas: dentro de su banda');
  });

  // ── MH3 ──
  await check('MH3 si la suma de las horas fijadas pasa del total, el total pasa a ser la suma, con aviso visible', () => {
    const r = dist(A1A2, 20, [7, 12, 6, 4]);
    eq([r.targetHours, r.moduleHours.totalAdjusted, r.moduleHours.requestedTotalHours, r.moduleHours.totalHours], [29, true, 20, 29], 'el total pasa a 29 h');
    assert(r.moduleHours.warnings.some((w) => /suman 29 h, más que las 20 h del curso: el total pasa a ser 29 h/.test(w)), `aviso: ${JSON.stringify(r.moduleHours.warnings)}`);
    assert(r.priorityTrace.some((t) => /el total pasa a ser 29 h/.test(t)), 'el aviso también está en la traza del diseño');
    // Con un módulo sin horas y la suma pasada: el mínimo de 1 h para el módulo sin horas.
    const r2 = dist(A1A2, 20, [7, null, 6, 12]);
    eq([r2.moduleHours.totalAdjusted, r2.moduleHours.remainderHours, r2.targetHours], [true, 1, 26], 'módulo sin horas: 1 h y total 26 h');
    assert(r2.moduleHours.warnings.some((w) => /no queda tiempo/.test(w)), 'aviso del módulo sin margen');
    // Sin pasar del total no se avisa.
    const r3 = dist(A1A2, 40, [7, 12, 6, 4]);
    eq([r3.moduleHours.totalAdjusted, r3.targetHours], [false, 40], 'sin pasarse, el total es el pedido');
  });

  // ── MH4 ──
  await check('MH4 un módulo con muy pocas horas para sus capítulos: conflicto explícito (módulo y horas), en el diseño y en Verificación', () => {
    const r = dist(A1A2, 28, [7, 12, 6, 2]);
    const m4 = r.moduleHours.modules[3];
    eq(m4.status, 'minimum_exceeds_target', 'estado del módulo 4');
    assert(/módulo 4 «Módulo 4» tiene muy pocas horas para sus 5 capítulos/.test(m4.explanation) && /con 2 h \(±10 %\)/.test(m4.explanation) && /estructura mínima, que toma \d+(,\d)? h/.test(m4.explanation), m4.explanation);
    assert(/Sube sus horas a \d+(,\d)? h o más/.test(m4.explanation), 'dice a cuántas horas subirlo');
    assert(r.recommendations.some((t) => t === m4.explanation), 'está entre las recomendaciones del diseño');
    eq(r.status, 'minimum_exceeds_target', 'el diseño lo refleja');
    assert(r.modules[3].chapters.length === 5, 'Cursia no quita capítulos por su cuenta');
    // Verificación: un hallazgo por módulo, crítico, con el módulo y las horas.
    const V = L('modules/course-design/design-verification.js');
    const v = V.verifyDesign({
      status: r.status, targetHours: r.targetHours, estimatedHours: r.estimatedHours, toleranceHours: r.toleranceHours, baseHours: r.baseHours, counts: r.counts, manifestErrors: [], alignment: null,
      approach: null, policyKind: null, audiovisual: null, pinnedChapters: 0, cost: null, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] },
      proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [], moduleHours: r.moduleHours,
    });
    const c = v.checks.find((x) => x.id === 'module-hours:4');
    assert(c && c.severity === 'critical', `hallazgo crítico del módulo 4: ${JSON.stringify(v.checks.map((x) => x.id))}`);
    assert(/Módulo 4 «Módulo 4»: \d+(,\d)? h, pidió 2 h/.test(c.title) && /muy pocas horas/.test(c.detail), `título y detalle: ${c.title} / ${c.detail}`);
    assert(!v.checks.some((x) => /module-hours:[123]$/.test(x.id)), 'los módulos que sí llegan no se marcan');
    // Sin horas por módulo, Verificación no cambia.
    const base = dist(A1A2, 28);
    const vb = V.verifyDesign({ status: base.status, targetHours: base.targetHours, estimatedHours: base.estimatedHours, toleranceHours: base.toleranceHours, baseHours: base.baseHours, counts: base.counts, manifestErrors: [], alignment: null, approach: null, policyKind: null, audiovisual: null, pinnedChapters: 0, cost: null, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [] });
    assert(!vb.checks.some((x) => /module-hours/.test(x.id)), 'sin horas por módulo: ningún hallazgo nuevo');
  });

  // ── MH5 ──
  await check('MH5 sin horas por módulo el resultado es idéntico al de origin/staging (todos los fixtures del distribuidor)', async () => {
    const cur = matrix(DIST);
    const got = {};
    Object.assign(got, cur.run(), cur.dry);
    // Las formas de «no hay horas por módulo» (ausente, null, [], todo null) dan lo mismo que no pasarlas.
    for (const v of NOMH.slice(1)) {
      const alt = cur.run({ moduleHours: v });
      const diff = Object.keys(got).filter((k) => alt[k] !== undefined && alt[k] !== got[k]);
      eq(diff, [], `moduleHours = ${JSON.stringify(v)} cambia el resultado`);
    }
    if (process.argv.includes('--write-golden')) {
      assert(BASE, '--write-golden pide --base <dist de origin/staging>');
      const b = matrix(BASE);
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify({ ...b.run(), ...b.dry }, null, 2)}\n`);
      console.log(`   golden escrito en ${path.relative(REPO, GOLDEN)} (${Object.keys(got).length} casos)`);
      return;
    }
    let want;
    if (BASE) { const b = matrix(BASE); want = { ...b.run(), ...b.dry }; } else want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
    eq(bad, [], `huellas distintas de origin/staging (${BASE ? 'en vivo' : 'golden'})`);
    assert(Object.keys(got).length > 400, `hay casos (${Object.keys(got).length})`);
  });

  // ── MH6 ──
  const R = loader(DIST);
  const XN = R('modules/academic-context/requirements/requirements-extractor.js');
  const BOXM = R('modules/academic-context/requirements/requirements-box.js');
  const DOCR = R('modules/academic-context/requirements/document-requirements.js');
  const T = R('modules/academic-context/extract/text-sources.js');
  const linesN = (txt) => T.readText(Buffer.from(txt), 'text/plain').lines;
  const modHours = (reqs) => reqs.filter((r) => r.kind === 'target_hours' && r.scope.level === 'module').map((r) => [r.scope.index, r.value]);
  const courseHours = (reqs) => reqs.filter((r) => r.kind === 'target_hours' && r.scope.level === 'course').map((r) => r.value);
  await check('MH6 el lector entiende las tres frases del brief y no toma las horas de componente como horas de un módulo', () => {
    // «Movilidad segura: 4 capítulos, 7 h» (título + capítulos + horas, un módulo por renglón).
    const a = BOXM.extractBox('Movilidad segura: 4 capítulos, 7 h\nNormas de tránsito: 7 capítulos, 12 h\nSeñalización: 4 capítulos, 6 h\nEl vehículo: 5 capítulos, 3 h').requirements;
    eq(modHours(a), [[1, 7], [2, 12], [3, 6], [4, 3]], '«título: N capítulos, H h»');
    eq(a.find((r) => r.kind === 'structure').shape, [4, 7, 4, 5], 'y la forma sigue siendo 4 / 7 / 4 / 5');
    eq(courseHours(a), [], 'ninguna es del curso');
    // «Módulo 2: 12 horas».
    const b = BOXM.extractBox('4 módulos con 4, 7, 4 y 5 capítulos\nMódulo 1: 7 horas\nMódulo 2: 12 horas\nMódulo 3: 6 horas\nMódulo 4: 3 horas\n28 horas en total').requirements;
    eq(modHours(b), [[1, 7], [2, 12], [3, 6], [4, 3]], '«Módulo N: H horas»');
    eq(courseHours(b), [28], 'las 28 h son del curso');
    eq(modHours(BOXM.extractBox('Módulo 2: 12 horas').requirements), [[2, 12]], 'el renglón solo');
    // «Normas de tránsito – 7 capítulos – 12 horas».
    const c = BOXM.extractBox('Movilidad segura – 4 capítulos – 7 horas\nNormas de tránsito – 7 capítulos – 12 horas\nSeñalización – 4 capítulos – 6 horas\nEl vehículo – 5 capítulos – 3 horas').requirements;
    eq(modHours(c), [[1, 7], [2, 12], [3, 6], [4, 3]], '«título – N capítulos – H horas»');
    // En una sola frase y entre paréntesis.
    eq(modHours(BOXM.extractBox('Módulo 1: 4 capítulos (7 h), Módulo 2: 7 capítulos (12 h)').requirements), [[1, 7], [2, 12]], 'paréntesis');
    // Las horas del último módulo: si los demás no traen horas, son las del curso (no de ese módulo).
    const lastTotal = BOXM.extractBox('Movilidad segura: 4 capítulos\nNormas: 7 capítulos\nEmergencias: 5 capítulos, 28 horas').requirements;
    eq([modHours(lastTotal), courseHours(lastTotal)], [[], [28]], '«…, 28 horas» tras el último módulo son del curso');
    // NUNCA: horas de componente, rangos, referencias.
    const nope = (t, msg) => { const r = BOXM.extractBox(t).requirements; eq(modHours(r), [], msg); };
    nope('Módulo 2: 20 horas de clase', '«20 horas de clase» no son horas del módulo');
    nope('El módulo 2 tendrá 20 horas autónomas', 'horas autónomas');
    nope('Módulo 3: 4 horas semanales', 'horas semanales');
    nope('Módulo 2: 10–12 horas', 'un rango no es una cifra de módulo');
    nope('20 horas de clase para el módulo 2', 'al revés, también');
    eq(courseHours(BOXM.extractBox('Módulo 2: 20 horas de clase').requirements), [], 'tampoco son horas del curso');
    const comp = XN.extractRequirements(linesN('Módulo 2: 20 horas de clase\nEl curso tendrá 28 horas de trabajo del estudiante.'), 'doc');
    eq(modHours(comp.requirements), [], 'documento: sin horas de módulo');
    assert(comp.ignored.some((g) => g.reason === 'component_hours'), 'la cifra de componente queda registrada como ignorada');
    // Un documento: solo con verbo («El módulo 2 tendrá 12 horas»); «Módulo 2: 12 horas» suelto sigue su camino de siempre.
    eq(modHours(XN.extractRequirements(linesN('El módulo 2 tendrá 12 horas de trabajo.'), 'doc').requirements), [[2, 12]], 'documento con verbo');
    const sinVerbo = XN.extractRequirements(linesN('Módulo 2: 12 horas'), 'doc');
    eq(modHours(sinVerbo.requirements), [], 'documento sin verbo: no se inventa una autoridad');
  });

  // ── MH7 ──
  const docEntry = (text) => { const x = XN.extractRequirements(linesN(text), 'D1'); const docs = [{ id: 'D1', name: 'micro.docx', sha256: 'a'.repeat(64) }]; return { docs, entry: DOCR.storedEntry(docs, x, '2026-11-14T00:00:00.000Z') }; };
  const viewOf = (docText, boxText) => {
    const base = docText ? (() => { const { docs, entry } = docEntry(docText); return DOCR.buildRequirementsView([entry], null, docs); })() : DOCR.buildRequirementsView([], null, []);
    return BOXM.applyBoxToView(base, boxText ? { version: 1, text: boxText, at: '2026-11-14T00:00:00.000Z' } : null);
  };
  await check('MH7 la caja con horas por módulo reemplaza las del documento, con aviso; Entendí / No entendí', () => {
    const doc = 'El módulo 1 tendrá 8 horas. El módulo 2 tendrá 10 horas. El módulo 3 tendrá 5 horas.';
    const sin = viewOf(doc, null);
    eq(BOXM.moduleHoursDetail(sin.items.filter((i) => i.applies)), { hours: [8, 10, 5], origins: ['document', 'document', 'document'] }, 'solo el documento: sus horas, «del documento»');
    const v = viewOf(doc, 'Módulo 1: 7 horas\nMódulo 2: 12 horas');
    const applying = v.items.filter((i) => i.applies);
    eq(BOXM.moduleHoursDetail(applying), { hours: [7, 12], origins: ['requirements_box', 'requirements_box'] }, 'la caja manda; el módulo 3, que la caja no menciona, queda sin horas (no se toma el del documento)');
    const replaced = v.items.filter((i) => i.overriddenByBox && i.kind === 'target_hours');
    eq(replaced.length, 3, 'las tres horas del documento quedan reemplazadas');
    for (const it of replaced) assert(it.review.some((x) => /^La caja de requisitos reemplaza a «.+» del documento\.$/.test(x)) && !it.applies, 'con aviso visible');
    assert(v.box.overrides.length >= 3 && v.box.overrides.every((o) => /^La caja de requisitos reemplaza a «/.test(o.message)), 'cada reemplazo queda listado');
    // Entendí: las horas por módulo salen en el resumen, ya no «próximamente».
    const e = viewOf(null, '4 módulos con 4, 7, 4 y 5 capítulos\nMódulo 1: 7 horas\nMódulo 2: 12 horas\nMódulo 3: 6 horas\nMódulo 4: 3 horas\n28 horas');
    eq(e.box.understood.moduleHours, [7, 12, 6, 3], 'Entendí: horas por módulo');
    assert(/horas por módulo 7 \/ 12 \/ 6 \/ 3 h/.test(e.box.understood.summary), `resumen: ${e.box.understood.summary}`);
    eq(e.box.notUnderstood, [], 'todo se entendió');
    eq(e.box.understood.hours, 28, 'las horas del curso siguen siendo 28 h');
    // Una caja sin horas por módulo no toca las del documento.
    const nb = viewOf(doc, '4 módulos con 4, 7, 4 y 5 capítulos');
    eq(BOXM.moduleHoursDetail(nb.items.filter((i) => i.applies)), { hours: [8, 10, 5], origins: ['document', 'document', 'document'] }, 'sin horas en la caja, las del documento siguen');
    // Una línea que no se pudo leer como horas de módulo se dice (no «próximamente»).
    const nu = viewOf(null, 'Movilidad segura: 4 capítulos (6 h de clase), Normas: 7 capítulos (8 h de clase)');
    assert(nu.box.notUnderstood.some((n) => /No pude leer estas horas como las de un módulo/.test(n.reason)), JSON.stringify(nu.box.notUnderstood));
  });

  // ── MH8 ──
  await check('MH8 perfil: moduleTargetHours se valida y se redondea a 0,5 h; sin horas por módulo el sha no cambia', () => {
    const PRO = R('modules/pedagogy/pedagogy-profile.js');
    const reg = L('modules/pedagogy/index.js');
    const prof = (extra) => profileOf('competencias', extra);
    const norm = (p) => PRO.normalizePedagogicalProfile(p, reg.defaultApproachRegistry ? reg.defaultApproachRegistry() : undefined);
    const sinHoras = norm(prof({ targetHours: 28 }));
    assert(!('moduleTargetHours' in sinHoras), 'sin horas por módulo, la clave no existe');
    eq(PRO.pedagogicalProfileSha256(norm(prof({ targetHours: 28, moduleTargetHours: [null, null] }))), PRO.pedagogicalProfileSha256(sinHoras), 'todo null = el mismo perfil (mismo sha)');
    const con = norm(prof({ targetHours: 28, moduleTargetHours: [7, 12.2, null, 3.4] }));
    eq(con.moduleTargetHours, [7, 12, null, 3.5], 'se redondea a múltiplos de 0,5 h');
    eq(PRO.profileModuleHours(prof({ moduleTargetHours: [7, null, 6] })), [7, null, 6], 'lector de horas por módulo');
    eq(PRO.profileModuleHours(prof({})), null, 'sin horas: null');
    for (const bad of [[0, 5], [-3], ['x'], 'siete', [501], Array.from({ length: 100 }, () => 1)]) {
      let e = null; try { norm(prof({ moduleTargetHours: bad })); } catch (x) { e = x; }
      assert(e && /INVALID_MODULE_HOURS/.test(e.message), `inválido: ${JSON.stringify(bad).slice(0, 30)} → ${e && e.message}`);
    }
    // El redondeo y el aviso del distribuidor (por si llegan valores intermedios).
    const r = dist(A1A2, 28, [7, 12.2, 6, 3.5]);
    assert(r.moduleHours.warnings.some((w) => /módulo 2 \(12,2 h\) se redondearon a 12 h/.test(w)), `aviso de redondeo: ${JSON.stringify(r.moduleHours.warnings)}`);
    eq(r.moduleHours.modules[1].targetHours, 12, 'usa 12 h');
    const m = D.ST.normalizeModuleHours([7, 3.3, 'x', 0, 1000], 3);
    eq(m.hours, [7, 3.5, null], 'normalizeModuleHours: redondea, ignora lo inválido y recorta a los módulos que hay');
  });

  // ── MH9 ──
  await check('MH9 dry-run de punta a punta: reparto por módulo, Manifest coincide, huella y costo cambian con las horas', () => {
    const P = D.P;
    const run = (extra, pricing) => P.runPedagogyDryRun({ structure: struct(A1A2, LIGHT), profile: profileOf('competencias', { targetHours: 28, ...extra }), ...(pricing ? { pricing } : {}) });
    const a = run({});
    const b = run({ moduleTargetHours: [7, 12, 6, 3.5] });
    const c = run({ moduleTargetHours: [7, 14, 6, 3.5] });
    assert(a.distribution.moduleHours === undefined, 'sin horas por módulo: sin moduleHours');
    assert(b.distribution.moduleHours && b.distribution.moduleHours.modules.length === 4, 'con horas: moduleHours');
    eq(b.distribution.materialized.manifestErrors, [], 'el Manifest materializado coincide con la propuesta (sin DISTRIBUTION_MODEL_MISMATCH)');
    assert(a.distribution.proposalSha256 !== b.distribution.proposalSha256 && b.distribution.proposalSha256 !== c.distribution.proposalSha256, 'la huella de la propuesta cambia con las horas de los módulos');
    // Lo que se aprueba es lo que se ve: misma entrada → misma huella.
    eq(run({ moduleTargetHours: [7, 12, 6, 3.5] }).distribution.proposalSha256, b.distribution.proposalSha256, 'determinista');
    // El resumen de horas se recalcula: más horas en el módulo 2 → más horas en el diseño.
    assert(c.distribution.estimatedHours > b.distribution.estimatedHours + 1, `el resumen de horas sube (${b.distribution.estimatedHours} → ${c.distribution.estimatedHours})`);
    assert(within(c.distribution.moduleHours.modules[1].estimatedHours, 14), 'módulo 2: 14 h');
    // Total que pasa a ser la suma: workload y distribución dicen lo mismo.
    const d = run({ moduleTargetHours: [7, 12, 6, 4] , targetHours: 20 });
    eq([d.distribution.targetHours, d.workload.targetHours], [29, 29], 'el total pasa a ser la suma, también en el resumen');
    // El costo estimado se recalcula (más horas = más capítulos de práctica / actividades = más producción).
    const price = { audioPerMinuteUsd: 0.015, llmPerKTokUsd: 0.012 };
    const cost = (r) => (r.diff && r.diff.estimateExpectedUsd ? r.diff.estimateExpectedUsd.pedagogical : null);
    const mc = (r) => { const t = r.distribution.materialized.totals || {}; return JSON.stringify(t); };
    assert(mc(b) !== mc(c) || cost(b) !== cost(c), 'los totales del Manifest (de donde sale el costo) cambian con las horas');
    void price;
  });

  // ── MH10 ──
  await check('MH10 Prebrief: el resumen dice las horas por módulo; sin ellas, el de siempre', () => {
    const { fixture } = require(path.join(REPO, 'scripts/fixtures/prebrief-fixtures.js'));
    const M = R('modules/prebrief/prebrief-model.js');
    const DOCM = R('modules/prebrief/prebrief-document.js');
    const RA = R('modules/academic-context/requirements/requirement-authority.js');
    const build = (inp) => M.buildPrebriefModel(inp, RA.actualText, RA.requirementText);
    const inp = fixture({ shape: [4, 7, 4, 5] });
    const sin = build(inp);
    assert(!('moduleHours' in sin.duration), 'sin horas por módulo, el modelo no trae la clave');
    const withMh = { ...inp, card: { ...inp.card } };
    withMh.card.moduleHours = {
      active: true, values: [7, 12, 6, 3], origins: ['requirements_box', 'requirements_box', 'document', 'teacher'], suggested: null, suggestedOrigins: null, notes: [],
      result: { version: 1, modules: [7, 12, 6, 3].map((h, i) => ({ index: i + 1, title: `Módulo ${i + 1}`, source: 'fixed', targetHours: h, estimatedHours: h === 3 ? 3.4 : h - 0.3, status: h === 3 ? 'minimum_exceeds_target' : 'within_tolerance' })) },
    };
    const m = build(withMh);
    eq(m.duration.moduleHours.map((e) => [e.n, e.requested, e.estimated, e.within]), [[1, 7, 6.7, true], [2, 12, 11.7, true], [3, 6, 5.7, true], [4, 3, 3.4, false]], 'modelo');
    eq(m.structure.modules.map((x) => x.hours), [6.7, 11.7, 5.7, 3.4], 'las horas de cada módulo son las del módulo');
    const doc = DOCM.buildPrebriefDocument(m);
    const txt = DOCM.documentTexts(doc).join('\n');
    assert(/Horas por módulo/.test(txt) && /Módulo 1: 6,7 h de 7 h pedidas/.test(txt) && /Módulo 4: 3,4 h de 3 h pedidas \(fuera de lo pedido\)/.test(txt), `el documento dice las horas por módulo: ${txt.split('\n').filter((l) => /Horas por módulo|Módulo 1:/.test(l)).join(' | ')}`);
    assert(!/Horas por módulo/.test(DOCM.documentTexts(DOCM.buildPrebriefDocument(sin)).join('\n')), 'sin horas por módulo, el documento de siempre');
    assert(M.diffModels(sin, m).some((x) => /^Horas por módulo: sin horas por módulo → 7 \/ 12 \/ 6 \/ 3 h$/.test(x)), `diferencia: ${JSON.stringify(M.diffModels(sin, m))}`);
  });

  // ── MH11 ──
  await check('MH11 API: el DTO acepta moduleTargetHours; la respuesta trae el origen de cada módulo', () => {
    const { validateSync } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const DTO = L('modules/course-design/dto/recommend.dto.js');
    const errs = (adjust) => validateSync(plainToInstance(DTO.RecommendDesignDto, { adjust }), { whitelist: true, forbidNonWhitelisted: false }).length;
    eq([errs({ moduleTargetHours: [7, 12, null, 3] }), errs({ moduleTargetHours: null }), errs({ moduleTargetHours: Array.from({ length: 100 }, () => 1) })].map((n) => n > 0), [false, false, true], 'DTO');
    const src = fs.readFileSync(path.join(REPO, 'src/modules/course-design/course-design.service.ts'), 'utf8');
    assert(/moduleHoursDetail\(auth\.applicable\)/.test(src) && /suggestedOrigins/.test(src) && /'requirements_box'|requirements_box/.test(fs.readFileSync(path.join(REPO, 'src/modules/academic-context/requirements/requirements-box.ts'), 'utf8')), 'la respuesta trae origen por módulo');
    assert(/moduleHours: \{ saved: savedMh, suggested: reqMh \? reqMh\.hours : null, suggestedOrigins: reqMh \? reqMh\.origins : null \}/.test(src), 'structure-options trae moduleHours { saved, suggested, suggestedOrigins } para precargar «Estructura»');
    // Autoridad: lo que el docente escribió gana a la caja, que gana al documento.
    const detail = BOXM.moduleHoursDetail(viewOf('El módulo 1 tendrá 8 horas. El módulo 2 tendrá 10 horas.', 'Módulo 1: 7 horas').items.filter((i) => i.applies));
    eq(detail, { hours: [7], origins: ['requirements_box'] }, 'caja > documento');
    const origins = (vals, det) => vals.map((v, i) => (v === null ? null : det && det.hours[i] === v ? det.origins[i] : 'teacher'));
    eq(origins([7, 11, null], detail), ['requirements_box', 'teacher', null], 'docente > caja: un valor distinto es del docente');
  });

  eq(netAttempts, [], 'red');
  console.log(`\n${ok} OK · ${fail} fallas · red ${netAttempts.length} · USD 0.00`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
