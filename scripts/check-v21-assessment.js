#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R6: check PURO (sin DB, sin Moodle) de src/package/assessment.
//
// Requiere el módulo COMPILADO (dist/), igual que el resto de scripts/check-*.js:
//   npm run build && node scripts/check-v21-assessment.js
//
// Cubre: resolución del perfil (overrides, intentos, métodos, pesos, política
// de completion), validación de pesos, XML bien formado (parser mínimo propio
// + xmllint si está disponible), forma idéntica a los backups reales de Moodle
// 4.5 hechos en R0 (fixtures en scripts/fixtures/v21-r0-moodle45/) y salida
// determinista.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const modPath = path.resolve(process.cwd(), process.argv[2] || 'dist/package/assessment/index.js');
const profilesPath = path.resolve(process.cwd(), 'dist/modules/course-profiles/course-profiles.js');
let A, P;
try {
  A = require(modPath);
  P = require(profilesPath);
} catch (err) {
  console.error(`❌ No se pudo cargar el módulo compilado (${modPath})`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

const FIX = path.resolve(__dirname, 'fixtures/v21-r0-moodle45');

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'distinto'}: esperado ${e}, recibido ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'condición falsa');
}
function throws(fn, re, msg) {
  try {
    fn();
  } catch (err) {
    if (re && !re.test(String(err && err.message))) {
      throw new Error(`${msg || 'lanzó otro error'}: ${err.message}`);
    }
    return;
  }
  throw new Error(`${msg || 'no lanzó'} (se esperaba ${re})`);
}

// ── XML: parser mínimo de buena formación ─────────────────────────────────
function wellFormed(xml) {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) throw new Error('falta la declaración XML');
  let body = xml.replace(/^<\?xml[^?]*\?>/, '');
  const stack = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const checkText = (t) => {
    if (/[<>]/.test(t)) throw new Error(`texto con < o > sin escapar: ${JSON.stringify(t.slice(0, 60))}`);
    const amp = t.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
    if (amp) throw new Error(`& sin escapar: ${JSON.stringify(t.slice(0, 60))}`);
  };
  while ((m = re.exec(body))) {
    checkText(body.slice(last, m.index));
    last = re.lastIndex;
    const [, close, name, , self] = m;
    if (close) {
      const top = stack.pop();
      if (top !== name) throw new Error(`cierre </${name}> no coincide con <${top}>`);
    } else if (!self) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) roots += 1;
  }
  const tail = body.slice(last);
  if (tail.trim()) throw new Error(`texto después de la raíz: ${JSON.stringify(tail.slice(0, 40))}`);
  if (stack.length) throw new Error(`sin cerrar: ${stack.join(' > ')}`);
  if (roots !== 1) throw new Error(`se esperaba 1 elemento raíz, hay ${roots}`);
  return true;
}
let xmllintAvailable = false;
try {
  execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
  xmllintAvailable = true;
} catch (_) { /* opcional */ }
function xmllint(xml) {
  if (!xmllintAvailable) return;
  execFileSync('xmllint', ['--noout', '-'], { input: xml, stdio: ['pipe', 'ignore', 'pipe'] });
}
function assertXml(xml) {
  wellFormed(xml);
  xmllint(xml);
}
/** Secuencia de nombres de elementos abiertos (orden de documento), sin el contenido de grade_grades. */
function tagSeq(xml) {
  const s = xml.replace(/<grade_grades>[\s\S]*?<\/grade_grades>/g, '<grade_grades></grade_grades>')
    .replace(/<course_completion_crit_completions>[\s\S]*?<\/course_completion_crit_completions>/g,
      '<course_completion_crit_completions></course_completion_crit_completions>');
  const out = [];
  const re = /<([A-Za-z_][\w.-]*)[\s>\/]/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}(?: [^>]*)?>[\\s\\S]*?</${tag}>`, 'g');
  return xml.match(re) || [];
}
function val(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : undefined;
}
function fixture(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

const TS = 1790000000;
const BV = '2024100700';
const defFinal = () => P.defaultAssessmentProfile({ finalExam: true });
const defNoFinal = () => P.defaultAssessmentProfile({ finalExam: false });

// ── Exports ────────────────────────────────────────────────────────────────
check('exporta la API pública', () => {
  for (const n of ['resolveAssessment', 'categoryForItem', 'categoryKeyForItem', 'assertCategoriesPopulated',
    'completionCriteriaFor', 'gradedModuleXml', 'gradeItemXml', 'gradebookXml', 'courseCompletionXml',
    'quizAttemptsXmlFields', 'scormAssessmentFields', 'h5pactivityXml', 'h5pDisplayOptionsInt', 'applyXmlFields']) {
    ok(typeof A[n] === 'function', `falta ${n}`);
  }
  eq(A.ASSESSMENT_CATEGORY_NAMES, { practice: 'Práctica de capítulos', moduleExams: 'Evaluaciones de módulo', finalExam: 'Evaluación final' });
});

// ── resolveAssessment ─────────────────────────────────────────────────────
check('resolve: defaults con examen final → 70 en todo, 30/50/20, intentos 0/0/3/3, highest', () => {
  const r = A.resolveAssessment(defFinal(), { hasFinalExam: true });
  eq(r.courseGradepass, 70);
  eq(Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, v.passingGrade])), { activity: 70, video: 70, exam: 70, finalExam: 70 });
  eq(Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, v.attempts])), { activity: 0, video: 0, exam: 3, finalExam: 3 });
  eq(Object.values(r.kinds).map((k) => k.gradeMethod), ['highest', 'highest', 'highest', 'highest']);
  eq(r.categories, [
    { key: 'practice', fullname: 'Práctica de capítulos', weight: 30 },
    { key: 'moduleExams', fullname: 'Evaluaciones de módulo', weight: 50 },
    { key: 'finalExam', fullname: 'Evaluación final', weight: 20 },
  ]);
  eq(r.courseCompletion, { requireAllChapterActivities: true, requireExams: true, requireCourseGradePass: false, courseGradepass: 70, aggregation: 'all' });
});
check('resolve: defaults sin examen final → 40/60', () => {
  const r = A.resolveAssessment(defNoFinal(), { hasFinalExam: false });
  eq(r.categories.map((c) => [c.key, c.weight]), [['practice', 40], ['moduleExams', 60]]);
  eq(r.hasFinalExam, false);
});
check('resolve: override ?? passingGrade por tipo', () => {
  const p = defFinal();
  p.passingGrade = 60;
  p.overrides = { activity: null, video: 50, exam: 80, finalExam: 0 };
  const r = A.resolveAssessment(p, { hasFinalExam: true });
  eq(Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, v.passingGrade])), { activity: 60, video: 50, exam: 80, finalExam: 0 });
  eq(r.courseGradepass, 60, 'el curso usa el passingGrade base, no overrides');
  eq(r.courseCompletion.courseGradepass, 60);
});
check('resolve: intentos y métodos por tipo', () => {
  const p = defFinal();
  p.attempts = { activity: 2, video: 0, exam: 1, finalExam: 5 };
  p.gradeMethod = { activity: 'last', video: 'average', exam: 'first', finalExam: 'average' };
  const r = A.resolveAssessment(p, { hasFinalExam: true, activityEngine: 'scorm' });
  eq(Object.values(r.kinds).map((k) => [k.attempts, k.gradeMethod, k.category]), [
    [2, 'last', 'practice'], [0, 'average', 'practice'], [1, 'first', 'moduleExams'], [5, 'average', 'finalExam']]);
});
check('resolve: pesos de examen final con curso sin final → WEIGHTS_FINAL_EXAM_MISMATCH', () => {
  throws(() => A.resolveAssessment(defFinal(), { hasFinalExam: false }), /ASSESSMENT_PROFILE_INVALID.*WEIGHTS_FINAL_EXAM_MISMATCH/);
  throws(() => A.resolveAssessment(defNoFinal(), { hasFinalExam: true }), /WEIGHTS_FINAL_EXAM_MISMATCH/);
});
check('resolve: pesos que no suman 100 → WEIGHTS_SUM_NOT_100', () => {
  const p = defFinal();
  p.categoryWeights = { practice: 30, moduleExams: 50, finalExam: 30 };
  throws(() => A.resolveAssessment(p, { hasFinalExam: true }), /WEIGHTS_SUM_NOT_100/);
  const q = defNoFinal();
  q.categoryWeights = { practice: 40, moduleExams: 59 };
  throws(() => A.resolveAssessment(q, { hasFinalExam: false }), /WEIGHTS_SUM_NOT_100/);
});
check('resolve: pesos configurables válidos (0/100, 10/20/70)', () => {
  const p = defNoFinal();
  p.categoryWeights = { practice: 0, moduleExams: 100 };
  eq(A.resolveAssessment(p, { hasFinalExam: false }).categories.map((c) => c.weight), [0, 100]);
  const q = defFinal();
  q.categoryWeights = { practice: 10, moduleExams: 20, finalExam: 70 };
  eq(A.resolveAssessment(q, { hasFinalExam: true }).categories.map((c) => c.weight), [10, 20, 70]);
});
check('resolve: perfil inválido o facts inválidos fallan fuerte', () => {
  const p = defFinal();
  p.passingGrade = 101;
  throws(() => A.resolveAssessment(p, { hasFinalExam: true }), /INVALID_PASSING_GRADE/);
  const q = defFinal();
  q.overrides.exam = 'x';
  throws(() => A.resolveAssessment(q, { hasFinalExam: true }), /INVALID_OVERRIDE/);
  throws(() => A.resolveAssessment(defFinal(), {}), /ASSESSMENT_INVALID_FACTS/);
  throws(() => A.resolveAssessment(defFinal(), { hasFinalExam: true, activityEngine: 'hvp' }), /ASSESSMENT_INVALID_FACTS/);
  const extra = defFinal();
  extra.videoGraded = true;
  throws(() => A.resolveAssessment(extra, { hasFinalExam: true }), /UNKNOWN_FIELD/);
});
check('resolve: intentos no aplicables en h5pactivity → ASSESSMENT_UNENFORCEABLE', () => {
  const p = defFinal();
  p.attempts.video = 2;
  throws(() => A.resolveAssessment(p, { hasFinalExam: true }), /ASSESSMENT_UNENFORCEABLE.*attempts\.video/);
  const q = defFinal();
  q.attempts.activity = 3;
  throws(() => A.resolveAssessment(q, { hasFinalExam: true, activityEngine: 'h5p' }), /ASSESSMENT_UNENFORCEABLE.*attempts\.activity/);
  eq(A.resolveAssessment(q, { hasFinalExam: true, activityEngine: 'scorm' }).kinds.activity.attempts, 3);
});
check('resolve: determinista y no muta el perfil', () => {
  const p = defFinal();
  const before = JSON.stringify(p);
  const a = JSON.stringify(A.resolveAssessment(p, { hasFinalExam: true }));
  const b = JSON.stringify(A.resolveAssessment(JSON.parse(before), { hasFinalExam: true }));
  eq(a, b);
  eq(JSON.stringify(p), before, 'el perfil fue mutado');
});
check('categoryForItem: nombres fijos en español', () => {
  eq(['activity', 'video', 'exam', 'finalExam'].map(A.categoryForItem),
    ['Práctica de capítulos', 'Práctica de capítulos', 'Evaluaciones de módulo', 'Evaluación final']);
  throws(() => A.categoryForItem('forum'), /ASSESSMENT_UNKNOWN_KIND/);
});
check('assertCategoriesPopulated: categoría con peso y sin ítems falla fuerte', () => {
  const r = A.resolveAssessment(defFinal(), { hasFinalExam: true });
  A.assertCategoriesPopulated(r, { practice: 2, moduleExams: 1, finalExam: 1 });
  throws(() => A.assertCategoriesPopulated(r, { practice: 0, moduleExams: 1, finalExam: 1 }), /ASSESSMENT_EMPTY_WEIGHTED_CATEGORY: practice/);
  const p = defNoFinal();
  p.categoryWeights = { practice: 0, moduleExams: 100 };
  A.assertCategoriesPopulated(A.resolveAssessment(p, { hasFinalExam: false }), { moduleExams: 1 });
});
check('completionCriteriaFor: según requireAllChapterActivities / requireExams', () => {
  const items = [
    { moduleId: 11, modname: 'scorm', kind: 'activity' },
    { moduleId: 12, modname: 'h5pactivity', kind: 'video' },
    { moduleId: 13, modname: 'quiz', kind: 'exam' },
    { moduleId: 14, modname: 'quiz', kind: 'finalExam' },
  ];
  const base = { requireAllChapterActivities: true, requireExams: true, requireCourseGradePass: false, courseGradepass: 70, aggregation: 'all' };
  eq(A.completionCriteriaFor(items, base).map((c) => c.moduleId), [11, 12, 13, 14]);
  eq(A.completionCriteriaFor(items, { ...base, requireExams: false }).map((c) => c.moduleId), [11, 12]);
  eq(A.completionCriteriaFor(items, { ...base, requireAllChapterActivities: false }).map((c) => c.moduleId), [13, 14]);
  throws(() => A.completionCriteriaFor([{ moduleId: 1, modname: 'quiz', kind: 'x' }], base), /UNKNOWN_KIND/);
});

// ── module.xml ────────────────────────────────────────────────────────────
const modXml = (modname) => A.gradedModuleXml({ mid: 4602, modname, secnum: 1, ts: TS, bv: BV, passGradeRequired: true });
check('gradedModuleXml: completion=2, gradeitemnumber=0, passgrade=1, view=0, showdescription=1', () => {
  for (const m of ['quiz', 'scorm', 'h5pactivity']) {
    const x = modXml(m);
    assertXml(x);
    eq([val(x, 'modulename'), val(x, 'completion'), val(x, 'completiongradeitemnumber'), val(x, 'completionpassgrade'), val(x, 'completionview'), val(x, 'showdescription')],
      [m, '2', '0', '1', '0', '1']);
  }
  eq(val(A.gradedModuleXml({ mid: 1, modname: 'quiz', secnum: 2, ts: TS, bv: BV, passGradeRequired: false }), 'completionpassgrade'), '0');
});
check('gradedModuleXml: misma forma que module.xml real de R0 (scorm y h5pactivity)', () => {
  eq(tagSeq(modXml('scorm')), tagSeq(fixture('bk3-scorm-module.xml')));
  eq(tagSeq(modXml('h5pactivity')), tagSeq(fixture('bk-h5pactivity-module.xml')));
  const r0 = fixture('bk3-scorm-module.xml');
  for (const t of ['completion', 'completiongradeitemnumber', 'completionpassgrade', 'completionview']) eq(val(modXml('scorm'), t), val(r0, t), t);
});
check('gradedModuleXml: entradas inválidas fallan fuerte', () => {
  throws(() => A.gradedModuleXml({ mid: 1, modname: 'label', secnum: 1, ts: TS, bv: BV, passGradeRequired: true }), /no calificable/);
  throws(() => A.gradedModuleXml({ mid: 0, modname: 'quiz', secnum: 1, ts: TS, bv: BV, passGradeRequired: true }), /mid/);
  throws(() => A.gradedModuleXml({ mid: 1, modname: 'quiz', secnum: 1, ts: TS, bv: '4.5', passGradeRequired: true }), /bv/);
  throws(() => A.gradedModuleXml({ mid: 1, modname: 'quiz', secnum: 1, ts: TS, bv: BV }), /passGradeRequired/);
});

// ── grades.xml ────────────────────────────────────────────────────────────
const giXml = (gp) => A.gradeItemXml({ gradeItemId: 1269, itemName: 'R0 SCORM & <cía>', itemModule: 'scorm', aid: 900, ts: TS, grademax: 100, gradepass: gp, categoryId: 127, sortorder: 2 });
check('gradeItemXml: categoryid, grademax 100, grademin 0, gradepass efectivo, nombre escapado', () => {
  const x = giXml(70);
  assertXml(x);
  eq([val(x, 'categoryid'), val(x, 'grademax'), val(x, 'grademin'), val(x, 'gradepass'), val(x, 'itemmodule'), val(x, 'iteminstance'), val(x, 'itemname')],
    ['127', '100.00000', '0.00000', '70.00000', 'scorm', '900', 'R0 SCORM &amp; &lt;cía&gt;']);
  eq(val(giXml(62.5), 'gradepass'), '62.50000');
});
check('gradeItemXml: misma forma que grades.xml real de R0', () => {
  eq(tagSeq(giXml(70)), tagSeq(fixture('bk3-scorm-grades.xml')));
});
check('gradeItemXml: grademax≠100, gradepass fuera de rango o categoría ausente fallan', () => {
  const base = { gradeItemId: 1, itemName: 'x', itemModule: 'quiz', aid: 1, ts: TS, grademax: 100, gradepass: 70, categoryId: 2 };
  throws(() => A.gradeItemXml({ ...base, grademax: 10 }), /grademax/);
  throws(() => A.gradeItemXml({ ...base, gradepass: 101 }), /gradepass/);
  throws(() => A.gradeItemXml({ ...base, categoryId: undefined }), /categoryId/);
  throws(() => A.gradeItemXml({ ...base, itemModule: 'url' }), /itemModule/);
});

// ── gradebook.xml ─────────────────────────────────────────────────────────
const gbInput = (weights, gp = 70) => ({
  ts: TS, courseGradepass: gp, aggregation: 'weighted_mean', courseCategoryId: 1, courseItemId: 1,
  categories: weights.map((w, i) => ({ id: 2 + i, fullname: ['Práctica de capítulos', 'Evaluaciones de módulo', 'Evaluación final'][i], weight: w, gradeItemId: 2 + i })),
});
check('gradebookXml: curso media ponderada (10), hijas con media (0), gradepass del curso, pesos en aggregationcoef', () => {
  const x = A.gradebookXml(gbInput([30, 50, 20]));
  assertXml(x);
  const cats = blocks(x, 'grade_category');
  eq(cats.length, 4);
  const byId = Object.fromEntries(cats.map((c) => [c.match(/id="(\d+)"/)[1], c]));
  eq([val(byId['1'], 'parent'), val(byId['1'], 'depth'), val(byId['1'], 'path'), val(byId['1'], 'aggregation')], ['$@NULL@$', '1', '/1/', '10']);
  for (const id of ['2', '3', '4']) {
    eq([val(byId[id], 'parent'), val(byId[id], 'depth'), val(byId[id], 'path'), val(byId[id], 'aggregation'), val(byId[id], 'aggregateonlygraded')],
      ['1', '2', `/1/${id}/`, '0', '0']);
  }
  eq(cats.map((c) => val(c, 'fullname')), ['Práctica de capítulos', 'Evaluaciones de módulo', 'Evaluación final', '?']);
  const items = blocks(x, 'grade_item');
  const course = items.find((i) => val(i, 'itemtype') === 'course');
  eq([val(course, 'iteminstance'), val(course, 'gradepass'), val(course, 'grademax')], ['1', '70.00000', '100.00000']);
  const catItems = items.filter((i) => val(i, 'itemtype') === 'category');
  eq(catItems.map((i) => [val(i, 'iteminstance'), val(i, 'aggregationcoef')]), [['2', '30.00000'], ['3', '50.00000'], ['4', '20.00000']]);
});
check('gradebookXml: ids consistentes con los categoryid de los grades.xml', () => {
  const x = A.gradebookXml(gbInput([40, 60], 80));
  const catIds = blocks(x, 'grade_category').map((c) => c.match(/id="(\d+)"/)[1]);
  const g = A.gradeItemXml({ gradeItemId: 50, itemName: 'Q', itemModule: 'quiz', aid: 5, ts: TS, grademax: 100, gradepass: 80, categoryId: 3 });
  ok(catIds.includes(val(g, 'categoryid')), 'categoryid del ítem no existe en gradebook.xml');
  const itemIds = blocks(x, 'grade_item').map((c) => c.match(/id="(\d+)"/)[1]);
  eq(new Set(itemIds).size, itemIds.length, 'ids de grade_item repetidos');
});
check('gradebookXml: misma forma que gradebook.xml real de R0 (categoría e ítems)', () => {
  const x = A.gradebookXml(gbInput([30, 50, 20]));
  const r0 = fixture('bk3-gradebook.xml');
  const r0Cat = tagSeq(blocks(r0, 'grade_category')[0]);
  for (const c of blocks(x, 'grade_category')) eq(tagSeq(c), r0Cat, 'grade_category');
  const r0Item = tagSeq(blocks(r0, 'grade_item')[0]);
  for (const i of blocks(x, 'grade_item')) eq(tagSeq(i), r0Item, 'grade_item');
  eq(tagSeq(x.replace(/<grade_categories>[\s\S]*<\/grade_items>/, '')), tagSeq(r0.replace(/<grade_categories>[\s\S]*<\/grade_items>/, '')), 'envoltorio');
});
check('gradebookXml: pesos ≠ 100, ids repetidos o agregación no soportada fallan', () => {
  throws(() => A.gradebookXml(gbInput([30, 50, 30])), /WEIGHTS_SUM_NOT_100/);
  const dup = gbInput([40, 60]);
  dup.categories[1].id = 2;
  throws(() => A.gradebookXml(dup), /repetido/);
  const dupItem = gbInput([40, 60]);
  dupItem.categories[0].gradeItemId = 1;
  throws(() => A.gradebookXml(dupItem), /repetido/);
  throws(() => A.gradebookXml({ ...gbInput([40, 60]), aggregation: 'natural' }), /weighted_mean/);
  throws(() => A.gradebookXml({ ...gbInput([40, 60]), categories: [] }), /vacío/);
});

// ── completion.xml ────────────────────────────────────────────────────────
check('courseCompletionXml: criterios de actividad + criterio de nota + agregación ALL', () => {
  const x = A.courseCompletionXml({ criteria: [{ moduleId: 4602, modname: 'scorm' }, { moduleId: 4603, modname: 'quiz' }], aggregation: 'all', requireCourseGradePass: true, courseGradepass: 70 });
  assertXml(x);
  const crit = blocks(x, 'course_completion_criteria');
  eq(crit.map((c) => [val(c, 'criteriatype'), val(c, 'module'), val(c, 'moduleinstance'), val(c, 'gradepass')]), [
    ['4', 'scorm', '4602', '$@NULL@$'], ['4', 'quiz', '4603', '$@NULL@$'], ['6', '$@NULL@$', '$@NULL@$', '70.00000']]);
  const ag = blocks(x, 'course_completion_aggr_methd');
  eq(ag.map((a) => [val(a, 'criteriatype'), val(a, 'method')]), [['$@NULL@$', '1']]);
  eq(crit.map((c) => c.match(/id="(\d+)"/)[1]), ['1', '2', '3']);
});
check('courseCompletionXml: misma forma que completion.xml real de R0', () => {
  const x = A.courseCompletionXml({ criteria: [{ moduleId: 4602, modname: 'scorm' }], aggregation: 'all', requireCourseGradePass: false, courseGradepass: 70 });
  eq(tagSeq(x), tagSeq(fixture('bk3-completion.xml')));
});
check('courseCompletionXml: sin criterios → course_completion vacío; entradas inválidas fallan', () => {
  const x = A.courseCompletionXml({ criteria: [], aggregation: 'all', requireCourseGradePass: false, courseGradepass: 70 });
  assertXml(x);
  eq(blocks(x, 'course_completion_criteria').length, 0);
  throws(() => A.courseCompletionXml({ criteria: [{ moduleId: 1, modname: 'quiz' }, { moduleId: 1, modname: 'quiz' }], aggregation: 'all', requireCourseGradePass: false, courseGradepass: 70 }), /repetido/);
  throws(() => A.courseCompletionXml({ criteria: [], aggregation: 'any', requireCourseGradePass: false, courseGradepass: 70 }), /aggregation/);
});

// ── quiz / scorm / h5pactivity ────────────────────────────────────────────
const SAMPLE_QUIZ = '<?xml version="1.0" encoding="UTF-8"?>\n<activity><quiz id="1"><preferredbehaviour>deferredfeedback</preferredbehaviour><attempts_number>0</attempts_number><attemptonlast>0</attemptonlast><grademethod>1</grademethod><sumgrades>100.00000</sumgrades><grade>100.00000</grade><feedbacks><feedback id="1"><maxgrade>101.00000</maxgrade></feedback></feedbacks></quiz></activity>';
check('quizAttemptsXmlFields: attempts_number, grademethod (constantes de mod/quiz), sumgrades/grade 100', () => {
  eq(A.quizAttemptsXmlFields({ attempts: 3, grademethod: 'highest' }), { preferredbehaviour: 'deferredfeedback', attempts_number: '3', grademethod: '1', sumgrades: '100.00000', grade: '100.00000' });
  eq(['highest', 'average', 'first', 'last'].map((m) => A.quizAttemptsXmlFields({ attempts: 0, grademethod: m }).grademethod), ['1', '2', '3', '4']);
  const x = A.applyXmlFields(SAMPLE_QUIZ, A.quizAttemptsXmlFields({ attempts: 2, grademethod: 'average' }));
  assertXml(x);
  eq([val(x, 'attempts_number'), val(x, 'grademethod'), val(x, 'maxgrade')], ['2', '2', '101.00000']);
  throws(() => A.quizAttemptsXmlFields({ attempts: -1, grademethod: 'highest' }), /attempts/);
  throws(() => A.quizAttemptsXmlFields({ attempts: 1, grademethod: 'best' }), /grademethod/);
});
check('applyXmlFields: campo ausente o repetido falla fuerte', () => {
  throws(() => A.applyXmlFields('<a><b>1</b></a>', { c: '2' }), /ASSESSMENT_XML_FIELD_NOT_FOUND/);
  throws(() => A.applyXmlFields('<a><b>1</b><b>2</b></a>', { b: '3' }), /2 veces/);
  eq(A.applyXmlFields('<a><b>1</b></a>', { b: '$@NULL@$' }), '<a><b>$@NULL@$</b></a>', 'no interpreta $ como patrón');
});
check('scormAssessmentFields: whatgrade por método, maxattempt, masteryoverride, sin condición de estado', () => {
  const f = A.scormAssessmentFields({ maxgrade: 100, grademethod: 'highest', whatgrade: 'last', maxattempt: 0, masteryoverride: 1 });
  eq(f, { maxgrade: '100', grademethod: '1', whatgrade: '3', maxattempt: '0', masteryoverride: '1', completionstatusrequired: '$@NULL@$', completionscorerequired: '$@NULL@$' });
  eq(['highest', 'average', 'first', 'last'].map((m) => A.scormAssessmentFields({ maxgrade: 100, grademethod: 'highest', whatgrade: m, maxattempt: 2, masteryoverride: 1 }).whatgrade), ['0', '1', '2', '3']);
  throws(() => A.scormAssessmentFields({ maxgrade: 10, grademethod: 'highest', whatgrade: 'last', maxattempt: 0, masteryoverride: 1 }), /maxgrade/);
});
const h5pX = (over = {}) => A.h5pactivityXml({ aid: 1, mid: 4575, ctx: 4707, name: 'QS & video', intro: '<p>Hola</p>', grade: 100, grademethod: 'highest', enabletracking: 1, reviewmode: 1, displayoptions: { frame: false, download: false, embed: false, copyright: false }, ts: TS, ...over });
check('h5pactivityXml: grade 100, grademethod, tracking, reviewmode, displayoptions; forma de R0', () => {
  const x = h5pX();
  assertXml(x);
  eq([val(x, 'grade'), val(x, 'grademethod'), val(x, 'enabletracking'), val(x, 'reviewmode'), val(x, 'displayoptions'), val(x, 'intro'), val(x, 'name')],
    ['100', '1', '1', '1', '15', '&lt;p&gt;Hola&lt;/p&gt;', 'QS &amp; video']);
  eq(tagSeq(x), tagSeq(fixture('bk-h5pactivity.xml')));
  eq(['highest', 'average', 'last', 'first'].map((m) => val(h5pX({ grademethod: m }), 'grademethod')), ['1', '2', '3', '4']);
});
check('h5pDisplayOptionsInt: bitmask de lo desactivado (frame forzado si hay otros)', () => {
  eq(A.h5pDisplayOptionsInt({ frame: false, download: false, embed: false, copyright: false }), 15);
  eq(A.h5pDisplayOptionsInt({ frame: true, download: true, embed: true, copyright: true }), 0);
  eq(A.h5pDisplayOptionsInt({ frame: false, download: false, embed: true, copyright: false }), 10);
  eq(A.h5pDisplayOptionsInt({ frame: true, download: false, embed: false, copyright: false }), 14);
  throws(() => A.h5pDisplayOptionsInt({ frame: 1, download: false, embed: false, copyright: false }), /frame/);
});
check('h5pactivityXml: grade≠100, tracking≠1 o método desconocido fallan', () => {
  throws(() => h5pX({ grade: 50 }), /grade/);
  throws(() => h5pX({ enabletracking: 0 }), /enabletracking/);
  throws(() => h5pX({ grademethod: 'manual' }), /grademethod/);
});

// ── Determinismo ──────────────────────────────────────────────────────────
check('todos los generadores son deterministas (misma entrada → mismos bytes)', () => {
  const run = () => [
    modXml('quiz'), giXml(70), A.gradebookXml(gbInput([30, 50, 20])),
    A.courseCompletionXml({ criteria: [{ moduleId: 3, modname: 'quiz' }], aggregation: 'all', requireCourseGradePass: true, courseGradepass: 70 }),
    JSON.stringify(A.quizAttemptsXmlFields({ attempts: 3, grademethod: 'highest' })),
    JSON.stringify(A.scormAssessmentFields({ maxgrade: 100, grademethod: 'highest', whatgrade: 'highest', maxattempt: 0, masteryoverride: 1 })),
    h5pX(), JSON.stringify(A.resolveAssessment(defFinal(), { hasFinalExam: true })),
  ].join('\n#\n');
  const a = run();
  const b = run();
  eq(require('crypto').createHash('sha256').update(a).digest('hex'), require('crypto').createHash('sha256').update(b).digest('hex'));
});
check('el parser de buena formación rechaza XML roto (autotest)', () => {
  throws(() => wellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a><b></a>'), /no coincide/);
  throws(() => wellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a>x & y</a>'), /sin escapar/);
  throws(() => wellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a></a><b></b>'), /raíz/);
});

console.log(`\n${passed} ok, ${failures} fallos${xmllintAvailable ? ' (xmllint activo)' : ' (xmllint no disponible: solo parser propio)'}`);
process.exit(failures ? 1 : 0);
