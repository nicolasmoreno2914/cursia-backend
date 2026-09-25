#!/usr/bin/env node
/* eslint-disable */
// Fase 5B.1 — regresión del mapeo examen/video por UUID (sin DB, sin red).
//
// Fixture del criterio de aceptación de Fase 4, que el curso real 39 no
// reproducía: 4 módulos {2,5,1,3}; exámenes M1 ON, M2 OFF, M3 ON, M4 ON (un
// módulo intermedio SIN examen); videos en los capítulos globales
// 1, 3, 5, 8, 10 y 11.
//
// Recorre Blueprint snapshot → Generation Manifest → PackagingPlan →
// buildDynamicMbz con los módulos COMPILADOS de dist/ (igual que
// check-packaging-plan-determinism.js), y verifica el .mbz resultante por UUID,
// no solo por conteo: cada contenido de entrada lleva un marcador con el UUID
// de su capítulo o módulo, y el check exige que ese marcador aparezca en la
// actividad correcta dentro de la sección de Moodle correcta.
//
// Usage:
//   node scripts/check-packaging-exam-video-mapping.js
//   node scripts/check-packaging-exam-video-mapping.js path/to/dist

const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');

function loadDist(relPath) {
  const abs = path.join(distRoot, relPath);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const { buildBlueprintSnapshot, snapshotSha256 } = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const { buildGenerationManifest } = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const { buildPackagingPlan } = loadDist('modules/dynamic-packaging/packaging-plan.js');
const { buildDynamicMbz } = loadDist('package/dynamic-mbz-builder.js');
const JSZip = require('jszip');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: esperado ${e}, encontrado ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Fixture del criterio. UUIDs fijos (v4) para que un fallo sea reproducible.
// ---------------------------------------------------------------------------

const M = [
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003',
  'a1000000-0000-4000-8000-000000000004',
];
const EXAM_BY_MODULE = [true, false, true, true];
const CHAPTERS_PER_MODULE = [2, 5, 1, 3];
const VIDEO_CHAPTER_NUMBERS = [1, 3, 5, 8, 10, 11];

function chapterUuid(n) {
  return `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function buildFixture() {
  const modules = M.map((id, i) => ({
    id,
    position: i,
    title: `Módulo criterio ${i + 1}`,
    objective: `Objetivo del módulo ${i + 1}`,
    exam_enabled: EXAM_BY_MODULE[i],
  }));
  const chapters = [];
  let n = 0;
  CHAPTERS_PER_MODULE.forEach((count, mi) => {
    for (let ci = 0; ci < count; ci++) {
      n += 1;
      chapters.push({
        id: chapterUuid(n),
        module_id: M[mi],
        position: ci,
        title: `Capítulo criterio ${n}`,
        objective: null,
        video_enabled: VIDEO_CHAPTER_NUMBERS.includes(n),
      });
    }
  });
  const snapshot = buildBlueprintSnapshot({ id: 9001, title: 'Curso fixture criterio M1/M3/M4' }, modules, chapters);
  const manifest = buildGenerationManifest(snapshot, {
    courseId: 9001,
    blueprintId: 9001,
    blueprintNumber: 1,
    blueprintSha256: snapshotSha256(snapshot),
  });
  const plan = buildPackagingPlan(manifest, snapshot, { manifestId: 9001 });
  return { snapshot, manifest, plan };
}

// Marcadores con UUID en cada contenido de entrada.
const chMark = (uuid) => `MARKCH${uuid}`;
const modMark = (uuid) => `MARKMOD${uuid}`;

function buildContents(plan) {
  const contents = { contentMd: new Map(), scorm: new Map(), examGift: new Map(), videos: new Map() };
  for (const m of plan.modules) {
    if (m.examItemKey) {
      contents.examGift.set(
        m.moduleId,
        [1, 2, 3].map((q) => `::Q${q}:: Pregunta ${q} ${modMark(m.moduleId)} {=correcta ~incorrecta}`).join('\n\n'),
      );
    }
    for (const c of m.chapters) {
      contents.contentMd.set(c.chapterId, `# ${c.title}\n\nContenido ${chMark(c.chapterId)}.`);
      contents.scorm.set(c.chapterId, {
        html: `<html><body><h1>${chMark(c.chapterId)}</h1></body></html>`,
        manifestXml: `<?xml version="1.0"?><manifest identifier="cap${c.chapterNumber}"></manifest>`,
      });
      if (c.videoItemKey) {
        contents.videos.set(c.chapterId, {
          url: `https://videosb.nomaddi.com/api/videos/${c.chapterId}/download`,
          videogenJobId: `job-${c.chapterId}`,
        });
      }
    }
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Lectura del .mbz
// ---------------------------------------------------------------------------

async function readMbz(buf) {
  const zip = await JSZip.loadAsync(buf);
  const text = async (f) => {
    const e = zip.file(f);
    if (!e) throw new Error(`falta ${f} en el .mbz`);
    return e.async('string');
  };

  // moduleid → número de sección, desde sections/section_N/section.xml
  const sectionOfModule = {};
  const sectionNumbers = [];
  for (const f of Object.keys(zip.files).filter((x) => /^sections\/section_\d+\/section\.xml$/.test(x))) {
    const x = await text(f);
    const num = Number((x.match(/<number>(\d+)<\/number>/) || [])[1]);
    sectionNumbers.push(num);
    const seq = (x.match(/<sequence>([^<]*)<\/sequence>/) || [])[1] || '';
    seq.split(',').filter(Boolean).forEach((mid, idx) => {
      sectionOfModule[mid] = { section: num, index: idx };
    });
  }

  // Actividades: moduleid, modname, contextid y su xml principal.
  const activities = [];
  for (const f of Object.keys(zip.files).filter((x) => /^activities\/(\w+)_(\d+)\/\1\.xml$/.test(x))) {
    const [, modname, mid] = f.match(/^activities\/(\w+)_(\d+)\//);
    const xml = await text(f);
    const ctx = (xml.match(/contextid="(\d+)"/) || [])[1];
    activities.push({ modname, mid, ctx, xml, ...sectionOfModule[mid] });
  }

  // files.xml → blobs por contexto
  const filesXml = await text('files.xml');
  const files = [...filesXml.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].map((m) => {
    const b = m[1];
    const g = (tag) => (b.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
    return { hash: g('contenthash'), ctx: g('contextid'), comp: g('component'), area: g('filearea'), name: g('filename') };
  });
  const blob = async (hash) => text(`files/${hash.slice(0, 2)}/${hash}`);

  const questionsXml = await text('questions.xml');
  return { activities, files, blob, questionsXml, sectionNumbers };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

(async () => {
  const { manifest, plan } = buildFixture();
  const contents = buildContents(plan);
  const buf = await buildDynamicMbz({ plan, contents });
  const mbz = await readMbz(buf);

  const chapterByNumber = {};
  for (const m of plan.modules) for (const c of m.chapters) chapterByNumber[c.chapterNumber] = c;
  const moduleByUuid = Object.fromEntries(plan.modules.map((m) => [m.moduleId, m]));

  check('Manifest: exam solo en M1/M3/M4 (por UUID), video solo en caps 1,3,5,8,10,11 (por UUID)', () => {
    const examModules = manifest.items.filter((i) => i.type === 'exam').map((i) => i.moduleId);
    assertDeepEqual(examModules, [M[0], M[2], M[3]], 'exam items');
    const videoChapters = manifest.items.filter((i) => i.type === 'video').map((i) => i.chapterId);
    assertDeepEqual(videoChapters, VIDEO_CHAPTER_NUMBERS.map(chapterUuid), 'video items');
  });

  check('Plan: capítulos 1..11 globales, módulo y posición correctos por UUID', () => {
    const got = plan.modules.flatMap((m) => m.chapters.map((c) => [c.chapterNumber, c.chapterId, c.moduleId, m.sectionNum]));
    let n = 0;
    const expected = [];
    CHAPTERS_PER_MODULE.forEach((count, mi) => {
      for (let ci = 0; ci < count; ci++) {
        n += 1;
        expected.push([n, chapterUuid(n), M[mi], 2 + mi]);
      }
    });
    assertDeepEqual(got, expected, 'chapters');
    assertDeepEqual(plan.totals, { modules: 4, chapters: 11, scorms: 11, videos: 6, exams: 3 }, 'totals');
  });

  check('Plan: examItemKey por UUID — M2 (intermedio) sin examen', () => {
    assertDeepEqual(
      plan.modules.map((m) => [m.moduleId, m.examItemKey]),
      [[M[0], `exam:${M[0]}`], [M[1], null], [M[2], `exam:${M[2]}`], [M[3], `exam:${M[3]}`]],
      'examItemKey',
    );
  });

  check('.mbz: secciones 0..5 exactamente (sin sección de cierre/examen final)', () => {
    assertDeepEqual([...mbz.sectionNumbers].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'sections');
  });

  check('.mbz: 3 quiz, cada uno en la sección de su módulo y con las preguntas de ESE módulo (UUID)', () => {
    const quizzes = mbz.activities.filter((a) => a.modname === 'quiz');
    assert(quizzes.length === 3, `esperado 3 quiz, encontrado ${quizzes.length}`);
    const got = [];
    for (const q of quizzes) {
      // preguntas del banco en el contexto de este quiz (contextinstanceid = moduleid)
      const cats = [...mbz.questionsXml.matchAll(/<question_category id="\d+">([\s\S]*?)<\/question_category>/g)]
        .map((m) => m[1])
        .filter((b) => (b.match(/<contextinstanceid>(\d+)<\/contextinstanceid>/) || [])[1] === q.mid);
      const marks = new Set();
      for (const b of cats) for (const mm of b.matchAll(/MARKMOD([0-9a-f-]{36})/g)) marks.add(mm[1]);
      assert(marks.size === 1, `quiz ${q.mid}: esperado preguntas de 1 módulo, encontrado ${[...marks].join(',') || 'ninguno'}`);
      const moduleId = [...marks][0];
      const mod = moduleByUuid[moduleId];
      assert(mod, `quiz ${q.mid}: UUID de módulo desconocido ${moduleId}`);
      assert(q.section === mod.sectionNum, `quiz del módulo ${moduleId} en sección ${q.section}, esperado ${mod.sectionNum}`);
      got.push([moduleId, q.section]);
    }
    got.sort((a, b) => a[1] - b[1]);
    assertDeepEqual(got, [[M[0], 2], [M[2], 4], [M[3], 5]], 'quiz por módulo');
    assert(!quizzes.some((q) => /final/i.test(q.xml.match(/<name>([^<]*)<\/name>/)?.[1] || '')), 'hay un quiz "final"');
    assert(!mbz.activities.some((a) => a.section === 3 && a.modname === 'quiz'), 'M2 (sección 3) tiene quiz');
  });

  check('.mbz: 6 url de video, cada una con el UUID de SU capítulo y en la sección de su módulo', () => {
    const urls = mbz.activities.filter((a) => a.modname === 'url');
    assert(urls.length === 6, `esperado 6 url, encontrado ${urls.length}`);
    const got = urls
      .map((u) => {
        const ext = (u.xml.match(/<externalurl>([^<]*)<\/externalurl>/) || [])[1] || '';
        const uuid = (ext.match(/videos\/([0-9a-f-]{36})\/download/) || [])[1];
        const ch = plan.modules.flatMap((m) => m.chapters).find((c) => c.chapterId === uuid);
        assert(ch, `url ${u.mid} sin UUID de capítulo conocido (${ext})`);
        const mod = moduleByUuid[ch.moduleId];
        assert(u.section === mod.sectionNum, `video del cap ${ch.chapterNumber} en sección ${u.section}, esperado ${mod.sectionNum}`);
        return ch.chapterNumber;
      })
      .sort((a, b) => a - b);
    assertDeepEqual(got, VIDEO_CHAPTER_NUMBERS, 'capítulos con video');
  });

  // Checks asíncronos (leen blobs del .mbz).
  try {
    const scorms = mbz.activities.filter((a) => a.modname === 'scorm');
    assert(scorms.length === 11, `esperado 11 scorm, encontrado ${scorms.length}`);
    const rows = [];
    for (const s of scorms) {
      const idx = mbz.files.find((f) => f.ctx === s.ctx && f.comp === 'mod_scorm' && f.area === 'content' && f.name === 'index.html');
      assert(idx, `scorm ${s.mid} sin index.html`);
      const html = await mbz.blob(idx.hash);
      const uuid = (html.match(/MARKCH([0-9a-f-]{36})/) || [])[1];
      const ch = plan.modules.flatMap((m) => m.chapters).find((c) => c.chapterId === uuid);
      assert(ch, `scorm ${s.mid} sin UUID de capítulo conocido`);
      assert(s.section === moduleByUuid[ch.moduleId].sectionNum, `scorm cap ${ch.chapterNumber} en sección ${s.section}`);
      rows.push([s.section, s.index, ch.chapterNumber]);
    }
    rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assertDeepEqual(rows.map((r) => r[2]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'orden de SCORM por sección/sequence');
    console.log('✅ .mbz: 11 SCORM, index.html con el UUID de su capítulo, en su sección y en orden (sin truncar tras el cap 9)');
  } catch (err) {
    failures += 1;
    console.error('❌ .mbz: 11 SCORM por UUID/orden');
    console.error(`   ${err.message}`);
  }

  try {
    const res = mbz.activities.filter((a) => a.modname === 'resource');
    assert(res.length === 1 && res[0].section === 1, 'esperado 1 resource (Libro Guía) en la sección 1');
    const f = mbz.files.find((x) => x.ctx === res[0].ctx && x.comp === 'mod_resource' && x.area === 'content' && x.name === 'libro_guia_completo.html');
    assert(f, 'falta libro_guia_completo.html');
    const html = await mbz.blob(f.hash);
    assert(/<\/html>\s*$/.test(html), 'el Libro Guía no cierra en </html>');
    const order = [...html.matchAll(/MARKCH([0-9a-f-]{36})/g)].map((m) => m[1]);
    const uniq = order.filter((u, i) => order.indexOf(u) === i);
    assertDeepEqual(uniq, Array.from({ length: 11 }, (_, i) => chapterUuid(i + 1)), 'capítulos del Libro Guía');
    console.log('✅ .mbz: Libro Guía con los 11 capítulos en orden por UUID (sin truncar tras el cap 9)');
  } catch (err) {
    failures += 1;
    console.error('❌ .mbz: Libro Guía completo');
    console.error(`   ${err.message}`);
  }

  await checkV2();

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) fallaron — mapeo examen/video por UUID roto.`);
    process.exit(1);
  }
  console.log('\n✅ Mapeo examen/video por UUID OK (criterio M1/M3/M4, videos 1,3,5,8,10,11).');
})().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// rulesVersion 2 (5B.2.B): mismo fixture del criterio con Manifest v2 →
// 37 items (identidad por key/UUID), intro de curso en la sección 0 después
// de la bienvenida, intro de cada módulo como PRIMER label de SU sección (por
// UUID), prefacios de módulo + bibliografía en el Libro Guía. Las
// verificaciones v1 de arriba no cambian.
// ---------------------------------------------------------------------------

async function checkV2() {
  const { snapshot } = buildFixture();
  const manifest = buildGenerationManifest(
    snapshot,
    { courseId: 9001, blueprintId: 9001, blueprintNumber: 1, blueprintSha256: snapshotSha256(snapshot) },
    { rulesVersion: 2 },
  );
  const plan = buildPackagingPlan(manifest, snapshot, { manifestId: 9002 });
  const ciMark = 'MARKCOURSEINTRO9001';
  const bibMark = 'MARKBIBLIO9001';
  const miMark = (uuid) => `MARKMI${uuid}`;
  const contents = buildContents(plan);
  contents.courseIntroMd = [
    '## Introducción', `Intro del curso ${ciMark}.`,
    '## Metodología', 'Metodología.', '## Competencias', '- Competencia 1',
    '## Bibliografía sugerida', `- Autor, A. (2020). *Libro* ${bibMark}.`,
  ].join('\n');
  contents.moduleIntroMd = new Map(plan.modules.map((m) => [m.moduleId,
    `## Presentación del módulo\nPresentación ${miMark(m.moduleId)} <b>no-html</b> & "citas".\n\n## Bibliografía sugerida\n- Ref del módulo.`]));

  check('v2 Manifest: 37 items exactos por key/UUID (11 content, 11 scorm, 6 video, 3 exam, 1 plan, 1 intro, 4 intros de módulo)', () => {
    const expected = ['course_plan:9001', 'course_intro:9001'];
    let n = 0;
    CHAPTERS_PER_MODULE.forEach((count, mi) => {
      expected.push(`module_intro:${M[mi]}`);
      for (let ci = 0; ci < count; ci++) {
        n += 1;
        expected.push(`content:${chapterUuid(n)}`, `scorm:${chapterUuid(n)}`);
        if (VIDEO_CHAPTER_NUMBERS.includes(n)) expected.push(`video:${chapterUuid(n)}`);
      }
      if (EXAM_BY_MODULE[mi]) expected.push(`exam:${M[mi]}`);
    });
    assertDeepEqual(manifest.items.map((i) => i.key), expected, 'keys v2');
    assert(expected.length === 37, `esperado 37, encontrado ${expected.length}`);
    assert(manifest.totals.totalJobs === 37, 'totals.totalJobs');
  });

  check('v2 Plan: courseIntroItemKey y moduleIntroItemKey por UUID; totals iguales a v1', () => {
    assert(plan.rulesVersion === 2, 'plan.rulesVersion');
    assert(plan.courseIntroItemKey === 'course_intro:9001', `courseIntroItemKey=${plan.courseIntroItemKey}`);
    assertDeepEqual(plan.modules.map((m) => [m.moduleId, m.moduleIntroItemKey]), M.map((id) => [id, `module_intro:${id}`]), 'moduleIntroItemKey');
    assertDeepEqual(plan.totals, { modules: 4, chapters: 11, scorms: 11, videos: 6, exams: 3 }, 'totals');
  });

  const mbz = await readMbz(await buildDynamicMbz({ plan, contents }));
  const labelText = (a) => a.xml;
  const moduleByUuid = Object.fromEntries(plan.modules.map((m) => [m.moduleId, m]));

  check('v2 .mbz: sección 0 = foro, bienvenida, intro de curso (con su marcador) — en ese orden', () => {
    const s0 = mbz.activities.filter((a) => a.section === 0).sort((x, y) => x.index - y.index);
    assertDeepEqual(s0.map((a) => a.modname), ['forum', 'label', 'label'], 'actividades de la sección 0');
    assert(/Bienvenida/.test(labelText(s0[1])), 'la 2ª actividad no es la bienvenida');
    assert(labelText(s0[2]).includes(ciMark), 'la intro de curso no está después de la bienvenida');
    assert(!labelText(s0[2]).includes('<h2>'), 'el HTML de la intro no está xml-escapado en label.xml');
    const withCi = mbz.activities.filter((a) => a.xml.includes(ciMark));
    assert(withCi.length === 1, `el marcador de la intro de curso aparece en ${withCi.length} actividades`);
  });

  check('v2 .mbz: la intro de CADA módulo es el primer label de SU sección (por UUID), y solo ahí', () => {
    for (const m of plan.modules) {
      const inSection = mbz.activities.filter((a) => a.section === m.sectionNum).sort((x, y) => x.index - y.index);
      const first = inSection[0];
      assert(first && first.modname === 'label' && first.xml.includes(miMark(m.moduleId)),
        `módulo ${m.moduleId}: la primera actividad de la sección ${m.sectionNum} no es su intro`);
      assert(first.xml.includes('&amp;lt;b&amp;gt;no-html&amp;lt;/b&amp;gt;'), `módulo ${m.moduleId}: el HTML del markdown no quedó escapado (md→HTML + xmlEsc)`);
      const holders = mbz.activities.filter((a) => a.xml.includes(miMark(m.moduleId)));
      assert(holders.length === 1 && holders[0].section === m.sectionNum, `módulo ${m.moduleId}: su intro aparece fuera de su sección`);
      assert(moduleByUuid[m.moduleId].sectionNum === 2 + M.indexOf(m.moduleId), 'sectionNum por UUID');
    }
  });

  check('v2 .mbz: 3 quiz (M1/M3/M4) y 6 url de video, igual que v1', () => {
    const quizzes = mbz.activities.filter((a) => a.modname === 'quiz').map((q) => q.section).sort();
    assertDeepEqual(quizzes, [2, 4, 5], 'secciones con quiz');
    assert(mbz.activities.filter((a) => a.modname === 'url').length === 6, '6 url');
    assert(mbz.activities.filter((a) => a.modname === 'scorm').length === 11, '11 scorm');
  });

  try {
    const res = mbz.activities.filter((a) => a.modname === 'resource');
    assert(res.length === 1 && res[0].section === 1, 'esperado 1 resource (Libro Guía) en la sección 1');
    const f = mbz.files.find((x) => x.ctx === res[0].ctx && x.name === 'libro_guia_completo.html');
    const html = await mbz.blob(f.hash);
    assert(/<\/html>\s*$/.test(html), 'el Libro Guía no cierra en </html>');
    const order = [...html.matchAll(/MARK(MI|CH)([0-9a-f-]{36})|MARKBIBLIO9001/g)].map((m) => m[0]);
    const uniq = order.filter((u, i) => order.indexOf(u) === i);
    const expected = [];
    let n = 0;
    CHAPTERS_PER_MODULE.forEach((count, mi) => {
      expected.push(miMark(M[mi]));
      for (let ci = 0; ci < count; ci++) { n += 1; expected.push(chMark(chapterUuid(n))); }
    });
    expected.push(bibMark);
    assertDeepEqual(uniq, expected, 'orden del Libro Guía (prefacio de módulo → capítulos …, bibliografía al final)');
    assert(!html.includes(ciMark), 'el Libro Guía solo lleva la bibliografía de la intro de curso, no la intro completa');
    console.log('✅ v2 .mbz: Libro Guía con prefacio de cada módulo antes de sus capítulos (UUID) y la bibliografía sugerida al final');
  } catch (err) {
    failures += 1;
    console.error('❌ v2 .mbz: Libro Guía v2');
    console.error(`   ${err.message}`);
  }

  // I3 (fix wave review-rv2): encabezado "Bibliografía sugerida" tolerante
  // (marcador opcional + cualquier texto después), MISMA regex que la
  // validación del frontend (45/46). Si falta igual, el builder NO lanza:
  // renderiza la intro entera sin separar y omite la sección del Libro Guía
  // (con warning) — empaquetar nunca queda imposible para siempre.
  for (const [heading, expectBib] of [
    ['## Bibliografía sugerida — 5 a 8 referencias reales (autor, título, año)', true],
    ['## Bibliografía sugerida y lecturas', true],
    ['### Bibliografía sugerida (APA)', true],
    ['## Bibliografia Sugerida:', true],
    ['Bibliografía sugerida', true],
    ['## Bibliografía', false],
  ]) {
    const variant = { ...contents, courseIntroMd: `## Introducción\nIntro ${ciMark}.\n\n${heading}\n- Autor, A. (2020). *Libro* ${bibMark}.` };
    const warns = [];
    const { Logger } = require('@nestjs/common');
    const origWarn = Logger.prototype.warn;
    Logger.prototype.warn = function (m) { warns.push(String(m)); };
    let err = null;
    let buf = null;
    try { buf = await buildDynamicMbz({ plan, contents: variant }); } catch (e) { err = e; } finally { Logger.prototype.warn = origWarn; }
    const name = `v2 builder con intro "${heading}"`;
    if (err) { failures += 1; console.error(`❌ ${name}: lanzó (${err.message}) — debe empaquetar igual`); continue; }
    const m2 = await readMbz(buf);
    const res = m2.activities.find((a) => a.modname === 'resource');
    const f = m2.files.find((x) => x.ctx === res.ctx && x.name === 'libro_guia_completo.html');
    const html = await m2.blob(f.hash);
    const ci = m2.activities.find((a) => a.section === 0 && a.xml.includes(ciMark));
    const okShape = expectBib
      ? html.includes(bibMark) && html.includes('id="bibliografia"') && warns.length === 0
      : !html.includes('id="bibliografia"') && !html.includes('href="#bibliografia"') && warns.some((w) => /Bibliograf/.test(w)) && /<\/html>\s*$/.test(html);
    if (okShape && ci && ci.xml.includes(bibMark)) console.log(`✅ ${name}: ${expectBib ? 'bibliografía extraída al Libro Guía' : 'sin encabezado → intro entera en su label, Libro Guía sin sección de bibliografía, warning'}`);
    else { failures += 1; console.error(`❌ ${name}: forma inesperada (bib en libro=${html.includes(bibMark)}, warns=${JSON.stringify(warns)}, intro label=${!!ci})`); }
  }

  for (const [name, mutate, needle] of [
    ['sin intro del módulo M3', (c) => c.moduleIntroMd.delete(M[2]), `module_intro:${M[2]}`],
    ['sin intro de curso', (c) => { delete c.courseIntroMd; }, 'course_intro:9001'],
  ]) {
    const broken = { ...contents, moduleIntroMd: new Map(contents.moduleIntroMd) };
    mutate(broken);
    let msg = null;
    try { await buildDynamicMbz({ plan, contents: broken }); } catch (e) { msg = e.message; }
    if (msg && msg.includes(needle)) console.log(`✅ v2 builder falla fuerte ${name} (lista ${needle})`);
    else { failures += 1; console.error(`❌ v2 builder ${name}: esperado error con ${needle}, obtenido ${msg}`); }
  }
}
