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
const AUDIO = loadDist('package/audio/index.js');
const SHELL = loadDist('modules/course-shell/index.js');
const PROF = loadDist('modules/course-profiles/course-profiles.js');
const THEME = loadDist('modules/theme-engine/index.js');
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
  await check('plan v3: cada item del Manifest en exactamente un lugar; secciones 0,1,módulos,cierre', async () => {
    const { manifest, blueprint } = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const plan = PV3.buildPackagingPlanV3(manifest, blueprint, { manifestId: 7 });
    eq(plan.sections.map((s) => [s.sectionNum, s.kind]), [[0, 'shell'], [1, 'route_and_book'], [2, 'module'], [3, 'module'], [4, 'closing']], 'secciones');
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

  await check('[h5p-final-light] H5P: activity type por UUID del capítulo (R-012), paquetes content-only del perfil, sin SingleChoiceSet', async () => {
    const { input, r } = built['h5p-final-light'];
    const acts = r.summary.h5pPackages.filter((p) => p.itemKey.startsWith('activity:'));
    const LIB = { questionset: 'H5P.QuestionSet', dragtext: 'H5P.DragText', blanks: 'H5P.Blanks' };
    for (const p of acts) {
      const chapterId = p.itemKey.slice('activity:'.length);
      eq(p.mainLibrary, LIB[SHELL.activityTypeForChapter(chapterId)], `tipo de ${p.itemKey}`);
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
    assert(html.includes('La revolución del servicio') && html.includes('(1990)'), 'entradas de bibliografía');
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
    ['STRUCTURE', () => {
      const a = find(/^cv3:exam:/);
      return { [`${a.dir}/inforef.xml`]: (x) => x.replace(/(<grade_itemref>\s*<grade_item><id>)(\d+)/, (m, pre, id) => `${pre}${Number(id) + 999}`) };
    }],
  );
  const forumAct = find(/^cv3:shell:forum$/);
  const forumCtx = /contextid="(\d+)"/.exec(await bz.file(`${forumAct.dir}/forum.xml`).async('string'))[1];
  for (const [code, mk] of cases) {
    await check(`validador detecta ${code}`, async () => {
      const bad = await mutate(base.r.mbz, mk());
      const v = await V.validateMbzV3(bad, base.r.expectations);
      assert(!v.ok && v.issues.some((i) => i.code === code), `esperaba ${code}, hallazgos: ${JSON.stringify(v.issues.slice(0, 4))}`);
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
  await check('fix G6 M5: categoría ponderada vacía → prepareV3Package falla (409 al pedir), no un job fallido', async () => {
    const { manifest } = SF.buildCourse(distRoot, { courseId: 641, finalExam: false, engine: 'h5p', modules: [{ examEnabled: true, chapters: [{ video: false, activity: false }] }] });
    const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
    const rows = [];
    for (const it of manifest.items) for (const t of R.requiredArtifactTypesV3(it.type, it.variant)) {
      rows.push({ item_key: it.key, item_run_id: `g-${it.key}`, gir_status: 'completed', gir_type: it.type, output_summary: {}, artifact_id: `${it.key}-${t}`, artifact_type: t, storage_bucket: 'b', storage_path: 'o/p', mime_type: 'application/json', artifact_status: null, metadata: {} });
    }
    const q = { query: async (sql) => {
      if (/generation_item_runs/.test(sql)) return rows;
      if (/course_profiles/.test(sql)) return [];
      if (/course_generation_manifests/.test(sql)) return [{ n: 0 }];
      if (/production_jobs/.test(sql)) return [{ id: 'r', owner_id: 'o', execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: {} }];
      throw new Error(sql);
    } };
    await rejects(PK.prepareV3Package(q, 'r', { id: 1, sha256: 's', manifest }, 641, '4.1'), /ASSESSMENT_EMPTY_WEIGHTED_CATEGORY: practice/, 'práctica vacía');
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
    await rejects(B.buildDynamicMbzV3(input), /ASSESSMENT_EMPTY_WEIGHTED_CATEGORY: practice \(peso 40\)/, 'práctica vacía');
    const okProfile = PROF.defaultAssessmentProfile({ finalExam: false });
    okProfile.categoryWeights = { practice: 0, moduleExams: 100 };
    const r = await B.buildDynamicMbzV3({ ...input, assessmentProfile: okProfile });
    assert((await validate(r)).ok, 'con peso 0 en práctica el curso desnudo empaqueta y valida');
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
  });

  // ── Guardas, tema, clave ─────────────────────────────────────────────────
  await check('guarda R-007: artifact simulado en run real → MOCK_ARTIFACT_IN_REAL_RUN; run congelado en mock → pasa', async () => {
    const byItem = new Map([['presentation:x', { itemKey: 'presentation:x', type: 'presentation', outputSummary: {}, artifacts: [{ itemKey: 'presentation:x', artifactId: 'a1', type: 'dynamic_presentation', metadata: { mock: true, fixture: true } }] }]]);
    throwsSync(() => PK.assertRunArtifactsPackageable({ id: 'r', input_payload: { providerModes: { presentation: 'real', audio: 'real' } } }, byItem), /MOCK_ARTIFACT_IN_REAL_RUN/, 'real');
    throwsSync(() => PK.assertRunArtifactsPackageable({ id: 'r', input_payload: {} }, byItem), /MOCK_ARTIFACT_IN_REAL_RUN/, 'sin modos');
    PK.assertRunArtifactsPackageable({ id: 'r', input_payload: { providerModes: { presentation: 'mock', audio: 'real' } } }, byItem);
  });
  await check('tema del paquete: perfil > paleta legacy (solo cursos migrados de v2) > default v3 aula-clara/light', async () => {
    const prof = { themeFamily: 'vibrante', mode: 'light', brandSeed: { accent: '#AA3366' }, themeVersion: 1 };
    eq(PK.resolvePackagingTheme({ presentationProfile: prof, v2Migrated: true, legacyPaletteId: 'ocean' }).source, 'profile', 'perfil');
    const leg = PK.resolvePackagingTheme({ presentationProfile: null, v2Migrated: true, legacyPaletteId: 'ocean' });
    eq(leg.source, 'legacy_palette', 'legacy');
    eq(leg.input, THEME.legacyPaletteThemeFallback('ocean'), 'fallback de R1');
    eq(PK.resolvePackagingTheme({ presentationProfile: null, v2Migrated: false, legacyPaletteId: 'ocean' }), { source: 'default_v3', input: { themeFamily: 'aula-clara', mode: 'light', themeVersion: 1 } }, 'no migrado → default');
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
    assert(B.DYNAMIC_MBZ_BUILDER_VERSION_V3 === '3.0.1' && loadDist('package/dynamic-mbz-builder.js').DYNAMIC_MBZ_BUILDER_VERSION === '1.3.0', 'versión v3 propia; v1/v2 intacta');
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

  function harness({ providerModes, profiles = [], stripMockMetadata = false } = {}) {
    const rowsFor = stripMockMetadata ? rows.map((r) => ({ ...r, metadata: {} })) : rows;
    const state = { completed: [], failed: [], uploads: [], ledger: [], dynamicMbz: [] };
    const runRow = { id: RUN_ID, owner_id: OWNER, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: { videoMode: 'real', videoDelivery: 'youtube', ...(providerModes ? { providerModes } : {}) } };
    const ds = {
      async query(sql, params) {
        if (/set status = 'completed'/.test(sql)) { state.completed.push(JSON.parse(params[2])); return [{ id: params[0] }]; }
        if (/set status = 'failed'/.test(sql)) { state.failed.push(params[2]); return []; }
        if (/set lease_until = now\(\)/.test(sql)) return [{ id: params[0] }];
        if (/from public\.course_profiles/.test(sql)) return profiles;
        if (/from public\.course_generation_manifests/.test(sql)) return [{ n: 0 }];
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
