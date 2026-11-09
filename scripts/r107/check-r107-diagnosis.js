#!/usr/bin/env node
/* eslint-disable */
// r107 B3 — diagnóstico técnico del Taller de cursos (T01–T12, hallazgos, semáforo, arreglo sugerido), contra el código
// COMPILADO (dist/). Sin red, sin IA, sin base, USD 0. Nada se escribe a disco (salvo --bite, que copia dist/ a un
// directorio temporal para romperlo a propósito).
//
//   D1 cada DAÑADO produce EXACTAMENTE su falla sembrada (check + destino del manifiesto) y ningún otro error / aviso que
//      no esté ya en su base (comparación por id estable del hallazgo)
//   D2 sintéticos sanos → verde (0 error, 0 warning), sin y CON expectativas (validador v3 completo)
//   D3 reales (--corpus): 0 excepciones; hallazgos por familia
//   D4 determinismo: el mismo paquete dos veces → el mismo informe byte a byte
//   D5 semáforo: reglas de agregación (rojo ⇐ error, amarillo ⇐ solo warning, verde; info no cuenta) por actividad,
//      capítulo y curso, sobre conjuntos armados y sobre informes reales
//   D6 estado de cada check: corrió / no aplica (con motivo) / T12 diferido; tabla por familia completa
//   D7 forma del hallazgo: id estable, título sin jerga, evidencia, arreglo del catálogo cerrado (o null)
//   D8 V1 mínimo armado acá (Libro HTML, SCORM, hvp, audiolibro, examen): sano → verde; cada falla V1 → su check
//   D9 validador v3 sin expectativas: lo que reporta queda dentro de un hallazgo (corroboración) o como T11 propio
//
//   --census <survey.json> (local): todo el censo; 0 excepciones; defectos reales conocidos con su check (Libro Guía →
//      label, `$&` roto, tokens external, huérfanos); semáforo por familia y los 10 hallazgos más frecuentes
//   --bite: rompe a propósito T02 y el semáforo en una copia de dist/ y confirma que --ci FALLA
//
// Usage:
//   node scripts/r107/check-r107-diagnosis.js --corpus [manifest.json|dir]   (local: corpus de B0)
//   node scripts/r107/check-r107-diagnosis.js --ci                            (CI: sintéticos + dañados generados acá)
//   node scripts/r107/check-r107-diagnosis.js --census <survey.json>          (local: todo el censo real)
//   node scripts/r107/check-r107-diagnosis.js --bite                          (local: las aserciones muerden)
//   [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const CI = has('--ci');
const BITE = has('--bite');
const CENSUS = has('--census') ? arg('--census', path.join(os.homedir(), 'cursia-test-env/work/r107/survey/survey.json')) : null;
const DEFAULT_CORPUS = path.join(os.homedir(), 'cursia-test-env/work/r107/corpus/manifest.json');
if (!CI && !CENSUS && !BITE && !has('--corpus')) { console.error('Usage: --corpus [manifest.json|dir] | --ci | --census <survey.json> | --bite  [--dist dist]'); process.exit(2); }
let corpusArg = CI || CENSUS || BITE ? null : arg('--corpus', DEFAULT_CORPUS);
if (corpusArg && fs.existsSync(corpusArg) && fs.statSync(corpusArg).isDirectory()) corpusArg = path.join(corpusArg, 'manifest.json');

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
let stable = (v) => JSON.stringify(v);
const eqS = (a, b, m) => { const x = stable(a); const y = stable(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ── --bite: las aserciones muerden ──────────────────────────────────────────────────────────────────────────────────
if (BITE) {
  const patches = [
    { name: 'T02 apagado (no devuelve hallazgos)', file: 'modules/course-workshop/diagnosis/checks.js', from: 'run: t02 }', to: 'run: () => [] }', expect: /blob-missing/ },
    { name: 'el semáforo nunca se pone rojo', file: 'modules/course-workshop/diagnosis/diagnose.js', from: "return 'red';", to: "return 'yellow';", expect: /D5/ },
    { name: 'T10 apagado (no devuelve hallazgos)', file: 'modules/course-workshop/diagnosis/checks.js', from: 'run: t10 }', to: 'run: () => [] }', expect: /exam-no-correct/ },
    { name: 'T04 trata «external» como ok', file: 'modules/course-workshop/diagnosis/checks.js', from: "if (t.status === 'external') {", to: "if (false) {", expect: /token-external/ },
  ];
  let bad = 0;
  for (const p of patches) {
    // La copia va DENTRO del repo (y se borra al terminar): el builder lee assets/ relativo a dist/.. y los require
    // resuelven contra node_modules del repo.
    const tmp = fs.mkdtempSync(path.join(REPO, '.r107-bite-'));
    try {
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, p.file);
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes(p.from)) { console.log(`❌ bite «${p.name}»: no encontré el texto a romper en ${p.file}`); bad++; continue; }
      fs.writeFileSync(f, src.split(p.from).join(p.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const failed = r.status !== 0 && p.expect.test((r.stdout || '').split('\n').filter((l) => l.startsWith('❌')).join('\n'));
      console.log(`${failed ? '✅' : '❌'} bite «${p.name}»: --ci ${r.status !== 0 ? 'falla' : 'PASA (no muerde)'} — ${(r.stdout || '').split('\n').filter((l) => l.startsWith('❌')).slice(0, 2).join(' | ') || (r.stderr || '').slice(0, 300)}`);
      if (!failed) bad++;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`\n${bad ? '❌' : '✅'} check-r107-diagnosis --bite: ${patches.length - bad}/${patches.length} rupturas detectadas`);
  process.exit(bad ? 1 : 0);
}

const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const R = L('modules/course-workshop/mbz-reader.js');
const I = L('modules/course-workshop/identify.js');
const DG = L('modules/course-workshop/diagnosis/index.js');
const M = L('modules/course-workshop/course-model.js');
const BC = require(path.join(REPO, 'scripts/r107/build-corpus.js'));
stable = (v) => M.stableStringify(v);
const JSZip = require('jszip');

function spyWrites() {
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdtempSync', 'mkdirSync', 'copyFileSync', 'renameSync'];
  const saved = {};
  const calls = [];
  for (const n of names) { saved[n] = fs[n]; fs[n] = function (...a) { calls.push(`${n}(${String(a[0]).slice(0, 80)})`); return saved[n].apply(fs, a); }; }
  return () => { for (const n of names) fs[n] = saved[n]; return calls; };
}

async function diagnose(buf, filename, opts = {}) {
  const pkg = await R.openMbz(buf);
  const facts = await I.readPackageFacts(pkg, filename);
  return DG.runTechnicalDiagnosis({ pkg, packageBytes: buf, family: I.familyOf(facts), builderLine: I.builderLineOf(facts), builderVersion: null, expectations: opts.expectations ?? null, expectationsReason: opts.expectations ? null : 'prueba sin expectativas' });
}

/** ¿El hallazgo es el del destino del manifiesto? `question/N`, `component/filearea/filename`, `component/filename`, o carpeta. */
function matchesTarget(f, target) {
  const q = /^question\/(\d+)$/.exec(target);
  if (q) return f.evidence.questionId === Number(q[1]);
  if (target.includes('/')) {
    const e = f.evidence.file;
    if (!e) return false;
    return `${e.component}/${e.filearea}/${e.filename}` === target || `${e.component}/${e.filename}` === target;
  }
  return !!f.scope.activity && f.scope.activity.dir === `activities/${target}`;
}
const visible = (r) => r.findings.filter((x) => x.severity !== 'info');
const fmt = (x) => `${x.check}/${x.code}@${x.scope.activity ? x.scope.activity.dir : 'curso'}${x.evidence.questionId ? `#q${x.evidence.questionId}` : ''}`;

/** D1: el dañado vs su base — exactamente un hallazgo nuevo (error/warning), del check y destino esperados. */
function exactlySeeded(dmg, base, exp) {
  const baseIds = new Set(visible(base).map((x) => x.id));
  const added = visible(dmg).filter((x) => !baseIds.has(x.id));
  if (added.length !== 1) throw new Error(`esperaba 1 hallazgo nuevo (${exp.check} ${exp.target}), hay ${added.length}: ${added.map(fmt).join(', ') || '(ninguno)'}`);
  const x = added[0];
  if (x.check !== exp.check || !matchesTarget(x, exp.target)) throw new Error(`esperaba ${exp.check} en ${exp.target}, vino ${fmt(x)}`);
  return x;
}

// ── V1 mínimo (CI): bienvenida + audiolibro + Libro Guía HTML + 2 capítulos (página, hvp, SCORM) + examen ──────────────
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LIBRO_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Libro</title></head><body><h1>Libro Guía</h1>'
  + '<h1>Capítulo 1: Primero</h1><p>Contenido del primero.</p><h1>Capítulo 2: Segundo</h1><p>Contenido del segundo.</p></body></html>';
const MANIFEST = (n) => `<?xml version="1.0" encoding="UTF-8"?><manifest identifier="cap${n}_juego" version="1.2"><organizations default="o"><organization identifier="o"><title>Cap ${n}</title><item identifier="i" identifierref="r"><title>Juego</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" href="index.html"><file href="index.html"/></resource></resources></manifest>`;
const GAME = (n) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Juego ${n}</title></head><body><div id="g"></div><script>window.salas=[1,2,3];</script></body></html>`;
const HVP_JSON = (n, video = true) => JSON.stringify({ interactiveVideo: { video: { files: video ? [{ path: `https://www.youtube.com/watch?v=abc${n}`, mime: 'video/YouTube' }] : [], startScreenOptions: {} }, assets: { interactions: [
  { action: { library: 'H5P.MultiChoice 1.16', params: { question: '<p>¿Qué?</p>', answers: [{ text: 'Sí', correct: true }, { text: 'No', correct: false }], behaviour: { type: 'auto' } } } },
] } } });

async function miniV1(audioMp3) {
  const z = new JSZip();
  const acts = []; // [mid, modname, title, html, files[], extraXml]
  let ctx = 100;
  const files = [];
  let fileId = 1;
  const addFile = (mid, ctxId, component, filearea, filename, buf, mimetype) => {
    const h = sha1(buf);
    z.file(`files/${h.slice(0, 2)}/${h}`, buf);
    files.push(`<file id="${fileId++}"><contenthash>${h}</contenthash><contextid>${ctxId}</contextid><component>${component}</component><filearea>${filearea}</filearea><itemid>0</itemid><filepath>/</filepath><filename>${esc(filename)}</filename><userid>$@NULL@$</userid><filesize>${buf.length}</filesize><mimetype>${mimetype}</mimetype><status>0</status><timecreated>1</timecreated><timemodified>1</timemodified><source>$@NULL@$</source><author>$@NULL@$</author><license>$@NULL@$</license><sortorder>0</sortorder><repositorytype>$@NULL@$</repositorytype><repositoryid>$@NULL@$</repositoryid><reference>$@NULL@$</reference></file>`);
  };
  const act = (mid, mod, title, html, sec, extra = '') => { acts.push({ mid, mod, title, html, sec, ctx: ++ctx, extra }); return ctx; };
  act(901, 'label', '🏠 Bienvenida al Curso', '<p style="color:#000">Bienvenidos al curso. <a href="$@RESOURCEVIEWBYID*903@$">Abrir el Libro Guía</a></p>', 0);
  const cAudio = act(902, 'label', '📻 Audiolibro del Curso', '<p>Escucha el audiolibro.</p><audio controls><source src="@@PLUGINFILE@@/audiolibro.mp3" type="audio/mpeg"></audio>', 1);
  addFile(902, cAudio, 'mod_label', 'intro', 'audiolibro.mp3', audioMp3, 'audio/mpeg');
  const cLibro = act(903, 'resource', '📚 Libro Guía Completo', '<p>El libro del curso.</p>', 1);
  addFile(903, cLibro, 'mod_resource', 'content', 'libro_guia_completo.html', Buffer.from(LIBRO_HTML), 'text/html');
  for (const n of [1, 2]) {
    const base = 900 + n * 10;
    act(base, 'label', `▶️ Cap. ${n} — Video: Tema ${n}`, `<p>MÓDULO 1 · CAPÍTULO ${n}</p><p>📺 Instrucciones: mira el video.</p>`, 1 + n);
    act(base + 1, 'hvp', `🎥 Video Interactivo Cap ${n} — Tema ${n}`, `<p>Video del capítulo ${n}. <a href="$@SCORMVIEWBYID*${base + 2}@$">Practicar</a></p>`, 1 + n, `<json_content>${esc(HVP_JSON(n))}</json_content>`);
    const cS = act(base + 2, 'scorm', `🎮 Actividad Interactiva Cap ${n} — Tema ${n}`, '<p>Juego.</p>', 1 + n, '<reference>scorm.zip</reference>');
    addFile(base + 2, cS, 'mod_scorm', 'content', 'imsmanifest.xml', Buffer.from(MANIFEST(n)), 'application/xml');
    addFile(base + 2, cS, 'mod_scorm', 'content', 'index.html', Buffer.from(GAME(n)), 'text/html');
  }
  const cQuiz = act(930, 'quiz', '📝 Examen Unidad 1', '<p>Examen.</p>', 4, '<question_instances><question_instance id="1"><slot>1</slot><questionid>5001</questionid></question_instance><question_instance id="2"><slot>2</slot><questionid>5002</questionid></question_instance></question_instances>');
  const qmc = `<question id="5001"><parent>0</parent><name>Q1</name><questiontext>&lt;p&gt;¿Cuánto es 2 + 2?&lt;/p&gt;</questiontext><qtype>multichoice</qtype><plugin_qtype_multichoice_question><answers>`
    + [['4', '1.0000000'], ['3', '0.0000000'], ['5', '0.0000000']].map(([t, fr], i) => `<answer id="${6001 + i}"><answertext>${t}</answertext><answerformat>0</answerformat><fraction>${fr}</fraction><feedback></feedback></answer>`).join('')
    + `</answers><multichoice id="1"><single>1</single></multichoice></plugin_qtype_multichoice_question></question>`;
  const qtf = `<question id="5002"><parent>0</parent><name>Q2</name><questiontext>&lt;p&gt;El agua moja.&lt;/p&gt;</questiontext><qtype>truefalse</qtype><plugin_qtype_truefalse_question><answers><answer id="6101"><answertext>Verdadero</answertext><fraction>1.0000000</fraction></answer><answer id="6102"><answertext>Falso</answertext><fraction>0.0000000</fraction></answer></answers></plugin_qtype_truefalse_question></question>`;
  z.file('questions.xml', `<?xml version="1.0" encoding="UTF-8"?><question_categories><question_category id="70"><name>Examen Unidad 1</name><contextid>${cQuiz}</contextid><contextlevel>70</contextlevel><contextinstanceid>930</contextinstanceid><questions>${qmc}${qtf}</questions></question_category></question_categories>`);
  const secs = [0, 1, 2, 3, 4];
  z.file('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?><moodle_backup><information><name>curso-v1-minimo.mbz</name><moodle_release>4.1</moodle_release><original_course_id>5</original_course_id><original_course_contextid>50</original_course_contextid><original_course_fullname>Curso V1 mínimo</original_course_fullname><contents><activities>`
    + acts.map((a) => `<activity><moduleid>${a.mid}</moduleid><sectionid>${10 + a.sec}</sectionid><modulename>${a.mod}</modulename><title>${esc(a.title)}</title><directory>activities/${a.mod}_${a.mid}</directory></activity>`).join('')
    + `</activities><sections>${secs.map((n) => `<section><sectionid>${10 + n}</sectionid><title>Sección ${n}</title><directory>sections/section_${10 + n}</directory></section>`).join('')}</sections></contents></information></moodle_backup>`);
  z.file('course/course.xml', '<course id="5" contextid="50"><summary></summary></course>');
  for (const n of secs) z.file(`sections/section_${10 + n}/section.xml`, `<section id="${10 + n}"><number>${n}</number><name>${n === 0 ? 'Bienvenida' : n === 1 ? 'Recursos' : n === 4 ? 'Evaluación' : `Capítulo ${n - 1}`}</name><summary></summary><sequence>${acts.filter((a) => a.sec === n).map((a) => a.mid).join(',')}</sequence><visible>1</visible></section>`);
  for (const a of acts) {
    z.file(`activities/${a.mod}_${a.mid}/module.xml`, `<module id="${a.mid}"><modulename>${a.mod}</modulename><sectionid>${10 + a.sec}</sectionid><sectionnumber>${a.sec}</sectionnumber><idnumber></idnumber><visible>1</visible></module>`);
    z.file(`activities/${a.mod}_${a.mid}/${a.mod}.xml`, `<activity id="${a.mid - 800}" moduleid="${a.mid}" modulename="${a.mod}" contextid="${a.ctx}"><${a.mod} id="${a.mid - 800}"><name>${esc(a.title)}</name><intro>${esc(a.html)}</intro>${a.extra}</${a.mod}></activity>`);
  }
  z.file('files.xml', `<?xml version="1.0" encoding="UTF-8"?><files>${files.join('')}</files>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Mutaciones propias de B3 (además de las de B0): cada una = (zip) → falla esperada { check, target }. */
const B3_MUTATIONS = {
  async 'token-external'(zip) {
    const dir = await injectLabel(zip, '<p><a href="$@COURSEVIEWBYID*424242@$">Ir al otro curso</a></p>');
    return { check: 'T04', target: dir };
  },
  async 'token-malformed'(zip) {
    // El bug de `$&` (changelog #1): el `$` final del token se pierde → `$@KIND*id@` que Moodle deja literal.
    const dir = await injectLabel(zip, '<p><a href="$@QUIZVIEWBYID*12@">Ir</a></p>');
    return { check: 'T04', target: dir };
  },
  async 'exam-many-correct'(zip) {
    let xml = await zip.file('questions.xml').async('string');
    let qid = null;
    for (const m of xml.matchAll(/<question id="(\d+)">([\s\S]*?)<\/question>/g)) {
      if (!/<qtype>multichoice<\/qtype>/.test(m[2]) || !/<single>1<\/single>/.test(m[2])) continue;
      qid = m[1];
      let k = 0;
      xml = xml.replace(m[0], m[0].replace(/<fraction>[^<]*<\/fraction>/g, (f) => (k++ < 2 ? '<fraction>1.0000000</fraction>' : f)));
      break;
    }
    zip.file('questions.xml', xml);
    return qid ? { check: 'T10', target: `question/${qid}` } : null;
  },
  async 'exam-fraction-sum'(zip) {
    let xml = await zip.file('questions.xml').async('string');
    let qid = null;
    for (const m of xml.matchAll(/<question id="(\d+)">([\s\S]*?)<\/question>/g)) {
      if (!/<qtype>multichoice<\/qtype>/.test(m[2]) || !/<single>1<\/single>/.test(m[2])) continue;
      qid = m[1];
      let k = 0;
      xml = xml.replace(m[0], m[0].replace('<single>1</single>', '<single>0</single>').replace(/<fraction>[^<]*<\/fraction>/g, () => (k++ === 0 ? '<fraction>0.5000000</fraction>' : k === 2 ? '<fraction>0.3000000</fraction>' : '<fraction>0.0000000</fraction>')));
      break;
    }
    zip.file('questions.xml', xml);
    return qid ? { check: 'T10', target: `question/${qid}` } : null;
  },
};
async function injectLabel(zip, html) {
  const dirs = [];
  zip.forEach((p) => { const m = /^activities\/(label_\d+)\/label\.xml$/.exec(p); if (m) dirs.push(m[1]); });
  dirs.sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  for (const d of dirs) {
    const p = `activities/${d}/label.xml`;
    const xml = await zip.file(p).async('string');
    if (!/<intro>[^<]{20,}<\/intro>/.test(xml)) continue;
    zip.file(p, xml.replace(/<intro>/, () => '<intro>' + esc(html)));
    return d;
  }
  throw new Error('sin label');
}

/** Mutaciones V1 propias (sobre el V1 mínimo). */
const V1_MUTATIONS = {
  async 'scorm-no-manifest'(zip) {
    const files = await zip.file('files.xml').async('string');
    const blk = /<file id="\d+">(?:(?!<\/file>)[\s\S])*<component>mod_scorm<\/component>(?:(?!<\/file>)[\s\S])*<filename>imsmanifest\.xml<\/filename>[\s\S]*?<\/file>/.exec(files)[0];
    const h = /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(blk)[1];
    zip.file('files.xml', files.replace(blk, ''));
    zip.remove(`files/${h.slice(0, 2)}/${h}`);
    return { check: 'T06', target: 'scorm_912' };
  },
  async 'hvp-no-video'(zip) {
    const p = 'activities/hvp_911/hvp.xml';
    zip.file(p, (await zip.file(p).async('string')).replace(/<json_content>[\s\S]*?<\/json_content>/, () => `<json_content>${esc(HVP_JSON(1, false))}</json_content>`));
    return { check: 'T09', target: 'hvp_911' };
  },
  async 'hvp-question-no-correct'(zip) {
    const p = 'activities/hvp_921/hvp.xml';
    zip.file(p, (await zip.file(p).async('string')).replace(/&quot;correct&quot;:true/, '&quot;correct&quot;:false'));
    return { check: 'T09', target: 'hvp_921' };
  },
  async 'libro-missing-chapter'(zip) {
    const files = await zip.file('files.xml').async('string');
    const h = /<contenthash>([0-9a-f]{40})<\/contenthash>(?:(?!<\/file>)[\s\S])*<filename>libro_guia_completo\.html<\/filename>/.exec(files)[1];
    const nb = Buffer.from(LIBRO_HTML.replace(/<h1>Capítulo 2: Segundo<\/h1><p>Contenido del segundo\.<\/p>/, ''));
    const nh = sha1(nb);
    zip.remove(`files/${h.slice(0, 2)}/${h}`);
    zip.file(`files/${nh.slice(0, 2)}/${nh}`, nb);
    zip.file('files.xml', files.replace(`<contenthash>${h}</contenthash>`, `<contenthash>${nh}</contenthash>`).replace(new RegExp(`(<contenthash>${nh}</contenthash>[\\s\\S]*?<filesize>)\\d+`), (_m, a) => `${a}${nb.length}`));
    return { check: 'T07', target: 'mod_resource/content/libro_guia_completo.html' };
  },
  async 'audiobook-short'(zip) {
    // Solo los primeros frames del MP3 (sin el frame Xing): suena, pero dura segundos para 2 capítulos.
    const files = await zip.file('files.xml').async('string');
    const h = /<contenthash>([0-9a-f]{40})<\/contenthash>(?:(?!<\/file>)[\s\S])*<filename>audiolibro\.mp3<\/filename>/.exec(files)[1];
    const b = await zip.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
    const short = b.subarray(0, Math.min(b.length, 4096));
    const nb = Buffer.concat([short]);
    const nh = sha1(nb);
    zip.remove(`files/${h.slice(0, 2)}/${h}`);
    zip.file(`files/${nh.slice(0, 2)}/${nh}`, nb);
    zip.file('files.xml', files.replace(`<contenthash>${h}</contenthash>`, `<contenthash>${nh}</contenthash>`).replace(new RegExp(`(<contenthash>${nh}</contenthash>[\\s\\S]*?<filesize>)\\d+`), (_m, a) => `${a}${nb.length}`));
    return { check: 'T08', target: 'label_902' };
  },
};

/** MP3 «largo» sintético: el audiolibro del v3 A-S (motor de la simulación, sin red). */
async function audiobookOf(v3buf) {
  const z = await JSZip.loadAsync(v3buf);
  const files = await z.file('files.xml').async('string');
  const blks = [...files.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].map((m) => m[1]).filter((b) => /<filename>[^<]*\.mp3<\/filename>/.test(b));
  let best = null;
  for (const b of blks) { const h = /<contenthash>([0-9a-f]{40})/.exec(b)[1]; const buf = await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer'); if (!best || buf.length > best.length) best = buf; }
  return best;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ciFixtures() {
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const synth = [];
  let base = null;
  for (const id of ['A-S', 'ofimatica', '1x1-sin-examenes']) {
    const sim = await S.simulateCourse(DIST, COURSES.find((c) => c.id === id));
    synth.push({ id: `synthetic:v3-${id}`, family: 'v2-dynamic', filename: `v3-${id}.mbz`, buf: sim.built.mbz, expectations: sim.built.expectations });
    if (id === 'A-S') base = sim.built.mbz;
  }
  const damaged = [];
  const gen = async (from, baseId, muts, table) => {
    for (const name of muts) {
      const zip = await JSZip.loadAsync(from);
      const exp = await table[name](zip);
      if (!exp) { damaged.push({ id: `${baseId}~${name}`, skipped: true }); continue; }
      damaged.push({ id: `${baseId}~${name}`, base: baseId, filename: `${baseId}~${name}.mbz`, buf: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), expected: { check: exp.check, target: exp.target } });
    }
  };
  await gen(base, 'v3-A-S', ['blob-missing', 'blob-altered', 'orphan-token', 'wrong-type-token', 'duplicate-moduleid', 'listed-missing-folder', 'pending-placeholder', 'empty-label', 'exam-no-correct', 'libro-pdf-truncated'], BC.MUTATIONS);
  await gen(base, 'v3-A-S', Object.keys(B3_MUTATIONS), B3_MUTATIONS);
  const v1 = await miniV1(await audiobookOf(base));
  await gen(v1, 'v1-min', ['blob-missing', 'blob-altered', 'orphan-token', 'wrong-type-token', 'pending-placeholder', 'exam-no-correct', 'libro-html-truncated', 'scorm-pending'], BC.MUTATIONS);
  await gen(v1, 'v1-min', Object.keys(V1_MUTATIONS), V1_MUTATIONS);
  return { synth, damaged, bases: { 'v3-A-S': { buf: base, filename: 'v3-A-S.mbz' }, 'v1-min': { buf: v1, filename: 'curso-v1-minimo.mbz' } }, real: [] };
}
function corpusFixtures(manifestPath) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fx = man.fixtures.filter((f) => !f.skipped);
  const load = (f) => fs.readFileSync(f.path);
  const synth = fx.filter((f) => f.source === 'synthetic').map((f) => ({ id: f.id, family: f.family, filename: path.basename(f.path), buf: load(f), expectations: JSON.parse(fs.readFileSync(f.path.replace(/\.mbz$/, '.expectations.json'), 'utf8')) }));
  const bases = { 'v3-A-S': { buf: synth.find((s) => s.id === 'synthetic:v3-A-S').buf, filename: 'v3-A-S.mbz' } };
  if (man.v1DamageBase) bases[`v1-${man.v1DamageBase.sha1.slice(0, 8)}`] = { buf: fs.readFileSync(man.v1DamageBase.path), filename: path.basename(man.v1DamageBase.path) };
  const damaged = fx.filter((f) => f.source === 'damaged').map((f) => ({ id: f.id, base: f.base, filename: path.basename(f.path), buf: load(f), expected: f.expectedDefects[0] }));
  const real = fx.filter((f) => f.source === 'real').map((f) => ({ id: f.id, family: f.family, filename: path.basename(f.path), path: f.path }));
  return { synth, damaged, bases, real };
}

// ── --census ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function censusMode(surveyPath) {
  const recs = JSON.parse(fs.readFileSync(surveyPath, 'utf8')).filter((r) => !r.duplicateOf);
  console.log(`  modo censo: ${surveyPath} — ${recs.length} paquetes únicos`);
  const fam = {};
  const rejected = [];
  const errors = [];
  const freq = new Map();
  const known = { libroLabel: [], malformed: [], external: [], orphan: [], missedTokens: [] };
  let maxMs = 0;
  let maxFile = '';
  const unspy = spyWrites();
  try {
    for (const r of recs) {
      const name = path.basename(r.file);
      let buf;
      let pkg;
      try { buf = fs.readFileSync(r.file); pkg = await R.openMbz(buf); } catch (e) { if (R.isMbzReaderError(e)) rejected.push(`${name}: ${e.code}`); else errors.push(`${name}: ${e && e.stack}`); continue; }
      try {
        const facts = await I.readPackageFacts(pkg, name);
        const family = I.familyOf(facts);
        const t0 = Date.now();
        const rep = await DG.runTechnicalDiagnosis({ pkg, packageBytes: buf, family, builderLine: I.builderLineOf(facts), builderVersion: null });
        const ms = Date.now() - t0;
        if (ms > maxMs) { maxMs = ms; maxFile = name; }
        const f = (fam[family] ||= { packages: 0, red: 0, yellow: 0, green: 0, findings: { error: 0, warning: 0, info: 0 }, byCheck: {} });
        f.packages++; f[rep.light.course]++;
        for (const k of ['error', 'warning', 'info']) f.findings[k] += rep.counts.total[k];
        for (const [id, c] of Object.entries(rep.counts.byCheck)) { const b = (f.byCheck[id] ||= { error: 0, warning: 0, info: 0, packages: 0 }); for (const k of ['error', 'warning', 'info']) b[k] += c[k]; if (c.error + c.warning) b.packages++; }
        const seenHere = new Set();
        for (const x of rep.findings) {
          const k = `${x.check}/${x.code}/${x.severity}`;
          const e = freq.get(k) || { n: 0, packages: 0, samples: [], titles: [] };
          e.n++;
          if (!seenHere.has(k)) { e.packages++; seenHere.add(k); if (e.samples.length < 4) e.samples.push(`${family} | ${name}`); }
          if (e.titles.length < 2) e.titles.push(x.title.slice(0, 150));
          freq.set(k, e);
        }
        // Defectos reales conocidos (B2): Libro Guía → label, `$&` roto, external, huérfanos/mal tipados.
        const t04 = rep.findings.filter((x) => x.check === 'T04');
        if (t04.some((x) => x.code === 'token_wrong_type' && /RESOURCEVIEWBYID/.test(x.evidence.token || '') && /Libro Guía/.test(x.title))) known.libroLabel.push(name);
        if (t04.some((x) => x.code === 'token_malformed')) known.malformed.push(name);
        if (t04.some((x) => x.code === 'token_external')) known.external.push(name);
        if (t04.some((x) => x.code === 'token_orphan' || x.code === 'token_wrong_type')) known.orphan.push(name);
        // Cruce con el inventario: todo token no ok del inventario tiene su hallazgo T04.
        const inv = await (L('modules/course-workshop/inventory.js')).buildInventory(pkg, { family, builderLine: I.builderLineOf(facts) });
        const st = inv.stats.tokens;
        const want = { token_orphan: st.orphan, token_wrong_type: st.wrong_type, token_malformed: st.malformed, token_external: st.external };
        for (const [code, n] of Object.entries(want)) if (n > 0 && !t04.some((x) => x.code === code)) known.missedTokens.push(`${name}: ${code} (${n} en el inventario)`);
      } catch (e) {
        if (e instanceof I.PackageFactsError) rejected.push(`${name}: ${e.code}`); else errors.push(`${name}: ${e && e.stack}`);
      }
    }
  } finally {
    const calls = unspy();
    if (calls.length) errors.push(`escribió a disco: ${calls.slice(0, 3).join(', ')}`);
  }
  console.log('\n   Semáforo del curso por familia (rojo / amarillo / verde) y hallazgos (error / warning / info):');
  for (const [k, f] of Object.entries(fam).sort()) console.log(`   ${k.padEnd(16)} ${String(f.packages).padStart(3)} paquetes · 🔴 ${f.red} · 🟡 ${f.yellow} · 🟢 ${f.green} · hallazgos ${f.findings.error}/${f.findings.warning}/${f.findings.info}`);
  console.log('\n   Conteo por check y familia (error/warning/info · paquetes con error o warning):');
  for (const [k, f] of Object.entries(fam).sort()) console.log(`   ${k.padEnd(16)} ${DG.CHECK_IDS.map((id) => { const b = f.byCheck[id] || { error: 0, warning: 0, info: 0, packages: 0 }; return `${id} ${b.error}/${b.warning}/${b.info}·${b.packages}`; }).join('  ')}`);
  console.log('\n   Todos los códigos (error / warning) — paquetes · total:');
  console.log('   ' + [...freq.entries()].filter(([k]) => !k.endsWith('/info')).sort((a, b) => b[1].packages - a[1].packages).map(([k, e]) => `${k} ${e.packages}·${e.n}`).join(' · '));
  const top = [...freq.entries()].filter(([k]) => !k.endsWith('/info')).sort((a, b) => b[1].packages - a[1].packages || b[1].n - a[1].n).slice(0, 10);
  console.log('\n   Los 10 hallazgos (error / warning) más frecuentes — paquetes · total · ejemplos:');
  for (const [k, e] of top) console.log(`   ${k.padEnd(42)} ${String(e.packages).padStart(3)} paq · ${String(e.n).padStart(4)} · ${e.samples.slice(0, 3).join(' ; ')}\n      «${e.titles[0]}»`);
  const topInfo = [...freq.entries()].filter(([k]) => k.endsWith('/info')).sort((a, b) => b[1].packages - a[1].packages).slice(0, 6);
  console.log('\n   info más frecuentes: ' + topInfo.map(([k, e]) => `${k} (${e.packages} paq)`).join(' · '));
  console.log(`\n   Defectos conocidos: Libro Guía → label en ${known.libroLabel.length} paquete(s) · token roto (\`$&\`) en ${known.malformed.length} · enlaces a otro curso (external) en ${known.external.length} · huérfanos / mal tipados en ${known.orphan.length}`);
  console.log(`   paquete más lento: ${maxFile} (${maxMs} ms) · rechazos tipados del lector: ${rejected.length}${rejected.length ? ' — ' + rejected.join('; ') : ''}`);
  await check('C1 censo: 0 excepciones (salvo los rechazos tipados del lector), 0 escrituras a disco', async () => { if (errors.length) throw new Error(errors.slice(0, 5).join('\n')); });
  await check('C2 censo: los defectos reales conocidos aparecen con su check (Libro Guía → label ≥ 7, `$&` roto, external)', async () => {
    assert(known.libroLabel.length >= 7, `Libro Guía → label en ${known.libroLabel.length} (B2 contó 7)`);
    assert(known.malformed.length > 0, 'ningún token roto');
    assert(known.external.length > 0, 'ningún external');
  });
  await check('C3 censo: todo token no ok del inventario (B2) tiene su hallazgo T04', async () => { if (known.missedTokens.length) throw new Error(known.missedTokens.slice(0, 5).join('\n')); });
  console.log(`\n${fail ? '❌' : '✅'} check-r107-diagnosis --census: ${ok} ok, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  if (CENSUS) return censusMode(CENSUS);
  const { synth, damaged, bases, real } = CI ? await ciFixtures() : corpusFixtures(corpusArg);
  console.log(`  modo ${CI ? 'CI (sintéticos + dañados generados acá + V1 mínimo)' : `corpus ${corpusArg}`}: ${synth.length} sintéticos, ${damaged.filter((d) => !d.skipped).length} dañados, ${real.length} reales`);
  const unspy = spyWrites();
  const reports = new Map();
  const baseReports = {};
  try {
    for (const [k, b] of Object.entries(bases)) baseReports[k] = await diagnose(b.buf, b.filename);

    await check('D2 sintéticos sanos → verde (0 error, 0 warning), sin y con expectativas (validador v3 completo)', async () => {
      for (const s of synth) {
        const r = await diagnose(s.buf, s.filename);
        reports.set(s.id, r);
        eq([r.light.course, r.counts.total.error, r.counts.total.warning], ['green', 0, 0], `${s.id} sin expectativas (${visible(r).map(fmt).join(', ')})`);
        eq(r.validator.mode, 'without_expectations', `${s.id} modo del validador`);
        const w = await diagnose(s.buf, s.filename, { expectations: s.expectations });
        eq([w.validator.mode, w.validator.issues, w.light.course, w.counts.total.error, w.counts.total.warning], ['with_expectations', 0, 'green', 0, 0], `${s.id} con expectativas (${visible(w).map(fmt).join(', ')})`);
      }
    });
    if (CI) {
      await check('D8 V1 mínimo sano → verde; T06 / T07 / T08 / T09 / T10 corren sobre él', async () => {
        const r = baseReports['v1-min'];
        eq([r.family, r.light.course, r.counts.total.error, r.counts.total.warning], ['v1-legacy-hvp', 'green', 0, 0], `V1 mínimo (${visible(r).map(fmt).join(', ')})`);
        for (const id of ['T06', 'T07', 'T08', 'T09', 'T10']) eq(r.checks.find((c) => c.check === id).status, 'ran', `${id} corrió`);
        assert(r.findings.some((x) => x.code === 'audiobook_info'), 'info del audiolibro (duración / bitrate)');
      });
    }
    for (const d of damaged) {
      if (d.skipped) { console.log(`⏭️  ${d.id}: la base no tiene el elemento a dañar`); continue; }
      await check(`D1 ${d.id} → exactamente ${d.expected.check} en ${d.expected.target}`, async () => {
        const r = await diagnose(d.buf, d.filename);
        reports.set(d.id, r);
        const base = baseReports[d.base];
        assert(base, `sin base ${d.base}`);
        const x = exactlySeeded(r, base, d.expected);
        assert(r.light.course !== 'green', 'el curso dañado no puede quedar verde');
        if (x.severity === 'error') assert(r.light.course === 'red', 'error → curso rojo');
      });
    }
    for (const f of real) {
      await check(`D3 real ${f.id} (${f.family}): diagnóstico sin excepción`, async () => {
        const r = await diagnose(fs.readFileSync(f.path), f.filename);
        reports.set(f.id, r);
        const by = Object.entries(r.counts.byCheck).filter(([, c]) => c.error + c.warning + c.info).map(([k, c]) => `${k} ${c.error}/${c.warning}/${c.info}`).join(' · ');
        console.log(`   ${r.light.course.padEnd(6)} ${by || '(sin hallazgos)'}`);
      });
    }

    await check('D4 determinismo: el mismo paquete dos veces → el mismo informe byte a byte', async () => {
      const s = synth[0];
      const a = M.stableStringify(await diagnose(s.buf, s.filename));
      const b = M.stableStringify(await diagnose(Buffer.from(s.buf), s.filename));
      eq(a === b, true, 'mismo informe');
      const d = damaged.find((x) => !x.skipped);
      eq(M.stableStringify(await diagnose(d.buf, d.filename)) === M.stableStringify(await diagnose(d.buf, d.filename)), true, 'dañado');
    });

    await check('D5 semáforo: rojo ⇐ error · amarillo ⇐ solo warning · verde ⇐ nada (info no cuenta); actividad / capítulo / curso', async () => {
      const mk = (sev, scope) => ({ id: `${sev}${Math.random()}`, severity: sev, scope });
      eq(DG.lightOf([]), 'green', 'vacío');
      eq(DG.lightOf([mk('info')]), 'green', 'solo info');
      eq(DG.lightOf([mk('warning'), mk('info')]), 'yellow', 'warning + info');
      eq(DG.lightOf([mk('warning'), mk('error')]), 'red', 'error gana');
      eqS(DG.countOf([mk('warning'), mk('error'), mk('info'), mk('info')]), { error: 1, warning: 1, info: 2 }, 'conteo');
      let checked = 0;
      for (const [id, r] of reports) {
        for (const a of r.light.activities) {
          const fs2 = r.findings.filter((x) => x.scope.activity && x.scope.activity.moduleId === a.moduleId);
          eqS([a.light, a.counts], [DG.lightOf(fs2), DG.countOf(fs2)], `${id} actividad ${a.dir}`);
          checked++;
        }
        for (const c of r.light.chapters) {
          const fs2 = r.findings.filter((x) => x.scope.chapterNumber === c.number);
          eq(c.light, DG.lightOf(fs2), `${id} capítulo ${c.number}`);
          // Un capítulo es al menos tan grave como la peor de sus actividades.
          const rank = { green: 0, yellow: 1, red: 2 };
          for (const a of r.light.activities.filter((x) => x.chapterNumber === c.number)) assert(rank[c.light] >= rank[a.light], `${id} capítulo ${c.number} menos grave que ${a.dir}`);
        }
        eqS([r.light.course, r.counts.total], [DG.lightOf(r.findings), DG.countOf(r.findings)], `${id} curso`);
        const sum = { error: 0, warning: 0, info: 0 };
        for (const c of Object.values(r.counts.byCheck)) for (const k of Object.keys(sum)) sum[k] += c[k];
        eqS(sum, r.counts.total, `${id} conteo por check = total`);
      }
      assert(checked > 100, `pocas actividades verificadas (${checked})`);
    });

    await check('D6 estado de cada check: T01–T12 presentes; no aplica con motivo; T12 diferido «B6 / bajo demanda»; tabla por familia', async () => {
      for (const [id, r] of reports) {
        eq(r.checks.map((c) => c.check), DG.CHECK_IDS, `${id} checks`);
        for (const c of r.checks) if (c.status !== 'ran') assert(typeof c.reason === 'string' && c.reason.length > 5, `${id} ${c.check} sin motivo`);
        const t12 = r.checks.find((c) => c.check === 'T12');
        eq(t12.status, 'deferred', `${id} T12`);
        assert(/B6/.test(t12.reason) && /bajo demanda/.test(t12.reason), 'T12: B6 / bajo demanda');
        assert(!r.findings.some((x) => x.check === 'T12'), 'T12 sin hallazgos');
        if (r.builderLine !== 'v3') eq(r.checks.find((c) => c.check === 'T11').status, 'not_applicable', `${id} T11 fuera de v3`);
      }
      const s = reports.get(synth[0].id);
      eq(s.checks.find((c) => c.check === 'T06').status, 'not_applicable', 'v3 sin SCORM: T06 no aplica');
      for (const id of DG.CHECK_IDS) for (const fam of I.WORKSHOP_FAMILIES) assert(DG.CHECK_FAMILY_APPLICABILITY[id][fam] !== undefined, `tabla ${id} ${fam}`);
    });

    await check('D7 forma: id estable único, título sin jerga, evidencia, arreglo del catálogo cerrado (o null)', async () => {
      const ops = new Set(DG.WORKSHOP_OPERATIONS);
      const JARGON = /\$@|\.xml\b|moduleid|contenthash|sha1|\btoken\b|files\.xml|activities\/|inforef|idnumber|cv3:/i;
      let n = 0;
      for (const [id, r] of reports) {
        const ids = new Set();
        for (const x of r.findings) {
          n++;
          assert(/^T(0[1-9]|1[0-1])\.[a-z0-9_]+\.[0-9a-f]{12}$/.test(x.id), `${id} id ${x.id}`);
          assert(!ids.has(x.id), `${id} id repetido ${x.id}`);
          ids.add(x.id);
          const titleSansNames = x.title.replace(/«[^»]*»/g, '«»');
          assert(!JARGON.test(titleSansNames), `${id} jerga en el título: ${x.title}`);
          assert(x.detail && x.detail.length > 5, `${id} sin detalle`);
          assert(x.evidence && 'entry' in x.evidence, `${id} sin evidencia`);
          if (x.evidence.excerpt) assert(x.evidence.excerpt.length <= 160, `${id} fragmento largo`);
          if (x.suggestedFix) assert(ops.has(x.suggestedFix.operation) && typeof x.suggestedFix.params === 'object', `${id} operación fuera del catálogo: ${x.suggestedFix.operation}`);
          assert(['course', 'chapter', 'activity'].includes(x.scope.level), `${id} alcance`);
          if (x.scope.level === 'activity') assert(x.scope.activity && /^activities\//.test(x.scope.activity.dir), `${id} actividad sin carpeta`);
        }
      }
      assert(n > 0, 'ningún hallazgo verificado');
    });

    await check('D9 validador v3 sin expectativas: cada hallazgo suyo queda como corroboración o como T11 propio', async () => {
      let corr = 0;
      for (const [id, r] of reports) {
        if (r.validator.mode === 'not_applicable') continue;
        const t11 = r.findings.filter((x) => x.check === 'T11').length;
        const c = r.findings.reduce((s, x) => s + x.corroboratedBy.length, 0);
        corr += c;
        assert(r.validator.issues === 0 || t11 + c > 0, `${id}: ${r.validator.issues} hallazgos del validador perdidos`);
      }
      assert(corr > 0, 'ningún dañado v3 corroborado por el validador');
    });
  } finally {
    const calls = unspy();
    if (calls.length) { fail++; console.log(`❌ escribió a disco: ${calls.slice(0, 3).join(', ')}`); }
  }
  console.log(`\n${fail ? '❌' : '✅'} check-r107-diagnosis ${CI ? '--ci' : '--corpus'}: ${ok} ok, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
