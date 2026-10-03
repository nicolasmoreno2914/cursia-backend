/**
 * Cursia V2.1 — Libro Guía v3 (R12, audit §Q.6) — r19 (bloque L, builder 3.13.0): PDF REAL.
 *
 * Antes era una página HTML con CSS de impresión (se abría como página web, sin logo, sin marca de agua,
 * sin encabezado ni números de página). Desde 3.13.0 es un PDF generado en proceso con pdfkit a partir del
 * MISMO insumo (`LibroV3Input`): es el ÚNICO archivo del recurso «📘 Libro Guía».
 *
 * Contenido, en el orden del Manifest (join por UUID):
 *   portada (título, «Libro Guía», institución/marca, módulos y capítulos) → índice con números de página →
 *   por módulo: prefacio en recuadro (presentation + outcomes) y sus capítulos (markdown de `content`) →
 *   bibliografía verificada (la del curso y la de cada módulo, de los intros v3).
 *
 * Diseño: encabezado con el título del curso y pie «Página X de Y» en toda página salvo la portada, color de
 * acento del tema resuelto (ajustado para leerse sobre papel blanco), fuentes estándar PDF (Helvetica o Times
 * según la familia del tema; WinAnsi: todo carácter fuera de ese juego se mapea o se quita, `pdfText`).
 *
 * Marca de agua: EXACTAMENTE un dibujo de imagen por página, en TODA página (portada e índice incluidos):
 * el logo (`ResolvedLibroLogo`, prioridad cuenta → Cursia), centrado, opacidad `LIBRO_WATERMARK_OPACITY`,
 * dibujado PRIMERO en cada página (evento `pageAdded`, antes de cualquier texto) — queda detrás del texto.
 * El renderer cuenta los dibujos por página y falla fuerte si alguno ≠ 1.
 *
 * Puro y determinístico: fechas e ID fijos (el ID de pdfkit es el md5 del diccionario Info: título del curso,
 * marca y fechas fijas) → mismos insumos, mismos bytes.
 */
import PDFDocument = require('pdfkit');
import { verifyBibliography } from './verified-bibliography';
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio, moduleColor } from '../../modules/theme-engine';
import type { BibliographyEntry, CourseIntroV3, ModuleIntroV3 } from '../../modules/course-shell/intro-schemas';
import { stripLeadingDuplicateTitle } from '../dynamic-mbz-builder';
import type { ResolvedLibroLogo } from './libro-logo';

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
  /** Logo ya resuelto y validado (`resolveLibroLogo`): marca de agua de cada página. */
  logo: ResolvedLibroLogo;
  /** Nombre de la institución / marca (portada y pie), si la cuenta lo tiene. */
  brandName?: string | null;
  /** Fix round 1 (M8): clave del documento (p.ej. sha del plan) → Info /Keywords, y así /ID único por curso y determinístico. */
  documentKey?: string | null;
}

export interface LibroPdfResult {
  pdf: Buffer;
  pageCount: number;
  /** Palabras del texto del libro (portada, prefacios, capítulos, bibliografía; sin índice ni encabezados). */
  wordCount: number;
  hasBibliography: boolean;
  /** Dibujos de la marca de agua por página (todos = 1, o el renderer falla). */
  watermarkDrawsPerPage: number[];
  /** Página (1-based) de inicio de cada capítulo, por número de capítulo. */
  chapterPages: Record<number, number>;
  /** Fix round 1 (i): dibujos del logo a opacidad plena en la portada (siempre 1, solo en la página 1). */
  coverLogoDraws: number;
  /** Fix round 1 (I2): caracteres visibles del insumo sin equivalente en WinAnsi (quitados; aviso en el paquete). */
  unmappedChars: number;
}

/** Opacidad de la marca de agua (≈ 0.06–0.10: discreta, el texto sigue completamente legible). */
export const LIBRO_WATERMARK_OPACITY = 0.07;
/** Fecha fija del PDF (CreationDate / ModDate): bytes estables para goldens y la clave de reuse. */
export const LIBRO_PDF_FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
export const LIBRO_PDF_MIMETYPE = 'application/pdf';

/** Nombre del archivo del recurso: `libro_guia_<slug del curso>.pdf` (ASCII, ≤ 60 caracteres de slug). */
export function libroPdfFilename(courseTitle: string): string {
  const slug = String(courseTitle ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return slug ? `libro_guia_${slug}.pdf` : 'libro_guia_completo.pdf';
}

// ─── Texto seguro para las fuentes estándar (WinAnsi) ─────────────────────

/** Los 27 caracteres de cp1252 en 0x80–0x9F (además de ASCII imprimible y Latin-1 0xA0–0xFF). */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

const GREEK: Record<string, string> = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ϵ': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ϑ': 'theta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'µ', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'ς': 'sigma',
  'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Α': 'Alpha', 'Β': 'Beta', 'Γ': 'Gamma', 'Δ': 'Delta', 'Ε': 'Epsilon', 'Ζ': 'Zeta', 'Η': 'Eta', 'Θ': 'Theta', 'Ι': 'Iota', 'Κ': 'Kappa',
  'Λ': 'Lambda', 'Μ': 'Mu', 'Ν': 'Nu', 'Ξ': 'Xi', 'Ο': 'Omicron', 'Π': 'Pi', 'Ρ': 'Rho', 'Σ': 'Sigma', 'Τ': 'Tau', 'Υ': 'Upsilon',
  'Φ': 'Phi', 'Χ': 'Chi', 'Ψ': 'Psi', 'Ω': 'Omega', '\u2126': 'Omega', '∆': 'Delta', '∑': 'Sigma', '∏': 'Pi',
};

/**
 * Fix round 1 (I2): transliteración determinística de lo común que WinAnsi no tiene (nunca se pierde en silencio):
 * subíndices/superíndices → dígitos, griego → nombre (π → pi, Δ → Delta; μ → µ, que sí es WinAnsi), comparadores y
 * operadores → texto, flechas, ✓/✗, viñetas, números en círculo, fracciones, unidades. Lo que quede sin mapa se quita
 * y se CUENTA (`unmappedCharCount` → aviso `libro_chars_unmapped:<n>` en el resumen del paquete).
 */
const CHAR_MAP: Record<string, string> = {
  // viñetas y marcadores
  '■': '•', '□': '•', '▪': '•', '▫': '•', '◆': '•', '◇': '•', '●': '•', '○': '•', '◼': '•', '◻': '•', '⬛': '•', '⬜': '•',
  '▶': '•', '►': '•', '▸': '•', '‣': '•', '⁃': '-', '∙': '·', '◦': '•', '⦁': '•', '❖': '•', '★': '*', '☆': '*',
  // guiones
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—', '⸺': '—', '⸻': '—',
  // flechas
  '→': '->', '⇒': '=>', '➜': '->', '➔': '->', '➡': '->', '⟶': '->', '⟹': '=>', '↦': '->', '←': '<-', '⇐': '<=', '⬅': '<-', '⟵': '<-',
  '↔': '<->', '⇔': '<=>', '⟷': '<->', '↑': '(arriba)', '↓': '(abajo)', '⬆': '(arriba)', '⬇': '(abajo)', '↗': '(sube)', '↘': '(baja)',
  // comparadores y operadores (× ÷ ± ¬ · son WinAnsi y se conservan)
  '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~=', '≅': '~=', '≃': '~=', '≡': '===', '∓': '-/+', '∝': ' proporcional a ', '∞': 'infinito',
  '√': 'raíz de ', '∛': 'raíz cúbica de ', '∂': 'd', '∇': 'nabla', '∫': 'integral ', '∈': ' en ', '∉': ' no en ', '∩': ' intersección ', '∪': ' unión ',
  '⊂': ' subconjunto de ', '∅': 'vacío', '∀': 'para todo ', '∃': 'existe ', '∴': 'por lo tanto', '⋅': '·', '∗': '*', '⁄': '/', '∕': '/',
  // ✓ ✗
  '✓': '(sí)', '✔': '(sí)', '☑': '(sí)', '✅': '(sí)', '✗': '(no)', '✘': '(no)', '❌': '(no)', '☒': '(no)', '☐': '[ ]',
  // subíndices y superíndices (¹ ² ³ son Latin-1)
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  '⁰': '0', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n',
  // fracciones (½ ¼ ¾ son Latin-1)
  '⅓': '1/3', '⅔': '2/3', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
  // unidades y abreviaturas
  '℃': '°C', '℉': '°F', '№': 'N.º', '℮': 'e', 'ℓ': 'l', '㎡': 'm²', '㎥': 'm³',
  // comillas / primas / espacios
  '′': "'", '″': '"', '‴': "'''", '\u2009': ' ', '\u2002': ' ', '\u2003': ' ', '\u202f': ' ', '\u2007': ' ', '\u200a': ' ', '\u2008': ' ', '\u205f': ' ',
  '\t': ' ',
  ...GREEK,
};
for (let n = 1; n <= 20; n++) CHAR_MAP[String.fromCodePoint(0x2460 + n - 1)] = `${n}.`; // ① … ⑳
for (let n = 1; n <= 10; n++) CHAR_MAP[String.fromCodePoint(0x2776 + n - 1)] = `${n}.`; // ❶ … ❿
for (let n = 1; n <= 10; n++) CHAR_MAP[String.fromCodePoint(0x2780 + n - 1)] = `${n}.`; // ➀ … ➉

/** Caracteres de formato invisibles: se quitan sin contar (no son contenido). */
const INVISIBLE = /^(?:[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­​-‏⁠-⁤︀-️﻿]|[\u{e0020}-\u{e007f}])$/u;

const isWinAnsi = (ch: string): boolean => {
  const cp = ch.codePointAt(0) as number;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(ch);
};

/**
 * Texto apto para las fuentes estándar del PDF (codificación WinAnsi): NFC, transliteración determinística
 * (CHAR_MAP) y supresión de lo que no tiene mapa (emoji, CJK, pictogramas…). Nunca deja un carácter que se pintaría
 * como basura. Una letra griega pegada a otra letra o dígito lleva un espacio («Δt» → «Delta t»).
 */
export function pdfText(s: string): string {
  let out = '';
  const chars = [...String(s ?? '').normalize('NFC')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const mapped = CHAR_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      if (GREEK[ch] && GREEK[ch] !== 'µ' && i + 1 < chars.length && /[\p{L}\p{N}]/u.test(chars[i + 1]) && !GREEK[chars[i + 1]]) out += ' ';
      continue;
    }
    if (isWinAnsi(ch)) out += ch;
    else if (ch === '\n' || ch === '\r') out += ' ';
    // resto (emoji, CJK, pictogramas, formato invisible): se quita; `unmappedCharCount` cuenta los visibles
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Fix round 1 (I2): caracteres VISIBLES que `pdfText` quitaría sin equivalente (para el aviso del paquete). */
export function unmappedCharCount(s: string): number {
  let n = 0;
  for (const ch of String(s ?? '').normalize('NFC')) {
    if (CHAR_MAP[ch] !== undefined || isWinAnsi(ch) || ch === '\n' || ch === '\r' || INVISIBLE.test(ch)) continue;
    n++;
  }
  return n;
}

// ─── Markdown → bloques ────────────────────────────────────────────────────

interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
  link?: string | null;
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; runs: Run[] }
  | { t: 'callout'; runs: Run[] }
  | { t: 'list'; ordered: boolean; items: Run[][] }
  | { t: 'quote'; paras: Run[][] }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'code'; lines: string[] }
  | { t: 'hr' };

const SAFE_URL = /^(https?:\/\/|mailto:|#)[^"'<>\s`]*$/i;

/**
 * G6 M2 (se conserva del Libro HTML): cada link markdown se conserva solo si su URL es http(s)/mailto/#ancla
 * sin comillas ni `<>`; si no, queda solo el texto. En el PDF los `#anclas` quedan como texto (no hay anclas).
 */
export function sanitizeMarkdownLinks(md: string): string {
  let prev: string;
  let cur = String(md ?? '');
  do {
    prev = cur;
    cur = cur.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => (SAFE_URL.test(url) ? m : text));
  } while (cur !== prev);
  return cur;
}

const INLINE_RE = /(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+?)\*\*)|(__([^_]+?)__)|((?<![*\p{L}\p{N}])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![*\p{L}\p{N}]))|((?<![\p{L}\p{N}_])_([^_\s](?:[^_]*?[^_\s])?)_(?![\p{L}\p{N}_]))/gu;

function parseInline(s: string, base: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  let last = 0;
  const src = String(s ?? '');
  for (const m of src.matchAll(INLINE_RE)) {
    const idx = m.index as number;
    if (idx > last) out.push({ ...base, text: src.slice(last, idx) });
    if (m[1]) out.push({ ...base, code: true, text: m[2] });
    else if (m[3]) {
      const url = m[5];
      const link = /^(https?:\/\/|mailto:)/i.test(url) && SAFE_URL.test(url) ? url : base.link ?? null;
      out.push(...parseInline(m[4], { ...base, link }));
    } else if (m[6]) out.push(...parseInline(m[7], { ...base, b: true }));
    else if (m[8]) out.push(...parseInline(m[9], { ...base, b: true }));
    else if (m[10]) out.push(...parseInline(m[11], { ...base, i: true }));
    else if (m[12]) out.push(...parseInline(m[13], { ...base, i: true }));
    last = idx + m[0].length;
  }
  if (last < src.length) out.push({ ...base, text: src.slice(last) });
  return out
    .map((r) => ({ ...r, text: pdfText(r.text.replace(/\*\*/g, '')) }))
    .filter((r) => r.text.length > 0);
}

const plain = (runs: Run[]): string => runs.map((r) => r.text).join('');
const plainInline = (s: string): string => plain(parseInline(s)).trim();

const isTableRow = (l: string): boolean => l.includes('|') && l.trim().length > 0;
const isTableSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
function splitRow(l: string): string[] {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** Párrafo que abre con un pictograma o marcador (■, ✏, 💡, ⚠️ …) → recuadro destacado, sin el marcador. */
const CALLOUT_LEAD = /^\s*(?:[■□▪◆●▶►✏✎✍★☆✅❗❕❓⚠]|\p{Extended_Pictographic})[️‍\p{Extended_Pictographic}]*\s*/u;
/** Igual que CALLOUT_LEAD en cada línea (el marcador de un destacado se quita a propósito: no es contenido perdido). */
const CALLOUT_LEAD_G = /^\s*(?:[■□▪◆●▶►✏✎✍★☆✅❗❕❓⚠]|\p{Extended_Pictographic})[️‍\p{Extended_Pictographic}]*\s*/gmu;

export function parseLibroMarkdown(md: string): Block[] {
  const lines = sanitizeMarkdownLinks(md).split(/\r?\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    para = [];
    if (!text) return;
    if (CALLOUT_LEAD.test(text)) {
      const runs = parseInline(text.replace(CALLOUT_LEAD, ''));
      if (runs.length) blocks.push({ t: 'callout', runs });
      return;
    }
    const runs = parseInline(text);
    if (runs.length) blocks.push({ t: 'p', runs });
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it) => parseInline(it)).filter((r) => r.length > 0);
    if (items.length) blocks.push({ t: 'list', ordered: list.ordered, items });
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    const paras: Run[][] = [];
    let cur: string[] = [];
    for (const q of [...quote, '']) {
      if (q.trim()) cur.push(q.trim());
      else if (cur.length) {
        const r = parseInline(cur.join(' '));
        if (r.length) paras.push(r);
        cur = [];
      }
    }
    if (paras.length) blocks.push({ t: 'quote', paras });
    quote = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fix round 1 (M7): bloque de código cercado (``` o ~~~) → monoespaciado, línea por línea (antes: un párrafo con ```).
    const fenceM = /^\s*(```|~~~)/.exec(line);
    if (fenceM) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fenceM[1])) code.push(pdfText(lines[i++].replace(/\s+$/, '')));
      i++;
      while (code.length && !code[code.length - 1].trim()) code.pop();
      if (code.length) blocks.push({ t: 'code', lines: code });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushAll();
      const header = splitRow(line).map(plainInline);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]).map(plainInline));
        i++;
      }
      // fix round 1 (M7): una fila con más celdas que el encabezado ya no pierde las de más (se ensancha el encabezado).
      const width = Math.max(header.length, ...rows.map((r) => r.length));
      while (header.length < width) header.push('');
      blocks.push({ t: 'table', header, rows: rows.map((r) => header.map((_, k) => r[k] ?? '')) });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const bq = /^\s*>\s?(.*)$/.exec(line);
    const hr = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line);
    if (hr) {
      flushAll();
      blocks.push({ t: 'hr' });
    } else if (h) {
      flushAll();
      const text = plainInline(h[2]);
      if (text) blocks.push({ t: 'h', level: h[1].length, text });
    } else if (bq) {
      flushPara();
      flushList();
      (quote ??= []).push(bq[1]);
    } else if (ol || ul) {
      flushPara();
      flushQuote();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ol ?? ul)[1]);
    } else if (!line.trim()) {
      flushAll();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      flushQuote();
      para.push(line.trim());
    }
    i++;
  }
  flushAll();
  return blocks;
}

// ─── Bibliografía (verificada) ─────────────────────────────────────────────

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

export interface LibroBibliography {
  course: BibliographyEntry[];
  modules: Array<{ number: number; title: string; entries: BibliographyEntry[] }>;
}

/** R14: solo obras verificadas, en forma canónica (verified-bibliography.ts); lo demás se omite y se registra. */
export function libroBibliographyV3(input: Pick<LibroV3Input, 'courseIntro' | 'modules'>): LibroBibliography {
  const verified = (list: BibliographyEntry[], where: string): BibliographyEntry[] => {
    const v = verifyBibliography(dedupe(list ?? []));
    if (v.dropped.length || v.corrected) console.warn(`[libro-v3] bibliografía ${where}: ${v.kept.length} publicadas, ${v.corrected} corregidas a forma canónica, ${v.dropped.length} omitidas por no verificables`);
    return v.kept;
  };
  return {
    course: verified(input.courseIntro.bibliography, 'del curso'),
    modules: input.modules
      .map((m) => ({ number: m.number, title: m.title, entries: verified(m.intro.bibliography, `del módulo ${m.number}`) }))
      .filter((x) => x.entries.length > 0),
  };
}

// ─── Colores y fuentes para papel blanco ──────────────────────────────────

const PAPER = '#FFFFFF';
const INK = '#1C2430';
const INK_SOFT = '#5B6573';
const RULE = '#D3D8DF';

function onPaper(candidates: string[], min: number, fallback: string): string {
  for (const c of candidates) {
    try {
      if (c && contrastRatio(c, PAPER) >= min) return c;
    } catch {
      /* color inválido → siguiente */
    }
  }
  return fallback;
}

function lightFill(candidates: string[], fallback: string): string {
  for (const c of candidates) {
    try {
      if (c && contrastRatio(INK, c) >= 10 && contrastRatio(c, PAPER) < 1.25) return c;
    } catch {
      /* siguiente */
    }
  }
  return fallback;
}

type Family = 'sans' | 'serif';
const FONTS: Record<Family, { r: string; b: string; i: string; bi: string }> = {
  sans: { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', bi: 'Helvetica-BoldOblique' },
  serif: { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' },
};
const familyOf = (stack: string): Family => (/(^|,)\s*serif\s*$/i.test(String(stack ?? '').trim()) ? 'serif' : 'sans');
const fontOf = (f: Family, r: { b?: boolean; i?: boolean; code?: boolean }): string =>
  r.code ? 'Courier' : r.b && r.i ? FONTS[f].bi : r.b ? FONTS[f].b : r.i ? FONTS[f].i : FONTS[f].r;

const WORD_RE = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
const countWords = (s: string): number => (String(s ?? '').match(WORD_RE) || []).length;

// ─── Render ────────────────────────────────────────────────────────────────

const PAGE = { size: 'LETTER' as const, w: 612, h: 792, top: 78, bottom: 74, left: 68, right: 68 };

/**
 * Fix round 1 (I1): todo error que no sea propio (`LIBRO_*`), p.ej. pdfkit que lanza el string «Invalid JPEG.»,
 * sale como `LIBRO_V3_PDF_FAILED: …` (clasificado en failure-classifier), nunca como un error sin código.
 */
export async function renderLibroPdfV3(input: LibroV3Input): Promise<LibroPdfResult> {
  try {
    return await renderLibroPdfV3Inner(input);
  } catch (err) {
    if (err instanceof Error && /^LIBRO_/.test(err.message)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LIBRO_V3_PDF_FAILED: pdfkit no pudo generar el Libro Guía: ${msg.slice(0, 200)}`);
  }
}

/** Fix round 1 (I2): caracteres visibles sin equivalente WinAnsi en el texto que el libro imprime (cada fuente una vez). */
export function libroUnmappedChars(input: Pick<LibroV3Input, 'courseTitle' | 'brandName' | 'courseIntro' | 'modules'>): number {
  const parts: string[] = [input.courseTitle, input.brandName ?? ''];
  const bib = libroBibliographyV3(input);
  for (const b of [...bib.course, ...bib.modules.flatMap((m) => m.entries)]) parts.push(b.author, b.title, b.publisher);
  for (const m of input.modules) {
    parts.push(m.title, m.intro.presentation ?? '', ...(m.intro.outcomes ?? []));
    for (const ch of m.chapters) parts.push(ch.title, stripLeadingDuplicateTitle(String(ch.md ?? ''), ch.title, ch.number).replace(CALLOUT_LEAD_G, ''));
  }
  return parts.reduce((n, p) => n + unmappedCharCount(String(p ?? '')), 0);
}

async function renderLibroPdfV3Inner(input: LibroV3Input): Promise<LibroPdfResult> {
  const { theme: t, modules } = input;
  if (!input.courseTitle || !Array.isArray(modules) || modules.length === 0) {
    throw new Error('LIBRO_V3_INVALID: faltan el título del curso o los módulos');
  }
  const logo = input.logo;
  if (!logo || !Buffer.isBuffer(logo.bytes) || logo.bytes.length === 0 || !(logo.width > 0) || !(logo.height > 0)) {
    throw new Error('LIBRO_V3_INVALID: falta el logo resuelto de la marca de agua');
  }
  const courseTitle = pdfText(input.courseTitle).trim();
  const brandName = input.brandName ? pdfText(input.brandName).trim() : '';
  const bib = libroBibliographyV3(input);
  const hasBibliography = bib.course.length > 0 || bib.modules.length > 0;

  const c = t.color;
  const accent = onPaper([c.accentStrong, c.accent, c.textPrimary], 4.5, '#1F3A5F');
  const ink = onPaper([c.textPrimary], 10, INK);
  const inkSoft = onPaper([c.textSecondary], 4.5, INK_SOFT);
  const rule = RULE;
  const tableHead = lightFill([c.surfaceAlt, c.accentSoft], '#EEF1F5');
  const bodyFamily = familyOf(t.typography.fontBody);
  const headFamily = familyOf(t.typography.fontHeading);
  const modColor = (mi: number): string => {
    try {
      return onPaper([moduleColor(t, mi).main, moduleColor(t, mi).border], 3, accent);
    } catch {
      return accent;
    }
  };

  const SIZE = { body: 10.5, small: 8.5, h1: 23, h2: 15, h3: 12.5, h4: 11, table: 9 };
  const LINE_GAP = 3.2;
  const contentW = PAGE.w - PAGE.left - PAGE.right;

  const doc = new PDFDocument({
    size: PAGE.size,
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right },
    bufferPages: true,
    autoFirstPage: false,
    pdfVersion: '1.7',
    lang: 'es-419',
    displayTitle: true,
    compress: true,
    info: {
      Title: courseTitle,
      Subject: 'Libro Guía del curso',
      Author: brandName || 'Cursia',
      Creator: 'Cursia',
      Producer: 'Cursia (pdfkit)',
      CreationDate: LIBRO_PDF_FIXED_DATE,
      ModDate: LIBRO_PDF_FIXED_DATE,
      ...(input.documentKey ? { Keywords: `cursia:${String(input.documentKey).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80)}` } : {}),
    },
  } as any);
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  // ── Marca de agua: una imagen por página, primero ──
  const wmImage = (doc as any).openImage(logo.bytes);
  const wmScale = Math.min((contentW * 0.62) / logo.width, (PAGE.h * 0.34) / logo.height);
  const wmW = logo.width * wmScale;
  const wmH = logo.height * wmScale;
  const wmX = (PAGE.w - wmW) / 2;
  const wmY = (PAGE.h - wmH) / 2;
  const watermarkDraws: number[] = [];
  let pageIdx = -1;
  doc.on('pageAdded', () => {
    pageIdx++;
    watermarkDraws[pageIdx] = (watermarkDraws[pageIdx] ?? 0) + 1;
    doc.save();
    doc.opacity(LIBRO_WATERMARK_OPACITY);
    doc.image(wmImage, wmX, wmY, { width: wmW, height: wmH, ignoreOrientation: true } as any);
    doc.restore();
  });
  let coverLogoDraws = 0;

  let words = 0;
  const bottomY = () => doc.page.height - doc.page.margins.bottom;
  const remaining = () => bottomY() - doc.y;
  const newPage = () => {
    doc.addPage();
    doc.x = PAGE.left;
    doc.y = PAGE.top;
  };
  const ensure = (h: number) => {
    if (remaining() < h) newPage();
  };

  const textRuns = (runs: Run[], x: number, width: number, o: { size: number; color: string; family: Family; italic?: boolean; align?: 'left' | 'justify'; count?: boolean }) => {
    const rs = runs.filter((r) => r.text.length > 0);
    if (!rs.length) return;
    if (o.count !== false) words += countWords(plain(rs));
    rs.forEach((r, k) => {
      doc.font(fontOf(o.family, { ...r, i: r.i || o.italic })).fontSize(r.code ? o.size - 0.5 : o.size).fillColor(r.link ? accent : o.color);
      const opts: any = { continued: k < rs.length - 1, width, lineGap: LINE_GAP, align: o.align ?? 'left', link: r.link || null, underline: !!r.link };
      if (k === 0) doc.text(r.text, x, doc.y, opts);
      else doc.text(r.text, opts);
    });
    doc.x = PAGE.left;
  };
  const measureRuns = (runs: Run[], width: number, size: number, family: Family): number => {
    doc.font(FONTS[family].r).fontSize(size);
    return doc.heightOfString(plain(runs), { width, lineGap: LINE_GAP }) * 1.06;
  };
  const heading = (text: string, size: number, color: string, o: { before?: number; after?: number; count?: boolean } = {}) => {
    doc.font(FONTS[headFamily].b).fontSize(size);
    const h = doc.heightOfString(text, { width: contentW, lineGap: 2 });
    if (doc.y > PAGE.top + 1) doc.y += o.before ?? size * 0.7;
    // sin huérfanos: el título va con al menos ~3 líneas de texto debajo
    if (remaining() < h + SIZE.body * 4.5) newPage();
    if (o.count !== false) words += countWords(text);
    doc.fillColor(color).text(text, PAGE.left, doc.y, { width: contentW, lineGap: 2 });
    doc.y += o.after ?? size * 0.35;
  };
  const eyebrow = (text: string, color: string) => {
    doc.font(FONTS.sans.b).fontSize(8.5).fillColor(color).text(text.toUpperCase(), PAGE.left, doc.y, { width: contentW, characterSpacing: 1.6 });
    doc.y += 4;
  };
  const accentRule = (color: string, width = 56, thick = 2.5) => {
    doc.save().rect(PAGE.left, doc.y, width, thick).fill(color).restore();
    doc.y += thick + 12;
  };
  const paraGap = () => {
    doc.y += SIZE.body * 0.6;
  };

  const leftBarBlock = (paras: Run[][], o: { italic?: boolean; color: string; bar: string; label?: boolean }) => {
    const indent = 14;
    const w = contentW - indent;
    const total = paras.reduce((s, p) => s + measureRuns(p, w, SIZE.body, bodyFamily) + SIZE.body * 0.4, 0);
    if (total > remaining() && total < bottomY() - PAGE.top) newPage();
    ensure(SIZE.body * 3);
    const startPage = pageIdx;
    const y0 = doc.y;
    paras.forEach((p, k) => {
      textRuns(p, PAGE.left + indent, w, { size: SIZE.body, color: o.color, family: bodyFamily, italic: o.italic });
      if (k < paras.length - 1) doc.y += SIZE.body * 0.4;
    });
    if (pageIdx === startPage) doc.save().rect(PAGE.left, y0 - 1, 3, doc.y - y0 + 2).fill(o.bar).restore();
    paraGap();
  };

  const table = (header: string[], rows: string[][]) => {
    const n = header.length;
    if (!n) return;
    const pad = 5;
    doc.fontSize(SIZE.table);
    const allRows = [header, ...rows];
    const natural = header.map((_, k) => {
      let nat = 0;
      let word = 0;
      allRows.forEach((r, ri) => {
        doc.font(ri === 0 ? FONTS[bodyFamily].b : FONTS[bodyFamily].r);
        const cell = r[k] ?? '';
        nat = Math.max(nat, Math.min(doc.widthOfString(cell), contentW));
        for (const wd of cell.split(/\s+/)) word = Math.max(word, doc.widthOfString(wd));
      });
      return { nat: nat + 2 * pad, min: Math.min(word + 2 * pad, contentW / n) };
    });
    let widths = natural.map((x) => Math.max(x.nat, x.min, 36));
    const sum = widths.reduce((a, b) => a + b, 0);
    widths = widths.map((x) => (x / sum) * contentW);
    const cellH = (r: string[], bold: boolean) =>
      Math.max(
        ...r.map((cell, k) => {
          doc.font(bold ? FONTS[bodyFamily].b : FONTS[bodyFamily].r).fontSize(SIZE.table);
          return doc.heightOfString(cell || ' ', { width: widths[k] - 2 * pad, lineGap: 1.5 });
        }),
      ) + 2 * pad;
    const drawRow = (r: string[], bold: boolean) => {
      const maxH = bottomY() - PAGE.top - 4;
      const h = Math.min(cellH(r, bold), maxH);
      if (h > remaining()) newPage();
      const y = doc.y;
      let x = PAGE.left;
      if (bold) doc.save().rect(PAGE.left, y, contentW, h).fill(tableHead).restore();
      r.forEach((cell, k) => {
        doc.save().lineWidth(0.6).strokeColor(rule).rect(x, y, widths[k], h).stroke().restore();
        doc.font(bold ? FONTS[bodyFamily].b : FONTS[bodyFamily].r).fontSize(SIZE.table).fillColor(ink);
        words += countWords(cell);
        doc.text(cell, x + pad, y + pad, { width: widths[k] - 2 * pad, height: h - 2 * pad + 1, lineGap: 1.5, ellipsis: true });
        x += widths[k];
      });
      doc.x = PAGE.left;
      doc.y = y + h;
    };
    ensure(cellH(header, true) + (rows[0] ? cellH(rows[0], false) : 0));
    drawRow(header, true);
    for (const r of rows) {
      if (cellH(r, false) > remaining()) {
        newPage();
        drawRow(header, true);
      }
      drawRow(r, false);
    }
    paraGap();
  };

  const list = (items: Run[][], ordered: boolean) => {
    const indent = 18;
    items.forEach((it, k) => {
      ensure(SIZE.body * 2.6);
      const y = doc.y;
      const marker = ordered ? `${k + 1}.` : '•';
      doc.font(ordered ? FONTS[bodyFamily].b : FONTS[bodyFamily].r).fontSize(SIZE.body).fillColor(accent).text(marker, PAGE.left + 2, y, { width: indent - 2, lineBreak: false });
      doc.y = y;
      textRuns(it, PAGE.left + indent, contentW - indent, { size: SIZE.body, color: ink, family: bodyFamily });
      doc.y += SIZE.body * 0.3;
    });
    paraGap();
  };

  const blocks = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === 'h') {
        const size = b.level <= 2 ? SIZE.h2 : b.level === 3 ? SIZE.h3 : SIZE.h4;
        heading(b.text, size, b.level <= 2 ? accent : ink);
      } else if (b.t === 'p') {
        ensure(SIZE.body * 2.4);
        textRuns(b.runs, PAGE.left, contentW, { size: SIZE.body, color: ink, family: bodyFamily, align: 'left' });
        paraGap();
      } else if (b.t === 'callout') {
        leftBarBlock([b.runs], { color: ink, bar: accent });
      } else if (b.t === 'quote') {
        leftBarBlock(b.paras, { italic: true, color: inkSoft, bar: rule });
      } else if (b.t === 'list') {
        list(b.items, b.ordered);
      } else if (b.t === 'table') {
        table(b.header, b.rows);
      } else if (b.t === 'code') {
        leftBarBlock(b.lines.map((l) => [{ text: l || ' ', code: true }]), { color: ink, bar: rule });
      } else if (b.t === 'hr') {
        if (doc.y > PAGE.top + 1 && remaining() > 24) {
          doc.save().lineWidth(0.6).strokeColor(rule).moveTo(PAGE.left, doc.y + 4).lineTo(PAGE.left + contentW, doc.y + 4).stroke().restore();
          doc.y += 14;
        }
      }
    }
  };

  // ── 1. Portada ──
  newPage();
  doc.save().rect(0, 0, PAGE.w, 10).fill(accent).restore();
  // Fix round 1 (i): el logo resuelto a opacidad plena, arriba a la izquierda (≤ 150 × 60 pt), lejos de la marca de agua.
  {
    const sc = Math.min(150 / logo.width, 60 / logo.height);
    doc.image(wmImage, PAGE.left, 66, { width: logo.width * sc, height: logo.height * sc, ignoreOrientation: true } as any);
    coverLogoDraws++;
  }
  doc.y = 150;
  if (brandName) {
    doc.font(FONTS.sans.b).fontSize(10.5).fillColor(accent).text(brandName, PAGE.left, doc.y, { width: contentW, characterSpacing: 0.6 });
    words += countWords(brandName);
    doc.y += 26;
  }
  eyebrow('Libro Guía', accent);
  doc.y += 4;
  doc.font(FONTS[headFamily].b).fontSize(30).fillColor(ink).text(courseTitle, PAGE.left, doc.y, { width: contentW, lineGap: 4 });
  words += countWords(courseTitle);
  doc.y += 14;
  accentRule(accent, 72, 3);
  const nCh = modules.reduce((s, m) => s + m.chapters.length, 0);
  const coverLine = `${modules.length} ${modules.length === 1 ? 'módulo' : 'módulos'} · ${nCh} ${nCh === 1 ? 'capítulo' : 'capítulos'}${hasBibliography ? ' · bibliografía verificada' : ''}`;
  doc.font(FONTS[bodyFamily].r).fontSize(12).fillColor(inkSoft).text(coverLine, PAGE.left, doc.y, { width: contentW });
  doc.y += 8;
  doc.font(FONTS[bodyFamily].r).fontSize(11).fillColor(inkSoft).text('Material de estudio del curso: el texto completo, organizado por módulos y capítulos.', PAGE.left, doc.y, { width: contentW });

  // ── 2. Índice (números de página al final, cuando se conocen) ──
  newPage();
  heading('Índice', SIZE.h1, ink, { count: false, after: 6 });
  accentRule(accent);
  interface TocLine { key: string; page: number; y: number; xEnd: number; bold: boolean }
  const toc: TocLine[] = [];
  const tocLine = (key: string, text: string, indent: number, bold: boolean) => {
    const size = bold ? 11 : 10.5;
    const numW = 30;
    const w = contentW - indent - numW;
    doc.font(bold ? FONTS[bodyFamily].b : FONTS[bodyFamily].r).fontSize(size);
    const h = doc.heightOfString(text, { width: w, lineGap: 2 });
    ensure(h + (bold ? 24 : 6));
    if (bold && toc.length) doc.y += 8;
    doc.fillColor(ink).text(text, PAGE.left + indent, doc.y, { width: w, lineGap: 2, goTo: key } as any);
    // puntos guía solo para entradas de una línea (en las largas, el número va solo al final de la última línea)
    const oneLine = h <= size * 1.6;
    const xEnd = oneLine ? PAGE.left + indent + doc.widthOfString(text) : PAGE.left + contentW;
    toc.push({ key, page: pageIdx, y: doc.y - doc.currentLineHeight(true), xEnd, bold });
    doc.y += 4;
  };
  modules.forEach((m) => {
    tocLine(`mod-${m.number}`, `Módulo ${m.number} — ${pdfText(m.title)}`, 0, true);
    m.chapters.forEach((ch) => tocLine(`cap-${ch.number}`, `Capítulo ${ch.number}. ${pdfText(ch.title)}`, 16, false));
  });
  if (hasBibliography) {
    doc.y += 6;
    tocLine('bibliografia', 'Bibliografía', 0, true);
  }

  // ── 3. Módulos y capítulos ──
  const startOf: Record<string, number> = {};
  const outline = (doc as any).outline;
  modules.forEach((m, mi) => {
    const mc = modColor(mi);
    newPage();
    startOf[`mod-${m.number}`] = pageIdx;
    doc.addNamedDestination(`mod-${m.number}`);
    const modOutline = outline.addItem(`Módulo ${m.number} — ${pdfText(m.title)}`);
    // prefacio en recuadro (si entra en la página; si no, sin recuadro y con la franja superior)
    const presentation = String(m.intro.presentation ?? '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => parseInline(p.replace(/\n/g, ' ')));
    const outcomes = (m.intro.outcomes ?? []).map((o) => parseInline(String(o)));
    const boxPad = 18;
    const innerW = contentW - 2 * boxPad;
    doc.font(FONTS[headFamily].b).fontSize(SIZE.h1);
    const titleH = doc.heightOfString(pdfText(m.title), { width: innerW, lineGap: 2 });
    const estH =
      boxPad * 2 + 20 + titleH + 16 + presentation.reduce((s, p) => s + measureRuns(p, innerW, SIZE.body, bodyFamily) + 8, 0) + 30 + outcomes.reduce((s, o) => s + measureRuns(o, innerW - 18, SIZE.body, bodyFamily) + 4, 0);
    const boxed = estH <= remaining();
    const y0 = doc.y;
    const L = boxed ? PAGE.left + boxPad : PAGE.left;
    const W = boxed ? innerW : contentW;
    if (boxed) {
      doc.y += boxPad;
    } else {
      doc.save().rect(PAGE.left, doc.y, contentW, 4).fill(mc).restore();
      doc.y += 14;
    }
    doc.font(FONTS.sans.b).fontSize(8.5).fillColor(mc).text(`MÓDULO ${m.number}`, L, doc.y, { width: W, characterSpacing: 1.6 });
    doc.y += 6;
    words += 2;
    doc.font(FONTS[headFamily].b).fontSize(SIZE.h1).fillColor(ink).text(pdfText(m.title), L, doc.y, { width: W, lineGap: 2 });
    words += countWords(pdfText(m.title));
    doc.y += 12;
    presentation.forEach((p) => {
      textRuns(p, L, W, { size: SIZE.body, color: ink, family: bodyFamily });
      doc.y += 8;
    });
    if (outcomes.length) {
      doc.y += 4;
      doc.font(FONTS[headFamily].b).fontSize(SIZE.h4).fillColor(ink).text('Al terminar este módulo podrás:', L, doc.y, { width: W });
      words += countWords('Al terminar este módulo podrás:');
      doc.y += 6;
      outcomes.forEach((o) => {
        const y = doc.y;
        doc.font(FONTS[bodyFamily].r).fontSize(SIZE.body).fillColor(mc).text('•', L + 2, y, { width: 14, lineBreak: false });
        doc.y = y;
        textRuns(o, L + 18, W - 18, { size: SIZE.body, color: ink, family: bodyFamily });
        doc.y += 4;
      });
    }
    if (boxed) {
      doc.y += boxPad;
      doc.save().lineWidth(1.2).strokeColor(mc).roundedRect(PAGE.left, y0, contentW, doc.y - y0, 8).stroke().restore();
      doc.save().rect(PAGE.left + 8, y0, contentW - 16, 4).fill(mc).restore();
    }
    doc.x = PAGE.left;

    m.chapters.forEach((ch) => {
      newPage();
      startOf[`cap-${ch.number}`] = pageIdx;
      doc.addNamedDestination(`cap-${ch.number}`);
      modOutline.addItem(`Capítulo ${ch.number}. ${pdfText(ch.title)}`);
      eyebrow(`Capítulo ${ch.number}`, mc);
      words += 2;
      heading(pdfText(ch.title), SIZE.h1, ink, { before: 0, after: 8 });
      accentRule(mc);
      const md = stripLeadingDuplicateTitle(String(ch.md ?? ''), ch.title, ch.number);
      blocks(parseLibroMarkdown(md));
    });
  });

  // ── 4. Bibliografía ──
  const entry = (b: BibliographyEntry) => {
    const runs: Run[] = [
      { text: pdfText(`${b.author} (${b.year}). `) },
      { text: pdfText(b.title), i: true },
      { text: pdfText(`. ${b.publisher}.`) },
    ];
    ensure(SIZE.body * 2.6);
    textRuns(runs, PAGE.left + 12, contentW - 12, { size: SIZE.body, color: ink, family: bodyFamily });
    doc.y += 5;
  };
  if (hasBibliography) {
    newPage();
    startOf.bibliografia = pageIdx;
    doc.addNamedDestination('bibliografia');
    outline.addItem('Bibliografía');
    heading('Bibliografía', SIZE.h1, ink, { before: 0, after: 6 });
    accentRule(accent);
    if (bib.course.length) {
      heading('Bibliografía general del curso', SIZE.h3, accent);
      bib.course.forEach(entry);
    }
    for (const mb of bib.modules) {
      heading(`Módulo ${mb.number} — ${pdfText(mb.title)}`, SIZE.h3, accent);
      mb.entries.forEach(entry);
    }
  }

  // ── 5. Números del índice, encabezado y pie (con la cantidad final de páginas) ──
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (const l of toc) {
    const target = startOf[l.key];
    if (target === undefined) throw new Error(`LIBRO_V3_INVALID: el índice apunta a "${l.key}" que no está en el libro`);
    doc.switchToPage(l.page);
    const saveBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const num = String(target + 1);
    const size = l.bold ? 11 : 10.5;
    doc.font(l.bold ? FONTS[bodyFamily].b : FONTS[bodyFamily].r).fontSize(size).fillColor(l.bold ? ink : inkSoft);
    const numW = doc.widthOfString(num);
    const numX = PAGE.left + contentW - numW;
    doc.text(num, numX, l.y, { lineBreak: false, goTo: l.key } as any);
    const dotW = doc.font(FONTS[bodyFamily].r).fontSize(size).widthOfString(' .');
    const gap = numX - 6 - (l.xEnd + 6);
    if (gap > dotW * 2) {
      const dots = ' .'.repeat(Math.floor(gap / dotW));
      doc.fillColor('#9AA3AF').text(dots, numX - 6 - doc.widthOfString(dots), l.y, { lineBreak: false });
    }
    doc.page.margins.bottom = saveBottom;
  }
  for (let p = 1; p < total; p++) {
    doc.switchToPage(p);
    const saveBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    // encabezado: título del curso (recortado a una línea) · «Libro Guía»
    doc.font(FONTS.sans.r).fontSize(SIZE.small);
    const rightTxt = 'Libro Guía';
    const rightW = doc.widthOfString(rightTxt);
    let head = courseTitle;
    const maxW = contentW - rightW - 24;
    if (doc.widthOfString(head) > maxW) {
      while (head.length > 4 && doc.widthOfString(`${head}…`) > maxW) head = head.slice(0, -1);
      head = `${head.trimEnd()}…`;
    }
    doc.fillColor(inkSoft).text(head, PAGE.left, 40, { lineBreak: false });
    doc.fillColor(accent).text(rightTxt, PAGE.left + contentW - rightW, 40, { lineBreak: false });
    doc.save().lineWidth(0.6).strokeColor(rule).moveTo(PAGE.left, 54).lineTo(PAGE.left + contentW, 54).stroke().restore();
    // pie: marca · «Página X de Y»
    const fy = PAGE.h - 46;
    doc.save().lineWidth(0.6).strokeColor(rule).moveTo(PAGE.left, fy - 8).lineTo(PAGE.left + contentW, fy - 8).stroke().restore();
    const pg = `Página ${p + 1} de ${total}`;
    doc.font(FONTS.sans.r).fontSize(SIZE.small).fillColor(inkSoft);
    doc.text(pg, PAGE.left + contentW - doc.widthOfString(pg), fy, { lineBreak: false });
    if (brandName) {
      let bn = brandName;
      while (bn.length > 4 && doc.widthOfString(bn) > contentW / 2) bn = bn.slice(0, -1);
      doc.text(bn, PAGE.left, fy, { lineBreak: false });
    }
    doc.page.margins.bottom = saveBottom;
  }

  const draws = watermarkDraws.slice(0, total);
  if (draws.length !== total || draws.some((d) => d !== 1)) {
    throw new Error(`LIBRO_V3_WATERMARK: se esperaba exactamente 1 marca de agua por página (${draws.join(',')})`);
  }
  doc.end();
  await done;
  const pdf = Buffer.concat(chunks);
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-' || !/%%EOF\s*$/.test(pdf.subarray(-32).toString('latin1'))) {
    throw new Error('LIBRO_V3_INVALID: el PDF del Libro Guía quedó incompleto');
  }
  const chapterPages: Record<number, number> = {};
  for (const m of modules) for (const ch of m.chapters) chapterPages[ch.number] = (startOf[`cap-${ch.number}`] as number) + 1;
  if (coverLogoDraws !== 1) throw new Error(`LIBRO_V3_WATERMARK: se esperaba exactamente 1 logo en la portada (${coverLogoDraws})`);
  return { pdf, pageCount: total, wordCount: words, hasBibliography, watermarkDrawsPerPage: draws, chapterPages, coverLogoDraws, unmappedChars: libroUnmappedChars(input) };
}
