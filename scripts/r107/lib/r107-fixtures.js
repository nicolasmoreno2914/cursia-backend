/* eslint-disable */
// r107 — fixtures compartidas por los checks del Taller (B3 diagnóstico, B4 motor de parches): el V1 mínimo armado en
// memoria (bienvenida + audiolibro + Libro Guía HTML + 2 capítulos con página, hvp y SCORM + examen) y el MP3 «largo»
// sintético (el audiolibro del v3 A-S del motor de la simulación comercial). Sin red, sin IA, USD 0. Movido tal cual
// desde check-r107-diagnosis.js (B4) para no duplicarlo.
'use strict';
const crypto = require('crypto');
const JSZip = require('jszip');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

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
  act(904, 'label', '📚 Libro Guía del Curso', '<p>Tu guía completa del curso. <a href="$@RESOURCEVIEWBYID*903@$">Descargar Libro Guía</a></p>', 1);
  addFile(903, cLibro, 'mod_resource', 'content', 'libro_guia_completo.html', Buffer.from(LIBRO_HTML), 'text/html');
  for (const n of [1, 2]) {
    const base = 900 + n * 10;
    act(base, 'label', `▶️ Cap. ${n} — Video: Tema ${n}`, `<p>MÓDULO 1 · CAPÍTULO ${n}</p><p>📺 Instrucciones: mira el video.</p>`, 1 + n);
    act(base + 1, 'hvp', `🎥 Video Interactivo Cap ${n} — Tema ${n}`, `<p>Video del capítulo ${n}. <a href="$@SCORMVIEWBYID*${base + 2}@$">Practicar</a></p>`, 1 + n, `<json_content>${esc(HVP_JSON(n))}</json_content>`);
    const cS = act(base + 2, 'scorm', `🎮 Actividad Interactiva Cap ${n} — Tema ${n}`, '<p>Juego.</p>', 1 + n, `<reference>scorm.zip</reference><scoes><sco id="${60000 + n * 2}"><manifest>cap${n}_juego</manifest><organization></organization><parent>/</parent><identifier>o</identifier><launch></launch><scormtype></scormtype><title>Juego</title></sco><sco id="${60001 + n * 2}"><manifest>cap${n}_juego</manifest><organization>o</organization><parent>o</parent><identifier>i</identifier><launch>index.html</launch><scormtype>sco</scormtype><title>Juego</title></sco></scoes>`);
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


/** MP3 «largo» sintético: el audiolibro del v3 A-S (motor de la simulación, sin red). */
async function audiobookOf(v3buf) {
  const z = await JSZip.loadAsync(v3buf);
  const files = await z.file('files.xml').async('string');
  const blks = [...files.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].map((m) => m[1]).filter((b) => /<filename>[^<]*\.mp3<\/filename>/.test(b));
  let best = null;
  for (const b of blks) { const h = /<contenthash>([0-9a-f]{40})/.exec(b)[1]; const buf = await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer'); if (!best || buf.length > best.length) best = buf; }
  return best;
}

// ── r107 B8: edición de paquetes para sembrar defectos de CALIDAD (sin red, USD 0) ──────────────────────────────────────
const exactEsc = (s) => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
const xmlUnesc = (s) => String(s).split('&quot;').join('"').split('&gt;').join('>').split('&lt;').join('<').split('&amp;').join('&');
async function zipEdit(buf, fn) { const z = await JSZip.loadAsync(buf); await fn(z); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); }
/** Reescribe el `<intro>` de una actividad (`fn` recibe y devuelve el HTML desescapado; se escribe con el xmlEsc exacto). */
async function setIntro(z, dir, fn) {
  const p = `activities/${dir}/${dir.split('_')[0]}.xml`;
  const x = await z.file(p).async('string');
  const i = x.indexOf('<intro>'); const j = x.indexOf('</intro>', i);
  z.file(p, x.slice(0, i + 7) + exactEsc(fn(xmlUnesc(x.slice(i + 7, j)))) + x.slice(j));
}
/** Reemplaza el CONTENIDO de un archivo por nombre (blob nuevo por su sha1; files.xml con su hash y tamaño). */
async function replaceBlob(z, filename, fn) {
  let files = await z.file('files.xml').async('string');
  const m = new RegExp(`<contenthash>([0-9a-f]{40})</contenthash>(?:(?!</file>)[\\s\\S])*?<filename>${filename.replace(/\./g, '\\.')}</filename>`).exec(files);
  const old = m[1];
  const buf = Buffer.from(fn(await z.file(`files/${old.slice(0, 2)}/${old}`).async('string')));
  const h = sha1(buf);
  z.remove(`files/${old.slice(0, 2)}/${old}`);
  z.file(`files/${h.slice(0, 2)}/${h}`, buf);
  files = files.split(old).join(h).replace(new RegExp(`(<contenthash>${h}</contenthash>(?:(?!</file>)[\\s\\S])*?<filesize>)\\d+(</filesize>)`), `$1${buf.length}$2`);
  z.file('files.xml', files);
}
/** Reescribe el json_content de un hvp (V1). */
async function editHvp(z, dir, fn) {
  const p = `activities/${dir}/hvp.xml`;
  const x = await z.file(p).async('string');
  const i = x.indexOf('<json_content>') + 14; const j = x.indexOf('</json_content>');
  z.file(p, x.slice(0, i) + exactEsc(JSON.stringify(fn(JSON.parse(xmlUnesc(x.slice(i, j)))))) + x.slice(j));
}
const setHvpQuestion = (text) => (j) => { j.interactiveVideo.assets.interactions[0].action.params.question = text; return j; };
/** El V1 mínimo con datos COHERENTES entre Libro, video y textos de sus dos capítulos (base limpia de la calidad, B8). */
async function qualityV1(audioMp3) {
  return zipEdit(await miniV1(audioMp3), async (z) => {
    await setIntro(z, 'label_910', () => '<p>MÓDULO 1 · CAPÍTULO 1</p><p>La distancia mínima de seguridad entre equipos es de 2 metros.</p><p>📺 Instrucciones: mira el video.</p>');
    await setIntro(z, 'label_920', () => '<p>MÓDULO 1 · CAPÍTULO 2</p><p>La distancia mínima de seguridad entre equipos es de 2 metros.</p><p>📺 Instrucciones: mira el video.</p>');
    await replaceBlob(z, 'libro_guia_completo.html', (h) => h
      .replace('<p>Contenido del primero.</p>', '<p>Contenido del primero.</p><p>La velocidad máxima en zona escolar es de 30 km/h.</p>')
      .replace('<p>Contenido del segundo.</p>', '<p>Contenido del segundo.</p><p>Usa guantes de nitrilo para manipular los reactivos del taller.</p>'));
    await editHvp(z, 'hvp_911', setHvpQuestion('<p>Según el video, la velocidad máxima en zona escolar es de 30 km/h. ¿Es cierto?</p>'));
    await editHvp(z, 'hvp_921', setHvpQuestion('<p>Según el video, usa guantes de nitrilo para manipular los reactivos del taller. ¿Es cierto?</p>'));
  });
}

module.exports = { esc, LIBRO_HTML, MANIFEST, GAME, HVP_JSON, miniV1, audiobookOf, exactEsc, xmlUnesc, zipEdit, setIntro, replaceBlob, editHvp, setHvpQuestion, qualityV1 };
