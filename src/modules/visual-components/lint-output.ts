/**
 * R2 — Visual Components: linters de SALIDA (HTML), usados por los tests y luego por el
 * validador del MBZ. Sin dependencias: incluye un parser HTML mínimo suficiente para el
 * HTML que emite el renderer y el que devuelve purify_html() de Moodle.
 *
 * - lintCleanSafe(html): el nivel base funciona con forceclean=1 (§X.1).
 * - extractText(html): texto en orden de lectura, para comparar equivalencias.
 */

import { contrastRatio } from '../theme-engine';

function expandHex(h: string): string {
  const x = h.trim().toUpperCase();
  return x.length === 4 ? `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}` : x;
}

export interface HtmlElement {
  kind: 'el';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
  /** Contenido crudo de <style>/<script>. */
  raw?: string;
}
export interface HtmlText {
  kind: 'text';
  text: string;
  parent: HtmlElement | null;
}
export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NON_CONTENT = new Set(['script', 'style', 'template', 'noscript']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', shy: '\u00AD', minus: '\u2212',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', laquo: '\u00AB', raquo: '\u00BB',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { kind: 'el', tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  const n = html.length;
  const pushText = (t: string) => {
    if (t) cur.children.push({ kind: 'text', text: decodeEntities(t), parent: cur });
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(lt, lt + 64));
    if (close) {
      const tag = close[1].toLowerCase();
      let el: HtmlElement | null = cur;
      while (el && el.tag !== tag) el = el.parent;
      if (el && el.parent) cur = el.parent;
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!open) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    const tag = open[1].toLowerCase();
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(open[2]))) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    const el: HtmlElement = { kind: 'el', tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    i = lt + open[0].length;
    if (RAW.has(tag)) {
      const endRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const em = endRe.exec(rest);
      el.raw = em ? rest.slice(0, em.index) : rest;
      i = em ? i + em.index + em[0].length : n;
      continue;
    }
    if (!VOID.has(tag) && !open[3]) cur = el;
  }
  return root;
}

// ─── extractText ────────────────────────────────────────────────────────────

/** Texto visible en orden de lectura; ignora <style>/<script>, guiones suaves y espacios de ancho cero. */
export function extractText(html: string): string {
  const out: string[] = [];
  const walk = (node: HtmlNode) => {
    if (node.kind === 'text') {
      out.push(node.text);
      return;
    }
    if (NON_CONTENT.has(node.tag)) return;
    const block = BLOCK.has(node.tag);
    if (block) out.push(' ');
    node.children.forEach(walk);
    if (block) out.push(' ');
  };
  walk(parseHtml(html));
  return out
    .join('')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Style parsing ──────────────────────────────────────────────────────────

export interface CssDecl {
  prop: string;
  value: string;
}

export function parseStyle(style: string | undefined): CssDecl[] {
  if (!style) return [];
  const decls: CssDecl[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  const flush = () => {
    const idx = buf.indexOf(':');
    if (idx > 0) {
      const prop = buf.slice(0, idx).trim().toLowerCase();
      const value = buf.slice(idx + 1).trim();
      if (prop) decls.push({ prop, value });
    }
    buf = '';
  };
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      depth++;
      buf += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === ';' && depth === 0) {
      flush();
    } else {
      buf += ch;
    }
  }
  flush();
  return decls;
}

/** Propiedades inline que sobreviven forceclean=1 (§X.1). Las demás son ENHANCED. */
export const CLEAN_SAFE_PROPERTIES = [
  'color', 'background-color', 'margin', 'padding', 'border', 'font', 'line-height', 'text-align', 'max-width',
  'width', 'min-width', 'letter-spacing', 'text-transform', 'list-style', 'border-collapse', 'vertical-align',
];

export function isCleanSafeProperty(prop: string): boolean {
  if (prop === 'border-radius' || prop.startsWith('border-image') || /^border-(?:top|bottom)-(?:left|right)-radius$/.test(prop)) return false;
  return CLEAN_SAFE_PROPERTIES.some((p) => prop === p || prop.startsWith(p + '-'));
}

/** Funciones que el purificador descarta: se permiten como override ENHANCED de una propiedad segura ya fijada. */
const PURIFIER_REJECTED_FN = /\b(?:clamp|min|max|calc)\s*\(/i;
const FORBIDDEN_VALUE = /oklch|oklab|\blab\(|\blch\(|var\s*\(|rgba?\s*\(|hsla?\s*\(|gradient|color-mix|currentcolor|!important/i;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Valor base (el que queda tras forceclean) de una propiedad segura: última ocurrencia con valor "plano". */
function baseValue(decls: CssDecl[], prop: string): string | undefined {
  let v: string | undefined;
  for (const d of decls) if (d.prop === prop && !PURIFIER_REJECTED_FN.test(d.value)) v = d.value;
  return v;
}

function solidBackground(decls: CssDecl[]): string | undefined {
  const bc = baseValue(decls, 'background-color');
  if (bc !== undefined) return bc;
  const b = baseValue(decls, 'background');
  if (b !== undefined && HEX.test(b.trim())) return b.trim();
  return undefined;
}

// ─── lintCleanSafe ──────────────────────────────────────────────────────────

export type CleanSafeLintCode =
  | 'BASE_HIDDEN'
  | 'NO_COLOR'
  | 'NO_BACKGROUND'
  | 'BG_NOT_PAIRED'
  | 'COLOR_WITHOUT_BACKGROUND'
  | 'NON_HEX_COLOR'
  | 'FORBIDDEN_VALUE'
  | 'GRADIENT_WITHOUT_FALLBACK'
  | 'DUPLICATE_SAFE_PROPERTY'
  | 'FONT_TOO_SMALL'
  | 'LOW_CONTRAST';

export interface CleanSafeLintError {
  code: CleanSafeLintCode;
  message: string;
  /** Ruta corta del elemento (tag.clase > \u2026). */
  where: string;
}

export interface CleanSafeLintResult {
  ok: boolean;
  errors: CleanSafeLintError[];
}

function where(el: HtmlElement | null): string {
  const parts: string[] = [];
  for (let e = el; e && e.tag !== '#root'; e = e.parent) {
    const cls = (e.attrs.class || '').split(/\s+/).filter(Boolean)[0];
    parts.unshift(cls ? `${e.tag}.${cls}` : e.tag);
  }
  return parts.slice(-4).join(' > ') || '#root';
}

function hasClass(el: HtmlElement, cls: string): boolean {
  return (el.attrs.class || '').split(/\s+/).includes(cls);
}

function pxValue(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+(?:\.\d+)?)px$/i.exec(v.trim());
  return m ? parseFloat(m[1]) : undefined;
}

/**
 * Reglas:
 *  - nada oculto en la base (display:none, visibility:hidden, opacity:0, font-size:0, [hidden], <details> sin open);
 *  - cada nodo de texto tiene un ancestro (o él mismo) con `color`, y el `background-color` sólido más cercano
 *    está en ese mismo elemento o por encima (el color fue elegido para ese fondo);
 *  - colores base solo hex; sin oklch/var/rgba/hsl/gradientes/color-mix en propiedades seguras;
 *    un gradiente (enhanced) exige background-color hex en el mismo elemento;
 *  - una propiedad segura no se repite salvo override con clamp()/min()/max()/calc() (que el purificador descarta);
 *  - font-size base < 16px solo en .cvc-meta y nunca < 13px;
 *  - contraste estático color/fondo emparejados ≥ 4.5:1 (WCAG, texto normal).
 */
export function lintCleanSafe(html: string): CleanSafeLintResult {
  const errors: CleanSafeLintError[] = [];
  const root = parseHtml(html);
  const styleCache = new Map<HtmlElement, CssDecl[]>();
  const declsOf = (el: HtmlElement) => {
    let d = styleCache.get(el);
    if (!d) {
      d = parseStyle(el.attrs.style);
      styleCache.set(el, d);
    }
    return d;
  };

  const visitEl = (el: HtmlElement) => {
    const decls = declsOf(el);
    const w = () => where(el);
    // ocultamiento en la base
    for (const d of decls) {
      const v = d.value.toLowerCase().replace(/\s+/g, '');
      if ((d.prop === 'display' && v.startsWith('none')) || (d.prop === 'visibility' && (v.startsWith('hidden') || v.startsWith('collapse'))) || (d.prop === 'opacity' && parseFloat(v) === 0) || (d.prop === 'font-size' && /^0(px|em|rem|%)?$/.test(v))) {
        errors.push({ code: 'BASE_HIDDEN', message: `${d.prop}:${d.value}`, where: w() });
      }
    }
    if ('hidden' in el.attrs) errors.push({ code: 'BASE_HIDDEN', message: 'atributo hidden', where: w() });
    if (el.tag === 'details' && !('open' in el.attrs)) errors.push({ code: 'BASE_HIDDEN', message: '<details> cerrado', where: w() });

    // valores prohibidos / duplicados en propiedades seguras
    const seen = new Map<string, number>();
    for (const d of decls) {
      if (!isCleanSafeProperty(d.prop) && d.prop !== 'background' && d.prop !== 'background-image') continue;
      const rejected = PURIFIER_REJECTED_FN.test(d.value);
      if (d.prop === 'background' || d.prop === 'background-image') {
        if (/gradient|url\s*\(/i.test(d.value)) {
          const bc = baseValue(decls, 'background-color');
          if (!bc || !HEX.test(bc)) {
            errors.push({ code: 'GRADIENT_WITHOUT_FALLBACK', message: `${d.prop} sin background-color hex sólido`, where: w() });
          }
        } else if (FORBIDDEN_VALUE.test(d.value)) {
          errors.push({ code: 'FORBIDDEN_VALUE', message: `${d.prop}:${d.value}`, where: w() });
        }
        continue;
      }
      if (FORBIDDEN_VALUE.test(d.value)) {
        errors.push({ code: 'FORBIDDEN_VALUE', message: `${d.prop}:${d.value}`, where: w() });
      }
      if ((d.prop === 'color' || d.prop === 'background-color') && !rejected && !HEX.test(d.value.trim())) {
        errors.push({ code: 'NON_HEX_COLOR', message: `${d.prop}:${d.value}`, where: w() });
      }
      const count = (seen.get(d.prop) || 0) + 1;
      seen.set(d.prop, count);
      if (count > 1 && !rejected) {
        errors.push({ code: 'DUPLICATE_SAFE_PROPERTY', message: `${d.prop} repetida con un valor que sobrevive al purificador`, where: w() });
      }
      if (rejected && count === 1) {
        errors.push({ code: 'FORBIDDEN_VALUE', message: `${d.prop}:${d.value} sin valor base previo`, where: w() });
      }
    }

    // colores sin fondo
    if (baseValue(decls, 'color') !== undefined) {
      let e: HtmlElement | null = el;
      let ok = false;
      for (; e; e = e.parent) if (solidBackground(declsOf(e)) !== undefined) { ok = true; break; }
      if (!ok) errors.push({ code: 'COLOR_WITHOUT_BACKGROUND', message: 'fija color sin background-color sólido propio o de un ancestro', where: w() });
    }

    // tamaño mínimo
    const fs = pxValue(baseValue(decls, 'font-size'));
    if (fs !== undefined) {
      const meta = hasClass(el, 'cvc-meta');
      if ((!meta && fs < 16) || (meta && fs < 13)) {
        errors.push({ code: 'FONT_TOO_SMALL', message: `font-size ${fs}px${meta ? ' (meta)' : ''}`, where: w() });
      }
    }

    for (const ch of el.children) {
      if (ch.kind === 'el') {
        if (!NON_CONTENT.has(ch.tag)) visitEl(ch);
      } else if (ch.text.trim().replace(/[\u00AD\u200B]/g, '')) {
        visitText(ch);
      }
    }
  };

  const visitText = (t: HtmlText) => {
    let colorEl: HtmlElement | null = null;
    let bgEl: HtmlElement | null = null;
    for (let e = t.parent; e; e = e.parent) {
      const d = declsOf(e);
      if (!colorEl && baseValue(d, 'color') !== undefined) colorEl = e;
      if (!bgEl && solidBackground(d) !== undefined) bgEl = e;
      if (colorEl && bgEl) break;
    }
    const snippet = t.text.trim().slice(0, 40);
    if (!colorEl) {
      errors.push({ code: 'NO_COLOR', message: `texto sin color explícito: "${snippet}"`, where: where(t.parent) });
      return;
    }
    if (!bgEl) {
      errors.push({ code: 'NO_BACKGROUND', message: `texto sin fondo sólido: "${snippet}"`, where: where(t.parent) });
      return;
    }
    // bgEl debe ser colorEl o un ancestro suyo (no puede haber un fondo "nuevo" entre el texto y su color).
    let e: HtmlElement | null = colorEl;
    while (e && e !== bgEl) e = e.parent;
    if (e) {
      const fg = baseValue(declsOf(colorEl), 'color')!.trim();
      const bg = solidBackground(declsOf(bgEl))!.trim();
      if (HEX.test(fg) && HEX.test(bg)) {
        const ratio = contrastRatio(expandHex(fg), expandHex(bg));
        if (ratio < 4.5) {
          errors.push({ code: 'LOW_CONTRAST', message: `${fg} sobre ${bg} = ${ratio.toFixed(2)}:1 < 4.5: "${snippet}"`, where: where(t.parent) });
        }
      }
    } else {
      errors.push({ code: 'BG_NOT_PAIRED', message: `el fondo más cercano está por debajo del elemento que fija color: "${snippet}"`, where: where(t.parent) });
    }
  };

  visitEl(root);
  return { ok: errors.length === 0, errors };
}
