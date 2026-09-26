/**
 * Cursia V2.1 — R12: Libro Guía v3 (audit §Q.6, §E S1.2).
 *
 * Es un ARCHIVO del resource (Moodle lo sirve crudo, sin `format_text`), así
 * que lleva un `<style>` completo con los tokens hex del tema resuelto (R1) y
 * CSS de impresión. Contenido, en el orden del Manifest (join por UUID):
 *   portada → índice → por módulo: prefacio (module_intro.presentation +
 *   outcomes) y sus capítulos (markdown de `content`) → bibliografía (la del
 *   curso y la de cada módulo, de los intros v3).
 * Siempre termina en `</html>` (mismo guard que el builder v1/v2).
 * Puro y determinístico.
 */
import type { ResolvedTheme } from '../../modules/theme-engine';
import { moduleColor } from '../../modules/theme-engine';
import type { BibliographyEntry, CourseIntroV3, ModuleIntroV3 } from '../../modules/course-shell/intro-schemas';
import { mdToHtmlBasic, stripLeadingDuplicateTitle } from '../dynamic-mbz-builder';

export interface LibroV3Chapter {
  number: number;
  title: string;
  md: string;
}

export interface LibroV3Module {
  number: number;
  title: string;
  intro: ModuleIntroV3;
  chapters: LibroV3Chapter[];
}

export interface LibroV3Input {
  courseTitle: string;
  theme: ResolvedTheme;
  courseIntro: CourseIntroV3;
  modules: LibroV3Module[];
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paragraphs(text: string): string {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * G6 M2: el Libro se sirve CRUDO en el origen de Moodle. `mdToHtmlBasic` (v1/v2,
 * byte-idéntico, no se toca) no escapa `"` ni filtra el esquema de los links.
 * Antes de convertir, cada link markdown se conserva solo si su URL es
 * http(s)/mailto/#ancla sin comillas ni `<>`; si no, queda solo el texto.
 */
export function sanitizeMarkdownLinks(md: string): string {
  const SAFE = /^(https?:\/\/|mailto:|#)[^"'<>\s`]*$/i;
  let prev: string;
  let cur = String(md ?? '');
  // Repetir hasta un punto fijo: quitar un link inseguro no puede dejar otro armado.
  do {
    prev = cur;
    cur = cur.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => (SAFE.test(url) ? m : text));
  } while (cur !== prev);
  return cur;
}

function biblioItem(b: BibliographyEntry): string {
  return `<li>${esc(b.author)} (${b.year}). <em>${esc(b.title)}</em>. ${esc(b.publisher)}.</li>`;
}

function dedupe(list: BibliographyEntry[]): BibliographyEntry[] {
  const seen = new Set<string>();
  const out: BibliographyEntry[] = [];
  for (const b of list) {
    const k = `${b.author}|${b.title}|${b.year}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

function css(t: ResolvedTheme): string {
  const c = t.color;
  const ty = t.typography;
  return [
    `html{background:${c.bg};}`,
    `body{margin:0;background:${c.bg};color:${c.textPrimary};font-family:${ty.fontBody};font-size:${ty.sizeBodyPx}px;line-height:${ty.lineBody};}`,
    `.libro{max-width:${ty.measureCh + 8}ch;margin:0 auto;padding:32px 20px 64px;}`,
    `h1,h2,h3,h4{font-family:${ty.fontHeading};font-weight:${ty.weightHeading};line-height:${ty.lineHeading};color:${c.textPrimary};}`,
    `h1{font-size:${ty.sizeH1Px}px;margin:0 0 16px;}h2{font-size:${ty.sizeH2Px}px;margin:48px 0 16px;}h3{font-size:${ty.sizeH3Px}px;margin:32px 0 12px;}h4{font-size:${ty.sizeBodyPx}px;margin:24px 0 8px;}`,
    `p,li{max-width:${ty.measureCh}ch;}`,
    `a{color:${c.accentStrong};}`,
    `blockquote{margin:16px 0;padding:8px 16px;border:1px solid ${c.border};border-radius:8px;background:${c.surfaceAlt};color:${c.textPrimary};}`,
    `code{background:${c.surfaceAlt};color:${c.textPrimary};padding:0 4px;}`,
    `table{border-collapse:collapse;width:100%;margin:16px 0;display:block;overflow-x:auto;}th,td{border:1px solid ${c.border};padding:8px;text-align:left;vertical-align:top;}th{background:${c.surfaceAlt};}`,
    `.cc-libro-cover{background:${c.accent};color:${c.textOnAccent};padding:48px 32px;margin:0 0 32px;}`,
    `.cc-libro-cover h1,.cc-libro-cover p{color:${c.textOnAccent};}`,
    `.cc-libro-toc{background:${c.surface};border:1px solid ${c.border};padding:16px 24px;}`,
    `.cc-libro-module{background:${c.surfaceAlt};color:${c.textPrimary};padding:16px 24px;margin:48px 0 0;}`,
    `.cc-libro-module h2{margin-top:0;}`,
    `.cc-libro-biblio li{margin:0 0 8px;}`,
    '@media (max-width:640px){.libro{padding:16px 12px 48px;}h1{font-size:28px;}h2{font-size:24px;}}',
    '@media print{html,body{background:#FFFFFF;color:#111111;}.libro{max-width:none;padding:0;}' +
      '.cc-libro-cover{background:#FFFFFF;color:#111111;border-bottom:2px solid #111111;}.cc-libro-cover h1,.cc-libro-cover p{color:#111111;}' +
      '.cc-libro-module,.cc-libro-chapter,.cc-libro-biblio{page-break-before:always;break-before:page;}' +
      'h2,h3,h4{page-break-after:avoid;break-after:avoid;}a{color:#111111;text-decoration:none;}' +
      'table{display:table;}@page{margin:2cm;}}',
  ].join('\n');
}

export function compileLibroHtmlV3(input: LibroV3Input): string {
  const { theme: t, courseIntro, modules } = input;
  if (!input.courseTitle || !Array.isArray(modules) || modules.length === 0) {
    throw new Error('LIBRO_V3_INVALID: faltan el título del curso o los módulos');
  }
  const toc = modules
    .map((m) => {
      const chs = m.chapters.map((c) => `<li><a href="#cap-${c.number}">Capítulo ${c.number}: ${esc(c.title)}</a></li>`).join('\n');
      return `<li><a href="#mod-${m.number}">Módulo ${m.number}: ${esc(m.title)}</a><ul>${chs}</ul></li>`;
    })
    .join('\n');
  const body = modules
    .map((m, mi) => {
      const mc = moduleColor(t, mi);
      const outcomes = m.intro.outcomes.map((o) => `<li>${esc(o)}</li>`).join('');
      const preface =
        `<section id="mod-${m.number}" class="cc-libro-module" style="border:1px solid ${mc.main};border-radius:8px;padding:0 20px 8px;">` +
        `<h2>Módulo ${m.number} — ${esc(m.title)}</h2>\n${paragraphs(m.intro.presentation)}\n` +
        `<h4>Al terminar este módulo podrás:</h4><ul>${outcomes}</ul></section>`;
      const chapters = m.chapters
        .map((c) => {
          const md = stripLeadingDuplicateTitle(c.md, c.title, c.number);
          return `<section id="cap-${c.number}" class="cc-libro-chapter"><h2>Capítulo ${c.number} — ${esc(c.title)}</h2>\n${mdToHtmlBasic(sanitizeMarkdownLinks(md))}</section>`;
        })
        .join('\n');
      return `${preface}\n${chapters}`;
    })
    .join('\n');
  const courseBib = dedupe(courseIntro.bibliography);
  const moduleBibs = modules
    .map((m) => ({ m, list: dedupe(m.intro.bibliography) }))
    .filter((x) => x.list.length > 0)
    .map((x) => `<h3>Módulo ${x.m.number} — ${esc(x.m.title)}</h3><ul>${x.list.map(biblioItem).join('')}</ul>`)
    .join('\n');
  const biblio =
    `<section id="bibliografia" class="cc-libro-biblio"><h2>Bibliografía</h2>` +
    `<h3>Bibliografía general del curso</h3><ul>${courseBib.map(biblioItem).join('')}</ul>\n${moduleBibs}</section>`;
  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(input.courseTitle)} — Libro Guía</title>
<style>
${css(t)}
</style></head>
<body><main class="libro">
<div class="cc-libro-cover"><h1>${esc(input.courseTitle)}</h1><p>Libro Guía del curso</p></div>
<nav class="cc-libro-toc"><h2>Índice</h2><ul>${toc}\n<li><a href="#bibliografia">Bibliografía</a></li></ul></nav>
${body}
${biblio}
</main></body>
</html>`;
  if (!/<\/html>\s*$/i.test(html)) throw new Error('LIBRO_V3_INVALID: el Libro Guía no cierra en </html>');
  return html;
}

/** Palabras del Libro (texto visible de <main>, sin etiquetas ni CSS). Dato medido para facts. */
export function libroWordCount(html: string): number {
  const main = /<main[^>]*>([\s\S]*)<\/main>/i.exec(html);
  const text = (main ? main[1] : html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return (text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length;
}
