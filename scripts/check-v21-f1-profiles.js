#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — F1: perfiles (review final I3 + I4). PURO: sin DB, sin red, sin proveedores.
// Corre contra los módulos COMPILADOS de dist/ (npm run build antes).
//
//  I3 — pesos de evaluación:
//   - normalizeCategoryWeights: resto mayor, suma 100, determinístico, empates por orden fijo;
//   - resolveAssessment con itemCounts: sin exámenes / sin actividades+videos / sin final /
//     todo vacío (curso sin nota) / sin itemCounts = R6 intacto / facts inválidos fallan;
//   - builder v3 + validador §Q.8: curso normalizado y curso sin nota empaquetan y validan;
//     el validador detecta un Libro sin completion por vista en un curso sin nota;
//   - prepareV3Package registra course_without_grades / assessment_weights_normalized;
//   - startRun v3: perfil inaplicable → 409 assessment_profile_invalid ANTES de cualquier
//     otra consulta o escritura; v1/v2 no consultan perfiles.
//  I4 — paleta → presentación:
//   - presentationProfileFromPalette sobre las 28 paletas (claro → aula-clara/light, resto →
//     oscuro-premium/dark, seed de la paleta) + vectores compartidos con el frontend;
//   - defaultPresentationProfileFor / GET de perfiles con ?paletteId (nunca persiste);
//   - validador de presentación: modo no soportado por la familia → THEME_MODE_NOT_SUPPORTED.
//
// Usage: node scripts/check-v21-f1-profiles.js [path/to/dist]

const path = require('path');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || path.join(ROOT, 'dist'));
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const A = loadDist('package/assessment/index.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const PK = loadDist('modules/dynamic-packaging/packaging-v3.js');
const PROF = loadDist('modules/course-profiles/course-profiles.js');
const PRE = loadDist('modules/course-profiles/assessment-preflight.js');
const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
const THEME = loadDist('modules/theme-engine/index.js');
const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const PF = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function throwsSync(fn, re, m) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${e.message.slice(0, 300)}"`);
  return e;
}
async function rejects(p, m) {
  let e = null;
  try { await p; } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  return e;
}
const weightsOf = (r) => r.categories.map((c) => [c.key, c.weight]);
const def = (finalExam) => PROF.defaultAssessmentProfile({ finalExam });

(async () => {
  // ── I3: normalización pura ───────────────────────────────────────────────
  await check('normalizeCategoryWeights: resto mayor, suma 100, empates por orden fijo, todo 0 → partes iguales', () => {
    eq(A.normalizeCategoryWeights({ moduleExams: 50, finalExam: 20 }, ['moduleExams', 'finalExam']), { moduleExams: 71, finalExam: 29 }, '50/20');
    eq(A.normalizeCategoryWeights({ practice: 30, finalExam: 20 }, ['practice', 'finalExam']), { practice: 60, finalExam: 40 }, '30/20');
    eq(A.normalizeCategoryWeights({ practice: 1, moduleExams: 1, finalExam: 1 }, ['practice', 'moduleExams', 'finalExam']), { practice: 34, moduleExams: 33, finalExam: 33 }, '1/1/1 → empate al primero');
    eq(A.normalizeCategoryWeights({ practice: 0, finalExam: 0 }, ['practice', 'finalExam']), { practice: 50, finalExam: 50 }, 'todo 0');
    eq(A.normalizeCategoryWeights({ moduleExams: 7 }, ['moduleExams']), { moduleExams: 100 }, 'una sola');
    // Barrido: toda combinación de pesos enteros 0..100 que suma 100, quitando cada categoría.
    const keys = ['practice', 'moduleExams', 'finalExam'];
    for (let p = 0; p <= 100; p += 3) for (let m = 0; m <= 100 - p; m += 7) {
      const w = { practice: p, moduleExams: m, finalExam: 100 - p - m };
      for (const drop of keys) {
        const keep = keys.filter((k) => k !== drop);
        const out = A.normalizeCategoryWeights(w, keep);
        const sum = keep.reduce((a, k) => a + out[k], 0);
        assert(sum === 100, `suma ${sum} para ${JSON.stringify(w)} sin ${drop}`);
        const tot = keep.reduce((a, k) => a + w[k], 0);
        for (const k of keep) {
          const exact = tot === 0 ? 100 / keep.length : (w[k] * 100) / tot;
          assert(Math.abs(out[k] - exact) < 1, `${k}: ${out[k]} lejos de ${exact}`);
        }
        eq(A.normalizeCategoryWeights(w, keep), out, 'determinístico');
      }
    }
    throwsSync(() => A.normalizeCategoryWeights({ practice: -1 }, ['practice']), /ASSESSMENT_INVALID_FACTS/, 'peso negativo');
    throwsSync(() => A.normalizeCategoryWeights({}, []), /ASSESSMENT_INVALID_FACTS/, 'sin categorías');
  });

  await check('assessmentItemCountsFromManifest: video+activity → practice, exam → moduleExams, final_exam → finalExam', () => {
    eq(A.assessmentItemCountsFromManifest({ items: [{ type: 'video' }, { type: 'activity' }, { type: 'activity' }, { type: 'exam' }, { type: 'final_exam' }, { type: 'content' }] }), { practice: 3, moduleExams: 1, finalExam: 1 }, 'conteo');
    throwsSync(() => A.assessmentItemCountsFromManifest({}), /ASSESSMENT_INVALID_FACTS/, 'sin items');
  });

  await check('resolveAssessment + itemCounts: sin exámenes de módulo (con final) → práctica/final 60/40, registra pesos originales', () => {
    const r = A.resolveAssessment(def(true), { hasFinalExam: true, activityEngine: 'h5p', itemCounts: { practice: 4, moduleExams: 0, finalExam: 1 } });
    eq(weightsOf(r), [['practice', 60], ['finalExam', 40]], 'pesos');
    eq([r.weightsNormalized, r.withoutGrades, r.emptyCategories, r.originalWeights], [true, false, ['moduleExams'], { practice: 30, moduleExams: 50, finalExam: 20 }], 'registro');
    eq(r.courseGradepass, 70, 'nota del curso intacta');
  });
  await check('resolveAssessment + itemCounts: sin actividades ni videos (con final) → exámenes/final 71/29', () => {
    const r = A.resolveAssessment(def(true), { hasFinalExam: true, itemCounts: { practice: 0, moduleExams: 2, finalExam: 1 } });
    eq(weightsOf(r), [['moduleExams', 71], ['finalExam', 29]], 'pesos');
    assert(r.weightsNormalized === true, 'normalizado');
  });
  await check('resolveAssessment + itemCounts: sin examen final → 40/60 sin normalizar; sin final ni práctica → exámenes 100', () => {
    const r = A.resolveAssessment(def(false), { hasFinalExam: false, itemCounts: { practice: 3, moduleExams: 2, finalExam: 0 } });
    eq(weightsOf(r), [['practice', 40], ['moduleExams', 60]], 'pesos');
    eq([r.weightsNormalized, r.emptyCategories], [false, []], 'sin normalizar');
    const r2 = A.resolveAssessment(def(false), { hasFinalExam: false, itemCounts: { practice: 0, moduleExams: 2 } });
    eq(weightsOf(r2), [['moduleExams', 100]], 'solo exámenes');
    const r3 = A.resolveAssessment(def(true), { hasFinalExam: true, itemCounts: { practice: 0, moduleExams: 0, finalExam: 1 } });
    eq(weightsOf(r3), [['finalExam', 100]], 'solo final');
  });
  await check('resolveAssessment + itemCounts: categoría vacía con peso 0 → se omite sin marcar normalización', () => {
    const p = def(false);
    p.categoryWeights = { practice: 0, moduleExams: 100 };
    const r = A.resolveAssessment(p, { hasFinalExam: false, itemCounts: { practice: 0, moduleExams: 1 } });
    eq([weightsOf(r), r.weightsNormalized, r.emptyCategories], [[['moduleExams', 100]], false, ['practice']], 'omitida');
  });
  await check('resolveAssessment + itemCounts: todo vacío → curso sin nota (sin categorías, gradepass 0, sin criterio de nota)', () => {
    const p = def(false);
    p.courseCompletion.requireCourseGradePass = true;
    const r = A.resolveAssessment(p, { hasFinalExam: false, itemCounts: { practice: 0, moduleExams: 0, finalExam: 0 } });
    eq([r.withoutGrades, r.categories, r.courseGradepass, r.courseCompletion.requireCourseGradePass, r.courseCompletion.courseGradepass], [true, [], 0, false, 0], 'sin nota');
    eq(r.originalWeights, { practice: 40, moduleExams: 60 }, 'pesos originales');
    eq(B.assessmentPackageWarnings(r), ['course_without_grades'], 'aviso');
  });
  await check('resolveAssessment: sin itemCounts = comportamiento R6 (sin campos nuevos); facts inválidos fallan fuerte; el perfil inaplicable sigue fallando', () => {
    const r = A.resolveAssessment(def(true), { hasFinalExam: true });
    assert(!('weightsNormalized' in r) && !('withoutGrades' in r) && r.categories.length === 3, 'R6 intacto');
    throwsSync(() => A.resolveAssessment(def(true), { hasFinalExam: true, itemCounts: { practice: 1, moduleExams: 1, finalExam: 0 } }), /ASSESSMENT_INVALID_FACTS/, 'final sin ítem');
    throwsSync(() => A.resolveAssessment(def(false), { hasFinalExam: false, itemCounts: { practice: 1, moduleExams: 1, finalExam: 1 } }), /ASSESSMENT_INVALID_FACTS/, 'ítem final sin final');
    throwsSync(() => A.resolveAssessment(def(true), { hasFinalExam: true, itemCounts: { practice: 1.5, moduleExams: 1, finalExam: 1 } }), /ASSESSMENT_INVALID_FACTS/, 'no entero');
    throwsSync(() => A.resolveAssessment(def(false), { hasFinalExam: true, itemCounts: { practice: 1, moduleExams: 1, finalExam: 1 } }), /WEIGHTS_FINAL_EXAM_MISMATCH/, 'mismatch');
    const a = def(true); a.attempts.activity = 2;
    throwsSync(() => A.resolveAssessment(a, { hasFinalExam: true, activityEngine: 'h5p', itemCounts: { practice: 1, moduleExams: 1, finalExam: 1 } }), /ASSESSMENT_UNENFORCEABLE/, 'intentos h5p');
  });

  // ── I3: builder + validador ──────────────────────────────────────────────
  async function gradebookCats(mbz) {
    const z = await JSZip.loadAsync(mbz);
    const gb = await z.file('gradebook.xml').async('string');
    const cats = [...gb.matchAll(/<grade_category id="(\d+)">[\s\S]*?<parent>([^<]*)<\/parent>[\s\S]*?<fullname>([^<]*)<\/fullname>/g)].map((m) => ({ id: +m[1], parent: m[2], fullname: m[3] }));
    return { z, gb, cats };
  }
  await check('builder v3: sin exámenes de módulo (con final) → gradebook sin "Evaluaciones de módulo", pesos 60/40, valida; resumen registra la normalización', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 811, modules: [
      { examEnabled: false, chapters: [{ video: true, activity: true }, { video: false, activity: true }] },
      { examEnabled: false, chapters: [{ video: false, activity: false }] },
    ] });
    const r = await B.buildDynamicMbzV3(input);
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `valida: ${JSON.stringify(v.issues.slice(0, 3))}`);
    eq(r.summary.assessment, { weightsNormalized: true, originalWeights: { practice: 30, moduleExams: 50, finalExam: 20 }, weights: { practice: 60, finalExam: 40 }, emptyCategories: ['moduleExams'], withoutGrades: false }, 'resumen');
    const { cats } = await gradebookCats(r.mbz);
    eq(cats.filter((c) => c.parent !== '$@NULL@$').map((c) => c.fullname), ['Práctica de capítulos', 'Evaluación final'], 'categorías');
  });
  await check('builder v3: sin actividades ni videos (con final) → 71/29, valida', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'scorm', finalExam: true, courseId: 812, modules: [
      { examEnabled: true, chapters: [{ video: false, activity: false }] },
    ] });
    const r = await B.buildDynamicMbzV3(input);
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `valida: ${JSON.stringify(v.issues.slice(0, 3))}`);
    eq(r.summary.assessment.weights, { moduleExams: 71, finalExam: 29 }, 'pesos');
  });
  let noGrades = null;
  await check('builder v3: curso sin nota (sin práctica, sin exámenes, sin final) → sin categorías, gradepass 0, completion por vista del Libro Guía; valida', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false, courseId: 813, modules: [
      { examEnabled: false, chapters: [{ video: false, activity: false }, { video: false, activity: false }] },
    ] });
    const r = await B.buildDynamicMbzV3(input);
    noGrades = r;
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `valida: ${JSON.stringify(v.issues.slice(0, 3))}`);
    eq(r.summary.assessment, { weightsNormalized: false, originalWeights: { practice: 40, moduleExams: 60 }, weights: {}, emptyCategories: ['practice', 'moduleExams'], withoutGrades: true }, 'resumen');
    const { z, gb, cats } = await gradebookCats(r.mbz);
    eq(cats.length, 1, 'solo la categoría del curso');
    assert(/<itemtype>course<\/itemtype>[\s\S]*?<gradepass>0\.00000<\/gradepass>/.test(gb), 'gradepass del curso 0');
    const comp = await z.file('completion.xml').async('string');
    const crit = [...comp.matchAll(/<criteriatype>(\d+)<\/criteriatype>\s*<module>([^<]*)<\/module>\s*<moduleinstance>(\d+)/g)].map((m) => [m[1], m[2], +m[3]]);
    const mb = await z.file('moodle_backup.xml').async('string');
    const libroDir = /<directory>(activities\/resource_\d+)<\/directory>/.exec(mb)[1];
    const libroMod = await z.file(`${libroDir}/module.xml`).async('string');
    const libroMid = +/<module id="(\d+)"/.exec(libroMod)[1];
    eq(crit, [['4', 'resource', libroMid]], 'criterio = vista del Libro Guía');
    assert(/<completion>2<\/completion>/.test(libroMod) && /<completionview>1<\/completionview>/.test(libroMod), 'Libro con completion por vista');
    assert(!/<criteriatype>6<\/criteriatype>/.test(comp), 'sin criterio de nota');
  });
  await check('validador v3: curso sin nota con el Libro sin completion por vista → COMPLETION + COURSE_COMPLETION', async () => {
    assert(noGrades, 'depende del check anterior');
    const z = await JSZip.loadAsync(noGrades.mbz);
    const mb = await z.file('moodle_backup.xml').async('string');
    const libroDir = /<directory>(activities\/resource_\d+)<\/directory>/.exec(mb)[1];
    const mod = await z.file(`${libroDir}/module.xml`).async('string');
    z.file(`${libroDir}/module.xml`, mod.replace('<completion>2</completion>', '<completion>0</completion>'));
    z.file('completion.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n</course_completion>');
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const v = await V.validateMbzV3(bad, noGrades.expectations);
    const codes = [...new Set(v.issues.map((i) => i.code))].sort();
    assert(!v.ok && codes.includes('COMPLETION') && codes.includes('COURSE_COMPLETION'), `detecta: ${codes.join(',')}`);
  });
  await check('gradebookXml/courseCompletionXml: withoutGrades exige 0 categorías y gradepass 0; resource solo como criterio de vista', () => {
    throwsSync(() => A.gradebookXml({ ts: 1, categories: [], courseGradepass: 70, aggregation: 'weighted_mean' }), /categories vacío/, 'sin flag');
    throwsSync(() => A.gradebookXml({ ts: 1, categories: [], courseGradepass: 70, aggregation: 'weighted_mean', withoutGrades: true }), /courseGradepass 0/, 'gradepass');
    throwsSync(() => A.gradebookXml({ ts: 1, categories: [{ id: 2, fullname: 'x', weight: 100, gradeItemId: 2 }], courseGradepass: 0, aggregation: 'weighted_mean', withoutGrades: true }), /sin nota/, 'con categorías');
    assert(/<course_completion_criteria/.test(A.courseCompletionXml({ criteria: [{ moduleId: 9, modname: 'resource' }], aggregation: 'all', requireCourseGradePass: false, courseGradepass: 0 })), 'resource ok');
    throwsSync(() => A.courseCompletionXml({ criteria: [{ moduleId: 9, modname: 'label' }], aggregation: 'all', requireCourseGradePass: false, courseGradepass: 0 }), /modname/, 'label no');
  });

  // ── I3: avisos del empaque (prepareV3Package) ────────────────────────────
  function fakePrepareQ(manifest, { profiles = [], metadata = {} } = {}) {
    const rows = [];
    for (const it of manifest.items) for (const t of R.requiredArtifactTypesV3(it.type, it.variant)) {
      rows.push({ item_key: it.key, item_run_id: `g-${it.key}`, gir_status: 'completed', gir_type: it.type, output_summary: {}, artifact_id: `${it.key}-${t}`, artifact_type: t, storage_bucket: 'b', storage_path: 'o/p', mime_type: 'application/json', artifact_status: null, metadata: {} });
    }
    return { query: async (sql) => {
      if (/generation_item_runs/.test(sql)) return rows;
      if (/course_profiles/.test(sql)) return profiles;
      if (/from public\.courses where id/.test(sql)) return [{ metadata }];
      if (/production_jobs/.test(sql)) return [{ id: 'r', owner_id: 'o', execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: {} }];
      throw new Error(`SQL no esperado: ${sql}`);
    } };
  }
  await check('prepareV3Package: curso sin nota → aviso course_without_grades + resumen; con paleta guardada → sin presentation_profile_defaulted', async () => {
    const { manifest } = SF.buildCourse(distRoot, { courseId: 821, finalExam: false, engine: 'h5p', modules: [{ examEnabled: false, chapters: [{ video: false, activity: false }] }] });
    const prep = await PK.prepareV3Package(fakePrepareQ(manifest, { metadata: { paletteId: 'navy-teal' } }), 'r', { id: 1, sha256: 's', manifest }, 821, '4.1');
    eq(prep.profileWarnings, ['course_without_grades'], 'avisos');
    eq([prep.assessment.withoutGrades, prep.profiles.theme.source, prep.profiles.theme.input.themeFamily], [true, 'palette', 'oscuro-premium'], 'resumen + tema');
    const prep2 = await PK.prepareV3Package(fakePrepareQ(manifest), 'r', { id: 1, sha256: 's', manifest }, 821, '4.1');
    eq(prep2.profileWarnings, ['presentation_profile_defaulted', 'course_without_grades'], 'sin paleta → default con aviso');
    eq(prep2.profiles.theme.input, { themeFamily: 'aula-clara', mode: 'light', themeVersion: 1 }, 'aula-clara/light');
  });

  // ── I3: gate de startRun (409 antes de gastar) ──────────────────────────
  const OWNER = '11111111-2222-4333-8444-555555555555';
  function manifestV3(finalExam) {
    const { manifest } = SF.buildCourse(distRoot, { courseId: 831, finalExam, engine: 'h5p', modules: [{ examEnabled: true, chapters: [{ video: false, activity: true }] }] });
    return { id: 77, rulesVersion: 3, sha256: 's', manifest };
  }
  async function startWith(manifest, profileRows) {
    const env = { DYNAMIC_COURSE_STRUCTURE: process.env.DYNAMIC_COURSE_STRUCTURE, DYNAMIC_V2_ALLOWED_OWNERS: process.env.DYNAMIC_V2_ALLOWED_OWNERS };
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_V2_ALLOWED_OWNERS = OWNER;
    const sqls = [];
    const SENTINEL = 'SENTINEL_AFTER_PREFLIGHT';
    const ds = { async query(sql) { sqls.push(sql); if (/course_profiles/.test(sql)) return profileRows; throw new Error(SENTINEL); } };
    const svc = new RunsService(ds, { async get() { return manifest; } }, {});
    // Cualquier paso posterior al gate corta con el centinela (no se prueba acá).
    svc.findActiveRunOnOtherManifest = async () => { throw new Error(SENTINEL); };
    svc.startRunFromPrevious = async () => { throw new Error(SENTINEL); };
    let err = null;
    try {
      await svc.startRun(831, OWNER, 1, { nombre: 'Curso', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' });
    } catch (e) { err = e; } finally {
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    // "Pasó el gate" = el error (si lo hay) NO es el 409 del gate: cualquier paso posterior
    // (modos de proveedor, run activo…) corta con su propio error o con el centinela.
    const passedGate = !(err && err.getResponse && err.getResponse().code === 'assessment_profile_invalid');
    return { err, sqls, SENTINEL, passedGate };
  }
  await check('startRun v3: perfil de evaluación inaplicable (pesos con final en un curso sin final) → 409 assessment_profile_invalid, sin ninguna otra consulta ni escritura', async () => {
    const { err, sqls } = await startWith(manifestV3(false), [{ version: 2, data: def(true) }]);
    assert(err && err.getStatus && err.getStatus() === 409, `409: ${err && err.message}`);
    const body = err.getResponse();
    eq([body.code, body.profileVersion], ['assessment_profile_invalid', 2], 'código y versión');
    assert(/WEIGHTS_FINAL_EXAM_MISMATCH/.test(body.message) && /no se gastó nada/.test(body.message), body.message);
    eq(sqls.length, 1, 'solo la lectura del perfil');
    assert(/course_profiles/.test(sqls[0]) && !/insert|update/i.test(sqls[0]), 'lectura');
  });
  await check('startRun v3: intentos que Moodle no puede imponer / perfil guardado ilegible → 409; perfil válido o default con categorías vacías → pasa el gate', async () => {
    const att = def(false); att.attempts.video = 2;
    const r1 = await startWith(manifestV3(false), [{ version: 1, data: att }]);
    assert(r1.err && r1.err.getResponse && r1.err.getResponse().code === 'assessment_profile_invalid' && /ASSESSMENT_UNENFORCEABLE/.test(r1.err.getResponse().message), 'intentos');
    const r2 = await startWith(manifestV3(false), [{ version: 4, data: { passingGrade: 70 } }]);
    assert(r2.err && r2.err.getResponse && r2.err.getResponse().code === 'assessment_profile_invalid', `ilegible: ${r2.err && r2.err.message}`);
    // default (sin fila): el curso no tiene videos ni… sí tiene actividad y examen — pasa.
    const r3 = await startWith(manifestV3(false), []);
    assert(r3.passedGate && r3.sqls.filter((q) => /course_profiles/.test(q)).length === 1, `pasa el gate: ${r3.err && r3.err.message}`);
    // curso con final y sin práctica: el default 30/50/20 se normaliza, no bloquea.
    const { manifest } = SF.buildCourse(distRoot, { courseId: 832, finalExam: true, engine: 'h5p', modules: [{ examEnabled: false, chapters: [{ video: false, activity: false }] }] });
    const r4 = await startWith({ id: 78, rulesVersion: 3, sha256: 's', manifest }, []);
    assert(r4.passedGate, `normalizado pasa: ${r4.err && r4.err.message}`);
  });
  await check('startRun v1/v2: el gate no consulta perfiles (comportamiento previo intacto)', async () => {
    for (const rv of [1, 2]) {
      const { err, sqls, SENTINEL } = await startWith({ id: 5, rulesVersion: rv, sha256: 's', manifest: { items: [] } }, [{ version: 1, data: def(true) }]);
      assert(err && err.message === SENTINEL, `rv${rv}: ${err && err.message}`);
      assert(!sqls.some((q) => /course_profiles/.test(q)), `rv${rv} sin lectura de perfiles`);
    }
    const r = PRE.preflightAssessmentProfile(def(true), { items: [{ type: 'final_exam' }], features: { finalExam: true } });
    eq([r.ok, r.resolved.categories.map((c) => c.key)], [true, ['finalExam']], 'pura');
  });

  // ── I4: paleta → presentación ───────────────────────────────────────────
  // Vectores compartidos con el frontend (src/js/__harness__/test-47-profiles-panel.mjs).
  const VECTORS = {
    'navy-teal': { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: { accent: '#E8692A', moduleColors: ['#1A3C5E', '#0B6B56', '#7D3C98'] }, themeVersion: 1 },
    'blanco-corp': { themeFamily: 'aula-clara', mode: 'light', brandSeed: { accent: '#1D4ED8', moduleColors: ['#1E3A5F', '#0F6E5C', '#5B3A8E'] }, themeVersion: 1 },
    emerald: { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: { accent: '#22C55E', moduleColors: ['#145A32', '#78350F', '#1E3A5F'] }, themeVersion: 1 },
  };
  await check('presentationProfileFromPalette: 28 paletas — claro → aula-clara/light, el resto → oscuro-premium/dark; seed = brandSeedFromLegacyPalette; resuelve y valida', () => {
    eq(THEME.LEGACY_PALETTES.length, 28, '28 paletas');
    for (const p of THEME.LEGACY_PALETTES) {
      const d = THEME.presentationProfileFromPalette(p);
      const light = p.cat === 'claro';
      eq([d.themeFamily, d.mode], light ? ['aula-clara', 'light'] : ['oscuro-premium', 'dark'], p.id);
      eq(d.brandSeed, THEME.brandSeedFromLegacyPalette(p), `${p.id} seed`);
      const t = THEME.resolveTheme(d);
      eq(THEME.validateTheme(t, { moduleCount: 6 }), [], `${p.id} valida`);
      eq(PROF.validatePresentationProfile(PROF.defaultPresentationProfileFor(p.id).profile), [], `${p.id} perfil válido`);
    }
    for (const [id, want] of Object.entries(VECTORS)) eq(THEME.presentationProfileFromPaletteId(id), want, `vector ${id}`);
    throwsSync(() => THEME.presentationProfileFromPaletteId('inexistente'), /THEME_INVALID/, 'desconocida');
  });
  await check('defaultPresentationProfileFor: paleta conocida → derivado (palette); sin paleta → aula-clara (fallback); desconocida → fallback + PALETTE_UNKNOWN', () => {
    eq(PROF.defaultPresentationProfileFor('navy-teal'), { profile: VECTORS['navy-teal'], source: 'palette', warnings: [] }, 'conocida');
    eq(PROF.defaultPresentationProfileFor(null), { profile: PROF.defaultPresentationProfile(), source: 'fallback', warnings: [] }, 'sin paleta');
    const u = PROF.defaultPresentationProfileFor('mi-marca');
    eq([u.source, u.profile, u.warnings.map((w) => w.code)], ['fallback', PROF.defaultPresentationProfile(), ['PALETTE_UNKNOWN']], 'desconocida');
  });
  await check('validatePresentationProfile: modo que la familia no soporta → THEME_MODE_NOT_SUPPORTED; técnico admite ambos', () => {
    const codes = (p) => PROF.validatePresentationProfile(p).map((e) => e.code);
    eq(codes({ themeFamily: 'aula-clara', mode: 'dark', brandSeed: null, themeVersion: 1 }), ['THEME_MODE_NOT_SUPPORTED'], 'aula-clara dark');
    eq(codes({ themeFamily: 'oscuro-premium', mode: 'light', brandSeed: null, themeVersion: 1 }), ['THEME_MODE_NOT_SUPPORTED'], 'oscuro light');
    eq(codes({ themeFamily: 'tecnico', mode: 'dark', brandSeed: null, themeVersion: 1 }), [], 'técnico dark');
    eq(codes({ themeFamily: 'tecnico', mode: 'light', brandSeed: null, themeVersion: 1 }), [], 'técnico light');
    eq(codes({ themeFamily: 'nope', mode: 'dark', brandSeed: null, themeVersion: 1 }), ['INVALID_THEME_FAMILY'], 'familia inválida sin ruido extra');
  });
  await check('GET perfiles (servicio): sin perfil de presentación → default de la paleta (query o metadata del curso), sin persistir; assessment intacto', async () => {
    const sqls = [];
    const svc = new CourseProfilesService(
      { async query(sql) {
        sqls.push(sql);
        if (/final_exam_enabled/.test(sql)) return [{ final_exam_enabled: true }];
        if (/course_profiles/.test(sql)) return [];
        if (/select metadata from public\.courses/.test(sql)) return [{ metadata: { pal: { id: 'blanco-corp' } } }];
        throw new Error(`SQL no esperado: ${sql}`);
      } },
      { async findOne() { return { structureVersion: 'dynamic' }; } },
    );
    const q = await svc.getCurrent(5, OWNER, 'presentation', 'navy-teal');
    eq([q.isDefault, q.version, q.defaultSource, q.profile], [true, 0, 'palette', VECTORS['navy-teal']], 'query');
    eq(q.sha256, PROF.profileSha256(VECTORS['navy-teal']), 'sha del default');
    const m = await svc.getCurrent(5, OWNER, 'presentation');
    eq([m.defaultSource, m.profile.themeFamily], ['palette', 'aula-clara'], 'metadata');
    const u = await svc.getCurrent(5, OWNER, 'presentation', 'mi-marca');
    eq([u.defaultSource, u.warnings.map((w) => w.code)], ['fallback', ['PALETTE_UNKNOWN']], 'desconocida');
    const a = await svc.getCurrent(5, OWNER, 'assessment', 'navy-teal');
    eq([a.defaultSource, a.profile.passingGrade], [null, 70], 'assessment sin cambios');
    assert(!sqls.some((s) => /insert|update|delete/i.test(s)), 'nunca escribe');
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures > 0 ? 1 : 0);
})();
