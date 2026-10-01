#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R12: empaque v3 (PURO). Sin DB, sin red, sin proveedores.
// Corre contra los módulos COMPILADOS de dist/ (npm run build antes).
//
//  - plan v3: cada item del Manifest en exactamente un lugar; fail loud ante Manifest roto;
//  - builder v3 sobre fixtures: 2 módulos × las 4 combinaciones video/actividad,
//    examen final on/off, motor h5p y scorm, tema claro y oscuro, portadas mock;
//  - validador v3 (§Q.8) en verde para toda la matriz y ROJO ante cada mutación;
//  - estructura por UUID (idnumber cv3:…) = plan + chapterSlotSequence;
//  - determinismo con reloj fijo (mismo proceso y otro TZ);
//  - cambio de tema / de nota mínima = paquete nuevo con los MISMOS contenidos;
//  - fail loud (contenido faltante, H5P no calificable, tipo H5P ajeno a la rotación,
//    categoría ponderada vacía, perfil inaplicable, cifra en un intro);
//  - guarda de mocks (R-007), tema por perfil/legacy/default, clave de reuse v3;
//  - worker v3 con dependencias falsas: fixtures de proveedor mock fluyen, un run real
//    con mocks falla, restore-first, cambio de perfil = paquete nuevo, evento ZERO_BY_DESIGN.
//
// Usage: node scripts/check-v21-packaging-v3.js [path/to/dist]

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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

const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const PV3 = loadDist('modules/dynamic-packaging/packaging-plan-v3.js');
const PK = loadDist('modules/dynamic-packaging/packaging-v3.js');
const G = loadDist('modules/dynamic-packaging/packaging-guards.js');
const MEDIA = loadDist('package/v3/synthetic-media.js');
const PNG = loadDist('package/v3/png-downscale.js');
const PRES = loadDist('package/presentation/index.js');
const TE = loadDist('modules/theme-engine/index.js');
const VC = loadDist('modules/visual-components/index.js');
const AUDIO = loadDist('package/audio/index.js');
const SHELL = loadDist('modules/course-shell/index.js');
const PROF = loadDist('modules/course-profiles/course-profiles.js');
const THEME = loadDist('modules/theme-engine/index.js');
const A = loadDist('package/assessment/index.js');
const H5P = loadDist('package/h5p/index.js');
const MA = loadDist('package/v3/moodle-activities-v3.js');
const W = loadDist('workers/dynamic-package-worker.js');
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
async function rejects(p, re, m) {
  let e = null;
  try { await p; } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${e.message.slice(0, 300)}"`);
  return e;
}
function throwsSync(fn, re, m) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${e.message.slice(0, 300)}"`);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function build(o) {
  const input = PF.packagingInput(distRoot, o);
  if (o.level) input.level = o.level;
  const r = await B.buildDynamicMbzV3(input);
  return { input, r };
}
async function validate(r) {
  return V.validateMbzV3(r.mbz, r.expectations);
}

async function mutate(mbz, edits) {
  const z = await JSZip.loadAsync(mbz);
  for (const [file, fn] of Object.entries(edits)) {
    const cur = await z.file(file).async('string');
    const next = fn(cur);
    if (next === cur) throw new Error(`la mutación de ${file} no cambió nada`);
    z.file(file, next);
  }
  return z.generateAsync({ type: 'nodebuffer' });
}

async function actDirs(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const mb = await z.file('moodle_backup.xml').async('string');
  const acts = [];
  const contents = /<contents>([\s\S]*?)<\/contents>/.exec(mb)[1];
  for (const b of contents.match(/<activity>[\s\S]*?<\/activity>/g)) {
    const dir = /<directory>(.*?)<\/directory>/.exec(b)[1];
    const mod = await z.file(`${dir}/module.xml`).async('string');
    acts.push({
      dir,
      modname: /<modulename>(.*?)<\/modulename>/.exec(b)[1],
      section: Number(/<sectionid>(.*?)<\/sectionid>/.exec(b)[1]),
      idnumber: /<idnumber>(.*?)<\/idnumber>/.exec(mod)[1],
    });
  }
  return { z, acts };
}

const expectedSequence = (input) => PF.expectedSequence(distRoot, input);

const MATRIX = [
  { id: 'h5p-final-light', engine: 'h5p', finalExam: true, theme: { themeFamily: 'aula-clara', mode: 'light' } },
  { id: 'scorm-nofinal-dark', engine: 'scorm', finalExam: false, theme: { themeFamily: 'oscuro-premium', mode: 'dark' }, realAudio: true },
  { id: 'h5p-nofinal-dark-mock-cleansafe', engine: 'h5p', finalExam: false, theme: { themeFamily: 'tecnico', mode: 'dark' }, mockPresentations: true, level: 'clean_safe' },
  { id: 'scorm-final-light', engine: 'scorm', finalExam: true, theme: { themeFamily: 'institucional', mode: 'light' } },
];

(async () => {
  // ── Plan ──────────────────────────────────────────────────────────────────
  await check('plan v3: cada item del Manifest en exactamente un lugar; EV6: secciones 0, 1, una por capítulo / evaluación, evaluación final, cierre', async () => {
    const { manifest, blueprint } = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const plan = PV3.buildPackagingPlanV3(manifest, blueprint, { manifestId: 7 });
    // Fixture: módulo 1 (2 capítulos, con examen), módulo 2 (2 capítulos, sin examen), examen final.
    eq(plan.sections.map((s) => [s.sectionNum, s.kind]), [[0, 'shell'], [1, 'route_and_book'], [2, 'chapter'], [3, 'chapter'], [4, 'module_exam'], [5, 'chapter'], [6, 'chapter'], [7, 'final_exam'], [8, 'closing']], 'secciones');
    const chs = plan.modules.flatMap((m) => m.chapters);
    eq(plan.sections.filter((s) => s.kind === 'chapter').map((s) => [s.chapterId, s.title]), chs.map((c) => [c.chapterId, `Módulo ${c.moduleNumber} · Capítulo ${c.chapterNumber}: ${c.title}`]), 'títulos de las secciones de capítulo');
    eq(chs.map((c) => c.sectionNum), [2, 3, 5, 6], 'sección de cada capítulo');
    eq(plan.modules.map((m) => [m.firstSectionNum, m.examSectionNum]), [[2, 4], [5, null]], 'primera sección y sección de evaluación por módulo');
    eq(plan.sections.find((s) => s.kind === 'module_exam').title, 'Módulo 1 · Evaluación', 'título de la evaluación del módulo');
    eq([plan.finalExamSectionNum, plan.closingSectionNum, plan.sections[plan.sections.length - 1].title], [7, 8, 'Cierre del curso'], 'evaluación final ANTES del cierre; el cierre es la última sección');
    const nf = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false });
    const pnf = PV3.buildPackagingPlanV3(nf.manifest, nf.blueprint);
    eq([pnf.sections.map((s) => s.kind).slice(-2), pnf.finalExamSectionNum, pnf.closingSectionNum], [['chapter', 'closing'], null, 7], 'sin examen final: el cierre sigue al último capítulo');
    const keys = new Set([
      ...Object.values(plan.keys).filter(Boolean),
      ...plan.modules.flatMap((m) => [...Object.values(m.keys).filter(Boolean), ...m.chapters.flatMap((c) => Object.values(c.keys).filter(Boolean))]),
    ]);
    eq([...keys].sort(), manifest.items.map((i) => i.key).sort(), 'items consumidos');
    eq(PV3.packagingPlanV3Sha256(plan), PV3.packagingPlanV3Sha256(PV3.buildPackagingPlanV3(manifest, blueprint, { manifestId: 7 })), 'plan determinístico');
  });
  await check('plan v3 falla fuerte: item faltante, item extra, sha del Blueprint distinto, Manifest v1', async () => {
    const { manifest, blueprint } = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const m1 = JSON.parse(JSON.stringify(manifest));
    m1.items = m1.items.filter((i) => i.type !== 'audiobook_chapter' || i !== m1.items.find((x) => x.type === 'audiobook_chapter'));
    throwsSync(() => PV3.buildPackagingPlanV3(m1, blueprint), /PACKAGING_PLAN_V3_INVALID: falta el item audiobook_chapter:/, 'faltante');
    const m2 = JSON.parse(JSON.stringify(manifest));
    m2.items.push({ ...m2.items.find((i) => i.type === 'content'), key: 'content:intruso' });
    throwsSync(() => PV3.buildPackagingPlanV3(m2, blueprint), /sin lugar en el paquete: content:intruso/, 'extra');
    const bp = JSON.parse(JSON.stringify(blueprint));
    bp.course.title += ' (editado)';
    throwsSync(() => PV3.buildPackagingPlanV3(manifest, bp), /blueprintSha256 no coincide/, 'sha');
    throwsSync(() => PV3.buildPackagingPlanV3({ ...manifest, rulesVersion: 1 }, blueprint), /rulesVersion 3/, 'v1');
  });

  // ── Matriz: build + validador + estructura ────────────────────────────────
  const built = {};
  for (const cfg of MATRIX) {
    await check(`[${cfg.id}] build v3 + validador §Q.8 sin hallazgos`, async () => {
      const { input, r } = await build(cfg);
      built[cfg.id] = { input, r };
      const v = await validate(r);
      assert(v.ok, `hallazgos: ${JSON.stringify(v.issues.slice(0, 5))}`);
      const c = r.summary.counts;
      eq([c.modules, c.chapters, c.videos, c.activities, c.finalExam], [2, 4, 2, 2, cfg.finalExam], 'conteos');
      eq(v.stats.graded, 2 + 2 + 1 + (cfg.finalExam ? 1 : 0), 'ítems calificables (2 videos + 2 actividades + examen + final)');
      eq(v.stats.h5p, cfg.engine === 'h5p' ? 4 : 2, 'h5pactivity');
    });
    await check(`[${cfg.id}] estructura por UUID: idnumbers por sección = Manifest + chapterSlotSequence`, async () => {
      const { input, r } = built[cfg.id];
      const { acts } = await actDirs(r.mbz);
      const got = [];
      for (const a of acts) {
        let row = got.find((x) => x[0] === a.section);
        if (!row) got.push((row = [a.section, []]));
        row[1].push(a.idnumber);
      }
      eq(got, expectedSequence(input), 'secuencia');
      const modOf = Object.fromEntries(acts.map((a) => [a.idnumber, a.modname]));
      for (const ch of input.manifest.modules.flatMap((m) => m.chapters)) {
        if (ch.videoEnabled) eq(modOf[`cv3:ch:${ch.chapterId}:video`], 'h5pactivity', 'video = h5pactivity');
        if (ch.activityEnabled) eq(modOf[`cv3:ch:${ch.chapterId}:activity`], cfg.engine === 'h5p' ? 'h5pactivity' : 'scorm', 'actividad');
      }
    });
  }

  // P2-B1 (EV6 Fase 2 — exámenes): cada quiz_*/quiz.xml (examen de módulo y examen final) de TODA la
  // matriz lleva exactamente los 8 campos de revisión de QUIZ_REVIEW_V3 y, con el perfil por defecto
  // (intentos 3), completionattemptsexhausted 1.
  await check('P2-B1: todo quiz.xml de la matriz tiene la política de revisión y completionattemptsexhausted = (attempts_number > 0)', async () => {
    let quizzes = 0;
    for (const cfg of MATRIX) {
      const { z, acts } = await actDirs(built[cfg.id].r.mbz);
      for (const a of acts.filter((x) => x.modname === 'quiz')) {
        const x = await z.file(`${a.dir}/quiz.xml`).async('string');
        for (const [field, want] of Object.entries(MA.QUIZ_REVIEW_V3)) {
          const got = new RegExp(`<${field}>(\\d+)</${field}>`).exec(x)?.[1];
          eq(Number(got), want, `${cfg.id} ${a.idnumber}: ${field}`);
        }
        const attempts = Number(/<attempts_number>(\d+)<\/attempts_number>/.exec(x)[1]);
        const exhausted = /<completionattemptsexhausted>(\d+)<\/completionattemptsexhausted>/.exec(x)[1];
        eq(exhausted, attempts > 0 ? '1' : '0', `${cfg.id} ${a.idnumber}: completionattemptsexhausted vs attempts_number ${attempts}`);
        quizzes++;
      }
    }
    assert(quizzes >= MATRIX.filter((c) => c.finalExam).length + MATRIX.length, `se revisaron ${quizzes} quizzes`);
  });

  // P2-B1 acceptance A1: `attempts: { exam: 0 }` → completionattemptsexhausted 0 solo en el examen de
  // módulo (intentos ilimitados nunca se agotan); el examen final, con el perfil por defecto, sigue en 1.
  await check('P2-B1: attempts.exam = 0 (ilimitado) → completionattemptsexhausted 0 en el examen de módulo', async () => {
    const defaults = PROF.defaultAssessmentProfile({ finalExam: true });
    const profile = { ...defaults, attempts: { ...defaults.attempts, exam: 0 } };
    const { r } = await build({ engine: 'h5p', finalExam: true, profile });
    const v = await validate(r);
    assert(v.ok, `hallazgos: ${JSON.stringify(v.issues.slice(0, 5))}`);
    const { z, acts } = await actDirs(r.mbz);
    const moduleExam = acts.find((a) => /^cv3:exam:/.test(a.idnumber));
    const finalExam = acts.find((a) => a.idnumber === 'cv3:final_exam');
    const examXml = await z.file(`${moduleExam.dir}/quiz.xml`).async('string');
    const finalXml = await z.file(`${finalExam.dir}/quiz.xml`).async('string');
    eq(/<attempts_number>(\d+)<\/attempts_number>/.exec(examXml)[1], '0', 'examen de módulo: intentos ilimitados');
    eq(/<completionattemptsexhausted>(\d+)<\/completionattemptsexhausted>/.exec(examXml)[1], '0', 'examen de módulo: nunca se agota');
    eq(/<attempts_number>(\d+)<\/attempts_number>/.exec(finalXml)[1], '3', 'examen final: intentos del perfil sin tocar');
    eq(/<completionattemptsexhausted>(\d+)<\/completionattemptsexhausted>/.exec(finalXml)[1], '1', 'examen final: sigue agotándose');
  });

  // Aceptación staging V2.1: el Visual System prohíbe franjas laterales (border-left/right > 1px como acento).
  // Se escanea TODO texto del paquete: XML de actividades/labels (HTML escapado), Libro, blobs de texto.
  await check('Visual System: ningún HTML del paquete v3 usa franja lateral (border-left/right > 1px), en toda la matriz', async () => {
    const STRIPE = /border-(?:left|right)(?:-width)?\s*:\s*(?:[2-9]|\d{2,})(?:\.\d+)?px/i;
    const hits = [];
    for (const cfg of MATRIX) {
      const z = await JSZip.loadAsync(built[cfg.id].r.mbz);
      for (const name of Object.keys(z.files)) {
        const f = z.files[name];
        if (f.dir) continue;
        const buf = await f.async('nodebuffer');
        if (buf.subarray(0, 2).toString('latin1') === 'PK' || buf.subarray(0, 4).toString('latin1') === '%PDF') continue;
        const txt = buf.toString('utf8');
        const m = STRIPE.exec(txt);
        if (m) hits.push(`${cfg.id}:${name}: …${txt.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ')}…`);
      }
    }
    eq(hits.slice(0, 6), [], 'franjas laterales encontradas');
    // Review I3: la tarjeta de módulo del Libro conserva el padding de su clase (el h2 no queda pegado al borde).
    const lib = await JSZip.loadAsync(built['h5p-final-light'].r.mbz);
    let libro = '';
    for (const n of Object.keys(lib.files)) { if (!n.startsWith('files/') || lib.files[n].dir) continue; const t = (await lib.files[n].async('nodebuffer')).toString('utf8'); if (t.includes('cc-libro-module')) { libro = t; break; } }
    const secs = libro.match(/<section[^>]*class="cc-libro-module"[^>]*>/g) || [];
    assert(secs.length > 0, 'Libro con tarjetas de módulo');
    eq(secs.filter((x) => /padding/.test(x)), [], 'padding inline que pisa el de la clase');
  });

  await check('[h5p-final-light] H5P: activity type por UUID del capítulo (R-012), paquetes content-only del perfil, sin SingleChoiceSet', async () => {
    const { input, r } = built['h5p-final-light'];
    const acts = r.summary.h5pPackages.filter((p) => p.itemKey.startsWith('activity:'));
    const LIB = { questionset: 'H5P.QuestionSet', dragtext: 'H5P.DragText', blanks: 'H5P.Blanks' };
    for (const p of acts) {
      const chapterId = p.itemKey.slice('activity:'.length);
      eq(p.mainLibrary, LIB[SHELL.activityTypeForChapter(chapterId)], `tipo de ${p.itemKey}`);
      // EV5-C: Manifest legacy (sin h5pType) ⇒ el resolvedor único da exactamente el hash.
      eq(SHELL.resolveActivityType(input.manifest.items.find((i) => i.key === p.itemKey)), SHELL.activityTypeForChapter(chapterId), `resolver legacy ${p.itemKey}`);
      assert(p.mainLibrary !== 'H5P.SingleChoiceSet', 'SCS nunca calificable (R-011)');
    }
    assert(r.summary.h5pPackages.filter((p) => p.mainLibrary === 'H5P.InteractiveVideo').length === 2, 'dos IV');
    void input;
  });

  await check('[h5p-final-light] portada Gamma reducida (≤ 640 px) y PDF/PNG en el filearea intro del label de la tarjeta', async () => {
    const { r } = built['h5p-final-light'];
    const { z, acts } = await actDirs(r.mbz);
    const files = await z.file('files.xml').async('string');
    const pres = acts.filter((a) => /:presentation$/.test(a.idnumber));
    eq(pres.length, 4, 'una tarjeta por capítulo');
    for (const a of pres) {
      const ctx = /contextid="(\d+)"/.exec(await z.file(`${a.dir}/label.xml`).async('string'))[1];
      const mine = files.match(/<file id="\d+">[\s\S]*?<\/file>/g).filter((f) => f.includes(`<contextid>${ctx}</contextid>`));
      const png = mine.find((f) => /portada\.png/.test(f));
      const pdf = mine.find((f) => /presentacion\.pdf/.test(f));
      assert(png && pdf && /<filearea>intro<\/filearea>/.test(png) && /<component>mod_label<\/component>/.test(pdf), `archivos de ${a.idnumber}`);
      const h = /<contenthash>(\w+)<\/contenthash>/.exec(png)[1];
      const dims = PRES.pngDimensions(await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer'));
      eq([dims.width, dims.height], [640, 360], 'portada reducida');
    }
    eq(r.summary.warnings, [], 'sin avisos');
  });

  await check('[scorm-nofinal-dark] SCORM: scoes del imsmanifest real, completion solo por nota (R6), whatgrade/maxattempt del perfil', async () => {
    const { r } = built['scorm-nofinal-dark'];
    const { z, acts } = await actDirs(r.mbz);
    const sc = acts.filter((a) => a.modname === 'scorm');
    eq(sc.length, 2, 'dos SCORM');
    for (const a of sc) {
      const x = await z.file(`${a.dir}/scorm.xml`).async('string');
      assert(/<maxgrade>100<\/maxgrade>/.test(x) && /<whatgrade>0<\/whatgrade>/.test(x) && /<maxattempt>0<\/maxattempt>/.test(x), 'campos de evaluación');
      assert(/<completionstatusrequired>\$@NULL@\$<\/completionstatusrequired>/.test(x), 'sin regla de estado');
      assert(/<identifier>cap\d+_org<\/identifier>/.test(x) && /<identifier>item_1<\/identifier>/.test(x), 'ids del manifiesto');
    }
  });

  await check('[h5p-final-light] Libro Guía v3: <style> con tokens del tema + print CSS, prefacios, capítulos, bibliografía y </html>', async () => {
    const { input, r } = built['h5p-final-light'];
    const { z, acts } = await actDirs(r.mbz);
    const libro = acts.find((a) => a.idnumber === 'cv3:shell:libro');
    const ctx = /contextid="(\d+)"/.exec(await z.file(`${libro.dir}/resource.xml`).async('string'))[1];
    const files = await z.file('files.xml').async('string');
    const f = files.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((x) => x.includes(`<contextid>${ctx}</contextid>`) && x.includes('libro_guia_completo.html'));
    const h = /<contenthash>(\w+)<\/contenthash>/.exec(f)[1];
    const html = await z.file(`files/${h.slice(0, 2)}/${h}`).async('string');
    const theme = THEME.resolveTheme(input.presentation);
    assert(html.trim().endsWith('</html>'), '</html>');
    assert(html.includes('@media print') && html.includes(theme.color.accentStrong), 'print CSS + tokens');
    assert(html.includes('Al terminar este módulo podrás') && html.includes('Bibliografía general del curso'), 'prefacio + bibliografía');
    assert(html.includes('Visible Learning') && html.includes('(2009)'), 'entradas de bibliografía (verificadas)');
    for (const m of input.manifest.modules) for (const c of m.chapters) assert(html.includes(`id="cap-${c.chapterNumber}"`), `capítulo ${c.chapterNumber}`);
    const words = r.expectations.facts.libro.wordCount;
    assert(words > 100, 'palabras medidas');
  });

  await check('[h5p-final-light] audio: MP3 de bienvenida y audiolibro ensamblado (R10) en el intro de sus labels, duraciones medidas', async () => {
    const { input, r } = built['h5p-final-light'];
    const f = r.expectations.facts;
    eq(Math.abs(f.audio.welcomeSeconds - AUDIO.mp3DurationSeconds(input.contents.audioWelcome)) < 1e-9, true, 'bienvenida medida');
    const sum = [...input.contents.audiobookChapters.values()].reduce((s, b) => s + AUDIO.mp3DurationSeconds(b), 0);
    assert(Math.abs(f.audio.audiobookSeconds - sum) < 1e-6, 'audiolibro = suma de partes');
  });

  // ── Determinismo ──────────────────────────────────────────────────────────
  await check('título de capítulo > 200 caracteres (InteractiveVideo + actividad H5P): el paquete se genera, el título H5P queda ≤ 200 sin cortar palabras y sigue identificable', async () => {
    const H = loadDist('package/h5p/index.js');
    const LONG = 'Comercialización y distribución de productos agrícolas Canales de comercialización, análisis de costos y precios, identificación de mercados locales y regionales, logística de transporte y almacenamiento poscosecha para pequeños productores';
    assert(LONG.length > 200 && LONG.length <= 255, `fixture ${LONG.length}`);
    const t = H.h5pTitle(LONG);
    assert(t.length <= 200 && t.endsWith('…'), `h5pTitle: ${t.length}`);
    assert(t.startsWith('Comercialización y distribución de productos agrícolas'), 'identificable');
    const body = t.slice(0, -1);
    assert(LONG.startsWith(body) && [' ', ','].includes(LONG[body.length]), `no corta palabras: "${body.slice(-20)}|${LONG.slice(body.length, body.length + 5)}"`);
    eq(H.h5pTitle('  Título   corto  '), 'Título corto', 'corto: solo normaliza espacios');
    eq(H.h5pTitle('x'.repeat(250)).length <= 200, true, 'sin espacios: corta igual');
    const { r } = await build({ engine: 'h5p', finalExam: true, courseId: 671, chapterTitles: [LONG],
      modules: [{ examEnabled: true, chapters: [{ video: true, activity: true }] }] });
    assert(r && r.mbz && r.mbz.length > 0, 'MBZ generado');
    const v = await validate(r);
    assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
  });

  await check('determinismo: mismos insumos + reloj fijo → mismos bytes (dos veces y en otro TZ)', async () => {
    const a = (await build(MATRIX[0])).r.mbz;
    const b = (await build(MATRIX[0])).r.mbz;
    eq(sha(a), sha(b), 'mismo proceso');
    const code = `const PF=require(${JSON.stringify(path.join(__dirname, 'lib/v21-packaging-fixtures.js'))});` +
      `const B=require(${JSON.stringify(path.join(distRoot, 'package/dynamic-mbz-builder-v3.js'))});` +
      `B.buildDynamicMbzV3(PF.packagingInput(${JSON.stringify(distRoot)},${JSON.stringify(MATRIX[0])})).then(r=>{process.stdout.write(require('crypto').createHash('sha256').update(r.mbz).digest('hex'))}).catch(e=>{console.error(e);process.exit(1)})`;
    const out = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'Pacific/Kiritimati' }, encoding: 'utf8' });
    assert(out.status === 0, `child: ${out.stderr}`);
    eq(out.stdout, sha(a), 'otro TZ');
    const c = await B.buildDynamicMbzV3({ ...PF.packagingInput(distRoot, MATRIX[0]), ts: 1790500001 });
    assert(sha(c.mbz) !== sha(a), 'otro reloj → otros bytes (el ts está en el paquete)');
  });

  // ── Tema / nota mínima: paquete nuevo, mismos contenidos ─────────────────
  await check('cambio de tema → paquete distinto con los MISMOS artifacts de contenido (H5P idénticos, sin regenerar)', async () => {
    const base = built['h5p-final-light'].r;
    const other = (await build({ ...MATRIX[0], theme: { themeFamily: 'editorial', mode: 'light' } })).r;
    assert(sha(base.mbz) !== sha(other.mbz), 'bytes distintos');
    assert(base.summary.themeSha256 !== other.summary.themeSha256, 'themeSha distinto');
    eq(other.summary.h5pPackages.map((p) => p.sha1), base.summary.h5pPackages.map((p) => p.sha1), 'mismos .h5p');
    assert((await validate(other)).ok, 'valida');
    const k = (t) => PK.packageReuseHashV3({ builderVersion: '3.0.0', manifestSha256: 'm', sourceArtifactIds: ['b', 'a'], themeSha256: t, assessmentProfileSha256: 'p', h5pProfileVersion: 1, vcRendererVersion: 'r', moodleVersion: '4.1' });
    assert(k(base.summary.themeSha256) !== k(other.summary.themeSha256), 'clave de reuse distinta');
  });
  await check('cambio de passingGrade (70→80) → paquete distinto: gradepass 80 y passPercentage del QuestionSet = 80, sin contenidos nuevos', async () => {
    const p = PROF.defaultAssessmentProfile({ finalExam: true });
    p.passingGrade = 80;
    const { r } = await build({ ...MATRIX[0], profile: p });
    const v = await validate(r);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    eq(r.expectations.resolved.kinds.activity.passingGrade, 80, 'perfil');
    assert(sha(r.mbz) !== sha(built['h5p-final-light'].r.mbz), 'bytes distintos');
    const { z } = await actDirs(r.mbz);
    const qs = r.summary.h5pPackages.find((x) => x.mainLibrary === 'H5P.QuestionSet');
    if (qs) {
      const blob = await z.file(`files/${qs.sha1.slice(0, 2)}/${qs.sha1}`).async('nodebuffer');
      const content = JSON.parse(await (await JSZip.loadAsync(blob)).file('content/content.json').async('string'));
      eq(content.passPercentage, 80, 'passPercentage');
    }
    const grades = await z.file('gradebook.xml').async('string');
    assert(/<gradepass>80\.00000<\/gradepass>/.test(grades), 'gradepass del curso 80');
    // el validador con el perfil VIEJO rechaza el paquete nuevo
    const stale = await V.validateMbzV3(r.mbz, built['h5p-final-light'].r.expectations);
    assert(!stale.ok && stale.issues.some((i) => i.code === 'GRADEPASS'), 'GRADEPASS contra el perfil viejo');
  });

  // ── Validador: cada mutación se detecta ──────────────────────────────────
  const base = built['h5p-final-light'];
  const { z: bz, acts: bacts } = await actDirs(base.r.mbz);
  const noVideoCh = base.input.manifest.modules.flatMap((m) => m.chapters).find((c) => !c.videoEnabled);
  const find = (re) => bacts.find((a) => re.test(a.idnumber));
  await check('Edu EV3: cada botón queda resuelto al token de su destino (actividad del capítulo, evaluación, sección siguiente)', async () => {
    const intro = async (a) => bz.file(`${a.dir}/label.xml`).async('string');
    const secOf = new Map(bacts.map((a) => [a.idnumber, a.section]));
    for (let i = 0; i < bacts.length; i++) {
      const a = bacts[i];
      const x = await intro(a).catch(() => '');
      assert(!x.includes('cursia-cta://'), `${a.idnumber}: marcador sin resolver`);
      if (/:activity_instruction$/.test(a.idnumber)) {
        const next = bacts[i + 1];
        const mid = /_(\d+)$/.exec(next.dir)[1];
        const tok = next.modname === 'scorm' ? 'SCORMVIEWBYID' : 'H5PACTIVITYVIEWBYID';
        assert(x.includes(`$@${tok}*${mid}@$`), `${a.idnumber}: el botón no apunta a ${next.idnumber}`);
      }
      if (/^cv3:(exam_info:|final_exam_info)/.test(a.idnumber)) {
        const mid = /_(\d+)$/.exec(bacts[i + 1].dir)[1];
        assert(bacts[i + 1].modname === 'quiz' && x.includes(`$@QUIZVIEWBYID*${mid}@$`), `${a.idnumber}: el botón no apunta a su evaluación`);
      }
    }
    const sectionLinks = async (a) => Array.from((await intro(a)).matchAll(/\$@COURSESECTIONBYID\*(\d+)@\$/g), (m) => Number(m[1]));
    const M = base.input.manifest;
    const firstCh = (mod) => secOf.get(`cv3:ch:${mod.chapters[0].chapterId}:opening`);
    const nexts = bacts.filter((a) => /^cv3:module_next:/.test(a.idnumber));
    // Fix 1 (I1): module_next SOLO en módulos con examen (sin examen, el cierre del capítulo es el paso siguiente).
    assert(nexts.length === M.modules.filter((m) => m.examEnabled).length && M.modules.some((m) => !m.examEnabled), `module_next ${nexts.length}`);
    for (const mod of M.modules.filter((m) => !m.examEnabled)) assert(!find(new RegExp(`^cv3:module_next:${mod.moduleId}$`)), `module_next en el módulo sin examen ${mod.moduleId}`);
    const dup = {};
    for (const a of bacts.filter((x) => x.modname === 'label')) for (const t of new Set(await sectionLinks(a))) (dup[`${a.section}→${t}`] = dup[`${a.section}→${t}`] || []).push(a.idnumber);
    eq(Object.entries(dup).filter(([, ids]) => ids.length > 1), [], 'ninguna sección con dos botones al mismo destino');
    const finalSec = secOf.get('cv3:final_exam');
    const closingSec = secOf.get('cv3:shell:closing');
    // EV6: el cierre es la ÚLTIMA sección y va después de la evaluación final.
    assert(Number.isInteger(finalSec) && finalSec < closingSec && Math.max(...bacts.map((a) => a.section)) === closingSec, `evaluación final (${finalSec}) antes del cierre (${closingSec}), cierre al final`);
    for (const [i, mod] of M.modules.entries()) {
      if (!mod.examEnabled) continue;
      const a = nexts.find((x) => x.idnumber === `cv3:module_next:${mod.moduleId}`);
      const want = M.modules[i + 1] ? firstCh(M.modules[i + 1]) : finalSec;
      eq(await sectionLinks(a), [want], `${a.idnumber}: botón → sección ${want}`);
    }
    eq(await sectionLinks(find(/^cv3:shell:start$/)), [firstCh(M.modules[0])], '«Comenzar el curso» → sección del capítulo 1');
    eq(await sectionLinks(find(/^cv3:shell:route_start$/)), [firstCh(M.modules[0])], '«Comenzar con el capítulo 1» → sección del capítulo 1');
    eq(await sectionLinks(find(/^cv3:final_exam_next$/)), [closingSec], 'evaluación final → cierre');
    // Cada cierre de capítulo: exactamente UN botón de sección, al paso siguiente real.
    const chapters = M.modules.flatMap((mod, mi) => mod.chapters.map((ch, ci) => ({ mod, mi, ch, ci })));
    for (const { mod, mi, ch, ci } of chapters) {
      const a = find(new RegExp(`^cv3:ch:${ch.chapterId}:closing$`));
      const nextCh = mod.chapters[ci + 1];
      const want = nextCh ? secOf.get(`cv3:ch:${nextCh.chapterId}:opening`)
        : mod.examEnabled ? secOf.get(`cv3:exam:${mod.moduleId}`)
          : M.modules[mi + 1] ? firstCh(M.modules[mi + 1])
            : Number.isInteger(finalSec) ? finalSec : closingSec;
      eq(await sectionLinks(a), [want], `${a.idnumber}: un solo botón → sección ${want}`);
      assert(a.section === secOf.get(`cv3:ch:${ch.chapterId}:opening`), `${a.idnumber}: el cierre está en la sección de su capítulo`);
    }
  });
  const cases = [
    ['GRADEPASS', () => {
      const a = find(/:activity$/);
      return { [`${a.dir}/grades.xml`]: (x) => x.replace('<gradepass>70.00000</gradepass>', '<gradepass>60.00000</gradepass>') };
    }],
    ['GRADEMAX', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/grades.xml`]: (x) => x.replace('<grademax>100.00000</grademax>', '<grademax>50.00000</grademax>') };
    }],
    ['COMPLETION', () => {
      const a = find(/:video$/);
      return { [`${a.dir}/module.xml`]: (x) => x.replace('<completionpassgrade>1</completionpassgrade>', '<completionpassgrade>0</completionpassgrade>') };
    }],
    ['CATEGORIES', () => ({ 'gradebook.xml': (x) => x.replace('<aggregationcoef>30.00000</aggregationcoef>', '<aggregationcoef>35.00000</aggregationcoef>') })],
    ['COURSE_COMPLETION', () => ({ 'completion.xml': (x) => x.replace(/  <course_completion_criteria id="1">[\s\S]*?<\/course_completion_criteria>\n/, '') })],
    ['RESOURCE_DISABLED', () => {
      const a = bacts.find((x) => x.idnumber === `cv3:ch:${noVideoCh.chapterId}:synthesis`);
      return { [`${a.dir}/label.xml`]: (x) => x.replace('&lt;span class=&quot;nolink&quot;&gt;', '&lt;span class=&quot;nolink&quot;&gt;Mira el video antes de seguir. ') };
    }],
    ['NUMBER_NOT_FROM_FACTS', () => {
      const a = find(/^cv3:shell:methodology$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace('Cómo vas a aprender&lt;/span&gt;', 'Cómo vas a aprender en 97 semanas&lt;/span&gt;') };
    }],
    ['CLEAN_SAFE', () => {
      const a = find(/^cv3:shell:route$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/font-size:18px/, 'font-size:12px') };
    }],
    ['TOKEN_INVALID', () => {
      const a = find(/^cv3:shell:libro_card$/);
      const forum = find(/^cv3:shell:forum$/);
      const mid = /forum_(\d+)/.exec(forum.dir)[1];
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@RESOURCEVIEWBYID\*\d+@\$/, `$@RESOURCEVIEWBYID*${mid}@$`) };
    }],
    ['H5P_FILES', () => ({ 'files.xml': (x) => x.replace(/<filearea>intro<\/filearea>\n    <itemid>0<\/itemid>\n    <filepath>\/<\/filepath>\n    <filename>cursia-video/, '<filearea>content</filearea>\n    <itemid>0</itemid>\n    <filepath>/</filepath>\n    <filename>cursia-video') })],
    ['AUDIO_DURATION', () => {
      const a = find(/^cv3:shell:audio_welcome$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/Duración: \d+ min \d+ s/, 'Duración: 0 min 59 s') };
    }],
    ['STRUCTURE', () => {
      const a = find(/^cv3:shell:welcome$/);
      return { [`${a.dir}/module.xml`]: (x) => x.replace('<idnumber>cv3:shell:welcome</idnumber>', '<idnumber>cv3:shell:forum</idnumber>') };
    }],
  ];
  // Fix round 1 (G6 M6/M8): códigos que antes no tenían una mutación que los hiciera fallar.
  cases.push(
    ['COURSE_GRADEPASS', () => ({ 'gradebook.xml': (x) => x.replace('<gradepass>70.00000</gradepass>', '<gradepass>65.00000</gradepass>') })],
    ['TRANSITION_DISABLED_RESOURCE', () => {
      const a = bacts.find((x) => x.idnumber === `cv3:ch:${noVideoCh.chapterId}:closing`);
      return { [`${a.dir}/label.xml`]: (x) => {
        const at = x.indexOf('cvc-transition');
        const sp = x.indexOf('&lt;span class=&quot;nolink&quot;&gt;', at) + '&lt;span class=&quot;nolink&quot;&gt;'.length;
        return x.slice(0, sp) + 'Ahora mira el video. ' + x.slice(sp);
      } };
    }],
    ['STRUCTURE', () => {
      const a = find(/^cv3:shell:competencies$/);
      const forum = find(/^cv3:shell:forum$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/contextid="\d+"/, () => `contextid="${forumCtx}"`) };
    }],
    // EV4b: el recorrido «En este capítulo» no puede prometer un video que el capítulo no tiene.
    ['TRANSITION_DISABLED_RESOURCE', () => {
      const a = bacts.find((x) => x.idnumber === `cv3:ch:${noVideoCh.chapterId}:opening`);
      // P3: el recorrido se titula «Tu recorrido en este capítulo».
      return { [`${a.dir}/label.xml`]: (x) => x.replace('Tu recorrido en este capítulo', 'Tu recorrido en este capítulo con video') };
    }],
    // P3: el riel «Dónde estás» del cierre no nombra recursos que no sean capítulos o la evaluación del módulo.
    ['TRANSITION_DISABLED_RESOURCE', () => {
      const a = bacts.find((x) => x.idnumber === `cv3:ch:${noVideoCh.chapterId}:closing`);
      return { [`${a.dir}/label.xml`]: (x) => x.replace('Dónde estás · ', 'Dónde estás (con video) · ') };
    }],
    ['NUMBER_NOT_FROM_FACTS', () => {
      const a = bacts.find((x) => x.idnumber === `cv3:ch:${noVideoCh.chapterId}:opening`);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/ min&lt;\/span&gt;/, ' min · 917 minutos más&lt;/span&gt;') };
    }],
    // Edu EV3: botones de navegación mal resueltos o con cifras inventadas.
    ['TOKEN_INVALID', () => {
      const a = find(/^cv3:module_next:/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@COURSESECTIONBYID\*\d+@\$/, '$@COURSESECTIONBYID*99@$') };
    }],
    ['TOKEN_INVALID', () => {
      const a = find(/^cv3:module_next:/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@COURSESECTIONBYID\*(\d+)@\$/, 'cursia-cta://section/$1') };
    }],
    ['TOKEN_INVALID', () => {
      const a = find(/^cv3:ch:[^:]+:activity_instruction$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@(SCORM|H5PACTIVITY)VIEWBYID\*\d+@\$/, 'cursia-cta://next-activity') };
    }],
    ['NUMBER_NOT_FROM_FACTS', () => {
      const a = find(/^cv3:module_next:/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace('continúa por aquí.', 'continúa por aquí en 97 minutos.') };
    }],
    ['STRUCTURE', () => {
      const a = find(/^cv3:module_next:/);
      return { [`${a.dir}/module.xml`]: (x) => x.replace(/<idnumber>cv3:module_next:[^<]+<\/idnumber>/, '<idnumber>cv3:module_next:no-existe</idnumber>') };
    }],
    // EV6: botón de capítulo a una sección real pero equivocada; layout de una sola página; secciones renombradas/movidas.
    ['NAVIGATION', () => {
      const a = find(/^cv3:ch:[^:]+:closing$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@COURSESECTIONBYID\*\d+@\$/, '$@COURSESECTIONBYID*0@$') };
    }],
    ['NAVIGATION', () => {
      const a = find(/^cv3:ch:[^:]+:closing$/);
      return { [`${a.dir}/label.xml`]: (x) => x.replace(/(\$@COURSESECTIONBYID\*\d+@\$)/, '$1&quot; data-x=&quot;$1') };
    }],
    ['SECTIONS', () => ({ 'course/course.xml': (x) => x.replace('<name>coursedisplay</name><value>1</value>', '<name>coursedisplay</name><value>0</value>') })],
    // Fix 1 (I2): «evaluación final» en el cuerpo (síntesis, LLM) del último capítulo del curso — solo
    // el label de cierre (botón determinístico «Ir a la evaluación final →») puede nombrarla.
    ['RESOURCE_DISABLED', () => {
      const M = base.input.manifest;
      const lastMod = M.modules[M.modules.length - 1];
      const lastCh = lastMod.chapters[lastMod.chapters.length - 1];
      assert(!lastMod.examEnabled && M.features.finalExam, 'fixture: último módulo sin examen y con examen final');
      const a = find(new RegExp(`^cv3:ch:${lastCh.chapterId}:synthesis$`));
      return { [`${a.dir}/label.xml`]: (x) => {
        const sp = x.indexOf('&lt;span class=&quot;nolink&quot;&gt;') + '&lt;span class=&quot;nolink&quot;&gt;'.length;
        return x.slice(0, sp) + 'Prepárate para la evaluación final. ' + x.slice(sp);
      } };
    }],
    ['SECTIONS', () => ({ 'sections/section_7/section.xml': (x) => x.replace('<name>Evaluación final</name>', '<name>Cierre del curso</name>') })],
    ['SECTIONS', () => {
      const a = find(/^cv3:shell:closing$/);
      return { 'moodle_backup.xml': (x) => x.replace(`<moduleid>${/_(\d+)$/.exec(a.dir)[1]}</moduleid>\n        <sectionid>8</sectionid>`, `<moduleid>${/_(\d+)$/.exec(a.dir)[1]}</moduleid>\n        <sectionid>7</sectionid>`) };
    }],
    ['STRUCTURE', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/inforef.xml`]: (x) => x.replace(/(<grade_itemref>\s*<grade_item><id>)(\d+)/, (m, pre, id) => `${pre}${Number(id) + 999}`) };
    }],
    // P2-B1 (EV6 Fase 2): un campo de revisión alterado → QUIZ_REVIEW.
    ['QUIZ_REVIEW', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/quiz.xml`]: (x) => x.replace('<reviewcorrectness>16</reviewcorrectness>', '<reviewcorrectness>4352</reviewcorrectness>') };
    }],
    // completionattemptsexhausted en 0 con intentos > 0 (el fixture base tiene attempts_number 3) → QUIZ_COMPLETION.
    ['QUIZ_COMPLETION', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/quiz.xml`]: (x) => x.replace('<completionattemptsexhausted>1</completionattemptsexhausted>', '<completionattemptsexhausted>0</completionattemptsexhausted>') };
    }],
    // completionattemptsexhausted en 1 con intentos = 0 (ilimitado, nunca se agota) → QUIZ_COMPLETION.
    ['QUIZ_COMPLETION', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/quiz.xml`]: (x) => x.replace('<attempts_number>3</attempts_number>', '<attempts_number>0</attempts_number>') };
    }],
  );
  await check('validador (fix 1, I1): dos botones de la MISMA sección al MISMO destino → NAVIGATION «misma sección»', async () => {
    // route_start (sección 1) movido a la sección 0, junto a start: los dos llevan al capítulo 1.
    const a = find(/^cv3:shell:route_start$/);
    const mid = /_(\d+)$/.exec(a.dir)[1];
    const bad = await mutate(base.r.mbz, { 'moodle_backup.xml': (x) => x.replace(`<moduleid>${mid}</moduleid>\n        <sectionid>1</sectionid>`, `<moduleid>${mid}</moduleid>\n        <sectionid>0</sectionid>`) });
    const v = await V.validateMbzV3(bad, base.r.expectations);
    assert(v.issues.some((i) => i.code === 'NAVIGATION' && /llevan a la misma sección/.test(i.message) && /cv3:shell:start/.test(i.where) && /cv3:shell:route_start/.test(i.where)), JSON.stringify(v.issues.slice(0, 5)));
  });
  const forumAct = find(/^cv3:shell:forum$/);
  const forumCtx = /contextid="(\d+)"/.exec(await bz.file(`${forumAct.dir}/forum.xml`).async('string'))[1];
  for (const [code, mk] of cases) {
    await check(`validador detecta ${code}`, async () => {
      const bad = await mutate(base.r.mbz, mk());
      const v = await V.validateMbzV3(bad, base.r.expectations);
      assert(!v.ok && v.issues.some((i) => i.code === code), `esperaba ${code}, hallazgos: ${JSON.stringify(v.issues.slice(0, 4))}`);
    });
  }
  // ── P3: la actividad del capítulo va enmarcada con el tono de su módulo ─────
  await check('P3: intro de la actividad (H5P y SCORM) enmarcada con el tono del módulo; clases del cargador y del QA intactas', async () => {
    for (const cfg of MATRIX) {
      const { r } = built[cfg.id];
      const z = await JSZip.loadAsync(r.mbz);
      const { acts } = await actDirs(r.mbz);
      const theme = TE.resolveTheme(cfg.theme);
      const ground = theme.personality.plate ? theme.color.bg : theme.color.surface;
      for (const ch of r.expectations.facts.chapters.filter((c) => c.activityEnabled)) {
        const a = acts.find((x) => x.idnumber === `cv3:ch:${ch.id}:activity`);
        const xml = await z.file(`${a.dir}/${a.modname}.xml`).async('string');
        const intro = /<intro>([\s\S]*?)<\/intro>/.exec(xml)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const mt = VC.moduleTone(theme, TE.moduleColor(theme, ch.moduleNumber - 1), ground);
        assert(intro.includes('class="cvc-act-h"') && intro.includes(`background-color:${mt.soft}`) && intro.includes(`color:${mt.ink}`) && (intro.includes(`Práctica del capítulo ${ch.number} · Responde aquí`) || intro.includes(`Práctica calificada del capítulo ${ch.number}</span>`)), `${cfg.id} cap ${ch.number}: marco del módulo`);
        if (a.modname === 'h5pactivity') assert(['cursia-iv', 'cursia-iv-inline', 'cursia-iv-fallback', 'cursia-iv-open'].every((c) => intro.includes(`class="${c}`)) && intro.includes('data-cursia-src='), `${cfg.id} cap ${ch.number}: clases del cargador`);
      }
    }
  });
  // ── EV6 T3: certificado nativo (insignia de curso) ─────────────────────────
  await check('EV6 T3: insignia-certificado en toda la matriz (badges.xml, setting badges=1, imagen f1/f2/f3, examen final como criterio, panel del cierre)', async () => {
    for (const cfg of MATRIX) {
      const { r } = built[cfg.id];
      const z = await JSZip.loadAsync(r.mbz);
      const bx = await z.file('badges.xml').async('string');
      if (!cfg.finalExam) {
        // Fix round 1b (decisión M5): sin evaluación final no hay certificado (ni insignia, ni imagen,
        // ni setting, ni panel, ni label para docentes) y el resumen lo avisa.
        assert(!/<badge id/.test(bx), `${cfg.id}: sin insignia`);
        assert(/<name>badges<\/name>\n      <value>0<\/value>/.test(await z.file('moodle_backup.xml').async('string')), `${cfg.id}: setting badges = 0`);
        assert(!(await z.file('files.xml').async('string')).includes('<component>badges</component>'), `${cfg.id}: sin imagen`);
        const { acts } = await actDirs(r.mbz);
        const lx = await z.file(`${acts.find((a) => a.idnumber === 'cv3:shell:closing').dir}/label.xml`).async('string');
        assert(!/BADGESVIEWBYID|certificad/i.test(lx), `${cfg.id}: el cierre no promete certificado`);
        assert(!acts.some((a) => a.idnumber === 'cv3:shell:certificate_teacher'), `${cfg.id}: sin label docente`);
        assert(r.summary.warnings.includes('certificate_omitted:no_final_exam'), `${cfg.id}: aviso certificate_omitted:no_final_exam`);
        continue;
      }
      const title = r.expectations.facts.course.title;
      assert(bx.includes(`<name>Certificado: ${title}</name>`), `${cfg.id}: nombre`);
      // Fix round 1 (review I1): perfil por defecto → se exige aprobar TODO lo calificable, nombrado por tipo.
      const kinds = ['todas las actividades prácticas', 'todos los videos interactivos', 'todas las evaluaciones de módulo', 'la evaluación final'];
      const list = `${kinds.slice(0, -1).join(', ')} y ${kinds[kinds.length - 1]}`;
      const desc = `Otorgado al completar el curso «${title}»: aprobar ${list}.`;
      assert(bx.includes(`<description>${desc}</description>`), `${cfg.id}: descripción`);
      for (const t of ['<type>2</type>', '<courseid>1</courseid>', '<status>1</status>', '<notification>0</notification>', '<language>es</language>', '<issuername>Cursia</issuername>', '<name>course_1</name>', '<value>1</value>']) assert(bx.includes(t), `${cfg.id}: ${t}`);
      assert(/%badgename%/.test(bx), `${cfg.id}: %badgename%`);
      const mb = await z.file('moodle_backup.xml').async('string');
      assert(/<level>root<\/level>\n      <name>badges<\/name>\n      <value>1<\/value>/.test(mb), `${cfg.id}: setting badges`);
      const fx = await z.file('files.xml').async('string');
      for (const [fn, size] of [['f1.png', 100], ['f2.png', 35], ['f3.png', 512]]) {
        const f = fx.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((x) => x.includes('<component>badges</component>') && x.includes(`<filename>${fn}</filename>`));
        assert(f && f.includes('<contextid>2</contextid>') && f.includes('<filearea>badgeimage</filearea>') && f.includes('<itemid>1</itemid>'), `${cfg.id}: ${fn} en files.xml`);
        const h = /<contenthash>(\w+)<\/contenthash>/.exec(f)[1];
        const png = await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
        eq([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [size, size, 6], `${cfg.id}: ${fn} RGBA ${size}px`);
      }
      const { acts } = await actDirs(r.mbz);
      const closing = acts.find((a) => a.idnumber === 'cv3:shell:closing');
      const lx = await z.file(`${closing.dir}/label.xml`).async('string');
      assert(lx.includes('$@BADGESVIEWBYID*1@$') && lx.includes('Tu certificado') && lx.includes('Ver mi certificado →'), `${cfg.id}: panel del cierre`);
      const want = `Cuando apruebes ${list}, Moodle te otorga el certificado del curso. Lo encuentras en tu perfil, en Insignias.`;
      assert(lx.includes(want), `${cfg.id}: texto del panel`);
      // Fix 0b: label oculto para docentes, justo después del cierre, en la misma sección.
      const teacher = acts.find((a) => a.idnumber === 'cv3:shell:certificate_teacher');
      assert(teacher && teacher.section === closing.section && acts.indexOf(teacher) === acts.indexOf(closing) + 1, `${cfg.id}: label docente tras el cierre`);
      const tm = await z.file(`${teacher.dir}/module.xml`).async('string');
      assert(tm.includes('<visible>0</visible>') && tm.includes('<visibleold>0</visibleold>'), `${cfg.id}: label docente oculto`);
      const tx = await z.file(`${teacher.dir}/label.xml`).async('string');
      for (const t of ['Para docentes: activa el certificado del curso', 'Moodle deja la insignia desactivada al restaurar.', `Entra a Insignias → «Certificado: ${title}» → «Habilitar acceso».`, 'Solo se hace una vez.', 'Abrir las insignias del curso →', '$@BADGESVIEWBYID*1@$']) {
        assert(tx.includes(t.replace(/"/g, '&quot;')), `${cfg.id}: label docente «${t}»`);
      }
      const hidden = [];
      for (const a of acts) if ((await z.file(`${a.dir}/module.xml`).async('string')).includes('<visible>0</visible>')) hidden.push(a.idnumber);
      eq(hidden, ['cv3:shell:certificate_teacher'], `${cfg.id}: único módulo oculto`);
      if (cfg.finalExam) {
        const fin = acts.find((a) => a.idnumber === 'cv3:final_exam');
        const comp = await z.file('completion.xml').async('string');
        assert(comp.includes(`<module>quiz</module>\n    <moduleinstance>${/_(\d+)$/.exec(fin.dir)[1]}</moduleinstance>`), `${cfg.id}: final como criterio`);
      }
    }
    // Imagen determinística y con los colores del tema (acento en el centro de la medalla).
    const t = { color: { accent: '#1D4ED8', accentStrong: '#1E3A8A', textOnAccent: '#FFFFFF' } };
    const BADGE = loadDist('package/v3/course-badge.js');
    const a1 = BADGE.renderCourseBadgePng(t, 512);
    assert(a1.equals(BADGE.renderCourseBadgePng(t, 512)), 'determinismo de la imagen');
    assert(!a1.equals(BADGE.renderCourseBadgePng({ color: { ...t.color, accent: '#B91C1C' } }, 512)), 'la imagen cambia con el acento');
    eq(BADGE.courseBadgeName('x'.repeat(400)).length <= 255, true, 'nombre ≤ 255');
  });
  await check('EV6 T3: perfil con requireExams=false → la evaluación final sigue siendo criterio (los exámenes de módulo no)', async () => {
    const input = PF.packagingInput(distRoot, MATRIX[0]);
    input.assessmentProfile = JSON.parse(JSON.stringify(input.assessmentProfile));
    input.assessmentProfile.courseCompletion.requireExams = false;
    const r = await B.buildDynamicMbzV3(input);
    const v = await validate(r);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    const { z, acts } = await actDirs(r.mbz);
    const comp = await z.file('completion.xml').async('string');
    const inst = [...comp.matchAll(/<moduleinstance>(\d+)<\/moduleinstance>/g)].map((m) => Number(m[1]));
    const mid = (a) => Number(/_(\d+)$/.exec(a.dir)[1]);
    assert(inst.includes(mid(acts.find((a) => a.idnumber === 'cv3:final_exam'))), 'el final es criterio');
    assert(!acts.filter((a) => /^cv3:exam:/.test(a.idnumber)).some((a) => inst.includes(mid(a))), 'los exámenes de módulo no');
  });
  await check('EV6 T3 (review I1): perfil con requireCourseGradePass y sin prácticas → panel y descripción nombran SOLO evaluaciones + nota mínima', async () => {
    const input = PF.packagingInput(distRoot, MATRIX[0]);
    input.assessmentProfile = JSON.parse(JSON.stringify(input.assessmentProfile));
    input.assessmentProfile.courseCompletion = { requireAllChapterActivities: false, requireExams: true, requireCourseGradePass: true };
    const r = await B.buildDynamicMbzV3(input);
    const v = await validate(r);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    const { z, acts } = await actDirs(r.mbz);
    const title = r.expectations.facts.course.title;
    assert((await z.file('badges.xml').async('string')).includes(`<description>Otorgado al completar el curso «${title}»: aprobar todas las evaluaciones de módulo y la evaluación final y alcanzar la nota mínima del curso.</description>`), 'descripción');
    const lx = await z.file(`${acts.find((a) => a.idnumber === 'cv3:shell:closing').dir}/label.xml`).async('string');
    assert(lx.includes('Cuando apruebes todas las evaluaciones de módulo y la evaluación final y alcances la nota mínima del curso, Moodle te otorga'), 'panel');
    assert(!/actividades prácticas|videos interactivos/.test(lx), 'no nombra lo que no se exige');
  });
  await check('EV6 T3: sin evaluación final (aunque el perfil exija todo lo demás o nada) → sin certificado y aviso certificate_omitted:no_final_exam', async () => {
    const input = PF.packagingInput(distRoot, MATRIX[1]);
    input.assessmentProfile = JSON.parse(JSON.stringify(input.assessmentProfile));
    input.assessmentProfile.courseCompletion = { requireAllChapterActivities: false, requireExams: false, requireCourseGradePass: false };
    const r = await B.buildDynamicMbzV3(input);
    const v = await validate(r);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    assert(r.summary.warnings.includes('certificate_omitted:no_final_exam'), 'aviso');
    const { z, acts } = await actDirs(r.mbz);
    assert(!/<badge id/.test(await z.file('badges.xml').async('string')), 'sin insignia');
    assert(/<name>badges<\/name>\n      <value>0<\/value>/.test(await z.file('moodle_backup.xml').async('string')), 'setting badges = 0');
    assert(!(await z.file('files.xml').async('string')).includes('<component>badges</component>'), 'sin imagen');
    const lx = await z.file(`${acts.find((a) => a.idnumber === 'cv3:shell:closing').dir}/label.xml`).async('string');
    assert(!/BADGESVIEWBYID|certificado/i.test(lx), 'sin panel');
    assert(!acts.some((a) => a.idnumber === 'cv3:shell:certificate_teacher'), 'sin label docente');
  });
  {
    const certCases = [
      ['setting badges = 0', () => ({ 'moodle_backup.xml': (x) => x.replace(/(<name>badges<\/name>\n      <value>)1/, '$10') })],
      ['sin insignia', () => ({ 'badges.xml': (x) => x.replace(/<badge id[\s\S]*<\/badge>/, '') })],
      ['criterio de curso con otro id', () => ({ 'badges.xml': (x) => x.replace('<name>course_1</name>', '<name>course_2</name>') })],
      ['insignia inactiva', () => ({ 'badges.xml': (x) => x.replace('<status>1</status>', '<status>0</status>') })],
      ['descripción que omite la evaluación final', () => ({ 'badges.xml': (x) => x.replace(' y la evaluación final.</description>', '.</description>') })],
      ['panel que no enuncia los criterios reales', () => {
        const a = find(/^cv3:shell:closing$/);
        return { [`${a.dir}/label.xml`]: (x) => x.replace('Cuando apruebes todas las actividades prácticas', 'Cuando completes todas las actividades calificadas') };
      }],
      ['label docente sin la nota de diagnóstico', () => {
        const a = find(/^cv3:shell:certificate_teacher$/);
        return { [`${a.dir}/label.xml`]: (x) => x.replace('Si no ves la insignia', 'Si no aparece') };
      }],
      ['falta f3.png', () => ({ 'files.xml': (x) => x.replace('<filename>f3.png</filename>', '<filename>f9.png</filename>') })],
      ['contexto del curso = contexto de sistema', () => ({ 'moodle_backup.xml': (x) => x.replace('<original_course_contextid>2</original_course_contextid>', '<original_course_contextid>1</original_course_contextid>') })],
      ['imagen con otro itemid', () => ({ 'files.xml': (x) => x.replace(/(<filearea>badgeimage<\/filearea>\n    <itemid>)1/, '$17') })],
      ['label docente visible para estudiantes', () => {
        const a = find(/^cv3:shell:certificate_teacher$/);
        return { [`${a.dir}/module.xml`]: (x) => x.replace('<visible>0</visible>', '<visible>1</visible>') };
      }],
      ['label docente sin «Habilitar acceso»', () => {
        const a = find(/^cv3:shell:certificate_teacher$/);
        return { [`${a.dir}/label.xml`]: (x) => x.replace('Habilitar acceso', 'Activar') };
      }],
      ['otro módulo oculto', () => {
        const a = find(/^cv3:shell:welcome$/);
        return { [`${a.dir}/module.xml`]: (x) => x.replace('<visible>1</visible>', '<visible>0</visible>') };
      }],
      ['falta el label docente', () => {
        const a = find(/^cv3:shell:certificate_teacher$/);
        return { [`${a.dir}/module.xml`]: (x) => x.replace('<idnumber>cv3:shell:certificate_teacher</idnumber>', '<idnumber>cv3:shell:otro</idnumber>') };
      }],
      ['cierre sin enlace a la insignia', () => {
        const a = find(/^cv3:shell:closing$/);
        return { [`${a.dir}/label.xml`]: (x) => x.split('$@BADGESVIEWBYID*1@$').join('#') };
      }],
      ['evaluación final fuera de la completion del curso', () => {
        const a = find(/^cv3:final_exam$/);
        const mid = /_(\d+)$/.exec(a.dir)[1];
        return { 'completion.xml': (x) => x.replace(new RegExp(`  <course_completion_criteria id="\\d+">\\n    <course>1</course>\\n    <criteriatype>4</criteriatype>\\n    <module>quiz</module>\\n    <moduleinstance>${mid}</moduleinstance>[\\s\\S]*?</course_completion_criteria>\\n`), '') };
      }],
    ];
    for (const [what, mk] of certCases) {
      await check(`validador detecta CERTIFICATE: ${what}`, async () => {
        const bad = await mutate(base.r.mbz, mk());
        const v = await V.validateMbzV3(bad, base.r.expectations);
        assert(!v.ok && v.issues.some((i) => i.code === 'CERTIFICATE'), `esperaba CERTIFICATE, hallazgos: ${JSON.stringify(v.issues.slice(0, 4))}`);
      });
    }
    await check('validador detecta CERTIFICATE: insignia en un curso SIN evaluación final (fix round 1b)', async () => {
      const nf = built['scorm-nofinal-dark'].r;
      const bxWith = await (await JSZip.loadAsync(base.r.mbz)).file('badges.xml').async('string');
      const bad = await mutate(nf.mbz, { 'badges.xml': () => bxWith });
      const v = await V.validateMbzV3(bad, nf.expectations);
      assert(!v.ok && v.issues.some((i) => i.code === 'CERTIFICATE' && /sin evaluación final/.test(i.message)), JSON.stringify(v.issues.slice(0, 4)));
    });
    await check('validador detecta TOKEN_INVALID: $@BADGESVIEWBYID@$ que no apunta al curso del backup', async () => {
      const a = find(/^cv3:shell:closing$/);
      const bad = await mutate(base.r.mbz, { [`${a.dir}/label.xml`]: (x) => x.split('$@BADGESVIEWBYID*1@$').join('$@BADGESVIEWBYID*7@$') });
      const v = await V.validateMbzV3(bad, base.r.expectations);
      assert(v.issues.some((i) => i.code === 'TOKEN_INVALID' && /BADGESVIEWBYID\*7/.test(i.message)), JSON.stringify(v.issues.slice(0, 4)));
    });
  }
  await check('validador detecta H5P_LIBRARIES (dependencia fuera del perfil) y FILES_INTEGRITY (blob alterado)', async () => {
    const z = await JSZip.loadAsync(base.r.mbz);
    const pkg = base.r.summary.h5pPackages[0];
    const blobPath = `files/${pkg.sha1.slice(0, 2)}/${pkg.sha1}`;
    const inner = await JSZip.loadAsync(await z.file(blobPath).async('nodebuffer'));
    const hj = JSON.parse(await inner.file('h5p.json').async('string'));
    hj.preloadedDependencies.push({ machineName: 'H5P.Intruso', majorVersion: 9, minorVersion: 9 });
    inner.file('h5p.json', JSON.stringify(hj));
    const nb = await inner.generateAsync({ type: 'nodebuffer' });
    const nh = crypto.createHash('sha1').update(nb).digest('hex');
    z.remove(blobPath);
    z.file(`files/${nh.slice(0, 2)}/${nh}`, nb);
    const fx = (await z.file('files.xml').async('string')).split(pkg.sha1).join(nh).split(`<filesize>${pkg.bytes}</filesize>`).join(`<filesize>${nb.length}</filesize>`);
    z.file('files.xml', fx);
    const v1 = await V.validateMbzV3(await z.generateAsync({ type: 'nodebuffer' }), base.r.expectations);
    assert(v1.issues.some((i) => i.code === 'H5P_LIBRARIES' && /H5P.Intruso/.test(i.message)), JSON.stringify(v1.issues.slice(0, 3)));
    const z2 = await JSZip.loadAsync(base.r.mbz);
    z2.file(blobPath, Buffer.from('corrupto'));
    const v2 = await V.validateMbzV3(await z2.generateAsync({ type: 'nodebuffer' }), base.r.expectations);
    assert(v2.issues.some((i) => i.code === 'FILES_INTEGRITY'), 'blob alterado');
  });
  // Reescribe un blob del paquete (re-hash + files.xml) para mutar archivos, no solo XML.
  async function rewriteBlob(mbz, pickHash, fn) {
    const z = await JSZip.loadAsync(mbz);
    const fx0 = await z.file('files.xml').async('string');
    const h = pickHash(fx0);
    const p0 = `files/${h.slice(0, 2)}/${h}`;
    const oldBuf = await z.file(p0).async('nodebuffer');
    const nb = await fn(oldBuf);
    const nh = crypto.createHash('sha1').update(nb).digest('hex');
    z.remove(p0);
    z.file(`files/${nh.slice(0, 2)}/${nh}`, nb);
    const fx = fx0.split(h).join(nh).split(`<filesize>${oldBuf.length}</filesize>`).join(`<filesize>${nb.length}</filesize>`);
    z.file('files.xml', fx);
    return z.generateAsync({ type: 'nodebuffer' });
  }
  await check('validador detecta LIBRO (sin print CSS / sin </html>) y H5P_LIBRARIES por rol (G6 M7: actividad con otra librería, video que no es IV)', async () => {
    const libroHash = (fx) => /<contenthash>(\w+)<\/contenthash>/.exec(fx.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((b) => b.includes('<filename>libro_guia_completo.html</filename>')))[1];
    for (const edit of [(t) => t.replace('@media print', '@media screen'), (t) => t.replace(/<\/html>\s*$/, '')]) {
      const bad = await rewriteBlob(base.r.mbz, libroHash, async (b) => Buffer.from(edit(b.toString('utf8'))));
      const v = await V.validateMbzV3(bad, base.r.expectations);
      assert(v.issues.some((i) => i.code === 'LIBRO'), JSON.stringify(v.issues.slice(0, 3)));
    }
    const swapMain = (lib) => async (b) => {
      const inner = await JSZip.loadAsync(b);
      const hj = JSON.parse(await inner.file('h5p.json').async('string'));
      hj.mainLibrary = lib;
      inner.file('h5p.json', JSON.stringify(hj));
      return inner.generateAsync({ type: 'nodebuffer' });
    };
    const act = base.r.summary.h5pPackages.find((p) => p.itemKey.startsWith('activity:'));
    const other = ['H5P.QuestionSet', 'H5P.DragText', 'H5P.Blanks'].find((l) => l !== act.mainLibrary);
    for (const [pkg, lib, re] of [[act, other, /R-012/], [act, 'H5P.SingleChoiceSet', /R-011/], [base.r.summary.h5pPackages.find((p) => p.mainLibrary === 'H5P.InteractiveVideo'), 'H5P.QuestionSet', /H5P.InteractiveVideo/]]) {
      const bad = await rewriteBlob(base.r.mbz, () => pkg.sha1, swapMain(lib));
      const v = await V.validateMbzV3(bad, base.r.expectations);
      assert(v.issues.some((i) => i.code === 'H5P_LIBRARIES' && re.test(i.message)), `${lib}: ${JSON.stringify(v.issues.slice(0, 3))}`);
    }
  });
  void bz;


  // ── Fix round 1 (review G6) ───────────────────────────────────────────────
  await check('fix G6 I1: predicado único de mock (metadata o cuerpo); reproducción del review: run real + flag solo en el cuerpo → falla fuerte', async () => {
    const run = { id: 'r', input_payload: { providerModes: { presentation: 'real', audio: 'real' } } };
    const mk = (key, type, mime) => ({ itemKey: key, type: key.split(':')[0], outputSummary: {}, artifacts: [{ itemKey: key, artifactId: key + '-a', type, metadata: {}, mimeType: mime, storageBucket: 'b', storagePath: 'o/x' }] });
    const byItem = new Map();
    for (const [k, t, m] of [['course_intro:1', 'dynamic_course_intro_json', 'application/json'], ['audio_welcome:1', 'dynamic_audio_mp3', 'application/json'], ['presentation:c1', 'dynamic_presentation', 'application/json'], ['audiobook_chapter:c1', 'dynamic_audio_mp3', 'application/json'], ['module_intro:m1', 'dynamic_module_intro_json'], ['content:c1', 'dynamic_content_md'], ['experience:c1', 'dynamic_experience_json']]) byItem.set(k, mk(k, t, m));
    PK.assertRunArtifactsPackageable(run, byItem); // metadata limpia: la guarda previa pasa…
    const plan = { keys: { courseIntro: 'course_intro:1', audioWelcome: 'audio_welcome:1', finalExam: null }, modules: [{ moduleId: 'm1', keys: { moduleIntro: 'module_intro:m1', exam: null }, chapters: [{ chapterId: 'c1', keys: { content: 'content:c1', experience: 'experience:c1', presentation: 'presentation:c1', audiobookChapter: 'audiobook_chapter:c1', video: null, activity: null } }] }] };
    const L = (body) => ({ loadText: async (a) => (a.type === 'dynamic_presentation' ? JSON.stringify({ ...body, slideCount: 3 }) : a.type === 'dynamic_audio_mp3' ? JSON.stringify({ ...body, durationSeconds: 5 }) : '{}'), loadBytes: async () => { throw new Error('bytes'); }, loadStorageBytes: async () => { throw new Error('storage'); } });
    for (const body of [{ fixture: true }, { mock: true }, { mode: 'mock' }]) {
      await rejects(PK.loadContentsV3(L(body), plan, byItem, run, { familyId: 'aula-clara', mode: 'light' }), /MOCK_ARTIFACT_IN_REAL_RUN/, `…pero el cargador rechaza el cuerpo ${JSON.stringify(body)}`);
    }
    // metadata.mode='mock' también es señal (ahora la guarda previa lo ve)
    const bm = new Map([['presentation:c1', { itemKey: 'presentation:c1', type: 'presentation', outputSummary: {}, artifacts: [{ itemKey: 'presentation:c1', artifactId: 'p', type: 'dynamic_presentation', metadata: { mode: 'mock' } }] }]]);
    throwsSync(() => PK.assertRunArtifactsPackageable(run, bm), /MOCK_ARTIFACT_IN_REAL_RUN/, 'metadata.mode=mock');
    assert(PK.isMockSignaled({ metadata: {} }, { fixture: true }) && PK.isMockSignaled({ metadata: { fixture: true } }) && !PK.isMockSignaled({ metadata: {} }, { mode: 'real' }), 'predicado');
    // audio JSON sin marcas en un run real: tampoco se materializa
    const L2 = { loadText: async (a) => (a.type === 'dynamic_audio_mp3' ? '{"durationSeconds":5}' : a.type === 'dynamic_presentation' ? '{"schemaVersion":1}' : '{}'), loadBytes: async () => Buffer.from('{"fixture":true}'), loadStorageBytes: async () => { throw new Error('x'); } };
    await rejects(PK.loadContentsV3(L2, plan, byItem, run, { familyId: 'aula-clara', mode: 'light' }), /PACKAGING_V3/, 'JSON de audio en run real');
    // run mock pero fixture sin datos → falla (G6 M3), nunca un valor inventado
    const runMock = { id: 'r', input_payload: { providerModes: { presentation: 'mock', audio: 'mock' } } };
    const L3 = { loadText: async (a) => (a.type === 'dynamic_presentation' ? '{"fixture":true}' : a.type === 'dynamic_audio_mp3' ? '{"fixture":true,"durationSeconds":5}' : '{}'), loadBytes: async () => { throw new Error('x'); }, loadStorageBytes: async () => { throw new Error('x'); } };
    await rejects(PK.loadContentsV3(L3, plan, byItem, runMock, { familyId: 'aula-clara', mode: 'light' }), /sin slideCount válido/, 'fixture sin slideCount');
  });
  await check('fix G6 I2: storage path — dot-segments, backslashes, %-encoding, absolutos, vacíos y otro dueño se rechazan ANTES de descargar', async () => {
    const OWN = '8a1b2c3d-0000-4000-8000-000000000001';
    const bad = [
      `${OWN}/../victim/f.pdf`, `${OWN}/./f.pdf`, `${OWN}/a/../../victim/f.pdf`, `${OWN}\\..\\victim\\f.pdf`, `${OWN}/..\\victim/f.pdf`,
      `${OWN}/%2e%2e/victim/f.pdf`, `${OWN}/%2E%2E/victim`, `${OWN}%2f..%2fvictim/f.pdf`, `${OWN}/a%2fb.pdf`, `/${OWN}/f.pdf`, `${OWN}//f.pdf`,
      `${OWN}/f.pdf/`, '', `victim/${OWN}/f.pdf`, `${OWN}x/f.pdf`, `${OWN}/a b.pdf`, `${OWN}/f\u0000.pdf`,
    ];
    for (const p of bad) throwsSync(() => PK.assertOwnerStoragePath(OWN, p), /STORAGE_PATH_INVALID|no pertenece al dueño/, `rechaza ${JSON.stringify(p)}`);
    eq(PK.assertOwnerStoragePath(OWN, `${OWN}/dynamic/9/presentation/cap-1.pdf`), [OWN, 'dynamic', '9', 'presentation', 'cap-1.pdf'], 'válido');
    // ArtifactsService.downloadStorageObject: valida antes de fetch y arma la URL por segmentos
    const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
    const svc = new ArtifactsService({}, { get: (k) => ({ SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'k' })[k] });
    const urls = [];
    const saved = global.fetch;
    global.fetch = async (u) => { urls.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; };
    try {
      // el servicio valida la FORMA (el dueño lo exige el cargador del empaque)
      for (const p of bad.filter((x) => !x.startsWith('victim/') && !x.startsWith(`${OWN}x/`))) await rejects(svc.downloadStorageObject('cursia-artifacts', p), /STORAGE_PATH_INVALID/, `service rechaza ${JSON.stringify(p)}`);
      await rejects(svc.downloadStorageObject('../x', `${OWN}/f.pdf`), /STORAGE_PATH_INVALID: bucket/, 'bucket');
      eq(urls, [], 'ningún fetch con un path inválido');
      await svc.downloadStorageObject('cursia-artifacts', `${OWN}/d/f.pdf`);
      eq(urls, [`https://sb.example/storage/v1/object/authenticated/cursia-artifacts/${OWN}/d/f.pdf`], 'URL');
    } finally {
      global.fetch = saved;
    }
    // el cargador real aplica el mismo control
    const Lr = PK.artifactsServiceLoadersV3({ downloadStorageObject: async () => Buffer.from('x'), getDownloadUrl: async () => ({}) }, OWN);
    await rejects(Lr.loadStorageBytes('cursia-artifacts', `${OWN}/../victim/f.pdf`), /STORAGE_PATH_INVALID/, 'loader');
  });
  await check('fix G6 M2: Libro sin links javascript:/data: ni atributos inyectados; links http(s)/mailto/# se conservan', async () => {
    const LB = loadDist('package/v3/libro-v3.js');
    eq(LB.sanitizeMarkdownLinks('[a](javascript:alert(1)) [b](https://x.org/p) [c](a"onmouseover="alert(1)) [d](#cap-2) [e](mailto:a@b.co) [f](data:text/html,x)'),
      'a) [b](https://x.org/p) c) [d](#cap-2) [e](mailto:a@b.co) f', 'sanitizado (el `)` sobrante queda como texto inerte)');
    const input = PF.packagingInput(distRoot, MATRIX[0]);
    const [c1] = input.contents.contentMd.keys();
    input.contents.contentMd.set(c1, input.contents.contentMd.get(c1) + '\n\nVer [esto](javascript:alert(1)) y [aquello](x"onmouseover="alert(2)).');
    const r = await B.buildDynamicMbzV3(input);
    const z = await JSZip.loadAsync(r.mbz);
    const names = Object.keys(z.files).filter((n) => n.startsWith('files/'));
    let libro = '';
    for (const n of names) { const t = await z.file(n).async('string'); if (t.includes('Libro Guía del curso')) libro = t; }
    assert(libro && !/javascript:/i.test(libro) && !/onmouseover/i.test(libro), 'sin javascript:/onmouseover en el Libro');
  });
  await check('F1 (I3): categoría ponderada vacía → prepareV3Package normaliza (sin fallar) y lo registra; tema sin perfil ni paleta → presentation_profile_defaulted', async () => {
    const { manifest } = SF.buildCourse(distRoot, { courseId: 641, finalExam: false, engine: 'h5p', modules: [{ examEnabled: true, chapters: [{ video: false, activity: false }] }] });
    const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
    const rows = [];
    for (const it of manifest.items) for (const t of R.requiredArtifactTypesV3(it.type, it.variant)) {
      rows.push({ item_key: it.key, item_run_id: `g-${it.key}`, gir_status: 'completed', gir_type: it.type, output_summary: {}, artifact_id: `${it.key}-${t}`, artifact_type: t, storage_bucket: 'b', storage_path: 'o/p', mime_type: 'application/json', artifact_status: null, metadata: {} });
    }
    const q = { query: async (sql) => {
      if (/generation_item_runs/.test(sql)) return rows;
      if (/course_profiles/.test(sql)) return [];
      if (/from public\.courses where id/.test(sql)) return [{ metadata: {} }];
      if (/production_jobs/.test(sql)) return [{ id: 'r', owner_id: 'o', execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: {} }];
      throw new Error(sql);
    } };
    const prep = await PK.prepareV3Package(q, 'r', { id: 1, sha256: 's', manifest }, 641, '4.1');
    eq(prep.resolved.categories.map((c) => [c.key, c.weight]), [['moduleExams', 100]], 'práctica vacía → exámenes 100');
    eq(prep.assessment, { weightsNormalized: true, originalWeights: { practice: 40, moduleExams: 60 }, weights: { moduleExams: 100 }, emptyCategories: ['practice'], withoutGrades: false }, 'resumen');
    eq(prep.profileWarnings, ['presentation_profile_defaulted', 'assessment_weights_normalized:practice=40,moduleExams=60->moduleExams=100'], 'avisos');
    eq(prep.profiles.theme.source, 'default_v3', 'sin perfil ni paleta');
  });

  // ── Fail loud del builder ─────────────────────────────────────────────────
  await check('builder falla fuerte: contenido faltante lista las keys del Manifest', async () => {
    const input = PF.packagingInput(distRoot, MATRIX[0]);
    const [first] = input.contents.presentations.keys();
    input.contents.presentations.delete(first);
    input.contents.audiobookChapters.delete(first);
    await rejects(B.buildDynamicMbzV3(input), new RegExp(`PACKAGING_V3_CONTENT_MISSING: faltan 2 contenido\\(s\\): presentation:${first}, audiobook_chapter:${first}`), 'faltantes');
  });
  await check('builder falla fuerte: SingleChoiceSet (R-011) y tipo H5P fuera de la rotación por UUID (R-012)', async () => {
    const input = PF.packagingInput(distRoot, MATRIX[0]);
    const [chId, act] = [...input.contents.activities.entries()][0];
    input.contents.activities.set(chId, { variant: 'h5p', payload: SF.h5pPayload('singlechoiceset') });
    await rejects(B.buildDynamicMbzV3(input), /H5P_ACTIVITY_PAYLOAD_INVALID: .*H5P_TYPE_NOT_GRADABLE/, 'SCS');
    const wrong = ['questionset', 'dragtext', 'blanks'].find((t) => t !== SHELL.activityTypeForChapter(chId));
    const p2 = SF.h5pPayload(wrong);
    p2.data.itemKey = `activity:${chId}`;
    input.contents.activities.set(chId, { variant: 'h5p', payload: p2 });
    await rejects(B.buildDynamicMbzV3(input), /ACTIVITY_TYPE_MISMATCH/, 'tipo ajeno');
    void act;
    throwsSync(() => H5P.assertH5pGradableInMoodle('H5P.SingleChoiceSet'), /H5P_NOT_GRADABLE_IN_MOODLE/, 'assert SCS');
  });
  await check('builder falla fuerte: categoría ponderada vacía, perfil inaplicable (pesos de final / intentos h5p)', async () => {
    const { snapshot, manifest } = SF.buildCourse(distRoot, {
      courseId: 611, finalExam: false, engine: 'h5p',
      modules: [{ examEnabled: true, chapters: [{ video: false, activity: false }, { video: false, activity: false }] }],
    });
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false });
    input.manifest = manifest;
    input.blueprint = snapshot;
    // contenidos del curso "desnudo" a partir de los de 2 capítulos del fixture
    const src = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false });
    const chs = manifest.modules[0].chapters;
    const srcIds = [...src.contents.contentMd.keys()];
    for (const k of ['contentMd', 'experiences', 'presentations', 'audiobookChapters']) {
      input.contents[k] = new Map(chs.map((c, i) => {
        const v = src.contents[k].get(srcIds[i]);
        return [c.chapterId, k === 'experiences' ? { ...v, chapterId: c.chapterId } : v];
      }));
    }
    input.contents.videos = new Map(); input.contents.videoInteractions = new Map(); input.contents.activities = new Map();
    input.contents.moduleIntros = new Map([[manifest.modules[0].moduleId, SF.moduleIntroFixture(manifest, 0)]]);
    input.contents.examGift = new Map([[manifest.modules[0].moduleId, PF.moduleGift(1)]]);
    // F1 (I3): la categoría vacía ya no falla — su peso se redistribuye y el paquete valida.
    const rn = await B.buildDynamicMbzV3(input);
    assert((await validate(rn)).ok, 'práctica vacía (peso 40) → normalizado, empaqueta y valida');
    eq(rn.summary.assessment, { weightsNormalized: true, originalWeights: { practice: 40, moduleExams: 60 }, weights: { moduleExams: 100 }, emptyCategories: ['practice'], withoutGrades: false }, 'resumen normalizado');
    const okProfile = PROF.defaultAssessmentProfile({ finalExam: false });
    okProfile.categoryWeights = { practice: 0, moduleExams: 100 };
    const r = await B.buildDynamicMbzV3({ ...input, assessmentProfile: okProfile });
    assert((await validate(r)).ok, 'con peso 0 en práctica el curso desnudo empaqueta y valida');
    eq(r.summary.assessment.weightsNormalized, false, 'peso 0 → no hubo que normalizar');
    const bad = PF.packagingInput(distRoot, MATRIX[0]);
    bad.assessmentProfile = PROF.defaultAssessmentProfile({ finalExam: false });
    await rejects(B.buildDynamicMbzV3(bad), /ASSESSMENT_PROFILE_INVALID: .*WEIGHTS_FINAL_EXAM_MISMATCH/, 'pesos sin final');
    const att = PF.packagingInput(distRoot, MATRIX[0]);
    att.assessmentProfile.attempts.activity = 2;
    await rejects(B.buildDynamicMbzV3(att), /ASSESSMENT_UNENFORCEABLE/, 'intentos en h5p');
  });
  await check('builder falla fuerte: cifra en un intro del LLM, duración del video ≠ documento, token inválido', async () => {
    const i1 = PF.packagingInput(distRoot, MATRIX[0]);
    i1.contents.courseIntro = { ...i1.contents.courseIntro, closing: 'Completaste los 4 capítulos del curso.' };
    await rejects(B.buildDynamicMbzV3(i1), /COURSE_INTRO_INVALID|DIGIT_IN_TEXT/, 'dígito');
    const i2 = PF.packagingInput(distRoot, MATRIX[0]);
    const [vid] = i2.contents.videos.keys();
    i2.contents.videos.set(vid, { youtubeId: PF.YOUTUBE_ID, durationSec: 600 });
    await rejects(B.buildDynamicMbzV3(i2), /H5P_INPUT_INVALID\(VideoInteractions\)|durationSec/, 'duración');
    throwsSync(() => B.assertTokensV3('<a href="$@QUIZVIEWBYID*5@$">x</a>', new Map([[5, 'label']]), 'x'), /MBZ_V3_TOKEN_INVALID/, 'token');
    // Edu EV3: marcador sin resolver, sección inexistente o sin lista de secciones → fallo fuerte.
    throwsSync(() => B.assertTokensV3('<a href="cursia-cta://next-exam">x</a>', new Map(), 'x', new Set([1])), /MBZ_V3_TOKEN_INVALID.*cursia-cta sin resolver/, 'marcador');
    throwsSync(() => B.assertTokensV3('<a href="$@COURSESECTIONBYID*9@$">x</a>', new Map(), 'x', new Set([1, 2])), /MBZ_V3_TOKEN_INVALID/, 'sección inexistente');
    throwsSync(() => B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a>', new Map(), 'x'), /MBZ_V3_TOKEN_INVALID/, 'sin secciones');
    B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a><a href="$@QUIZVIEWBYID*5@$">y</a>', new Map([[5, 'quiz']]), 'x', new Set([1]));
  });

  // ── Guardas, tema, clave ─────────────────────────────────────────────────
  await check('guarda R-007: artifact simulado en run real → MOCK_ARTIFACT_IN_REAL_RUN; run congelado en mock → pasa', async () => {
    const byItem = new Map([['presentation:x', { itemKey: 'presentation:x', type: 'presentation', outputSummary: {}, artifacts: [{ itemKey: 'presentation:x', artifactId: 'a1', type: 'dynamic_presentation', metadata: { mock: true, fixture: true } }] }]]);
    throwsSync(() => PK.assertRunArtifactsPackageable({ id: 'r', input_payload: { providerModes: { presentation: 'real', audio: 'real' } } }, byItem), /MOCK_ARTIFACT_IN_REAL_RUN/, 'real');
    throwsSync(() => PK.assertRunArtifactsPackageable({ id: 'r', input_payload: {} }, byItem), /MOCK_ARTIFACT_IN_REAL_RUN/, 'sin modos');
    PK.assertRunArtifactsPackageable({ id: 'r', input_payload: { providerModes: { presentation: 'mock', audio: 'real' } } }, byItem);
  });
  await check('tema del paquete (F1/I4): perfil > paleta del curso (cualquier curso) > default v3 aula-clara/light', async () => {
    const prof = { themeFamily: 'vibrante', mode: 'light', brandSeed: { accent: '#AA3366' }, themeVersion: 1 };
    eq(PK.resolvePackagingTheme({ presentationProfile: prof, v2Migrated: true, legacyPaletteId: 'ocean' }).source, 'profile', 'perfil');
    const leg = PK.resolvePackagingTheme({ presentationProfile: null, v2Migrated: true, legacyPaletteId: 'ocean' });
    eq(leg.source, 'palette', 'paleta');
    eq(leg.input, { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: THEME.brandSeedFromLegacyPalette(THEME.LEGACY_PALETTES.find((p) => p.id === 'ocean')), themeVersion: 1 }, 'oscuro → oscuro-premium/dark + seed');
    eq(PK.resolvePackagingTheme({ presentationProfile: null, v2Migrated: false, legacyPaletteId: 'ocean' }), leg, 'no migrado → también la paleta (I4)');
    eq(PK.resolvePackagingTheme({ presentationProfile: null, legacyPaletteId: 'blanco-corp' }).input.themeFamily, 'aula-clara', 'claro → aula-clara');
    eq(PK.resolvePackagingTheme({ presentationProfile: null, legacyPaletteId: null }), { source: 'default_v3', input: { themeFamily: 'aula-clara', mode: 'light', themeVersion: 1 } }, 'sin paleta → default');
    eq(PK.profileWarningsV3({ source: 'default_v3' }, A.resolveAssessment(PROF.defaultAssessmentProfile({ finalExam: true }), { hasFinalExam: true, itemCounts: { practice: 1, moduleExams: 1, finalExam: 1 } })), ['presentation_profile_defaulted'], 'aviso del default');
    eq(PK.profileWarningsV3({ source: 'palette' }, A.resolveAssessment(PROF.defaultAssessmentProfile({ finalExam: true }), { hasFinalExam: true, itemCounts: { practice: 1, moduleExams: 1, finalExam: 1 } })), [], 'paleta → sin aviso');
    throwsSync(() => PK.resolvePackagingTheme({ presentationProfile: null, v2Migrated: true, legacyPaletteId: 'inexistente' }), /THEME_INVALID/, 'paleta desconocida');
    eq(PK.legacyPaletteIdOf({ pal: { id: 'berry' } }), 'berry', 'metadata.pal.id');
  });
  await check('clave de reuse v3: independiente del orden de ids; cambia con cada componente', async () => {
    const baseK = { builderVersion: '3.0.0', manifestSha256: 'm', sourceArtifactIds: ['b', 'a'], themeSha256: 't', assessmentProfileSha256: 'p', h5pProfileVersion: 1, vcRendererVersion: 'r', moodleVersion: '4.1' };
    const k0 = PK.packageReuseHashV3(baseK);
    eq(PK.packageReuseHashV3({ ...baseK, sourceArtifactIds: ['a', 'b'] }), k0, 'orden');
    for (const [f, v] of [['builderVersion', '3.0.1'], ['manifestSha256', 'm2'], ['sourceArtifactIds', ['a']], ['themeSha256', 't2'], ['assessmentProfileSha256', 'p2'], ['h5pProfileVersion', 2], ['vcRendererVersion', 'r2'], ['moodleVersion', '4.5']]) {
      assert(PK.packageReuseHashV3({ ...baseK, [f]: v }) !== k0, `cambia con ${f}`);
    }
    assert(B.DYNAMIC_MBZ_BUILDER_VERSION_V3 === '3.5.0' && loadDist('package/dynamic-mbz-builder.js').DYNAMIC_MBZ_BUILDER_VERSION === '1.3.0', 'versión v3 propia; v1/v2 intacta');
  });

  // ── Medios ────────────────────────────────────────────────────────────────
  await check('medios sintéticos (solo mocks) y reducción de portada: PDF de N páginas, MP3 medible, PNG 16-bit intacto con aviso', async () => {
    for (const n of [1, 7, 12]) eq(PRES.pdfPageCount(MEDIA.syntheticPdf(n)), n, `pdf ${n}`);
    const mp3 = MEDIA.syntheticMp3(45);
    assert(Math.abs(AUDIO.mp3DurationSeconds(mp3) - 45) < 0.03, 'mp3 45 s');
    AUDIO.assembleAudiobook([{ chapterId: 'a', chapterNumber: 1, mp3 }, { chapterId: 'b', chapterNumber: 2, mp3: MEDIA.syntheticMp3(3) }]);
    const small = MEDIA.syntheticCoverPng(300, 200, '#123456');
    eq(PNG.downscaleCoverPng(small).reason, 'already_small', 'chica');
    const big = PNG.downscaleCoverPng(MEDIA.syntheticCoverPng(2000, 1000, '#123456'));
    eq([big.width, big.height, big.downscaled], [640, 320, true], 'grande');
    const dec = PNG.decodePng(big.png);
    eq([dec.pixels[0], dec.pixels[1], dec.pixels[2]], [0x12, 0x34, 0x56], 'color preservado');
    const png16 = Buffer.from(small);
    png16[24] = 16; // bit depth del IHDR (el CRC queda mal, pero el decoder corta antes)
    const r16 = PNG.downscaleCoverPng(png16);
    assert(!r16.downscaled && /PNG_UNSUPPORTED/.test(r16.reason), 'formato no soportado → intacto con motivo');
    eq(MA.quizMaxMarks(3), ['33.3333333', '33.3333333', '33.3333334'], 'maxmarks suman 100');
  });

  // ── Worker v3 (dependencias falsas) ──────────────────────────────────────
  await workerChecks();

  // ── v1/v2 intactos ────────────────────────────────────────────────────────
  await check('v1/v2 byte-idénticos: check-dynamic-video-delivery (sha fijado) y check-packaging-plan-determinism pasan', async () => {
    for (const s of ['check-dynamic-video-delivery.js', 'check-packaging-plan-determinism.js']) {
      const r = spawnSync(process.execPath, [path.join(__dirname, s), distRoot], { encoding: 'utf8', cwd: ROOT });
      assert(r.status === 0, `${s} falló:\n${(r.stdout + r.stderr).split('\n').filter((l) => /❌/.test(l)).slice(0, 5).join('\n')}`);
    }
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ═══ Worker v3 con fakes ═══════════════════════════════════════════════════
async function workerChecks() {
  const fx = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 621 });
  const manifest = fx.manifest;
  const RUN_ID = '11111111-1111-4111-8111-111111111111';
  const OWNER = 'owner-1';
  // Artifacts del run: contenido real de los fixtures; presentación y audio como FIXTURES de R4 (sin bytes).
  const artifacts = new Map(); // id -> {content, meta, mime}
  const rows = [];
  let n = 0;
  const addArt = (item, type, content, meta = {}, mime = 'application/json') => {
    const id = `art-${String(++n).padStart(3, '0')}`;
    artifacts.set(id, { content, meta, mime });
    rows.push({ item_key: item.key, item_run_id: `gir-${item.key}`, gir_status: 'completed', gir_type: item.type, output_summary: {}, artifact_id: id, artifact_type: type, storage_bucket: 'cursia-artifacts', storage_path: `${OWNER}/x/${id}`, mime_type: mime, artifact_status: null, metadata: meta });
  };
  const byChapter = (item) => item.chapterId;
  for (const item of manifest.items) {
    const ch = byChapter(item);
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
      case 'video': addArt(item, 'dynamic_video', JSON.stringify({ mode: 'real', delivery: 'youtube', videogenJobId: `vg-${ch}`, youtubeVideoId: PF.YOUTUBE_ID, youtubeUrl: `https://www.youtube.com/watch?v=${PF.YOUTUBE_ID}`, durationSec: PF.VIDEO_SECONDS })); break;
      case 'video_interactions': addArt(item, 'dynamic_video_interactions_json', JSON.stringify(fx.contents.videoInteractions.get(ch))); break;
      case 'activity': addArt(item, 'dynamic_h5p_params_json', JSON.stringify(fx.contents.activities.get(ch).payload)); break;
      case 'exam': addArt(item, 'dynamic_exam_gift', fx.contents.examGift.get(item.moduleId), {}, 'text/plain'); break;
      case 'final_exam': addArt(item, 'dynamic_exam_gift', fx.contents.finalExamGift, {}, 'text/plain'); break;
      default: throw new Error(`tipo sin fixture ${item.type}`);
    }
  }

  function harness({ providerModes, profiles = [], stripMockMetadata = false, courseMetadata = {} } = {}) {
    const rowsFor = stripMockMetadata ? rows.map((r) => ({ ...r, metadata: {} })) : rows;
    const state = { completed: [], failed: [], uploads: [], ledger: [], dynamicMbz: [] };
    const runRow = { id: RUN_ID, owner_id: OWNER, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: { videoMode: 'real', videoDelivery: 'youtube', ...(providerModes ? { providerModes } : {}) } };
    const ds = {
      async query(sql, params) {
        if (/set status = 'completed'/.test(sql)) { state.completed.push(JSON.parse(params[2])); return [{ id: params[0] }]; }
        if (/set status = 'failed'/.test(sql)) { state.failed.push(params[2]); return []; }
        if (/set lease_until = now\(\)/.test(sql)) return [{ id: params[0] }];
        if (/from public\.course_profiles/.test(sql)) return profiles;
        if (/from public\.courses where id = \$1/.test(sql)) return [{ metadata: courseMetadata }];
        if (/generation_item_runs/.test(sql)) return rowsFor;
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
        async getByNumber() { throw new Error('v3 no debe usar getByNumber (501 BLUEPRINT_V2_REQUIRES_RULES_V3)'); },
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
      finops: { async recordZero(e) { state.ledger.push(e); return { inserted: true }; } },
      loadersV3: () => ({
        loadText: async (a) => artifacts.get(a.artifactId).content,
        loadBytes: async () => { throw new Error('los audios del fixture son mock (JSON)'); },
        loadStorageBytes: async () => { throw new Error('las presentaciones del fixture son mock'); },
      }),
      nowSeconds: () => 1790600000,
    };
    const job = { id: 'job-1', owner_id: OWNER, course_id: manifest.source.courseId, frontend_course_id: null, worker_status: 'running', status: 'running', input_payload: { runId: RUN_ID, manifestId: 9001, blueprintNumber: 1 }, output_summary: {}, attempt_count: 1, max_attempts: 3 };
    return { deps, job, state };
  }

  await check('worker v3: run congelado en mock para Gamma/TTS → las fixtures fluyen (medios sintéticos), valida, sube y registra ZERO_BY_DESIGN', async () => {
    const h = harness({ providerModes: { presentation: 'mock', audio: 'mock' } });
    await W.processItem(h.deps, h.job);
    eq(h.state.failed, [], 'sin fallos');
    eq(h.state.uploads.length, 1, 'un upload');
    const s = h.state.completed[0];
    eq([s.builderVersion, s.rulesVersion, s.reused, s.themeSource], [B.DYNAMIC_MBZ_BUILDER_VERSION_V3, 3, false, 'default_v3'], 'resumen');
    // F1 (I4): sin perfil ni paleta guardada → aviso visible en el resumen del paquete.
    assert((s.warnings || []).some((w) => w.code === 'presentation_profile_defaulted'), `aviso presentation_profile_defaulted: ${JSON.stringify(s.warnings)}`);
    eq(s.assessment && s.assessment.weightsNormalized, false, 'F1 (I3): curso completo → sin normalizar');
    eq(s.mockProviderItems.length, manifest.items.filter((i) => ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(i.type)).length, 'fixtures materializadas');
    eq(h.state.ledger.map((e) => [e.kind, e.externalId, e.attributionRunId]), [['package', 'job-1', RUN_ID]], 'ZERO_BY_DESIGN');
    const up = h.state.uploads[0];
    assert(up.storagePath.endsWith(`/${s.sourceIdsHash}.mbz`) && up.upsert === false, 'path direccionado por la clave');
    const z = await JSZip.loadAsync(up.buffer);
    assert(z.file('moodle_backup.xml'), 'es un .mbz');
    // restore-first: el mismo job otra vez reutiliza el .mbz subido
    h.state.completed.length = 0;
    await W.processItem(h.deps, h.job);
    eq([h.state.uploads.length, h.state.completed[0].reused, h.state.completed[0].artifactId], [1, true, 'mbz-1'], 'reuse');
    assert((h.state.completed[0].warnings || []).some((w) => w.code === 'presentation_profile_defaulted'), 'el aviso también en el paquete reutilizado');
    // un perfil de evaluación nuevo (nota 80) = clave nueva = paquete nuevo, sin artifacts nuevos
    const p80 = PROF.defaultAssessmentProfile({ finalExam: true });
    p80.passingGrade = 80;
    const h2 = harness({ providerModes: { presentation: 'mock', audio: 'mock' }, profiles: [{ kind: 'assessment', version: 2, data: p80 }] });
    h2.state.dynamicMbz.push(...h.state.dynamicMbz);
    await W.processItem(h2.deps, h2.job);
    const s2 = h2.state.completed[0];
    assert(s2.sourceIdsHash !== s.sourceIdsHash && s2.reused === false, 'clave nueva, build nuevo');
    eq(s2.sourceArtifactIds, s.sourceArtifactIds, 'mismos artifacts de origen');
    eq(s2.assessmentProfileVersion, 2, 'versión del perfil');
  });
  await check('F1 (I4) worker v3: sin perfil pero con la paleta guardada en el curso → tema de la paleta, sin aviso de default', async () => {
    const h = harness({ providerModes: { presentation: 'mock', audio: 'mock' }, courseMetadata: { paletteId: 'blanco-corp' } });
    await W.processItem(h.deps, h.job);
    eq(h.state.failed, [], 'sin fallos');
    const s = h.state.completed[0];
    eq(s.themeSource, 'palette', 'fuente');
    assert(!(s.warnings || []).some((w) => w.code === 'presentation_profile_defaulted'), 'sin aviso de default');
    const expected = THEME.themeSha256(THEME.resolveTheme(THEME.presentationProfileFromPaletteId('blanco-corp')));
    eq(s.themeSha256, expected, 'tema = aula-clara/light + seed de blanco-corp');
  });
  await check('worker v3: run REAL con fixtures de proveedor → falla MOCK_ARTIFACT_IN_REAL_RUN antes de construir o subir', async () => {
    const h = harness({ providerModes: { presentation: 'real', audio: 'real' } });
    await W.processItem(h.deps, h.job);
    eq(h.state.uploads.length, 0, 'sin upload');
    assert(h.state.failed.length === 1 && /MOCK_ARTIFACT_IN_REAL_RUN/.test(h.state.failed[0]), `falla: ${h.state.failed[0]}`);
  });
  await check('worker v3: perfil de evaluación inaplicable al run (pesos sin final) → falla fuerte, sin upload', async () => {
    const h = harness({ providerModes: { presentation: 'mock', audio: 'mock' }, profiles: [{ kind: 'assessment', version: 3, data: PROF.defaultAssessmentProfile({ finalExam: false }) }] });
    await W.processItem(h.deps, h.job);
    eq(h.state.uploads.length, 0, 'sin upload');
    assert(/ASSESSMENT_PROFILE_INVALID.*WEIGHTS_FINAL_EXAM_MISMATCH/.test(h.state.failed[0] || ''), `falla: ${h.state.failed[0]}`);
  });
  await check('fix G6 I1 (worker): run REAL cuyas fixtures perdieron la marca en metadata (solo el cuerpo dice fixture) → MOCK_ARTIFACT_IN_REAL_RUN, sin upload', async () => {
    const h = harness({ providerModes: { presentation: 'real', audio: 'real' }, stripMockMetadata: true });
    await W.processItem(h.deps, h.job);
    eq(h.state.uploads.length, 0, 'sin upload');
    assert(h.state.failed.length === 1 && /MOCK_ARTIFACT_IN_REAL_RUN/.test(h.state.failed[0]), `falla: ${h.state.failed[0]}`);
    const hm = harness({ providerModes: { presentation: 'mock', audio: 'mock' }, stripMockMetadata: true });
    await W.processItem(hm.deps, hm.job);
    eq([hm.state.failed.length, hm.state.uploads.length], [0, 1], 'el mismo cuerpo en un run mock sí empaqueta');
  });
}
