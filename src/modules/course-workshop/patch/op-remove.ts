/**
 * r107 B4 · `remove_activity` — quita UNA actividad del paquete:
 *   - su carpeta `activities/<modname>_<id>/` entera;
 *   - su `<activity>` en moodle_backup.xml (contents) y sus `<setting>` de nivel actividad;
 *   - su moduleid del `<sequence>` de su sección;
 *   - sus `<file>` de files.xml (contexto de la actividad) y los blobs que quedan huérfanos (un blob que otra entrada
 *     sigue usando se conserva);
 *   - si es un examen: sus categorías del banco (contexto del quiz) en questions.xml;
 *   - los tokens que la nombraban (`referencedBy*` de B2) en OTRAS actividades, secciones y el resumen del curso se
 *     sanean: el enlace `<a href="…token…">texto</a>` se reemplaza por su texto (el botón deja de ser un botón que no
 *     lleva a ningún lado). Un token fuera de un enlace (iframe, imagen, texto) no se puede sanear → la operación falla.
 * Nunca deja una sección sin actividades si antes tenía, nunca quita el último examen del curso, y falla si algo del
 * curso depende de la actividad (condiciones de acceso, finalización del curso, insignias).
 */
import { WorkshopHtmlField } from '../course-model';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { sha1Of } from './container';
import { editToken, locateField, validateNewHtml, writeField } from './html-edit';
import { OpContext, blobPath, noteModified } from './op-context';
import { PatchError, RemoveActivityOp } from './types';
import { matchBlocks, tagInner } from '../xml-scan';

/** Quita un bloque `<tag>…</tag>` (con la sangría y el salto de línea anteriores) por posición. */
function cutBlock(xml: string, start: number, end: number): string {
  const ls = xml.lastIndexOf('\n', start - 1);
  const from = ls >= 0 && /^\s*$/.test(xml.slice(ls, start)) ? ls : start;
  return xml.slice(0, from) + xml.slice(end);
}

export async function applyRemoveActivity(ctx: OpContext, op: RemoveActivityOp): Promise<void> {
  const { state, inv, report: r } = ctx;
  const a = inv.activities.find((x) => x.moduleId === op.moduleId);
  if (!a) throw new PatchError('target_not_found', `No existe la actividad ${op.moduleId}.`);
  const quizzes = inv.activities.filter((x) => x.modname === 'quiz' && !x.missingFolder);
  if (a.modname === 'quiz' && quizzes.length <= 1 && quizzes.some((x) => x.moduleId === a.moduleId)) throw new PatchError('invariant', `«${a.title}» es el último examen del curso: no se quita.`);
  const sec = inv.sections.find((s) => s.sequence.includes(a.moduleId)) ?? null;
  if (sec && sec.sequence.length === 1) throw new PatchError('invariant', `«${a.title}» es la única actividad de la sección «${sec.name}»: la sección quedaría vacía.`);
  const tag = `${a.modname}_${a.moduleId}`;

  // Dependencias que un saneo de tokens no resuelve.
  for (const x of inv.activities.filter((y) => y.moduleId !== a.moduleId && !y.missingFolder)) {
    const mx = `${x.dir}/module.xml`;
    if (!state.has(mx)) continue;
    const av = tagInner(await state.readText(mx), 'availability') ?? '';
    if (new RegExp(`(&quot;|")cm(&quot;|")\\s*:\\s*${a.moduleId}\\b`).test(av)) throw new PatchError('invariant', `«${x.title}» tiene una condición de acceso que depende de «${a.title}»: no se puede quitar sin cambiar esa condición.`);
  }
  for (const s of inv.sections) {
    if (!s.entry || !state.has(s.entry)) continue;
    const av = tagInner(await state.readText(s.entry), 'availabilityjson') ?? '';
    if (new RegExp(`(&quot;|")cm(&quot;|")\\s*:\\s*${a.moduleId}\\b`).test(av)) throw new PatchError('invariant', `La sección «${s.name}» tiene una condición de acceso que depende de «${a.title}».`);
  }
  // Fix round 1 (P2-2): dependencias por los ÍTEMS DE CALIFICACIÓN de la actividad (su grades.xml): condiciones de acceso
  // «por nota» (`{"type":"grade","id":<itemid>}`) y cálculos del libro de calificaciones (`##gi<itemid>##`); y bloques
  // cuya configuración nombra la actividad. No se limpian: la operación falla con el motivo.
  const gradesEntry = `${a.dir}/grades.xml`;
  const itemIds = state.has(gradesEntry) ? [...(await state.readText(gradesEntry)).matchAll(/<grade_item id="(\d+)">/g)].map((m) => Number(m[1])) : [];
  if (itemIds.length) {
    const gradeCond = new RegExp(`(?:&quot;|")type(?:&quot;|")\\s*:\\s*(?:&quot;|")grade(?:&quot;|")\\s*,\\s*(?:&quot;|")id(?:&quot;|")\\s*:\\s*(${itemIds.join('|')})\\b`);
    const calc = new RegExp(`##gi(${itemIds.join('|')})##`);
    for (const n of state.names()) {
      if (!/\.xml$/.test(n) || n.startsWith(`${a.dir}/`)) continue;
      if (!/(^|\/)(module|section|grades|gradebook)\.xml$/.test(n)) continue;
      const x = await state.readText(n);
      if (gradeCond.test(x)) throw new PatchError('invariant', `${n} tiene una condición de acceso por la NOTA de «${a.title}»: no se puede quitar sin cambiar esa condición.`);
      if (calc.test(x)) throw new PatchError('invariant', `${n} tiene un cálculo de calificación que usa la nota de «${a.title}» (##gi…##): no se quita.`);
    }
  }
  for (const n of state.names().filter((x) => /(^|\/)blocks\/[^/]+\/block\.xml$/.test(x))) {
    const cfg = /<configdata>([^<]*)<\/configdata>/.exec(await state.readText(n))?.[1] ?? '';
    if (!cfg) continue;
    let dec = '';
    try { dec = Buffer.from(cfg, 'base64').toString('latin1'); } catch { dec = ''; }
    if (new RegExp(`"${a.modname}-${a.moduleId}"|s:\\d+:"${a.moduleId}"|i:${a.moduleId};`).test(dec)) throw new PatchError('invariant', `La configuración del bloque ${n.split('/').slice(-2, -1)[0]} nombra a «${a.title}»: no se quita (el bloque quedaría apuntando a una actividad que no existe).`);
  }
  if (state.has('completion.xml') && new RegExp(`<moduleinstance>${a.moduleId}</moduleinstance>`).test(await state.readText('completion.xml'))) throw new PatchError('invariant', `La finalización del curso depende de «${a.title}»: no se quita.`);
  if (state.has('badges.xml') && new RegExp(`<name>module_${a.moduleId}</name>`).test(await state.readText('badges.xml'))) throw new PatchError('invariant', `Una insignia del curso depende de «${a.title}»: no se quita.`);

  // 1. Tokens que la nombran, en otras actividades / secciones / el resumen del curso.
  const targets: Array<{ f: WorkshopHtmlField; where: string; moduleId: number | null; sectionId: number | null; files: string[]; tokens: string[] }> = [];
  const pointsHere = (t: { targetModuleId: number | null }) => t.targetModuleId === a.moduleId;
  const anchored = [...inv.activities.flatMap((x) => x.tokens), ...inv.sections.flatMap((s) => s.tokens), ...inv.courseSummary.tokens].find((t) => t.anchor?.type === 'module' && t.anchor.id === a.moduleId);
  if (anchored) throw new PatchError('unsupported', `Un enlace «${anchored.token}#module-${a.moduleId}» (${anchored.entry}) lleva a «${a.title}» por ancla: no se sanea sin tocar otros enlaces del mismo token.`);
  for (const x of inv.activities) {
    if (x.moduleId === a.moduleId) continue;
    for (const f of x.html) {
      const tk = x.tokens.filter((t) => pointsHere(t) && t.entry === f.entry && t.field === f.field).map((t) => t.token);
      if (tk.length) targets.push({ f, where: `${x.dir} (${f.field})`, moduleId: x.moduleId, sectionId: null, files: x.files.map((y) => y.filename), tokens: tk });
    }
    if (x.tokens.some((t) => pointsHere(t) && t.entry === 'questions.xml')) throw new PatchError('unsupported', `Una pregunta de «${x.title}» enlaza a «${a.title}»: no se sanea texto de preguntas con esta operación.`);
  }
  for (const s of inv.sections) for (const f of s.html) {
    const tk = s.tokens.filter((t) => pointsHere(t) && t.field === f.field).map((t) => t.token);
    if (tk.length) targets.push({ f, where: `sección ${s.number ?? s.id}`, moduleId: null, sectionId: s.id, files: [], tokens: tk });
  }
  for (const f of inv.courseSummary.html) {
    const tk = inv.courseSummary.tokens.filter((t) => pointsHere(t) && t.field === f.field).map((t) => t.token);
    if (tk.length) targets.push({ f, where: 'resumen del curso', moduleId: null, sectionId: null, files: [], tokens: tk });
  }
  // Misma entrada con varios campos: de atrás hacia adelante.
  targets.sort((x, y) => (x.f.entry < y.f.entry ? -1 : x.f.entry > y.f.entry ? 1 : y.f.rawOffset - x.f.rawOffset));
  for (const t of targets) {
    const loc = await locateField(state, t.f);
    let raw = loc.raw;
    const toks = [...new Set(t.tokens)];
    const notes: string[] = [];
    for (const tok of toks) {
      const res = editToken(raw, tok, 'unlink');
      raw = res.newRaw;
      notes.push(...res.notes);
    }
    if (raw === loc.raw) continue;
    validateNewHtml('', xmlUnescape(raw), { tokenCtx: ctx.tokenCtx, oldHtml: t.f.html, files: t.files, where: t.where });
    writeField(state, loc, raw);
    noteModified(ctx, loc.entry);
    r.fields.push({ entry: loc.entry, field: t.f.field, moduleId: t.moduleId, sectionId: t.sectionId, before: t.f.html, after: xmlUnescape(raw), beforeRawSha1: t.f.rawSha1, afterRawSha1: sha1Of(raw) });
    r.notes.push(`${t.where}: ${notes.join('; ')}`);
  }

  // 2. moodle_backup.xml: <activity> y sus <setting>.
  let mb = await state.readText('moodle_backup.xml');
  const am = matchBlocks(mb, /<activity>\s*<moduleid>(\d+)<\/moduleid>/, '</activity>').filter((m) => Number(m[1]) === a.moduleId);
  if (am.length !== 1) throw new PatchError('invariant', `moodle_backup.xml lista ${am.length} veces la actividad ${a.moduleId}.`);
  const cuts = [{ s: am[0].index ?? 0, e: (am[0].index ?? 0) + am[0][0].length }, ...matchBlocks(mb, /<setting>\s*<level>activity<\/level>\s*<activity>([^<]*)<\/activity>/, '</setting>').filter((m) => m[1] === tag).map((m) => ({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length }))];
  for (const c of cuts.sort((x, y) => y.s - x.s)) mb = cutBlock(mb, c.s, c.e);
  state.write('moodle_backup.xml', mb);
  noteModified(ctx, 'moodle_backup.xml');
  r.notes.push(`moodle_backup.xml: <activity> y ${cuts.length - 1} <setting> quitados`);

  // 3. <sequence> de su sección.
  if (sec && sec.entry) {
    const sx = await state.readText(sec.entry);
    const i = sx.indexOf('<sequence>');
    const j = sx.indexOf('</sequence>', i);
    if (i < 0 || j < 0) throw new PatchError('invariant', `${sec.entry} sin <sequence>.`);
    const seq = sx.slice(i + 10, j).split(',').filter((v) => v.trim() !== '' && Number(v) !== a.moduleId).join(',');
    state.write(sec.entry, sx.slice(0, i + 10) + seq + sx.slice(j));
    noteModified(ctx, sec.entry);
  }

  // 4. Carpeta.
  for (const n of state.names().filter((x) => x.startsWith(`${a.dir}/`))) { state.remove(n); r.entriesRemoved.push(n); }

  // 5. files.xml: los archivos de su contexto; blobs huérfanos fuera.
  if (a.contextId !== null && state.has('files.xml')) {
    let fx = await state.readText('files.xml');
    const mine = matchBlocks(fx, /<file id="(\d+)">/, '</file>').filter((m) => Number(/<contextid>(\d+)<\/contextid>/.exec(m[2])?.[1] ?? -1) === a.contextId);
    const hashes = new Set(mine.map((m) => /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(m[2])?.[1] ?? '').filter(Boolean));
    for (const m of mine.reverse()) fx = cutBlock(fx, m.index ?? 0, (m.index ?? 0) + m[0].length);
    if (mine.length) { state.write('files.xml', fx); noteModified(ctx, 'files.xml'); }
    let kept = 0;
    for (const h of hashes) {
      if (fx.includes(`<contenthash>${h}</contenthash>`)) { kept++; continue; }
      if (state.has(blobPath(h))) { state.remove(blobPath(h)); r.entriesRemoved.push(blobPath(h)); }
    }
    r.notes.push(`files.xml: ${mine.length} archivo(s) quitados; ${kept} blob(s) compartidos se conservan`);
  }

  // 6. Examen: sus categorías del banco (contexto del quiz).
  if (a.modname === 'quiz' && a.contextId !== null && state.has('questions.xml')) {
    let qx = await state.readText('questions.xml');
    const cats = matchBlocks(qx, /<question_category id="(\d+)">/, '</question_category>').filter((m) => Number(/<contextid>(\d+)<\/contextid>/.exec(m[2])?.[1] ?? -1) === a.contextId);
    const qids = cats.flatMap((m) => [...m[2].matchAll(/<question id="(\d+)">/g)].map((x) => Number(x[1])));
    for (const m of cats.reverse()) qx = cutBlock(qx, m.index ?? 0, (m.index ?? 0) + m[0].length);
    if (cats.length) { state.write('questions.xml', qx); noteModified(ctx, 'questions.xml'); }
    r.notes.push(`questions.xml: ${cats.length} categoría(s) del banco del examen quitadas (${qids.length} preguntas)`);
    const other = inv.activities.find((x) => x.kind === 'exam_answers' && x.unit === a.unit && x.moduleId !== a.moduleId);
    if (other) r.misalignment.push(`La página «${other.title}» (respuestas explicadas del examen quitado) sigue en el curso: quítala aparte si ya no corresponde.`);
  }
  if (a.placement.scope === 'chapter') r.misalignment.push(`El capítulo ${a.placement.chapterNumber} queda sin «${a.title}»: los textos que la mencionan (sin enlace) no se reescriben solos.`);
  r.summary = `Actividad «${a.title || a.dir}» (${a.dir}) quitada${targets.length ? `; ${targets.length} campo(s) que la enlazaban saneados` : ''}`;
}

