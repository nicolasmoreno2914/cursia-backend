#!/usr/bin/env node
/* eslint-disable no-console */
// T4/T5 (r57) — Actividad de Aplicación como Tarea de Moodle (mod_assign) y archivos de trabajo (mod_resource).
// USD 0: sin red, sin proveedores, sin base. Fixtures genéricos («Curso de ejemplo»).
//
//   D1  perfil: applicationDelivery / practiceResources validados con códigos estables; normalización estable; sin las
//       claves, el perfil normalizado (y su sha) es el de siempre; pesos con `applications` ⇔ categoría propia calificada
//   D2  evaluación resuelta: categoría «Actividades de Aplicación» (id 5) con su peso, ítems = Tareas calificadas;
//       categoría vacía → peso redistribuido (aviso); en práctica → suma a «Práctica de capítulos»; formativa → nada
//   D3  byte a byte: sin las claves = el .mbz de siempre (dorado del build ANTERIOR, GOLDEN_OFF); modo `page` con la
//       clave presente = mismo .mbz que sin la clave
//   D4  Tarea CALIFICADA con rúbrica (categoría propia): assign.xml (texto + archivos, límites, formatos, fecha límite,
//       comentarios de retroalimentación, completionsubmit), grades.xml en la categoría 5 (grademax/gradepass del perfil),
//       grading.xml (rúbrica LISTA con los criterios de la AA, niveles 0 / ⌊p/2⌋ / p), PDF del estudiante en intro,
//       solucionario oculto + prohibido al estudiante, regla de aprobación nombra las AA calificadas; validador en verde
//   D5  Tarea FORMATIVA: sin ítem de nota, grade 0, sin grading.xml; el curso sigue aprobándose por la nota final
//   D6  Tarea calificada en «Práctica de capítulos» (sin categoría nueva) y excepción por capítulo (chapterModes)
//   D7  validador: rúbrica faltante, categoría equivocada, formativa con nota, calificada sin nota, entrega distinta del
//       perfil, solucionario visible, sha de un archivo de trabajo, enlace de la AA al archivo → hallazgos
//   D8  archivos de trabajo: xlsx/docx/pdf subidos + CSV/XLSX generados desde tabla → mod_resource del capítulo, la Tarea
//       los enlaza; generados determinísticos y abribles; sha/tamaño/tipo/firma distintos → falla fuerte; huérfano o
//       sin AA → aviso visible
//   D9  worker: loadPracticeFilesV3 descarga SOLO artifacts practice_file del dueño (owner/type/path)
//   D10 sin red ni proveedores: todo el armado corre con fetch prohibido; FinOps sin cambios (no hay items nuevos)
//
// Uso: node scripts/check-application-deliverables.js [dist]   (después de npm run build)
//      GOLDEN_OFF=<json> para D3 (sha del .mbz del build anterior; ver scripts/fixtures/deliverables/golden-off.json)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const P = L('modules/course-profiles/course-profiles.js');
const AD = L('modules/course-profiles/application-delivery.js');
const A = L('package/assessment/index.js');
const PFILES = L('package/v3/practice-files.js');
const PKG = L('modules/dynamic-packaging/packaging-v3.js');
const MEDIA = L('package/v3/synthetic-media.js');
const PF = require('./lib/v21-packaging-fixtures');
const DF = require('./lib/deliverable-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (errs) => [...new Set(errs.map((e) => e.code))].sort();

async function actsOf(zip) {
  const mb = await zip.file('moodle_backup.xml').async('string');
  const out = [];
  for (const m of mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9_]+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)) {
    const mod = await zip.file(`${m[5]}/module.xml`).async('string');
    out.push({ mid: Number(m[1]), sec: Number(m[2]), mod: m[3], dir: m[5], idnumber: (mod.match(/<idnumber>([^<]*)<\/idnumber>/) || [])[1], moduleXml: mod });
  }
  return out;
}
const tag = (x, t) => ((x || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
async function mutate(mbz, fn) {
  const z = await JSZip.loadAsync(mbz);
  await fn(z);
  return z.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  // ── D1 ──
  await check('D1 perfil: validación con códigos estables, normalización estable, sin claves = perfil de siempre, pesos con «applications» ⇔ categoría propia', async () => {
    const base = P.defaultAssessmentProfile({ finalExam: true });
    eq(P.validateAssessmentProfile(base, { finalExam: true }), [], 'default válido');
    eq(JSON.stringify(P.normalizeAssessmentProfile(base)), JSON.stringify(P.normalizeAssessmentProfile(JSON.parse(JSON.stringify(base)))), 'normalizado estable');
    eq(P.profileSha256(P.normalizeAssessmentProfile(base)), P.profileSha256(base), 'sin las claves: mismo sha');
    const graded = DF.deliveryProfile(base, { graded: true, category: 'applications' });
    eq(P.validateAssessmentProfile(graded, { finalExam: true }), [], 'calificada en categoría propia válida');
    eq(codes(P.validateAssessmentProfile({ ...graded, categoryWeights: base.categoryWeights }, { finalExam: true })), ['WEIGHTS_FINAL_EXAM_MISMATCH'], 'propia sin peso applications');
    const formative = DF.deliveryProfile(base, { graded: false });
    eq(P.validateAssessmentProfile(formative, { finalExam: true }), [], 'formativa válida');
    eq(codes(P.validateAssessmentProfile({ ...formative, categoryWeights: { ...base.categoryWeights, applications: 0 } }, { finalExam: true })), ['WEIGHTS_FINAL_EXAM_MISMATCH'], 'applications sobrante');
    const bad = (mut) => codes(AD.validateApplicationDelivery(mut(JSON.parse(JSON.stringify(graded.applicationDelivery)))));
    eq(bad((d) => { d.submission.onlineText = false; d.submission.file = false; return d; }), ['SUBMISSION_TYPE_REQUIRED'], 'sin tipo de entrega');
    eq(bad((d) => { d.submission.maxFiles = 0; return d; }), ['INVALID_MAX_FILES'], 'maxFiles 0');
    eq(bad((d) => { d.submission.maxBytes = 500 * 1024 * 1024; return d; }), ['INVALID_MAX_BYTES'], 'maxBytes > 100 MB');
    eq(bad((d) => { d.submission.fileTypes = ['.exe']; return d; }), ['INVALID_FILE_TYPES'], 'formato no permitido');
    eq(bad((d) => { d.grading.gradepass = 101; return d; }), ['INVALID_GRADEPASS'], 'gradepass > máx');
    eq(bad((d) => { d.dueOffsetDays = 0; return d; }), ['INVALID_DUE_OFFSET'], 'due 0');
    eq(bad((d) => { d.mode = 'quiz'; return d; }), ['INVALID_DELIVERY_MODE'], 'modo desconocido');
    eq(bad((d) => { d.extra = 1; return d; }), ['UNKNOWN_FIELD'], 'campo extra');
    eq(bad((d) => { d.grading = { graded: false, maxGrade: 10 }; return d; }), ['UNKNOWN_FIELD'], 'formativa con nota');
    const res = (mut) => codes(AD.validatePracticeResources(mut(JSON.parse(JSON.stringify(DF.sampleResources('c1'))))));
    eq(res((l) => l), [], 'recursos válidos');
    eq(res((l) => { l[0].source.filename = 'malware.exe'; return l; }), ['FILE_TYPE_NOT_ALLOWED'], 'extensión no permitida');
    eq(res((l) => { l[2].source.filename = '../x.pdf'; return l; }), ['INVALID_FILENAME'], 'ruta en el nombre');
    eq(res((l) => { l[0].source.mimetype = 'text/plain'; return l; }), ['MIMETYPE_MISMATCH'], 'mimetype distinto');
    eq(res((l) => { l[0].source.bytes = 30 * 1024 * 1024; return l; }), ['FILE_TOO_LARGE'], 'archivo > 20 MB');
    eq(res((l) => { l[1].id = l[0].id; return l; }), ['DUPLICATE_RESOURCE_ID'], 'id repetido');
    eq(res((l) => { l[3].source.rows[0] = ['solo una']; return l; }), ['INVALID_TABLE'], 'tabla inválida');
    const withRes = { ...graded, practiceResources: DF.sampleResources('c1') };
    eq(P.validateAssessmentProfile(withRes, { finalExam: true }), [], 'perfil con recursos válido');
    eq(P.profileSha256(P.normalizeAssessmentProfile(withRes)), P.profileSha256(P.normalizeAssessmentProfile(JSON.parse(JSON.stringify(withRes)))), 'sha estable');
    assert(P.profileSha256(P.normalizeAssessmentProfile(withRes)) !== P.profileSha256(P.normalizeAssessmentProfile(graded)), 'los recursos cambian el sha (clave de reuse)');
  });

  // Cursos fixture (mismo Manifest/Blueprint que Fase 2: 4 AA en 5 capítulos, uno de práctica).
  const course = DF.courseInput(distRoot);
  const appChapterIds = course.manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.key.slice('application_activity:'.length));
  const base = P.defaultAssessmentProfile({ finalExam: true });

  // ── D2 ──
  await check('D2 evaluación resuelta: categoría propia (id 5) con peso; vacía → redistribuida; en práctica → suma; formativa → nada', async () => {
    const m = course.manifest;
    const counts0 = A.assessmentItemCountsForPackage(m, [], base);
    const g = DF.deliveryProfile(base, { graded: true, category: 'applications' });
    const counts = A.assessmentItemCountsForPackage(m, [], g);
    eq(counts.applications, appChapterIds.length, 'ítems de la categoría propia = Tareas calificadas');
    eq(counts.practice, counts0.practice, 'práctica sin cambio');
    const r = A.resolveAssessment(g, { hasFinalExam: true, activityEngine: 'h5p', itemCounts: counts });
    eq(r.categories.map((c) => [c.key, c.fullname, c.weight]), [['practice', 'Práctica de capítulos', 25], ['applications', 'Actividades de Aplicación', 20], ['moduleExams', 'Evaluaciones de módulo', 35], ['finalExam', 'Evaluación final', 20]], 'categorías');
    eq([r.application.graded, r.application.maxGrade, r.application.gradepass, r.application.category, r.application.rubric], [true, 100, 60, 'applications', true], 'entrega resuelta');
    const allPage = DF.deliveryProfile(base, { graded: true, category: 'applications', chapterModes: Object.fromEntries(appChapterIds.map((id) => [id, 'page'])) });
    const rEmpty = A.resolveAssessment(allPage, { hasFinalExam: true, activityEngine: 'h5p', itemCounts: A.assessmentItemCountsForPackage(m, [], allPage) });
    assert(rEmpty.weightsNormalized === true && rEmpty.emptyCategories.includes('applications') && !rEmpty.categories.some((c) => c.key === 'applications'), 'categoría vacía → normalizada');
    const pr = DF.deliveryProfile(base, { graded: true, category: 'practice' });
    eq(A.assessmentItemCountsForPackage(m, [], pr).practice, counts0.practice + appChapterIds.length, 'en práctica suma');
    eq(A.assessmentItemCountsForPackage(m, [], DF.deliveryProfile(base, { graded: false })), counts0, 'formativa: conteos de siempre');
    eq(A.resolveAssessment(DF.deliveryProfile(base, { graded: false }), { hasFinalExam: true, itemCounts: counts0 }).categories, A.resolveAssessment(base, { hasFinalExam: true, itemCounts: counts0 }).categories, 'formativa: mismas categorías');
  });

  // ── D3 ──
  const plainBuilt = await B.buildDynamicMbzV3(DF.withProfile(course, base));
  await check('D3 byte a byte: sin las claves = .mbz del build anterior (dorado); modo page con la clave = sin la clave', async () => {
    const goldenPath = process.env.GOLDEN_OFF || path.join(__dirname, 'fixtures', 'deliverables', 'golden-off.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    eq(sha(plainBuilt.mbz), golden.appModulesH5p, 'mbz sin claves = build anterior');
    eq(sha((await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'scorm', finalExam: true, courseId: 640, modules: DF.APP_MODULES }))).mbz), golden.appModulesScorm, 'scorm = build anterior');
    eq(sha((await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false }))).mbz), golden.course2NoFinal, 'sin examen final = build anterior');
    eq(sha((await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, activityTypeRules: 2, reviewCards: true, courseId: 655, chapterObjectives: ['Decidir cómo atender un reclamo', 'Escuchar al cliente', 'Identificar partes', 'Identificar partes'] }))).mbz), golden.course2H5pV2Review, 'H5P v2 + Repaso = build anterior');
    const pageBuilt = await B.buildDynamicMbzV3(DF.withProfile(course, DF.deliveryProfile(base, { mode: 'page', graded: false })));
    eq(sha(pageBuilt.mbz), sha(plainBuilt.mbz), 'modo page con la clave = sin la clave');
    const v = await V.validateMbzV3(plainBuilt.mbz, plainBuilt.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
  });

  // ── D4 ──
  const gradedProfile = DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true });
  const gradedIn = DF.withProfile(course, gradedProfile);
  const gradedBuilt = await B.buildDynamicMbzV3(gradedIn);
  await check('D4 Tarea calificada + rúbrica (categoría propia): assign/grades/grading.xml, PDF en intro, solucionario oculto; validador en verde', async () => {
    const v = await V.validateMbzV3(gradedBuilt.mbz, gradedBuilt.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    const z = await JSZip.loadAsync(gradedBuilt.mbz);
    const acts = await actsOf(z);
    const assigns = acts.filter((a) => a.mod === 'assign');
    eq(assigns.length, appChapterIds.length, 'una Tarea por AA');
    eq(gradedBuilt.summary.applicationAssigns, { count: appChapterIds.length, graded: appChapterIds.length, rubric: appChapterIds.length, category: 'applications' }, 'resumen');
    const filesXml = await z.file('files.xml').async('string');
    for (const a of assigns) {
      const chId = /^cv3:ch:([^:]+):application$/.exec(a.idnumber)[1];
      const x = await z.file(`${a.dir}/assign.xml`).async('string');
      eq([tag(x, 'grade'), tag(x, 'completionsubmit'), tag(x, 'alwaysshowdescription'), tag(x, 'duedate'), tag(x, 'attemptreopenmethod')], ['100', '1', '1', String(gradedIn.ts + 14 * 86400), 'none'], `${a.idnumber} assign.xml`);
      for (const [k, want] of [['onlinetext</plugin>\n        <subtype>assignsubmission</subtype>\n        <name>enabled</name>\n        <value>1', true], ['maxfilesubmissions</name>\n        <value>3', true], ['maxsubmissionsizebytes</name>\n        <value>10485760', true], ['filetypeslist</name>\n        <value>.pdf,.docx,.xlsx', true], ['comments</plugin>\n        <subtype>assignfeedback</subtype>\n        <name>enabled</name>\n        <value>1', true]]) {
        assert(x.includes(k) === want, `${a.idnumber}: plugin_config ${k.split('<')[0]}`);
      }
      assert(/<completion>2<\/completion>[\s\S]*<completionview>0<\/completionview>/.test(a.moduleXml), 'completion al enviar');
      const g = await z.file(`${a.dir}/grades.xml`).async('string');
      eq([tag(g, 'itemmodule'), tag(g, 'categoryid'), tag(g, 'grademax'), tag(g, 'gradepass')], ['assign', '5', '100.00000', '60.00000'], 'ítem de nota en la categoría 5');
      const gx = await z.file(`${a.dir}/grading.xml`).async('string');
      const doc = gradedIn.contents.applications.get(chId);
      eq((gx.match(/<criterion id=/g) || []).length, doc.activity.criteria.length, 'criterios de la rúbrica = criterios de la AA');
      const scores = [...gx.matchAll(/<score>([\d.]+)<\/score>/g)].map((m) => Number(m[1]));
      eq(scores, doc.activity.criteria.flatMap((c) => [0, Math.floor(c.weight / 2), c.weight]), 'niveles 0 / ⌊p/2⌋ / p');
      assert(/<activemethod>rubric<\/activemethod>[\s\S]*<status>20<\/status>/.test(gx) && !/alwaysshowdefinition/.test(gx), 'rúbrica LISTA, visible solo tras calificar');
      const intro = tag(x, 'intro').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert(/Cómo entregar/.test(intro) && /Taller de aplicación/.test(intro) && !/Solucionario|Respuesta:/.test(intro), 'descripción = AA del estudiante + cómo entregar, sin solucionario');
      const ctx = /contextid="(\d+)"/.exec(x)[1];
      assert(new RegExp(`<contextid>${ctx}</contextid>\\s*<component>mod_assign</component>\\s*<filearea>intro</filearea>[\\s\\S]*?<filename>capitulo-\\d+-actividad-de-aplicacion\\.pdf</filename>`).test(filesXml), 'PDF del estudiante en mod_assign/intro');
      const sol = acts.find((s) => s.idnumber === `cv3:ch:${chId}:application_solution`);
      assert(sol && /<visible>0<\/visible>/.test(sol.moduleXml), 'solucionario oculto');
    }
    const gb = await z.file('gradebook.xml').async('string');
    assert(/<grade_category id="5">[\s\S]*?<fullname>Actividades de Aplicación<\/fullname>/.test(gb), 'categoría en el gradebook');
    const badges = await z.file('badges.xml').async('string');
    assert(/Actividades de Aplicación calificadas/.test(badges), 'la regla de aprobación nombra las AA calificadas');
    eq(gradedBuilt.expectations.facts.counts.applicationAssignsGraded, appChapterIds.length, 'facts');
  });

  // ── D5 ──
  await check('D5 Tarea formativa: sin ítem de nota, grade 0, sin grading.xml; curso aprobado por nota final; validador en verde', async () => {
    const r = await B.buildDynamicMbzV3(DF.withProfile(course, DF.deliveryProfile(base, { graded: false })));
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    const z = await JSZip.loadAsync(r.mbz);
    for (const a of (await actsOf(z)).filter((x) => x.mod === 'assign')) {
      const x = await z.file(`${a.dir}/assign.xml`).async('string');
      eq(tag(x, 'grade'), '0', 'grade 0');
      assert(!/<grade_item /.test(await z.file(`${a.dir}/grades.xml`).async('string')), 'sin ítem de nota');
      assert(!z.file(`${a.dir}/grading.xml`), 'sin grading.xml');
      assert(/Es formativa: no lleva nota/.test(x.replace(/&[a-z]+;/g, ' ')), 'dice que es formativa');
    }
    const comp = await z.file('completion.xml').async('string');
    assert(/<criteriatype>6<\/criteriatype>/.test(comp) && !/<criteriatype>4<\/criteriatype>/.test(comp), 'solo criterio de nota final');
    assert(!/Actividades de Aplicación/.test(await z.file('gradebook.xml').async('string')), 'sin categoría nueva');
  });

  // ── D6 ──
  await check('D6 calificada en «Práctica de capítulos» + excepción por capítulo (chapterModes): página + Tareas mezcladas, válido', async () => {
    const keepPage = appChapterIds[1];
    const prof = DF.deliveryProfile(base, { graded: true, category: 'practice', rubric: false, chapterModes: { [keepPage]: 'page', 'ffffffff-0000-4000-8000-000000000000': 'assign' } });
    const r = await B.buildDynamicMbzV3(DF.withProfile(course, prof));
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    assert(r.summary.warnings.includes('application_delivery_chapter_ignored:ffffffff-0000-4000-8000-000000000000'), 'excepción de un capítulo inexistente → aviso');
    const z = await JSZip.loadAsync(r.mbz);
    const acts = await actsOf(z);
    eq(acts.find((a) => a.idnumber === `cv3:ch:${keepPage}:application`).mod, 'page', 'excepción: página');
    const assigns = acts.filter((a) => a.mod === 'assign');
    eq(assigns.length, appChapterIds.length - 1, 'resto: Tareas');
    for (const a of assigns) {
      eq(tag(await z.file(`${a.dir}/grades.xml`).async('string'), 'categoryid'), '2', 'categoría práctica');
      assert(!z.file(`${a.dir}/grading.xml`), 'sin rúbrica pedida → sin grading.xml');
    }
    assert(!/Actividades de Aplicación/.test(await z.file('gradebook.xml').async('string')), 'sin categoría nueva');
  });

  // ── D7 ──
  await check('D7 validador: rúbrica faltante, categoría, formativa con nota, calificada sin nota, entrega ≠ perfil, solucionario visible → hallazgos', async () => {
    const z0 = await JSZip.loadAsync(gradedBuilt.mbz);
    const a0 = (await actsOf(z0)).find((a) => a.mod === 'assign');
    const sol = (await actsOf(z0)).find((a) => a.idnumber === a0.idnumber + '_solution');
    const cases = [
      ['RUBRIC', async (z) => z.remove(`${a0.dir}/grading.xml`)],
      ['CATEGORIES', async (z) => z.file(`${a0.dir}/grades.xml`, (await z.file(`${a0.dir}/grades.xml`).async('string')).replace('<categoryid>5</categoryid>', '<categoryid>2</categoryid>'))],
      ['APPLICATION', async (z) => { z.file(`${a0.dir}/grades.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<activity_gradebook>\n  <grade_items>\n  </grade_items>\n  <grade_letters>\n  </grade_letters>\n</activity_gradebook>'); z.file(`${a0.dir}/inforef.xml`, (await z.file(`${a0.dir}/inforef.xml`).async('string')).replace(/<grade_itemref>[\s\S]*?<\/grade_itemref>\n?/, '')); }],
      ['SUBMISSION', async (z) => z.file(`${a0.dir}/assign.xml`, (await z.file(`${a0.dir}/assign.xml`).async('string')).replace('<name>maxfilesubmissions</name>\n        <value>3</value>', '<name>maxfilesubmissions</name>\n        <value>20</value>'))],
      ['APPLICATION', async (z) => z.file(`${a0.dir}/module.xml`, (await z.file(`${a0.dir}/module.xml`).async('string')).replace('<completion>2</completion>', '<completion>0</completion>'))],
      ['APPLICATION', async (z) => z.file(`${sol.dir}/module.xml`, (await z.file(`${sol.dir}/module.xml`).async('string')).replace('<visible>0</visible>', '<visible>1</visible>'))],
      ['SUBMISSION', async (z) => z.file(`${a0.dir}/assign.xml`, (await z.file(`${a0.dir}/assign.xml`).async('string')).replace(/<duedate>\d+<\/duedate>/, '<duedate>0</duedate>'))],
    ];
    for (const [code, fn] of cases) {
      const v = await V.validateMbzV3(await mutate(gradedBuilt.mbz, fn), gradedBuilt.expectations);
      assert(!v.ok && v.issues.some((i) => i.code === code), `${code}: ${JSON.stringify(v.issues.slice(0, 3))}`);
    }
    // Formativa con ítem de nota (las expectativas de una formativa sobre el paquete calificado).
    const formIn = DF.withProfile(course, DF.deliveryProfile(base, { graded: false }));
    const form = await B.buildDynamicMbzV3(formIn);
    const vf = await V.validateMbzV3(gradedBuilt.mbz, form.expectations);
    assert(!vf.ok && vf.issues.some((i) => i.code === 'APPLICATION' && /formativa con ítem de nota|calificación de la Tarea incoherente/.test(i.message)), `formativa con nota: ${JSON.stringify(vf.issues.slice(0, 3))}`);
  });

  // ── D8 ──
  const withFiles = await DF.withPracticeFiles(distRoot, course, gradedProfile, appChapterIds);
  const filesBuilt = await B.buildDynamicMbzV3(withFiles.input);
  await check('D8 archivos de trabajo: xlsx/docx/pdf subidos + CSV/XLSX de tabla → mod_resource del capítulo enlazados desde la Tarea; validador en verde', async () => {
    const v = await V.validateMbzV3(filesBuilt.mbz, filesBuilt.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    const z = await JSZip.loadAsync(filesBuilt.mbz);
    const acts = await actsOf(z);
    const files = await z.file('files.xml').async('string');
    eq(filesBuilt.summary.practiceResources.length, withFiles.input.assessmentProfile.practiceResources.length, 'todos publicados');
    for (const r of filesBuilt.summary.practiceResources) {
      const a = acts.find((x) => x.idnumber === `cv3:ch:${r.chapterId}:resource:${r.id}`);
      assert(a && a.mod === 'resource', `recurso ${r.id}`);
      const ctx = /contextid="(\d+)"/.exec(await z.file(`${a.dir}/resource.xml`).async('string'))[1];
      const fe = [...files.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].map((m) => m[1]).find((b) => tag(b, 'contextid') === ctx && tag(b, 'component') === 'mod_resource' && tag(b, 'filename') !== '.');
      const h = tag(fe, 'contenthash');
      const blob = await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
      eq([tag(fe, 'filename'), tag(fe, 'mimetype')], [r.filename, r.mimetype], `archivo ${r.id}`);
      eq(sha(blob), r.sha256, `sha256 ${r.id}`);
      if (r.relation === 'application') {
        const t = acts.find((x) => x.idnumber === `cv3:ch:${r.chapterId}:application`);
        const intro = await z.file(`${t.dir}/${t.mod}.xml`).async('string');
        assert(intro.includes(`$@RESOURCEVIEWBYID*${a.mid}@$`), `la AA enlaza ${r.id}`);
        assert(acts.indexOf(a) < acts.indexOf(t), 'el archivo va antes de la actividad');
      }
    }
    eq(filesBuilt.summary.practiceResources.map((r) => r.origin).sort(), ['csv', 'upload', 'upload', 'upload', 'xlsx'], 'orígenes');
    // Generados: determinísticos y abribles.
    const xlsx = await PFILES.tableToXlsx(['Producto', 'Cantidad'], [['A', 3], ['B', null]]);
    eq(sha(xlsx), sha(await PFILES.tableToXlsx(['Producto', 'Cantidad'], [['A', 3], ['B', null]])), 'XLSX determinístico');
    const xz = await JSZip.loadAsync(xlsx);
    assert(xz.file('xl/workbook.xml') && /Producto/.test(await xz.file('xl/worksheets/sheet1.xml').async('string')), 'XLSX abrible');
    assert(await PFILES.sniffMatchesExtension('.xlsx', xlsx), 'firma xlsx');
    eq(PFILES.tableToCsv(['a', 'b'], [['x, y', 1]]).toString('utf8'), '﻿a,b\r\n"x, y",1\r\n', 'CSV RFC 4180');
    // Firma de cada formato de oficina (PowerPoint incluido: el usuario lo sube; no se genera).
    const pz = new JSZip();
    pz.file('[Content_Types].xml', '<Types/>');
    pz.file('ppt/presentation.xml', '<p:presentation/>');
    const pptx = await pz.generateAsync({ type: 'nodebuffer' });
    assert(await PFILES.sniffMatchesExtension('.pptx', pptx), 'firma pptx');
    assert(!(await PFILES.sniffMatchesExtension('.pptx', withFiles.bytes.docx)), 'un docx renombrado a .pptx no pasa');
    assert(await PFILES.sniffMatchesExtension('.docx', withFiles.bytes.docx) && await PFILES.sniffMatchesExtension('.pdf', withFiles.bytes.pdf), 'firmas docx/pdf');
    assert(!(await PFILES.sniffMatchesExtension('.csv', Buffer.from([0x00, 0x01, 0x02]))), 'binario como .csv no pasa');
    // Secuencia de la sección = Manifest + chapterSlotSequence (archivos de la AA entre su instrucción y la actividad).
    const expected = PF.expectedSequence(distRoot, withFiles.input);
    for (const [secnum, ids] of expected) {
      const got = acts.filter((a) => a.sec === secnum).map((a) => a.idnumber);
      eq(got, ids, `sección ${secnum}`);
    }
  });

  await check('D8b archivo distinto / tipo / firma / faltante → falla fuerte; huérfano y «de la AA» sin AA → aviso visible; validador detecta sha y enlace', async () => {
    const tryBuild = async (mut) => {
      const inp = DF.clone(withFiles.input);
      mut(inp);
      try { await B.buildDynamicMbzV3(inp); return null; } catch (e) { return e.message; }
    };
    const up = withFiles.input.assessmentProfile.practiceResources.find((r) => r.source.kind === 'artifact');
    assert(/FILE_SHA256_MISMATCH/.test(await tryBuild((i) => { const b = Buffer.from(i.contents.practiceFiles.get(up.id)); b[b.length - 1] ^= 1; i.contents.practiceFiles.set(up.id, b); })), 'sha distinto');
    assert(/FILE_MISSING/.test(await tryBuild((i) => { i.contents.practiceFiles.delete(up.id); })), 'faltante');
    assert(/FILE_SIZE_MISMATCH/.test(await tryBuild((i) => { i.contents.practiceFiles.set(up.id, Buffer.concat([i.contents.practiceFiles.get(up.id), Buffer.from('x')])); })), 'tamaño');
    const fakeDocx = Buffer.from('esto no es un docx');
    assert(/FILE_CONTENT_MISMATCH/.test(await tryBuild((i) => { const r = i.assessmentProfile.practiceResources.find((x) => x.source.filename.endsWith('.docx')); i.contents.practiceFiles.set(r.id, fakeDocx); r.source.bytes = fakeDocx.length; r.source.sha256 = sha(fakeDocx); })), 'docx falso');
    const ok = DF.clone(withFiles.input);
    ok.assessmentProfile.practiceResources.push({ id: 'huerfano', chapterId: 'eeeeeeee-0000-4000-8000-000000000000', title: 'Archivo de otro curso', instructions: '', relation: 'chapter', source: { kind: 'table', format: 'csv', filename: 'datos.csv', columns: ['a'], rows: [['1']] } });
    const noApp = course.manifest.modules.flatMap((m) => m.chapters).find((c) => c.applicationMinutes === undefined).chapterId;
    ok.assessmentProfile.practiceResources.push({ id: 'sin-aa', chapterId: noApp, title: 'Datos del capítulo', instructions: 'Úsalo para practicar.', relation: 'application', source: { kind: 'table', format: 'csv', filename: 'practica.csv', columns: ['a'], rows: [['1']] } });
    const r = await B.buildDynamicMbzV3(ok);
    assert(r.summary.warnings.includes('practice_resource_orphan:huerfano') && r.summary.warnings.includes('practice_resource_no_application:sin-aa'), JSON.stringify(r.summary.warnings));
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    eq(r.expectations.facts.chapters.find((c) => c.id === noApp).resources.map((x) => x.relation), ['chapter'], '«de la AA» sin AA → material del capítulo');
    // Validador: blob distinto (sha) y enlace quitado.
    const z = await JSZip.loadAsync(filesBuilt.mbz);
    const acts = await actsOf(z);
    const res = acts.find((a) => /:resource:/.test(a.idnumber) && /taller-datos/.test(a.idnumber));
    const t = acts.find((a) => a.idnumber === res.idnumber.replace(/:resource:.+$/, ':application'));
    const vLink = await V.validateMbzV3(await mutate(filesBuilt.mbz, async (zz) => zz.file(`${t.dir}/assign.xml`, (await zz.file(`${t.dir}/assign.xml`).async('string')).split(`$@RESOURCEVIEWBYID*${res.mid}@$`).join('#'))), filesBuilt.expectations);
    assert(vLink.issues.some((i) => i.code === 'PRACTICE_RESOURCE' && /no enlaza/.test(i.message)), `enlace: ${JSON.stringify(vLink.issues.slice(0, 3))}`);
    const exp2 = JSON.parse(JSON.stringify(filesBuilt.expectations));
    const rr = exp2.facts.chapters.flatMap((c) => c.resources || []).find((x) => x.id === 'taller-datos');
    rr.sha256 = '0'.repeat(64);
    const vSha = await V.validateMbzV3(filesBuilt.mbz, exp2);
    assert(vSha.issues.some((i) => i.code === 'PRACTICE_RESOURCE' && /sha256/.test(i.message)), `sha: ${JSON.stringify(vSha.issues.slice(0, 3))}`);
  });

  // ── D9 ──
  await check('D9 worker: loadPracticeFilesV3 descarga solo artifacts practice_file del dueño (y dentro de su carpeta)', async () => {
    const owner = '11111111-2222-4333-8444-555555555555';
    const prof = { practiceResources: [{ id: 'r1', source: { kind: 'artifact', artifactId: 'aaaaaaaa-0000-4000-8000-000000000001' } }, { id: 't1', source: { kind: 'table' } }] };
    const rows = { 'aaaaaaaa-0000-4000-8000-000000000001': { id: 'aaaaaaaa-0000-4000-8000-000000000001', owner_id: owner, type: 'practice_file', storage_bucket: 'cursia-artifacts', storage_path: `${owner}/77/practice_file/datos.xlsx` } };
    const q = { query: async (_sql, p) => (rows[p[0]] && rows[p[0]].owner_id === p[1] ? [rows[p[0]]] : []) };
    const loaded = [];
    const Lo = { loadStorageBytes: async (b, sp) => { loaded.push([b, sp]); return Buffer.from('x'); } };
    const out = await PKG.loadPracticeFilesV3(q, Lo, owner, prof);
    eq([...out.keys()], ['r1'], 'solo los subidos');
    eq(loaded, [['cursia-artifacts', `${owner}/77/practice_file/datos.xlsx`]], 'ruta del dueño');
    let msg = '';
    try { await PKG.loadPracticeFilesV3(q, Lo, '99999999-2222-4333-8444-555555555555', prof); } catch (e) { msg = e.message; }
    assert(/no existe o no es del dueño/.test(msg), 'otro dueño → falla');
    rows['aaaaaaaa-0000-4000-8000-000000000001'].type = 'mbz_final';
    msg = '';
    try { await PKG.loadPracticeFilesV3(q, Lo, owner, prof); } catch (e) { msg = e.message; }
    assert(/no practice_file/.test(msg), 'tipo distinto → falla');
    // Cargadores reales: la ruta fuera de la carpeta del dueño se rechaza antes de descargar.
    let refused = '';
    try { PKG.assertOwnerStoragePath(owner, `otro/77/practice_file/x.xlsx`); } catch (e) { refused = e.message; }
    assert(/no pertenece al dueño/.test(refused), 'carpeta ajena rechazada');
  });

  // ── D10 ──
  await check('D10 sin red ni proveedores (fetch prohibido en todo el armado); el Manifest no gana items (FinOps sin cambios)', async () => {
    eq(course.manifest.items.filter((i) => /assign|resource/.test(i.type)).length, 0, 'sin items nuevos');
    eq(A.assessmentItemCountsFromManifest(course.manifest), A.assessmentItemCountsFromManifest(course.manifest, null), 'conteos sin perfil');
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
