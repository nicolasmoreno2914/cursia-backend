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
    const ends = SCENES.map((s) => Math.ceil(s.endSec - 1e-6));
    p.checkpoints.forEach((c, i) => {
      assert(ends.includes(c.atSec), `atSec ${c.atSec} no es fin de escena`);
      assert(c.atSec >= 30 && c.atSec <= Math.floor(D) - 15, 'ventana');
      eq(c.segment, [i === 0 ? 0 : p.checkpoints[i - 1].atSec, c.atSec], 'segmento');
      if (i) assert(c.atSec - p.checkpoints[i - 1].atSec >= 20, 'gap');
      const sc = P.scenesForCheckpoint(c, SCENES);
      assert(sc.length >= 1 && Math.ceil(sc[sc.length - 1].endSec - 1e-6) === c.atSec, 'la última escena cubierta termina en la pausa');
    });
    P.assertSceneAnchoredCheckpoints(D, p.checkpoints, SCENES);
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
    eq(r.summary, { interactionCount: n, timelineSource: 'videogen_scenes' }, 'summary anclado');
    const r0 = V3.validateV3ItemArtifact({ ...ctx, video: { videoItemKey: 'video:ch1', durationSec: D } }, text);
    eq(r0.summary, { interactionCount: n }, 'summary de siempre');
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
