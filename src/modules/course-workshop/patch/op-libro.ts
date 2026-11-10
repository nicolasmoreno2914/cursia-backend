/**
 * r107 B4 · `edit_libro_section` — Libro Guía V1 (`libro_guia_completo.html` en un mod_resource, o el Libro como
 * página): reemplaza el CUERPO de capítulos, agrega los que faltan y, si el documento está cortado (bug #7 del
 * changelog: sanitizador de logs a 250 000 caracteres), lo RECOMPONE completo. Siempre cierra en `</html>`; blob nuevo
 * con su sha1 y files.xml al día en TODAS las entradas que usaban el viejo.
 *
 * Estructura que reconoce (la de `buildLibroHTML()` de 11-pdf.js): títulos `<h1..h3>` «Capítulo N: …» (o «Capítulo N —
 * …»), opcionalmente cada sección envuelta en `<div class="page">…</div>`. El cuerpo de un capítulo va desde el final
 * de su título hasta el primer límite: el cierre de su `<div class="page">`, el próximo título de nivel ≤ al suyo, o
 * `</body>`.
 *
 * Libro v3 (PDF del builder `libro-v3.ts`): regenerarlo exige la fuente (markdown por capítulo + portada + módulos), que
 * NO viene en el paquete ni en el inventario de B2 (solo referencias a artifacts de la base) → la operación se declara
 * NO DISPONIBLE con motivo (nunca un PDF a medias). El libro en línea (mod_book) se edita por capítulo con `edit_html`.
 */
import { libroChapterSequence } from '../diagnosis/checks';
import { plainText, WorkshopActivity } from '../course-model';
import { sha1Of } from './container';
import { locateField, writeField, xmlEsc } from './html-edit';
import { OpContext, blobPath, noteModified, replaceBlob } from './op-context';
import { EditLibroSectionOp, LibroChapterInput, PatchError } from './types';

const HEAD = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const CH_TITLE = /^\s*Cap[ií]tulo\s+(\d{1,3})\s*[:—–-]/i;
const htmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Heading { start: number; end: number; level: number; number: number | null; text: string }
interface ChapterBlock { number: number; level: number; headStart: number; headEnd: number; bodyEnd: number; blockStart: number; blockEnd: number; wrapped: boolean; complete: boolean }

/** Índice del `</div>` que cierra el `<div` que abre en `open` (o -1). */
function matchingDivClose(html: string, open: number): number {
  const re = /<div\b|<\/div\s*>/gi;
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0][1] === '/') { depth--; if (depth === 0) return m.index; } else depth++;
  }
  return -1;
}

/** `<div class="page">` abierto que contiene la posición `at`, o -1. */
function enclosingPage(html: string, at: number): number {
  const i = html.lastIndexOf('<div class="page">', at);
  if (i < 0) return -1;
  const close = matchingDivClose(html, i);
  return close < 0 || close > at ? i : -1;
}

export function libroStructure(html: string): { headings: Heading[]; chapters: ChapterBlock[]; bodyClose: number } {
  const headings: Heading[] = [...html.matchAll(HEAD)].map((m) => {
    const text = plainText(m[2], 200);
    const n = CH_TITLE.exec(text);
    return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, level: Number(m[1]), number: n ? Number(n[1]) : null, text };
  });
  const bodyCloseIdx = html.search(/<\/body\s*>/i);
  const bodyClose = bodyCloseIdx < 0 ? html.length : bodyCloseIdx;
  const chapters: ChapterBlock[] = [];
  headings.forEach((h, i) => {
    if (h.number === null) return;
    const page = enclosingPage(html, h.start);
    let bodyEnd = bodyClose;
    let complete = bodyCloseIdx >= 0;
    let blockEnd: number;
    for (const n of headings.slice(i + 1)) if (n.level <= h.level) { bodyEnd = Math.min(bodyEnd, n.start); complete = true; break; }
    if (page >= 0) {
      const close = matchingDivClose(html, page);
      if (close >= 0) { bodyEnd = Math.min(bodyEnd, close); complete = true; } else complete = false;
      // Fix round 1 (P2-4b): el pie de la página (`<div class="pg-ft">…</div>`, último hijo) NO es parte del cuerpo.
      if (close >= 0 && bodyEnd === close) {
        const ft = html.lastIndexOf('<div class="pg-ft">', close);
        if (ft > h.end) {
          const ftClose = matchingDivClose(html, ft);
          if (ftClose >= 0 && /^\s*$/.test(html.slice(ftClose + html.slice(ftClose).match(/^<\/div\s*>/i)![0].length, close))) bodyEnd = ft;
        }
      }
      blockEnd = close >= 0 ? close + html.slice(close).match(/^<\/div\s*>/i)![0].length : html.length;
    } else {
      blockEnd = bodyEnd;
    }
    chapters.push({ number: h.number, level: h.level, headStart: h.start, headEnd: h.end, bodyEnd, blockStart: page >= 0 ? page : h.start, blockEnd, wrapped: page >= 0, complete });
  });
  return { headings, chapters, bodyClose };
}

function validateChapterHtml(c: LibroChapterInput): void {
  if (!Number.isInteger(c.number) || c.number < 1) throw new PatchError('invalid_params', `Capítulo inválido: ${c.number}.`);
  if (typeof c.html !== 'string' || !plainText(c.html, 20)) throw new PatchError('invalid_content', `El capítulo ${c.number} viene vacío.`);
  if (/\$@[A-Z0-9_]+/.test(c.html)) throw new PatchError('invalid_content', `El capítulo ${c.number} trae un token $@…@$: dentro de un archivo Moodle no los resuelve.`);
  if (/<script\b/i.test(c.html)) throw new PatchError('invalid_content', `El capítulo ${c.number} trae <script>.`);
  if (/<\/?(html|head|body)\b/i.test(c.html)) throw new PatchError('invalid_content', `El capítulo ${c.number} trae <html>/<head>/<body>: va solo el cuerpo.`);
  if (CH_TITLE.test(plainText(c.html.match(/^\s*<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? '', 80))) throw new PatchError('invalid_content', `El cuerpo del capítulo ${c.number} empieza con su título: va solo el cuerpo (el título lo pone el motor).`);
}

/** Documento recompuesto + qué pasó con cada capítulo. */
export function recomposeLibro(html: string, input: EditLibroSectionOp, titleOf: (n: number) => string | null, courseChapters: number[], moduleOf: (n: number) => number | null = () => null): { html: string; notes: string[]; misalignment: string[] } {
  const notes: string[] = [];
  const misalignment: string[] = [];
  const byNum = new Map<number, LibroChapterInput>();
  for (const c of input.chapters) {
    validateChapterHtml(c);
    if (byNum.has(c.number)) throw new PatchError('invalid_params', `El capítulo ${c.number} viene dos veces.`);
    byNum.set(c.number, c);
  }
  const intact = /<\/html>\s*$/i.test(html);
  const st = libroStructure(html);
  const seq = st.chapters.map((c) => c.number);
  if (seq.some((n, i) => i > 0 && n <= seq[i - 1])) throw new PatchError('unsupported', `Los títulos de capítulo del Libro no siguen un orden (${seq.join(', ')}): no se puede ubicar cada capítulo con certeza.`);
  const level = st.chapters[0]?.level ?? 1;
  const wrapped = st.chapters.length ? st.chapters[0].wrapped : /<div class="page">/.test(html);
  const heading = (n: number, title: string | undefined) => {
    const t = title ?? titleOf(n);
    if (!t) throw new PatchError('invalid_params', `Falta el título del capítulo ${n} (no está en el Libro ni en el inventario).`);
    return `<h${level}>Capítulo ${n}: ${htmlEsc(t)}</h${level}>`;
  };
  // Fix round 1 (P2-4b): un capítulo agregado lleva el encabezado (pg-hd) y el pie (pg-ft) de las páginas de capítulo
  // del Libro: se copian de la primera página de capítulo completa.
  const tpl = st.chapters.find((c) => c.wrapped && c.complete);
  const pgHead = tpl ? html.slice(tpl.blockStart + '<div class="page">'.length, tpl.headStart) : '';
  const pgFoot = tpl ? html.slice(tpl.bodyEnd, tpl.blockEnd).replace(/<\/div\s*>\s*$/i, '') : '';
  const block = (c: LibroChapterInput) => (wrapped ? `<div class="page">${pgHead}${heading(c.number, c.title)}${c.html}${pgFoot}</div>` : `${heading(c.number, c.title)}${c.html}`);
  // Páginas de presentación de módulo («Módulo M …»): un capítulo agregado nunca queda del lado equivocado (P2-4a).
  const moduleBlocks = st.headings.filter((x) => x.number === null && /^\s*M[óo]dulo\s+(\d+)\b/i.test(x.text)).map((x) => {
    const page = enclosingPage(html, x.start);
    const close = page >= 0 ? matchingDivClose(html, page) : -1;
    const end = close >= 0 ? close + html.slice(close).match(/^<\/div\s*>/i)![0].length : (st.headings.find((y) => y.start > x.start && y.level <= x.level)?.start ?? st.bodyClose);
    return { module: Number(/M[óo]dulo\s+(\d+)/i.exec(x.text)![1]), start: page >= 0 ? page : x.start, end };
  });
  const insertAt = (n: number): number => {
    const m = moduleOf(n);
    const prev = [...st.chapters].reverse().find((c) => c.number < n);
    const next = st.chapters.find((c) => c.number > n);
    if (m !== null) {
      if (prev && moduleOf(prev.number) === m) return prev.blockEnd;
      if (next && moduleOf(next.number) === m) return next.blockStart;
      const mb = moduleBlocks.find((x) => x.module === m);
      if (mb) return mb.end;
    }
    const from = prev ? prev.blockEnd : 0;
    const to = next ? next.blockStart : st.bodyClose;
    if (moduleBlocks.some((x) => x.start >= from && x.start < to)) throw new PatchError('unsupported', `No se sabe de qué módulo es el capítulo ${n} y entre sus vecinos hay una presentación de módulo: no se ubica a ciegas.`);
    return prev ? prev.blockEnd : next ? next.blockStart : st.bodyClose;
  };

  if (intact) {
    if (!st.chapters.length) throw new PatchError('unsupported', 'El Libro no tiene títulos de capítulo con el formato del builder («Capítulo N: …»): no se puede ubicar cada capítulo con certeza (se editaría a ciegas).');
    if (input.front) throw new PatchError('invalid_params', 'El Libro está completo: la portada no se reemplaza con esta operación.');
    // Reemplazos de cuerpo / título (de atrás hacia adelante, por posición) e inserciones de los que faltan.
    const edits: Array<{ start: number; end: number; ins: string }> = [];
    for (const c of st.chapters) {
      const p = byNum.get(c.number);
      if (!p) continue;
      edits.push({ start: c.headEnd, end: c.bodyEnd, ins: p.html });
      if (p.title !== undefined) edits.push({ start: c.headStart, end: c.headEnd, ins: heading(c.number, p.title) });
      notes.push(`capítulo ${c.number}: cuerpo reemplazado${p.title !== undefined ? ' y título' : ''}`);
    }
    const missing = [...byNum.keys()].filter((n) => !seq.includes(n)).sort((a, b) => a - b);
    for (const n of missing) {
      const at = insertAt(n);
      edits.push({ start: at, end: at, ins: block(byNum.get(n)!) });
      notes.push(`capítulo ${n}: agregado (faltaba)`);
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = html;
    for (const e of edits) out = out.slice(0, e.start) + e.ins + out.slice(e.end);
    if (missing.length) misalignment.push('El índice del Libro no se regeneró: revisa que nombre los capítulos agregados.');
    return { html: out, notes, misalignment };
  }

  // Documento cortado: recomponer.
  const complete = st.chapters.filter((c) => c.complete);
  const firstCut = st.chapters.find((c) => !c.complete);
  let prefix: string;
  let keptUntil: number;
  let kept: number[];
  if (input.front) {
    if (typeof input.front.headHtml !== 'string' || typeof input.front.coverHtml !== 'string' || /<script\b/i.test(input.front.headHtml + input.front.coverHtml)) throw new PatchError('invalid_content', 'Portada / encabezado inválidos.');
    prefix = `<!DOCTYPE html><html lang="es"><head>${input.front.headHtml}</head><body>${input.front.coverHtml}`;
    keptUntil = -1;
    kept = [];
    notes.push('portada e índice: recompuestos desde la fuente');
  } else {
    const first = st.chapters[0];
    const head = first ? html.slice(0, first.blockStart) : html;
    if (!first || !/<\/head\s*>/i.test(head) || !/<body\b[^>]*>/i.test(head)) {
      throw new PatchError('invalid_params', 'El Libro está cortado antes del primer capítulo (portada o índice incompletos) y la operación no trae la portada (`front`): no se puede recomponer sin inventar.');
    }
    prefix = head;
    const lastComplete = complete.length ? complete[complete.length - 1] : null;
    keptUntil = lastComplete ? lastComplete.blockEnd : first.blockStart;
    kept = complete.map((c) => c.number);
    notes.push(`portada e índice: los del original; capítulos completos conservados: ${kept.join(', ') || 'ninguno'}`);
    if (firstCut) notes.push(`capítulo ${firstCut.number}: estaba cortado, se reemplaza entero`);
  }
  const body: string[] = [];
  if (keptUntil > 0) {
    // Lo que había entre la portada y el último capítulo completo, con los cuerpos pedidos reemplazados.
    const st2 = complete;
    let seg = html.slice(prefix.length, keptUntil);
    const off = prefix.length;
    const edits: Array<{ start: number; end: number; ins: string }> = [];
    for (const c of st2) {
      const p = byNum.get(c.number);
      if (!p) continue;
      edits.push({ start: c.headEnd - off, end: c.bodyEnd - off, ins: p.html });
      if (p.title !== undefined) edits.push({ start: c.headStart - off, end: c.headEnd - off, ins: heading(c.number, p.title) });
      notes.push(`capítulo ${c.number}: cuerpo reemplazado`);
    }
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) seg = seg.slice(0, e.start) + e.ins + seg.slice(e.end);
    body.push(seg);
  }
  const want = [...new Set([...courseChapters, ...byNum.keys()])].sort((a, b) => a - b).filter((n) => !kept.includes(n));
  const lacking = want.filter((n) => !byNum.has(n));
  if (lacking.length) throw new PatchError('invalid_params', `El Libro está cortado y faltan los capítulos ${lacking.join(', ')}: la fuente no los trae, no se puede recomponer sin inventar.`);
  if (kept.length && want.some((n) => n < kept[kept.length - 1])) throw new PatchError('unsupported', `Los capítulos ${want.join(', ')} irían antes de capítulos conservados: no se reordena un Libro cortado.`);
  for (const n of want) { body.push(block(byNum.get(n)!)); if (!kept.includes(n) && (!firstCut || n !== firstCut.number)) notes.push(`capítulo ${n}: agregado desde la fuente`); }
  misalignment.push('Lo que en el original seguía al corte y no es un capítulo (p. ej. la bibliografía) no se puede recuperar del paquete: revisa el final del Libro.');
  return { html: `${prefix}${body.join('')}</body></html>`, notes, misalignment };
}

export async function applyEditLibroSection(ctx: OpContext, op: EditLibroSectionOp): Promise<void> {
  const a = ctx.inv.activities.find((x) => x.moduleId === op.moduleId);
  if (!a) throw new PatchError('target_not_found', `No existe la actividad ${op.moduleId}.`);
  if (a.kind !== 'libro' && a.kind !== 'libro_mobile') throw new PatchError('invalid_params', `${a.dir} no es el Libro Guía (es ${a.kind}).`);
  if (!Array.isArray(op.chapters) || !op.chapters.length) throw new PatchError('invalid_params', 'Faltan los capítulos (`chapters`).');
  if (a.modname === 'book') {
    throw new PatchError('unavailable', 'El Libro en línea (mod_book, builder v3) se edita por capítulo con edit_html; su PDF no se puede regenerar desde el paquete (ver Libro v3).');
  }
  const titleOf = (n: number) => ctx.inv.chapters.find((c) => c.number === n)?.title ?? null;
  const courseChapters = ctx.inv.chapters.map((c) => c.number);
  const moduleOf = (n: number) => ctx.inv.chapters.find((c) => c.number === n)?.moduleNumber ?? null;
  if (a.modname === 'page') {
    const f = a.html.find((h) => h.field === 'content');
    if (!f) throw new PatchError('target_not_found', `${a.dir} no tiene contenido.`);
    const loc = await locateField(ctx.state, f);
    const res = recomposeLibro(f.html, op, titleOf, courseChapters, moduleOf);
    check(res.html, courseChapters, op);
    const raw = xmlEsc(res.html);
    writeField(ctx.state, loc, raw);
    noteModified(ctx, loc.entry);
    ctx.report.fields.push({ entry: loc.entry, field: 'content', moduleId: a.moduleId, sectionId: null, before: f.html, after: res.html, beforeRawSha1: f.rawSha1, afterRawSha1: sha1Of(raw) });
    finish(ctx, a, res);
    return;
  }
  if (a.modname !== 'resource') throw new PatchError('unsupported', `Libro en ${a.modname}: no soportado.`);
  const main = a.files.filter((x) => x.filearea === 'content' && x.filename !== '.');
  const lf = main.find((x) => /\.html?$/i.test(x.filename)) ?? main.find((x) => /\.pdf$/i.test(x.filename)) ?? main[0];
  if (!lf) throw new PatchError('target_not_found', `${a.dir} no trae archivo del Libro.`);
  if (/\.pdf$/i.test(lf.filename) || lf.mimetype === 'application/pdf') {
    throw new PatchError('unavailable', 'El Libro Guía es un PDF (builder v3): regenerarlo exige la fuente por capítulo (markdown, portada, módulos), que no viene en el paquete ni en el inventario. No disponible en esta fase: nunca un PDF a medias.');
  }
  if (!/\.html?$/i.test(lf.filename)) throw new PatchError('unsupported', `El Libro es «${lf.filename}»: solo HTML.`);
  if (!lf.blobPresent || !ctx.state.has(blobPath(lf.contenthash))) throw new PatchError('target_not_found', 'El archivo del Libro no viene en el paquete (blob faltante).');
  const buf = await ctx.state.read(blobPath(lf.contenthash));
  if (sha1Of(buf) !== lf.contenthash) throw new PatchError('stale_target', 'El blob del Libro no coincide con su sha1: no se edita un archivo dañado.');
  const html = buf.toString('utf8');
  const res = recomposeLibro(html, op, titleOf, courseChapters, moduleOf);
  check(res.html, courseChapters, op);
  const out = Buffer.from(res.html, 'utf8');
  await replaceBlob(ctx, lf.contenthash, out);
  ctx.report.fields.push({ entry: blobPath(sha1Of(out)), field: `file:${lf.filename}`, moduleId: a.moduleId, sectionId: null, before: html.length > 4000 ? `${html.slice(0, 1500)}…[${html.length} caracteres]…${html.slice(-1500)}` : html, after: res.html.length > 4000 ? `${res.html.slice(0, 1500)}…[${res.html.length} caracteres]…${res.html.slice(-1500)}` : res.html, beforeRawSha1: lf.contenthash, afterRawSha1: sha1Of(out) });
  finish(ctx, a, res);
}

function check(html: string, courseChapters: number[], op: EditLibroSectionOp): void {
  if (!/<\/html>\s*$/i.test(html)) throw new PatchError('invariant', 'El Libro recompuesto no cierra en </html>.');
  const seq = libroChapterSequence(html);
  const want = [...new Set([...courseChapters, ...op.chapters.map((c) => c.number)])];
  if (!seq.reliable) throw new PatchError('invariant', `El Libro resultante no tiene sus capítulos en orden (${seq.numbers.join(', ')}).`);
  const missing = want.filter((n) => !seq.numbers.includes(n));
  // Un Libro intacto al que ya le faltaban capítulos no se completa solo: eso lo dice el hallazgo, no el motor.
  if (missing.some((n) => op.chapters.some((c) => c.number === n))) throw new PatchError('invariant', `El Libro resultante no nombra los capítulos ${missing.join(', ')}.`);
}

function finish(ctx: OpContext, a: WorkshopActivity, res: { notes: string[]; misalignment: string[] }): void {
  ctx.report.notes.push(...res.notes);
  ctx.report.misalignment.push(...res.misalignment);
  ctx.report.misalignment.push('El audiolibro y los videos no se regeneran con este cambio (D7): si el capítulo cambió de fondo, pídelo aparte.');
  ctx.report.summary = `Libro Guía (${a.title || a.dir}): ${res.notes.join('; ')}`;
}
