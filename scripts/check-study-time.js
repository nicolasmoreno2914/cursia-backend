#!/usr/bin/env node
/* eslint-disable no-console */
// Motor de carga horaria — Loop 1: modelo de tiempo determinista (src/modules/study-time).
//
//   ST1  reglas congeladas y versionadas; el módulo no importa red ni proveedores
//   ST2  capítulo planificado completo: cada recurso con su regla (página, Libro, diapositivas, video,
//        preguntas y pausas, actividad, repaso) y el total redondeado
//   ST3  curso RCP 3×3 planificado (Blueprint → Manifest → estimador): ~13,6 h; componentes suman el total;
//        determinista
//   ST4  el estimador sigue el Manifest: sin video / sin actividad / sin examen / sin final / sin repaso
//   ST5  medidas reemplazan a los planificados y quedan marcadas
//   ST6  entradas inválidas fallan fuerte (nunca un default inventado)
//   ST7  preguntas y pausas del video = el MISMO plan del empaque (plan.ts)
//   ST8  preguntas de exámenes planificadas = plan de slots del banco (17 / 33 en un 2×2)
//   ST9  3 cursos REALES de staging (medidas de solo lectura): horas por capítulo y curso; la duración del
//        video sale de las marcas de tiempo reales y la regla de preguntas + pausas coincide con el paquete
//   ST10 dry-run pedagógico: horas planificadas en línea base y vista pedagógica, sin proveedores
//   ST11 la discrepancia anterior (badge ~30–35 min) queda corregida: un capítulo completo da ~70 min
//
// Uso: node scripts/check-study-time.js [path/to/dist]   (después de npm run build)
'use strict';
const fs = require('fs');
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
const ST = loadDist('modules/study-time/index.js');
const P = loadDist('modules/pedagogy/index.js');
const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const PLAN = loadDist('package/h5p/interactive-video/plan.js');
const EB = loadDist('modules/course-shell/exam-bank.js');
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PF = require('./fixtures/pedagogy/profiles.json');
const REAL = require('./fixtures/study-time/staging-courses.json');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
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
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}: esperado ${B}, encontrado ${A}`);
}
function near(a, b, tol, m) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: esperado ${b} ± ${tol}, encontrado ${a}`);
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
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

function manifestOf(structure, activityTypeRules = 2) {
  const snap = P.snapshotFromStructure(structure);
  const source = { courseId: snap.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(snap) };
  const manifest = MB.buildGenerationManifestV3(snap, source, { activityTypeRules });
  eq(MB.validateGenerationManifestV3(manifest, snap, source).length, 0, 'Manifest válido');
  return { snap, manifest };
}
function estimateOf(structure, measured, activityTypeRules) {
  const { snap, manifest } = manifestOf(structure, activityTypeRules);
  return ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(manifest, snap, measured));
}
const fullChapter = (id, extra = {}) => ({ chapterId: id, libro: true, presentation: true, video: true, ivAdvanced: true, activity: true, review: true, ...extra });
const mins = (est, kind) => est.resources.filter((r) => r.resource === kind).map((r) => r.minutes);

check('ST1 reglas congeladas y versionadas; el módulo no importa red ni proveedores', () => {
  const R = ST.STUDY_TIME_RULES;
  assert(Object.isFrozen(R) && Object.isFrozen(R.planned) && Object.isFrozen(R.applicationActivityTiers), 'reglas congeladas');
  eq([R.rulesVersion, R.readingWordsPerMinute, R.minutesPerSlide, R.minutesPerActivityItem, R.minutesPerReviewCard, R.minutesPerExamQuestion], [1, 150, 0.6, 1.2, 0.5, 1.2], 'reglas de la Fase 0');
  eq([R.planned.chapterPageWords, R.planned.libroChapterWords, R.planned.slides, R.planned.videoSeconds, R.planned.activityItems, R.planned.reviewCards], [2200, 2900, 10, 600, 8, 9], 'planificados calibrados');
  eq([...R.applicationActivityTiers], [30, 60, 90, 120], 'niveles de la Actividad de aplicación');
  const dir = path.join(__dirname, '..', 'src', 'modules', 'study-time');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/from '([^']+)'/g)) {
      assert(!/http|axios|fetch|provider|worker|typeorm|supabase|anthropic|gamma|videogen|openai/i.test(m[1]), `${f} importa ${m[1]}`);
    }
  }
});

check('ST2 capítulo planificado completo: cada recurso con su regla y el total', () => {
  const c = ST.estimateChapterStudyTime(fullChapter('c1'));
  const by = Object.fromEntries(c.resources.map((r) => [r.resource, r.minutes]));
  eq(by, { chapter_page: 14.67, libro: 19.33, presentation: 6, video: 10, video_interactions: 8, activity: 9.6, review: 4.5 }, 'minutos por recurso');
  eq(c.chapterEstimatedMinutes, 72.1, 'total exacto (a mano: 14,67 + 19,33 + 6 + 10 + 8 + 9,6 + 4,5)');
  eq(c.displayMinutes, 70, 'redondeado a 5');
  assert(c.resources.every((r) => r.measured === false && r.basis.length > 0), 'planificados con su fórmula');
  eq(c.resources.find((r) => r.resource === 'video_interactions').basis, '6 preguntas + 2 pausas × 1 min', 'pausas IV v2');
  eq(ST.estimateChapterStudyTime(fullChapter('c1', { ivAdvanced: false })).resources.find((r) => r.resource === 'video_interactions').minutes, 6, 'sin IV v2 no hay pausas');
  eq(ST.estimateChapterStudyTime(fullChapter('c1', { applicationMinutes: 90 })).chapterEstimatedMinutes, 162.1, 'Actividad de aplicación (Fase 2) suma su nivel');
  eq(ST.displayChapterMinutes(1), 5, 'mínimo 5');
});

check('ST3 curso RCP 3×3 planificado: ~13,6 h, componentes = total, determinista', () => {
  const s = clone(RCP);
  s.course.reviewCards = true;
  const a = estimateOf(s);
  const b = estimateOf(clone(s));
  eq(a, b, 'misma entrada → mismo resultado');
  eq(a.modules.length, 3, 'módulos');
  eq(a.modules.flatMap((m) => m.chapters).length, 9, 'capítulos');
  near(a.courseEstimatedHours, 13.6, 0.05, 'horas (baseline Fase 0: 13,6 h sin guías)');
  eq(a.courseEstimatedMinutes, 813.23, 'a mano: 9 × 72,1 + 3 × 30 + 48 + 3 × 3 + 6,33 + 1 + 10');
  eq(a.courseEstimatedHours, Math.round((a.courseEstimatedMinutes / 60) * 10) / 10, 'horas = minutos / 60');
  near(sum(Object.values(a.byComponent)), a.courseEstimatedMinutes, 0.05, 'componentes suman el total');
  const modSum = sum(a.modules.map((m) => m.moduleEstimatedMinutes)) + sum(a.resources.map((r) => r.minutes));
  near(modSum, a.courseEstimatedMinutes, 0.05, 'módulos + curso = total');
  eq(mins(a, 'final_exam'), [48], 'examen final: 40 preguntas (tope) × 1,2');
  eq(a.modules.map((m) => m.resources.find((r) => r.resource === 'module_exam').minutes), [30, 30, 30], 'exámenes de módulo: 25 × 1,2');
  assert(a.usesPlannedValues === true, 'antes de generar todo es planificado');
  // Sin «Repaso» (el ajuste del Blueprint de este fixture está apagado): 9 × 4,5 min menos.
  near(estimateOf(clone(RCP)).courseEstimatedMinutes, a.courseEstimatedMinutes - 40.5, 0.05, 'sin repaso');
});

check('ST4 el estimador sigue el Manifest (video, actividad, examen, final, repaso, motor)', () => {
  const s = clone(RCP);
  s.course.reviewCards = true;
  s.modules[0].chapters[0].videoEnabled = false;
  s.modules[0].chapters[1].activityEnabled = false;
  s.modules[1].examEnabled = false;
  s.course.finalExam = false;
  const e = estimateOf(s);
  const ch = (mi, ci) => e.modules[mi].chapters[ci].resources.map((r) => r.resource);
  assert(!ch(0, 0).includes('video') && !ch(0, 0).includes('video_interactions'), 'sin video');
  assert(!ch(0, 1).includes('activity'), 'sin actividad');
  assert(!e.modules[1].resources.some((r) => r.resource === 'module_exam'), 'sin examen de módulo');
  eq(mins(e, 'final_exam'), [], 'sin examen final');
  assert(e.modules.every((m) => m.resources.some((r) => r.resource === 'module_intro')), 'apertura de cada módulo');
  eq(e.resources.map((r) => r.resource), ['course_frame', 'welcome_audio', 'forum'], 'recursos de curso');
  // Repaso solo con H5P v2 y motor h5p (mismas condiciones que el empaque).
  const noReview = (mut, atr) => {
    const x = clone(RCP);
    x.course.reviewCards = true;
    mut(x);
    return estimateOf(x, {}, atr).modules.every((m) => m.chapters.every((c) => !c.resources.some((r) => r.resource === 'review')));
  };
  assert(noReview(() => {}, 1), 'H5P v1 → sin repaso');
  assert(noReview((x) => (x.course.activityEngine = 'scorm'), 2), 'SCORM → sin repaso');
  assert(!noReview(() => {}, 2), 'H5P v2 + h5p → repaso');
});

check('ST5 las medidas reemplazan a los planificados y quedan marcadas', () => {
  const { snap, manifest } = manifestOf(clone(RCP));
  const id = manifest.modules[0].chapters[0].chapterId;
  const mid = manifest.modules[0].moduleId;
  const e = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(manifest, snap, {
    pageWordsByChapter: { [id]: 3000 },
    libroWordsByChapter: { [id]: 1500 },
    slidesByChapter: { [id]: 12 },
    videoSecondsByChapter: { [id]: 420 },
    activityItemsByChapter: { [id]: 5 },
    examQuestionsByModule: { [mid]: 20 },
    finalExamQuestions: 30,
    welcomeAudioSeconds: 90,
    frameWords: 1200,
  }));
  const c = e.modules[0].chapters[0];
  const by = Object.fromEntries(c.resources.map((r) => [r.resource, r]));
  eq([by.chapter_page.minutes, by.libro.minutes, by.presentation.minutes, by.video.minutes, by.video_interactions.minutes, by.activity.minutes], [20, 10, 7.2, 7, 6, 6], 'minutos medidos');
  assert(['chapter_page', 'libro', 'presentation', 'video', 'video_interactions', 'activity'].every((k) => by[k].measured), 'marcados como medidos');
  eq(e.modules[0].resources.find((r) => r.resource === 'module_exam').minutes, 24, 'examen medido');
  eq(mins(e, 'final_exam'), [36], 'final medido');
  eq(mins(e, 'welcome_audio'), [1.5], 'audio medido');
  eq(mins(e, 'course_frame'), [8], 'marco medido');
  assert(e.modules[0].chapters[1].resources.every((r) => !r.measured), 'los demás capítulos siguen planificados');
});

check('ST6 entradas inválidas fallan fuerte', () => {
  const one = (ch) => ({ frame: false, welcomeAudio: false, forum: false, finalExam: false, modules: [{ moduleId: 'm', intro: false, exam: false, chapters: [ch] }] });
  const bad = [
    [fullChapter('c', { pageWords: -1 }), /pageWords/],
    [fullChapter('c', { pageWords: 0 }), /pageWords/],
    [fullChapter('c', { pageWords: null }), /pageWords/],
    [fullChapter('c', { videoSeconds: null }), /videoSeconds/],
    [fullChapter('c', { slides: 2.5 }), /slides/],
    [fullChapter('c', { videoSeconds: NaN }), /videoSeconds/],
    [fullChapter('c', { videoSeconds: 999999 }), /videoSeconds/],
    [fullChapter('c', { activityItems: '8' }), /activityItems/],
    [fullChapter('c', { applicationMinutes: 45 }), /30\/60\/90\/120/],
    [fullChapter(''), /chapterId/],
  ];
  for (const [ch, re] of bad) throwsRe(() => ST.estimateCourseStudyTime(one(ch)), re, JSON.stringify(ch).slice(0, 80));
  throwsRe(() => ST.estimateCourseStudyTime({ frame: false, welcomeAudio: false, forum: false, finalExam: false, modules: [] }), /al menos un módulo/, 'curso vacío');
  throwsRe(() => ST.estimateCourseStudyTime({ frame: false, welcomeAudio: false, forum: false, finalExam: false, modules: [{ moduleId: 'm', intro: false, exam: false, chapters: [] }] }), /no tiene capítulos/, 'módulo vacío');
  throwsRe(() => ST.estimateCourseStudyTime({ frame: false, welcomeAudio: false, forum: false, finalExam: false, modules: [{ moduleId: 'm', intro: false, exam: false, chapters: [fullChapter('c'), fullChapter('c')] }] }), /repetido/, 'capítulo repetido');
  throwsRe(() => ST.estimateCourseStudyTime({ frame: false, welcomeAudio: false, forum: false, finalExam: true, finalExamQuestions: 0, modules: [{ moduleId: 'm', intro: false, exam: false, chapters: [fullChapter('c')] }] }), /finalExamQuestions/, 'final con 0 preguntas');
  const { snap, manifest } = manifestOf(clone(RCP));
  throwsRe(() => ST.studyTimeInputFromManifest({ ...manifest, rulesVersion: 2 }, snap), /rulesVersion 3/, 'Manifest v2');
  assert(ST.StudyTimeError && new ST.StudyTimeError('x').code === 'STUDY_TIME_INPUT_INVALID', 'código de error');
});

check('ST7 preguntas y pausas del video = el plan del empaque', () => {
  for (const d of [105, 150, 180, 240, 299, 300, 420, 600, 700, 900, 1500]) {
    for (const iv of [false, true]) {
      const c = ST.estimateChapterStudyTime({ chapterId: 'c', libro: false, presentation: false, video: true, videoSeconds: d, ivAdvanced: iv, activity: false, review: false });
      const expected = PLAN.videoInteractionCount(d) + (iv ? PLAN.reflectionPauseCount(d) : 0);
      eq(c.resources.find((r) => r.resource === 'video_interactions').minutes, expected, `d=${d} iv=${iv}`);
    }
  }
});

check('ST8 preguntas de exámenes planificadas = plan de slots del banco', () => {
  const s = clone(RCP);
  s.modules = s.modules.slice(0, 2).map((m) => ({ ...m, chapters: m.chapters.slice(0, 2) }));
  const e = estimateOf(s);
  eq(e.modules.map((m) => m.resources.find((r) => r.resource === 'module_exam').basis), ['17 preguntas × 1,2 min', '17 preguntas × 1,2 min'], 'módulo 2 capítulos');
  eq(e.resources.find((r) => r.resource === 'final_exam').basis, '33 preguntas × 1,2 min', 'final 4 capítulos');
  eq([EB.examSlotSplit(2).total, EB.finalExamSlotSplit(4).total, EB.finalExamSlotSplit(9).total], [17, 33, 40], 'slots');
});

check('ST9 cursos reales de staging (solo lectura): horas por capítulo y curso; el plan del video coincide con el paquete', () => {
  eq(REAL.courses.map((c) => c.courseId), [616, 583, 542], 'cursos');
  const rows = [];
  for (const c of REAL.courses) {
    const byMod = new Map();
    c.chapters.forEach((ch, i) => {
      // Video de YouTube (fuera del .mbz): su duración sale de las marcas de tiempo REALES de las preguntas del
      // paquete (plan: n preguntas en los puntos medios de n tramos iguales de [30, d − 15]) → d = 45 + n × tramo.
      // NO usa la regla de cantidad (clamp(round(d/100), 3, 8)): la prueba la verifica contra el paquete.
      const q = ch.videoQuestionAtSec;
      const n = q.length;
      const seg = (q[n - 1] - q[0]) / (n - 1);
      assert(Math.abs(q[0] - (30 + seg / 2)) <= 1, `curso ${c.courseId} cap ${i + 1}: la primera pregunta está donde la pone el plan`);
      // Las marcas son segundos enteros: d tiene ±2 s de error. #616 cap. 1 da 748,5 s, 1,5 s antes del salto 7 → 8
      // preguntas (750 s): si algún día falla SOLO ese caso, es redondeo de la marca, no un cambio de la regla.
      const videoSeconds = 45 + n * seg;
      const input = {
        chapterId: `c${c.courseId}-${i + 1}`,
        pageWords: ch.pageWords,
        libro: true,
        libroWords: Math.round(c.libroWords / c.chapters.length),
        presentation: true,
        video: true,
        videoSeconds,
        ivAdvanced: true,
        activity: true,
        activityItems: ch.activityItems,
        review: true,
        reviewCards: ch.reviewCards,
      };
      byMod.set(ch.module, [...(byMod.get(ch.module) || []), { input, real: n + ch.videoPauseAtSec.length }]);
    });
    const mods = [...byMod.keys()].sort((a, b) => a - b);
    const est = ST.estimateCourseStudyTime({
      frame: true,
      frameWords: c.frameWords,
      welcomeAudio: true,
      welcomeAudioSeconds: c.welcomeAudioSeconds,
      forum: true,
      finalExam: true,
      finalExamQuestions: c.finalExamQuestions,
      modules: mods.map((n, i) => ({ moduleId: `m${n}`, intro: true, exam: true, examQuestions: c.examQuestionsByModule[i], chapters: byMod.get(n).map((x) => x.input) })),
    });
    const reals = mods.flatMap((n) => byMod.get(n).map((x) => x.real));
    est.modules.flatMap((m) => m.chapters).forEach((ch, i) => {
      eq(ch.resources.find((r) => r.resource === 'video_interactions').minutes, reals[i], `curso ${c.courseId} cap ${i + 1}: preguntas + pausas = las del paquete real`);
      assert(ch.displayMinutes >= 60 && ch.displayMinutes <= 90, `curso ${c.courseId} cap ${i + 1}: ${ch.displayMinutes} min fuera de [60, 90]`);
    });
    assert(est.courseEstimatedHours >= 6 && est.courseEstimatedHours <= 7.5, `curso ${c.courseId}: ${est.courseEstimatedHours} h fuera de [6, 7,5] (2×2)`);
    assert(est.usesPlannedValues === true, 'module_intro sigue planificado');
    rows.push(`#${c.courseId}: capítulos ${est.modules.flatMap((m) => m.chapters).map((x) => `${x.displayMinutes}`).join('/')} min · curso ${est.courseEstimatedHours} h`);
  }
  console.log(`   ${rows.join('\n   ')}`);
});

check('ST10 dry-run pedagógico: horas planificadas en línea base y vista pedagógica, sin proveedores', () => {
  const profile = {
    pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches,
    learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
  };
  const empty = P.runPedagogyDryRun({ structure: clone(RCP), profile: null });
  eq([empty.providersCalled, empty.spendUsd], [0, '0.00'], 'sin proveedores ni gasto');
  near(empty.baseline.studyTime.courseEstimatedHours, 12.9, 0.05, 'línea base sin repaso');
  eq(empty.diff.estimatedHours, { baseline: empty.baseline.studyTime.courseEstimatedHours, pedagogical: null }, 'diff sin perfil');
  const ped = P.runPedagogyDryRun({ structure: clone(RCP), profile });
  assert(ped.pedagogical && ped.pedagogical.studyTime.rulesVersion === 1, 'vista pedagógica con horas');
  eq(ped.diff.estimatedHours.pedagogical, ped.pedagogical.studyTime.courseEstimatedHours, 'diff con perfil');
});

check('ST11 la discrepancia anterior (~30–35 min) queda corregida', () => {
  // Badge anterior (facts P3: 180 palabras/min, video fijo 6 min, actividad 8, sin Libro, preguntas del video
  // ni repaso) para el mismo capítulo: 2200/180 + 10 × 0,5 + 6 + 8 = 31,2 → «~30 min».
  // Ahora, el mismo capítulo planificado completo (a mano en ST2): 72,1 → «~70 min».
  eq(ST.estimateChapterStudyTime(fullChapter('c')).displayMinutes, 70, 'capítulo completo');
  eq(ST.estimateChapterStudyTime(fullChapter('c', { libro: false, review: false, ivAdvanced: false })).displayMinutes, 45, 'aun sin Libro ni repaso (46,27) supera el badge anterior');
});

console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
