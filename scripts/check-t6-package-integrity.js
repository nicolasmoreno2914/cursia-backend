#!/usr/bin/env node
/* eslint-disable no-console */
// T6 (r57) — integridad del paquete v3 ANTES de subir (validateMbzV3 + presupuesto de tamaño). USD 0: sin red, sin
// proveedores, sin base. Fixtures genéricos («Curso de ejemplo»).
//
//   I1  verde: H5P (examen final), SCORM (sin final), Fase 2 con Tareas calificadas + rúbrica, bancos aleatorios
//   I2  archivos: blob huérfano, ruta de blob mal formada, sha1 ≠ contenthash, filesize ≠ blob, blob faltante,
//       archivo sin referencia en el inforef de su actividad, archivo sin dueño (contexto desconocido) → FILES_INTEGRITY
//   I3  enlaces: token del tipo equivocado / inexistente, enlace muerto href="#" / javascript:, token y
//       @@PLUGINFILE@@ del CONTENIDO de una página → TOKEN_INVALID / FILES_INTEGRITY (sin ningún «#» entregado)
//   I4  cobertura del Manifest: presentación ausente, actividad ausente, video de más, presentación sin PDF → MANIFEST_COVERAGE
//   I5  H5P: carpeta de librería en un paquete solo contenido, versión de la principal ≠ Library Pack v3, dependencia
//       fuera del pack, content/content.json faltante o roto → H5P_LIBRARIES / H5P_PARTIAL_LIBRARY_CLOSURE / H5P_FILES
//   I6  bancos: filtercondition en formato 4.3+ (no legado), una pregunta menos en la hoja (≠ facts / piso del slot),
//       una referencia de más → QUIZ_RANDOM
//   I7  Tarea: nota de la Tarea ≠ perfil, rúbrica faltante → APPLICATION / RUBRIC (actividades coherentes)
//   I8  presupuesto de tamaño: entorno (sin variables = solo medir; inválido / aviso > límite → PACKAGE_SIZE_CONFIG_INVALID;
//       aviso por defecto = 90 % del límite), veredictos (aviso / error con lo más pesado), clasificación config retenida
//
// Uso: node scripts/check-t6-package-integrity.js [dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const SZ = L('package/v3/package-size-budget.js');
const FC = L('modules/reliability/failure-classifier.js');
const P = L('modules/course-profiles/course-profiles.js');
const EB = L('modules/course-shell/exam-bank.js');
const PF = require('./lib/v21-packaging-fixtures');
const DF = require('./lib/deliverable-fixtures');
const EBF = require('./lib/exam-bank-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (x, t) => ((x || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];

async function actsOf(z) {
  const mb = await z.file('moodle_backup.xml').async('string');
  const out = [];
  for (const m of mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9_]+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)) {
    const mod = await z.file(`${m[5]}/module.xml`).async('string');
    out.push({ mid: Number(m[1]), mod: m[3], dir: m[5], idnumber: (mod.match(/<idnumber>([^<]*)<\/idnumber>/) || [])[1] });
  }
  return out;
}
async function mutate(mbz, fn) {
  const z = await JSZip.loadAsync(mbz);
  await fn(z);
  return z.generateAsync({ type: 'nodebuffer' });
}
async function edit(z, p, fn) {
  const t = await z.file(p).async('string');
  const n = fn(t);
  if (n === t) throw new Error(`la mutación no cambió ${p}`);
  z.file(p, n);
}
/** Reemplaza un blob por otro contenido y actualiza files.xml (contenthash + filesize de TODAS sus entradas). */
async function replaceBlob(z, oldHash, buf) {
  const h = sha1(buf);
  z.remove(`files/${oldHash.slice(0, 2)}/${oldHash}`);
  z.file(`files/${h.slice(0, 2)}/${h}`, buf);
  await edit(z, 'files.xml', (x) => x.replace(/<file id="\d+">[\s\S]*?<\/file>/g, (b) => (b.includes(`<contenthash>${oldHash}</contenthash>`)
    ? b.replace(`<contenthash>${oldHash}</contenthash>`, `<contenthash>${h}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, `<filesize>${buf.length}</filesize>`)
    : b)));
  return h;
}
/** Bloques <file> de files.xml. */
async function filesOf(z) {
  const fx = await z.file('files.xml').async('string');
  return [...fx.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].map((m) => ({ id: m[1], block: m[0], hash: tag(m[2], 'contenthash'), ctx: tag(m[2], 'contextid'), component: tag(m[2], 'component'), filearea: tag(m[2], 'filearea'), filename: tag(m[2], 'filename') }));
}

/** Bancos válidos (mismo generador que check-p2-exam-validators). */
function bankInput() {
  const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 761 });
  const manifest = input.manifest;
  const all = manifest.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
  const gIndex = new Map(all.map((c, i) => [c.id, i]));
  const c = input.contents;
  for (const ch of all) c.contentMd.set(ch.id, `${c.contentMd.get(ch.id)}\n\n${EBF.chapterMarkdown(gIndex.get(ch.id), 'Reglas')}`);
  const banks = new Map();
  for (const m of manifest.modules) {
    if (!m.examEnabled) continue;
    const chs = all.filter((x) => x.moduleId === m.moduleId);
    banks.set(m.moduleId, EBF.makeExamBank({ scope: 'module', moduleId: m.moduleId, chapters: chs, chapterIndex: gIndex, prefix: `V${m.moduleNumber}L`, plan: EB.expectedExamPlan('module', chs) }));
  }
  c.examGift = new Map();
  c.finalExamGift = null;
  c.examBanks = banks;
  c.finalExamBank = EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: all, chapterIndex: gIndex, prefix: 'VF', plan: EB.expectedExamPlan('final', all) });
  return input;
}

(async () => {
  const h5p = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 760 }));
  const scorm = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'scorm', finalExam: false, courseId: 762 }));
  const base = P.defaultAssessmentProfile({ finalExam: true });
  const app = await B.buildDynamicMbzV3(DF.withProfile(DF.courseInput(distRoot, { courseId: 763 }), DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true })));
  const bank = await B.buildDynamicMbzV3(bankInput());
  const validate = (built, mbz) => V.validateMbzV3(mbz || built.mbz, built.expectations);
  /** La mutación produce al menos un hallazgo con `code` (y, si se da, con el mensaje que coincide). */
  const expectIssue = async (built, mbz, code, re, label) => {
    const v = await validate(built, mbz);
    const hit = v.issues.filter((i) => i.code === code && (!re || re.test(`${i.where} ${i.message}`)));
    assert(!v.ok && hit.length > 0, `${label}: se esperaba ${code}${re ? ` ${re}` : ''}; hallazgos: ${JSON.stringify(v.issues.slice(0, 5))}`);
  };

  await check('I1 verde: H5P, SCORM, Tareas calificadas con rúbrica y bancos aleatorios pasan el validador (sin «#» ni huérfanos)', async () => {
    for (const [n, b] of [['h5p', h5p], ['scorm', scorm], ['app', app], ['bank', bank]]) {
      const v = await validate(b);
      assert(v.ok, `${n}: ${JSON.stringify(v.issues.slice(0, 5))}`);
      const z = await JSZip.loadAsync(b.mbz);
      for (const p of Object.keys(z.files).filter((x) => /^activities\/.*\.xml$/.test(x))) {
        const t = await z.file(p).async('string');
        assert(!/href=(?:&quot;|")#(?:&quot;|")/.test(t), `${n}: enlace muerto en ${p}`);
      }
    }
  });

  await check('I2 archivos: huérfano, ruta mal formada, sha1, filesize, blob faltante, sin inforef, sin dueño → FILES_INTEGRITY', async () => {
    const z0 = await JSZip.loadAsync(h5p.mbz);
    const fs0 = (await filesOf(z0)).filter((f) => f.filename !== '.');
    const acts = await actsOf(z0);
    const pres = acts.find((a) => /:presentation$/.test(a.idnumber));
    const presCtx = /contextid="(\d+)"/.exec(await z0.file(`${pres.dir}/label.xml`).async('string'))[1];
    const presFile = fs0.find((f) => f.ctx === presCtx && /\.png$/.test(f.filename));
    const orphan = Buffer.from('blob que nadie declara');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => z.file(`files/${sha1(orphan).slice(0, 2)}/${sha1(orphan)}`, orphan)), 'FILES_INTEGRITY', /huérfano/, 'huérfano');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => z.file('files/zz/no-es-un-sha1', 'x')), 'FILES_INTEGRITY', /mal formada/, 'ruta');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => z.file(`files/${presFile.hash.slice(0, 2)}/${presFile.hash}`, Buffer.from('otro contenido'))), 'FILES_INTEGRITY', /sha1 del blob/, 'sha1');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => edit(z, 'files.xml', (x) => x.replace(presFile.block, () => presFile.block.replace(/<filesize>(\d+)<\/filesize>/, (m, n) => `<filesize>${Number(n) + 1}</filesize>`)))), 'FILES_INTEGRITY', /filesize/, 'filesize');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => z.remove(`files/${presFile.hash.slice(0, 2)}/${presFile.hash}`)), 'FILES_INTEGRITY', /falta el blob/, 'blob faltante');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => edit(z, `${pres.dir}/inforef.xml`, (x) => x.replace(`<file><id>${presFile.id}</id></file>`, ''))), 'FILES_INTEGRITY', /sin referencia en el inforef/, 'inforef');
    await expectIssue(h5p, await mutate(h5p.mbz, (z) => edit(z, 'files.xml', (x) => x.replace(presFile.block, () => presFile.block.replace(/<contextid>\d+<\/contextid>/, '<contextid>999999</contextid>')))), 'FILES_INTEGRITY', /sin dueño/, 'sin dueño');
  });

  await check('I3 enlaces: token de otro tipo / inexistente, href="#" / javascript:, token y @@PLUGINFILE@@ del contenido de una página → hallazgo', async () => {
    const z0 = await JSZip.loadAsync(h5p.mbz);
    const acts = await actsOf(z0);
    const lab = acts.find((a) => /:presentation$/.test(a.idnumber));
    const vid = acts.find((a) => /:video$/.test(a.idnumber));
    const inject = (html) => (z) => edit(z, `${lab.dir}/label.xml`, (x) => x.replace('<intro>', () => `<intro>${xe(html)}`));
    await expectIssue(h5p, await mutate(h5p.mbz, inject(`<a href="$@SCORMVIEWBYID*${vid.mid}@$">x</a>`)), 'TOKEN_INVALID', /SCORMVIEWBYID/, 'tipo equivocado');
    await expectIssue(h5p, await mutate(h5p.mbz, inject('<a href="$@QUIZVIEWBYID*999999@$">x</a>')), 'TOKEN_INVALID', /999999/, 'inexistente');
    await expectIssue(h5p, await mutate(h5p.mbz, inject('<a href="#">Abrir</a>')), 'TOKEN_INVALID', /enlace muerto/, 'href #');
    await expectIssue(h5p, await mutate(h5p.mbz, inject('<a href="javascript:void(0)">Abrir</a>')), 'TOKEN_INVALID', /enlace muerto/, 'javascript:');
    const za = await JSZip.loadAsync(app.mbz);
    const page = (await actsOf(za)).find((a) => a.mod === 'page');
    const injectPage = (html) => (z) => edit(z, `${page.dir}/page.xml`, (x) => x.replace('<content>', () => `<content>${xe(html)}`));
    await expectIssue(app, await mutate(app.mbz, injectPage('<a href="$@RESOURCEVIEWBYID*999999@$">x</a>')), 'TOKEN_INVALID', /#content .*RESOURCEVIEWBYID/, 'token en página');
    await expectIssue(app, await mutate(app.mbz, injectPage('<a href="@@PLUGINFILE@@/no-existe.pdf">x</a>')), 'FILES_INTEGRITY', /filearea content/, 'pluginfile en página');
    await expectIssue(app, await mutate(app.mbz, injectPage('<a href="">x</a>')), 'TOKEN_INVALID', /#content .*enlace muerto/, 'href vacío en página');
  });

  await check('I4 cobertura del Manifest: presentación / actividad ausentes, video de más, presentación sin PDF → MANIFEST_COVERAGE', async () => {
    const z0 = await JSZip.loadAsync(h5p.mbz);
    const acts = await actsOf(z0);
    const rename = (a, to) => (z) => edit(z, `${a.dir}/module.xml`, (x) => x.replace(`<idnumber>${a.idnumber}</idnumber>`, () => `<idnumber>${to}</idnumber>`));
    const pres = acts.find((a) => /:presentation$/.test(a.idnumber));
    await expectIssue(h5p, await mutate(h5p.mbz, rename(pres, pres.idnumber.replace(/:presentation$/, ':presentacion'))), 'MANIFEST_COVERAGE', /presentation/, 'presentación ausente');
    const act = acts.find((a) => /:activity$/.test(a.idnumber));
    await expectIssue(h5p, await mutate(h5p.mbz, rename(act, act.idnumber.replace(/:activity$/, ':actividad'))), 'MANIFEST_COVERAGE', /activity/, 'actividad ausente');
    // video de más: un capítulo sin video en facts recibe el idnumber de video de otra actividad
    const noVideo = h5p.expectations.facts.chapters.find((c) => !c.videoEnabled && c.activityEnabled);
    assert(noVideo, 'fixture con un capítulo sin video');
    const actNv = acts.find((a) => a.idnumber === `cv3:ch:${noVideo.id}:activity`);
    await expectIssue(h5p, await mutate(h5p.mbz, rename(actNv, `cv3:ch:${noVideo.id}:video`)), 'MANIFEST_COVERAGE', /video/, 'video de más');
    const fs0 = await filesOf(z0);
    const presCtx = /contextid="(\d+)"/.exec(await z0.file(`${pres.dir}/label.xml`).async('string'))[1];
    const pdf = fs0.find((f) => f.ctx === presCtx && /\.pdf$/.test(f.filename));
    await expectIssue(h5p, await mutate(h5p.mbz, async (z) => { await replaceBlob(z, pdf.hash, Buffer.from('no soy un pdf')); }), 'MANIFEST_COVERAGE', /no es un PDF/, 'PDF de la presentación');
    // SCORM: la actividad del capítulo debe ser un mod_scorm
    const zs = await JSZip.loadAsync(scorm.mbz);
    const sAct = (await actsOf(zs)).find((a) => a.mod === 'scorm');
    const sVid = (await actsOf(zs)).find((a) => /:video$/.test(a.idnumber));
    await expectIssue(scorm, await mutate(scorm.mbz, async (z) => {
      const chId = /^cv3:ch:([^:]+):activity$/.exec(sAct.idnumber)[1];
      await rename(sAct, `cv3:ch:${chId}:actividad`)(z);
      if (sVid && sVid.idnumber !== `cv3:ch:${chId}:video`) await rename(sVid, `cv3:ch:${chId}:activity`)(z);
    }), 'MANIFEST_COVERAGE', /activity/, 'scorm');
  });

  await check('I5 H5P: librerías en un paquete solo contenido, principal ≠ pack v3, dependencia fuera del pack, content.json → hallazgo', async () => {
    const z0 = await JSZip.loadAsync(h5p.mbz);
    const pkgFile = (await filesOf(z0)).find((f) => f.component === 'mod_h5pactivity' && f.filearea === 'package' && f.filename !== '.' && /actividad|activity/i.test(f.filename)) || (await filesOf(z0)).find((f) => f.component === 'mod_h5pactivity' && f.filearea === 'package' && f.filename !== '.');
    const orig = await z0.file(`files/${pkgFile.hash.slice(0, 2)}/${pkgFile.hash}`).async('nodebuffer');
    const withH5p = async (fn) => mutate(h5p.mbz, async (z) => {
      const hz = await JSZip.loadAsync(orig);
      await fn(hz);
      await replaceBlob(z, pkgFile.hash, await hz.generateAsync({ type: 'nodebuffer' }));
    });
    await expectIssue(h5p, await withH5p((hz) => { hz.file('H5P.Foo-1.0/library.json', JSON.stringify({ machineName: 'H5P.Foo', majorVersion: 1, minorVersion: 0, preloadedDependencies: [{ machineName: 'H5P.Bar', majorVersion: 1, minorVersion: 0 }] })); }), 'H5P_LIBRARIES', /content-only/, 'carpeta de librería');
    await expectIssue(h5p, await withH5p((hz) => { hz.file('H5P.Foo-1.0/library.json', JSON.stringify({ machineName: 'H5P.Foo', majorVersion: 1, minorVersion: 0, preloadedDependencies: [{ machineName: 'H5P.Bar', majorVersion: 1, minorVersion: 0 }] })); }), 'H5P_PARTIAL_LIBRARY_CLOSURE', /H5P\.Bar/, 'clausura parcial');
    const hj = JSON.parse(await (await JSZip.loadAsync(orig)).file('h5p.json').async('string'));
    await expectIssue(h5p, await withH5p(async (hz) => { const j = JSON.parse(JSON.stringify(hj)); j.preloadedDependencies[0].minorVersion += 7; hz.file('h5p.json', JSON.stringify(j)); }), 'H5P_LIBRARIES', /perfil v3/, 'versión de la principal');
    await expectIssue(h5p, await withH5p(async (hz) => { const j = JSON.parse(JSON.stringify(hj)); j.preloadedDependencies.push({ machineName: 'H5P.NoEnElPack', majorVersion: 9, minorVersion: 9 }); hz.file('h5p.json', JSON.stringify(j)); }), 'H5P_LIBRARIES', /fuera del perfil/, 'dependencia fuera del pack');
    await expectIssue(h5p, await withH5p((hz) => { hz.remove('content/content.json'); }), 'H5P_FILES', /content\.json/, 'sin content.json');
    await expectIssue(h5p, await withH5p((hz) => { hz.file('content/content.json', '{roto'); }), 'H5P_FILES', /JSON válido/, 'content.json roto');
  });

  await check('I6 bancos: filtercondition 4.3+, una pregunta menos en una hoja, una referencia de más → QUIZ_RANDOM', async () => {
    const z0 = await JSZip.loadAsync(bank.mbz);
    const quiz = (await actsOf(z0)).find((a) => a.mod === 'quiz');
    await expectIssue(bank, await mutate(bank.mbz, (z) => edit(z, `${quiz.dir}/quiz.xml`, (x) => x.replace(/\{"questioncategoryid":(\d+),"includingsubcategories":0\}/, (m, id) => `{"filter":{"category":{"values":[${id}]}}}`))), 'QUIZ_RANDOM', /4\.3\+/, 'formato 4.3+');
    await expectIssue(bank, await mutate(bank.mbz, (z) => edit(z, 'questions.xml', (x) => x.replace(/<question_bank_entry id="\d+">[\s\S]*?<\/question_bank_entry>/, ''))), 'QUIZ_RANDOM', /preguntas/, 'pregunta de menos');
    await expectIssue(bank, await mutate(bank.mbz, (z) => edit(z, `${quiz.dir}/quiz.xml`, (x) => x.replace(/<maxmark>([0-9.]+)<\/maxmark>/, (m, n) => `<maxmark>${(Number(n) + 1).toFixed(7)}</maxmark>`))), 'QUIZ_RANDOM', /maxmark/, 'Σ maxmark');
  });

  await check('I7 Tarea: nota de la Tarea ≠ perfil y rúbrica faltante → APPLICATION / RUBRIC', async () => {
    const z0 = await JSZip.loadAsync(app.mbz);
    const asg = (await actsOf(z0)).find((a) => a.mod === 'assign');
    await expectIssue(app, await mutate(app.mbz, (z) => edit(z, `${asg.dir}/assign.xml`, (x) => x.replace('<grade>100</grade>', '<grade>50</grade>'))), 'APPLICATION', null, 'nota');
    await expectIssue(app, await mutate(app.mbz, (z) => z.remove(`${asg.dir}/grading.xml`)), 'RUBRIC', null, 'rúbrica');
  });

  await check('I8 presupuesto de tamaño: entorno, veredictos, lo más pesado, códigos clasificados como config retenida', async () => {
    eq(SZ.packageSizeLimitsFromEnv({}), { warnBytes: null, maxBytes: null }, 'sin variables = solo medir');
    eq(SZ.packageSizeLimitsFromEnv({ PACKAGE_MBZ_MAX_BYTES: '52428800' }), { warnBytes: 47185920, maxBytes: 52428800 }, 'aviso por defecto = 90 %');
    eq(SZ.packageSizeLimitsFromEnv({ PACKAGE_MBZ_WARN_BYTES: '1000' }), { warnBytes: 1000, maxBytes: null }, 'solo aviso');
    for (const env of [{ PACKAGE_MBZ_MAX_BYTES: '50MB' }, { PACKAGE_MBZ_MAX_BYTES: '0' }, { PACKAGE_MBZ_WARN_BYTES: '-1' }, { PACKAGE_MBZ_WARN_BYTES: '20', PACKAGE_MBZ_MAX_BYTES: '10' }]) {
      let err = null;
      try { SZ.packageSizeLimitsFromEnv(env); } catch (e) { err = e.message; }
      assert(err && err.startsWith('PACKAGE_SIZE_CONFIG_INVALID:'), `${JSON.stringify(env)} → ${err}`);
    }
    const total = h5p.mbz.length;
    const free = await SZ.packageSizeBudget(h5p.mbz, { warnBytes: null, maxBytes: null });
    eq([free.error, free.warnings, free.stats.totalBytes], [null, [], total], 'sin límites');
    assert(free.stats.largest.length === SZ.PACKAGE_SIZE_TOP_FILES && free.stats.largest[0].bytes >= free.stats.largest[1].bytes, 'top ordenado');
    assert(free.stats.largest.some((x) => x.filename && /\.(h5p|pdf|mp3|png)$/.test(x.filename)), `blobs con nombre: ${JSON.stringify(free.stats.largest.slice(0, 3))}`);
    const warn = await SZ.packageSizeBudget(h5p.mbz, { warnBytes: total - 1, maxBytes: null });
    eq([warn.error, warn.warnings], [null, [`package_size_over_warn:${total}:${total - 1}`]], 'aviso');
    eq((await SZ.packageSizeBudget(h5p.mbz, { warnBytes: total, maxBytes: total })).warnings, [], 'en el límite exacto: cabe, sin aviso');
    const over = await SZ.packageSizeBudget(h5p.mbz, { warnBytes: null, maxBytes: total - 1 });
    assert(/^PACKAGE_SIZE_LIMIT_EXCEEDED: el paquete pesa \d+ bytes .*Lo más pesado: /.test(over.error || ''), over.error);
    for (const msg of [over.error, 'PACKAGE_SIZE_CONFIG_INVALID: PACKAGE_MBZ_MAX_BYTES="x"']) {
      const r = FC.classifyFailure({ error: msg, source: 'package_worker' });
      eq([r.class, r.strategy, r.humanReason, r.unclassified], ['D', 'hold_for_human', 'config', false], `clasificación de «${msg.slice(0, 40)}»`);
    }
    const mc = FC.classifyFailure({ error: 'MBZ_V3_VALIDATION_FAILED: 1 hallazgo(s): MANIFEST_COVERAGE cv3:ch:x:video: capítulo 1', source: 'package_worker' });
    eq([mc.class, mc.humanReason], ['D', 'product_bug'], 'MANIFEST_COVERAGE = bug de producto');
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
