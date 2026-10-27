/**
 * Cursia V2 — r78 «Libro Guía en el celular»: versión de LECTURA EN LÍNEA del Libro Guía, como libro de Moodle
 * (mod_book), armada con EXACTAMENTE el mismo insumo que el PDF (`LibroV3Input` → `parseLibroMarkdown`, mismo parser,
 * mismos bloques, mismas referencias). Sin IA, sin regenerar ni reescribir nada.
 *
 * Por qué: el PDF (carta, cuerpo de 10,5 pt) queda en ≈ 6,7 px ajustado a un teléfono de 390 px (r77 §6); el texto del
 * libro en HTML fluye al ancho de la pantalla, a 18 px con interlineado 1,65, con los colores, fuentes y logo del tema.
 *
 * Capítulos del libro de Moodle (el índice y los botones anterior/siguiente de Moodle salen de esta lista):
 *   1. «Portada e índice» — marca, título, línea de cantidades y frase de la portada del PDF; enlace al PDF (descarga);
 *      índice con un enlace por módulo / capítulo / referencias (los capítulos de práctica, sin enlace, como en el PDF).
 *   2. por módulo: «Módulo N — título» (prefacio + «Al terminar este módulo podrás:») y, como subcapítulos, sus
 *      capítulos de contenido «Capítulo N. título» (markdown del capítulo + práctica guiada al final, como el PDF).
 *   3. «Referencias» / «Bibliografía» (si el PDF la tiene), con las mismas secciones y entradas.
 * Al pie de cada capítulo: «Siguiente: … →» (píldora ≥ 44 px), «← Anterior: …» y la vuelta a la portada, con tokens
 * `$@BOOKVIEWBYIDCH*mid*capítulo@$` que Moodle resuelve al restaurar (la app oficial abre el capítulo dentro del libro).
 *
 * Dos regímenes de Moodle (r77): todo el diseño va en estilos EN LÍNEA que sobreviven a HTMLPurifier (forceclean y la
 * app); el `<style>` del shell (ENHANCED) es solo una mejora. Sin `<script>`, sin media queries, sin scroll horizontal:
 * tablas `table-layout:fixed` a 100 % con guiones suaves en las celdas, bloques de código con `white-space:pre-wrap`.
 *
 * Paridad (falla fuerte): por capítulo, las palabras visibles del HTML (sin la navegación) = las del texto que dibuja
 * el PDF (`libroParityWords`, misma normalización). Nada se corta por tamaño: un libro grande queda completo.
 */
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio } from '../../modules/theme-engine';
import type { CourseIntroV3 } from '../../modules/course-shell/intro-schemas';
import { Decl, Hx, Surf, ShellRenderOptions, blockLink, bgSurf, hx, link, root, shellFail, st, surfOn, toneSurf, unprotectedText } from '../../modules/course-shell/html';
import { WelcomeIdentity, identityStrip } from '../../modules/course-shell/shell';
import { HtmlNode, lintCleanSafe, parseHtml } from '../../modules/visual-components/lint-output';
import { HYPHEN_DEFAULT, HYPHEN_HEADING, HyphenOpts, NOLINK_CLOSE, NOLINK_OPEN, nolinkRunHtml } from '../../modules/visual-components/text';
import { stripLeadingDuplicateTitle } from '../dynamic-mbz-builder';
import {
  Block, LIBRO_COVER_SENTENCE, LIBRO_TEXT_HTML, LIBRO_TEXT_PDF, LibroFrontMatter, LibroTextMode, LibroV3Module, Run,
  libroFrontMatterV3, libroParityWords, libroRunsText, parseLibroInline, parseLibroMarkdown,
} from './libro-v3';
import type { BibliographyEntry } from '../../modules/course-shell/intro-schemas';
import { xmlEsc } from '../mbz-common';

/** Nombre de la actividad (mod_book) en la sección 1. */
export const LIBRO_HTML_NAME = '📱 Libro Guía · lectura en el celular';
/** Botón de la tarjeta del Libro Guía hacia la lectura en línea. */
export const LIBRO_HTML_CTA_TEXT = 'Leer en el celular →';
/** Enlace de la portada del libro en línea al PDF (descarga / imprimir). */
export const LIBRO_HTML_PDF_LINK_TEXT = 'Descargar el Libro Guía en PDF';
/** Título del primer capítulo del libro de Moodle. */
export const LIBRO_HTML_COVER_TITLE = 'Portada e índice';
/** Primer id de capítulo (book_chapters) del respaldo: rango propio, como sco/sco_data. */
export const LIBRO_HTML_CHAPTER_ID_BASE = 80001;
/** idnumber del libro de Moodle. */
export const LIBRO_HTML_IDNUMBER = 'cv3:shell:libro_html';
/** Clases de lo que NO es texto del Libro (no entra en la paridad). */
export const LIBRO_HTML_NAV_CLASS = 'cvc-libro-nav';
export const LIBRO_HTML_TOC_CLASS = 'cvc-libro-toc';
const MONO = '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export interface LibroHtmlInput {
  courseTitle: string;
  courseIntro: CourseIntroV3;
  modules: LibroV3Module[];
  brandName?: string | null;
  practiceChapters?: Array<{ number: number; title: string; moduleNumber: number }>;
  programReferences?: string[];
}

export interface LibroHtmlNav {
  /** moduleid del libro (tokens BOOKVIEWBYIDCH). */
  bookMid: number;
  /** moduleid del recurso PDF del Libro Guía (enlace de descarga). */
  libroMid: number;
}

export type LibroHtmlChapterKind = 'cover' | 'module' | 'chapter' | 'references';

export interface LibroHtmlChapter {
  /** id del capítulo en el respaldo (book_chapters). */
  id: number;
  kind: LibroHtmlChapterKind;
  /** Clave de destino del PDF (`mod-N`, `cap-N`, `bibliografia`; la portada: `portada`). */
  key: string;
  title: string;
  subchapter: boolean;
  html: string;
  /** Archivos del capítulo (filearea mod_book/chapter, itemid = id): el logo de la portada, si el perfil lo muestra. */
  files: Array<{ name: string; data: Buffer; mime: string }>;
  /** Palabras del texto que el PDF dibuja para este capítulo (sin el título que Moodle pinta, salvo la portada). */
  expectedWords: number;
}

export interface LibroHtmlResult {
  chapters: LibroHtmlChapter[];
  /** Palabras visibles del libro en línea (texto del Libro, sin navegación). */
  words: number;
  /** Bytes del HTML (todos los capítulos). */
  bytes: number;
}

// ─── texto de los bloques (paridad) ───────────────────────────────────────

/** Texto de los bloques en el orden en que el PDF y el HTML los muestran (marcadores de lista numerada incluidos). */
export function libroBlocksText(bs: ReadonlyArray<Block>): string {
  const out: string[] = [];
  for (const b of bs) {
    if (b.t === 'h') out.push(b.text);
    else if (b.t === 'p' || b.t === 'callout') out.push(libroRunsText(b.runs));
    else if (b.t === 'list') b.items.forEach((it, k) => out.push(`${b.ordered ? `${(b.start ?? 1) + k}. ` : ''}${libroRunsText(it)}`));
    else if (b.t === 'quote') b.paras.forEach((p) => out.push(libroRunsText(p)));
    else if (b.t === 'table') {
      out.push(b.header.join(' '));
      for (const r of b.rows) out.push(r.join(' '));
    } else if (b.t === 'code') out.push(...b.lines);
  }
  return out.join('\n');
}

const bibEntryText = (b: BibliographyEntry, tx: LibroTextMode): { a: string; t: string; p: string } => ({
  a: tx.text(`${b.author} (${b.year}). `),
  t: tx.text(b.title),
  p: tx.text(`. ${b.publisher}.`),
});

const citedTail = (r: { chapters: number[] }): string => ` — ${r.chapters.length === 1 ? 'capítulo' : 'capítulos'} ${r.chapters.join(', ')}.`;
const CITED_NOTE = 'Documentos que el texto menciona. Consulta siempre su versión oficial vigente.';
const OUTCOMES_TITLE = 'Al terminar este módulo podrás:';

/** Partes de texto de un módulo (prefacio y logros), como las dibuja el PDF. */
function moduleParts(m: LibroV3Module, tx: LibroTextMode): { presentation: Run[][]; outcomes: Run[][] } {
  const presentation = String(m.intro.presentation ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => parseLibroInline(p.replace(/\n/g, ' '), tx));
  const outcomes = (m.intro.outcomes ?? []).map((o) => parseLibroInline(String(o), tx));
  return { presentation, outcomes };
}

function chapterBlocks(ch: { number: number; title: string; md: string; appendixMd?: string }, tx: LibroTextMode): Block[] {
  const md = stripLeadingDuplicateTitle(String(ch.md ?? ''), ch.title, ch.number);
  return [...parseLibroMarkdown(md, tx), ...(ch.appendixMd ? parseLibroMarkdown(String(ch.appendixMd), tx) : [])];
}

/** Texto que el PDF dibuja en la portada (sin la línea «LIBRO GUÍA», que el HTML también muestra). */
function coverText(fm: LibroFrontMatter): string {
  return [fm.brandName, 'Libro Guía', fm.courseTitle, fm.coverLine, LIBRO_COVER_SENTENCE].filter(Boolean).join('\n');
}

/** Texto del índice del PDF (sin números de página). */
export function libroTocText(input: LibroHtmlInput, tx: LibroTextMode): string {
  const fm = libroFrontMatterV3(input, tx);
  const out: string[] = ['Índice'];
  for (const m of input.modules) {
    out.push(`Módulo ${m.number} — ${tx.text(m.title)}`);
    for (const e of tocEntries(m, fm)) out.push(e.ch ? `Capítulo ${e.ch.number}. ${tx.text(e.ch.title)}` : `Capítulo ${e.p!.number}. ${tx.text(e.p!.title)} · capítulo de práctica (en el aula virtual)`);
  }
  if (fm.hasReferences) out.push(fm.refsTitle);
  return out.join('\n');
}

function tocEntries(m: LibroV3Module, fm: LibroFrontMatter): Array<{ ch: LibroV3Module['chapters'][number] | null; p: LibroFrontMatter['practice'][number] | null }> {
  const mp = fm.practice.filter((p) => p.moduleNumber === m.number);
  return [...m.chapters.map((ch) => ({ ch, p: null })), ...mp.map((p) => ({ ch: null, p }))].sort(
    (a, b) => ((a.ch?.number ?? a.p?.number) as number) - ((b.ch?.number ?? b.p?.number) as number),
  );
}

/** Texto de las referencias como lo dibuja el PDF. */
function referencesText(fm: LibroFrontMatter, tx: LibroTextMode): string {
  const out: string[] = [];
  if (fm.bib.course.length) {
    out.push(fm.extraRefs ? 'Bibliografía verificada del curso' : 'Bibliografía general del curso');
    for (const b of fm.bib.course) { const e = bibEntryText(b, tx); out.push(e.a + e.t + e.p); }
  }
  for (const mb of fm.bib.modules) {
    out.push(`Módulo ${mb.number} — ${tx.text(mb.title)}`);
    for (const b of mb.entries) { const e = bibEntryText(b, tx); out.push(e.a + e.t + e.p); }
  }
  if (fm.programRefs.length) {
    out.push('Referencias del programa académico');
    out.push(...fm.programRefs);
  }
  if (fm.cited.length) {
    out.push('Normas y documentos citados en el texto', CITED_NOTE);
    for (const r of fm.cited) out.push(tx.text(r.label) + tx.text(citedTail(r)));
  }
  return out.join('\n');
}

/**
 * Texto visible de un HTML del libro en línea: sin <style>/<script> y sin lo marcado como navegación (`skip` clases).
 * Bloques separados por un salto (las palabras no se pegan entre párrafos).
 */
export function libroHtmlVisibleText(html: string, skip: ReadonlyArray<string> = [LIBRO_HTML_NAV_CLASS]): string {
  const out: string[] = [];
  const BLOCKS = new Set(['p', 'div', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'br']);
  const walk = (n: HtmlNode) => {
    if (n.kind === 'text') { out.push(n.text); return; }
    if (n.tag === 'style' || n.tag === 'script') return;
    const cls = (n.attrs.class || '').split(/\s+/);
    if (skip.some((c) => cls.includes(c))) return;
    if (BLOCKS.has(n.tag)) out.push('\n');
    n.children.forEach(walk);
    if (BLOCKS.has(n.tag)) out.push('\n');
  };
  walk(parseHtml(html));
  return out.join('');
}

// ─── HTML ──────────────────────────────────────────────────────────────────

interface Ctx {
  h: Hx;
  s: Surf;
  accent: string;
}

function readableOn(t: ResolvedTheme, bg: string, cands: string[], fallback: string): string {
  return cands.find((c) => { try { return contrastRatio(c, bg) >= 4.5; } catch { return false; } }) ?? fallback;
}

function runsHtml(c: Ctx, runs: ReadonlyArray<Run>, s: Surf, hy: HyphenOpts = HYPHEN_DEFAULT): string {
  const linkCol = readableOn(c.h.t, s.bg, [c.h.t.color.accentStrong, c.h.t.color.accent], s.fg);
  return runs
    .map((r) => {
      let x = nolinkRunHtml(r.text, hy);
      // El tema de Moodle (Bootstrap) pinta <code> de rosa: color propio, el del texto de la superficie.
      if (r.code) x = `<code${st(c.h, [['color', s.fg], ['font-family', MONO], ['font-size', '0.95em']])}>${x}</code>`;
      if (r.i) x = `<em>${x}</em>`;
      if (r.b) x = `<strong>${x}</strong>`;
      if (r.link) x = `<a href="${attr(r.link)}" target="_blank" rel="noopener noreferrer"${st(c.h, [['color', linkCol], ['text-decoration', 'underline']])}>${x}</a>`;
      return x;
    })
    .join('');
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function para(c: Ctx, inner: string, s: Surf, extra: Decl[] = [], margin = '0 0 16px 0'): string {
  const ty = c.h.t.typography;
  const base: Decl[] = [['margin', margin], ['padding', 0], ['color', s.fg], ['font-size', ty.sizeBodyPx], ['line-height', String(ty.lineBody)], ['max-width', `${ty.measureCh}ch`]];
  const over = new Set(extra.map(([k]) => k));
  return `<p${st(c.h, [...base.filter(([k]) => !over.has(k)), ...extra])}>${inner}</p>`;
}

function hd(c: Ctx, tag: 'h3' | 'h4' | 'h5' | 'h6', text: string, s: Surf, o: { px: number; color?: string; margin?: string; weight?: number } = { px: 22 }): string {
  const t = c.h.t;
  return (
    `<${tag}${st(c.h, [
      ['margin', o.margin ?? '28px 0 12px 0'],
      ['padding', 0],
      ['color', o.color ?? s.fg],
      ['font-family', t.typography.fontHeading],
      ['font-size', o.px],
      ['font-weight', String(o.weight ?? t.typography.weightHeading)],
      ['line-height', '1.3'],
    ])}>${nolinkRunHtml(text, HYPHEN_HEADING)}</${tag}>`
  );
}

function boxWith(c: Ctx, tone: 'soft' | 'alt', inner: (s: Surf) => string): string {
  const cs = toneSurf(c.h, tone);
  return `<div${st(c.h, [['background-color', cs.s.bg], ['color', cs.s.fg], ['border', `1px solid ${cs.border}`], ['margin', '0 0 16px 0'], ['padding', '16px 20px']], [['border-radius', c.h.t.shape.radiusMd]])}>${inner(cs.s)}</div>`;
}

/** Guiones suaves de las celdas según la cantidad de columnas (cada columna cabe en ≈ 248 px a 320). */
function tableHyphens(n: number): { hy: HyphenOpts; pad: number } {
  const pad = n >= 4 ? 6 : 8;
  const inner = 248 / Math.max(1, n) - 2 * pad;
  const every = Math.max(2, Math.min(10, Math.floor(inner / 10.5)));
  return { hy: { minLen: Math.max(every + 2, n <= 2 ? 12 : every + 2), every }, pad };
}

function blocksHtml(c: Ctx, bs: ReadonlyArray<Block>): string {
  const t = c.h.t;
  const ty = t.typography;
  const s = c.s;
  const parts: string[] = [];
  for (const b of bs) {
    if (b.t === 'h') {
      const lvl = b.level <= 2 ? 'h4' : b.level === 3 ? 'h5' : 'h6';
      parts.push(hd(c, lvl, b.text, s, { px: b.level <= 2 ? 22 : b.level === 3 ? 20 : 18, color: b.level <= 2 ? c.accent : s.fg }));
    } else if (b.t === 'p') {
      parts.push(para(c, runsHtml(c, b.runs, s), s));
    } else if (b.t === 'callout') {
      parts.push(boxWith(c, 'soft', (bs2) => para(c, runsHtml(c, b.runs, bs2), bs2, [], '0')));
    } else if (b.t === 'quote') {
      parts.push(boxWith(c, 'alt', (bs2) => b.paras.map((p, k) => para(c, runsHtml(c, p, bs2), { ...bs2, fg: bs2.fg2 }, [['font-style', 'italic']], k === b.paras.length - 1 ? '0' : '0 0 12px 0')).join('')));
    } else if (b.t === 'list') {
      const li = (inner: string, extra: Decl[]) => `<li${st(c.h, [['margin', '0 0 10px 0'], ['color', s.fg], ['font-size', ty.sizeBodyPx], ['line-height', String(ty.lineBody)], ...extra])}>${inner}</li>`;
      if (b.ordered) {
        // Números como TEXTO (igual que el PDF): «3.» sigue siendo 3 sin depender de `start` ni de list-style.
        const items = b.items.map((it, k) => li(`<strong${st(c.h, [['color', c.accent]])}>${NOLINK_OPEN}${(b.start ?? 1) + k}.${NOLINK_CLOSE}</strong>${NOLINK_OPEN} ${NOLINK_CLOSE}${runsHtml(c, it, s)}`, [['padding', '0 0 0 2em'], ['text-indent', '-2em']]));
        parts.push(`<ol${st(c.h, [['list-style', 'none'], ['margin', '0 0 16px 0'], ['padding', 0]])}>${items.join('')}</ol>`);
      } else {
        const items = b.items.map((it) => li(runsHtml(c, it, s), [['padding', 0]]));
        parts.push(`<ul${st(c.h, [['list-style', 'disc'], ['margin', '0 0 16px 0'], ['padding', '0 0 0 24px']])}>${items.join('')}</ul>`);
      }
    } else if (b.t === 'table') {
      const n = b.header.length;
      if (!n) continue;
      const { hy, pad } = tableHyphens(n);
      const head = toneSurf(c.h, 'alt').s;
      const cell = (txt: string, th: boolean) =>
        `<${th ? 'th' : 'td'}${st(c.h, [
          ...(th ? ([['background-color', head.bg]] as Decl[]) : []),
          ['color', th ? head.fg : s.fg],
          ['border', `1px solid ${t.color.border}`],
          ['padding', `${pad}px`],
          ['text-align', 'left'],
          ['vertical-align', 'top'],
          ['font-size', 16],
          ['line-height', '1.45'],
          ...(th ? ([['font-weight', '700']] as Decl[]) : []),
        ])}>${txt ? nolinkRunHtml(txt, hy) : ''}</${th ? 'th' : 'td'}>`;
      parts.push(
        `<table${st(c.h, [['width', '100%'], ['max-width', '100%'], ['table-layout', 'fixed'], ['border-collapse', 'collapse'], ['margin', '0 0 20px 0'], ['background-color', s.bg], ['color', s.fg]])}>` +
          `<thead><tr>${b.header.map((x) => cell(x, true)).join('')}</tr></thead>` +
          `<tbody>${b.rows.map((r) => `<tr>${r.map((x) => cell(x, false)).join('')}</tr>`).join('')}</tbody></table>`,
      );
    } else if (b.t === 'code') {
      parts.push(
        boxWith(c, 'alt', (bs2) =>
          `<div${st(c.h, [['margin', 0], ['padding', 0], ['color', bs2.fg], ['font-family', MONO], ['font-size', 16], ['line-height', '1.5'], ['white-space', 'pre-wrap']])}>` +
          b.lines.map((l) => `<div${st(c.h, [['margin', 0], ['padding', 0]])}>${l.trim() ? nolinkRunHtml(l.replace(/ {2,}/g, (m) => ' '.repeat(m.length - 1) + ' ').replace(/^ /, ' '), { minLen: 18, every: 9 }) : '&nbsp;'}</div>`).join('') +
          `</div>`),
      );
    } else if (b.t === 'hr') {
      parts.push(`<div${st(c.h, [['margin', '8px 0 24px 0'], ['border-top', `1px solid ${t.color.border}`]])}></div>`);
    }
  }
  return parts.join('');
}

const bookTok = (nav: LibroHtmlNav, chapterId: number) => `$@BOOKVIEWBYIDCH*${nav.bookMid}*${chapterId}@$`;

function navHtml(c: Ctx, nav: LibroHtmlNav, prev: LibroHtmlChapter | null, next: LibroHtmlChapter | null, cover: LibroHtmlChapter): string {
  const s = c.s;
  const parts: string[] = [];
  if (next) parts.push(link(c.h, bookTok(nav, next.id), `Siguiente: ${next.title} →`, s, { button: true, margin: '0 0 8px 0' }));
  if (prev) parts.push(blockLink(c.h, bookTok(nav, prev.id), `← Anterior: ${prev.title}`, s, { margin: '0' }));
  if (prev && prev.id !== cover.id) parts.push(blockLink(c.h, bookTok(nav, cover.id), 'Volver al índice del Libro Guía', s, { margin: '0' }));
  return `<div class="${LIBRO_HTML_NAV_CLASS}"${st(c.h, [['margin', '32px 0 0 0'], ['padding', '20px 0 0 0'], ['border-top', `1px solid ${c.h.t.color.border}`]])}>${parts.join('')}</div>`;
}

/**
 * Libro Guía en línea. `nav` da los moduleid (libro y PDF) para los enlaces; `identity` = logo + nombre de la portada
 * (solo si el perfil muestra la marca en el curso, igual que la bienvenida). Falla fuerte si un capítulo no pasa
 * CLEAN_SAFE, tiene texto sin protección de filtros o pierde texto frente al del PDF.
 */
export function renderLibroHtmlV3(
  input: LibroHtmlInput,
  theme: ResolvedTheme,
  opts: ShellRenderOptions | undefined,
  nav: LibroHtmlNav,
  identity: (WelcomeIdentity & { file: { name: string; data: Buffer; mime: string } }) | null = null,
): LibroHtmlResult {
  if (!input.courseTitle || !Array.isArray(input.modules) || input.modules.length === 0) shellFail('Libro en línea: faltan el título del curso o los módulos');
  if (!Number.isInteger(nav.bookMid) || nav.bookMid < 1 || !Number.isInteger(nav.libroMid) || nav.libroMid < 1) shellFail('Libro en línea: moduleid inválido');
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const c: Ctx = { h, s, accent: readableOn(theme, s.bg, [theme.color.accentStrong, theme.color.accent], s.fg) };
  const fm = libroFrontMatterV3(input, LIBRO_TEXT_HTML);
  const fmPdf = libroFrontMatterV3(input, LIBRO_TEXT_PDF);

  // ── lista de capítulos (ids y títulos primero: la navegación los necesita) ──
  type Draft = Omit<LibroHtmlChapter, 'html' | 'expectedWords'> & { body: () => string; expected: string };
  let nextId = LIBRO_HTML_CHAPTER_ID_BASE;
  const drafts: Draft[] = [];
  const cover: Draft = { id: nextId++, kind: 'cover', key: 'portada', title: LIBRO_HTML_COVER_TITLE, subchapter: false, files: [], body: () => '', expected: coverText(fmPdf) };
  drafts.push(cover);
  const byKey = new Map<string, Draft>();
  for (const m of input.modules) {
    const mp = moduleParts(m, LIBRO_TEXT_PDF);
    const md: Draft = {
      id: nextId++, kind: 'module', key: `mod-${m.number}`, title: `Módulo ${m.number} — ${LIBRO_TEXT_HTML.text(m.title).trim()}`, subchapter: false, files: [],
      body: () => moduleBody(m), expected: [...mp.presentation.map(libroRunsText), ...(mp.outcomes.length ? [OUTCOMES_TITLE, ...mp.outcomes.map(libroRunsText)] : [])].join('\n'),
    };
    drafts.push(md);
    byKey.set(md.key, md);
    for (const ch of m.chapters) {
      const d: Draft = {
        id: nextId++, kind: 'chapter', key: `cap-${ch.number}`, title: `Capítulo ${ch.number}. ${LIBRO_TEXT_HTML.text(ch.title).trim()}`, subchapter: true, files: [],
        body: () => blocksHtml(c, chapterBlocks(ch, LIBRO_TEXT_HTML)), expected: libroBlocksText(chapterBlocks(ch, LIBRO_TEXT_PDF)),
      };
      drafts.push(d);
      byKey.set(d.key, d);
    }
  }
  if (fm.hasReferences) {
    const d: Draft = { id: nextId++, kind: 'references', key: 'bibliografia', title: fm.refsTitle, subchapter: false, files: [], body: () => referencesBody(), expected: referencesText(fmPdf, LIBRO_TEXT_PDF) };
    drafts.push(d);
    byKey.set(d.key, d);
  }
  for (const d of drafts) d.title = d.title.length > 255 ? `${[...d.title].slice(0, 254).join('')}…` : d.title;

  function moduleBody(m: LibroV3Module): string {
    const mp = moduleParts(m, LIBRO_TEXT_HTML);
    return (
      mp.presentation.map((p) => para(c, runsHtml(c, p, s), s)).join('') +
      (mp.outcomes.length
        ? hd(c, 'h4', OUTCOMES_TITLE, s, { px: 20 }) +
          `<ul${st(h, [['list-style', 'disc'], ['margin', '0 0 16px 0'], ['padding', '0 0 0 24px']])}>` +
          mp.outcomes.map((o) => `<li${st(h, [['margin', '0 0 10px 0'], ['padding', 0], ['color', s.fg], ['font-size', theme.typography.sizeBodyPx], ['line-height', String(theme.typography.lineBody)]])}>${runsHtml(c, o, s)}</li>`).join('') +
          `</ul>`
        : '')
    );
  }

  function referencesBody(): string {
    const parts: string[] = [];
    const entry = (inner: string) => para(c, inner, s, [['padding', '0 0 0 12px']], '0 0 10px 0');
    if (fm.bib.course.length) {
      parts.push(hd(c, 'h4', fm.extraRefs ? 'Bibliografía verificada del curso' : 'Bibliografía general del curso', s, { px: 20, color: c.accent }));
      for (const b of fm.bib.course) { const e = bibEntryText(b, LIBRO_TEXT_HTML); parts.push(entry(nolinkRunHtml(e.a) + `<em>${nolinkRunHtml(e.t)}</em>` + nolinkRunHtml(e.p))); }
    }
    for (const mb of fm.bib.modules) {
      parts.push(hd(c, 'h4', `Módulo ${mb.number} — ${LIBRO_TEXT_HTML.text(mb.title)}`, s, { px: 20, color: c.accent }));
      for (const b of mb.entries) { const e = bibEntryText(b, LIBRO_TEXT_HTML); parts.push(entry(nolinkRunHtml(e.a) + `<em>${nolinkRunHtml(e.t)}</em>` + nolinkRunHtml(e.p))); }
    }
    if (fm.programRefs.length) {
      parts.push(hd(c, 'h4', 'Referencias del programa académico', s, { px: 20, color: c.accent }));
      for (const r of fm.programRefs) parts.push(entry(nolinkRunHtml(r)));
    }
    if (fm.cited.length) {
      parts.push(hd(c, 'h4', 'Normas y documentos citados en el texto', s, { px: 20, color: c.accent }));
      parts.push(para(c, `<em>${nolinkRunHtml(CITED_NOTE)}</em>`, { ...s, fg: s.fg2 }));
      for (const r of fm.cited) parts.push(entry(`<strong>${nolinkRunHtml(LIBRO_TEXT_HTML.text(r.label))}</strong>${nolinkRunHtml(citedTail(r))}`));
    }
    return parts.join('');
  }

  function coverBody(): string {
    const ty = theme.typography;
    const parts: string[] = [];
    if (identity) {
      parts.push(identityStrip(h, identity, s));
      cover.files.push(identity.file);
    }
    if (fm.brandName && !(identity && identity.name)) parts.push(para(c, nolinkRunHtml(fm.brandName), s, [['font-weight', '700'], ['color', c.accent]], '0 0 8px 0'));
    parts.push(`<p class="cvc-meta cvc-kicker"${st(h, [['margin', '0 0 8px 0'], ['padding', 0], ['color', c.accent], ['font-family', theme.personality.fontMeta], ['font-size', ty.sizeMetaPx], ['font-weight', '700'], ['line-height', '1.4'], ['letter-spacing', '0.08em'], ['text-transform', 'uppercase']])}>${nolinkRunHtml('Libro Guía')}</p>`);
    parts.push(hd(c, 'h3', fm.courseTitle, s, { px: ty.sizeTitlePx, margin: '0 0 16px 0' }));
    parts.push(para(c, nolinkRunHtml(fm.coverLine), { ...s, fg: s.fg2 }, [], '0 0 8px 0'));
    parts.push(para(c, nolinkRunHtml(LIBRO_COVER_SENTENCE), { ...s, fg: s.fg2 }));
    parts.push(`<div class="${LIBRO_HTML_NAV_CLASS}"${st(h, [['margin', '0 0 8px 0'], ['padding', 0]])}>${blockLink(h, `$@RESOURCEVIEWBYID*${nav.libroMid}@$`, LIBRO_HTML_PDF_LINK_TEXT, s, { target: '_blank' })}</div>`);
    // Índice (el del PDF, sin números de página): un enlace por módulo, capítulo y referencias.
    const toc: string[] = [hd(c, 'h4', 'Índice', s, { px: 22, color: c.accent, margin: '24px 0 4px 0' })];
    const tocLink = (key: string, text: string, indent: number, bold: boolean) => {
      const d = byKey.get(key);
      if (!d) shellFail(`Libro en línea: el índice apunta a ${key}, que no está en el libro`);
      toc.push(bold ? `<div${st(h, [['margin', 0], ['padding', 0], ['font-weight', '700']])}>${blockLink(h, bookTok(nav, d.id), text, s, { margin: '8px 0 0 0' })}</div>` : blockLink(h, bookTok(nav, d.id), text, s, { margin: `0 0 0 ${indent}px` }));
    };
    for (const m of input.modules) {
      tocLink(`mod-${m.number}`, `Módulo ${m.number} — ${LIBRO_TEXT_HTML.text(m.title)}`, 0, true);
      for (const e of tocEntries(m, fm)) {
        if (e.ch) tocLink(`cap-${e.ch.number}`, `Capítulo ${e.ch.number}. ${LIBRO_TEXT_HTML.text(e.ch.title)}`, 16, false);
        else if (e.p) toc.push(para(c, `<em>${nolinkRunHtml(`Capítulo ${e.p.number}. ${LIBRO_TEXT_HTML.text(e.p.title)} · capítulo de práctica (en el aula virtual)`)}</em>`, { ...s, fg: s.fg2 }, [['padding', '10px 0']], '0 0 0 16px'));
      }
    }
    if (fm.hasReferences) tocLink('bibliografia', fm.refsTitle, 0, true);
    parts.push(`<div class="${LIBRO_HTML_TOC_CLASS}"${st(h, [['margin', 0], ['padding', 0]])}>${toc.join('')}</div>`);
    return parts.join('');
  }
  cover.body = coverBody;

  // ── HTML de cada capítulo + paridad ──
  const chapters: LibroHtmlChapter[] = [];
  let words = 0;
  let bytes = 0;
  drafts.forEach((d, i) => {
    const body = d.body();
    const html = root(h, 'libro-online', body + navHtml(c, nav, i > 0 ? (drafts[i - 1] as unknown as LibroHtmlChapter) : null, i < drafts.length - 1 ? (drafts[i + 1] as unknown as LibroHtmlChapter) : null, cover as unknown as LibroHtmlChapter));
    const lint = lintCleanSafe(html);
    if (!lint.ok) shellFail(`Libro en línea «${d.title}»: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
    const unprotected = unprotectedText(html);
    if (unprotected.length) shellFail(`Libro en línea «${d.title}»: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
    // Paridad con el PDF (texto del capítulo; la portada sin su índice, que se compara aparte).
    const got = libroParityWords(libroHtmlVisibleText(html, [LIBRO_HTML_NAV_CLASS, LIBRO_HTML_TOC_CLASS]));
    const want = libroParityWords(d.expected);
    if (got.join(' ') !== want.join(' ')) {
      let k = 0;
      while (k < got.length && got[k] === want[k]) k++;
      throw new Error(`LIBRO_HTML_PARITY: «${d.title}»: el texto en línea difiere del PDF en la palabra ${k + 1} (en línea «${got.slice(k, k + 6).join(' ')}», PDF «${want.slice(k, k + 6).join(' ')}»; ${got.length} / ${want.length} palabras)`);
    }
    if (d.kind === 'cover') {
      const tg = libroParityWords(libroHtmlVisibleText(html, [LIBRO_HTML_NAV_CLASS]).slice(0)).slice(got.length);
      const tw = libroParityWords(libroTocText(input, LIBRO_TEXT_PDF));
      if (tg.join(' ') !== tw.join(' ')) throw new Error(`LIBRO_HTML_PARITY: el índice en línea difiere del índice del PDF (${tg.length} / ${tw.length} palabras)`);
    }
    words += got.length;
    bytes += Buffer.byteLength(html, 'utf8');
    chapters.push({ id: d.id, kind: d.kind, key: d.key, title: d.title, subchapter: d.subchapter, html, files: d.files, expectedWords: want.length });
  });
  return { chapters, words, bytes };
}

/**
 * `activities/book_<mid>/book.xml` (formato de respaldo de mod_book, igual en Moodle 4.1–4.5): sin numeración automática
 * (los títulos ya traen «Módulo N» / «Capítulo N»), navegación de texto, títulos de Moodle (customtitles 0) y los
 * capítulos de contenido como subcapítulos de su módulo. Mismo `xmlEsc` que el resto del paquete (CLAUDE.md).
 */
export function libroBookXml(p: { aid: number; mid: number; ctx: number; name: string; ts: number; chapters: ReadonlyArray<Pick<LibroHtmlChapter, 'id' | 'title' | 'subchapter' | 'html'>> }): string {
  const chapters = p.chapters
    .map((ch, i) => `      <chapter id="${ch.id}">
        <pagenum>${i + 1}</pagenum>
        <subchapter>${ch.subchapter ? 1 : 0}</subchapter>
        <title>${xmlEsc(ch.title)}</title>
        <content>${xmlEsc(ch.html)}</content>
        <contentformat>1</contentformat>
        <hidden>0</hidden>
        <timecreated>${p.ts}</timecreated>
        <timemodified>${p.ts}</timemodified>
        <importsrc></importsrc>
      </chapter>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="book" contextid="${p.ctx}">
  <book id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <numbering>0</numbering>
    <navstyle>2</navstyle>
    <customtitles>0</customtitles>
    <timecreated>${p.ts}</timecreated>
    <timemodified>${p.ts}</timemodified>
    <chapters>
${chapters}
    </chapters>
    <chaptertags>
    </chaptertags>
  </book>
</activity>`;
}
