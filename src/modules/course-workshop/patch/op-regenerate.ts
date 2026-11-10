/**
 * r107 B10 · motor de parches — Fase 3: INSERTA el resultado validado de una regeneración (`regenerate_scorm` /
 * `regenerate_video` / `regenerate_gamma` / `regenerate_audio`). La IA y los proveedores ya trabajaron antes (con
 * aprobación y tope); acá no hay red ni IA: el motor vuelve a VALIDAR el resultado (salas completas y sin «⚠️ Pendiente»,
 * preguntas con exactamente una correcta, PDF y portada legibles, audiolibro con todos sus capítulos, mono ≤ 64 kbps) y
 * lo escribe con las reglas de los builders:
 *   - mismo moduleid, mismas entradas; cada blob nuevo con su SHA1 y SOLO las entradas de files.xml de ESTA actividad
 *     pasan al blob nuevo (un blob compartido con otra actividad no se toca); el viejo sale solo si nadie lo usa;
 *   - SCORM: index.html + imsmanifest.xml + el paquete .zip (rearmado con los mismos nombres) + `sha1hash` y los `scoes`
 *     de scorm.xml según el manifiesto nuevo; ids `sco` / `sco_data` en su rango propio (60000+), sin repetir ninguno;
 *   - textos del curso que describen el recurso (duración del audio, diapositivas del PDF, enlace de YouTube del video):
 *     se actualizan SOLO si el patrón del builder está; si no, queda dicho en el informe (D7: nunca a ciegas).
 * Un resultado inválido o incompleto NUNCA se escribe: la operación falla `invalid_content` y el plan entero no aplica.
 */
import JSZip = require('jszip');
import { WorkshopActivity, WorkshopFile } from '../course-model';
import { audioFramesOf, formatDurationEs, mp3DurationSeconds, parseMp3 } from '../../../package/audio';
import { pdfPageCount, pngDimensions } from '../../../package/presentation';
import { parseScormManifestIds } from '../../../package/v3/moodle-activities-v3';
import { audioProblems } from '../regenerate/audio';
import { scormProblems } from '../regenerate/scorm';
import { h5pJsonOf } from '../regenerate/target';
import { videoQuestionStats } from '../regenerate/video';
import { ProducedRegen, RegenerateOp } from '../regenerate/types';
import { sha1Of } from './container';
import { locateField, rawIndexMap, writeField, xmlEsc } from './html-edit';
import { OpContext, blobPath, noteModified, setTag } from './op-context';
import { PatchError } from './types';

const fileOf = (a: WorkshopActivity, area: string, re: RegExp): WorkshopFile | undefined => a.files.find((f) => f.filearea === area && re.test(f.filename) && f.filename !== '.');

/**
 * Reemplaza el contenido de UN archivo de la actividad (component + filearea + nombre + contexto): solo SUS entradas de
 * files.xml pasan al blob nuevo. El blob viejo sale del paquete si ya nadie lo usa.
 */
async function replaceActivityFile(ctx: OpContext, a: WorkshopActivity, f: WorkshopFile, data: Buffer, mimetype?: string | null): Promise<string> {
  const nh = sha1Of(data);
  const r = ctx.report;
  const oldHash = f.contenthash;
  if (nh === oldHash) return nh;
  const nEntry = blobPath(nh);
  if (!ctx.state.has(nEntry)) { ctx.state.write(nEntry, data); r.entriesAdded.push(nEntry); }
  let xml = await ctx.state.readText('files.xml');
  const mine = (body: string) => body.includes(`<contenthash>${oldHash}</contenthash>`)
    && (a.contextId === null || new RegExp(`<contextid>${a.contextId}</contextid>`).test(body))
    && body.includes(`<filearea>${xmlEsc(f.filearea)}</filearea>`) && body.includes(`<filename>${xmlEsc(f.filename)}</filename>`);
  const blocks = [...xml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].filter((m) => mine(m[2]));
  if (!blocks.length) throw new PatchError('invariant', `files.xml no tiene la entrada de «${f.filename}» de la actividad (${oldHash.slice(0, 10)}…).`);
  for (const m of blocks.reverse()) {
    const start = m.index ?? 0;
    const tagv = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[2])?.[1] ?? null;
    let nb = m[2].split(`<contenthash>${oldHash}</contenthash>`).join(`<contenthash>${nh}</contenthash>`);
    nb = setTag(nb, 'filesize', String(data.length));
    if (mimetype) nb = setTag(nb, 'mimetype', mimetype);
    xml = xml.slice(0, start) + `<file id="${m[1]}">${nb}</file>` + xml.slice(start + m[0].length);
    r.files.push({
      fileId: Number(m[1]), filename: tagv('filename') ?? '', component: tagv('component') ?? '', filearea: tagv('filearea') ?? '',
      before: { contenthash: oldHash, filesize: Number(tagv('filesize') ?? 0), mimetype: tagv('mimetype') },
      after: { contenthash: nh, filesize: data.length, mimetype: mimetype ?? tagv('mimetype') },
    });
  }
  ctx.state.write('files.xml', xml);
  noteModified(ctx, 'files.xml');
  if (!xml.includes(`<contenthash>${oldHash}</contenthash>`)) {
    const oEntry = blobPath(oldHash);
    if (ctx.state.has(oEntry)) { ctx.state.remove(oEntry); r.entriesRemoved.push(oEntry); }
  }
  return nh;
}

/** Cambios de texto en el campo HTML (sobre el desescapado; se escriben por posición con xmlEsc exacto). */
async function editIntro(ctx: OpContext, a: WorkshopActivity, edits: (html: string) => Array<{ start: number; end: number; ins: string; note: string }>): Promise<string[]> {
  const f = a.html.find((h) => h.field === 'intro') ?? a.html.find((h) => h.field === 'content');
  if (!f) return [];
  const es = edits(f.html);
  if (!es.length) return [];
  const loc = await locateField(ctx.state, f);
  const map = rawIndexMap(loc.raw);
  let raw = loc.raw;
  let html = f.html;
  for (const e of [...es].sort((x, y) => y.start - x.start)) {
    raw = raw.slice(0, map[e.start]) + xmlEsc(e.ins) + raw.slice(map[e.end]);
    html = html.slice(0, e.start) + e.ins + html.slice(e.end);
  }
  writeField(ctx.state, loc, raw);
  noteModified(ctx, loc.entry);
  ctx.report.fields.push({ entry: loc.entry, field: f.field, moduleId: a.moduleId, sectionId: null, before: f.html, after: html, beforeRawSha1: f.rawSha1, afterRawSha1: sha1Of(raw) });
  return es.map((e) => e.note);
}

function matches(html: string, re: RegExp, ins: (m: RegExpMatchArray) => string, note: string): Array<{ start: number; end: number; ins: string; note: string }> {
  const out: Array<{ start: number; end: number; ins: string; note: string }> = [];
  for (const m of html.matchAll(re)) {
    const v = ins(m);
    if (v !== m[0]) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, ins: v, note });
  }
  return out;
}

/** Validación del resultado ANTES de escribir (la misma que la producción, independiente de ella). */
export async function producedProblems(p: ProducedRegen, expect: { chapters?: number[] } = {}): Promise<string[]> {
  switch (p.kind) {
    case 'scorm_v2': return scormProblems(p);
    case 'h5p_practice': {
      const hj = await h5pJsonOf(p.h5p);
      if (!hj) return ['el .h5p de la práctica no abre'];
      // Fix round 1 (P2-6): las preguntas se RECUENTAN del content.json del .h5p (nunca el campo declarado).
      const n = practiceQuestionsOf(hj.mainLibrary, hj.content);
      return [
        ...(hj.mainLibrary !== p.mainLibrary ? [`el .h5p dice ${hj.mainLibrary}, no ${p.mainLibrary}`] : []),
        ...(n < 1 ? ['la práctica no tiene preguntas (recontadas del .h5p)'] : []),
        ...(n >= 1 && n !== p.questions ? [`la práctica dice ${p.questions} pregunta(s) y el .h5p trae ${n}`] : []),
      ];
    }
    case 'video': {
      let content: any = null;
      if (p.container === 'h5pactivity') {
        const hj = p.h5p ? await h5pJsonOf(p.h5p) : null;
        if (!hj || hj.mainLibrary !== 'H5P.InteractiveVideo') return ['el .h5p del video no es un H5P.InteractiveVideo'];
        content = hj.content;
      } else {
        try { content = JSON.parse(p.hvpJson ?? ''); } catch { return ['el contenido del video (hvp) no es JSON'] as string[]; }
      }
      const url = String(content?.interactiveVideo?.video?.files?.[0]?.path ?? '');
      const st = videoQuestionStats(content);
      return [
        ...(!url.includes(p.youtubeId) ? ['el video no apunta al video de YouTube producido'] : []),
        ...(st.questions < 1 ? ['el video no tiene preguntas'] : []),
        // Fix round 1 (P2-6): el número de preguntas sale del contenido, no del campo declarado.
        ...(st.questions >= 1 && st.questions !== p.interactions ? [`el video dice ${p.interactions} pregunta(s) y su contenido trae ${st.questions}`] : []),
        ...(st.singleCorrect !== st.questions ? [`${st.questions - st.singleCorrect} pregunta(s) del video no tienen exactamente una respuesta correcta`] : []),
      ];
    }
    case 'presentation': {
      const out: string[] = [];
      try { if (pdfPageCount(p.pdf) !== p.slideCount) out.push('el PDF no tiene las diapositivas que dice'); } catch { out.push('el PDF de la presentación no es válido'); }
      try { pngDimensions(p.cover); } catch { out.push('la portada no es un PNG válido'); }
      if (p.language !== 'es-419') out.push('la presentación no se pidió en español latinoamericano');
      return out;
    }
    case 'audio': return [...audioProblems(p, p.audio === 'audiobook' ? expect.chapters ?? p.chapters.map((c) => c.number) : []), ...audioRecountProblems(p)];
    case 'libro_pdf': return ['un PDF del Libro no es el resultado de una regeneración de actividad'];
  }
  return ['resultado desconocido'];
}

/** Preguntas de una práctica H5P contadas en su content.json (por tipo). */
export function practiceQuestionsOf(mainLibrary: string, content: any): number {
  const stars = (t: string) => Math.floor((String(t).match(/\*[^*\n]+\*/g) || []).length);
  if (/^H5P\.QuestionSet\b/.test(mainLibrary)) return Array.isArray(content?.questions) ? content.questions.length : 0;
  if (/^H5P\.DragText\b/.test(mainLibrary)) return stars(content?.textField ?? '');
  if (/^H5P\.Blanks\b/.test(mainLibrary)) return Array.isArray(content?.questions) ? stars(content.questions.join('\n')) : 0;
  if (/^H5P\.BranchingScenario\b/.test(mainLibrary)) {
    const xs = Array.isArray(content?.branchingScenario?.content) ? content.branchingScenario.content : [];
    return xs.filter((x: any) => /^H5P\.BranchingQuestion\b/.test(String(x?.type?.library ?? x?.library ?? ''))).length;
  }
  return 0;
}

/**
 * Fix round 1 (P2-6): duración y capítulos del audio RECONTADOS de los frames del MP3 (no de los campos declarados):
 * la duración total sale de los frames; en el audiolibro, los frames de cada capítulo suman los del archivo y cada
 * capítulo dura lo que dicen SUS frames.
 */
export function audioRecountProblems(p: Extract<ProducedRegen, { kind: 'audio' }>): string[] {
  let frames: Array<{ samples: number; sampleRate: number }>;
  try { frames = audioFramesOf(parseMp3(p.mp3)); } catch { return []; /* audioProblems ya lo informa */ }
  if (!frames.length) return [];
  const spf = frames[0].samples / frames[0].sampleRate;
  const total = frames.length * spf;
  const out: string[] = [];
  if (Math.abs(total - p.durationSec) > 0.05) out.push(`el audio dice durar ${p.durationSec.toFixed(1)} s y sus frames suman ${total.toFixed(1)} s`);
  if (p.audio === 'audiobook') {
    const declared = p.chapters.map((c) => (c as any).frames);
    if (declared.some((f) => !Number.isInteger(f) || f <= 0)) out.push('el audiolibro no trae los frames de cada capítulo para recontarlo');
    else {
      const sum = declared.reduce((a: number, b: number) => a + b, 0);
      if (sum !== frames.length) out.push(`los capítulos suman ${sum} frames y el MP3 trae ${frames.length}`);
      p.chapters.forEach((c, i) => { if (Math.abs(declared[i] * spf - c.seconds) > 0.05) out.push(`el capítulo ${c.number} dice ${c.seconds.toFixed(1)} s y sus frames dan ${(declared[i] * spf).toFixed(1)} s`); });
    }
  }
  return out;
}

/** sco / sco_data nuevos en su rango (60000+), sin repetir NINGÚN id del paquete. */
export async function scoIdAllocator(ctx: OpContext): Promise<() => number> {
  const used = new Set<number>();
  let max = 59_999;
  for (const n of ctx.state.names()) {
    if (!/\.xml$/i.test(n)) continue;
    const x = await ctx.state.readText(n);
    for (const m of x.matchAll(/\bid="(\d{1,15})"/g)) used.add(Number(m[1]));
    for (const m of x.matchAll(/<(sco|sco_data|sco_track|seq_[a-z_]+)\s+id="(\d{1,15})"/g)) max = Math.max(max, Number(m[2]));
  }
  let next = max + 1;
  return () => { while (used.has(next)) next++; used.add(next); return next++; };
}

async function applyScorm(ctx: OpContext, a: WorkshopActivity, p: Extract<ProducedRegen, { kind: 'scorm_v2' }>): Promise<void> {
  const html = fileOf(a, 'content', /^index\.html?$/i);
  const mf = fileOf(a, 'content', /^imsmanifest\.xml$/i);
  if (!html || !mf) throw new PatchError('unsupported', 'El juego SCORM no trae index.html e imsmanifest.xml en el paquete.');
  const ids = parseScormManifestIds(p.manifestXml);
  if (ids.launch.toLowerCase() !== html.filename.toLowerCase()) throw new PatchError('unsupported', `El manifiesto nuevo lanza «${ids.launch}» y el juego del curso es «${html.filename}».`);
  await replaceActivityFile(ctx, a, html, Buffer.from(p.html, 'utf8'));
  await replaceActivityFile(ctx, a, mf, Buffer.from(p.manifestXml, 'utf8'));
  const entry = `${a.dir}/scorm.xml`;
  let sx = await ctx.state.readText(entry);
  const pkg = fileOf(a, 'package', /\.zip$/i);
  if (pkg) {
    const old = await ctx.state.read(pkg.blobEntry);
    const z = await JSZip.loadAsync(old);
    const date = new Date(Date.UTC(2026, 0, 1));
    z.file(html.filename, p.html, { date, createFolders: false });
    z.file('imsmanifest.xml', p.manifestXml, { date, createFolders: false });
    const zip = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const nh = await replaceActivityFile(ctx, a, pkg, zip);
    if (/<sha1hash>[0-9a-f]*<\/sha1hash>/.test(sx)) sx = setTag(sx, 'sha1hash', nh);
    ctx.report.notes.push(`paquete ${pkg.filename} rearmado (index.html + imsmanifest.xml nuevos; ${Object.keys(z.files).length} entrada(s))`);
  }
  // scoes según el manifiesto nuevo: mismos ids si son 2 (organización + ítem); si no, ids nuevos en su rango.
  const scoes = /<scoes>([\s\S]*?)<\/scoes>/.exec(sx);
  if (!scoes) throw new PatchError('invariant', 'scorm.xml no trae <scoes>.');
  const scoIds = [...scoes[1].matchAll(/<sco id="(\d+)">/g)].map((m) => Number(m[1]));
  const dataIds = [...scoes[1].matchAll(/<sco_data id="(\d+)">/g)].map((m) => Number(m[1]));
  const take = await scoIdAllocator(ctx);
  const org = scoIds[0] ?? take();
  const itm = scoIds[1] ?? take();
  const d1 = dataIds[0] ?? take();
  const d2 = dataIds[1] ?? take();
  if (scoIds.length !== 2) ctx.report.notes.push(`scoes: el juego tenía ${scoIds.length} sco; queda con 2 (organización ${org}, ítem ${itm})`);
  for (const [k, v] of [['org', org], ['item', itm], ['d1', d1], ['d2', d2]] as const) if (!scoIds.includes(v) && !dataIds.includes(v)) (ctx.report.idsAssigned[`sco_${k}`] ||= []).push(v);
  const name = /<scorm id="\d+">\s*<name>([\s\S]*?)<\/name>/.exec(sx)?.[1] ?? xmlEsc(ids.title);
  const block = `<scoes>
      <sco id="${org}">
        <manifest>${xmlEsc(ids.manifest)}</manifest>
        <organization></organization>
        <parent>/</parent>
        <identifier>${xmlEsc(ids.organization)}</identifier>
        <launch></launch>
        <scormtype></scormtype>
        <title>${xmlEsc(ids.title)}</title>
        <sortorder>1</sortorder>
        <sco_datas></sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
      <sco id="${itm}">
        <manifest>${xmlEsc(ids.manifest)}</manifest>
        <organization>${xmlEsc(ids.organization)}</organization>
        <parent>${xmlEsc(ids.organization)}</parent>
        <identifier>${xmlEsc(ids.item)}</identifier>
        <launch>${xmlEsc(ids.launch)}</launch>
        <scormtype>sco</scormtype>
        <title>${name}</title>
        <sortorder>2</sortorder>
        <sco_datas>
          <sco_data id="${d1}"><name>isvisible</name><value>true</value></sco_data>
          <sco_data id="${d2}"><name>parameters</name><value></value></sco_data>
        </sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
    </scoes>`;
  const i0 = sx.indexOf('<scoes>');
  const i1 = sx.indexOf('</scoes>') + '</scoes>'.length;
  sx = sx.slice(0, i0) + block + sx.slice(i1);
  if (/<launch>\d*<\/launch>/.test(/<scorm id="\d+">[\s\S]*?<scoes>/.exec(sx)?.[0] ?? '')) {
    const head = sx.indexOf('<scoes>');
    sx = setTag(sx.slice(0, head), 'launch', String(itm)) + sx.slice(head);
  }
  ctx.state.write(entry, sx);
  noteModified(ctx, entry);
  ctx.report.notes.push(`juego rehecho: ${p.rooms} salas (${p.roomAssignment.join(', ')})`);
}

export async function applyRegenerate(ctx: OpContext, op: RegenerateOp): Promise<void> {
  const a = ctx.inv.activities.find((x) => x.moduleId === op.moduleId);
  if (!a || a.missingFolder) throw new PatchError('target_not_found', `La actividad ${op.moduleId} no está en el paquete.`);
  const p = op.produced;
  if (!p) throw new PatchError('invalid_params', 'Falta el resultado producido (la regeneración no corrió o no se cargó su artifact): no se aplica nada.');
  if (p.moduleId !== op.moduleId) throw new PatchError('invalid_params', 'El resultado producido es de otra actividad.');
  // Precondición: lo que se reemplaza es lo mismo que cuando se planeó.
  const hashes = new Set(a.files.map((f) => f.contenthash));
  for (const h of op.expect?.contenthashes ?? []) if (!hashes.has(h)) throw new PatchError('stale_target', `La actividad «${a.title}» cambió desde que se armó el plan (falta el archivo ${h.slice(0, 10)}…).`);
  const problems = await producedProblems(p, { chapters: p.kind === 'audio' && p.audio === 'audiobook' ? (op.summary?.chapters as number[] | undefined) : undefined });
  if (problems.length) throw new PatchError('invalid_content', `El resultado de «${a.title}» no es válido y no se aplica: ${problems.join('; ')}.`);
  const r = ctx.report;
  const kindOk = (op.op === 'regenerate_scorm' && (p.kind === 'scorm_v2' || p.kind === 'h5p_practice')) || (op.op === 'regenerate_video' && p.kind === 'video')
    || (op.op === 'regenerate_gamma' && p.kind === 'presentation') || (op.op === 'regenerate_audio' && p.kind === 'audio');
  if (!kindOk) throw new PatchError('invalid_params', `El resultado (${p.kind}) no corresponde a ${op.op}.`);
  switch (p.kind) {
    case 'scorm_v2':
      if (a.modname !== 'scorm') throw new PatchError('invalid_params', 'El juego nuevo es SCORM y la actividad no.');
      await applyScorm(ctx, a, p);
      r.summary = `${a.title} — juego rehecho (${p.rooms} salas)`;
      break;
    case 'h5p_practice': {
      const f = fileOf(a, 'package', /\.h5p$/i);
      if (a.modname !== 'h5pactivity' || !f) throw new PatchError('invalid_params', 'La práctica nueva es H5P y la actividad no trae su .h5p.');
      await replaceActivityFile(ctx, a, f, p.h5p);
      r.summary = `${a.title} — práctica H5P rehecha (${p.h5pType}, ${p.questions} pregunta(s))`;
      break;
    }
    case 'video': {
      const oldYt = typeof op.summary?.youtubeIdBefore === 'string' ? (op.summary.youtubeIdBefore as string) : null;
      const notes = oldYt ? await editIntro(ctx, a, (h) => matches(h, new RegExp(`(youtube\\.com/watch\\?v=|youtu\\.be/|youtube\\.com/embed/)${oldYt.replace(/[-]/g, '\\-')}`, 'g'), (m) => `${m[1]}${p.youtubeId}`, 'enlace de YouTube de la descripción actualizado')) : [];
      if (p.container === 'h5pactivity') {
        const f = fileOf(a, 'package', /\.h5p$/i);
        if (a.modname !== 'h5pactivity' || !f) throw new PatchError('invalid_params', 'El video nuevo es un .h5p y la actividad no trae su paquete.');
        await replaceActivityFile(ctx, a, f, p.h5p as Buffer);
      } else {
        if (a.modname !== 'hvp') throw new PatchError('invalid_params', 'El video nuevo es un hvp y la actividad no.');
        const entry = `${a.dir}/hvp.xml`;
        const x = await ctx.state.readText(entry);
        const i0 = x.indexOf('<json_content>');
        const i1 = x.indexOf('</json_content>');
        if (i0 < 0 || i1 < 0 || x.indexOf('<json_content>', i0 + 1) >= 0) throw new PatchError('invariant', 'hvp.xml no tiene exactamente un <json_content>.');
        const cur = x.slice(i0 + '<json_content>'.length, i1);
        if (op.expect?.jsonSha1 && sha1Of(cur) !== op.expect.jsonSha1) throw new PatchError('stale_target', `El video «${a.title}» cambió desde que se armó el plan.`);
        ctx.state.write(entry, x.slice(0, i0 + '<json_content>'.length) + xmlEsc(p.hvpJson as string) + x.slice(i1));
        noteModified(ctx, entry);
        r.fields.push({ entry, field: 'json_content', moduleId: a.moduleId, sectionId: null, before: `(video ${oldYt ?? '—'}, ${op.summary?.questionsBefore ?? '?'} pregunta(s))`, after: `(video ${p.youtubeId}, ${p.interactions} pregunta(s))`, beforeRawSha1: sha1Of(cur), afterRawSha1: sha1Of(xmlEsc(p.hvpJson as string)) });
      }
      r.notes.push(...notes, `video rehecho: ${p.youtubeId}, ${Math.round(p.durationSec)} s, ${p.interactions} pregunta(s)`);
      r.summary = `${a.title} — video rehecho (${p.interactions} pregunta(s))`;
      break;
    }
    case 'presentation': {
      const pdf = fileOf(a, 'intro', /\.pdf$/i);
      const png = fileOf(a, 'intro', /\.png$/i);
      if (!pdf || !png) throw new PatchError('invalid_params', 'La presentación del curso no trae su PDF y su portada.');
      await replaceActivityFile(ctx, a, pdf, p.pdf, 'application/pdf');
      await replaceActivityFile(ctx, a, png, p.cover, 'image/png');
      const notes = await editIntro(ctx, a, (h) => matches(h, /\(PDF, (\d+) diapositivas?\)/g, () => `(PDF, ${p.slideCount} diapositiva${p.slideCount === 1 ? '' : 's'})`, 'cantidad de diapositivas actualizada'));
      if (!notes.length) r.misalignment.push('El texto de la actividad no dice cuántas diapositivas tiene: no se cambió.');
      r.notes.push(...notes, `presentación rehecha: ${p.slideCount} diapositivas (es-419)`);
      r.summary = `${a.title} — presentación rehecha (${p.slideCount} diapositivas)`;
      break;
    }
    case 'audio': {
      const f = a.files.find((x) => x.filename !== '.' && /\.mp3$/i.test(x.filename));
      if (!f) throw new PatchError('invalid_params', 'La actividad no trae su MP3.');
      await replaceActivityFile(ctx, a, f, p.mp3, 'audio/mpeg');
      const dur = formatDurationEs(mp3DurationSeconds(p.mp3));
      const notes = await editIntro(ctx, a, (h) => matches(h, /(Duración(?: total)?: )(\d+ h )?\d+ min(?: \d+ s)?/g, (m) => `${m[1]}${dur}`, 'duración del audio actualizada'));
      if (!notes.length) r.misalignment.push('El texto de la actividad no dice la duración del audio: no se cambió.');
      r.notes.push(...notes, p.audio === 'audiobook' ? `audiolibro rehecho: ${p.chapters.length} capítulo(s), ${dur}` : `audio de bienvenida rehecho: ${dur}`);
      r.summary = `${a.title} — ${p.audio === 'audiobook' ? 'audiolibro' : 'audio de bienvenida'} rehecho (${dur})`;
      break;
    }
  }
}
