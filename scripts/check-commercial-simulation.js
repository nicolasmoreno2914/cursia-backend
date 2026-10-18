#!/usr/bin/env node
/* eslint-disable */
// T7 (r57) — SIMULACIÓN COMERCIAL: diez cursos sintéticos (clientes genéricos A/B/C) de punta a punta con el MISMO motor
// (scripts/lib/commercial-simulation.js); cada curso es SOLO configuración (scripts/fixtures/commercial-simulation/
// courses.json). Check puro contra el código COMPILADO (dist/; correr "npm run build" antes). Sin red, sin IA, sin DB,
// USD 0. Proveedores: los artifacts simulados de los checks de empaque (salidas del ejecutor falsas) + bancos de examen
// de prueba.
//
//   CS1 por curso: perfil → dry-run (distribuidor) → Prebrief → Blueprint → Manifest → briefs → artifacts falsos →
//       buildDynamicMbzV3 → validateMbzV3 limpio + aserciones del TIPO de curso (declaradas en su configuración):
//       tipos de aprendizaje, motivo del video, tipos de actividad, librerías H5P, metodología (directivas de fase en los
//       briefs + requisitos del marco + rótulos de fase), entregas (Tarea calificada en su categoría, rúbrica), archivos
//       de práctica enlazados, «Repaso» sin nota, H5P evaluativo con nota y tracking, solucionario oculto, guía del
//       docente oculta, slots aleatorios, nota mínima
//   CS2 solo configuración: el motor no nombra ningún curso/cliente/título de la configuración; los diez cursos pasan por
//       la MISMA función; las configuraciones son distintas entre sí
//   CS3 S (A) < M (B) < L (C): difieren en ≥ 6 dimensiones; horas, videos, preguntas y costo estimado crecen
//   CS4 FinOps estimado (Manifest): videogen = videos; cada curso con estimado > 0; los proveedores del estimado = los del
//       Manifest
//   CS5 determinismo: el mismo curso dos veces → el mismo .mbz byte a byte
//   CS7 las aserciones muerden: expectativas equivocadas (tipo, rúbrica, fase, guía, librería, formato) fallan
//   CS6 informe: proyección del diseño (vista previa) vs tipo de actividad congelado en el Manifest (hallazgo F1)
//
// Usage: node scripts/check-commercial-simulation.js [--only=A-S,…] [--out=<dir>]  (evidencia JSON en --out, default
//   ~/cursia-test-env/work/r57/t7-out)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.join(ROOT, 'dist');
const S = require('./lib/commercial-simulation');
const CONFIG_PATH = path.join(__dirname, 'fixtures/commercial-simulation/courses.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(os.homedir(), 'cursia-test-env/work/r57/t7-out');
const COURSES = CONFIG.courses.filter((c) => !only.length || only.includes(c.id));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n   ')}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}: ${x} !== ${y}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Aserciones genéricas: cada una se activa SOLO por una clave `expect` de la configuración del curso. */
async function assertCourse(sim) {
  const { cfg, built, validation, dryRun, prebrief, locked, manifest, briefs } = sim;
  const e = cfg.expect || {};
  const f = built.expectations.facts;
  const resolved = built.expectations.resolved;
  const insp = await S.inspectMbz(built.mbz);
  const notes = [];
  assert(validation.ok, `paquete inválido: ${JSON.stringify(validation.issues.slice(0, 4))}`);
  eq(built.expectations.builderVersion, sim.builderVersion, 'versión del builder');
  const contentFacts = f.chapters.filter((c) => c.kind !== 'practice');
  const lockedContent = locked.modules.flatMap((m) => m.chapters.filter((c) => (c.kind || 'content') === 'content'));
  const dChapters = dryRun.distribution.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content'));
  // Conteos (estructura) y Prebrief = paquete.
  if (e.counts) {
    if (e.counts.modules !== undefined) eq(f.counts.modules, e.counts.modules, 'módulos');
    if (e.counts.content !== undefined) eq(contentFacts.length, e.counts.content, 'capítulos de contenido');
    if (e.counts.practice !== undefined) eq(f.chapters.length - contentFacts.length, e.counts.practice, 'capítulos de práctica');
  }
  eq([prebrief.resources.videos, prebrief.resources.applicationActivities, prebrief.resources.moduleExams],
    [f.counts.videos, f.counts.applicationActivities || 0, f.counts.exams], 'Prebrief (videos / AA / exámenes) = paquete');
  eq([manifest.totals.videoCount, manifest.totals.activityCount], [f.counts.videos, f.counts.activities], 'Manifest = paquete');
  // Inventario del paquete por modname = facts.
  eq(insp.byModname.h5pactivity || 0, f.counts.videos + (f.counts.activitiesByVariant.h5p || 0) + (f.counts.reviewCards || 0), 'h5pactivity = videos + actividades + «Repaso»');
  eq(insp.byModname.quiz || 0, f.counts.exams + (f.finalExam.enabled ? 1 : 0), 'quiz = exámenes de módulo + final');
  eq(insp.byModname.assign || 0, f.counts.applicationAssigns || 0, 'assign = AA entregadas como Tarea');
  eq(insp.byModname.resource || 0, 1 + (f.counts.practiceResources || 0), 'resource = Libro Guía + archivos de práctica');
  // Tipos de aprendizaje (congelados en el Blueprint).
  const types = lockedContent.map((c) => c.design && c.design.learningType && c.design.learningType.type);
  if (e.learningTypesOnly) assert(types.every((t) => e.learningTypesOnly.includes(t)), `tipos de aprendizaje ${JSON.stringify(types)} ⊄ ${JSON.stringify(e.learningTypesOnly)}`);
  // Video por necesidad.
  if (e.videoForEveryContentChapter) assert(contentFacts.every((c) => c.videoEnabled), 'todo capítulo de contenido con video');
  if (e.videoRulePrefix) {
    const rules = dChapters.map((c) => c.videoDecision && c.videoDecision.ruleId);
    assert(rules.every((r) => r && r.startsWith(e.videoRulePrefix)), `motivo del video ${JSON.stringify(rules)} ≠ ${e.videoRulePrefix}*`);
  }
  // Actividad derivada del tipo de aprendizaje.
  const acts = contentFacts.filter((c) => c.activityEnabled).map((c) => c.activityType);
  if (e.activityTypesOnly) assert(acts.every((t) => e.activityTypesOnly.includes(t)), `actividades ${JSON.stringify(acts)} ⊄ ${JSON.stringify(e.activityTypesOnly)}`);
  // «Incluye»: sobre TODOS los capítulos (los de práctica que agrega el distribuidor también llevan actividad).
  const allActs = f.chapters.filter((c) => c.activityEnabled).map((c) => c.activityType);
  if (e.activityTypesInclude) for (const t of e.activityTypesInclude) assert(allActs.includes(t), `falta actividad ${t} (${JSON.stringify(allActs)})`);
  const libs = [...new Set((built.summary.h5pPackages || []).map((p) => p.mainLibrary))];
  if (e.h5pLibrariesInclude) for (const l of e.h5pLibrariesInclude) assert(libs.includes(l), `falta librería ${l} (${JSON.stringify(libs)})`);
  // H5P evaluativo vs «Repaso».
  for (const h of insp.h5p) {
    if (/:review_cards$/.test(h.idnumber)) eq([h.grade, h.enabletracking, h.hasGradeItem, h.completion, h.completionview], [0, 0, false, 2, 1], `${h.idnumber}: «Repaso» sin nota, completion por vista`);
    else eq([h.enabletracking, h.hasGradeItem, h.completion, h.completionview], [1, true, 2, 0], `${h.idnumber}: H5P evaluativo con tracking, ítem de nota y completion por nota`);
  }
  if (e.reviewCards) assert((f.counts.reviewCards || 0) > 0 && libs.includes('H5P.Dialogcards'), '«Repaso» (Dialog Cards) presente');
  // Metodología.
  if (e.framework) {
    eq(locked.course.pedagogy && locked.course.pedagogy.learningPlan && locked.course.pedagogy.learningPlan.framework, e.framework, 'metodología congelada en el curso');
    assert(lockedContent.every((c) => c.design && c.design.framework === e.framework), 'metodología en cada capítulo');
  }
  if (e.experienceRequirements) {
    for (const c of lockedContent) {
      const b = briefs.get(`experience:${c.id}`);
      eq(b && (b.experienceRequirements || []).map((r) => r.id), e.experienceRequirements, `requisitos del marco en la experiencia de ${c.title}`);
    }
  }
  if (e.briefIncludes) {
    for (const [type, phrases] of Object.entries(e.briefIncludes)) {
      const keys = manifest.items.filter((i) => i.type === type && (!i.chapterId || lockedContent.some((c) => c.id === i.chapterId))).map((i) => i.key);
      assert(keys.length > 0, `sin items ${type}`);
      for (const k of keys) {
        const b = briefs.get(k);
        assert(b, `${k}: sin brief`);
        for (const p of phrases) assert(b.text.includes(p), `${k}: el brief no trae «${p}»`);
      }
    }
  }
  if (e.phaseLabels) assert(contentFacts.every((c) => c.phaseLabels && Object.keys(c.phaseLabels).length > 0), 'rótulos de fase en cada capítulo de contenido');
  // Exámenes.
  const examMode = e.examMode || cfg.exams || 'bank';
  for (const q of insp.quizzes) {
    if (examMode === 'bank') eq(q.randomSlots, q.slots, `${q.idnumber}: todos los slots aleatorios`);
    else eq(q.randomSlots, 0, `${q.idnumber}: GIFT sin slots aleatorios`);
    assert(q.slots > 0, `${q.idnumber}: con preguntas`);
  }
  eq(insp.quizzes.filter((q) => q.idnumber !== 'cv3:final_exam').map((q) => q.slots), f.modules.filter((m) => m.examEnabled !== false && m.examQuestionCount).map((m) => m.examQuestionCount), 'slots por examen de módulo = facts');
  if (e.passingGrade) eq(resolved.courseGradepass, e.passingGrade, 'nota mínima del curso (gradepass del ítem del curso)');
  // Solucionario: una página oculta por AA (página o Tarea).
  const sol = insp.pages.filter((p) => /:application_solution$/.test(p.idnumber));
  eq(sol.length, f.counts.applicationActivities || 0, 'un solucionario por AA');
  assert(sol.every((p) => p.visible === 0), 'solucionarios ocultos');
  // Entregas como Tarea.
  if (e.assign) {
    const assigns = insp.pages.filter((p) => p.modname === 'assign');
    eq(assigns.length, f.counts.applicationActivities, 'cada AA como Tarea');
    eq(f.counts.applicationAssignsGraded || 0, e.assign.graded ? assigns.length : 0, 'Tareas calificadas');
    eq(resolved.application && resolved.application.category, e.assign.graded ? e.assign.category : null, 'categoría de la Tarea');
    if (e.assign.category === 'applications') assert(resolved.categories.some((c) => c.key === 'applications' && c.weight > 0), 'categoría «Actividades de Aplicación» con peso');
    assert(assigns.every((a) => a.hasRubric === !!e.assign.rubric), `rúbrica ${e.assign.rubric ? 'en' : 'en ninguna'} Tarea`);
  }
  // Archivos de práctica.
  if (e.practiceFiles) {
    const pr = built.summary.practiceResources || [];
    eq(pr.length, e.practiceFiles.count, 'archivos de práctica');
    eq([...new Set(pr.map((x) => x.filename.split('.').pop()))].sort(), [...e.practiceFiles.formats].sort(), 'formatos de los archivos');
    for (const x of pr.filter((r) => r.relation === 'application')) {
      const app = f.chapters.find((c) => c.id === x.chapterId);
      assert(app && app.applicationMinutes !== undefined, `${x.id}: enlazado desde una AA`);
    }
  }
  // Guía del docente.
  if (e.teacherGuide !== undefined) {
    const tg = insp.pages.filter((p) => p.idnumber === 'cv3:shell:teacher_guide');
    eq(tg.map((p) => p.visible), e.teacherGuide ? [0] : [], 'Guía del docente oculta');
  }
  // F1 (corregido): la proyección del diseño (dry-run `chapters[].activityDecision`) sale del Manifest materializado
  // (con los capítulos de práctica incluidos); debe coincidir con el h5pType congelado en cada capítulo.
  const manAct = new Map(manifest.items.filter((i) => i.type === 'activity').map((i) => [i.chapterId, i.h5pType]));
  const projectionMismatch = (dryRun.chapters || []).filter((ch) => ch.activityDecision && manAct.has(ch.chapterId) && manAct.get(ch.chapterId) !== ch.activityDecision.type)
    .map((ch) => ({ chapter: ch.title, projected: ch.activityDecision.type, manifest: manAct.get(ch.chapterId) }));
  notes.push(`${f.counts.modules}m ${contentFacts.length}+${f.chapters.length - contentFacts.length}c ${f.counts.videos}v ${libs.length}lib ${f.counts.applicationActivities || 0}AA ${f.counts.applicationAssigns || 0}assign ${(built.summary.practiceResources || []).length}files ${insp.quizzes.length}quiz/${insp.quizzes.reduce((n, q) => n + q.slots, 0)}slots ${dryRun.distribution.estimatedHours}h USD ${Number(dryRun.distribution.materialized.providers.estimateUsd.expected).toFixed(2)}`);
  return {
    id: cfg.id, client: cfg.client, kind: cfg.kind, valid: validation.ok, issues: validation.issues.length, warnings: built.summary.warnings || [],
    builderVersion: built.expectations.builderVersion, mbzSha256: sha(built.mbz), mbzBytes: built.mbz.length,
    counts: f.counts, byModname: insp.byModname, h5pLibraries: libs, learningTypes: types, activityTypes: acts,
    videoRules: dChapters.map((c) => c.videoDecision ? c.videoDecision.ruleId : null), hours: dryRun.distribution.estimatedHours, status: dryRun.distribution.status,
    usdExpected: Number(dryRun.distribution.materialized.providers.estimateUsd.expected), providers: dryRun.distribution.materialized.providers,
    quizzes: insp.quizzes, categories: resolved.categories, projectionMismatch, note: notes.join(' '),
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = {};
  const sims = {};
  // ── CS1 ────────────────────────────────────────────────────────────────────
  for (const cfg of COURSES) {
    await check(`CS1 [${cfg.id}] cliente ${cfg.client} · ${cfg.kind}: configuración → Prebrief/Blueprint/distribuidor → Manifest → artifacts falsos → builder → validador + aserciones del tipo`, async () => {
      const sim = await S.simulateCourse(distRoot, cfg);
      sims[cfg.id] = sim;
      results[cfg.id] = await assertCourse(sim);
      console.log(`   ${results[cfg.id].note}`);
    });
  }

  // ── CS2 ────────────────────────────────────────────────────────────────────
  await check('CS2 solo configuración: el motor no nombra ningún curso, cliente ni título; mismas funciones para todos; configuraciones distintas', () => {
    const engine = fs.readFileSync(path.join(__dirname, 'lib/commercial-simulation.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const c of CONFIG.courses) {
      for (const lit of [c.id, c.title, c.kind, String(c.courseId)]) assert(!engine.includes(`'${lit}'`) && !engine.includes(`"${lit}"`) && !engine.includes(String(c.courseId)), `el motor nombra ${lit}`);
      assert(!new RegExp(`\\bcliente\\s+${c.client}\\b`, 'i').test(engine), `el motor nombra al cliente ${c.client}`);
    }
    const shas = CONFIG.courses.map((c) => sha(JSON.stringify({ ...c, id: undefined, courseId: undefined, title: undefined })));
    eq(new Set(shas).size, CONFIG.courses.length, 'configuraciones pairwise distintas');
    assert(Object.keys(sims).length === COURSES.length, 'todos los cursos simulados por simulateCourse');
    results._engine = { file: 'scripts/lib/commercial-simulation.js', sha256: sha(fs.readFileSync(path.join(__dirname, 'lib/commercial-simulation.js'))), configSha256: sha(fs.readFileSync(CONFIG_PATH)) };
  });

  // ── CS3 ────────────────────────────────────────────────────────────────────
  if (results['A-S'] && results['B-M'] && results['C-L']) {
    await check('CS3 S (cliente A) < M (cliente B) < L (cliente C): ≥ 6 dimensiones distintas; horas, videos, preguntas y costo crecen', () => {
      const dim = (r) => ({ modules: r.counts.modules, chapters: r.counts.chapters, videos: r.counts.videos, h5p: r.byModname.h5pactivity, aa: r.counts.applicationActivities || 0, quiz: r.byModname.quiz, slots: r.quizzes.reduce((n, q) => n + q.slots, 0), hours: r.hours, labels: r.byModname.label, pages: r.byModname.page });
      const [s, m, l] = ['A-S', 'B-M', 'C-L'].map((k) => dim(results[k]));
      for (const [a, b, n] of [[s, m, 'S/M'], [m, l, 'M/L']]) {
        const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
        assert(diff.length >= 6, `${n}: solo difieren ${diff.join(',')}`);
        for (const k of ['hours', 'videos', 'slots', 'chapters']) assert(a[k] < b[k], `${n}: ${k} ${a[k]} < ${b[k]}`);
      }
      assert(results['A-S'].usdExpected < results['B-M'].usdExpected && results['B-M'].usdExpected < results['C-L'].usdExpected, 'costo estimado crece');
    });
  }

  // ── CS4 ────────────────────────────────────────────────────────────────────
  await check('CS4 FinOps estimado desde el Manifest: videogen.render = videos; estimado > 0 por curso; solo proveedores del Manifest', () => {
    for (const r of Object.values(results).filter((x) => x && x.id)) {
      const by = r.providers.byProvider;
      const vg = Object.values(by).reduce((n, p) => n + (p.operations['videogen.render'] || 0), 0);
      eq(vg, r.counts.videos, `${r.id}: videogen.render = videos`);
      assert(r.usdExpected > 0, `${r.id}: estimado > 0`);
      for (const p of Object.keys(by)) assert(['anthropic', 'videogen', 'gamma', 'openai', 'youtube', 'cursia'].includes(p), `${r.id}: proveedor ${p}`);
    }
  });

  // ── CS6 ────────────────────────────────────────────────────────────────────
  await check('CS6 proyección del diseño == Manifest congelado: tipo de actividad por capítulo (F1: fuente única = Manifest materializado)', () => {
    const rows = Object.values(results).filter((x) => x && x.id).flatMap((r) => r.projectionMismatch.map((m) => ({ course: r.id, ...m })));
    results._findings = { projectionMismatch: rows };
    eq(rows, [], `la vista previa dice un tipo y el Manifest congela otro: ${rows.map((m) => `${m.course}/${m.chapter} ${m.projected}→${m.manifest}`).join('; ')}`);
  });

  // ── CS5 ────────────────────────────────────────────────────────────────────
  const det = COURSES.find((c) => c.id === 'A-S') || COURSES[0];
  if (det && sims[det.id]) {
    await check(`CS5 determinismo: [${det.id}] dos veces → el mismo .mbz byte a byte`, async () => {
      const again = await S.simulateCourse(distRoot, det);
      eq(sha(again.built.mbz), sha(sims[det.id].built.mbz), 'mismos bytes');
    });
  }

  // ── CS7 ────────────────────────────────────────────────────────────────────
  await check('CS7 las aserciones muerden: una expectativa equivocada en la configuración hace FALLAR el curso', async () => {
    const muts = [
      ['procedimental', { learningTypesOnly: ['conceptual'] }, /tipos de aprendizaje/],
      ['entrega-rubrica', { assign: { graded: true, category: 'applications', rubric: false } }, /rúbrica/],
      ['gagne', { briefIncludes: { experience: ['Evento 10'] } }, /Evento 10/],
      ['A-S', { teacherGuide: false }, /Guía del docente/],
      ['multi-h5p', { h5pLibrariesInclude: ['H5P.Flashcards'] }, /Flashcards/],
      ['ofimatica', { practiceFiles: { formats: ['xlsx'], count: 4 } }, /formatos/],
    ];
    let bitten = 0;
    for (const [id, expect, re] of muts) {
      if (!sims[id]) continue;
      let err = null;
      try { await assertCourse({ ...sims[id], cfg: { ...sims[id].cfg, expect } }); } catch (e) { err = e; }
      assert(err && re.test(err.message), `${id}: la expectativa ${JSON.stringify(expect)} debía fallar (${err ? err.message : 'no falló'})`);
      bitten++;
    }
    assert(bitten > 0, 'sin cursos para mutar');
  });

  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v && v.id ? { ...v, providers: undefined } : v]));
  fs.writeFileSync(path.join(OUT, 'commercial-simulation-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${passed} ok, ${failed} fallos (evidencia: ${path.join(OUT, 'commercial-simulation-summary.json')})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
