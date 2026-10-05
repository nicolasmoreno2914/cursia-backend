#!/usr/bin/env node
/* eslint-disable no-console */
// Motor de carga horaria — Loop 4: capítulo de PRÁCTICA (kind 'practice').
//
//   PC1  Blueprint: `kind` SOLO en capítulos de práctica; reglas (sin video; cada módulo con un capítulo de
//        contenido) en la entrada, el builder y el snapshot; ida y vuelta canónica
//   PC2  Manifest v3: la práctica produce SOLO experience (+ activity) con dependsOn = content de los capítulos
//        de contenido del módulo; sin content / presentation / video / audiobook; fuera de exam y final_exam
//   PC3  validador del Manifest: rechaza items de más o aristas cambiadas en la práctica
//   PC4  exámenes: el plan del banco (claim y validación) no incluye capítulos de práctica
//   PC5  tiempo y costo: el modelo de tiempo la cuenta como práctica (≈ 20 min); el costo no suma Gamma,
//        Videogen ni TTS por ella; el distribuidor y el Manifest dan las MISMAS horas
//   PC6  invalidación: agregar / quitar / editar práctica y editar sus fuentes regeneran SOLO lo debido,
//        nunca proveedores pagos
//   PC7  empaque: .mbz válido con práctica (h5p y scorm); sección sin presentación; Libro y audiolibro sin ella;
//        badge de minutos y studyTime
//   PC8  pedagogía: el diseño nunca le pone video a un capítulo de práctica (regla de producto > pedagogía)
//   PC9  regresión: cursos sin práctica → Blueprint, Manifest, huellas y .mbz de siempre
//
// Uso: node scripts/check-practice-chapter.js [path/to/dist]   (después de npm run build)
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
const V3 = loadDist('modules/course-shell/v3-validation.js');
const FP = loadDist('modules/invalidation/fingerprints.js');
const PV3 = loadDist('modules/invalidation/plan-v3.js');
const RES = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const PLAN = loadDist('modules/dynamic-packaging/packaging-plan-v3.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const VAL = loadDist('package/v3/mbz-validator-v3.js');
const SHELL = loadDist('modules/course-shell/index.js');
const PF = require('./lib/v21-packaging-fixtures');
const CASCADE = loadDist('modules/dynamic-generation/regeneration-cascade.js');
const GUARD = loadDist('modules/course-structure/v21-schema-guard.js');
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
const PR1 = '9b0d1f00-0000-4000-8000-000000000119';
const PR2 = '9b0d1f00-0000-4000-8000-000000000129';
/** RCP con «Repaso» + práctica integradora al cierre del módulo 1 y práctica de casos a mitad del módulo 2. */
function rcpWithPractice() {
  const s = clone(RCP);
  s.course.reviewCards = true;
  s.modules[0].chapters.push({ id: PR1, title: 'Práctica integradora: reconocimiento', kind: 'practice', activityEnabled: true });
  s.modules[1].chapters.splice(1, 0, { id: PR2, title: 'Práctica de casos: compresiones', kind: 'practice', activityEnabled: true });
  return s;
}
const srcOf = (bp, n = 1) => ({ courseId: bp.course.id, blueprintId: n, blueprintNumber: n, blueprintSha256: SNAP.snapshotSha256V2(bp) });
const manifestOf = (bp, n = 1, atr = 2) => MB.buildGenerationManifestV3(bp, srcOf(bp, n), { activityTypeRules: atr });
const profileOf = (k) => ({
  pedagogyProfileVersion: 1, primaryApproach: PROF.profiles[k].primaryApproach, secondaryApproaches: PROF.profiles[k].secondaryApproaches,
  learner: PROF.learner, learningOutcomes: PROF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
});
const contentIdsOf = (s, mi) => s.modules[mi].chapters.filter((c) => c.kind !== 'practice').map((c) => c.id);

(async () => {
  await check('PC1 Blueprint: kind solo en práctica; reglas en entrada, builder y snapshot; ida y vuelta canónica', () => {
    const bp = P.snapshotFromStructure(rcpWithPractice());
    const chs = bp.modules.flatMap((m) => m.chapters);
    eq(chs.filter((c) => 'kind' in c).map((c) => [c.id, c.kind]), [[PR1, 'practice'], [PR2, 'practice']], 'solo los de práctica llevan la clave');
    eq(chs.find((c) => c.id === PR1).videoEnabled, false, 'práctica sin video');
    eq(Object.keys(chs.find((c) => c.id === PR1)), ['id', 'position', 'title', 'objective', 'videoEnabled', 'activityEnabled', 'kind'], 'orden canónico');
    eq(SNAP.validateBlueprintSnapshotV2(bp), [], 'snapshot válido');
    eq(SNAP.snapshotSha256V2(SNAP.recanonicalizeBlueprintSnapshotV2(clone(bp))), SNAP.snapshotSha256V2(bp), 'jsonb → canónico');
    eq(SNAP.chapterKindOf({ kind: 'practice' }), 'practice', 'chapterKindOf');
    // Reglas.
    const rows = SNAP.snapshotV2ToRows(bp);
    const withVideo = rows.chapters.map((c) => (c.id === PR1 ? { ...c, video_enabled: true } : c));
    eq(SNAP.validateBlueprintInputV2(rows.course, rows.modules, withVideo).map((e) => e.code), ['PRACTICE_CHAPTER_VIDEO'], 'práctica con video (entrada)');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(rows.course, rows.modules, withVideo), /no puede tener video/, 'práctica con video (builder)');
    const onlyPractice = rows.chapters.map((c) => (c.module_id === rows.modules[2].id ? { ...c, chapter_kind: 'practice', video_enabled: false } : c));
    eq(SNAP.validateBlueprintInputV2(rows.course, rows.modules, onlyPractice).map((e) => e.code), ['PRACTICE_MODULE_WITHOUT_CONTENT'], 'módulo sin contenido');
    const weird = rows.chapters.map((c) => (c.id === PR1 ? { ...c, chapter_kind: 'taller' } : c));
    eq(SNAP.validateBlueprintInputV2(rows.course, rows.modules, weird).map((e) => e.code), ['INVALID_CHAPTER_KIND'], 'tipo inválido');
    const tampered = clone(bp);
    tampered.modules[0].chapters[3].videoEnabled = true;
    assert(SNAP.validateBlueprintSnapshotV2(tampered).some((e) => e.code === 'PRACTICE_CHAPTER_VIDEO'), 'snapshot adulterado');
  });

  const bp = P.snapshotFromStructure(rcpWithPractice());
  const m = manifestOf(bp);
  const items = (id) => m.items.filter((i) => i.chapterId === id);

  await check('PC2 Manifest v3: práctica = experience (+ activity) sobre los content del módulo; fuera de los exámenes', () => {
    eq(MB.validateGenerationManifestV3(m, bp, m.source), [], 'válido');
    for (const [id, mi] of [[PR1, 0], [PR2, 1]]) {
      const deps = contentIdsOf(bp, mi).map((x) => `content:${x}`);
      eq(items(id).map((i) => [i.type, i.dependsOn]), [['experience', deps], ['activity', deps]], `items de ${id}`);
      assert(items(id).find((i) => i.type === 'activity').h5pType, 'tipo h5p elegido');
    }
    eq(m.modules.flatMap((x) => x.chapters).filter((c) => c.kind).map((c) => c.chapterId), [PR1, PR2], 'kind en modules[]');
    for (const ex of m.items.filter((i) => i.type === 'exam' || i.type === 'final_exam')) {
      assert(!ex.dependsOn.some((d) => d.endsWith(PR1) || d.endsWith(PR2)), `${ex.key} no depende de la práctica`);
    }
    const plain = manifestOf(P.snapshotFromStructure(clone(RCP)));
    eq(m.items.length - plain.items.length, 4, 'la práctica agrega solo 4 trabajos');
    eq(m.totals.presentationCount, plain.totals.presentationCount, 'sin presentaciones nuevas');
    eq(m.totals.audiobookChapterCount, plain.totals.audiobookChapterCount, 'sin audiolibro nuevo');
    eq(m.totals.contentCount, plain.totals.contentCount, 'sin Libro nuevo');
    eq(m.totals.videoCount, plain.totals.videoCount, 'sin video nuevo');
    eq(MB.manifestSha256(MB.buildGenerationManifestV3(bp, srcOf(bp), { activityTypeRules: 2 })), MB.manifestSha256(m), 'determinista');
  });

  await check('PC3 el validador del Manifest rechaza trabajos de más o aristas cambiadas en la práctica', () => {
    const extra = clone(m);
    extra.items.push({ key: `presentation:${PR1}`, type: 'presentation', scope: 'chapter', moduleId: bp.modules[0].id, chapterId: PR1, moduleNumber: 1, chapterNumber: 4, dependsOn: [] });
    assert(MB.validateGenerationManifestV3(extra, bp, m.source).length > 0, 'presentación en práctica');
    const deps = clone(m);
    deps.items.find((i) => i.key === `experience:${PR1}`).dependsOn = [`content:${contentIdsOf(bp, 0)[0]}`];
    assert(MB.validateGenerationManifestV3(deps, bp, m.source).some((e) => e.code === 'WRONG_DEPENDENCIES'), 'aristas');
    const noKind = clone(m);
    delete noKind.modules[0].chapters[3].kind;
    assert(MB.validateGenerationManifestV3(noKind, bp, m.source).some((e) => e.code === 'MODULES_MISMATCH'), 'kind faltante en modules[]');
  });

  await check('PC4 exámenes: el plan del banco no incluye capítulos de práctica', () => {
    const mod = V3.examChaptersFromManifest(m, 'exam', bp.modules[0].id).map((c) => c.id);
    eq(mod, contentIdsOf(bp, 0), 'examen del módulo 1');
    const fin = V3.examChaptersFromManifest(m, 'final_exam').map((c) => c.id);
    assert(!fin.includes(PR1) && !fin.includes(PR2) && fin.length === 9, 'final');
    const facts = V3.examBankClaimFacts(m, 'exam', bp.modules[0].id);
    eq(facts.plan.reduce((a, l) => a + l.slots, 0), 25, '25 preguntas (3 capítulos de contenido)');
  });

  await check('PC5 tiempo y costo: práctica ≈ 20 min; sin Gamma/Videogen/TTS por ella; distribuidor = Manifest', () => {
    const est = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(m, bp));
    const pc = est.modules[0].chapters.find((c) => c.chapterId === PR1);
    eq(pc.resources.map((r) => r.resource), ['practice_page', 'activity', 'review'], 'recursos de la práctica');
    eq(pc.chapterEstimatedMinutes, 20.1, 'a mano: 6 + 9,6 + 4,5');
    const exam1 = est.modules[0].resources.find((r) => r.resource === 'module_exam');
    eq(exam1.basis, '25 preguntas × 1,2 min', 'el examen sigue con 3 capítulos de contenido');
    const dr = P.runPedagogyDryRun({ structure: rcpWithPractice(), profile: null });
    const plain = P.runPedagogyDryRun({ structure: (() => { const s = clone(RCP); s.course.reviewCards = true; return s; })(), profile: null });
    const usd = (x) => Number(x.baseline.providers.estimateUsd.expected);
    const delta = usd(dr) - usd(plain);
    // Solo experience + activity (LLM) por capítulo de práctica; los exámenes NO cambian (no la cubren).
    assert(delta > 0 && delta < 0.6, `dos capítulos de práctica cuestan < USD 0,60 (${delta.toFixed(4)})`);
    for (const prov of ['gamma', 'videogen', 'openai']) {
      const ops = (x) => JSON.stringify((x.baseline.providers.byProvider[prov] || {}).operations || {});
      eq(ops(dr), ops(plain), `${prov}: mismas operaciones`);
    }
    // El distribuidor modela la práctica igual que el Manifest (misma suma de horas para la misma estructura).
    const d = ST.distributeCourseHours({ snapshot: bp, rules: null, targetHours: 15 });
    eq(d.baseHours, Math.round((est.courseEstimatedMinutes / 60) * 10) / 10, 'distribuidor = Manifest');
  });

  await check('PC6 invalidación: agregar/quitar/editar práctica y editar sus fuentes regeneran SOLO lo debido', () => {
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
    const base = (() => { const s = clone(RCP); s.course.reviewCards = true; return P.snapshotFromStructure(s); })();
    const paid = /^(presentation|video|audiobook_chapter|content):/;
    // Agregar las prácticas: sus trabajos (GENERATE), las aperturas de módulo y el plan/bienvenida del curso
    // (el temario cambió; texto LLM) — el audio de bienvenida queda en espera (STALE_NO_AUTO: nunca TTS solo).
    const add = plan(base, bp);
    assert(add.every((x) => !paid.test(x)), `nada pagado ni Libro: ${add.join(' | ')}`);
    assert(add.filter((x) => /^audio_welcome:/.test(x)).every((x) => /STALE_NO_AUTO/.test(x)), 'audio de bienvenida sin TTS automático');
    eq(add.filter((x) => /=GENERATE:/.test(x)).map((x) => x.split('=')[0]).sort(), [`activity:${PR1}`, `activity:${PR2}`, `experience:${PR1}`, `experience:${PR2}`].sort(), 'genera solo la práctica');
    assert(!add.some((x) => /^(exam|final_exam):/.test(x)), 'los exámenes no cambian');
    // Quitar: nada regenera salvo aperturas de módulo.
    const rm = plan(bp, base);
    // Sus trabajos quedan deshabilitados (recuperables); fuera de eso solo textos del curso / módulo; nada pagado.
    assert(rm.every((x) => /^(module_intro|course_plan|course_intro):/.test(x) || /^audio_welcome:.*STALE_NO_AUTO/.test(x) || (/(experience|activity):9b0d/.test(x) && /SOFT_DISABLE:chapter_deleted/.test(x))), `quitar práctica: ${rm.join(' | ')}`);
    // Editar el título de una fuente (capítulo de contenido del módulo 1): esa fuente + la práctica del módulo 1.
    const edited = SNAP.snapshotV2ToRows(bp);
    const srcId = contentIdsOf(bp, 0)[1];
    edited.chapters = edited.chapters.map((c) => (c.id === srcId ? { ...c, title: 'Seguridad de la escena (revisado)' } : c));
    const bp2 = SNAP.buildBlueprintSnapshotV2(edited.course, edited.modules, edited.chapters, edited.pedagogy);
    const ed = plan(bp, bp2);
    assert(ed.includes(`experience:${PR1}=REGENERATE:practice_sources_changed`) && ed.includes(`activity:${PR1}=REGENERATE:practice_sources_changed`), `práctica del módulo 1: ${ed.join(' | ')}`);
    assert(!ed.some((x) => x.includes(PR2)), 'la práctica del módulo 2 no cambia');
    // Editar el título de la práctica: solo sus trabajos (y la apertura de su módulo).
    const ep = SNAP.snapshotV2ToRows(bp);
    ep.chapters = ep.chapters.map((c) => (c.id === PR2 ? { ...c, title: 'Práctica de casos reales' } : c));
    const pe = plan(bp, SNAP.buildBlueprintSnapshotV2(ep.course, ep.modules, ep.chapters, ep.pedagogy));
    eq(pe.filter((x) => !/^(module_intro|course_plan|course_intro|audio_welcome):/.test(x)).map((x) => x.split('=')[0]).sort(), [`activity:${PR2}`, `experience:${PR2}`], 'editar la práctica');
    // Reordenar la práctica dentro del módulo: nada que regenerar (fuentes iguales) salvo lo que cambie de rol.
    const ro = SNAP.snapshotV2ToRows(bp);
    ro.chapters = ro.chapters.map((c) => (c.id === PR2 ? { ...c, position: 99 } : c));
    const re = plan(bp, SNAP.buildBlueprintSnapshotV2(ro.course, ro.modules, ro.chapters, ro.pedagogy));
    // Reordenar: a lo sumo REVIEW (sin costo) de los capítulos que cambian de lugar; nada se regenera con proveedores
    // pagos ni con el Libro, y los exámenes se reutilizan.
    assert(re.every((x) => !(paid.test(x) && /=(REGENERATE|GENERATE|STALE_NO_AUTO):/.test(x)) && !/^(exam|final_exam):/.test(x)), `reordenar: ${re.join(' | ')}`);
  });

  await check('PC7 empaque: .mbz válido con práctica (h5p y scorm); sin presentación, Libro ni audiolibro para ella', async () => {
    const mods = [
      { examEnabled: true, chapters: [{ video: true, activity: true }, { video: false, activity: true }, { practice: true, activity: true }] },
      { examEnabled: false, chapters: [{ video: true, activity: true }, { practice: true, activity: true }, { video: false, activity: false }] },
    ];
    for (const engine of ['h5p', 'scorm']) {
      const input = PF.packagingInput(distRoot, { engine, finalExam: true, courseId: 635, modules: mods });
      const r = await B.buildDynamicMbzV3(input);
      const v = await VAL.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `${engine}: ${JSON.stringify(v.issues.slice(0, 3))}`);
      const f = r.expectations.facts;
      const practice = f.chapters.filter((c) => c.kind === 'practice');
      eq(practice.map((c) => c.number), [3, 5], `${engine}: capítulos de práctica`);
      eq(practice.map((c) => c.slideCount), [0, 0], 'sin diapositivas');
      eq(f.audio.audiobookParts.map((p) => p.chapterNumber), [1, 2, 4, 6], 'audiolibro sin la práctica');
      assert(practice.every((c) => Number.isInteger(c.estimatedMinutes) && c.estimatedMinutes >= 5), 'badge de minutos');
      assert(f.studyTime && f.studyTime.courseEstimatedHours > 0, 'studyTime');
      const seq = PF.expectedSequence(distRoot, input);
      const prSec = seq.find(([, ids]) => ids.some((x) => x.includes(`cv3:ch:${f.chapters[2].id}:`)));
      assert(!prSec[1].some((x) => x.endsWith(':presentation')), 'sección de práctica sin presentación');
      eq(SHELL.chapterSlotSequence({ videoEnabled: false, activityEnabled: true, practice: true }), ['label:opening', 'label:deepening', 'label:synthesis', 'label:activity_instruction', 'activity', 'label:closing'], 'secuencia de slots');
    }
    // Un paquete que trae presentación para la práctica es un contrato roto → falla fuerte.
    const bad = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 636, modules: mods });
    const prId = bad.manifest.modules[0].chapters[2].chapterId;
    bad.contents.contentMd.set(prId, '# no debería existir');
    let msg = '';
    try { await B.buildDynamicMbzV3(bad); } catch (e) { msg = e.message; }
    assert(/practice_with_content/.test(msg), `contenido de más: ${msg.slice(0, 160)}`);
  });

  await check('PC8 pedagogía: el diseño nunca le pone video a un capítulo de práctica', () => {
    for (const k of Object.keys(PROF.profiles)) {
      const dr = P.runPedagogyDryRun({ structure: rcpWithPractice(), profile: profileOf(k), activityTypeRules: 2 });
      eq(dr.pedagogical.manifestErrors, [], `${k}: Manifest válido`);
      const prs = dr.pedagogical.blueprint.modules.flatMap((x) => x.chapters).filter((c) => c.kind === 'practice');
      assert(prs.length === 2 && prs.every((c) => !c.videoEnabled), `${k}: práctica sin video`);
      assert(!dr.structureChanges.some((c) => (c.entityId === PR1 || c.entityId === PR2) && c.field === 'videoEnabled'), `${k}: sin sugerencia de video en la práctica`);
    }
  });

  await check('PC9 regresión: sin práctica, Blueprint, Manifest, huellas y plan de empaque de siempre', () => {
    const plain = P.snapshotFromStructure(clone(RCP));
    assert(plain.modules.every((x) => x.chapters.every((c) => !('kind' in c))), 'sin clave kind');
    const pm = manifestOf(plain);
    assert(pm.modules.every((x) => x.chapters.every((c) => !('kind' in c))), 'modules[] sin kind');
    const fps = FP.computeFingerprintsV3(plain);
    eq(fps.practiceSources.size, 0, 'sin fuentes de práctica');
    const plan = PLAN.buildPackagingPlanV3(pm, plain);
    assert(plan.modules.every((x) => x.chapters.every((c) => !('kind' in c) && c.keys.content && c.keys.presentation && c.keys.audiobookChapter)), 'plan de empaque de siempre');
  });

  await check('PC10 regenerar el Libro de una fuente DENTRO de un run regenera también la práctica del módulo (revisión L4 I1)', () => {
    const src = contentIdsOf(bp, 0)[1];
    const c = CASCADE.regenerationCascade(3, m.items, { key: `content:${src}`, type: 'content', moduleId: bp.modules[0].id, chapterId: src });
    assert(c.regenerate.includes(`experience:${PR1}`) && c.regenerate.includes(`activity:${PR1}`), `práctica del módulo 1: ${c.regenerate.join(', ')}`);
    assert(!c.regenerate.some((k) => k.endsWith(PR2)), 'la del módulo 2 no');
    eq(c.stale.filter((k) => k.endsWith(PR1)), [], 'nada pagado de la práctica');
    const plain = manifestOf(P.snapshotFromStructure(clone(RCP)));
    const c0 = CASCADE.regenerationCascade(3, plain.items, { key: `content:${src}`, type: 'content', moduleId: bp.modules[0].id, chapterId: src });
    eq(c0.regenerate.filter((k) => !k.endsWith(src) && !/^(exam|final_exam):/.test(k)), [], 'sin práctica: la cascada de siempre');
  });

  await check('PC11 práctica al INICIO del módulo + enfoque «problemas»: el video del primer capítulo de contenido no se toca (revisión L4 I4)', () => {
    for (const k of ['problemas', 'problemas+significativo+autodirigido']) {
      const s2 = clone(RCP);
      s2.course.reviewCards = true;
      s2.modules[0].chapters.unshift({ id: PR1, title: 'Práctica de entrada', kind: 'practice', activityEnabled: true });
      const dr = P.runPedagogyDryRun({ structure: s2, profile: profileOf(k), activityTypeRules: 2 });
      const first = s2.modules[0].chapters[1].id;
      assert(!dr.structureChanges.some((c) => c.entityId === first && c.field === 'videoEnabled' && c.to === false), `${k}: no apaga el video del primer capítulo de contenido`);
      eq(dr.pedagogical.manifestErrors, [], `${k}: Manifest válido`);
    }
  });

  await check('PC12 guarda de esquema: sin la columna chapter_kind una escritura con kind responde 503 (no un 500); con ella pasa', async () => {
    GUARD._resetPracticeSchemaGuardForTests();
    let err = null;
    try { await GUARD.assertPracticeChapterSchema({ query: async () => [] }); } catch (e) { err = e; }
    assert(err && err.getStatus && err.getStatus() === 503 && /schema_not_migrated_practice/.test(JSON.stringify(err.getResponse())), `503: ${err && err.message}`);
    await GUARD.assertPracticeChapterSchema({ query: async () => [{ '?column?': 1 }] });
    let calls = 0;
    await GUARD.assertPracticeChapterSchema({ query: async () => { calls++; return []; } });
    eq(calls, 0, 'el positivo queda cacheado');
    GUARD._resetPracticeSchemaGuardForTests();
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})();
