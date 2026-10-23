// Inspección de un .mbz (ZIP Moodle 2) → estructura normalizada con los
// marcadores por UUID de cada actividad, y chequeo de tokens $@TOKEN*mid@$.
'use strict';

const MARK_RE = /MARK(CH|SC|EX|CI|MI|BIB)-([0-9a-f-]{36}|\d+)-([AB])/g;
function markers(text) {
  const out = [];
  let m;
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(text))) out.push({ kind: m[1], id: m[2], tag: m[3], pos: m.index });
  return out;
}

async function inspectMbz(JSZip, buf) {
  const zip = await JSZip.loadAsync(buf);
  const txt = async (f) => (zip.file(f) ? zip.file(f).async('string') : null);
  const mb = await txt('moodle_backup.xml');
  const acts = [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>(\w+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]*)<\/directory>/g)]
    .map((a) => ({ mid: a[1], sectionid: a[2], modname: a[3], title: a[4], dir: a[5] }));
  const actByMid = new Map(acts.map((a) => [a.mid, a]));
  // files.xml → contextid/component/filearea → contenthash
  const filesXml = (await txt('files.xml')) || '';
  const fileEntries = [...filesXml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].map((f) => {
    const g = (t) => ((f[2].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '');
    return { contenthash: g('contenthash'), contextid: g('contextid'), component: g('component'), filearea: g('filearea'), filename: g('filename'), mimetype: g('mimetype') };
  });
  const sections = [];
  for (const f of Object.keys(zip.files).filter((x) => /^sections\/section_\d+\/section\.xml$/.test(x))) {
    const x = await txt(f);
    sections.push({
      sectionid: (x.match(/<section id="(\d+)"/) || [])[1],
      number: Number((x.match(/<number>(\d+)<\/number>/) || [])[1]),
      name: (x.match(/<name>([^<]*)<\/name>/) || [])[1] || '',
      sequence: ((x.match(/<sequence>([^<]*)<\/sequence>/) || [])[1] || '').split(',').filter(Boolean),
    });
  }
  sections.sort((a, b) => a.number - b.number);
  const allText = [];
  const out = { sections: [], activities: acts, tokens: [], orphanTokens: [], fileCount: fileEntries.length };
  for (const s of sections) {
    const sec = { number: s.number, name: s.name, activities: [] };
    for (const mid of s.sequence) {
      const a = actByMid.get(mid);
      if (!a) { sec.activities.push({ mid, modname: null, error: 'sequence mid sin <activity>' }); continue; }
      let text = '';
      const dir = a.dir.replace(/\/$/, '');
      const mainXml = (await txt(`${dir}/${a.modname}.xml`)) || '';
      text += mainXml;
      const ctxid = (mainXml.match(/<activity id="\d+" moduleid="\d+" modulename="\w+" contextid="(\d+)"/) || [])[1];
      const extra = {};
      if (a.modname === 'url') extra.externalurl = (mainXml.match(/<externalurl>([^<]*)<\/externalurl>/) || [])[1] || null;
      if (a.modname === 'quiz') {
        extra.questionCount = 0;
        const qx = (await txt('questions.xml')) || '';
        // preguntas cuyo contexto es el del quiz
        for (const cat of qx.matchAll(/<question_category id="\d+">([\s\S]*?)<\/question_category>/g)) {
          if ((cat[1].match(/<contextid>(\d+)<\/contextid>/) || [])[1] !== ctxid) continue;
          const qs = [...cat[1].matchAll(/<question id="\d+">([\s\S]*?)<\/question>/g)];
          extra.questionCount += qs.length;
          text += cat[1];
        }
      }
      if (a.modname === 'scorm' || a.modname === 'resource') {
        extra.files = [];
        for (const fe of fileEntries.filter((e) => e.contextid === ctxid && e.filename !== '.')) {
          const p = `files/${fe.contenthash.slice(0, 2)}/${fe.contenthash}`;
          const blob = zip.file(p);
          extra.files.push({ component: fe.component, filearea: fe.filearea, filename: fe.filename, present: !!blob });
          if (!blob) continue;
          const b = await blob.async('nodebuffer');
          if (b[0] === 0x50 && b[1] === 0x4b) { // zip (paquete SCORM)
            const inner = await JSZip.loadAsync(b);
            for (const n of Object.keys(inner.files)) if (/\.(html?|xml|js|json)$/i.test(n)) text += await inner.file(n).async('string');
          } else text += b.toString('utf8');
        }
      }
      allText.push(text);
      sec.activities.push({ mid, modname: a.modname, title: a.title, markers: markers(text), extra, text });
    }
    out.sections.push(sec);
  }
  // tokens $@TYPE*mid@$ en todo el paquete (xml + archivos de contenido)
  const tokenType = { SCORMVIEWBYID: 'scorm', RESOURCEVIEWBYID: 'resource', PAGEVIEWBYID: 'page', QUIZVIEWBYID: 'quiz', URLVIEWBYID: 'url', FORUMVIEWBYID: 'forum', LABELVIEWBYID: 'label' };
  const corpus = [];
  for (const f of Object.keys(zip.files)) if (!zip.files[f].dir && (/\.xml$/.test(f) || /^files\//.test(f))) corpus.push(await zip.file(f).async('string'));
  const all = corpus.join('\n');
  for (const t of all.matchAll(/\$@([A-Z]+)\*(\d+)@\$/g)) {
    out.tokens.push(`${t[1]}*${t[2]}`);
    const a = actByMid.get(t[2]);
    if (!a || !tokenType[t[1]] || tokenType[t[1]] !== a.modname) out.orphanTokens.push(`${t[1]}*${t[2]}`);
  }
  return out;
}

module.exports = { inspectMbz, markers };
