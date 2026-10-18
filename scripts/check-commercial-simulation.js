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
//   r58 (I6): en CS1 además, para TODO curso, las relaciones objetivos ↔ actividades ↔ evaluaciones ↔ registro de
//       horas (gap reportado, nunca rellenado) ↔ archivos ↔ notas/insignia, y el informe de calidad sin BLOCKER;
//       expectativas nuevas: counts.videos, applicationActivitiesMin, manifestTypes (lista blanca), grading
//   CS8 defectos sembrados → el informe de calidad los detecta (y un .mbz corrupto → BLOCKER)
//   CS9 composición por necesidad: prioridad audiovisual menos ≤ recomendado ≤ más sobre la misma estructura
//
// Usage: node scripts/check-commercial-simulation.js [--only=A-S,…] [--out=<dir>]  (evidencia JSON en --out, default
//   ~/cursia-test-env/work/r57/t7-out; r58: usar --out=~/cursia-test-env/work/r58/out/…)
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

/**
 * r58 (I6) · RELACIONES que todo curso debe cumplir (no dependen de `expect`): objetivos ↔ actividades ↔ evaluaciones ↔
 * registro de horas (gap reportado, nunca rellenado) ↔ archivos ↔ notas ↔ requisitos de Moodle (validateMbzV3 ya en
 * assertCourse). Devuelve un resumen para la evidencia.
 */
function assertRelations(sim, insp) {
  const { built, locked, manifest, input, dryRun } = sim;
  const f = built.expectations.facts;
  const resolved = built.expectations.resolved;
  const items = new Set(manifest.items.map((i) => i.key));
  const lockedCh = locked.modules.flatMap((m) => m.chapters.map((c) => ({ ...c, moduleId: m.id, examEnabled: m.examEnabled })));
  const content = lockedCh.filter((c) => (c.kind || 'content') === 'content');
  const idn = new Set(insp.h5p.map((h) => h.idnumber));
  // Objetivos ↔ actividades: cada capítulo de contenido tiene objetivo, content + experience; actividad ⇒ item + H5P.
  for (const c of content) {
    assert(typeof c.objective === 'string' && c.objective.trim().length > 0, `${c.title}: capítulo sin objetivo`);
    assert(items.has(`content:${c.id}`) && items.has(`experience:${c.id}`), `${c.title}: sin content/experience en el Manifest`);
  }
  for (const c of f.chapters.filter((x) => x.activityEnabled && x.activityVariant !== 'scorm')) {
    assert(items.has(`activity:${c.id}`), `${c.id}: actividad sin item del Manifest`);
    assert(idn.has(`cv3:ch:${c.id}:activity`), `${c.id}: actividad sin H5P en el paquete`);
  }
  // Actividades ↔ evaluaciones: un quiz por módulo con examen (y ninguno sin él); el banco cubre cada capítulo.
  const quizIdn = new Set(insp.quizzes.map((q) => q.idnumber));
  for (const m of manifest.modules) {
    eq(quizIdn.has(`cv3:exam:${m.moduleId}`), !!m.examEnabled, `módulo ${m.moduleNumber}: examen ⇔ examEnabled`);
    const bank = input.contents.examBanks && input.contents.examBanks.get(m.moduleId);
    if (m.examEnabled && bank) {
      const covered = new Set(bank.questions.map((q) => q.chapterId));
      for (const c of m.chapters.filter((x) => x.kind !== 'practice')) assert(covered.has(c.chapterId), `módulo ${m.moduleNumber}: el banco no evalúa el capítulo ${c.chapterId}`);
    }
  }
  eq(quizIdn.has('cv3:final_exam'), !!manifest.features.finalExam, 'evaluación final ⇔ finalExam');
  // Registro de horas: líneas = total; gap = objetivo − total; HOURS_TARGET_GAP ⇔ fuera de tolerancia; sin relleno
  // (el paquete tiene exactamente los capítulos del Blueprint: el gap no agrega nada).
  const hr = f.hoursReport;
  assert(hr && Array.isArray(hr.lines) && hr.lines.length > 0, 'facts sin hoursReport');
  const sum = hr.lines.reduce((n, l) => n + l.minutes, 0);
  assert(Math.abs(sum - hr.totals.minutes) < 0.02, `líneas ${sum} ≠ total ${hr.totals.minutes}`);
  assert(hr.gap && Math.abs(hr.gap.minutes - (sim.cfg.targetHours * 60 - hr.totals.minutes)) < 0.02, `gap ${JSON.stringify(hr.gap)}`);
  eq(hr.findings.some((x) => x.code === 'HOURS_TARGET_GAP'), !hr.gap.within, 'HOURS_TARGET_GAP ⇔ gap fuera de tolerancia');
  eq(f.chapters.length, lockedCh.length, 'capítulos del paquete = Blueprint (el gap no se rellena)');
  // Archivos: cada archivo de práctica pertenece a un capítulo del Blueprint; los de una AA, a un capítulo con AA.
  for (const r of built.summary.practiceResources || []) {
    const ch = f.chapters.find((c) => c.id === r.chapterId);
    assert(ch, `${r.id}: capítulo inexistente`);
    if (r.relation === 'application') assert(items.has(`application_activity:${r.chapterId}`), `${r.id}: archivo de AA en un capítulo sin AA`);
  }
  // Notas: con nota ⇒ pesos suman 100 y cada categoría con peso tiene ítems calificables; sin nota ⇒ sin criterio de nota.
  const gradedH5p = insp.h5p.filter((h) => h.hasGradeItem).length;
  if (!resolved.withoutGrades) {
    const total = resolved.categories.reduce((n, c) => n + c.weight, 0);
    assert(Math.abs(total - 100) < 0.01, `pesos ${total} ≠ 100`);
    const has = { practice: gradedH5p > 0, moduleExams: insp.quizzes.some((q) => q.idnumber !== 'cv3:final_exam'), finalExam: quizIdn.has('cv3:final_exam'), applications: (f.counts.applicationAssignsGraded || 0) > 0 };
    for (const c of resolved.categories.filter((x) => x.weight > 0)) assert(has[c.key] !== false, `categoría ${c.key} con peso y sin ítems calificables`);
    eq(resolved.courseCompletion.requireCourseGradePass, true, 'con nota: criterio de nota del curso');
  } else {
    eq([gradedH5p, insp.quizzes.length, f.counts.applicationAssignsGraded || 0], [0, 0, 0], 'sin nota: ningún ítem calificable');
    eq(resolved.courseCompletion.requireCourseGradePass, false, 'sin nota: sin criterio de nota');
  }
  // Insignia ⇔ evaluación final (y curso con nota) — r55.
  eq(insp.badges > 0, !!manifest.features.finalExam && !resolved.withoutGrades, 'insignia ⇔ evaluación final con nota');
  return {
    contentChapters: content.length, activities: f.counts.activities, quizzes: insp.quizzes.length, gradedH5p, practiceFiles: (built.summary.practiceResources || []).length,
    hours: { target: sim.cfg.targetHours, total: hr.totals.hours, gap: hr.gap.hours, within: hr.gap.within, designStatus: dryRun.distribution.status }, withoutGrades: !!resolved.withoutGrades, badge: insp.badges > 0,
  };
}

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
  // r58 (I6) · expectativas nuevas (cada una activada SOLO por su clave `expect`).
  if (e.counts && e.counts.videos !== undefined) eq(f.counts.videos, e.counts.videos, 'videos');
  if (e.applicationActivitiesMin !== undefined) assert((f.counts.applicationActivities || 0) >= e.applicationActivitiesMin, `AA ${f.counts.applicationActivities || 0} < ${e.applicationActivitiesMin}`);
  if (e.manifestTypes) {
    const byType = {};
    for (const it of manifest.items) byType[it.type] = (byType[it.type] || 0) + 1;
    eq(Object.fromEntries(Object.entries(byType).sort()), Object.fromEntries(Object.entries(e.manifestTypes).sort()), 'tipos de items del Manifest (lista blanca)');
  }
  if (e.grading) {
    eq(!!resolved.withoutGrades, e.grading.withoutGrades, 'curso sin nota (withoutGrades)');
    eq(resolved.courseCompletion.requireCourseGradePass === true, e.grading.courseGradeCriterion, 'criterio de nota del curso');
    eq(insp.badges > 0, e.grading.badge, 'insignia');
  }
  const relations = assertRelations(sim, insp);
  const quality = S.qualityReportOf(distRoot, sim);
  eq(quality.counts.BLOCKER, 0, `informe de calidad sin BLOCKER en un curso limpio (${JSON.stringify(quality.findings.filter((x) => x.severity === 'BLOCKER').slice(0, 3))})`);
  assert(!quality.blocksDelivery, 'informe de calidad: la entrega no se bloquea');
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
    relations, quality: { counts: quality.counts, codes: [...new Set(quality.findings.map((x) => `${x.severity}:${x.code}`))].sort() }, badges: insp.badges, withoutGrades: !!resolved.withoutGrades,
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
      ['1x1-sin-examenes', { manifestTypes: { course_plan: 1, exam: 1 } }, /lista blanca/],
      ['1x1-sin-nota', { grading: { withoutGrades: false, courseGradeCriterion: true, badge: false } }, /withoutGrades/],
      ['practico-32', { counts: { videos: 3 } }, /videos/],
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
    // r58 (I6): las relaciones también muerden (un gap sin hallazgo; un capítulo sin preguntas en el banco).
    const rel = sims['A-S'] || sims[Object.keys(sims)[0]];
    const insp = await S.inspectMbz(rel.built.mbz);
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const facts = clone(rel.built.expectations.facts);
    facts.hoursReport.findings = facts.hoursReport.findings.filter((x) => x.code !== 'HOURS_TARGET_GAP');
    facts.hoursReport.gap.within = false;
    let err = null;
    try { assertRelations({ ...rel, built: { ...rel.built, expectations: { ...rel.built.expectations, facts } } }, insp); } catch (e) { err = e; }
    assert(err && /HOURS_TARGET_GAP/.test(err.message), `gap sin hallazgo debía fallar (${err ? err.message : 'no falló'})`);
    const m0 = rel.manifest.modules.find((m) => m.examEnabled);
    if (m0 && rel.input.contents.examBanks && rel.input.contents.examBanks.get(m0.moduleId)) {
      const banks = new Map(rel.input.contents.examBanks);
      const ch0 = m0.chapters.find((c) => c.kind !== 'practice').chapterId;
      banks.set(m0.moduleId, { ...banks.get(m0.moduleId), questions: banks.get(m0.moduleId).questions.filter((q) => q.chapterId !== ch0) });
      err = null;
      try { assertRelations({ ...rel, input: { ...rel.input, contents: { ...rel.input.contents, examBanks: banks } } }, insp); } catch (e) { err = e; }
      assert(err && /no evalúa el capítulo/.test(err.message), `capítulo sin preguntas debía fallar (${err ? err.message : 'no falló'})`);
    }
  });

  // ── CS8 (r58 I6) ───────────────────────────────────────────────────────────
  const seedId = ['practico-32', 'mixto-96', 'ofimatica'].find((id) => sims[id]);
  if (seedId) {
    await check(`CS8 defectos sembrados en [${seedId}] → el informe de calidad los detecta (conteo, archivo inexistente, ventana numérica, cierre prematuro; .mbz corrupto → BLOCKER)`, async () => {
      const sim = sims[seedId];
      const base = S.qualityReportOf(distRoot, sim);
      const codes = (r) => new Set(r.findings.map((x) => x.code));
      const before = codes(base);
      const c = sim.input.contents;
      const contentIds = sim.manifest.modules.flatMap((m) => m.chapters.filter((x) => x.kind !== 'practice').map((x) => x.chapterId));
      const [c1, c2] = contentIds;
      const contentMd = new Map(c.contentMd);
      contentMd.set(c1, `${contentMd.get(c1)}\n\nLos cinco pasos del procedimiento son:\n- Preparar el área.\n- Verificar el equipo.\n\nEl reporte del incidente se entrega como máximo en 24 horas.`);
      contentMd.set(c2, `${contentMd.get(c2)}\n\nEl reporte del incidente se entrega como máximo en 72 horas.\n\nHas recorrido todo el curso y ya dominas el método.`);
      const applications = new Map(c.applications);
      const aaId = [...applications.keys()][0];
      assert(aaId, 'el curso sembrado necesita una AA');
      const aa = JSON.parse(JSON.stringify(applications.get(aaId)));
      aa.activity.instructions = `${aa.activity.instructions || ''} Abre plantilla_inexistente.xlsx y completa la tabla.`;
      applications.set(aaId, aa);
      const seeded = S.qualityReportOf(distRoot, sim, { contents: { ...c, contentMd, applications } });
      const want = { COUNT_CLAIM_MISMATCH: 'MINOR', PRACTICE_FILE_REFERENCE_UNKNOWN: 'MAJOR', NUMERIC_WINDOW_CONFLICT: 'MAJOR', PREMATURE_COURSE_CLOSURE: 'MINOR' };
      for (const [code, sev] of Object.entries(want)) {
        const hit = seeded.findings.filter((x) => x.code === code);
        assert(hit.length >= 1 && hit.every((x) => x.severity === sev), `${code}: ${JSON.stringify(hit.slice(0, 2))}`);
        assert(!before.has(code), `${code} ya estaba en el curso limpio (la siembra no prueba nada)`);
      }
      eq(seeded.counts.BLOCKER, 0, 'defectos de contenido: no bloquean (revisión humana)');
      assert(seeded.requiresHumanResolution, 'MAJOR ⇒ requiere resolución humana');
      // .mbz corrupto: falta el blob de un archivo declarado en files.xml → validateMbzV3 lo detecta → BLOCKER.
      const JSZip = require('jszip');
      const z = await JSZip.loadAsync(sim.built.mbz);
      const blob = Object.keys(z.files).find((n) => /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(n));
      z.remove(blob);
      const broken = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      const vb = await require(path.join(distRoot, 'package/v3/mbz-validator-v3.js')).validateMbzV3(broken, sim.built.expectations);
      assert(!vb.ok && vb.issues.length > 0, 'el validador no detectó el blob faltante');
      const rb = S.qualityReportOf(distRoot, sim, { mbzIssues: vb.issues });
      assert(rb.blocksDelivery && rb.counts.BLOCKER >= 1, `BLOCKER con el .mbz corrupto: ${JSON.stringify(rb.counts)}`);
      results._seeded = { course: seedId, clean: base.counts, seeded: seeded.counts, corruptMbz: { issues: vb.issues.slice(0, 3).map((i) => i.code), counts: rb.counts } };
    });
  }

  // ── CS9 (r58 I6) ───────────────────────────────────────────────────────────
  // Curso mixto (capítulos con video necesario y opcional): la prioridad solo mueve los opcionales.
  const avBase = CONFIG.courses.find((c) => c.id === 'A-S');
  if (avBase && (!only.length || only.includes('A-S'))) {
    await check('CS9 composición por necesidad: la MISMA estructura con prioridad audiovisual menos ≤ recomendado ≤ más; los videos necesarios se mantienen siempre; «más» = todos los capítulos de contenido; Prebrief = Manifest', async () => {
      const counts = {};
      for (const av of ['less', 'recommended', 'more']) {
        const cfg = JSON.parse(JSON.stringify(avBase));
        cfg.pedagogy.designPreferences = { ...(cfg.pedagogy.designPreferences || {}), audiovisual: av };
        const p = await S.prepareCourse(distRoot, cfg);
        const content = p.manifest.modules.flatMap((m) => m.chapters.filter((c) => c.kind !== 'practice'));
        const need = p.dryRun.distribution.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content' && c.videoDecision && /^vid\.need\./.test(c.videoDecision.ruleId))).length;
        counts[av] = { videos: p.manifest.totals.videoCount, content: content.length, prebrief: p.prebrief.resources.videos, need };
        assert(counts[av].videos >= need, `${av}: ${counts[av].videos} videos < ${need} necesarios`);
        eq(counts[av].prebrief, counts[av].videos, `${av}: Prebrief = Manifest`);
      }
      assert(counts.less.videos <= counts.recommended.videos && counts.recommended.videos <= counts.more.videos, `no monótono: ${JSON.stringify(counts)}`);
      assert(counts.less.videos < counts.more.videos, `la prioridad no cambia nada: ${JSON.stringify(counts)}`);
      eq(counts.more.videos, counts.more.content, '«más»: un video por capítulo de contenido');
      results._audiovisual = counts;
    });
  }

  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v && v.id ? { ...v, providers: undefined } : v]));
  fs.writeFileSync(path.join(OUT, 'commercial-simulation-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${passed} ok, ${failed} fallos (evidencia: ${path.join(OUT, 'commercial-simulation-summary.json')})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
