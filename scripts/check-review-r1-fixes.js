#!/usr/bin/env node
/* eslint-disable no-console */
// Review r1 (r57) — arreglos de la revisión independiente. PURO: sin red, sin proveedores, sin base (el estado del run con
// PG desechable vive en check-ev6-dod-autopkg «[AP] review r1 I1»).
//
//   I1  frescura: builder anterior + opt-in apagado + mismo contenido → vigente con `builderUpdateAvailable`
//       (v3 y v2); contenido distinto → stale como siempre; opt-in encendido → builder_changed como siempre
//   I2  INTERNAL_VOCABULARY solo juzga texto GENERADO: archivo de práctica «Worked example ventas» con instrucciones
//       «texto fuente» y un capítulo titulado por el usuario empaquetan OK; el mismo término en texto generado se
//       repara y, inyectado, el validador lo sigue rechazando
//   I3  la reparación nunca empuja un campo más allá de su límite: campo EXACTAMENTE al límite → rótulo corto o el
//       original con aviso (y su regla no bloquea); el paquete se arma
//   M1  rúbrica: niveles genéricos (ninguna frase del solucionario); guía ↔ criterio por NOMBRE en el material docente
//   M2  fecha límite: default sin fecha (clave ausente ≡ null → 0); relativa = <startdate> del backup + N días
//   M9  enlace muerto `href="#"` → se desenvuelve (queda el texto) con aviso; un token sin resolver sigue fallando
//   M4  teacherGuide {include:false} ≡ ausente (mismo perfil normalizado y sha)
//   M8  referencias: error de la base → log + aviso en el resumen del paquete
//   M3  artifact de archivo de trabajo borrado → PRACTICE_FILE_MISSING (clase D package_precheck, igual que INVALID)
//   G   Tarea formativa sin ítem de nota; calificada con categoría aggregateonlygraded=0 (nota vacía = 0 hasta calificar)
//
// Uso: npm run build && node scripts/check-review-r1-fixes.js [dist]
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const VC = L('modules/visual-components/index.js');
const P = L('modules/course-profiles/course-profiles.js');
const AD = L('modules/course-profiles/application-delivery.js');
const PKG = L('modules/dynamic-packaging/packaging-v3.js');
const PFR = L('modules/dynamic-packaging/package-freshness.js');
const REUSE = L('modules/dynamic-packaging/packaging-reuse-key.js');
const R = L('modules/dynamic-packaging/artifact-resolver.js');
const ASSIGN = L('package/v3/assign-v3.js');
const AA = L('modules/course-shell/application-activity.js');
const DEAD = L('package/v3/dead-links-v3.js');
const FC = L('modules/reliability/failure-classifier.js');
const SF = require('./lib/v21-shell-fixtures');
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
    console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const tag = (x, t) => ((x || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
const unxml = (s) => String(s || '').replace(/&(lt|gt|quot|amp);/g, (_m, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]);
const withEnv = async (k, v, fn) => {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; }
};

(async () => {
  // ════ I1 — frescura con un builder anterior ══════════════════════════════
  const { manifest } = SF.buildCourse(distRoot, { courseId: 641, finalExam: false, engine: 'h5p', modules: [{ examEnabled: true, chapters: [{ video: false, activity: false }] }] });
  const rowsOf = (suffix = '') => {
    const rows = [];
    for (const it of manifest.items) for (const t of R.requiredArtifactTypesV3(it.type, it.variant)) {
      rows.push({ item_key: it.key, item_run_id: `g-${it.key}`, gir_status: 'completed', gir_type: it.type, output_summary: {}, artifact_id: `${it.key}-${t}${suffix}`, artifact_type: t, storage_bucket: 'b', storage_path: 'o/p', mime_type: 'application/json', artifact_status: null, metadata: {} });
    }
    return rows;
  };
  const fakeQ = (rows, opts = {}) => ({ query: async (sql) => {
    if (/generation_item_runs/.test(sql)) return rows;
    if (/course_profiles/.test(sql) && /kind = 'academic'/.test(sql) && opts.refsThrow) throw new Error('connection terminated unexpectedly');
    if (/course_profiles/.test(sql)) return [];
    if (/from public\.courses where id/.test(sql)) return [{ metadata: {} }];
    if (/production_jobs/.test(sql)) return [{ id: 'r', owner_id: 'o', execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: {} }];
    if (/to_regclass/.test(sql)) return [{ bp: true, us: true, inst: true }];
    if (/from public\.user_settings/.test(sql)) return [];
    throw new Error(`SQL inesperado en el check: ${sql.slice(0, 120)}`);
  } });
  const run = { id: 'r', owner_id: 'o', course_id: 641, worker_status: 'completed', status: 'completed', input_payload: {} };
  const M3 = { id: 1, sha256: 's', rulesVersion: 3, manifest };
  const CUR3 = L('package/dynamic-mbz-builder-v3.js').DYNAMIC_MBZ_BUILDER_VERSION_V3;

  await check('I1 v3: builder anterior + opt-in APAGADO + mismo contenido → vigente (stale:false) con builderUpdateAvailable; contenido distinto → sources_changed; opt-in ENCENDIDO → builder_changed (como antes); mismo builder → vigente sin el campo', async () => {
    const q = fakeQ(rowsOf());
    const prep = await PKG.prepareV3Package(q, 'r', M3, 641, '4.1');
    assert(prep.reuseKey && prep.reuseKey.builderVersion === CUR3, 'prepared expone la clave');
    const oldHash = PKG.legacyReuseHashesV3(prep.reuseKey, '3.14.0')[0];
    const job = (builderVersion, sourceIdsHash, ids = prep.sourceArtifactIds) => ({ id: 'j', worker_status: 'completed', input_payload: {}, output_summary: { artifactId: 'a', builderVersion, sourceIdsHash, sourceArtifactIds: ids } });
    await withEnv('DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP', undefined, async () => {
      eq(await PFR.buildPackageFreshness(q, run, M3, job('3.14.0', oldHash)), { stale: false, builderUpdateAvailable: { packagedWith: '3.14.0', current: CUR3 } }, 'solo builder');
      eq(await PFR.buildPackageFreshness(q, run, M3, job(CUR3, prep.sourceIdsHash)), { stale: false }, 'mismo builder');
      // Contenido distinto: un item se regeneró después del paquete (otro artifact id).
      const q2 = fakeQ(rowsOf('-v2'));
      const f2 = await PFR.buildPackageFreshness(q2, run, M3, job('3.14.0', oldHash));
      assert(f2.stale === true && /^sources_changed/.test(f2.reason) && !f2.builderUpdateAvailable, `contenido distinto: ${JSON.stringify(f2)}`);
      // Perfil/tema distinto con el builder viejo (misma lista de artifacts) → stale (profile_or_theme_changed).
      const f3 = await PFR.buildPackageFreshness(q, run, M3, job('3.14.0', 'f'.repeat(64)));
      assert(f3.stale === true && /^profile_or_theme_changed/.test(f3.reason), `perfil distinto: ${JSON.stringify(f3)}`);
      // Sin versión registrada (paquete muy viejo): no se puede recomputar → builder_changed.
      const f4 = await PFR.buildPackageFreshness(q, run, M3, job(undefined, oldHash));
      assert(f4.stale === true && /^builder_changed/.test(f4.reason), `sin versión: ${JSON.stringify(f4)}`);
    });
    await withEnv('DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP', 'true', async () => {
      const f = await PFR.buildPackageFreshness(q, run, M3, job('3.14.0', oldHash));
      assert(f.stale === true && /^builder_changed/.test(f.reason) && !f.builderUpdateAvailable, `opt-in: ${JSON.stringify(f)}`);
    });
  });

  await check('I1 v3: la clave de un builder anterior también se reconoce sin las referencias del programa (componente que entró con 3.15.0)', async () => {
    const k = { builderVersion: CUR3, manifestSha256: 'm', sourceArtifactIds: ['a'], themeSha256: 't', assessmentProfileSha256: 'p', h5pProfileVersion: 1, vcRendererVersion: 'r', moodleVersion: '4.1', libroBrandSha256: 'b', libroReferencesSha256: 'refs' };
    const hs = PKG.legacyReuseHashesV3(k, '3.14.0');
    eq(hs.length, 2, 'dos candidatas');
    eq(hs[1], PKG.packageReuseHashV3({ ...k, builderVersion: '3.14.0', libroReferencesSha256: undefined }), 'sin referencias');
    eq(PKG.legacyReuseHashesV3({ ...k, libroReferencesSha256: undefined }, '3.14.0').length, 1, 'sin referencias: una');
  });

  await check('I1 v2: builder anterior + opt-in apagado + mismos artifacts → vigente con builderUpdateAvailable; opt-in → builder_changed', async () => {
    const CUR2 = L('package/dynamic-mbz-builder.js').DYNAMIC_MBZ_BUILDER_VERSION;
    const RES = L('modules/dynamic-packaging/artifact-resolver.js');
    const orig = RES.resolveRunArtifacts;
    const byItem = new Map([['content:a', [{ artifactId: 'x1' }]], ['scorm:a', [{ artifactId: 'x2' }]]]);
    RES.resolveRunArtifacts = async () => byItem;
    try {
      const M2 = { id: 1, sha256: 's', rulesVersion: 2, manifest: { items: [] } };
      const ids = REUSE.sortedArtifactIds(byItem);
      const old = REUSE.packageReuseHash('2.0.0-old', ids, '4.1');
      const j = { id: 'j', worker_status: 'completed', input_payload: {}, output_summary: { builderVersion: '2.0.0-old', sourceIdsHash: old, sourceArtifactIds: ids } };
      await withEnv('DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP', undefined, async () => {
        eq(await PFR.buildPackageFreshness({ query: async () => [] }, run, M2, j), { stale: false, builderUpdateAvailable: { packagedWith: '2.0.0-old', current: CUR2 } }, 'v2 solo builder');
      });
      await withEnv('DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP', 'true', async () => {
        assert(/^builder_changed/.test((await PFR.buildPackageFreshness({ query: async () => [] }, run, M2, j)).reason), 'v2 opt-in');
      });
    } finally {
      RES.resolveRunArtifacts = orig;
    }
  });

  // ════ M8 — referencias con error de base ════════════════════════════════
  await check('M8 referencias: un error de la base al leer el contexto académico → log del servidor + aviso libro_references_unavailable en el resumen (nunca silencioso)', async () => {
    const logs = [];
    const r = await PKG.loadLibroReferencesV3({ query: async () => { throw new Error('connection terminated unexpectedly'); } }, 641, { warn: (m) => logs.push(m) });
    eq(r.references, [], 'sin referencias');
    assert(r.warnings.length === 1 && /^libro_references_unavailable:/.test(r.warnings[0]) && /connection terminated/.test(r.warnings[0]), JSON.stringify(r.warnings));
    assert(logs.length === 1 && /curso 641/.test(logs[0]) && /connection terminated/.test(logs[0]), `log: ${JSON.stringify(logs)}`);
    // El aviso llega al resumen del paquete (profileWarnings → warnings del job).
    const prep = await PKG.prepareV3Package(fakeQ(rowsOf(), { refsThrow: true }), 'r', M3, 641, '4.1');
    assert(prep.profileWarnings.some((w) => /^libro_references_unavailable:/.test(w)), `profileWarnings: ${JSON.stringify(prep.profileWarnings)}`);
  });

  // ════ M3 — archivo de trabajo borrado ═══════════════════════════════════
  await check('M3 archivo de trabajo con artifact borrado / ajeno / de otro tipo → PRACTICE_FILE_MISSING, clase D package_precheck (como PRACTICE_FILE_INVALID: lo corrige una persona)', async () => {
    const prof = { practiceResources: [{ id: 'datos', source: { kind: 'artifact', artifactId: 'aaaaaaaa-0000-4000-8000-000000000009' } }] };
    let err = null;
    try { await PKG.loadPracticeFilesV3({ query: async () => [] }, { loadStorageBytes: async () => Buffer.from('x') }, 'o', prof); } catch (e) { err = e; }
    assert(err && /^PRACTICE_FILE_MISSING: /.test(err.message), `borrado: ${err && err.message}`);
    err = null;
    try { await PKG.loadPracticeFilesV3({ query: async () => [{ id: 'x', owner_id: 'o', type: 'dynamic_mbz', storage_bucket: 'b', storage_path: 'o/x' }] }, { loadStorageBytes: async () => Buffer.from('x') }, 'o', prof); } catch (e) { err = e; }
    assert(err && /^PRACTICE_FILE_MISSING: /.test(err.message), `otro tipo: ${err && err.message}`);
    const v = FC.classifyFailure({ source: 'package_worker', error: err.message });
    const vi = FC.classifyFailure({ source: 'package_worker', error: 'PRACTICE_FILE_INVALID: datos [SHA256_MISMATCH] x' });
    eq([v.code, v.class, v.strategy], ['PRACTICE_FILE_MISSING', 'D', 'hold_for_human'], 'clasificado');
    eq([v.class, v.strategy, v.ruleId ?? v.rule ?? null], [vi.class, vi.strategy, vi.ruleId ?? vi.rule ?? null], 'mismo grupo que PRACTICE_FILE_INVALID');
    assert(FC.isFailureCodeClassified('PRACTICE_FILE_MISSING'), 'código clasificado');
  });

  // ════ M4 — teacherGuide include:false ═══════════════════════════════════
  await check('M4 teacherGuide {include:false} ≡ ausente: mismo perfil normalizado y mismo sha (apagarla no re-empaqueta); {include:true} sí cambia', async () => {
    const base = P.defaultAssessmentProfile({ finalExam: true });
    const off = { ...JSON.parse(JSON.stringify(base)), teacherGuide: { include: false } };
    eq(P.validateAssessmentProfile(off, { finalExam: true }), [], 'válido');
    eq(JSON.stringify(P.normalizeAssessmentProfile(off)), JSON.stringify(P.normalizeAssessmentProfile(base)), 'normalizado = ausente');
    eq(P.profileSha256(P.normalizeAssessmentProfile(off)), P.profileSha256(P.normalizeAssessmentProfile(base)), 'mismo sha');
    const on = { ...JSON.parse(JSON.stringify(base)), teacherGuide: { include: true } };
    assert(P.profileSha256(P.normalizeAssessmentProfile(on)) !== P.profileSha256(P.normalizeAssessmentProfile(base)), 'encendida cambia el sha');
  });

  // ════ I2 — texto del usuario no bloquea ═════════════════════════════════
  // Título de capítulo del usuario con un término interno que el Libro NO usa como vocabulario del tema (el Libro del fixture
  // repite el título del capítulo, así que el término quedaría exento por dominio: se prueba con otro término).
  const titles = ['Escuchar al cliente', 'Responder reclamos', 'Práctica integradora', 'Acuerdos justos', 'Cierre del mes'];
  const userCourse = () => PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 640, modules: DF.APP_MODULES, chapterTitles: titles });
  const appIdsOf = (input) => input.manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.key.slice('application_activity:'.length));
  const base = P.defaultAssessmentProfile({ finalExam: true });

  await check('I2 INTERNAL_VOCABULARY solo juzga texto GENERADO: archivo de práctica «Worked example ventas» con instrucciones «Lee el texto fuente…» → el paquete se arma y valida OK; los textos del usuario quedan tal cual', async () => {
    const input0 = userCourse();
    const ids = appIdsOf(input0);
    const prof = DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true });
    const { input } = await DF.withPracticeFiles(distRoot, input0, prof, ids);
    const res = input.assessmentProfile.practiceResources;
    res[0].title = 'Worked example ventas';
    res[0].instructions = 'Lee el texto fuente antes de empezar y completa la columna Total.';
    eq(P.validateAssessmentProfile(input.assessmentProfile, { finalExam: true }), [], 'perfil válido');
    const built = await B.buildDynamicMbzV3(input);
    eq(built.expectations.internalVocabularyExempt, [], 'sin exenciones de dominio (el caso es real)');
    eq(built.expectations.internalVocabularyUserTexts, ['Lee el texto fuente antes de empezar y completa la columna Total.', 'Worked example ventas'], 'textos del usuario protegidos');
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    const z = await JSZip.loadAsync(built.mbz);
    const all = (await Promise.all(Object.keys(z.files).filter((f) => /^activities\/.+\.xml$/.test(f)).map((f) => z.file(f).async('string')))).map(unxml).join('\n');
    assert(all.includes('Worked example ventas'), 'el título del archivo queda como lo escribió el usuario');
    assert(all.includes('Lee el texto fuente antes de empezar'), 'las instrucciones quedan tal cual');
    // Sin las expectativas nuevas (paquete de antes de r1) el mismo .mbz sí habría fallado: prueba que el caso es real.
    const { internalVocabularyUserTexts, ...old } = built.expectations;
    void internalVocabularyUserTexts;
    const vOld = await V.validateMbzV3(built.mbz, old);
    assert(vOld.issues.some((i) => i.code === 'INTERNAL_VOCABULARY'), 'sin la exención el validador lo rechazaba');
  });

  await check('I2 el texto GENERADO sigue juzgándose: la fuga en una experiencia se repara (aviso) y una fuga inyectada en un label generado → INTERNAL_VOCABULARY', async () => {
    const input = userCourse();
    const [chId, exp] = Array.from(input.contents.experiences.entries())[1];
    const e = JSON.parse(JSON.stringify(exp));
    e.movements.closing.find((c) => c.type === 'reflection').prompt = 'Piensa en la situación ilustrativa del worked_example y en lo que harías distinto.';
    input.contents.experiences.set(chId, e);
    const built = await B.buildDynamicMbzV3(input);
    assert(built.summary.warnings.includes('internal_vocabulary_repaired:worked_example:1'), JSON.stringify(built.summary.warnings));
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    const z = await JSZip.loadAsync(built.mbz);
    let target = null;
    for (const p of Object.keys(z.files).filter((x) => /activities\/label_\d+\/label\.xml$/.test(x))) {
      const x = await z.file(p).async('string');
      if (/cvc-bridge|Para reflexionar/.test(x) && x.includes('&lt;span class=&quot;nolink&quot;&gt;')) { target = p; break; }
    }
    assert(target, 'label generado con texto');
    const x = await z.file(target).async('string');
    const i = x.indexOf('&lt;span class=&quot;nolink&quot;&gt;') + '&lt;span class=&quot;nolink&quot;&gt;'.length;
    z.file(target, x.slice(0, i) + 'Revisa el texto fuente y el worked example. ' + x.slice(i));
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const v2 = await V.validateMbzV3(bad, built.expectations);
    assert(v2.issues.some((s) => s.code === 'INTERNAL_VOCABULARY' && /texto fuente/.test(s.message)), JSON.stringify(v2.issues.slice(0, 4)));
  });

  await check('I2 reparación: un texto generado que CITA el título del usuario no lo reescribe (tramo protegido); el resto sí', async () => {
    const prot = VC.protectedVocabularyTexts(['Worked example ventas', 'Sin términos internos'], []);
    eq(prot, ['Worked example ventas'], 'solo los fragmentos con términos');
    const r = VC.repairInternalVocabularyDeep({ text: 'Abre «Worked example ventas» y revisa el worked_example del capítulo.' }, [], { protectedTexts: prot });
    eq(r.value.text, 'Abre «Worked example ventas» y revisa el ejemplo resuelto del capítulo.', 'protegido');
    eq(VC.stripProtectedVocabularyTexts('Archivo: Worked  example ventas. Revisa el worked_example.', prot).includes('worked_example'), true, 'strip conserva lo generado');
    eq(VC.lintInternalVocabulary(VC.stripProtectedVocabularyTexts('Archivo: Worked example ventas', prot)), [], 'strip quita lo del usuario');
  });

  // ════ I3 — límite de largo ══════════════════════════════════════════════
  await check('I3 noGrowth: nunca alarga (caracteres ni palabras) — rótulo completo si entra, corto si no, original (kept) si tampoco', async () => {
    const r1 = VC.repairInternalVocabularyDeep({ a: 'Haz el self_check ahora.' }, [], { noGrowth: true });
    eq([r1.value.a, r1.shortened, r1.kept], ['Haz la prueba ahora.', ['self_check'], []], 'corto');
    const r2 = VC.repairInternalVocabularyDeep({ a: 'Vuelve al self_check.' }, [], { noGrowth: true });
    eq([r2.value.a, r2.kept], ['Vuelve al self_check.', ['self_check']], 'a la prueba suma una palabra → original');
    const r3 = VC.repairInternalVocabularyDeep({ a: 'Repasa las case_scenarios hoy.' }, [], { noGrowth: true });
    eq(r3.value.a.includes('case_scenario'), false, 'el completo que no alarga se usa');
    const r4 = VC.repairInternalVocabularyDeep({ a: 'Haz el self_check ahora.' });
    eq(r4.value.a, 'Haz la autoevaluación ahora.', 'sin noGrowth: rótulo completo (igual que antes)');
  });

  await check('I3 builder: competencia EXACTAMENTE en su límite (300) con «self_check» → antes TEXT_TOO_LONG; ahora se arma con el rótulo corto (aviso); una con «al self_check» queda original con aviso y su regla no bloquea; el validador en verde', async () => {
    const LIM = 300;
    const pad = (s) => s + ' ' + 'x'.repeat(LIM - Array.from(s).length - 2) + '.';
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const ci = JSON.parse(JSON.stringify(input.contents.courseIntro));
    ci.competencies[0] = pad('Aplicar el self_check de cada capítulo para comprobar lo aprendido');
    eq(Array.from(ci.competencies[0]).length, LIM, 'exactamente en el límite');
    input.contents.courseIntro = ci;
    // Sin la red de I3, la reparación completa lo habría empujado a 304 caracteres.
    const full = VC.repairInternalVocabularyDeep(ci.competencies[0]).value;
    assert(Array.from(full).length > LIM, `la reparación completa alarga: ${Array.from(full).length}`);
    const built = await B.buildDynamicMbzV3(input);
    assert(built.summary.warnings.includes('internal_vocabulary_short_label:self_check:1'), JSON.stringify(built.summary.warnings));
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    // Caso «kept»: ni el rótulo corto entra.
    const input2 = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const ci2 = JSON.parse(JSON.stringify(input2.contents.courseIntro));
    ci2.competencies[0] = pad('Volver al self_check de cada capítulo para comprobar lo aprendido');
    input2.contents.courseIntro = ci2;
    const built2 = await B.buildDynamicMbzV3(input2);
    assert(built2.summary.warnings.includes('internal_vocabulary_kept_length_limit:self_check:1'), JSON.stringify(built2.summary.warnings));
    assert(built2.expectations.internalVocabularyExempt.includes('self_check'), 'regla exenta en el validador');
    const v2 = await V.validateMbzV3(built2.mbz, built2.expectations);
    assert(v2.ok, JSON.stringify(v2.issues.slice(0, 4)));
    // Un error de largo SIN reparaciones sube igual (no se enmascara).
    const input3 = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const ci3 = JSON.parse(JSON.stringify(input3.contents.courseIntro));
    ci3.competencies[0] = 'y'.repeat(LIM + 1);
    input3.contents.courseIntro = ci3;
    let err = null;
    try { await B.buildDynamicMbzV3(input3); } catch (e) { err = e; }
    assert(err && /TEXT_TOO_LONG/.test(err.message), `sin reparaciones: ${err && err.message}`);
  });

  // ════ M1 — rúbrica sin solucionario ═════════════════════════════════════
  await check('M1 rúbrica: los niveles son genéricos desde el criterio — NINGUNA frase de la guía de corrección (solucionario) en grading.xml; el material docente empareja guía ↔ criterio por NOMBRE', async () => {
    const input = DF.withProfile(DF.courseInput(distRoot), DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true }));
    // Guía con frases únicas para poder buscarlas.
    for (const [k, doc] of input.contents.applications) {
      const d = JSON.parse(JSON.stringify(doc));
      d.solution.correctionGuide = d.solution.correctionGuide.map((g, i) => ({ ...g, achieved: `SOLUCIONARIO-L-${i} cumple todo el criterio.`, developing: `SOLUCIONARIO-P-${i} cumple en parte el criterio.`, insufficient: `SOLUCIONARIO-I-${i} no cumple el criterio.` }));
      input.contents.applications = new Map(input.contents.applications);
      input.contents.applications.set(k, d);
    }
    const built = await B.buildDynamicMbzV3(input);
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    const z = await JSZip.loadAsync(built.mbz);
    const gradings = Object.keys(z.files).filter((f) => /grading\.xml$/.test(f));
    assert(gradings.length > 0, 'hay rúbricas');
    for (const f of gradings) {
      const gx = await z.file(f).async('string');
      assert(!/SOLUCIONARIO-/.test(gx), `${f}: la rúbrica no lleva texto del solucionario`);
      for (const lvl of ['Insuficiente.', 'En proceso.', 'Logrado.']) assert(gx.includes(lvl), `${f}: nivel ${lvl}`);
    }
    // El solucionario (oculto) sí la conserva.
    const all = (await Promise.all(Object.keys(z.files).filter((f) => /page\.xml$/.test(f)).map((f) => z.file(f).async('string')))).join('');
    assert(/SOLUCIONARIO-L-0/.test(all), 'el solucionario docente la conserva');
    // Por nombre: guía en otro orden → cada entrada encuentra su criterio.
    const crit = [{ name: 'Análisis', weight: 40 }, { name: 'Solución', weight: 40 }, { name: 'Comunicación', weight: 20 }];
    eq(AA.criterionForGuide(crit, { criterion: 'Comunicación' }, 0).weight, 20, 'por nombre');
    eq(AA.criterionForGuide(crit, { criterion: 'Otro' }, 1).name, 'Solución', 'respaldo por posición');
    const rc = ASSIGN.rubricCriteriaFromApplication({ activity: { criteria: [{ name: 'Análisis', description: 'Identifica el problema.', weight: 40 }] }, solution: { correctionGuide: [{ criterion: 'Análisis', achieved: 'SECRETO', developing: 'SECRETO', insufficient: 'SECRETO' }] } });
    assert(!JSON.stringify(rc).includes('SECRETO'), 'rubricCriteriaFromApplication no lee el solucionario');
  });

  // ════ M2 — fecha límite ═════════════════════════════════════════════════
  await check('M2 fecha límite: clave ausente ≡ null (default: sin fecha, duedate 0); relativa = <startdate> del backup + N días (= original_course_startdate + N días)', async () => {
    const prof = DF.deliveryProfile(base, { graded: false });
    delete prof.applicationDelivery.dueOffsetDays;
    eq(AD.validateApplicationDelivery(prof.applicationDelivery), [], 'ausente válido');
    eq(P.normalizeAssessmentProfile(prof).applicationDelivery.dueOffsetDays, null, 'normalizado null');
    eq(ASSIGN.assignDueDate(1000, undefined), 0, 'undefined → 0');
    const b0 = await B.buildDynamicMbzV3(DF.withProfile(DF.courseInput(distRoot), prof));
    const z0 = await JSZip.loadAsync(b0.mbz);
    const a0 = Object.keys(z0.files).filter((f) => /assign\.xml$/.test(f));
    assert(a0.length > 0, 'hay Tareas');
    for (const f of a0) eq(tag(await z0.file(f).async('string'), 'duedate'), '0', `${f} sin fecha`);
    eq((await V.validateMbzV3(b0.mbz, b0.expectations)).ok, true, 'validador sin fecha');
    const input = DF.withProfile(DF.courseInput(distRoot), DF.deliveryProfile(base, { graded: false, dueOffsetDays: 21 }));
    const b1 = await B.buildDynamicMbzV3(input);
    const z1 = await JSZip.loadAsync(b1.mbz);
    const course = await z1.file('course/course.xml').async('string');
    const start = Number(tag(course, 'startdate'));
    eq(Number(tag(await z1.file('moodle_backup.xml').async('string'), 'original_course_startdate')), start, 'mismo inicio en el backup');
    for (const f of Object.keys(z1.files).filter((x) => /assign\.xml$/.test(x))) eq(Number(tag(await z1.file(f).async('string'), 'duedate')) - start, 21 * 86400, `${f}: inicio + 21 días`);
    eq((await V.validateMbzV3(b1.mbz, b1.expectations)).ok, true, 'validador relativa');
  });

  // ════ G — Tarea formativa vs calificada en el libro de notas ═════════════
  await check('G Tarea FORMATIVA: sin ítem de nota (no puede afectar la nota); CALIFICADA: ítem en su categoría con aggregateonlygraded=0 (sin calificar cuenta 0, documentado)', async () => {
    const bf = await B.buildDynamicMbzV3(DF.withProfile(DF.courseInput(distRoot), DF.deliveryProfile(base, { graded: false })));
    const zf = await JSZip.loadAsync(bf.mbz);
    for (const f of Object.keys(zf.files).filter((x) => /^activities\/assign_\d+\/grades\.xml$/.test(x))) {
      assert(!/<grade_item /.test(await zf.file(f).async('string')), `${f}: formativa sin ítem de nota`);
    }
    const bg = await B.buildDynamicMbzV3(DF.withProfile(DF.courseInput(distRoot), DF.deliveryProfile(base, { graded: true, category: 'applications' })));
    const gb = await (await JSZip.loadAsync(bg.mbz)).file('gradebook.xml').async('string');
    const cat = /<grade_category id="5">[\s\S]*?<\/grade_category>/.exec(gb);
    assert(cat && /<aggregateonlygraded>0<\/aggregateonlygraded>/.test(cat[0]), 'categoría de AA con aggregateonlygraded=0');
  });

  // ════ M9 — enlaces muertos ══════════════════════════════════════════════
  await check('M9 enlace muerto: href="#" / vacío / javascript: → se desenvuelve (queda el texto), XML sin enlaces muertos intacto byte a byte', async () => {
    eq(DEAD.unwrapDeadAnchorsHtml('<p>Ver <a href="#" style="color:red">el Libro</a> y <a href="$@PAGEVIEWBYID*3@$">esto</a></p>'), { html: '<p>Ver el Libro y <a href="$@PAGEVIEWBYID*3@$">esto</a></p>', count: 1 }, 'html');
    eq(DEAD.unwrapDeadAnchorsHtml("<a href=''>x</a><a href=\"javascript:void(0)\">y</a><a href=\"#sec\">z</a>").html, 'xy<a href="#sec">z</a>', 'vacío y javascript');
    const xml = '<label><intro>&lt;p&gt;&lt;a href=&quot;#&quot;&gt;Abrir &amp;amp; ver&lt;/a&gt;&lt;/p&gt;</intro><name>n</name></label>';
    eq(DEAD.repairDeadAnchorsInActivityXml(xml), { xml: '<label><intro>&lt;p&gt;Abrir &amp;amp; ver&lt;/p&gt;</intro><name>n</name></label>', count: 1 }, 'xml');
    const clean = '<label><intro>&lt;a href=&quot;$@PAGEVIEWBYID*3@$&quot;&gt;x&lt;/a&gt;</intro></label>';
    assert(DEAD.repairDeadAnchorsInActivityXml(clean).xml === clean, 'sin enlaces muertos: idéntico');
  });

  await check('M9 builder: un botón cuyo destino quedó en "#" (contenido viejo) ya no bloquea el re-empaque: se desenvuelve con aviso dead_link_unwrapped y el validador queda en verde; un token $@…@$ sin resolver SIGUE fallando', async () => {
    const H = L('modules/course-shell/html.js');
    const orig = H.link;
    try {
      H.link = (h, href, text, s, opts) => orig(h, /^\$@RESOURCEVIEWBYID\*/.test(href) && /Libro/.test(text) ? '#' : href, text, s, opts);
      const built = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true }));
      assert(built.summary.warnings.some((w) => /^dead_link_unwrapped:\d+$/.test(w)), JSON.stringify(built.summary.warnings));
      const z = await JSZip.loadAsync(built.mbz);
      const xmls = (await Promise.all(Object.keys(z.files).filter((f) => /^activities\/.+\.xml$/.test(f)).map((f) => z.file(f).async('string')))).map(unxml).join('\n');
      assert(!/href\s*=\s*["']#["']/.test(xmls), 'ningún href="#" en el paquete');
      assert(/Abrir Libro Gu/.test(xmls), 'el texto del botón queda');
      const v = await V.validateMbzV3(built.mbz, built.expectations);
      // Solo queda el hallazgo ESTRUCTURAL de ese botón en particular (el validador exige el enlace al Libro): ningún
      // enlace muerto (TOKEN_INVALID) — antes de r1 este mismo contenido fallaba por el enlace muerto.
      eq([...new Set(v.issues.map((i) => i.code))], ['LIBRO_CTA'], `hallazgos: ${JSON.stringify(v.issues.slice(0, 3))}`);
      H.link = (h, href, text, s, opts) => orig(h, /^\$@RESOURCEVIEWBYID\*/.test(href) && /Libro/.test(text) ? '$@RESOURCEVIEWBYID*999999@$' : href, text, s, opts);
      let err = null;
      try { await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true })); } catch (e) { err = e; }
      assert(err && /MBZ_V3_TOKEN_INVALID/.test(err.message), `token sin resolver: ${err && err.message}`);
    } finally {
      H.link = orig;
    }
    // Sin enlaces muertos: el paquete de siempre (sin aviso).
    const plain = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true }));
    assert(!plain.summary.warnings.some((w) => /^dead_link_unwrapped/.test(w)), 'sin aviso');
    void crypto;
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
