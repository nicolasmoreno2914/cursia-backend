/**
 * r107 B10 · Fase 3 — FUENTE del texto de cada capítulo para rehacer sus actividades (guion del audiolibro, texto que
 * recibe Videogen y Gamma, preguntas del video, práctica H5P).
 *
 * Orden de preferencia (la más fiel primero, siempre visible en el ítem del plan como `origin`):
 *   1. `db`      — el markdown del capítulo guardado en la base (`dynamic_content_md` del run que armó el curso; lo
 *                  resuelve el servicio con el mismo alcance que B2 y lo pasa acá);
 *   2. `package_md` — el markdown que dejaron builders viejos DENTRO del paquete (`libro_capN.md`);
 *   3. `book`    — el capítulo del Libro en línea (mod_book, v3);
 *   4. `libro_html` — el capítulo del Libro Guía HTML (V1);
 *   5. `labels`  — los textos del capítulo en el curso (último recurso; solo si alcanza el mínimo de palabras).
 * Sin ninguna con el mínimo de palabras → el capítulo NO tiene fuente: la operación queda `unavailable` con el motivo
 * ANTES de gastar (nunca un guion inventado ni un audiolibro al que le falta un capítulo).
 *
 * Puro: lee del paquete con la función que se le pasa.
 */
import { WorkshopCourse, plainText } from '../course-model';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { allBlocks, replaceBlocks, stripCommentsAndBlocks, stripTags, tagInner } from '../xml-scan';
import { libroStructure } from '../patch/op-libro';
import { chapterPlainText } from '../plan/summary';

export type SourceOrigin = 'db' | 'package_md' | 'book' | 'libro_html' | 'labels';
export interface ChapterSource { number: number; title: string; md: string; words: number; origin: SourceOrigin }

/** Lo que el servicio trae de la base (opcional): markdown y Context Package por número de capítulo. */
export interface RegenDbSources {
  chapterMd: Map<number, string>;
  contextPackage: Map<number, unknown>;
  courseContext: Record<string, unknown> | null;
  /** Fix round 1 (P2-4): el empaquetado al que se ató la fuente (el que armó el `.mbz` identificado). */
  tiedTo?: { artifactId: string; jobId: string; runId: string } | null;
  /** Por qué NO hay fuente de la base para este paquete (no se pudo atar al empaquetado que lo armó). */
  unavailable?: string | null;
}

/**
 * Fix round 1 (P2-5): mínimo de palabras de la fuente de UN capítulo. El piso del audiolibro r19 (25 min) equivale a
 * AUDIOBOOK_FLOOR_SOURCE_WORDS ≈ 4148 palabras de fuente para todo el curso (≈ 461 por capítulo en el curso típico de 9);
 * 400 deja fuera los «capítulos» que en realidad son una etiqueta o un resumen (antes 120) y queda por encima del bloque
 * mínimo del guion (AUDIOBOOK_CHUNK_MIN_WORDS = 250). El piso total del audiolibro se exige aparte (resolveRegen).
 */
export const SOURCE_MIN_WORDS = 400;
const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) || []).length;

/** HTML → markdown simple (títulos `##`, párrafos y listas): suficiente para el guion y los prompts. */
export function htmlToMarkdown(html: string): string {
  let s = stripCommentsAndBlocks(String(html || ''));
  s = replaceBlocks(s, /<h1\b[^<>]*>/i, /<\/h1>/i, (b) => `\n\n# ${plainText(b.inner, 400)}\n\n`);
  s = replaceBlocks(s, /<h[2-3]\b[^<>]*>/i, /<\/h[2-3]>/i, (b) => `\n\n## ${plainText(b.inner, 400)}\n\n`);
  s = replaceBlocks(s, /<h[4-6]\b[^<>]*>/i, /<\/h[4-6]>/i, (b) => `\n\n### ${plainText(b.inner, 400)}\n\n`);
  s = replaceBlocks(s, /<li\b[^<>]*>/i, /<\/li>/i, (b) => `\n- ${plainText(b.inner, 4000)}`);
  s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');
  s = stripTags(s).replace(/&nbsp;/g, ' ');
  s = xmlUnescape(s);
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Capítulos del Libro en línea (mod_book) en orden: título + HTML. */
async function bookChapters(course: WorkshopCourse, read: (e: string) => Promise<Buffer | null>): Promise<Array<{ title: string; html: string }>> {
  const book = course.activities.find((a) => a.modname === 'book' && !a.missingFolder);
  if (!book) return [];
  const x = await read(`${book.dir}/book.xml`);
  if (!x) return [];
  const xml = x.toString('utf8');
  const out: Array<{ title: string; html: string; pagenum: number }> = [];
  for (const m of allBlocks(xml, /<chapter id="\d+">/, '</chapter>')) {
    const body = m.inner;
    const title = xmlUnescape(tagInner(body, 'title') ?? '');
    const html = xmlUnescape(tagInner(body, 'content') ?? '');
    const pagenum = Number(/<pagenum>(\d+)<\/pagenum>/.exec(body)?.[1] ?? out.length + 1);
    const sub = /<subchapter>1<\/subchapter>/.test(body);
    if (!sub) out.push({ title, html, pagenum });
  }
  return out.sort((a, b) => a.pagenum - b.pagenum);
}

/** Libro Guía HTML del paquete (V1): capítulo N → cuerpo HTML. */
async function libroHtmlChapters(course: WorkshopCourse, read: (e: string) => Promise<Buffer | null>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const l = course.libro.find((x) => x.format === 'html');
  if (!l) return out;
  const a = course.activities.find((x) => x.moduleId === l.moduleId);
  const f = a?.files.find((x) => x.filearea === 'content' && /\.html?$/i.test(x.filename) && x.blobPresent);
  if (!f) return out;
  const b = await read(f.blobEntry);
  if (!b) return out;
  const html = b.toString('utf8');
  const st = libroStructure(html);
  for (const c of st.chapters) if (c.complete) out.set(c.number, html.slice(c.headEnd, c.bodyEnd));
  return out;
}

/**
 * Fuente de CADA capítulo pedido (en orden). `missing` = los que no tienen ninguna fuente con el mínimo de palabras.
 */
export async function chapterSources(course: WorkshopCourse, numbers: number[], read: (e: string) => Promise<Buffer | null>, db: RegenDbSources | null): Promise<{ sources: ChapterSource[]; missing: number[] }> {
  const sources: ChapterSource[] = [];
  const missing: number[] = [];
  let book: Array<{ title: string; html: string }> | null = null;
  let libro: Map<number, string> | null = null;
  for (const n of numbers) {
    const ch = course.chapters.find((c) => c.number === n);
    const title = ch?.title ?? `Capítulo ${n}`;
    const cands: Array<{ md: string; origin: SourceOrigin }> = [];
    const dbMd = db?.chapterMd.get(n);
    if (typeof dbMd === 'string') cands.push({ md: dbMd, origin: 'db' });
    let pkgMd = '';
    for (const e of ch?.packageSources ?? []) if (/\.md$/i.test(e)) { const b = await read(e); if (b) pkgMd += `${b.toString('utf8')}\n`; }
    if (pkgMd.trim()) cands.push({ md: pkgMd.trim(), origin: 'package_md' });
    book ||= await bookChapters(course, read);
    const bc = book.find((x) => new RegExp(`^\\s*(?:Cap[íi]tulo|Cap\\.?)\\s*${n}\\b`, 'i').test(x.title)) ?? (book.length === course.chapters.length ? book[course.chapters.findIndex((c) => c.number === n)] : undefined);
    if (bc) cands.push({ md: htmlToMarkdown(bc.html), origin: 'book' });
    libro ||= await libroHtmlChapters(course, read);
    const lh = libro.get(n);
    if (lh) cands.push({ md: htmlToMarkdown(lh), origin: 'libro_html' });
    const lt = chapterPlainText(course, n, 40_000);
    if (lt) cands.push({ md: lt, origin: 'labels' });
    const pick = cands.find((c) => words(c.md) >= SOURCE_MIN_WORDS);
    if (!pick) { missing.push(n); continue; }
    sources.push({ number: n, title, md: pick.md, words: words(pick.md), origin: pick.origin });
  }
  return { sources, missing };
}

export const ORIGIN_ES: Record<SourceOrigin, string> = {
  db: 'el texto del capítulo guardado en Cursia',
  package_md: 'el texto del capítulo que trae el paquete',
  book: 'el capítulo del Libro en línea del curso',
  libro_html: 'el capítulo del Libro Guía del paquete',
  labels: 'los textos del capítulo en el curso',
};
