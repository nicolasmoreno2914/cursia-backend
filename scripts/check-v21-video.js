#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R8 — chequeo PURO del video interactivo (sin red, sin Moodle, sin LLM).
//
// Cubre: plan determinístico de checkpoints (105/300/468/900/1800 s + barrido
// completo 105..14400), error VIDEO_TOO_SHORT_FOR_INTERACTIONS, validador del
// ítem `video_interactions` (rechazos), buildVideoActivity (contenido IV, UUIDs,
// bytes determinísticos), intro inline CLEAN_SAFE y entradas de files.xml.
//
// Uso (después de `npm run build`): node scripts/check-v21-video.js

const path = require('path');
const JSZip = require('jszip');

let h;
try {
  h = require(path.resolve(__dirname, '..', 'dist/package/h5p/index.js'));
} catch (err) {
  console.error(`❌ No se pudo cargar dist/package/h5p (¿npm run build?): ${err.message}`);
  process.exit(1);
}
const { makeInteractionsDoc, BANK } = require('./lib/v21-video-fixture');

let failures = 0;
let passes = 0;
const queue = [];
function check(name, fn) {
  queue.push([name, fn]);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, what) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${what}: esperado ${jb}, recibido ${ja}`);
}
function throwsWith(fn, re, what) {
  try {
    fn();
  } catch (err) {
    if (!re.test(err.message)) throw new Error(`${what}: el error "${err.message}" no coincide con ${re}`);
    return err;
  }
  throw new Error(`${what}: no lanzó`);
}
async function rejectsWith(fn, re, what) {
  try {
    await fn();
  } catch (err) {
    if (!re.test(err.message)) throw new Error(`${what}: el error "${err.message}" no coincide con ${re}`);
    return err;
  }
  throw new Error(`${what}: no lanzó`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── 1. Plan ────────────────────────────────────────────────────────────────
const PINNED = {
  105: [40, 60, 80],
  300: [73, 158, 243],
  468: [72, 157, 242, 326, 411],
  900: [83, 190, 297, 404, 511, 618, 725, 832],
  1800: [140, 359, 578, 798, 1017, 1237, 1456, 1675],
};

function planInvariants(d, plan) {
  const D = Math.floor(d);
  const n = Math.min(8, Math.max(3, Math.round(D / 100)));
  eq(plan.length, n, `d=${d} n`);
  plan.forEach((c, i) => {
    assert(c.index === i + 1, `d=${d} index ${c.index}`);
    assert(Number.isInteger(c.atSec), `d=${d} atSec entero`);
    assert(c.atSec >= 30 && c.atSec <= D - 15, `d=${d} atSec ${c.atSec} en ventana`);
    assert(c.segment[0] <= c.atSec && c.atSec <= c.segment[1], `d=${d} atSec en su segmento`);
    assert(Number.isInteger(c.segment[0]) && Number.isInteger(c.segment[1]), `d=${d} segmento entero`);
    if (i === 0) assert(c.segment[0] === 30, `d=${d} primer segmento empieza en 30`);
    else {
      assert(c.segment[0] === plan[i - 1].segment[1], `d=${d} segmentos contiguos`);
      assert(c.atSec - plan[i - 1].atSec >= 20, `d=${d} gap ≥ 20 (${plan[i - 1].atSec}→${c.atSec})`);
    }
  });
  assert(plan[plan.length - 1].segment[1] === D - 15, `d=${d} último segmento termina en d-15`);
  // Equidistancia: los gaps difieren a lo sumo en 1 s (redondeo).
  const gaps = plan.slice(1).map((c, i) => c.atSec - plan[i].atSec);
  assert(Math.max(...gaps) - Math.min(...gaps) <= 1, `d=${d} gaps equidistantes ${gaps}`);
}

for (const [d, expected] of Object.entries(PINNED)) {
  check(`plan ${d} s → ${expected.length} checkpoints en ${expected.join(', ')}`, () => {
    const plan = h.planInteractionCheckpoints(Number(d));
    eq(plan.map((c) => c.atSec), expected, `atSec ${d}`);
    planInvariants(Number(d), plan);
  });
}

check('plan 468 s: segmentos para el prompt del LLM (R11)', () => {
  eq(h.planInteractionCheckpoints(468).map((c) => c.segment), [[30, 115], [115, 199], [199, 284], [284, 368], [368, 453]], 'segmentos 468');
});

check('plan: barrido 105..14400 s — invariantes y n = clamp(round(d/100),3,8)', () => {
  for (let d = 105; d <= 14400; d++) planInvariants(d, h.planInteractionCheckpoints(d));
});

check('plan: duraciones fraccionarias usan floor (468.9 ≡ 468)', () => {
  eq(h.planInteractionCheckpoints(468.9), h.planInteractionCheckpoints(468), '468.9');
});

check('plan: determinismo (dos llamadas ⇒ mismo resultado, sin estado compartido)', () => {
  const a = h.planInteractionCheckpoints(900);
  a[0].atSec = -1;
  a[0].segment[0] = -1;
  eq(h.planInteractionCheckpoints(900), h.planInteractionCheckpoints(900), '900 x2');
  assert(h.planInteractionCheckpoints(900)[0].atSec === 83, 'mutar el resultado no afecta la siguiente llamada');
});

check('plan: < 105 s lanza VIDEO_TOO_SHORT_FOR_INTERACTIONS (104, 104.9, 60, 1)', () => {
  for (const d of [104, 104.9, 60, 1]) {
    const e = throwsWith(() => h.planInteractionCheckpoints(d), /^VIDEO_TOO_SHORT_FOR_INTERACTIONS: /, `d=${d}`);
    assert(e.code === 'VIDEO_TOO_SHORT_FOR_INTERACTIONS', 'code');
  }
  assert(h.VIDEO_CHECKPOINT_RULES.minDurationSec === 105, 'minDurationSec 105');
});

check('plan: duración inválida lanza VIDEO_DURATION_INVALID (0, -5, NaN, Infinity, "468", null, > 4 h)', () => {
  for (const d of [0, -5, NaN, Infinity, '468', null, 4 * 3600 + 1]) {
    throwsWith(() => h.planInteractionCheckpoints(d), /^VIDEO_DURATION_INVALID: /, `d=${d}`);
  }
});

// ── 2. Validador de video_interactions ──────────────────────────────────────
const PLAN468 = h.planInteractionCheckpoints(468);
const DOC = makeInteractionsDoc(PLAN468, { videoItemKey: 'video:ch1', durationSec: 468 });

check('validador: el documento fixture (468 s, 5 checkpoints, MC+TF) es válido y devuelve el plan', () => {
  eq(h.validateVideoInteractionsDoc(DOC, { videoItemKey: 'video:ch1', durationSec: 468 }), PLAN468, 'plan');
  eq(DOC.checkpoints.map((c) => c.kind), ['multichoice', 'truefalse', 'multichoice', 'truefalse', 'multichoice'], 'kinds');
});

check('validador: documentos válidos para 105/300/900/1800 s', () => {
  for (const d of [105, 300, 900, 1800]) {
    const plan = h.planInteractionCheckpoints(d);
    h.validateVideoInteractionsDoc(makeInteractionsDoc(plan, { durationSec: d }), { durationSec: d });
  }
});

const REJECTIONS = [
  ['no es objeto', () => [], /\$: debe ser un objeto/],
  ['schemaVersion 2', (d) => { d.schemaVersion = 2; }, /schemaVersion: debe ser 1/],
  ['campo raíz desconocido', (d) => { d.extra = 1; }, /campo desconocido "extra"/],
  ['videoItemKey con "#"', (d) => { d.videoItemKey = 'video#1'; }, /videoItemKey: inválido/],
  ['videoItemKey distinto del esperado', (d) => { d.videoItemKey = 'video:ch2'; }, /videoItemKey: debe ser "video:ch1"/],
  ['durationSec distinta de la real', (d) => { d.durationSec = 500; }, /durationSec: debe coincidir con la duración real 468/],
  ['durationSec demasiado corta', (d) => { d.durationSec = 90; }, /VIDEO_TOO_SHORT_FOR_INTERACTIONS/, { durationSec: undefined }],
  ['un checkpoint de menos', (d) => { d.checkpoints.pop(); }, /checkpoints: debe tener entre 5 y 5 elementos \(tiene 4\)/],
  ['un checkpoint de más', (d) => { d.checkpoints.push(clone(d.checkpoints[0])); }, /tiene 6/],
  ['index que no coincide con el plan', (d) => { d.checkpoints[2].index = 7; }, /checkpoints\[2\]\.index: debe ser 3/],
  ['índices en orden cambiado', (d) => { d.checkpoints[0].index = 2; d.checkpoints[1].index = 1; }, /checkpoints\[0\]\.index: debe ser 1/],
  ['MC con 2 opciones', (d) => { d.checkpoints[0].answers = d.checkpoints[0].answers.slice(0, 2); }, /answers: debe tener entre 3 y 4 elementos/],
  ['MC con 5 opciones', (d) => { d.checkpoints[2].answers.push({ text: 'Otra', correct: false }, { text: 'Otra más', correct: false }); }, /checkpoints\[2\]\.answers: debe tener entre 3 y 4/],
  ['MC sin correcta', (d) => { d.checkpoints[0].answers[0].correct = false; }, /exactamente 1 correcta \(hay 0\)/],
  ['MC con 2 correctas', (d) => { d.checkpoints[0].answers[1].correct = true; }, /exactamente 1 correcta \(hay 2\)/],
  ['MC con respuestas duplicadas', (d) => { d.checkpoints[0].answers[1].text = ' probabilidad  POR severidad '; }, /respuesta duplicada/],
  ['MC con `correct` suelto', (d) => { d.checkpoints[0].correct = true; }, /campo desconocido "correct"/],
  ['MC con feedback por respuesta (no está en el schema)', (d) => { d.checkpoints[0].answers[0].feedback = 'x'; }, /campo desconocido "feedback"/],
  ['TF con answers', (d) => { d.checkpoints[1].answers = [{ text: 'Sí', correct: true }]; }, /campo desconocido "answers"/],
  ['TF sin correct booleano', (d) => { d.checkpoints[1].correct = 'true'; }, /checkpoints\[1\]\.correct: debe ser booleano/],
  ['kind desconocido (blanks)', (d) => { d.checkpoints[1].kind = 'blanks'; }, /kind: debe ser "multichoice" o "truefalse"/],
  ['HTML en la pregunta', (d) => { d.checkpoints[0].question = '¿Qué es <b>esto</b>?'; }, /question: no se permite HTML/],
  ['entidad HTML en una respuesta', (d) => { d.checkpoints[0].answers[1].text = 'A&amp;B'; }, /no se permiten entidades HTML/],
  ['HTML en el feedback', (d) => { d.checkpoints[1].feedbackIncorrect = '<p>No</p>'; }, /feedbackIncorrect: no se permite HTML/],
  ['pregunta con salto de línea', (d) => { d.checkpoints[0].question = 'Línea 1\nLínea 2'; }, /una sola línea/],
  ['pregunta vacía', (d) => { d.checkpoints[0].question = '   '; }, /question: no puede estar vacío/],
  ['pregunta > 250 caracteres', (d) => { d.checkpoints[0].question = 'a'.repeat(251); }, /question: máximo 250/],
  ['respuesta > 120 caracteres', (d) => { d.checkpoints[0].answers[2].text = 'b'.repeat(121); }, /máximo 120/],
  ['feedback > 250 caracteres', (d) => { d.checkpoints[0].feedbackCorrect = 'c'.repeat(251); }, /feedbackCorrect: máximo 250/],
  ['checkpoint que no es objeto', (d) => { d.checkpoints[3] = 'x'; }, /checkpoints\[3\]: debe ser un objeto/],
];

for (const [name, mutate, re, expectOverride] of REJECTIONS) {
  check(`validador rechaza: ${name}`, () => {
    let d = clone(DOC);
    const r = mutate(d);
    if (r !== undefined) d = r;
    const expect = { videoItemKey: 'video:ch1', durationSec: 468, ...(expectOverride || {}) };
    if (expect.durationSec === undefined) delete expect.durationSec;
    const e = throwsWith(() => h.validateVideoInteractionsDoc(d, expect), /^H5P_INPUT_INVALID\(VideoInteractions\): /, name);
    assert(re.test(e.message), `mensaje "${e.message}" no coincide con ${re}`);
    assert(Array.isArray(e.errors) && e.errors.length >= 1, 'errors[]');
  });
}

check('validador: acumula TODOS los errores en una sola excepción', () => {
  const d = clone(DOC);
  d.checkpoints[0].question = '<i>x</i>';
  d.checkpoints[1].correct = 1;
  d.checkpoints[4].answers[0].correct = false;
  const e = throwsWith(() => h.validateVideoInteractionsDoc(d, { durationSec: 468 }), /H5P_INPUT_INVALID/, 'multi');
  assert(e.errors.length === 3, `3 errores, hay ${e.errors.length}: ${e.errors.join(' | ')}`);
});

// ── 3. buildVideoActivity ─────────────────────────────────────────────────
const INPUT = { itemKey: 'video:ch1', title: 'Matriz de peligros y valoración de riesgos', youtubeId: 'IdwOipZAeqY', durationSec: 468, interactionsDoc: DOC };

async function readH5p(buf) {
  const z = await JSZip.loadAsync(buf);
  return {
    names: Object.keys(z.files).sort(),
    h5pJson: JSON.parse(await z.file('h5p.json').async('string')),
    content: JSON.parse(await z.file('content/content.json').async('string')),
  };
}

check('buildVideoActivity: 5 interacciones, maxScore 5, paquete solo contenido', async () => {
  const r = await h.buildVideoActivity(INPUT);
  eq([r.interactionCount, r.maxScore], [5, 5], 'count/maxScore');
  const p = await readH5p(r.h5p);
  eq(p.names, ['content/content.json', 'h5p.json'], 'entradas del zip');
  eq(p.h5pJson.mainLibrary, 'H5P.InteractiveVideo', 'mainLibrary');
  eq(p.h5pJson.language, 'es', 'language');
});

// HD-V21-22 (resuelto por Nicolás): dentro de un intento → responder, enviar, nota, feedback y
// solución; para mejorar la nota → NUEVO intento. Nunca "ver solución → corregir → 100" en el mismo.
check('HD-V21-22 IV: sin "Reintentar" dentro del intento (override off + enableRetry false), "Ver solución" sí', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const { content } = await readH5p(r.h5p);
  eq([content.override.retryButton, content.override.showSolutionButton], ['off', 'on'], 'override del IV');
  const beh = content.interactiveVideo.assets.interactions.map((x) => x.action.params.behaviour);
  eq(beh.map((b) => [b.enableRetry, b.enableSolutionsButton, b.enableCheckButton]), beh.map(() => [false, true, true]), 'behaviour por interacción');
});

check('HD-V21-22 QuestionSet: sin reintento por pregunta dentro del intento; "Reintentar" final (= intento nuevo) sí', async () => {
  const { buildQuestionSet } = require(path.resolve(__dirname, '..', 'dist/package/h5p/types/question-set.js'));
  const q = (t, ok) => ({ kind: 'multichoice', question: t, answers: [{ text: 'Sí', correct: ok }, { text: 'No', correct: !ok }] });
  const built = buildQuestionSet({ itemKey: 'activity:x', title: 'Práctica', passPercentage: 70, questions: [q('¿Uno?', true), q('¿Dos?', false), q('¿Tres?', true)] });
  eq(built.content.questions.map((x) => x.params.behaviour.enableRetry), [false, false, false], 'enableRetry por pregunta');
  eq(built.content.endGame.showRetryButton, true, 'reintento del set completo (nuevo intento en Moodle)');
});

check('buildVideoActivity: tiempos = plan, pausa, YouTube, preventSkipping none, sin Summary', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const { content } = await readH5p(r.h5p);
  const iv = content.interactiveVideo;
  eq(iv.assets.interactions.map((x) => x.duration.from), PINNED[468], 'from');
  assert(iv.assets.interactions.every((x) => x.pause === true), 'pause');
  eq(iv.video.files[0].path, 'https://www.youtube.com/watch?v=IdwOipZAeqY', 'YouTube path');
  eq(iv.video.files[0].mime, 'video/YouTube', 'mime');
  eq(content.override.preventSkippingMode, 'none', 'preventSkipping OFF');
  assert(!iv.summary.task, 'sin Summary genérico');
  eq(iv.assets.endscreens.length, 1, 'endscreen');
  eq(r.checkpoints, PLAN468, 'checkpoints devueltos');
});

check('buildVideoActivity: subContentId = UUIDv5(item_key#i#p1) y tipos MC/TF en orden', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const { content } = await readH5p(r.h5p);
  const ids = content.interactiveVideo.assets.interactions.map((x) => x.action.subContentId);
  eq(ids, [0, 1, 2, 3, 4].map((i) => h.h5pSubContentId('video:ch1', i, 1)), 'UUIDs');
  eq(r.subContentIds, ids, 'metadata subContentIds');
  assert(ids.every(h.isUuid), 'todos UUID');
  eq(content.interactiveVideo.assets.interactions.map((x) => x.action.library), ['H5P.MultiChoice 1.16', 'H5P.TrueFalse 1.8', 'H5P.MultiChoice 1.16', 'H5P.TrueFalse 1.8', 'H5P.MultiChoice 1.16'], 'libraries');
});

check('buildVideoActivity: feedback correcto/incorrecto mapeado (MC por respuesta, TF en behaviour)', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const { content } = await readH5p(r.h5p);
  const [mc, tf] = content.interactiveVideo.assets.interactions.map((x) => x.action.params);
  const correct = mc.answers.find((a) => a.correct);
  const wrong = mc.answers.filter((a) => !a.correct);
  eq(correct.tipsAndFeedback.chosenFeedback, '<div>¡Correcto! Así se valora el riesgo.</div>', 'MC correcta');
  assert(wrong.every((a) => a.tipsAndFeedback.chosenFeedback === '<div>No es correcto: revisa esta parte del video.</div>'), 'MC incorrectas');
  eq(tf.correct, 'true', 'TF correct');
  eq(tf.behaviour.feedbackOnCorrect, '¡Correcto!', 'TF feedbackOnCorrect');
  eq(tf.behaviour.feedbackOnWrong, 'No es correcto: revisa esta parte del video.', 'TF feedbackOnWrong');
});

check('buildVideoActivity: sin inglés visible (no "Submit Answers", no "Untitled")', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const { content } = await readH5p(r.h5p);
  const s = JSON.stringify(content);
  assert(!/Submit Answers|Untitled/.test(s), 'hay textos en inglés');
  assert(/Enviar/.test(s), 'hay un botón Enviar en español');
});

check('buildVideoActivity: bytes determinísticos (sha256/sha1 iguales en dos builds)', async () => {
  const a = await h.buildVideoActivity(INPUT);
  const b = await h.buildVideoActivity(clone(INPUT));
  eq(a.sha256, b.sha256, 'sha256');
  eq(a.sha1, b.sha1, 'sha1');
  assert(a.h5p.equals(b.h5p), 'bytes');
});

check('buildVideoActivity: duración fraccionaria 468.4 produce el mismo paquete que 468', async () => {
  const a = await h.buildVideoActivity(INPUT);
  const b = await h.buildVideoActivity({ ...INPUT, durationSec: 468.4 });
  eq(a.sha256, b.sha256, 'sha256');
});

check('buildVideoActivity rechaza: itemKey ≠ videoItemKey del doc, duración real ≠ doc, video corto, youtubeId inválido', async () => {
  await rejectsWith(() => h.buildVideoActivity({ ...INPUT, itemKey: 'video:ch2' }), /videoItemKey: debe ser "video:ch2"/, 'itemKey');
  await rejectsWith(() => h.buildVideoActivity({ ...INPUT, durationSec: 600 }), /durationSec: debe coincidir con la duración real 600/, 'duración');
  await rejectsWith(() => h.buildVideoActivity({ ...INPUT, durationSec: 100 }), /VIDEO_TOO_SHORT_FOR_INTERACTIONS/, 'corto');
  await rejectsWith(() => h.buildVideoActivity({ ...INPUT, youtubeId: 'abc' }), /H5P_INPUT_INVALID\(InteractiveVideo\): youtubeId/, 'youtubeId');
  await rejectsWith(() => h.buildVideoActivity(null), /VIDEO_ACTIVITY_INVALID/, 'null');
});

// ── 4. Intro inline ──────────────────────────────────────────────────────
const INTRO_IN = { packageFilename: 'cursia-video-ch1.h5p', title: 'Matriz de peligros y valoración de riesgos', activityMid: 4242, youtubeId: 'IdwOipZAeqY' };

check('intro: iframe con data-cursia-src derivado de @@PLUGINFILE@@ (sin rutas fijas), loading=lazy, sin src', () => {
  const html = h.videoInlineIntroHtml(INTRO_IN);
  assert(html.includes('<iframe title="Matriz de peligros y valoración de riesgos" data-cursia-src="@@PLUGINFILE@@/../../../../h5p/embed.php?url=@@PLUGINFILE@@/cursia-video-ch1.h5p&amp;component=mod_h5pactivity" loading="lazy"'), 'iframe');
  assert(!/<iframe[^>]* src=/.test(html), 'el iframe no debe tener src (carga diferida)');
  assert(!/h5plib|\/h5p\/embed\.php\?/.test(html.replace('@@PLUGINFILE@@/../../../../h5p/embed.php?', '')), 'ruta fija a h5plib o /h5p/embed.php');
  assert(!/<script src=/.test(html), 'sin scripts externos');
  assert(html.includes(`<script>${h.CURSIA_IV_INLINE_SCRIPT}</script>`), 'script inline');
  assert(!/[<>&]/.test(h.CURSIA_IV_INLINE_SCRIPT), 'el script inline no contiene < > &');
});

// Simula la reescritura de Moodle (file_rewrite_pluginfile_urls) y la resolución del navegador.
function resolveEmbed(html, wwwroot, ctx) {
  const base = `${wwwroot}/pluginfile.php/${ctx}/mod_h5pactivity/intro`;
  const m = /data-cursia-src="([^"]+)"/.exec(html.split('@@PLUGINFILE@@').join(base));
  const u = new URL(m[1].replace(/&amp;/g, '&'), `${wwwroot}/course/view.php?id=2`);
  return u;
}
check('intro I3: la URL del embed resuelve a <wwwroot>/h5p/embed.php en raíz Y en subcarpeta (https://x.edu/moodle)', () => {
  const html = h.videoInlineIntroHtml(INTRO_IN);
  for (const [root, exp] of [['http://127.0.0.1:8099', 'http://127.0.0.1:8099/h5p/embed.php'], ['https://x.edu/moodle', 'https://x.edu/moodle/h5p/embed.php'], ['https://campus.example.org/a/b/moodle', 'https://campus.example.org/a/b/moodle/h5p/embed.php']]) {
    const u = resolveEmbed(html, root, 4772);
    eq(u.origin + u.pathname, exp, `embed para ${root}`);
    eq(u.searchParams.get('url'), `${root}/pluginfile.php/4772/mod_h5pactivity/intro/cursia-video-ch1.h5p`, 'url');
    eq(u.searchParams.get('component'), 'mod_h5pactivity', 'component');
  }
});

// Mini-DOM para ejecutar el script inline en Node (vm) sin dependencias.
function runInlineScript({ pathname, withIO, preInit }) {
  const vm = require('vm');
  const mk = (tag, attrs = {}) => {
    const el = { tagName: tag, attrs: { ...attrs }, style: {}, children: [], parentNode: null,
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
      querySelector(sel) { return all(this).find((e) => match(e, sel)) || null; },
      getBoundingClientRect() { return {}; } };
    return el;
  };
  const add = (p, c) => { c.parentNode = p; p.children.push(c); return c; };
  const all = (root) => root.children.flatMap((c) => [c, ...all(c)]);
  const match = (e, sel) => (sel === '.cursia-iv-inline' ? e.attrs.class === 'cursia-iv-inline' : sel === '.cursia-iv-open' ? e.attrs.class === 'cursia-iv-open' : sel === 'iframe[data-cursia-src]' ? e.tagName === 'iframe' && 'data-cursia-src' in e.attrs : false);
  const body = mk('body');
  const wrap = add(body, mk('div', { class: 'cursia-iv' }));
  const inline = add(wrap, mk('div', { class: 'cursia-iv-inline' }));
  inline.style.display = 'none';
  const frame = add(inline, mk('iframe', { 'data-cursia-src': 'http://x/h5p/embed.php?url=u' }));
  const open = add(wrap, mk('p', { class: 'cursia-iv-open' }));
  const listeners = {};
  const observed = [];
  const win = { location: { pathname }, postMessage() {}, addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {} };
  if (preInit) win.h5pResizerInitialized = true;
  if (withIO) win.IntersectionObserver = function (cb) { this.observe = (el) => observed.push({ el, cb, io: this }); this.disconnect = () => { this.off = true; }; };
  const doc = { querySelectorAll: (sel) => all(body).filter((e) => match(e, sel)), getElementsByTagName: (t) => all(body).filter((e) => e.tagName === t) };
  const ctx = { window: win, document: doc };
  vm.runInNewContext(h.CURSIA_IV_INLINE_SCRIPT, ctx);
  return { win, body, wrap, inline, frame, open, listeners, observed, run: () => vm.runInNewContext(h.CURSIA_IV_INLINE_SCRIPT, ctx) };
}
check('intro I2: en view.php el script ELIMINA el bloque inline antes de cargarlo y oculta "Abrir…"', () => {
  for (const p of ['/mod/h5pactivity/view.php', '/moodle/mod/h5pactivity/view.php']) {
    const t = runInlineScript({ pathname: p, withIO: true });
    assert(!t.wrap.children.includes(t.inline), `${p}: bloque inline no eliminado`);
    assert(t.frame.getAttribute('src') === null, `${p}: el iframe recibió src`);
    eq(t.open.style.display, 'none', `${p}: "Abrir…" visible`);
    eq(t.observed.length, 0, 'no observa nada');
  }
});
check('intro I2: en el curso activa el bloque y carga el iframe SOLO al acercarse al viewport (IntersectionObserver)', () => {
  const t = runInlineScript({ pathname: '/course/view.php', withIO: true });
  eq(t.inline.style.display, 'block', 'bloque visible');
  assert(t.frame.getAttribute('src') === null, 'cargó antes de intersectar');
  eq(t.observed.length, 1, 'observa el iframe');
  t.observed[0].cb([{ isIntersecting: false }]);
  assert(t.frame.getAttribute('src') === null, 'cargó sin intersectar');
  t.observed[0].cb([{ isIntersecting: true }]);
  eq(t.frame.getAttribute('src'), 'http://x/h5p/embed.php?url=u', 'src asignado');
  assert(t.observed[0].io.off, 'desconecta el observer');
  t.run();
  eq(t.observed.length, 1, 'idempotente: una segunda ejecución no vuelve a procesar el bloque');
  eq(t.listeners.message.length, 1, 'idempotente: un solo listener de mensajes');
});
check('intro I2: sin IntersectionObserver carga inmediatamente; respeta un resizer H5P ya instalado', () => {
  const t = runInlineScript({ pathname: '/course/view.php', withIO: false });
  eq(t.frame.getAttribute('src'), 'http://x/h5p/embed.php?url=u', 'src inmediato');
  eq(t.win.h5pResizerInitialized, true, 'marca el resizer');
  const u = runInlineScript({ pathname: '/course/view.php', withIO: false, preInit: true });
  assert(!u.listeners.message, 'no duplica el resizer si Moodle ya cargó el suyo');
});
check('intro I3: resizer inline sigue el protocolo h5p-resizer (hello, prepareResize, resize)', () => {
  const t = runInlineScript({ pathname: '/course/view.php', withIO: false });
  const sent = [];
  const src = { postMessage: (d) => sent.push(d.action) };
  t.frame.contentWindow = src;
  t.frame.clientHeight = 560;
  const fire = (data) => t.listeners.message[0]({ data, source: src, origin: 'http://x' });
  fire({ context: 'h5p', action: 'hello' });
  fire({ context: 'h5p', action: 'prepareResize', scrollHeight: 300, clientHeight: 300 });
  fire({ context: 'h5p', action: 'resize', scrollHeight: 312 });
  fire({ context: 'other', action: 'resize', scrollHeight: 999 });
  eq(sent, ['hello', 'resizePrepared'], 'respuestas');
  eq(t.frame.style.height, '312px', 'altura');
  eq(t.frame.style.width, '100%', 'ancho');
});

check('intro: fallback visible fuera del iframe (activity token + YouTube nomediaplugin)', () => {
  const html = h.videoInlineIntroHtml(INTRO_IN);
  assert(html.includes('<a href="$@H5PACTIVITYVIEWBYID*4242@$"'), 'token de la actividad');
  assert(html.includes('>Abrir el video interactivo</a>'), 'texto Abrir');
  assert(html.includes('<a class="nomediaplugin" href="https://www.youtube.com/watch?v=IdwOipZAeqY"'), 'YouTube nomediaplugin');
  assert(html.includes('>Ver el video en YouTube</a>'), 'texto YouTube');
  const iframeEnd = html.indexOf('</iframe>');
  assert(iframeEnd > 0 && html.indexOf('$@H5PACTIVITYVIEWBYID') > iframeEnd, 'el enlace está fuera (después) del iframe');
});

// Simula forceclean=1 (§X.1): elimina <style>, <script>, <iframe>, display/radius/etc.
function simulateForceclean(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/g, '');
}

check('intro CLEAN_SAFE: con forceclean simulado quedan el texto y AMBOS enlaces', () => {
  const clean = simulateForceclean(h.videoInlineIntroHtml(INTRO_IN));
  assert(!/<iframe|<script|<style/.test(clean), 'quedó algo no clean-safe');
  assert(clean.includes('Video interactivo calificable'), 'título del bloque');
  assert(clean.includes('$@H5PACTIVITYVIEWBYID*4242@$') && clean.includes('youtube.com/watch?v=IdwOipZAeqY'), 'enlaces');
});

check('intro CLEAN_SAFE: estilos inline solo con hex, fondo sólido, sin display/flex/grid/radius/var/oklch/gradiente', () => {
  const html = h.videoInlineIntroHtml(INTRO_IN);
  // Única excepción: el contenedor del iframe (no esencial) nace con display:none; con forceclean
  // se elimina display y también el iframe/script, así que queda un div vacío.
  assert(html.includes('<div class="cursia-iv-inline" style="display:none;margin:0 0 12px 0;padding:0;">'), 'contenedor inline oculto sin JS');
  const styles = [...html.replace('style="display:none;margin:0 0 12px 0;', 'style="margin:0 0 12px 0;').matchAll(/ style="([^"]*)"/g)].map((m) => m[1]);
  assert(styles.length >= 5, 'hay estilos inline');
  for (const s of styles) {
    assert(!/display|flex|grid|gap|radius|shadow|var\(|oklch|gradient|rgb\(|hsl\(|opacity|position|clamp\(/i.test(s), `estilo no clean-safe: ${s}`);
    for (const c of s.match(/#[0-9A-Za-z]+/g) || []) assert(/^#[0-9A-Fa-f]{6}$/.test(c), `color no hex: ${c}`);
  }
  assert(/background-color:#[0-9A-F]{6};color:#[0-9A-F]{6}/.test(html), 'bloque con background-color y color hex');
});

check('intro: copy en español que dice que es calificable, SIN números (los números vienen de los facts)', () => {
  const html = h.videoInlineIntroHtml(INTRO_IN);
  const text = simulateForceclean(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/calificable/.test(text) && /nota/.test(text), 'dice que es calificable');
  for (const v of Object.values(h.VIDEO_INTRO_COPY)) assert(!/\d/.test(v), `copy con dígitos: ${v}`);
});

check('intro: sin <style> (la ocultación en view.php la hace el script, no CSS)', () => {
  assert(!/<style/.test(h.videoInlineIntroHtml(INTRO_IN)), 'hay <style>');
});

check('intro: theme hex aplicado; theme/filename/mid/youtubeId/title inválidos fallan fuerte', () => {
  const html = h.videoInlineIntroHtml({ ...INTRO_IN, theme: { accent: '#AA0055' } });
  // Tarjeta con borde COMPLETO del acento (el Visual System prohíbe la franja lateral border-left).
  assert(html.includes('border:1px solid #AA0055') && html.includes('color:#AA0055'), 'accent aplicado');
  assert(!/border-(left|right)\s*:/.test(html), 'sin franja lateral');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, theme: { accent: 'oklch(0.5 0.1 200)' } }), /VIDEO_INTRO_INVALID: theme\.accent/, 'oklch');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, theme: { surface: 'var(--x)' } }), /theme\.surface/, 'var');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, packageFilename: 'x.zip' }), /packageFilename/, 'zip');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, packageFilename: '../x.h5p' }), /packageFilename/, 'path');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, activityMid: 0 }), /activityMid/, 'mid 0');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, youtubeId: 'x' }), /youtubeId/, 'youtubeId');
  throwsWith(() => h.videoInlineIntroHtml({ ...INTRO_IN, title: '<b>x</b>' }), /title/, 'title HTML');
});

check('intro: título con & y comillas se escapa en el atributo; determinismo', () => {
  const html = h.videoInlineIntroHtml({ ...INTRO_IN, title: 'Bombas & "filtros" d\'agua' });
  assert(html.includes('title="Bombas &amp; &quot;filtros&quot; d&#39;agua"'), 'escape');
  eq(h.videoInlineIntroHtml(INTRO_IN), h.videoInlineIntroHtml(clone(INTRO_IN)), 'determinismo');
});

check('videoPackageFilename: video:ch3 → cursia-video-ch3.h5p; vacío falla', () => {
  eq(h.videoPackageFilename('video:ch3'), 'cursia-video-ch3.h5p', 'ch3');
  eq(h.videoPackageFilename('video:Mod 2/Cap_10'), 'cursia-video-mod-2-cap-10.h5p', 'slug');
  throwsWith(() => h.videoPackageFilename(':::'), /VIDEO_PACKAGE_FILENAME_INVALID/, 'vacío');
});

// ── 5. Entradas de files.xml ──────────────────────────────────────────────
check('files: 2 entradas (package + intro), mismo hash SHA-1, un solo blob, mimetype h5p', async () => {
  const r = await h.buildVideoActivity(INPUT);
  const entries = h.videoActivityFileEntries({ packageFilename: 'cursia-video-ch1.h5p', h5p: r.h5p });
  eq(entries.map((e) => e.filearea), ['package', 'intro'], 'fileareas');
  assert(entries.every((e) => e.component === 'mod_h5pactivity' && e.itemid === 0 && e.filepath === '/'), 'component/itemid/filepath');
  assert(entries.every((e) => e.contenthash === r.sha1 && e.filesize === r.h5p.length), 'hash/size');
  eq(entries[0].blobPath, `files/${r.sha1.slice(0, 2)}/${r.sha1}`, 'blobPath');
  eq(entries[0].blobPath, entries[1].blobPath, 'un solo blob');
  eq(entries[0].mimetype, 'application/zip.h5p', 'mimetype');
  throwsWith(() => h.videoActivityFileEntries({ packageFilename: 'a.h5p', h5p: Buffer.alloc(0) }), /VIDEO_ACTIVITY_FILES_INVALID/, 'vacío');
});

check('ajustes Moodle: grade 100, gradepass 70, completion por nota aprobatoria, showdescription', () => {
  const S = h.VIDEO_ACTIVITY_MOODLE_SETTINGS;
  eq([S.grade, S.gradepass, S.completion, S.completionpassgrade, S.showdescription, S.displayoptions], [100, 70, 2, 1, 1, 15], 'settings');
});

check('fixture: el banco cubre 8 checkpoints y los MC tienen 3–4 opciones', () => {
  assert(BANK.length === 8, '8');
  assert(BANK.filter((b) => b.kind === 'multichoice').every((b) => b.wrong.length >= 2 && b.wrong.length <= 3), 'MC');
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passes++;
      console.log(`✅ ${name}`);
    } catch (err) {
      failures++;
      console.error(`❌ ${name}`);
      console.error(`   ${err.message}`);
    }
  }
  console.log('');
  if (failures) {
    console.error(`❌ check-v21-video: ${failures} fallo(s), ${passes} ok.`);
    process.exit(1);
  }
  console.log(`✅ check-v21-video: ${passes} ok.`);
})();
