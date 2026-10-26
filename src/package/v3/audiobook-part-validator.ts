/**
 * r74 — validador de una PARTE de audio del paquete autocontenido, sobre sus BYTES (antes de subirla).
 *
 * Exige: copia de curso (`type=course`) con SOLO la sección 1 (mismo nombre que la del principal); un label por segmento
 * con el idnumber esperado y en orden; cada label con su MP3 en el filearea `intro` (inforef + files.xml + blob presentes,
 * sha1 y tamaño = los del archivo, duración medida = facts); el HTML del label reproduce ese archivo
 * (`@@PLUGINFILE@@/<archivo>`); nada más en el paquete (ni notas, ni preguntas, ni insignias).
 */
import * as JSZip from 'jszip';
import { createHash } from 'crypto';
import { mp3DurationSeconds } from '../audio';
import type { AudiobookPartExpectations } from '../dynamic-mbz-builder-v3';

export interface AudiobookPartValidation {
  ok: boolean;
  issues: Array<{ code: string; where: string; message: string }>;
  stats: { labels: number; files: number; audioSeconds: number; bytes: number };
}

const tag = (x: string, t: string): string | null => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x);
  return m ? m[1] : null;
};
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export async function validateAudiobookPartV3(mbz: Buffer, exp: AudiobookPartExpectations): Promise<AudiobookPartValidation> {
  const issues: AudiobookPartValidation['issues'] = [];
  const add = (code: string, where: string, message: string) => issues.push({ code, where, message });
  let audioSeconds = 0;
  const zip = await JSZip.loadAsync(mbz);
  const text = async (p: string) => (zip.file(p) ? await (zip.file(p) as JSZip.JSZipObject).async('string') : null);
  const mb = (await text('moodle_backup.xml')) ?? '';
  if (!mb) add('PART_STRUCTURE', 'moodle_backup.xml', 'falta moodle_backup.xml');
  if (!/<type>course<\/type>/.test(mb)) add('PART_STRUCTURE', 'moodle_backup.xml', 'la parte debe ser una copia de curso');
  const secs = Array.from(mb.matchAll(/<section>\s*<sectionid>(\d+)<\/sectionid>\s*<title>([\s\S]*?)<\/title>/g), (m) => ({ id: Number(m[1]), title: unxml(m[2]) }));
  if (secs.length !== 1 || secs[0].id !== 1) add('PART_STRUCTURE', 'moodle_backup.xml', `la parte debe traer solo la sección 1 (trae ${JSON.stringify(secs.map((s) => s.id))})`);
  else if (secs[0].title !== exp.section1Title) add('PART_STRUCTURE', 'moodle_backup.xml', `sección 1 «${secs[0].title}» ≠ «${exp.section1Title}» del principal`);
  if (unxml(tag(mb, 'original_course_fullname') ?? '') !== exp.courseTitle) add('PART_STRUCTURE', 'moodle_backup.xml', 'el curso de la parte no es el del principal');
  const acts = Array.from(mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9]+)<\/modulename>[\s\S]*?<directory>([^<]+)<\/directory>/g), (m) => ({ mid: Number(m[1]), sec: Number(m[2]), mod: m[3], dir: m[4] }));
  if (acts.length !== exp.labels.length) add('PART_STRUCTURE', 'moodle_backup.xml', `${acts.length} actividad(es), esperadas ${exp.labels.length}`);
  const sx = (await text('sections/section_1/section.xml')) ?? '';
  const seq = (tag(sx, 'sequence') ?? '').split(',').filter(Boolean).map(Number);
  if (JSON.stringify(seq) !== JSON.stringify(acts.map((a) => a.mid))) add('PART_STRUCTURE', 'sections/section_1', `sequence ${seq.join(',')} ≠ actividades ${acts.map((a) => a.mid).join(',')}`);
  for (const forbidden of ['gradebook.xml']) if (zip.file(forbidden)) add('PART_STRUCTURE', forbidden, 'una parte de audio no lleva notas');
  if (/<question_category\b/.test((await text('questions.xml')) ?? '')) add('PART_STRUCTURE', 'questions.xml', 'una parte de audio no lleva preguntas');
  if (/<badge\b/.test((await text('badges.xml')) ?? '')) add('PART_STRUCTURE', 'badges.xml', 'una parte de audio no lleva insignias');
  const filesXml = (await text('files.xml')) ?? '';
  const files = Array.from(filesXml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g), (m) => ({
    id: Number(m[1]), hash: tag(m[2], 'contenthash') ?? '', ctx: Number(tag(m[2], 'contextid')), component: tag(m[2], 'component') ?? '',
    filearea: tag(m[2], 'filearea') ?? '', filename: unxml(tag(m[2], 'filename') ?? ''), size: Number(tag(m[2], 'filesize')),
  }));
  for (let i = 0; i < exp.labels.length; i++) {
    const want = exp.labels[i];
    const a = acts[i];
    if (!a) continue;
    const where = want.idnumber;
    if (a.mod !== 'label' || a.sec !== 1) add('PART_STRUCTURE', where, `actividad ${a.mod} en la sección ${a.sec}`);
    const modx = (await text(`${a.dir}/module.xml`)) ?? '';
    if (tag(modx, 'idnumber') !== want.idnumber) add('PART_STRUCTURE', where, `idnumber ${tag(modx, 'idnumber')} ≠ ${want.idnumber}`);
    const lx = (await text(`${a.dir}/label.xml`)) ?? '';
    const ctx = Number(/contextid="(\d+)"/.exec(lx)?.[1]);
    const intro = unxml(tag(lx, 'intro') ?? '');
    if (!intro.includes(`@@PLUGINFILE@@/${want.file}`)) add('PART_AUDIO', where, `el label no reproduce ${want.file}`);
    const inforefIds = Array.from(((await text(`${a.dir}/inforef.xml`)) ?? '').matchAll(/<file><id>(\d+)<\/id><\/file>/g), (m) => Number(m[1]));
    const f = files.find((x) => x.ctx === ctx && x.component === 'mod_label' && x.filearea === 'intro' && x.filename === want.file);
    if (!f) { add('PART_AUDIO', where, `files.xml no tiene ${want.file} en el label`); continue; }
    if (!inforefIds.includes(f.id)) add('PART_AUDIO', where, 'inforef no referencia el MP3');
    if (f.hash !== want.sha1 || f.size !== want.bytes) add('PART_AUDIO', where, `files.xml (${f.hash}, ${f.size} B) ≠ MP3 esperado (${want.sha1}, ${want.bytes} B)`);
    const blobFile = zip.file(`files/${f.hash.slice(0, 2)}/${f.hash}`);
    if (!blobFile) { add('PART_AUDIO', where, 'falta el blob del MP3'); continue; }
    const blob = await blobFile.async('nodebuffer');
    const sha1 = createHash('sha1').update(blob).digest('hex');
    if (sha1 !== f.hash || blob.length !== f.size) add('PART_AUDIO', where, `el blob no coincide con files.xml (sha1 ${sha1}, ${blob.length} B)`);
    try {
      const sec = mp3DurationSeconds(blob);
      audioSeconds += sec;
      if (Math.abs(sec - want.seconds) > 1e-6) add('PART_AUDIO', where, `el MP3 mide ${sec}s y facts dice ${want.seconds}s`);
    } catch (err) {
      add('PART_AUDIO', where, `MP3 ilegible: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const realFiles = files.filter((x) => x.filename !== '.');
  if (realFiles.length !== exp.labels.length) add('PART_STRUCTURE', 'files.xml', `${realFiles.length} archivo(s), esperados ${exp.labels.length}`);
  return { ok: issues.length === 0, issues, stats: { labels: acts.length, files: realFiles.length, audioSeconds, bytes: mbz.length } };
}
