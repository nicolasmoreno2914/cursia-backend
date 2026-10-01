#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — T5 fase B1: paquete v3 con videos PENDIENTES (vista previa).
//
// Un run v3 cuyos videos todavía son de vista previa (mock) se empaqueta con esos videos
// OMITIDOS: sin actividad de video, sin guía «Antes del video», sin «Video interactivo» en el
// recorrido «En este capítulo», con la práctica / el gradebook / la completion recalculados, y
// con `pendingVideos` en el resumen del paquete. Nunca se presenta un video simulado como real.
// v1/v2 siguen con el 409 mock_video_not_packageable (check-v2-acceptance-guards.js).
//
//  - plan v3 con omitVideoChapterIds; facts con pendingVideos; ítems calificables del paquete;
//  - builder + validador v3 (curso2 completo, parcial, y curso de solo videos → pesos normalizados);
//  - aviso del ruling 3 (facts + ensamblador + validador) y su detector (medición sobre fixtures);
//  - separación por item (output_summary.mode, con el modo del run como fallback) y clave de reuse;
//  - worker v3 con dependencias falsas: run mock → paquete sin videos + pendingVideos;
//  - PackagingService.assertRunReady: v3 mock sigue (sin 409); v1/v2 mock → 409 (sin cambios);
//  - opcional (--moodle): restore del paquete del worker en el Moodle local (E2E_MOODLE_DIR).
//
// Usage: node scripts/check-ev6-pending-videos.js [--moodle]   (npm run build antes)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.join(ROOT, 'dist');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const PV3 = L('modules/dynamic-packaging/packaging-plan-v3.js');
const PK = L('modules/dynamic-packaging/packaging-v3.js');
const SHELL = L('modules/course-shell/index.js');
const VC = L('modules/visual-components/index.js');
const A = L('package/assessment/index.js');
const W = L('workers/dynamic-package-worker.js');
const THEME = L('modules/theme-engine/index.js');
const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
const PF = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');

const WITH_MOODLE = process.argv.includes('--moodle');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function throwsSync(fn, re, m) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${e.message.slice(0, 300)}"`);
}

const videoChapters = (manifest) => manifest.modules.flatMap((m) => m.chapters.filter((c) => c.videoEnabled).map((c) => c.chapterId));

/** Secuencia esperada con los capítulos pendientes como "sin video" (y aviso si corresponde). */
function expectedSequencePending(input, pending, notice = []) {
  const seq = PF.expectedSequence(distRoot, input);
  const pend = new Set(pending);
  return seq.map(([n, ids]) => [n, ids.flatMap((id) => {
    const m = /^cv3:ch:([^:]+):(video_primer|video)$/.exec(id);
    if (!m || !pend.has(m[1])) return [id];
    if (m[2] === 'video_primer') return notice.includes(m[1]) ? [`cv3:ch:${m[1]}:video_pending`] : [];
    return [];
  })]);
}

async function mbzActs(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const mb = await z.file('moodle_backup.xml').async('string');
  const contents = /<contents>([\s\S]*?)<\/contents>/.exec(mb)[1];
  const acts = [];
  for (const b of contents.match(/<activity>[\s\S]*?<\/activity>/g)) {
    const dir = /<directory>(.*?)<\/directory>/.exec(b)[1];
    const modname = /<modulename>(.*?)<\/modulename>/.exec(b)[1];
    const mod = await z.file(`${dir}/module.xml`).async('string');
    const idnumber = /<idnumber>(.*?)<\/idnumber>/.exec(mod)[1];
    let intro = '';
    if (modname === 'label') {
      const x = await z.file(`${dir}/label.xml`).async('string');
      intro = (/<intro>([\s\S]*?)<\/intro>/.exec(x) || [])[1] || '';
      intro = intro.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }
    acts.push({ dir, modname, idnumber, intro, section: Number(/<sectionid>(.*?)<\/sectionid>/.exec(b)[1]) });
  }
  return acts;
}

async function buildPending(o, pending) {
  const input = PF.packagingInput(distRoot, o);
  const ids = pending === 'all' ? videoChapters(input.manifest) : pending;
  // Un video pendiente no llega al builder (el worker no lo descarga).
  for (const id of ids) { input.contents.videos.delete(id); input.contents.videoInteractions.delete(id); }
  input.pendingVideoChapterIds = ids;
  const r = await B.buildDynamicMbzV3(input);
  return { input, r, ids };
}

async function pureChecks() {
  const fx = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
  const vids = videoChapters(fx.manifest);

  await check('plan v3: omitVideoChapterIds consume video + video_interactions, capítulo videoPending, keys null, omittedVideos en orden', () => {
    const p = PV3.buildPackagingPlanV3(fx.manifest, fx.blueprint, { omitVideoChapterIds: [vids[1]] });
    const chs = p.modules.flatMap((m) => m.chapters);
    const c0 = chs.find((c) => c.chapterId === vids[0]);
    const c1 = chs.find((c) => c.chapterId === vids[1]);
    eq([c0.videoEnabled, c0.videoPending, !!c0.keys.video], [true, false, true], 'capítulo real');
    eq([c1.videoEnabled, c1.videoPending, c1.keys.video, c1.keys.videoInteractions], [false, true, null, null], 'capítulo pendiente');
    eq(p.omittedVideos.map((v) => [v.chapterId, v.videoKey, v.videoInteractionsKey]), [[vids[1], `video:${vids[1]}`, `video_interactions:${vids[1]}`]], 'omittedVideos');
    const p0 = PV3.buildPackagingPlanV3(fx.manifest, fx.blueprint, {});
    eq(p0.omittedVideos, [], 'sin omisiones');
    assert(p0.modules.every((m) => m.chapters.every((c) => c.videoPending === false)), 'sin pendientes');
  });
  await check('plan v3: omitir un capítulo SIN video (o desconocido) → PACKAGING_PLAN_V3_INVALID', () => {
    const noVideo = fx.manifest.modules.flatMap((m) => m.chapters).find((c) => !c.videoEnabled).chapterId;
    throwsSync(() => PV3.buildPackagingPlanV3(fx.manifest, fx.blueprint, { omitVideoChapterIds: [noVideo] }), /PACKAGING_PLAN_V3_INVALID.*no es un capítulo con video/, 'sin video');
    throwsSync(() => PV3.buildPackagingPlanV3(fx.manifest, fx.blueprint, { omitVideoChapterIds: ['nope'] }), /PACKAGING_PLAN_V3_INVALID/, 'desconocido');
  });
  await check('ítems calificables del paquete = Manifest − videos omitidos; video desconocido → falla', () => {
    const base = A.assessmentItemCountsFromManifest(fx.manifest);
    eq(A.assessmentItemCountsForPackage(fx.manifest, []), base, 'sin omisiones');
    eq(A.assessmentItemCountsForPackage(fx.manifest, vids.map((id) => `video:${id}`)).practice, base.practice - vids.length, 'práctica');
    throwsSync(() => A.assessmentItemCountsForPackage(fx.manifest, ['video:nope']), /ASSESSMENT_INVALID_FACTS/, 'desconocido');
  });
  await check('isRealVideoOutput: mode del item manda; sin mode decide el run (real sigue exigiendo su video, mock queda pendiente)', () => {
    eq([
      PK.isRealVideoOutput({ mode: 'real' }, 'mock'), PK.isRealVideoOutput({ mode: 'mock' }, 'real'),
      PK.isRealVideoOutput({}, 'real'), PK.isRealVideoOutput({}, 'mock'), PK.isRealVideoOutput(null, undefined), PK.isRealVideoOutput({ mode: 'x' }, 'mock'),
    ], [true, false, true, false, false, false], 'matriz');
  });
  await check('splitPendingVideosV3: separa videos mock + sus interacciones; nada que separar → mismo Map', () => {
    const byItem = new Map(fx.manifest.items.map((it) => [it.key, { itemKey: it.key, type: it.type, artifacts: [{ artifactId: `a-${it.key}` }], outputSummary: it.type === 'video' ? { mode: it.chapterId === vids[0] ? 'real' : 'mock' } : {} }]));
    const s = PK.splitPendingVideosV3(fx.manifest, byItem, 'mock');
    eq(s.pendingVideos, [{ itemKey: `video:${vids[1]}`, chapterId: vids[1], videoInteractionsKey: `video_interactions:${vids[1]}` }], 'pendientes');
    eq([s.byItem.has(`video:${vids[1]}`), s.byItem.has(`video_interactions:${vids[1]}`), s.byItem.has(`video:${vids[0]}`)], [false, false, true], 'byItem');
    const allReal = new Map([...byItem].map(([k, v]) => [k, { ...v, outputSummary: v.type === 'video' ? { mode: 'real' } : {} }]));
    const s2 = PK.splitPendingVideosV3(fx.manifest, allReal, 'real');
    assert(s2.byItem === allReal && s2.pendingVideos.length === 0, 'sin cambios');
  });
  await check('clave de reuse v3: sin omisiones es BYTE-IDÉNTICA a la anterior (sin campo); con omisiones cambia', () => {
    const k = { builderVersion: 'b', manifestSha256: 'm', sourceArtifactIds: ['x', 'y'], themeSha256: 't', assessmentProfileSha256: 'a', h5pProfileVersion: 1, vcRendererVersion: 'r', moodleVersion: '4.5' };
    const base = PK.packageReuseHashV3(k);
    eq(PK.packageReuseHashV3({ ...k, omittedVideoKeys: [] }), base, 'lista vacía');
    const withOmit = PK.packageReuseHashV3({ ...k, omittedVideoKeys: ['video:b', 'video:a'] });
    assert(withOmit !== base, 'cambia');
    eq(PK.packageReuseHashV3({ ...k, omittedVideoKeys: ['video:a', 'video:b'] }), withOmit, 'orden irrelevante');
  });

  // ── builder + validador ──
  for (const [label, o, pending] of [
    ['h5p + final, TODOS los videos pendientes', { engine: 'h5p', finalExam: true, courseId: 641 }, 'all'],
    ['scorm sin final, tema oscuro, UN video pendiente', { engine: 'scorm', finalExam: false, courseId: 642, theme: { themeFamily: 'oscuro-premium', mode: 'dark' } }, 'first'],
  ]) {
    await check(`builder v3 [${label}]: sin actividad de video, sin guía, recorrido sin «Video interactivo», validador sin hallazgos`, async () => {
      const probe = PF.packagingInput(distRoot, o);
      const ids = pending === 'all' ? videoChapters(probe.manifest) : [videoChapters(probe.manifest)[0]];
      const { input, r } = await buildPending(o, ids);
      const v = await V.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
      const acts = await mbzActs(r.mbz);
      const bySec = [];
      for (const a of acts) (bySec[a.section] = bySec[a.section] || []).push(a.idnumber);
      eq(bySec.map((x, i) => [i, x]).filter((x) => x[1]), expectedSequencePending(input, ids), 'secuencia por sección');
      for (const id of ids) {
        assert(!acts.some((a) => a.idnumber === `cv3:ch:${id}:video` || a.idnumber === `cv3:ch:${id}:video_primer`), `capítulo ${id} sin video ni guía`);
        const opening = acts.find((a) => a.idnumber === `cv3:ch:${id}:opening`);
        const route = VC.extractText((/<div class="cvc-route"[\s\S]*?<\/div>\s*<\/div>|<div class="cvc-route"[\s\S]*?<\/div>/.exec(opening.intro) || [''])[0]);
        assert(/En este cap/i.test(route) && !/video/i.test(route), `recorrido del capítulo pendiente: ${route}`);
      }
      for (const id of videoChapters(input.manifest).filter((x) => !ids.includes(x))) {
        assert(acts.some((a) => a.idnumber === `cv3:ch:${id}:video` && a.modname === 'h5pactivity'), `video real presente ${id}`);
        const opening = acts.find((a) => a.idnumber === `cv3:ch:${id}:opening`);
        assert(/Video interactivo/.test(VC.extractText(opening.intro)), 'el capítulo real sí lo promete');
      }
      eq(r.summary.pendingVideos.map((p) => [p.itemKey, p.notice]), ids.map((id) => [`video:${id}`, false]), 'summary.pendingVideos');
      eq(r.summary.warnings.filter((w) => w.startsWith('pending_video_omitted:')), ids.map((id) => `pending_video_omitted:video:${id}`), 'avisos');
      eq(r.expectations.facts.counts.videos, videoChapters(input.manifest).length - ids.length, 'facts.counts.videos');
      const graded = acts.filter((a) => /:(video|activity)$/.test(a.idnumber)).length;
      eq(graded, r.expectations.facts.counts.activities + r.expectations.facts.counts.videos, 'práctica calificable');
      // EV6 T3 (certificado) × T5: un video omitido no es criterio de completion; el certificado
      // (solo con evaluación final) nombra «videos interactivos» solo si queda alguno real.
      const z = await JSZip.loadAsync(r.mbz);
      const comp = await z.file('completion.xml').async('string');
      const critMids = [...comp.matchAll(/<moduleinstance>(\d+)<\/moduleinstance>/g)].map((m) => Number(m[1]));
      const midOf = new Map(acts.map((a) => [a.idnumber, Number(/_(\d+)$/.exec(a.dir || '')?.[1] ?? a.mid)]));
      for (const id of ids) assert(!midOf.has(`cv3:ch:${id}:video`), `video omitido ${id} sin módulo`);
      eq(critMids.length, graded + r.expectations.facts.counts.exams + (o.finalExam ? 1 : 0), 'criterios = ítems calificables reales (sin los videos omitidos)');
      const bx = await z.file('badges.xml').async('string');
      const closing = VC.extractText(acts.find((a) => a.idnumber === 'cv3:shell:closing').intro);
      if (o.finalExam) {
        const realVideos = r.expectations.facts.counts.videos > 0;
        assert(/<badge id=/.test(bx) && /Tu certificado/.test(closing), 'con evaluación final hay certificado');
        eq([/videos interactivos/.test(bx), /videos interactivos/.test(closing)], [realVideos, realVideos], `el certificado nombra videos solo si quedan reales (${r.expectations.facts.counts.videos})`);
      } else {
        assert(!/<badge id=/.test(bx) && !/certificad/i.test(closing) && r.summary.warnings.includes('certificate_omitted:no_final_exam'), 'sin evaluación final no hay certificado');
      }
    });
  }
  await check('builder v3: curso de SOLO videos (sin actividades) todos pendientes → «Práctica» vacía se omite y sus pesos se normalizan; validador OK', async () => {
    const o = { engine: 'h5p', finalExam: true, courseId: 643, modules: [{ examEnabled: true, chapters: [{ video: true, activity: false }, { video: true, activity: false }] }] };
    const { r } = await buildPending(o, 'all');
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    const res = r.expectations.resolved;
    eq([res.weightsNormalized, res.emptyCategories, res.categories.map((c) => c.key)], [true, ['practice'], ['moduleExams', 'finalExam']], 'normalización');
    eq(res.categories.reduce((s, c) => s + c.weight, 0), 100, 'suma 100');
  });
  // Fix round 1 (m-3): sha256 dorados tomados de un build SIN T5 con los mismos fixtures. Si un cambio
  // posterior altera el .mbz a propósito, actualizar estos valores Y subir DYNAMIC_MBZ_BUILDER_VERSION_V3
  // (regla G6 M9).
  // EV6 T3 (builder 3.2.0, certificado) cambió el .mbz a propósito: badges.xml + imagen f1/f2/f3,
  // setting badges, contexto del curso 2, panel «Tu certificado» y label oculto para docentes (con
  // evaluación final). Los dorados se re-tomaron de 094b7d3 = T3 SIN T5 (antes del rebase sobre
  // #53); el build de T3+T5 sin pendientes da los MISMOS bytes, o sea T5 sigue sin tocar el .mbz
  // cuando no hay videos pendientes.
  // P2-B1 (EV6 Fase 2 — exámenes, rebase sobre T3, builder 3.2.0 → 3.3.0) cambió el .mbz OTRA VEZ a
  // propósito: política de revisión del quiz (reviewattempt/…) y completionattemptsexhausted en TODO
  // quiz v3. Dorados anteriores (094b7d3, T3 sin T5, builder 3.2.0):
  // 644 8dff6102b2185377bc220284af9464afe769e07fdbaec890bdb43363431195bc,
  // 645 8ac9bc6537e2ef1ffad7a5339e0d8cccca66d96d59d2bfd885f28ca73d65b7a4.
  // Dorados antes de eso (4f60353, builder 3.1.0, pre-T3):
  // 644 6dd79270155faaa6c83db25be0df26c3bf659e11b93e5a4ae8fa615badecb232,
  // 645 6b35ed0bf50e3d2496081dde232851ce2db87c2725a1245ea4952dd581ddd745.
  const GOLDEN_PRE_T5 = {
    644: ['REPLACE_644', { engine: 'h5p', finalExam: true, courseId: 644 }],
    645: ['REPLACE_645', { engine: 'scorm', finalExam: false, courseId: 645, theme: { themeFamily: 'oscuro-premium', mode: 'dark' } }],
  };
  await check('builder v3: sin pendientes el .mbz es BYTE-IDÉNTICO al dorado post-P2-B1+T3 (certificado + política de revisión del quiz, builder 3.3.0), con y sin el campo', async () => {
    for (const [id, [want, o]] of Object.entries(GOLDEN_PRE_T5)) {
      const i1 = PF.packagingInput(distRoot, o);
      const i2 = PF.packagingInput(distRoot, o);
      i2.pendingVideoChapterIds = [];
      const [r1, r2] = [await B.buildDynamicMbzV3(i1), await B.buildDynamicMbzV3(i2)];
      eq(crypto.createHash('sha256').update(r1.mbz).digest('hex'), want, `sha256 del fixture ${id} vs pre-T5`);
      assert(r1.mbz.equals(r2.mbz), 'mismo .mbz con pendingVideoChapterIds=[]');
      eq(r1.summary.pendingVideos, [], 'sin pendientes');
    }
  });

  // ── Ruling 3: aviso neutral ──
  const noticeText = SHELL.COPY.videoPendingNotice;
  await check('ruling 3: copy exacto del aviso y el detector lo reconoce como mención de video', () => {
    eq(noticeText, 'El video interactivo de este capítulo estará disponible en una próxima versión del curso.', 'copy');
    assert(SHELL.mentionsCourseVideo(noticeText), 'mención');
    assert(!SHELL.mentionsCourseVideo('Un videojuego educativo y la videoconferencia del equipo'), 'vocabulario de dominio no cuenta');
  });
  await check('ruling 3: detector — capítulo/módulo/curso que menciona el video → aviso en los pendientes de su alcance; bibliografía y video_primer no cuentan', () => {
    const chapters = [{ id: 'c1', moduleId: 'm1' }, { id: 'c2', moduleId: 'm1' }, { id: 'c3', moduleId: 'm2' }];
    const clean = { t: 'Texto sin recursos.' };
    const base = { chapters, pendingChapterIds: ['c1', 'c3'], courseIntro: clean, moduleIntros: new Map([['m1', clean], ['m2', clean]]), experiences: new Map([['c1', clean], ['c2', clean], ['c3', clean]]) };
    eq(SHELL.pendingVideoNoticeChapterIds(base), [], 'nada menciona');
    eq(SHELL.pendingVideoNoticeChapterIds({ ...base, experiences: new Map([['c1', { movements: { opening: ['Mira el video y anota'] } }], ['c3', clean]]) }), ['c1'], 'capítulo');
    eq(SHELL.pendingVideoNoticeChapterIds({ ...base, experiences: new Map([['c1', { movements: { video_primer: ['En el video verás'] } }]]) }), [], 'video_primer no se publica');
    eq(SHELL.pendingVideoNoticeChapterIds({ ...base, moduleIntros: new Map([['m1', { x: 'En este módulo, los videos muestran casos.' }], ['m2', clean]]) }), ['c1'], 'módulo');
    eq(SHELL.pendingVideoNoticeChapterIds({ ...base, courseIntro: { welcome: 'Cada capítulo trae un video.' } }), ['c1', 'c3'], 'curso');
    eq(SHELL.pendingVideoNoticeChapterIds({ ...base, courseIntro: { bibliography: [{ title: 'El video en el aula' }] } }), [], 'bibliografía');
  });
  await check('ruling 3 — MEDICIÓN: en los fixtures v3 (curso2, curso4, h5p/scorm) ningún texto publicado menciona el video → 0 avisos', () => {
    let pendingChapters = 0;
    let notices = 0;
    for (const course of [SF.course2(distRoot, {}), SF.course4 ? SF.course4(distRoot, {}) : null].filter(Boolean)) {
      const mf = course.manifest;
      const exps = SF.experiencesFor(mf);
      const pend = videoChapters(mf);
      pendingChapters += pend.length;
      notices += SHELL.pendingVideoNoticeChapterIds({
        chapters: mf.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId }))),
        pendingChapterIds: pend,
        courseIntro: SF.courseIntroFixture(),
        moduleIntros: new Map(mf.modules.map((m, i) => [m.moduleId, SF.moduleIntroFixture(mf, i)])),
        experiences: exps,
      }).length;
    }
    assert(pendingChapters > 0, 'hay capítulos pendientes en la medición');
    eq(notices, 0, `avisos sobre ${pendingChapters} capítulos pendientes`);
    console.log(`   medición: ${notices} aviso(s) / ${pendingChapters} capítulo(s) con video pendiente`);
  });
  await check('ruling 3: facts + ensamblador → slot «video_pending» (CLEAN_SAFE) en lugar del video; facts rechaza aviso sin pendiente', async () => {
    const { r, input, ids } = await buildPending({ engine: 'h5p', finalExam: true, courseId: 645 }, 'all');
    const art = {
      audioWelcomeSeconds: 58, audiobookParts: r.expectations.facts.audio.audiobookParts.map((p) => ({ chapterId: p.chapterId, seconds: p.seconds })),
      slideCountByChapter: Object.fromEntries(r.expectations.facts.chapters.map((c) => [c.id, c.slideCount])),
      examQuestionCountByModule: Object.fromEntries(r.expectations.facts.modules.filter((m) => m.examEnabled).map((m) => [m.id, m.examQuestionCount])),
      finalExamQuestionCount: r.expectations.facts.finalExam.questionCount, libroWordCount: 1000,
    };
    const facts = SHELL.buildCourseFacts({ manifest: input.manifest, blueprint: input.blueprint, assessment: input.assessmentProfile, artifacts: art, pendingVideos: { chapterIds: ids, noticeChapterIds: [ids[0]] } });
    const ch = facts.chapters.find((c) => c.id === ids[0]);
    eq([ch.videoEnabled, ch.videoPending, ch.videoPendingNotice], [false, true, true], 'facts del capítulo');
    eq(SHELL.chapterSlotSequence({ videoEnabled: false, activityEnabled: ch.activityEnabled, videoPendingNotice: true }).includes('label:video_pending'), true, 'secuencia');
    const theme = THEME.resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
    const all = SHELL.assembleAllChapters(facts, Object.fromEntries(input.contents.experiences), theme);
    const slots = all.find((x) => x.chapterNumber === ch.number).slots;
    const notice = slots.find((s) => s.kind === 'label' && s.role === 'video_pending');
    assert(notice, 'slot del aviso');
    assert(VC.extractText(notice.html).includes(noticeText), 'texto del aviso');
    assert(VC.lintCleanSafe(notice.html).ok, 'CLEAN_SAFE');
    assert(!slots.some((s) => s.kind === 'video_h5p' || (s.kind === 'label' && s.role === 'video_primer')), 'sin video');
    const other = all.find((x) => x.chapterNumber === facts.chapters.find((c) => c.id === ids[1]).number).slots;
    assert(!other.some((s) => s.kind === 'label' && s.role === 'video_pending'), 'sin aviso donde no hace falta');
    throwsSync(() => SHELL.buildCourseFacts({ manifest: input.manifest, blueprint: input.blueprint, assessment: input.assessmentProfile, artifacts: art, pendingVideos: { chapterIds: [], noticeChapterIds: [ids[0]] } }), /FACTS_INVALID: aviso de video pendiente/, 'aviso sin pendiente');
    const noVideo = input.manifest.modules.flatMap((m) => m.chapters).find((c) => !c.videoEnabled).chapterId;
    throwsSync(() => SHELL.buildCourseFacts({ manifest: input.manifest, blueprint: input.blueprint, assessment: input.assessmentProfile, artifacts: art, pendingVideos: { chapterIds: [noVideo] } }), /FACTS_INVALID: video pendiente/, 'pendiente sin video');
    // Validador: si facts pide el aviso y el paquete no lo tiene → STRUCTURE (y la regla de menciones sigue estricta sin aviso).
    const v = await V.validateMbzV3(r.mbz, { ...r.expectations, facts });
    assert(!v.ok && v.issues.some((i) => i.code === 'STRUCTURE' && /video_pending/.test(i.where)), `falta el aviso: ${JSON.stringify(v.issues.slice(0, 3))}`);
  });
  await check('validador: un video empaquetado en un capítulo marcado pendiente → STRUCTURE', async () => {
    const i = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 646 });
    const r = await B.buildDynamicMbzV3(i);
    const vid = videoChapters(i.manifest)[0];
    const facts = JSON.parse(JSON.stringify(r.expectations.facts));
    const ch = facts.chapters.find((c) => c.id === vid);
    ch.videoEnabled = false;
    ch.videoPending = true;
    facts.counts.videos -= 1;
    const v = await V.validateMbzV3(r.mbz, { ...r.expectations, facts });
    assert(!v.ok && v.issues.some((x) => /video pendiente \(vista previa\) empaquetado/.test(x.message)), `hallazgo: ${JSON.stringify(v.issues.slice(0, 4))}`);
  });
}

// ── worker v3 con dependencias falsas ─────────────────────────────────────
function workerHarness({ videoMode = 'mock', videoModeByItem = null, omitMode = false } = {}) {
  const fx = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 651 });
  const manifest = fx.manifest;
  const RUN_ID = '22222222-2222-4222-8222-222222222222';
  const OWNER = 'owner-ev6';
  const artifacts = new Map();
  const rows = [];
  let n = 0;
  const addArt = (item, type, content, meta = {}, mime = 'application/json', outputSummary = {}) => {
    const id = `art-${String(++n).padStart(3, '0')}`;
    artifacts.set(id, { content, meta, mime });
    rows.push({ item_key: item.key, item_run_id: `gir-${item.key}`, gir_status: 'completed', gir_type: item.type, output_summary: outputSummary, artifact_id: id, artifact_type: type, storage_bucket: 'cursia-artifacts', storage_path: `${OWNER}/x/${id}`, mime_type: mime, artifact_status: null, metadata: meta });
  };
  const mockYt = (ch) => crypto.createHash('sha256').update(ch).digest('base64url').slice(0, 11);
  for (const item of manifest.items) {
    const ch = item.chapterId;
    switch (item.type) {
      case 'course_plan': addArt(item, 'dynamic_course_plan_json', '{}'); break;
      case 'course_intro': addArt(item, 'dynamic_course_intro_json', JSON.stringify(fx.contents.courseIntro)); break;
      case 'module_intro': addArt(item, 'dynamic_module_intro_json', JSON.stringify(fx.contents.moduleIntros.get(item.moduleId))); break;
      case 'content':
        addArt(item, 'dynamic_content_md', fx.contents.contentMd.get(ch), {}, 'text/markdown');
        addArt(item, 'dynamic_context_package_json', '{}');
        break;
      case 'experience': addArt(item, 'dynamic_experience_json', JSON.stringify(fx.contents.experiences.get(ch))); break;
      case 'presentation': addArt(item, 'dynamic_presentation', JSON.stringify({ fixture: true, provider: 'gamma', mode: 'mock', itemKey: item.key, chapterId: ch, slideCount: 7, pdfUrl: null, coverPngUrl: null }), { fixture: true, mock: true }); break;
      case 'audio_welcome':
      case 'audiobook_chapter': addArt(item, 'dynamic_audio_mp3', JSON.stringify({ fixture: true, provider: 'tts', mode: 'mock', durationSeconds: item.type === 'audio_welcome' ? 45 : 160 }), { fixture: true, mock: true }); break;
      case 'video': {
        const mode = videoModeByItem ? videoModeByItem(ch) : videoMode;
        const real = mode === 'real';
        const yt = real ? PF.YOUTUBE_ID : mockYt(ch); // mock: id fabricado por el publicador simulado
        addArt(item, 'dynamic_video', JSON.stringify({ mode, delivery: 'youtube', videogenJobId: `${real ? 'vg' : 'mock_'}-${ch}`, youtubeVideoId: yt, youtubeUrl: `https://www.youtube.com/watch?v=${yt}`, durationSec: PF.VIDEO_SECONDS }),
          { delivery: 'youtube', durationSec: PF.VIDEO_SECONDS }, 'application/json', omitMode ? {} : { mode, delivery: 'completed', youtubeVideoId: yt });
        break;
      }
      case 'video_interactions': addArt(item, 'dynamic_video_interactions_json', JSON.stringify(fx.contents.videoInteractions.get(ch))); break;
      case 'activity': addArt(item, 'dynamic_h5p_params_json', JSON.stringify(fx.contents.activities.get(ch).payload)); break;
      case 'exam': addArt(item, 'dynamic_exam_gift', fx.contents.examGift.get(item.moduleId), {}, 'text/plain'); break;
      case 'final_exam': addArt(item, 'dynamic_exam_gift', fx.contents.finalExamGift, {}, 'text/plain'); break;
      default: throw new Error(`tipo sin fixture ${item.type}`);
    }
  }
  const state = { completed: [], failed: [], uploads: [], dynamicMbz: [] };
  const runRow = { id: RUN_ID, owner_id: OWNER, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: { videoMode, videoDelivery: 'youtube', providerModes: { presentation: 'mock', audio: 'mock' } } };
  const ds = {
    async query(sql, params) {
      if (/set status = 'completed'/.test(sql)) { state.completed.push(JSON.parse(params[2])); return [{ id: params[0] }]; }
      if (/set status = 'failed'/.test(sql)) { state.failed.push(params[2]); return []; }
      if (/set lease_until = now\(\)/.test(sql)) return [{ id: params[0] }];
      if (/from public\.course_profiles/.test(sql)) return [];
      if (/from public\.courses where id = \$1/.test(sql)) return [{ metadata: {} }];
      if (/generation_item_runs/.test(sql)) return rows;
      if (/from public\.production_jobs where id = \$1/.test(sql)) return [runRow];
      throw new Error(`SQL no esperado en el fake: ${sql.slice(0, 80)}`);
    },
  };
  const deps = {
    dataSource: ds,
    artifacts: {
      async findAll(owner, f) { return f.type === 'dynamic_mbz' ? state.dynamicMbz : []; },
      async uploadBufferArtifact(i) { const a = { id: `mbz-${state.uploads.length + 1}`, metadata: i.metadata }; state.uploads.push(i); state.dynamicMbz.push(a); return a; },
    },
    manifests: { async getById() { return { id: 9001, sha256: 'manifest-sha', manifest }; } },
    blueprints: {
      async getByNumber() { throw new Error('v3 no usa getByNumber'); },
      async getByNumberAnySchema() { return { schemaVersion: 2, snapshot: fx.blueprint }; },
    },
    buildPlan: () => { throw new Error('v3 no usa el plan v1/v2'); },
    resolveArtifacts: () => { throw new Error('v3 no usa el resolver v1/v2'); },
    loadText: () => { throw new Error('v3 no usa loadText v1/v2'); },
    parseVideo: () => { throw new Error('v3 no usa parseVideo v1/v2'); },
    buildMbz: () => { throw new Error('v3 no usa el builder v1/v2'); },
    logger: { log() {}, warn() {}, error() {} },
    workerId: 'w1',
    leaseSeconds: 600,
    heartbeatMs: 3600000,
    finops: { async recordZero() { return { inserted: true }; } },
    loadersV3: () => ({
      loadText: async (a) => {
        const art = artifacts.get(a.artifactId);
        state.loaded = state.loaded || [];
        state.loaded.push(a.itemKey);
        return art.content;
      },
      loadBytes: async () => { throw new Error('los audios del fixture son mock (JSON)'); },
      loadStorageBytes: async () => { throw new Error('las presentaciones del fixture son mock'); },
    }),
    nowSeconds: () => 1790600000,
  };
  const job = { id: 'job-ev6', owner_id: OWNER, course_id: manifest.source.courseId, frontend_course_id: null, worker_status: 'running', status: 'running', input_payload: { runId: RUN_ID, manifestId: 9001, blueprintNumber: 1 }, output_summary: {}, attempt_count: 1, max_attempts: 3 };
  return { deps, job, state, manifest, fx };
}
let workerMbz = null;
async function workerChecks() {
  await check('worker v3: run MOCK (videos de vista previa) → empaqueta SIN videos, nunca descarga el video simulado, pendingVideos + aviso en el resumen', async () => {
    const h = workerHarness({ videoMode: 'mock' });
    await W.processItem(h.deps, h.job);
    eq(h.state.failed, [], 'sin fallos');
    eq(h.state.uploads.length, 1, 'un upload');
    const s = h.state.completed[0];
    const vids = videoChapters(h.manifest);
    eq(s.pendingVideos.map((p) => p.itemKey), vids.map((id) => `video:${id}`), 'pendingVideos');
    assert(s.pendingVideos.every((p) => Number.isInteger(p.chapterNumber)), 'chapterNumber');
    assert(!(h.state.loaded || []).some((k) => /^video/.test(k)), `no se descargó ningún video ni interacción: ${(h.state.loaded || []).filter((k) => /^video/.test(k))}`);
    assert((s.warnings || []).filter((w) => w.code === 'pending_video_omitted').length === vids.length, `avisos: ${JSON.stringify(s.warnings)}`);
    assert(!s.sourceArtifactIds.some((id) => /video/.test(id)), 'sourceArtifactIds sin los videos');
    eq(h.state.uploads[0].metadata.pendingVideos, s.pendingVideos, 'metadata del .mbz');
    // Fix round 1 (m-2): el ruling 3 se puede medir en staging desde el resumen del job.
    assert(s.pendingVideos.every((p) => p.notice === false), `flag notice por video: ${JSON.stringify(s.pendingVideos)}`);
    eq(s.pendingVideoNoticeCount, 0, 'pendingVideoNoticeCount');
    const acts = await mbzActs(h.state.uploads[0].buffer);
    assert(!acts.some((a) => /:video(_primer)?$/.test(a.idnumber)), 'sin actividades de video');
    for (const a of acts.filter((x) => x.modname === 'label' && /^cv3:ch:.*:opening$/.test(x.idnumber))) {
      const route = VC.extractText((/<div class="cvc-route"[\s\S]*$/.exec(a.intro) || [''])[0]).slice(0, 200);
      assert(!/video/i.test(route), `recorrido promete video: ${route}`);
    }
    workerMbz = h.state.uploads[0].buffer;
    // restore-first: mismo run → reutiliza, con pendingVideos también en el resumen reutilizado
    h.state.completed.length = 0;
    await W.processItem(h.deps, h.job);
    eq([h.state.uploads.length, h.state.completed[0].reused], [1, true], 'reuse');
    eq(h.state.completed[0].pendingVideos, s.pendingVideos, 'pendingVideos (con notice) en el reuse');
    eq(h.state.completed[0].pendingVideoNoticeCount, 0, 'pendingVideoNoticeCount en el reuse');
    eq((h.state.completed[0].warnings || []).filter((w) => w.code === 'pending_video_omitted').length, s.pendingVideos.length, 'avisos de pendientes también en el reuse');
  });
  await check('worker v3: run MIXTO (1 video real + 1 de vista previa) → el real entra, el mock queda pendiente', async () => {
    const probe = workerHarness();
    const vids = videoChapters(probe.manifest);
    const h = workerHarness({ videoMode: 'mock', videoModeByItem: (ch) => (ch === vids[0] ? 'real' : 'mock') });
    await W.processItem(h.deps, h.job);
    eq(h.state.failed, [], 'sin fallos');
    const s = h.state.completed[0];
    eq(s.pendingVideos.map((p) => p.itemKey), [`video:${vids[1]}`], 'solo el mock pendiente');
    const acts = await mbzActs(h.state.uploads[0].buffer);
    assert(acts.some((a) => a.idnumber === `cv3:ch:${vids[0]}:video` && a.modname === 'h5pactivity'), 'el video real está');
  });
  await check('worker v3: run REAL con items sin output_summary.mode (anteriores) → los videos se exigen como siempre (sin omitir)', async () => {
    const h = workerHarness({ videoMode: 'real', omitMode: true });
    await W.processItem(h.deps, h.job);
    eq(h.state.failed, [], 'sin fallos');
    eq(h.state.completed[0].pendingVideos, [], 'sin pendientes');
  });
  await check('worker v3: item que dice real pero cuyo cuerpo es mock → falla fuerte mock_video_not_packageable (el invariante sigue)', async () => {
    const h = workerHarness({ videoMode: 'mock' });
    // El resumen dice real (p.ej. dato corrupto) pero el cuerpo del artifact es simulado.
    const rows = await h.deps.dataSource.query('select generation_item_runs');
    for (const r of rows) if (r.gir_type === 'video') r.output_summary = { mode: 'real' };
    await W.processItem(h.deps, h.job);
    eq(h.state.uploads.length, 0, 'sin upload');
    assert(h.state.failed.length === 1 && /mock_video_not_packageable/.test(h.state.failed[0]), `falla: ${h.state.failed[0]}`);
  });
}

async function serviceChecks() {
  await check('PackagingService.assertRunReady: v3 con videos mock → SIN 409 (sigue al chequeo de items); v1/v2 mock → 409 mock_video_not_packageable', async () => {
    const SENT = 'LLEGO_A_LA_DB';
    const mk = () => { const st = { db: 0 }; return { st, svc: new PackagingService({ query: async () => { st.db++; throw new Error(SENT); } }, {}, {}) }; };
    const items = [{ key: 'content:a', type: 'content' }, { key: 'video:a', type: 'video' }];
    const a = mk();
    let e = null;
    try { await a.svc.assertRunReady({ id: 'r1', input_payload: { videoMode: 'mock' }, worker_status: 'completed' }, { rulesVersion: 3, manifest: { items } }); } catch (x) { e = x; }
    assert(e && e.message === SENT && a.st.db === 1, `v3 mock: ${e && e.message}`);
    const b = mk();
    e = null;
    try { await b.svc.assertRunReady({ id: 'r1', input_payload: { videoMode: 'mock' }, worker_status: 'completed' }, { rulesVersion: 2, manifest: { items } }); } catch (x) { e = x; }
    assert(e && /^mock_video_not_packageable:/.test(e.message) && b.st.db === 0, `v2 mock: ${e && e.message}`);
  });
  await check('PackagingService.assertRunReady v3: YouTube se exige SOLO a los videos reales (el pendiente no bloquea)', async () => {
    const q = [];
    const ds = {
      async query(sql) {
        q.push(sql);
        if (/gir\.item_key, gir\.status from/.test(sql)) return [{ item_key: 'video:a', status: 'completed' }, { item_key: 'video:b', status: 'completed' }];
        if (/where gir\.type = 'video'/.test(sql)) {
          return [
            { item_key: 'video:a', status: 'completed', output_summary: { mode: 'mock' } },
            { item_key: 'video:b', status: 'completed', output_summary: { mode: 'real' } },
          ];
        }
        throw new Error('sql inesperado');
      },
    };
    const svc = new PackagingService(ds, {}, {});
    let e = null;
    try {
      await svc.assertRunReady({ id: 'r1', input_payload: { videoMode: 'mock', videoDelivery: 'youtube' }, worker_status: 'completed' },
        { rulesVersion: 3, manifest: { items: [{ key: 'video:a', type: 'video' }, { key: 'video:b', type: 'video' }] } });
    } catch (x) { e = x; }
    assert(e && /youtube_delivery_incomplete/.test(e.message), `el real sin publicar bloquea: ${e && e.message}`);
    const missing = JSON.parse(/missingJson=(\[.*\])/.exec(e.message)[1]);
    assert(missing.every((m) => !String(m).startsWith('video:a')), `el pendiente no aparece: ${JSON.stringify(missing)}`);
  });
}

async function moodleChecks() {
  const MOODLE = process.env.E2E_MOODLE_DIR;
  if (!MOODLE) throw new Error('--moodle exige E2E_MOODLE_DIR');
  const OUT = path.join(MOODLE, 'ev6-pending-out');
  fs.mkdirSync(OUT, { recursive: true });
  const mbzPath = path.join(OUT, 'ev6-pending-videos.mbz');
  fs.writeFileSync(mbzPath, workerMbz);
  await check('Moodle local: restore del paquete del run mock (restore-and-inspect.sh) sin warnings, sin actividad de video, recorrido sin promesa de video', async () => {
    const rs = spawnSync(path.join(MOODLE, 'restore-and-inspect.sh'), [mbzPath], { encoding: 'utf8', env: { ...process.env, E2E_MOODLE_DIR: MOODLE }, maxBuffer: 64 * 1024 * 1024 });
    assert(rs.status === 0, `restore-and-inspect.sh salió con ${rs.status}: ${rs.stderr.slice(-800)}`);
    const courseid = Number((/Restored course id: (\d+)/.exec(rs.stderr) || [])[1]);
    assert(courseid > 0, 'sin course id');
    eq(rs.stderr.split('\n').filter((l) => /warning|notice|debug|error|exception/i.test(l)), [], 'CLI sin warnings');
    const inPath = path.join(OUT, 'in.json');
    const outPath = path.join(OUT, 'out.json');
    fs.writeFileSync(inPath, JSON.stringify({ moodleRoot: path.join(MOODLE, 'source'), courseid }));
    execFileSync(process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php', ['-c', path.join(MOODLE, 'php.ini'), path.join(__dirname, 'moodle/ev6-pending-labels.php'), inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const o = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert(!o.cms.some((c) => /:video(_primer)?$/.test(c.idnumber || '')), `sin video: ${o.cms.filter((c) => /video/.test(c.idnumber || '')).map((c) => c.idnumber)}`);
    const openings = o.labels.filter((l) => /^cv3:ch:.*:opening$/.test(l.idnumber));
    assert(openings.length > 0, 'hay aperturas de capítulo');
    for (const l of openings) {
      const txt = l.intro.replace(/<[^>]+>/g, ' ');
      const route = (/En este cap[ií]tulo([\s\S]{0,300})/.exec(txt) || [])[1] || '';
      assert(route && !/video/i.test(route), `recorrido restaurado promete video: ${route.slice(0, 160)}`);
    }
    const h5pVideos = o.cms.filter((c) => c.modname === 'h5pactivity' && /video/i.test(c.name));
    eq(h5pVideos.length, 0, 'ningún h5p de video');
    console.log(`   curso restaurado ${courseid}: ${o.cms.length} actividades, ${openings.length} capítulos, 0 videos`);
  });
}

(async () => {
  await pureChecks();
  await workerChecks();
  await serviceChecks();
  if (WITH_MOODLE) {
    if (!workerMbz) { failures++; console.error('❌ Moodle: no hay paquete del worker'); } else await moodleChecks();
  }
  console.log(`\n${failures === 0 ? 'Todos los checks de EV6 T5 B1 pasaron' : 'HAY FALLOS'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures === 0 ? 0 : 1);
})();
