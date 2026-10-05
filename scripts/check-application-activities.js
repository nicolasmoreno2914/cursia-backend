#!/usr/bin/env node
/* eslint-disable no-console */
// Fase 2 · Actividades de Aplicación — Loop A1 (modelo). USD 0: sin proveedores, sin base real.
//
//   AA1  Blueprint: `applicationMinutes` SOLO en capítulos con actividad (orden canónico); minutos inválidos
//        rechazados en entrada, builder y snapshot; `applicationContext` congelado SOLO si hay alguna actividad
//   AA2  Manifest v3: application_activity:<ch> después de activity y antes de audiobook_chapter; contenido →
//        dependsOn [content]; práctica → content del módulo; nunca agrega video / presentación / audiolibro;
//        fuera de exámenes; totals.applicationActivityCount solo con actividades
//   AA3  validador del Manifest: minutos cambiados, item de más, item faltante y totales → errores
//   AA4  tiempo: los minutos entran en chapterEstimatedMinutes y courseEstimatedHours (corta 30, estándar 60,
//        larga 120; también en práctica)
//   AA5  costo: solo operaciones de Anthropic; Gamma, Videogen y TTS idénticos; costo por actividad acotado
//   AA6  invalidación: agregar / cambiar minutos / cambiar resultados de aprendizaje / editar el capítulo /
//        quitar → SOLO la actividad (nada pagado, nada del Libro)
//   AA7  cascada: regenerar el content regenera la actividad del capítulo y las de la práctica del módulo
//   AA8  regresión: sin actividades, Blueprint, Manifest, huellas y plan de empaque de siempre
//   AA9  distribuidor: las actividades se generan (horas generables = horas del diseño) y la propuesta
//        materializada trae sus items y sus horas
//   AA10 guarda de esquema: sin la columna application_minutes, escribir los minutos responde 503
//   AA11 empaque (h5p y scorm, con práctica): página del estudiante visible (sin respuestas, con PDF imprimible),
//        solucionario docente OCULTO (con su PDF), badge con los minutos de la actividad; .mbz válido
//   AA12 el validador del .mbz detecta: solucionario visible, respuestas en la página del estudiante, actividad
//        faltante, PDF faltante
//   AA13 la secuencia de la sección = Manifest + chapterSlotSequence (instrucción → actividad → solucionario)
//   AA14 PDF imprimible: páginas reales = páginas con contenido (sin hojas en blanco), bytes deterministas, renglones
//        para responder; el del estudiante sin respuestas
//
// Uso: node scripts/check-application-activities.js [path/to/dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const P = loadDist('modules/pedagogy/index.js');
const ST = loadDist('modules/study-time/index.js');
const FP = loadDist('modules/invalidation/fingerprints.js');
const PV3 = loadDist('modules/invalidation/plan-v3.js');
const RES = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const PLAN = loadDist('modules/dynamic-packaging/packaging-plan-v3.js');
const CASCADE = loadDist('modules/dynamic-generation/regeneration-cascade.js');
const GUARD = loadDist('modules/course-structure/v21-schema-guard.js');
const SHELL = loadDist('modules/course-shell/index.js');
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PROF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
function eq(a, b, m) {
  const A = JSON.stringify(a);
  const B2 = JSON.stringify(b);
  if (A !== B2) throw new Error(`${m}: esperado ${B2}, encontrado ${A}`);
}
function throwsRe(fn, re, m) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  assert(msg !== null, `${m}: no falló`);
  assert(re.test(msg), `${m}: mensaje inesperado «${msg}»`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const PR1 = '9b0d1f00-0000-4000-8000-0000000001a9';
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PROF.profiles[k].primaryApproach, secondaryApproaches: PROF.profiles[k].secondaryApproaches,
  learner: PROF.learner, learningOutcomes: PROF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
const CTX = { learner: PROF.learner, learningOutcomes: PROF.outcomes };
const srcOf = (bp, n = 1) => ({ courseId: bp.course.id, blueprintId: n, blueprintNumber: n, blueprintSha256: SNAP.snapshotSha256V2(bp) });
const manifestOf = (bp, n = 1, atr = 2) => MB.buildGenerationManifestV3(bp, srcOf(bp, n), { activityTypeRules: atr });
/** Rebuild con filas modificadas (mismo diseño pedagógico, contexto opcional). */
function rebuild(bp, mutate, ctx = CTX) {
  const r = SNAP.snapshotV2ToRows(bp);
  mutate(r);
  return SNAP.buildBlueprintSnapshotV2({ ...r.course, applicationContext: ctx }, r.modules, r.chapters, r.pedagogy);
}
const plainRcp = () => P.snapshotFromStructure((() => { const s = clone(RCP); s.course.reviewCards = true; return s; })());
const C = (bp, mi, ci) => bp.modules[mi].chapters[ci].id;
/** RCP + «Repaso» + actividad estándar en el capítulo 1, corta en el 2, larga en el 3 + práctica con actividad en el módulo 1. */
function rcpWithApplications() {
  const base = plainRcp();
  return rebuild(base, (r) => {
    const m0 = base.modules[0];
    r.chapters = r.chapters.map((c) => (c.id === C(base, 0, 0) ? { ...c, application_minutes: 60 } : c.id === C(base, 0, 1) ? { ...c, application_minutes: 30 } : c.id === C(base, 0, 2) ? { ...c, application_minutes: 120 } : c));
    r.chapters.push({ id: PR1, module_id: m0.id, position: 99, title: 'Práctica integradora', objective: null, description: null, video_enabled: false, activity_enabled: true, chapter_kind: 'practice', application_minutes: 60 });
  });
}

(async () => {
  const bp = rcpWithApplications();
  const m = manifestOf(bp);
  const contentOf = (mi) => bp.modules[mi].chapters.filter((c) => c.kind !== 'practice').map((c) => `content:${c.id}`);

  await check('AA1 Blueprint: clave solo con actividad, orden canónico, minutos inválidos rechazados, contexto solo con actividades', () => {
    const chs = bp.modules.flatMap((x) => x.chapters);
    eq(chs.filter((c) => 'applicationMinutes' in c).map((c) => c.applicationMinutes), [60, 30, 120, 60], 'solo los capítulos con actividad');
    eq(Object.keys(chs.find((c) => c.id === PR1)), ['id', 'position', 'title', 'objective', 'videoEnabled', 'activityEnabled', 'kind', 'applicationMinutes'], 'orden canónico (después de kind)');
    eq(SNAP.validateBlueprintSnapshotV2(bp), [], 'snapshot válido');
    eq(SNAP.snapshotSha256V2(SNAP.recanonicalizeBlueprintSnapshotV2(clone(bp))), SNAP.snapshotSha256V2(bp), 'jsonb → canónico');
    eq(Object.keys(bp.course.applicationContext), ['learner', 'learningOutcomes'], 'contexto congelado');
    eq(bp.course.applicationContext.learningOutcomes.do, PROF.outcomes.do, 'resultados «hacer»');
    // Sin actividades: el contexto NO entra (sha de siempre aunque el perfil lo tenga).
    const noApp = rebuild(plainRcp(), () => {});
    eq('applicationContext' in noApp.course, false, 'sin actividades no hay contexto');
    eq(SNAP.snapshotSha256V2(noApp), SNAP.snapshotSha256V2(plainRcp()), 'sha de siempre');
    // Minutos inválidos: entrada, builder y snapshot adulterado.
    const r = SNAP.snapshotV2ToRows(bp);
    r.chapters[0] = { ...r.chapters[0], application_minutes: 45 };
    eq(SNAP.validateBlueprintInputV2(r.course, r.modules, r.chapters).map((e) => e.code), ['INVALID_APPLICATION_MINUTES'], 'entrada');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters, r.pedagogy), /INVALID_INPUT: .*Actividad de Aplicación inválidos \(45/, 'builder');
    const bad = clone(bp);
    bad.modules[0].chapters[0].applicationMinutes = 15;
    assert(SNAP.validateBlueprintSnapshotV2(bad).some((e) => e.code === 'INVALID_APPLICATION_MINUTES'), 'snapshot adulterado');
    const orphanCtx = clone(noApp);
    orphanCtx.course.applicationContext = clone(bp.course.applicationContext);
    assert(SNAP.validateBlueprintSnapshotV2(orphanCtx).some((e) => e.code === 'APPLICATION_CONTEXT_WITHOUT_ACTIVITY'), 'contexto sin actividades');
    // Contexto vacío (perfil sin estudiante ni resultados) → no se congela nada.
    const empty = rebuild(plainRcp(), (x) => { x.chapters[0] = { ...x.chapters[0], application_minutes: 60 }; }, { learner: {}, learningOutcomes: { know: [], do: [], competencies: [] } });
    eq('applicationContext' in empty.course, false, 'contexto vacío');
  });

  await check('AA2 Manifest v3: lugar, dependencias, práctica sin audiovisual, fuera de exámenes, totales', () => {
    const c0 = C(bp, 0, 0);
    const keys = m.items.filter((i) => i.chapterId === c0).map((i) => i.type);
    eq(keys.slice(-2), ['application_activity', 'audiobook_chapter'], 'después de activity, antes del audiolibro');
    const app0 = m.items.find((i) => i.key === `application_activity:${c0}`);
    eq([app0.dependsOn, app0.applicationMinutes, app0.scope], [[`content:${c0}`], 60, 'chapter'], 'contenido');
    const pr = m.items.filter((i) => i.chapterId === PR1);
    eq(pr.map((i) => i.type), ['experience', 'activity', 'application_activity'], 'práctica: sin content/presentación/video/audiolibro');
    eq(pr[2].dependsOn, contentOf(0), 'práctica: content del módulo');
    eq(m.modules[0].chapters.find((c) => c.chapterId === PR1), { chapterId: PR1, position: bp.modules[0].chapters.find((c) => c.id === PR1).position, chapterNumber: 4, videoEnabled: false, activityEnabled: true, kind: 'practice', applicationMinutes: 60 }, 'modules[] del Manifest');
    for (const e of m.items.filter((i) => i.type === 'exam' || i.type === 'final_exam')) assert(!e.dependsOn.some((d) => d.startsWith('application_activity:')), `${e.key} no depende de actividades`);
    eq(m.totals.applicationActivityCount, 4, 'totals');
    eq(Object.keys(m.totals).slice(-2), ['totalJobs', 'applicationActivityCount'], 'clave opcional al final');
    eq(MB.validateGenerationManifestV3(m, bp, srcOf(bp)), [], 'Manifest válido');
    eq(MB.canonicalManifestJsonV3(JSON.parse(MB.canonicalManifestJsonV3(m))), MB.canonicalManifestJsonV3(m), 'canónico estable');
    // Exámenes y FinOps solo cuentan capítulos de contenido (la actividad no cambia el examen).
    const plainM = manifestOf(plainRcp());
    eq(m.items.filter((i) => i.type === 'exam').map((i) => i.dependsOn), plainM.items.filter((i) => i.type === 'exam').map((i) => i.dependsOn), 'exámenes iguales');
  });

  await check('AA3 validador del Manifest: minutos cambiados, item de más, faltante y totales', () => {
    const codes = (man) => MB.validateGenerationManifestV3(man, bp, srcOf(bp)).map((e) => e.code);
    const t1 = clone(m);
    t1.items.find((i) => i.type === 'application_activity').applicationMinutes = 90;
    assert(codes(t1).includes('WRONG_APPLICATION_MINUTES'), `minutos: ${codes(t1)}`);
    const t2 = clone(m);
    const c1 = C(bp, 1, 0);
    const extra = { ...clone(t2.items.find((i) => i.key === `activity:${c1}`)), key: `application_activity:${c1}`, type: 'application_activity', applicationMinutes: 60 };
    delete extra.variant; delete extra.h5pType; delete extra.design;
    t2.items.push(extra);
    assert(codes(t2).includes('APPLICATION_NOT_ENABLED'), `de más: ${codes(t2)}`);
    const t3 = clone(m);
    t3.items = t3.items.filter((i) => i.key !== `application_activity:${PR1}`);
    assert(codes(t3).includes('MISSING_APPLICATION_ACTIVITY'), `faltante: ${codes(t3)}`);
    const t4 = clone(m);
    t4.totals.applicationActivityCount = 3;
    assert(codes(t4).includes('TOTALS_MISMATCH'), 'totales');
    const t5 = clone(m);
    t5.items.find((i) => i.type === 'experience').applicationMinutes = 60;
    assert(codes(t5).includes('UNEXPECTED_APPLICATION_MINUTES'), 'minutos en otro tipo');
  });

  await check('AA4 tiempo: los minutos entran al capítulo y al curso (corta, estándar, larga y en práctica)', () => {
    const est = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(m, bp));
    const plainBp = plainRcp();
    const est0 = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(manifestOf(plainBp), plainBp));
    const ch = (e, id) => e.modules.flatMap((x) => x.chapters).find((c) => c.chapterId === id);
    for (const [ci, min] of [[0, 60], [1, 30], [2, 120]]) {
      const id = C(bp, 0, ci);
      const app = ch(est, id).resources.find((r) => r.resource === 'application_activity');
      eq([app && app.minutes, app && app.component], [min, 'application'], `capítulo ${ci + 1}`);
      eq(Math.round((ch(est, id).chapterEstimatedMinutes - ch(est0, id).chapterEstimatedMinutes) * 10) / 10, min, `capítulo ${ci + 1}: +${min} min`);
    }
    const pr = ch(est, PR1);
    eq(pr.resources.map((r) => r.resource), ['practice_page', 'activity', 'review', 'application_activity'], 'práctica + actividad');
    eq(est.byComponent.application, 60 + 30 + 120 + 60, 'componente aplicación');
    assert(est.courseEstimatedHours > est0.courseEstimatedHours + 4.5, `curso: ${est0.courseEstimatedHours} → ${est.courseEstimatedHours}`);
  });

  await check('AA5 costo: solo Anthropic; Gamma, Videogen y TTS idénticos; costo por actividad acotado', () => {
    const one = rebuild(plainRcp(), (r) => { r.chapters = r.chapters.map((c) => (c.id === C(plainRcp(), 0, 0) ? { ...c, application_minutes: 60 } : c)); });
    const a = P.providerPlanFor(manifestOf(one));
    const b = P.providerPlanFor(manifestOf(plainRcp()));
    for (const prov of ['gamma', 'videogen', 'openai', 'youtube']) eq(JSON.stringify(a.byProvider[prov] || {}), JSON.stringify(b.byProvider[prov] || {}), `${prov} igual`);
    eq(a.byProvider.anthropic.operations['llm.application_activity'], 1, 'una operación de actividad');
    const delta = Number(a.estimateUsd.expected) - Number(b.estimateUsd.expected);
    assert(delta > 0.05 && delta < 0.5, `una actividad ≈ USD ${delta.toFixed(3)}`);
  });

  await check('AA6 invalidación: agregar, cambiar minutos, cambiar resultados, editar el capítulo y quitar → solo la actividad', () => {
    const itemsOf = (man) => man.items.map((it) => ({
      itemKey: it.key, itemRunId: `A#${it.key}`, status: 'completed', artifactIds: RES.requiredArtifactTypesV3(it.type, it.variant).map((r) => `A|${it.key}|${r}`),
      artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/A/${it.key}`,
      ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/A/video:${it.chapterId}` } : {}),
    }));
    const plan = (a, b) => {
      const ma = manifestOf(a, 1);
      const mb = manifestOf(b, 2);
      return PV3.computeInvalidationPlanV3({ from: { blueprint: a, manifest: ma, items: itemsOf(ma) }, to: { blueprint: b, manifest: mb } })
        .actions.filter((x) => x.action !== 'REUSE').map((x) => `${x.itemKey}=${x.action}:${x.reasons.join('+')}`).sort();
    };
    const notText = /^(presentation|video|video_interactions|audiobook_chapter|content|experience|activity|exam|final_exam|module_intro|course_plan|course_intro|audio_welcome):/;
    const c0 = C(bp, 0, 0);
    // Agregar una actividad a un capítulo existente: solo GENERATE de esa actividad.
    const without = rebuild(bp, (r) => { r.chapters = r.chapters.map((c) => (c.id === c0 ? { ...c, application_minutes: null } : c)); });
    const add = plan(without, bp);
    eq(add, [`application_activity:${c0}=GENERATE:application_toggled_on`], 'agregar');
    // Cambiar los minutos: solo esa actividad se rehace.
    const longer = rebuild(bp, (r) => { r.chapters = r.chapters.map((c) => (c.id === c0 ? { ...c, application_minutes: 90 } : c)); });
    eq(plan(bp, longer), [`application_activity:${c0}=REGENERATE:application_frame_changed`], 'cambiar minutos');
    // Cambiar los resultados de aprendizaje: todas las actividades (y nada más).
    const ctx2 = { learner: PROF.learner, learningOutcomes: { ...PROF.outcomes, do: [...PROF.outcomes.do, 'Coordinar un equipo de reanimación'] } };
    const outc = plan(bp, rebuild(bp, () => {}, ctx2));
    eq(outc.map((x) => x.split('=')[0]).sort(), bp.modules.flatMap((x) => x.chapters).filter((c) => c.applicationMinutes).map((c) => `application_activity:${c.id}`).sort(), 'resultados → todas las actividades');
    assert(outc.every((x) => /REGENERATE:application_frame_changed/.test(x)), 'motivo');
    // Editar el título del capítulo: su Libro, página, etc. como siempre + su actividad; nunca un proveedor por la actividad.
    const ed = plan(bp, rebuild(bp, (r) => { r.chapters = r.chapters.map((c) => (c.id === c0 ? { ...c, title: 'Reconocer el paro (revisado)' } : c)); }));
    assert(ed.includes(`application_activity:${c0}=REGENERATE:content_regenerated`), `editar: ${ed.join(' | ')}`);
    // La práctica del módulo 1 también (su fuente cambió).
    assert(ed.includes(`application_activity:${PR1}=REGENERATE:practice_sources_changed`), 'práctica del módulo');
    // Quitar: SOFT_DISABLE (recuperable) y nada más.
    eq(plan(bp, without), [`application_activity:${c0}=SOFT_DISABLE:application_toggled_off`], 'quitar');
    // Ningún cambio de actividad toca trabajos pagos o de texto ajenos.
    for (const p of [add, plan(bp, longer)]) assert(p.every((x) => !notText.test(x)), `solo actividades: ${p.join(' | ')}`);
  });

  await check('AA7 cascada: regenerar el content regenera la actividad del capítulo y la de la práctica del módulo', () => {
    const c1 = C(bp, 0, 1);
    const c = CASCADE.regenerationCascade(3, m.items, { key: `content:${c1}`, type: 'content', moduleId: bp.modules[0].id, chapterId: c1 });
    assert(c.regenerate.includes(`application_activity:${c1}`) && c.regenerate.includes(`application_activity:${PR1}`), c.regenerate.join(', '));
    assert(!c.stale.some((k) => k.startsWith('application_activity:')), 'nunca stale (es texto)');
  });

  await check('AA8 regresión: sin actividades, Blueprint, Manifest, huellas y plan de empaque de siempre', () => {
    const plain = plainRcp();
    assert(plain.modules.every((x) => x.chapters.every((c) => !('applicationMinutes' in c))), 'sin clave');
    const pm = manifestOf(plain);
    eq('applicationActivityCount' in pm.totals, false, 'totals sin clave');
    assert(pm.modules.every((x) => x.chapters.every((c) => !('applicationMinutes' in c))), 'modules[] sin clave');
    eq(FP.computeFingerprintsV3(plain).application.size, 0, 'sin huellas de actividad');
    const pl = PLAN.buildPackagingPlanV3(pm, plain);
    assert(pl.modules.every((x) => x.chapters.every((c) => !('applicationMinutes' in c) && !('application' in c.keys))), 'plan de empaque de siempre');
    const withApp = PLAN.buildPackagingPlanV3(m, bp);
    eq(withApp.modules[0].chapters.filter((c) => c.keys.application).map((c) => [c.applicationMinutes, c.keys.application]), bp.modules[0].chapters.filter((c) => c.applicationMinutes).map((c) => [c.applicationMinutes, `application_activity:${c.id}`]), 'plan con actividades');
  });

  await check('AA9 distribuidor: las actividades se generan y la propuesta materializada trae sus items y sus horas', () => {
    const s = clone(RCP);
    s.course.reviewCards = true;
    for (const h of [20, 33, 50]) {
      const d = P.runPedagogyDryRun({ structure: clone(s), profile: profileOf('competencias', { targetHours: h }), activityTypeRules: 2 }).distribution;
      eq(d.generableHours, d.estimatedHours, `${h} h: generable = diseño`);
      eq(d.materialized.manifestErrors, [], `${h} h: Manifest válido`);
      eq(d.materialized.totals.applicationActivityCount || 0, d.counts.applicationActivities, `${h} h: items = actividades del diseño`);
      assert(Math.abs(d.materialized.generableHours - d.estimatedHours) <= 0.1, `${h} h: horas del Manifest ${d.materialized.generableHours} vs ${d.estimatedHours}`);
      assert(!d.recommendations.some((r) => /todavía no se generan|se genera más adelante/.test(r)), `${h} h: sin textos de Fase 1`);
    }
  });

  await check('AA10 guarda de esquema: sin application_minutes una escritura con minutos responde 503; con ella pasa', async () => {
    GUARD._resetApplicationSchemaGuardForTests();
    let err = null;
    try { await GUARD.assertApplicationActivitySchema({ query: async () => [] }); } catch (e) { err = e; }
    assert(err && err.getStatus && err.getStatus() === 503 && /schema_not_migrated_application/.test(JSON.stringify(err.getResponse())), `503: ${err && err.message}`);
    await GUARD.assertApplicationActivitySchema({ query: async () => [{ '?column?': 1 }] });
    let calls = 0;
    await GUARD.assertApplicationActivitySchema({ query: async () => { calls++; return []; } });
    eq(calls, 0, 'el positivo queda cacheado');
    GUARD._resetApplicationSchemaGuardForTests();
    void SHELL;
  });

  const B = loadDist('package/dynamic-mbz-builder-v3.js');
  const VAL = loadDist('package/v3/mbz-validator-v3.js');
  const PF = require('./lib/v21-packaging-fixtures');
  const JSZip = require('jszip');
  const APP_MODULES = [
    { examEnabled: true, chapters: [{ video: true, activity: true, application: 60 }, { video: false, activity: true, application: 30 }, { practice: true, activity: true, application: 120 }] },
    { examEnabled: false, chapters: [{ video: true, activity: true }, { video: false, activity: false, application: 90 }] },
  ];
  const built = {};
  async function pkg(engine) {
    if (built[engine]) return built[engine];
    const input = PF.packagingInput(distRoot, { engine, finalExam: true, courseId: 640, modules: APP_MODULES });
    const r = await B.buildDynamicMbzV3(input);
    const zip = await JSZip.loadAsync(r.mbz);
    built[engine] = { input, r, zip };
    return built[engine];
  }
  const actsOf = async (zip) => {
    const mb = await zip.file('moodle_backup.xml').async('string');
    return [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9_]+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)].map((m) => ({ mid: Number(m[1]), sec: Number(m[2]), mod: m[3], title: m[4], dir: m[5] }));
  };
  const idnOf = async (zip, dir) => ((await zip.file(`${dir}/module.xml`).async('string')).match(/<idnumber>([^<]*)<\/idnumber>/) || [])[1];

  await check('AA11 empaque h5p y scorm: página visible sin respuestas + PDF, solucionario OCULTO + PDF, badge con minutos; .mbz válido', async () => {
    for (const engine of ['h5p', 'scorm']) {
      const { input, r, zip } = await pkg(engine);
      const v = await VAL.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `${engine}: validador ${JSON.stringify(v.issues.slice(0, 5))}`);
      const appChapters = input.manifest.modules.flatMap((m) => m.chapters).filter((c) => c.applicationMinutes !== undefined);
      eq(appChapters.length, 4, 'capítulos con actividad');
      const acts = await actsOf(zip);
      const files = await zip.file('files.xml').async('string');
      for (const c of appChapters) {
        const st = [];
        const so = [];
        for (const a of acts.filter((x) => x.mod === 'page')) {
          const idn = await idnOf(zip, a.dir);
          if (idn === `cv3:ch:${c.chapterId}:application`) st.push(a);
          if (idn === `cv3:ch:${c.chapterId}:application_solution`) so.push(a);
        }
        eq([st.length, so.length], [1, 1], `capítulo ${c.chapterNumber}: página + solucionario`);
        const vis = async (a) => ((await zip.file(`${a.dir}/module.xml`).async('string')).match(/<visible>(\d)<\/visible>/) || [])[1];
        eq([await vis(st[0]), await vis(so[0])], ['1', '0'], `capítulo ${c.chapterNumber}: estudiante visible, solucionario oculto`);
        const stHtml = await zip.file(`${st[0].dir}/page.xml`).async('string');
        const soHtml = await zip.file(`${so[0].dir}/page.xml`).async('string');
        const doc = input.contents.applications.get(c.chapterId);
        assert(stHtml.includes('Ejercicio 1') && stHtml.includes('Taller de aplicación') && stHtml.includes('Autoevaluación') && stHtml.includes('Criterios de evaluación'), 'estructura de la actividad');
        assert(!stHtml.includes(doc.solution.answers[0].answer.replace(/\./g, '')) && !/Solucionario|Respuesta:/.test(stHtml), 'sin respuestas en la página del estudiante');
        assert(soHtml.includes(doc.solution.answers[0].answer.slice(0, 20)) && soHtml.includes('Logrado') && soHtml.includes('Observaciones para el docente'), 'solucionario completo');
        assert(stHtml.includes(`capitulo-${c.chapterNumber}-actividad-de-aplicacion.pdf`) && soHtml.includes(`capitulo-${c.chapterNumber}-solucionario-docente.pdf`), 'enlaces a los PDF');
        assert(files.includes(`<filename>capitulo-${c.chapterNumber}-actividad-de-aplicacion.pdf</filename>`) && files.includes(`<filename>capitulo-${c.chapterNumber}-solucionario-docente.pdf</filename>`), 'PDF en files.xml');
      }
      // Minutos: facts del capítulo = base + actividad; la práctica nunca gana video/presentación/audiolibro.
      const facts = r.expectations.facts;
      for (const c of appChapters) {
        const fc = facts.chapters.find((x) => x.id === c.chapterId);
        eq(fc.applicationMinutes, c.applicationMinutes, 'facts con minutos');
        assert(fc.estimatedMinutes >= c.applicationMinutes + 10, `capítulo ${c.chapterNumber}: ${fc.estimatedMinutes} min incluye ${c.applicationMinutes}`);
      }
      const pr = facts.chapters.find((x) => x.kind === 'practice');
      eq([pr.videoEnabled, pr.slideCount], [false, 0], 'práctica sin video ni presentación');
      eq(facts.counts.applicationActivities, 4, 'facts.counts');
      assert(!acts.some((a) => a.mod === 'resource' && /actividad/i.test(a.title)), 'sin recursos sueltos');
    }
  });

  await check('AA12 el validador del .mbz detecta solucionario visible, respuestas filtradas, actividad faltante y PDF faltante', async () => {
    const { r, zip } = await pkg('h5p');
    const acts = await actsOf(zip);
    let solDir = null;
    let stDir = null;
    for (const a of acts.filter((x) => x.mod === 'page')) {
      const idn = await idnOf(zip, a.dir);
      if (/:application_solution$/.test(idn) && !solDir) solDir = a.dir;
      else if (/:application$/.test(idn) && !stDir) stDir = a.dir;
    }
    const tamper = async (fn) => {
      const z = await JSZip.loadAsync(r.mbz);
      await fn(z);
      const buf = await z.generateAsync({ type: 'nodebuffer' });
      return (await VAL.validateMbzV3(buf, r.expectations)).issues.map((i) => i.code);
    };
    const visible = await tamper(async (z) => { z.file(`${solDir}/module.xml`, (await z.file(`${solDir}/module.xml`).async('string')).replace('<visible>0</visible>', '<visible>1</visible>')); });
    assert(visible.includes('APPLICATION'), `solucionario visible: ${visible}`);
    const leak = await tamper(async (z) => { z.file(`${stDir}/page.xml`, (await z.file(`${stDir}/page.xml`).async('string')).replace('Ejercicio 1', 'Respuesta: 42 · Ejercicio 1')); });
    assert(leak.includes('APPLICATION'), `respuestas filtradas: ${leak}`);
    const pdf = await tamper(async (z) => { z.file(`${stDir}/page.xml`, (await z.file(`${stDir}/page.xml`).async('string')).replace(/@@PLUGINFILE@@\/capitulo-\d+-actividad-de-aplicacion\.pdf/, '#')); });
    assert(pdf.includes('APPLICATION'), `sin enlace al PDF: ${pdf}`);
    // Actividad faltante: facts con una actividad más que el paquete.
    const exp2 = JSON.parse(JSON.stringify(r.expectations));
    const noApp = exp2.facts.chapters.find((c) => c.applicationMinutes === undefined);
    noApp.applicationMinutes = 60;
    const miss = (await VAL.validateMbzV3(r.mbz, exp2)).issues.map((i) => i.code);
    assert(miss.includes('APPLICATION'), `actividad faltante: ${miss}`);
  });

  await check('AA13 secuencia de cada sección = Manifest + chapterSlotSequence (instrucción → actividad → solucionario)', async () => {
    const { input, zip } = await pkg('h5p');
    const want = PF.expectedSequence(distRoot, input);
    const acts = await actsOf(zip);
    const got = new Map();
    for (const a of acts) {
      const idn = await idnOf(zip, a.dir);
      if (!got.has(a.sec)) got.set(a.sec, []);
      got.get(a.sec).push(idn);
    }
    for (const [sec, ids] of want) eq(got.get(sec), ids, `sección ${sec}`);
    const appSec = want.find(([, ids]) => ids.some((x) => /:application$/.test(x)))[1];
    const i = appSec.findIndex((x) => /:application_instruction$/.test(x));
    eq([appSec[i + 1].split(':').pop(), appSec[i + 2].split(':').pop(), appSec[i + 3].split(':').pop()], ['application', 'application_solution', 'closing'], 'orden');
    eq(SHELL.chapterSlotSequence({ videoEnabled: false, activityEnabled: true, practice: true, application: true }), ['label:opening', 'label:deepening', 'label:synthesis', 'label:activity_instruction', 'activity', 'label:application_instruction', 'application', 'application_solution', 'label:closing'], 'práctica con actividad');
  });

  await check('AA14 PDF: sin hojas en blanco (pie dentro del margen), bytes deterministas, estudiante sin respuestas', async () => {
    const APDF = loadDist('package/v3/application-pdf.js');
    const TE = loadDist('modules/theme-engine/index.js');
    const theme = TE.resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
    for (const min of [30, 60, 90, 120]) {
      const doc = PF.applicationDoc('c-aa14', min, 2);
      const inp = { courseTitle: 'Curso', chapterNumber: 2, chapterTitle: 'Capítulo dos', doc, theme };
      for (const mode of ['student', 'teacher']) {
        const a = await APDF.renderApplicationPdf(inp, mode);
        const b = await APDF.renderApplicationPdf(inp, mode);
        assert(Buffer.compare(a.pdf, b.pdf) === 0, `${min}/${mode}: bytes deterministas`);
        const pages = (a.pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
        eq(pages, a.pages, `${min}/${mode}: páginas reales = informadas`);
        assert(a.pages >= 1 && a.pages <= 8, `${min}/${mode}: ${a.pages} páginas`);
      }
    }
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})();
