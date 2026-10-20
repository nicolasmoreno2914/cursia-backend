#!/usr/bin/env node
/* eslint-disable */
// r61 Q-04 — preguntas del video interactivo sincronizadas con las escenas reales del video (Videogen).
// Sobre dist/ (npm run build), sin DB ni red:
//
//  N  videoScenesFromVideogen: status de Videogen → escenas ordenadas, tiempos acumulados en ms enteros,
//     narración normalizada y acotada; sin duración / duplicadas / demasiadas → motivo explícito.
//  P  planVideoCheckpoints: anclado al final de escenas (invariante [fin − ε, inicio siguiente + ε]),
//     misma cantidad que el plan equidistante, determinístico; fallback equidistante + motivo.
//  S  VideogenService.getVideoStatus conserva `scenes` del status (fetch falso).
//  C  videoClaimFacts: con escenas → claim anclado + videoScenes; sin escenas → claim byte a byte el de
//     siempre; con escenas que no cuadran → equidistante + timelineReason. Reflexiones (ivAdvanced) sobre
//     el plan anclado.
//  V  validateV3ItemArtifact(video_interactions) con ctx.video.videoScenes → valida contra el plan anclado y
//     marca timelineSource; sin escenas → summary de siempre.
//  B  buildVideoActivity: con escenas las preguntas quedan en el .h5p en los segundos anclados; sin escenas
//     los bytes son idénticos al build de siempre.
//
// Usage: node scripts/check-r61-video-scenes.js [path/to/dist]
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const load = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const JSZip = require('jszip');

const P = load('package/h5p/interactive-video/plan.js');
const DOC = load('package/h5p/interactive-video/interactions-doc.js');
const ACT = load('package/h5p/interactive-video/activity.js');
const V3 = load('modules/course-shell/v3-validation.js');
const { VideogenService } = load('video-engine/videogen.service.js');
const W = load('workers/dynamic-item-worker.js');
const SCH = load('modules/dynamic-generation/scheduler.service.js');
const RUNS = load('modules/dynamic-generation/runs.service.js');
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

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
const plain = (v) => JSON.parse(JSON.stringify(v));

// Videogen (ai.service): 30–45 s por escena; 16 escenas ≈ 600 s.
const DURS = [33.4, 41.2, 37.9, 30.6, 44.1, 39.3, 35.5, 42.8, 31.7, 38.2, 40.9, 36.4, 43.6, 32.2, 39.8, 34.1];
const RAW = DURS.map((d, i) => ({ scene_order: i + 1, narration: `Escena ${i + 1}: la presión del circuito y el bloqueo de energía.`, duration_seconds: d }));
const SCENES = P.videoScenesFromVideogen(RAW).scenes;
const D = Math.round(SCENES[SCENES.length - 1].endSec * 10) / 10;
const YT = 'IdwOipZAeqY';
// buildVideoActivity sin escenas con origin/staging 7138145 (dist compilado de ese commit, mismas entradas).
const GOLDEN_SHA_V1 = 'fe950bbbea524dac0ad8b058def5097749acb0f488111372017549d603980a62';
const GOLDEN_SHA_V2 = '2d1f1f97fe4aaa2605c933b4f63107fdbc5720ef466a7d82fd2f168cfe879b1a';

function interactionsDoc(n, durationSec, extra) {
  return Object.assign({
    schemaVersion: 1, videoItemKey: 'video:ch1', durationSec,
    checkpoints: Array.from({ length: n }, (_, i) => (i % 2 === 0
      ? { index: i + 1, kind: 'multichoice', question: '¿Qué indica una respuesta lenta del actuador?', answers: [{ text: 'Pérdida de presión', correct: true }, { text: 'Exceso de pintura', correct: false }, { text: 'Filtro nuevo', correct: false }], feedbackCorrect: 'Bien: anticipa la falla.', feedbackIncorrect: 'Revisa la escena sobre presión.' }
      : { index: i + 1, kind: 'truefalse', question: 'El bloqueo de energía va antes de intervenir.', correct: true, feedbackCorrect: 'Así es.', feedbackIncorrect: 'Va antes.' })),
  }, extra || {});
}

async function main() {
  await check('N normaliza el status de Videogen: orden por scene_order, tiempos acumulados exactos, narración colapsada/acotada', () => {
    const raw = [
      { scene_order: 3, narration: 'x'.repeat(900), duration_seconds: 38 },
      { scene_order: 1, narration: '  Hola   mundo \n ', duration_seconds: 33.4 },
      { scene_order: 2, narration: null, duration_seconds: 41.25 },
    ];
    const r = P.videoScenesFromVideogen(raw);
    assert(r.ok, JSON.stringify(r));
    eq(r.scenes.map((s) => [s.order, s.startSec, s.endSec]), [[1, 0, 33.4], [2, 33.4, 74.65], [3, 74.65, 112.65]], 'tiempos');
    eq(r.scenes[0].narration, 'Hola mundo', 'colapsada');
    eq(r.scenes[1].narration, '', 'sin narración → vacía');
    assert(r.scenes[2].narration.length <= P.VIDEO_SCENE_RULES.narrationMax && r.scenes[2].narration.endsWith('…'), 'acotada');
    // 0.1 + 0.2 sin deriva: ms enteros.
    eq(P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: 0.1 }, { scene_order: 2, duration_seconds: 0.2 }]).scenes[1].endSec, 0.3, 'sin deriva');
  });

  await check('N motivos explícitos: sin escenas, escena sin duración, orden repetido/no entero, demasiadas escenas', () => {
    eq(P.videoScenesFromVideogen(null), { ok: false, reason: 'no_scene_data' }, 'null');
    eq(P.videoScenesFromVideogen([]), { ok: false, reason: 'no_scene_data' }, '[]');
    eq(P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: null }]), { ok: false, reason: 'scene_duration_missing(1)' }, 'null dur');
    eq(P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: 0 }]), { ok: false, reason: 'scene_duration_missing(1)' }, '0 dur');
    eq(P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: 3 }, { scene_order: 1, duration_seconds: 3 }]), { ok: false, reason: 'duplicate_scene_order(1)' }, 'dup');
    eq(P.videoScenesFromVideogen([{ scene_order: 'a', duration_seconds: 3 }]), { ok: false, reason: 'invalid_scene_order' }, 'orden');
    eq(P.videoScenesFromVideogen(Array.from({ length: 101 }, (_, i) => ({ scene_order: i, duration_seconds: 3 }))), { ok: false, reason: 'too_many_scenes(101)' }, 'tope');
  });

  await check('P anclado: cada atSec = ⌈fin de escena⌉, en [30, d−15], ≥ 20 s, misma cantidad que el equidistante, segmento [anterior, atSec]', () => {
    const even = P.planInteractionCheckpoints(D);
    const p = P.planVideoCheckpoints(D, SCENES);
    eq(p.timelineSource, 'videogen_scenes', 'source');
    eq(p.checkpoints.length, even.length, 'cantidad');
    // Fines de escena re-escalados a floor(d) (review M-1): son los que usa el plan.
    const ends = p.scenes.map((s) => Math.ceil(s.endSec - 1e-6));
    p.checkpoints.forEach((c, i) => {
      assert(ends.includes(c.atSec), `atSec ${c.atSec} no es fin de escena`);
      assert(c.atSec >= 30 && c.atSec <= Math.floor(D) - 15, 'ventana');
      eq(c.segment, [i === 0 ? 0 : p.checkpoints[i - 1].atSec, c.atSec], 'segmento');
      if (i) assert(c.atSec - p.checkpoints[i - 1].atSec >= 20, 'gap');
      const sc = P.scenesForCheckpoint(c, p.scenes);
      assert(sc.length >= 1 && Math.ceil(sc[sc.length - 1].endSec - 1e-6) === c.atSec, 'la última escena cubierta termina en la pausa');
    });
    P.assertSceneAnchoredCheckpoints(D, p.checkpoints, p.scenes);
    eq(P.planVideoCheckpoints(D, SCENES), p, 'determinístico');
    // El ancla de la pregunta 1 es el fin de escena más cercano a su punto equidistante.
    const best = ends.filter((b) => b >= 30).reduce((a, b) => (Math.abs(b - even[0].atSec) < Math.abs(a - even[0].atSec) ? b : a));
    assert(Math.abs(p.checkpoints[0].atSec - even[0].atSec) <= Math.abs(best - even[0].atSec) + 45, 'cercano');
  });

  await check('P invariante: un atSec que no está al final de una escena → VIDEO_PLAN_INVARIANT', () => {
    const p = P.planVideoCheckpoints(D, SCENES).checkpoints.map((c) => ({ ...c, segment: [...c.segment] }));
    p[1].atSec += 5;
    p[1].segment[1] = p[1].atSec;
    let msg = '';
    try { P.assertSceneAnchoredCheckpoints(D, p, SCENES); } catch (e) { msg = e.message; }
    assert(/^VIDEO_PLAN_INVARIANT: checkpoint 2 en \d+ no está anclado al final de una escena/.test(msg), msg);
  });

  await check('P fallback equidistante con motivo (nunca en silencio): sin escenas, Σ escenas ≠ duración, tiempos rotos, sin candidatos; video corto sigue fallando fuerte', () => {
    const even = plain(P.planInteractionCheckpoints(D));
    const cases = [
      [undefined, /^no_scene_data$/], [null, /^no_scene_data$/],
      [SCENES.slice(0, 9), /^timeline_duration_mismatch\(/],
      [SCENES.map((s, i) => (i === 2 ? { ...s, endSec: s.startSec } : s)), /^invalid_scene_times$/],
      [P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: D }]).scenes, /^insufficient_scene_boundaries\(0<\d\)$/],
    ];
    for (const [sc, re] of cases) {
      const p = P.planVideoCheckpoints(D, sc);
      eq(p.timelineSource, 'even_spacing', String(re));
      assert(re.test(p.timelineReason), p.timelineReason);
      eq(plain(p.checkpoints), even, 'plan de siempre');
    }
    let msg = '';
    try { P.planVideoCheckpoints(90, P.videoScenesFromVideogen([{ scene_order: 1, duration_seconds: 45 }, { scene_order: 2, duration_seconds: 45 }]).scenes); } catch (e) { msg = e.message; }
    assert(/^VIDEO_TOO_SHORT_FOR_INTERACTIONS/.test(msg), msg);
  });

  await check('S VideogenService.getVideoStatus conserva `scenes` del status externo (fetch falso)', async () => {
    const saved = { k: process.env.VIDEOGEN_API_KEY, u: process.env.VIDEOGEN_API_URL, f: global.fetch };
    process.env.VIDEOGEN_API_KEY = 'k';
    process.env.VIDEOGEN_API_URL = 'https://fake-videogen.local';
    global.fetch = async (url) => {
      assert(String(url) === 'https://fake-videogen.local/api/external/videos/job-1/status', String(url));
      return new Response(JSON.stringify({ job_id: 'job-1', status: 'completed_local', duration_seconds: 600.2, transcript: 'x', scenes: RAW.slice(0, 2) }), { status: 200 });
    };
    try {
      const st = await new VideogenService().getVideoStatus('job-1');
      eq(st.scenes, RAW.slice(0, 2), 'scenes crudas');
      eq(W.videoTimelinePatch(st).videoScenes.length, 2, 'patch del worker');
      eq(W.videoTimelinePatch({}), { videoScenes: null, videoScenesUnavailable: 'no_scene_data' }, 'sin escenas');
    } finally {
      process.env.VIDEOGEN_API_KEY = saved.k; process.env.VIDEOGEN_API_URL = saved.u; global.fetch = saved.f;
    }
  });

  await check('C claim: con escenas → anclado + videoScenes; sin escenas → claim de siempre (mismas claves); escenas que no cuadran → equidistante + timelineReason', () => {
    const base = { youtubeVideoId: YT, durationSec: D };
    const a = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { ...base, videoScenes: SCENES } });
    assert(a.ok, JSON.stringify(a));
    eq(a.video.timelineSource, 'videogen_scenes', 'source');
    eq(a.video.checkpoints, P.planVideoCheckpoints(D, SCENES).checkpoints, 'plan anclado');
    eq(a.video.videoScenes, SCENES, 'escenas para el prompt');
    const legacy = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { ...base, videoScenes: null, videoScenesUnavailable: 'no_scene_data' } });
    eq(Object.keys(legacy.video), ['videoItemKey', 'youtubeId', 'durationSec', 'checkpoints'], 'claves de siempre');
    eq(legacy.video.checkpoints, P.planInteractionCheckpoints(D), 'equidistante');
    const bad = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { ...base, durationSec: D + 60, videoScenes: SCENES } });
    eq([bad.video.timelineSource, /^timeline_duration_mismatch/.test(bad.video.timelineReason), 'videoScenes' in bad.video], ['even_spacing', true, false], 'mismatch');
    const adv = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { ...base, videoScenes: SCENES }, ivAdvanced: true });
    eq(adv.video.reflectionPlan, P.planReflectionPauses(D, a.video.checkpoints), 'pausas sobre el plan anclado');
  });

  await check('V validación del servidor: con ctx.video.videoScenes valida contra el plan anclado y marca timelineSource; sin escenas → summary de siempre', () => {
    const n = P.planInteractionCheckpoints(D).length;
    const text = JSON.stringify(interactionsDoc(n, D));
    const ctx = { type: 'video_interactions', itemKey: 'video_interactions:ch1', chapterId: 'ch1', video: { videoItemKey: 'video:ch1', durationSec: D, videoScenes: SCENES } };
    const r = V3.validateV3ItemArtifact(ctx, text);
    assert(r.ok, JSON.stringify(r.errors));
    eq(r.summary, { interactionCount: n, timelineSource: 'videogen_scenes', checkpointsAtSec: P.planVideoCheckpoints(D, SCENES).checkpoints.map((c) => c.atSec) }, 'summary anclado (+ segundos validados, re-review I-2)');
    const r0 = V3.validateV3ItemArtifact({ ...ctx, video: { videoItemKey: 'video:ch1', durationSec: D } }, text);
    eq(r0.summary, { interactionCount: n, checkpointsAtSec: P.planInteractionCheckpoints(D).map((c) => c.atSec) }, 'summary equidistante + segundos validados');
    // v2: las reflexiones se exigen en los index del plan de pausas ANCLADO.
    const want = P.planReflectionPauses(D, P.planVideoCheckpoints(D, SCENES).checkpoints).reflections;
    const doc2 = interactionsDoc(n, D, { schemaVersion: 2, reflections: want.map((x) => ({ index: x.index, prompt: '¿Cómo lo aplicarías?' })) });
    const r2 = V3.validateV3ItemArtifact({ ...ctx, videoInteractionsSchemaVersion: 2 }, JSON.stringify(doc2));
    assert(r2.ok, JSON.stringify(r2.errors));
    eq(r2.summary.timelineSource, 'videogen_scenes', 'v2 marcado');
  });

  await check('B buildVideoActivity: con escenas las preguntas quedan en los segundos anclados del .h5p; sin escenas bytes idénticos al build de siempre', async () => {
    const n = P.planInteractionCheckpoints(D).length;
    const doc = interactionsDoc(n, D);
    const input = { itemKey: 'video:ch1', title: 'Capítulo 1', youtubeId: YT, durationSec: D, interactionsDoc: doc };
    const plainBuild = await ACT.buildVideoActivity(input);
    const nullBuild = await ACT.buildVideoActivity({ ...input, videoScenes: null });
    eq(plainBuild.sha256, nullBuild.sha256, 'null = sin escenas');
    // Review M-5: sha dorado calculado con el dist de origin/staging 7138145 (antes de r61), mismas entradas.
    eq([D, plainBuild.sha256], [601.7, GOLDEN_SHA_V1], 'sin escenas = bytes de origin/staging (v1)');
    eq(plainBuild.timelineSource, 'even_spacing', 'source sin escenas');
    const anchored = await ACT.buildVideoActivity({ ...input, videoScenes: SCENES });
    eq(anchored.timelineSource, 'videogen_scenes', 'source');
    const want = P.planVideoCheckpoints(D, SCENES).checkpoints;
    eq(anchored.checkpoints, want, 'plan');
    const content = JSON.parse(await (await JSZip.loadAsync(anchored.h5p)).file('content/content.json').async('string'));
    const froms = content.interactiveVideo.assets.interactions.map((x) => x.duration.from);
    eq(froms, want.map((c) => c.atSec), 'segundos en el .h5p');
    assert(plainBuild.sha256 !== anchored.sha256, 'el .h5p anclado es distinto');
    // ivAdvanced: remediación al inicio del segmento anclado; pausas sobre el plan anclado.
    const refl = P.planReflectionPauses(D, want).reflections;
    const adv = await ACT.buildVideoActivity({ ...input, ivAdvanced: true, videoScenes: SCENES, interactionsDoc: interactionsDoc(n, D, { schemaVersion: 2, reflections: refl.map((x) => ({ index: x.index, prompt: '¿Cómo lo aplicarías?' })) }) });
    eq(adv.reflections, refl, 'pausas');
    const advEven = await ACT.buildVideoActivity({ ...input, ivAdvanced: true, interactionsDoc: interactionsDoc(n, D, { schemaVersion: 2, reflections: P.planReflectionPauses(D, P.planInteractionCheckpoints(D)).reflections.map((x) => ({ index: x.index, prompt: '¿Cómo lo aplicarías?' })) }) });
    eq(advEven.sha256, GOLDEN_SHA_V2, 'sin escenas = bytes de origin/staging (ivAdvanced)');
  });

  await check('M-1 re-escalado d/Σ: con el MP4 1,5 s más largo que Σ escenas, los anclajes siguen el fin real de cada escena', () => {
    const d = SCENES[SCENES.length - 1].endSec + 1.5;
    const p = P.planVideoCheckpoints(d, SCENES);
    eq(p.timelineSource, 'videogen_scenes', 'source');
    const f = d / SCENES[SCENES.length - 1].endSec;
    eq(p.scenes.map((x) => x.endSec), SCENES.map((x) => Math.round(x.endSec * f * 1000) / 1000), 'escenas escaladas');
    eq(p.scenes[p.scenes.length - 1].endSec, Math.round(d * 1000) / 1000, 'la última termina en la d medida (re-review M-7: sin floor)');
    p.checkpoints.forEach((c) => assert(p.scenes.some((x) => c.atSec === Math.ceil(x.endSec - 1e-6)), `atSec ${c.atSec} = fin escalado`));
    P.assertSceneAnchoredCheckpoints(d, p.checkpoints, p.scenes);
  });

  await check('M-2 cobertura: partición exacta por ⌈fin⌉ — toda escena terminada antes de la última pausa (también las de < 1 s) cae en UNA pregunta', () => {
    const sc = P.videoScenesFromVideogen([62.4, 0.5, 57.1, 0.3, 40, 45, 38, 41, 44, 37, 39, 42, 36].map((x, i) => ({ scene_order: i + 1, narration: 's' + (i + 1), duration_seconds: x }))).scenes;
    const d = sc[sc.length - 1].endSec;
    const p = P.planVideoCheckpoints(d, sc);
    eq(p.timelineSource, 'videogen_scenes', 'source');
    const seen = new Map();
    p.checkpoints.forEach((c) => P.scenesForCheckpoint(c, p.scenes).forEach((x) => seen.set(x.order, (seen.get(x.order) || 0) + 1)));
    const last = p.checkpoints[p.checkpoints.length - 1].atSec;
    p.scenes.filter((x) => Math.ceil(x.endSec - 1e-6) <= last).forEach((x) => eq(seen.get(x.order), 1, `escena ${x.order} cubierta una vez`));
    assert(seen.get(2) === 1, 'la escena de 0,5 s entra al prompt');
  });

  await check('M-3 progress(): sin videoScenes (queda videoSceneCount); el resto del output_summary igual', () => {
    eq(RUNS.progressOutputSummary({ a: 1, videoScenes: SCENES, videoScenesUnavailable: null }), { a: 1, videoScenesUnavailable: null, videoSceneCount: SCENES.length }, 'vista');
    eq(RUNS.progressOutputSummary({ a: 1 }), { a: 1 }, 'sin escenas igual');
    eq(RUNS.progressOutputSummary(null), {}, 'null');
  });

  await check('I-1 capacidad video-scenes-1: navegador sin la capacidad → claim de siempre aunque el video tenga escenas; worker del servidor o navegador con la capacidad → anclado', () => {
    const OLD = ['pedagogy-brief-1', 'application-activity-1', 'guided-practice-1'];
    eq(SCH.VIDEO_SCENES_FEATURE, 'video-scenes-1', 'nombre');
    eq([SCH.executorAnchorsVideoScenes('owner', OLD), SCH.executorAnchorsVideoScenes('owner', [...OLD, 'video-scenes-1']), SCH.executorAnchorsVideoScenes(undefined, []), SCH.executorAnchorsVideoScenes('owner', undefined)], [false, true, true, false], 'negociación');
    assert(SCH.SERVER_OWNED_SUMMARY_KEYS.includes('videoTimelinePinned'), 'el pin es del servidor');
    const legacy = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { youtubeVideoId: YT, durationSec: D, videoScenes: SCENES }, sceneAnchors: false });
    eq(Object.keys(legacy.video), ['videoItemKey', 'youtubeId', 'durationSec', 'checkpoints'], 'claves de siempre');
    eq(legacy.video.checkpoints, P.planInteractionCheckpoints(D), 'plan de siempre');
  });

  await check('I-1 regresión: el ejecutor de origin/staging (sin video-scenes-1) contra este BE completa SIN VIDEO_PLAN_MISMATCH; el validador del servidor (pin even_spacing) lo acepta; el ejecutor actual ancla', async () => {
    const OLD_REV = '7138145';
    const files = ['05-libro.js', '07-examenes.js', '08-downloads.js', '44-dynamic-prompt-builders.js', '45-dynamic-generation-executor.js', '46-dynamic-context-package.js'];
    let oldSrc = null;
    try {
      oldSrc = files.map((f) => execFileSync('git', ['show', `${OLD_REV}:vendor/dynamic-executor/${f}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch (e) {
      console.log(`   ⚠️  sin el historial de git (${OLD_REV}): no se puede cargar el ejecutor anterior; solo se prueba el actual`);
    }
    const curSrc = files.map((f) => fs.readFileSync(path.join(__dirname, '..', 'vendor', 'dynamic-executor', f), 'utf8'));
    const C1 = 'a1b2c3d4-0000-4000-8000-000000000001';
    const M1 = 'a1b2c3d4-0000-4000-8000-00000000000a';
    const MD = '# Fallas de presión\n\n## Señales\nUna respuesta lenta del actuador anticipa una pérdida de presión.';
    const run = async (srcs, video) => {
      const store = { md: MD };
      const ctx = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON };
      ctx.window = ctx;
      ctx.SB_USER = { id: 'user-1' };
      ctx.fetch = async (url) => { if (!String(url).startsWith('mem://')) throw new Error('RED PROHIBIDA ' + url); const id = String(url).slice(6); return { ok: true, status: 200, text: async () => store[id], json: async () => JSON.parse(store[id]) }; };
      ctx.artifactDownloadUrl = async (id) => ({ ok: true, url: 'mem://' + id });
      ctx.api = async (system, user) => JSON.stringify({ checkpoints: interactionsDoc([...user.matchAll(/^- index (\d+) \(segundo/gm)].length, D).checkpoints });
      vm.createContext(ctx);
      srcs.forEach((src, i) => vm.runInContext(src, ctx, { filename: files[i] }));
      const outline = [{ moduleNumber: 1, id: M1, title: 'Hidráulica', objective: null, chapters: [{ chapterNumber: 1, id: C1, title: 'Fallas', objective: 'Decidir.' }] }];
      const item = {
        itemRunId: 'ir-vi', runId: 'run-1', courseId: 1, artifactCourseId: 'c', manifestId: 7, itemKey: 'video_interactions:' + C1, type: 'video_interactions', rulesVersion: 3,
        moduleId: M1, chapterId: C1, moduleNumber: 1, chapterNumber: 1, idempotencyKey: 'idem', generation: 1, dependsOn: ['video:' + C1, 'content:' + C1], attempt: 1, outputSummary: {},
        context: { courseContext: { nombre: 'Curso', sector: 'Minería', pais: 'Chile', contexto: 'x', nivel: 'Intermedio', tono: 'Cercano', obj: 'x' }, contextHash: 'h' },
        blueprint: { course: { id: 1, title: 'Curso' }, module: { id: M1, title: 'Hidráulica', objective: null, position: 1 }, chapter: { position: 1, videoEnabled: true, ...outline[0].chapters[0] }, moduleChapters: [], outline },
        dependencyArtifacts: [{ itemKey: 'content:' + C1, artifactId: 'md', type: 'dynamic_content_md', storagePath: 'x' }],
        claimPayload: { validatedArtifactType: 'dynamic_video_interactions_json', video: JSON.parse(JSON.stringify(video)) },
      };
      return ctx._dynRunItem(item);
    };
    const os = { youtubeVideoId: YT, durationSec: D, videoScenes: SCENES };
    const legacyClaim = V3.videoClaimFacts({ videoItemKey: 'video:' + C1, outputSummary: os, sceneAnchors: false }).video;
    const anchoredClaim = V3.videoClaimFacts({ videoItemKey: 'video:' + C1, outputSummary: os }).video;
    const serverOk = (r, anchored) => {
      const v = V3.validateV3ItemArtifact({ type: 'video_interactions', itemKey: 'video_interactions:' + C1, chapterId: C1, video: { videoItemKey: 'video:' + C1, durationSec: D, ...(anchored ? { videoScenes: SCENES } : {}) } }, r.artifacts[0].content);
      assert(v.ok, JSON.stringify(v.errors));
      return v.summary;
    };
    if (oldSrc) {
      const r = await run(oldSrc, legacyClaim);
      assert(r.ok === true, `ejecutor anterior falló: ${r.error}`);
      eq(serverOk(r, false), { interactionCount: legacyClaim.checkpoints.length, checkpointsAtSec: legacyClaim.checkpoints.map((c) => c.atSec) }, 'validado equidistante');
      // Control: sin la negociación, el claim anclado lo dejaba retenido (el bug I-1).
      const bad = await run(oldSrc, anchoredClaim);
      assert(bad.ok === false && /VIDEO_PLAN_MISMATCH/.test(bad.error), 'control: ' + JSON.stringify(bad));
    }
    const rc = await run(curSrc, anchoredClaim);
    assert(rc.ok === true, rc.error);
    eq(rc.summary.timelineSource, 'videogen_scenes', 'ejecutor actual ancla');
    eq(serverOk(rc, true).timelineSource, 'videogen_scenes', 'validado anclado');
    const rl = await run(curSrc, legacyClaim);
    assert(rl.ok === true && rl.summary.timelineSource === 'even_spacing', 'ejecutor actual con claim de siempre');
  });

  await check('M-7 duración cruda: con d no entera, claim, validación del servidor y .h5p dan el MISMO plan anclado (escala con la d medida)', async () => {
    const d2 = SCENES[SCENES.length - 1].endSec + 0.83;
    const claim = V3.videoClaimFacts({ videoItemKey: 'video:ch1', outputSummary: { youtubeVideoId: YT, durationSec: d2, videoScenes: SCENES } }).video;
    eq(claim.checkpoints, P.planVideoCheckpoints(d2, SCENES).checkpoints, 'claim');
    const n = claim.checkpoints.length;
    const r = V3.validateV3ItemArtifact({ type: 'video_interactions', itemKey: 'video_interactions:ch1', chapterId: 'ch1', video: { videoItemKey: 'video:ch1', durationSec: d2, videoScenes: SCENES } }, JSON.stringify(interactionsDoc(n, d2)));
    assert(r.ok, JSON.stringify(r.errors));
    eq(r.summary.checkpointsAtSec, claim.checkpoints.map((c) => c.atSec), 'validación');
    const b = await ACT.buildVideoActivity({ itemKey: 'video:ch1', title: 'Capítulo 1', youtubeId: YT, durationSec: d2, interactionsDoc: interactionsDoc(n, d2), videoScenes: SCENES });
    eq(b.checkpoints, claim.checkpoints, '.h5p');
  });

  await check('I-2 checkpointsFromValidatedSeconds: válidos → esos segundos (segmento [anterior, atSec]); n distinta, fuera de ventana, gap < 20, no enteros → motivo', () => {
    const even = P.planInteractionCheckpoints(D).map((c) => c.atSec);
    const ok = P.checkpointsFromValidatedSeconds(D, even.map((a) => a + 3));
    assert(ok.ok, JSON.stringify(ok));
    eq(ok.checkpoints.map((c) => [c.atSec, c.segment]), even.map((a, i) => [a + 3, [i === 0 ? 0 : even[i - 1] + 3, a + 3]]), 'segundos');
    const bad = [[even.slice(1), /preguntas validadas; las reglas vigentes piden/], [[10, ...even.slice(1)], /fuera de \[30,/], [even.map((a, i) => (i === 1 ? even[0] + 5 : a)), /a menos de 20 s/], [even.map((a) => a + 0.5), /no entero/], [null, /sin segundos/]];
    for (const [x, re] of bad) {
      const r = P.checkpointsFromValidatedSeconds(D, x);
      assert(r.ok === false && re.test(r.reason), JSON.stringify(r));
    }
  });

  await check('I-2 buildVideoActivity con los segundos validados: iguales al plan → bytes de siempre; distintos y válidos → esos segundos en el .h5p (marcado); inválidos → VIDEO_TIMELINE_MISMATCH', async () => {
    const n = P.planInteractionCheckpoints(D).length;
    const input = { itemKey: 'video:ch1', title: 'Capítulo 1', youtubeId: YT, durationSec: D, interactionsDoc: interactionsDoc(n, D) };
    const same = await ACT.buildVideoActivity({ ...input, checkpointsAtSec: P.planInteractionCheckpoints(D).map((c) => c.atSec) });
    eq([same.sha256, !!same.checkpointsFromValidation], [GOLDEN_SHA_V1, false], 'iguales');
    const moved = P.planInteractionCheckpoints(D).map((c) => c.atSec + 4);
    const b = await ACT.buildVideoActivity({ ...input, checkpointsAtSec: moved });
    eq([b.checkpoints.map((c) => c.atSec), b.checkpointsFromValidation], [moved, true], 'validados');
    const content = JSON.parse(await (await JSZip.loadAsync(b.h5p)).file('content/content.json').async('string'));
    eq(content.interactiveVideo.assets.interactions.map((x) => x.duration.from), moved, 'en el .h5p');
    let msg = '';
    try { await ACT.buildVideoActivity({ ...input, checkpointsAtSec: moved.slice(1) }); } catch (e) { msg = e.message; }
    assert(/VIDEO_TIMELINE_MISMATCH/.test(msg), msg);
  });

  await check('I-2 VIDEO_TIMELINE_MISMATCH es clase B (package_component, reparable): el empaque automático regenera SOLO ese video_interactions — nunca unclassified/hold_for_human', () => {
    const C = load('modules/reliability/failure-classifier.js');
    const AP = load('modules/dynamic-packaging/auto-package.service.js');
    const text = 'VIDEO_TIMELINE_MISMATCH: las preguntas de video_interactions:ch1 no se pueden colocar en los segundos con que se validaron sobre video:ch1 (3 preguntas validadas; las reglas vigentes piden 4); se regeneran solo esas preguntas (no se mueven en silencio).';
    const v = C.classifyFailure({ source: 'package_worker', error: text });
    eq([v.unclassified, v.class, v.rule, v.code], [false, 'B', 'package_component', 'VIDEO_TIMELINE_MISMATCH'], 'veredicto');
    assert(v.strategy !== 'hold_for_human', v.strategy);
    eq(AP.packageBlockItemKey(text, ['video_interactions:ch1:VIDEO_TIMELINE_MISMATCH'], ['video:ch1', 'video_interactions:ch1', 'content:ch1']), 'video_interactions:ch1', 'item a regenerar');
  });

  console.log(`\n${passes} ok, ${failures} fail`);
  if (failures) {
    console.error('❌ r61 Q-04 (video ↔ preguntas) roto.');
    process.exit(1);
  }
  console.log('✅ r61 Q-04 OK (escenas de Videogen → plan anclado → claim, validación y .h5p; fallback equidistante explícito).');
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
