#!/usr/bin/env node
/* eslint-disable */
// #583 (bloque QUAL) — calidad del contenido del curso de validación #2, lado servidor (builder 3.11.0):
//   I3  piso del banco por hoja = 2·slots con las reglas v4 (bankFloorFor); v1–v3 conservan el histórico al empaquetar;
//   I2  DragText: `distractors` opcional (validación: nunca la respuesta de un hueco, sin repetidos) → H5P «distractors»;
//       payloads anteriores sin el campo, byte a byte igual; el claim de la actividad lo anuncia (activityFeatures);
//   I4  caso ramificado: cada final lleva SU imagen (óptimo verde, aceptable ámbar, malo rojo) dentro del .h5p
//       (content/images/*.png, PNG 600×400 fijos); el invariante exige la imagen en todo final;
//   M1  encabezados de paso con mayúscula inicial (renderer);
//   M4  la esquina de la tabla de comparación ya no dice «Aspecto» (renderer y runtime);
//   M5  cierre condicional (nunca «Has completado…»); la tarjeta del Libro Guía es la descripción del recurso (una sola
//       entrada en la sección 1) y el validador la revisa como un label; la nota máxima por pregunta («Puntúa como 5,88»)
//       no se muestra durante el intento ni al terminarlo (reviewmaxmarks O|C).
// Puro (sin red, sin Moodle, sin LLM). Uso: node scripts/check-v583-qual.js [dist]
'use strict';
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || path.join(ROOT, 'dist'));
require('reflect-metadata');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (e) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} — ¿npm run build?\n   ${e.message}`);
    process.exit(1);
  }
}
const EB = loadDist('modules/course-shell/exam-bank.js');
const S = loadDist('modules/course-shell/index.js');
const ACT = loadDist('modules/course-shell/activity-type.js');
const vc = loadDist('modules/visual-components/index.js');
const te = loadDist('modules/theme-engine/index.js');
const cp = loadDist('modules/course-profiles/course-profiles.js');
const h = loadDist('package/h5p/index.js');
const IMG = loadDist('package/h5p/types/bs-end-images.js');
const MA = loadDist('package/v3/moodle-activities-v3.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const F = require('./lib/v21-shell-fixtures');
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function throws(fn, re, m) {
  try { fn(); } catch (e) { assert(re.test(e.message), `${m}: mensaje ${e.message}`); return; }
  throw new Error(`${m}: no lanzó`);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const THEME = te.resolveTheme(F.THEME_COMBOS[0]);

/** PNG → {w, h, rgb del píxel (x, y)} (RGB 8 bits sin entrelazado, filtro 0 como los generamos). */
function png(buf) {
  assert(buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'firma PNG');
  let o = 8, w = 0, hgt = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); hgt = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const at = (x, y) => { const i = y * (w * 3 + 1) + 1 + x * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
  return { w, h: hgt, colorType: ct, at };
}

const BS_INPUT = {
  itemKey: 'activity:7a1c0de0-0000-4000-8000-0000000005b3', title: 'La entrega que no cuadra',
  situation: 'Eres Óscar, tendero en Pereira. El distribuidor de lácteos deja la mercancía y te pide firmar rápido.',
  decisions: [
    { id: 'd1', question: 'La remisión dice 24 bolsas de leche y cuentas 20. ¿Qué haces?', options: [{ text: 'Anotas la diferencia en la remisión antes de firmar.', next: 'd2' }, { text: 'Firmas para no demorarlo y reclamas la otra semana.', next: 'end:e3' }] },
    { id: 'd2', question: 'El conductor dice que la nota no vale sin el supervisor. ¿Cómo sigues?', options: [{ text: 'Llamas al supervisor y dejas constancia escrita.', next: 'end:e1' }, { text: 'Descuentas las cuatro bolsas del próximo pago sin avisar.', next: 'end:e2' }] },
  ],
  endings: [
    { id: 'e1', quality: 'optimal', title: 'Faltante resuelto el mismo día', text: 'Tu cuaderno dice lo que hay de verdad y el distribuidor repone las bolsas.' },
    { id: 'e2', quality: 'acceptable', title: 'Cobro sin respaldo', text: 'Recuperas el dinero, pero sin constancia el distribuidor puede discutir el descuento.' },
    { id: 'e3', quality: 'poor', title: 'Pagas leche que no llegó', text: 'El cuaderno no cuadra con la nevera y pierdes el valor de las bolsas.' },
  ],
};
const DT = { itemKey: 'activity:qa', title: 'El registro de doña Carmen', taskDescription: 'Arrastra cada término al hueco que corresponde. Dos palabras sobran.',
  text: 'Al recibir mercancía en la tienda, doña Carmen anota primero la *fecha de entrega*, después cada producto con su *código del lote* y la *cantidad llegada*. Luego anota el *costo por unidad* que pagó. Antes de firmar, compara todo lo anotado con la *remisión firmada*; si algo no cuadra, lo registra en el margen del cuaderno y llama al proveedor ese mismo día.' };

(async () => {
  // ══ I3 — piso del banco ══
  await check('I3: bankFloorFor — v4 = 2·slots (= bankTarget), v1–v3 = piso histórico; la holgura del pedido sigue encima (≤ bankMax)', () => {
    for (const s of [1, 2, 3, 5, 8, 12, 20]) {
      eq(EB.bankFloorFor(s, 4), EB.bankTarget(s), `v4 s=${s}`);
      for (const v of [1, 2, 3]) eq(EB.bankFloorFor(s, v), EB.bankFloor(s), `v${v} s=${s}`);
      assert(EB.bankAskCount(s, 'multichoice') > EB.bankFloorFor(s, 4) && EB.bankAskCount(s, 'multichoice') <= EB.bankMax(s), `holgura MC s=${s}`);
      assert(EB.bankAskCount(s, 'truefalse') > EB.bankFloorFor(s, 4), `holgura V/F s=${s}`);
    }
    eq(EB.EXAM_BANK_VALIDATION_VERSION, 4, 'reglas vigentes');
  });

  // ══ I2 — DragText con distractores ══
  await check('I2: DragText — distractors opcional y validado (no es la respuesta de un hueco —sin tildes ni mayúsculas—, sin repetidos, 1–4, sin * : \\ & < >)', () => {
    h.validateDragTextInput({ ...DT, distractors: ['precio de ventas', 'fecha de vencido'] });
    h.validateDragTextInput(DT);
    throws(() => h.validateDragTextInput({ ...DT, distractors: ['Remisión  FIRMADA', 'x'] }), /distractors\[0\]: "Remisión  FIRMADA" es la respuesta de un hueco/, 'respuesta');
    throws(() => h.validateDragTextInput({ ...DT, distractors: ['precio', 'Précio'] }), /distractors\[1\]: "Précio" repetido/, 'repetido');
    throws(() => h.validateDragTextInput({ ...DT, distractors: [] }), /distractors: debe ser una lista de 1 a 4/, 'vacía');
    throws(() => h.validateDragTextInput({ ...DT, distractors: ['a', 'b', 'c', 'd', 'e'] }), /de 1 a 4/, 'cinco');
    throws(() => h.validateDragTextInput({ ...DT, distractors: ['a*b'] }), /no puede contener \* : \\ & < >/, 'asterisco');
    throws(() => h.validateDragTextInput({ ...DT, distractors: ['dos\nlíneas'] }), /una sola línea/, 'salto');
    throws(() => h.validateDragTextInput({ ...DT, distractors: 'precio' }), /lista/, 'no lista');
  });
  await check('I2: buildDragText — distractors → «*a* *b*» escapado (no suma puntaje); sin el campo, el content.json de siempre (sin la clave)', () => {
    const b = h.buildDragText({ ...DT, distractors: ['precio de ventas', 'fecha de vencido'] });
    eq(b.content.distractors, '*precio de ventas* *fecha de vencido*', 'distractors');
    eq(b.maxScore, 5, 'maxScore = huecos');
    const legacy = h.buildDragText(DT);
    assert(!('distractors' in legacy.content), 'payload anterior: sin la clave');
    eq(Object.keys(b.content).filter((k) => k !== 'distractors'), Object.keys(legacy.content), 'mismas claves');
  });
  await check('I2: validateH5pActivityPayload acepta distractors; el claim de una actividad h5p anuncia activityFeatures.dragTextDistractors', () => {
    const ok = ACT.validateH5pActivityPayload({ type: 'dragtext', data: { title: DT.title, taskDescription: DT.taskDescription, text: DT.text, distractors: ['precio de ventas', 'fecha de vencido'] } }, { chapterId: 'c1', itemKey: 'activity:qa', expectedType: 'dragtext' });
    eq(ok.errors, [], 'sin errores');
    eq(ACT.H5P_ACTIVITY_DATA_FIELDS.dragtext, ['title', 'taskDescription', 'text', 'distractors'], 'campos del LLM');
  });

  // ══ I4 — imágenes de los finales del caso ramificado ══
  await check('I4: imágenes de final — PNG 600×400 RGB fijos (sha256 declarado), verde / ámbar / rojo', () => {
    const want = { optimal: (p) => p[1] > p[0] && p[1] > p[2], acceptable: (p) => p[0] > 180 && p[1] > 120 && p[2] < 110, poor: (p) => p[0] > p[1] + 80 && p[0] > p[2] + 80 };
    for (const q of ['optimal', 'acceptable', 'poor']) {
      const im = IMG.bsEndImage(q);
      eq(sha(im.bytes), im.sha256, `${q}: sha256`);
      eq([im.path, im.mime, im.width, im.height], [`images/cursia-final-${q}.png`, 'image/png', 600, 400], `${q}: metadatos`);
      const p = png(im.bytes);
      eq([p.w, p.h, p.colorType], [600, 400, 2], `${q}: IHDR`);
      assert(want[q](p.at(10, 10)), `${q}: color de fondo ${p.at(10, 10)}`);
      eq(p.at(300, 200).length, 3, `${q}: centro`);
    }
  });
  await check('I4: buildBranchingScenario — cada final lleva feedback.image de SU calidad (el aceptable ya no muestra el «pare» rojo por defecto); contentFiles = las 3 imágenes', () => {
    const b = h.buildBranchingScenario(BS_INPUT);
    const ends = [];
    for (const n of b.content.branchingScenario.content) {
      const alts = n.type.params.branchingQuestion?.alternatives || [];
      for (const a of alts) if (a.nextContentId === -1) ends.push([a.feedback.endScreenScore, a.feedback.image]);
    }
    const byScore = Object.fromEntries(ends.map(([s, im]) => [s, im.path]));
    eq(byScore, { 10: 'images/cursia-final-optimal.png', 7: 'images/cursia-final-acceptable.png', 0: 'images/cursia-final-poor.png' }, 'imagen por puntaje');
    for (const [, im] of ends) eq([im.mime, im.width, im.height], ['image/png', 600, 400], 'metadatos de la imagen');
    eq(Object.keys(b.contentFiles).sort(), ['images/cursia-final-acceptable.png', 'images/cursia-final-optimal.png', 'images/cursia-final-poor.png'], 'archivos');
    // El invariante del empaque exige la imagen en todo final.
    const bad = JSON.parse(JSON.stringify(b.content));
    delete bad.branchingScenario.content[1].type.params.branchingQuestion.alternatives[1].feedback.image;
    throws(() => h.assertBranchingScenarioContent(bad), /final sin imagen propia/, 'sin imagen');
  });
  await check('I4: buildBundledH5p — content/images/*.png dentro del .h5p, bytes determinísticos; una imagen referenciada que falta o una ruta fuera de images/ → H5P_PACKAGE_INVALID', async () => {
    const b = h.buildBranchingScenario(BS_INPUT);
    const store = h.openH5pLibraryStore(h.CURSIA_H5P_PROFILE_V2);
    const mk = (files) => h.buildBundledH5p({ mainLibrary: b.mainLibrary, content: b.content, title: b.title, language: 'es', profile: h.CURSIA_H5P_PROFILE_V2, libraryStore: store, contentFiles: files });
    const pkg = await mk(b.contentFiles);
    const z = await JSZip.loadAsync(pkg);
    for (const q of ['optimal', 'acceptable', 'poor']) {
      const f = z.file(`content/images/cursia-final-${q}.png`);
      assert(f, `${q}: en el .h5p`);
      eq(sha(await f.async('nodebuffer')), IMG.bsEndImage(q).sha256, `${q}: bytes`);
    }
    eq(sha(await mk(b.contentFiles)), sha(pkg), 'determinístico');
    const missing = { ...b.contentFiles };
    delete missing['images/cursia-final-poor.png'];
    let err = null;
    try { await mk(missing); } catch (e) { err = e; }
    assert(err && /H5P_PACKAGE_INVALID: el contenido referencia imágenes que no van en el paquete: images\/cursia-final-poor\.png/.test(err.message), String(err && err.message));
    err = null;
    try { await mk({ ...b.contentFiles, '../x.png': Buffer.from('x') }); } catch (e) { err = e; }
    assert(err && /archivo de contenido no permitido/.test(err.message), String(err && err.message));
    // Los demás builders no cambian: sin contentFiles, ningún archivo de contenido extra.
    const dc = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención', experience: F.experienceFor('7a1c0de0-0000-4000-8000-0000000000c1') });
    if (dc) {
      const zz = await JSZip.loadAsync(await h.buildBundledH5p({ mainLibrary: dc.mainLibrary, content: dc.content, title: dc.title, language: 'es', profile: h.CURSIA_H5P_PROFILE_V2, libraryStore: store }));
      eq(Object.keys(zz.files).filter((n) => n.startsWith('content/') && !zz.files[n].dir), ['content/content.json'], 'Dialog Cards sin imágenes');
    }
  });

  // ══ M1 / M4 — renderer ══
  await check('M1: los encabezados de paso empiezan en mayúscula («calcular el presupuesto…» → «Calcular…»; «Paso 2: priorizar» → «Priorizar»; «¿cuánto…?» → «¿Cuánto…?»); nunca toca siglas ni el resto', () => {
    const we = { type: 'worked_example', title: 'La tienda de doña Carmenza', situation: 'Es lunes y llega el distribuidor.', data: ['Dinero en caja: $180.000', 'Arriendo: $50.000'],
      steps: [{ action: 'calcular el presupuesto de compras', detail: 'Resta los compromisos fijos.' }, { action: 'Paso 2: priorizar los productos', detail: 'Primero la rotación alta.' }, { action: '¿cuánto pedir?', detail: 'Solo lo esencial.' }, { action: 'IVA incluido', detail: 'Revisa la factura.' }],
      result: 'La tienda queda surtida.' };
    const html = vc.renderComponent(we, THEME, { uid: 'w' });
    const t = vc.extractText(html);
    for (const want of ['Calcular el presupuesto de compras', 'Priorizar los productos', '¿Cuánto pedir?', 'IVA incluido']) assert(t.includes(want), `falta «${want}»: ${t.slice(0, 400)}`);
    for (const bad of ['calcular el presupuesto de compras', 'priorizar los productos', '¿cuánto pedir?']) assert(!t.includes(bad), `queda «${bad}»`);
    const ps = vc.renderComponent({ type: 'process_steps', title: 'Recibir mercancía', steps: [{ heading: 'contar las unidades', body: 'Antes de firmar.' }, { heading: 'anotar en el cuaderno', body: 'Con fecha.' }] }, THEME, { uid: 'p' });
    const tp = vc.extractText(ps);
    assert(tp.includes('Contar las unidades') && tp.includes('Anotar en el cuaderno'), tp);
    eq(vc.VC_RENDER_STYLE_VERSION, 3, 'estilo del renderer');
  });
  await check('M4: comparación de 2 columnas — la esquina de la tabla queda vacía (sin «Aspecto»: el LLM a veces pone productos en las filas); el runtime de la tabla completa, igual', () => {
    const cmp = { type: 'comparison', title: 'Arroz vs snacks', columns: ['Rotación', 'Margen'], rows: [{ label: 'Arroz', cells: ['Alta', 'Bajo'] }, { label: 'Snacks', cells: ['Media', 'Alto'] }] };
    for (const level of [undefined, 'enhanced']) {
      const html = vc.renderComponent(cmp, THEME, level ? { uid: 'c', level } : { uid: 'c' });
      assert(!/Aspecto/.test(html), `${level}: sin «Aspecto»`);
      assert(/<thead><tr><td[^>]*><\/td><th scope="col"/.test(html), `${level}: esquina vacía`);
      assert(/<th scope="row"[^>]*>(?:<[^>]+>)*Arroz/.test(html), `${level}: filas con encabezado de fila`);
    }
    // > 2 columnas: el runtime (ENHANCED) arma la tabla completa con la esquina vacía.
    const rt = vc.renderComponent({ ...cmp, columns: ['A', 'B', 'C'], rows: [{ label: 'x', cells: ['1', '2', '3'] }, { label: 'y', cells: ['4', '5', '6'] }] }, THEME, { uid: 'r', level: 'enhanced' });
    assert(/cvc-cmp-stack/.test(rt) && !/Aspecto/.test(rt), 'apilada, sin «Aspecto»');
    const RT = loadDist('modules/visual-components/runtime.js');
    const js = RT.runtimeScript('u');
    assert(js.includes('N.cmp=function') && !/Aspecto/.test(js) && js.includes('var h0=d.createElement("td");hr.appendChild(h0);'), 'runtime: esquina vacía');
    eq(vc.VC_RUNTIME_VERSION, 4, 'runtime');
  });

  // ══ M5 — shell, Libro Guía, quiz ══
  const course = F.course2(distRoot);
  const facts = S.buildCourseFacts({ manifest: course.manifest, blueprint: course.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: true }), artifacts: F.measuredArtifacts(course.manifest) });
  await check('M5: el cierre nunca afirma que el estudiante completó el curso (con y sin evaluación final)', () => {
    const ci = F.courseIntroFixture();
    const withFinal = vc.extractText(S.closingLabel(facts, ci, THEME).html);
    assert(withFinal.includes('Al aprobar la evaluación final completas el recorrido del curso.') && !/Has completado/.test(withFinal), withFinal);
    const c2 = F.course2(distRoot, { finalExam: false });
    const f2 = S.buildCourseFacts({ manifest: c2.manifest, blueprint: c2.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: false }), artifacts: F.measuredArtifacts(c2.manifest) });
    const noFinal = vc.extractText(S.closingLabel(f2, ci, THEME).html);
    assert(noFinal.includes('Llegaste al cierre del recorrido del curso.') && !/Has completado|actividad|práctica/i.test(noFinal.replace(/Insignias/, '')), noFinal);
  });
  await check('M5: la descripción del recurso del Libro Guía = la tarjeta sin el botón (el nombre del recurso ya es el enlace); CLEAN_SAFE y cifras de facts', () => {
    const intro = S.libroResourceIntro(facts, THEME);
    const card = S.libroCardLabel(77, facts, THEME);
    const t = vc.extractText(intro.html);
    assert(t.includes('Libro Guía') && t.includes('El texto completo del curso en un solo documento'), t);
    assert(!/Abrir el Libro Guía|RESOURCEVIEWBYID|href=/.test(intro.html), 'sin botón ni enlace');
    assert(vc.extractText(card.html).includes('Abrir el Libro Guía'), 'la tarjeta de antes sigue igual');
    assert(vc.lintCleanSafe(intro.html).ok, 'CLEAN_SAFE');
    eq(S.lintShellNumbers(t, facts), [], 'cifras de facts');
  });
  await check('M5: quiz — la nota máxima por pregunta solo con la nota (O|C): ni durante el intento ni al terminarlo (sin «Puntúa como 5,88»); el resto de la política igual', () => {
    const D = 0x10000, I = 0x1000, O = 0x100, C = 0x10;
    eq(MA.QUIZ_REVIEW_V3.reviewmaxmarks, O | C, 'reviewmaxmarks');
    eq(MA.QUIZ_REVIEW_V3.reviewmarks, O | C, 'reviewmarks');
    assert(!(MA.QUIZ_REVIEW_V3.reviewmaxmarks & D) && !(MA.QUIZ_REVIEW_V3.reviewmaxmarks & I), 'nada en D|I');
    eq([MA.QUIZ_REVIEW_V3.reviewattempt, MA.QUIZ_REVIEW_V3.reviewoverallfeedback, MA.QUIZ_REVIEW_V3.reviewcorrectness, MA.QUIZ_REVIEW_V3.reviewrightanswer], [D | I | C, I | O | C, C, C], 'resto de la política');
  });
  await check('M5: .mbz 3.11.0 — sección 1 con UNA entrada del Libro Guía (recurso con descripción, sin label libro_card), quiz.xml con reviewmaxmarks 272; validador limpio y la descripción pasa las reglas de los labels', async () => {
    const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 583 }));
    eq(r.summary.builderVersion, '3.11.0', 'versión');
    const z = await JSZip.loadAsync(r.mbz);
    const mb = await z.file('moodle_backup.xml').async('string');
    const acts = [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>\d+<\/sectionid>\s*<modulename>(\w+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)].map((m) => ({ mid: m[1], mod: m[2], title: m[3], dir: m[4] }));
    const libroRows = acts.filter((a) => /Libro Guía/.test(a.title));
    eq(libroRows.map((a) => [a.mod, a.title]), [['resource', '📘 Libro Guía']], 'una sola entrada');
    const res = libroRows[0];
    const rx = await z.file(`${res.dir}/resource.xml`).async('string');
    const intro = unxml(/<intro>([\s\S]*?)<\/intro>/.exec(rx)[1]);
    assert(vc.extractText(intro).includes('El texto completo del curso en un solo documento'), 'descripción');
    assert(/<showdescription>1<\/showdescription>/.test(await z.file(`${res.dir}/module.xml`).async('string')), 'showdescription 1');
    for (const q of acts.filter((a) => a.mod === 'quiz')) {
      const qx = await z.file(`${q.dir}/quiz.xml`).async('string');
      assert(/<reviewmaxmarks>272<\/reviewmaxmarks><reviewmarks>272<\/reviewmarks>/.test(qx), `${q.title}: revisión`);
    }
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    eq(v.issues, [], 'validador limpio');
    // Una cifra fuera de facts en la descripción del recurso → NUMBER_NOT_FROM_FACTS (la revisa como un label).
    z.file(`${res.dir}/resource.xml`, rx.replace('El texto completo del curso', 'El texto completo de los 97 capítulos del curso'));
    const v2 = await V.validateMbzV3(await z.generateAsync({ type: 'nodebuffer' }), r.expectations);
    assert(v2.issues.some((i) => i.code === 'NUMBER_NOT_FROM_FACTS' && i.where === 'cv3:shell:libro'), JSON.stringify(v2.issues.slice(0, 3)));
  });

  console.log(`\n${failures ? 'HAY FALLOS' : 'Todos los checks de #583 QUAL pasaron'} (${passed} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
