/**
 * r107 B12 (H1) · escaneo LINEAL de bloques XML/HTML del paquete, sin regex de cuerpo perezoso (`[\s\S]*?`).
 *
 * Por qué: `/<x>([\s\S]*?)<\/x>/` sobre un texto con muchos `<x>` sin cierre es O(n²) — por cada apertura el motor
 * recorre hasta el final buscando `</x>`. Un moodle_backup.xml de 400 KB (958 B subidos) bloqueaba el event loop 18 s.
 *
 * Contrato (igual al de la regex perezosa en entradas bien formadas):
 *   - apertura: primera coincidencia de `open` desde el cursor (texto literal o regex SIN cuerpo perezoso);
 *   - cierre: primera coincidencia de `close` DESDE el fin de la apertura (indexOf / regex con lastIndex);
 *   - sin cierre → no hay bloque y la lista TERMINA (ninguna apertura posterior puede tener cierre después);
 *   - listas: el cursor sigue tras el cierre (sin solapes, como `matchAll`).
 * Cada búsqueda avanza el cursor, así que el costo total es lineal en el largo del texto.
 */

export type ScanOpen = string | RegExp;
export type ScanClose = string | RegExp | ((open: RegExpExecArray | null) => string | RegExp);

export interface ScanBlock {
  /** Índice del primer carácter de la apertura. */
  start: number;
  /** Índice tras el último carácter del cierre. */
  end: number;
  innerStart: number;
  innerEnd: number;
  /** Bloque entero (apertura + cuerpo + cierre). */
  whole: string;
  /** Cuerpo entre la apertura y el cierre. */
  inner: string;
  /** Coincidencia de la apertura (null si `open` es texto). */
  open: RegExpExecArray | null;
  /** Coincidencia del cierre (null si `close` es texto). */
  close: RegExpExecArray | null;
}

const globalOf = (re: RegExp): RegExp => (re.global ? new RegExp(re.source, re.flags) : new RegExp(re.source, `${re.flags}g`));

interface Hit { start: number; end: number; m: RegExpExecArray | null }

function find(text: string, pat: string | RegExp, from: number): Hit | null {
  if (typeof pat === 'string') {
    const i = text.indexOf(pat, from);
    return i < 0 ? null : { start: i, end: i + pat.length, m: null };
  }
  pat.lastIndex = from;
  const m = pat.exec(text);
  if (!m) return null;
  // Una regex que coincide vacío no avanza: se trata como el carácter siguiente para no quedar en bucle.
  return { start: m.index, end: m.index + Math.max(m[0].length, 0), m };
}

/**
 * Escáner reutilizable (compila las regex una vez).
 * Cierre FIJO: si no aparece desde una apertura, tampoco aparece desde ninguna posterior → no hay más bloques.
 * Cierre que DEPENDE de la apertura (`<\/\1>`): la regex probaría la apertura siguiente; acá también, pero cada cierre
 * que ya falló se recuerda y no se vuelve a buscar (sigue siendo lineal: a lo sumo una búsqueda fallida por cierre).
 */
function scanner(open: ScanOpen, close: ScanClose) {
  const o = typeof open === 'string' ? open : globalOf(open);
  const staticClose = typeof close === 'function' ? null : typeof close === 'string' ? close : globalOf(close);
  let failed = new Set<string>();
  let lastText: string | null = null;
  return (text: string, from: number, to: number): ScanBlock | null => {
    if (text !== lastText) { failed = new Set<string>(); lastText = text; }
    let cur = from;
    for (;;) {
      const a = find(text, o, cur);
      if (!a || a.start >= to) return null;
      const c0 = staticClose ?? (close as (m: RegExpExecArray | null) => string | RegExp)(a.m);
      const key = typeof c0 === 'string' ? `s:${c0}` : `r:${c0.source}/${c0.flags}`;
      const b = staticClose || !failed.has(key) ? find(text, typeof c0 === 'string' || staticClose ? c0 : globalOf(c0), a.end) : null;
      if (b && b.end <= to) {
        return {
          start: a.start, end: b.end, innerStart: a.end, innerEnd: b.start,
          whole: text.slice(a.start, b.end), inner: text.slice(a.end, b.start), open: a.m, close: b.m,
        };
      }
      if (staticClose) return null;
      if (!b) failed.add(key);
      cur = a.start + 1;
    }
  };
}

/** Primer bloque desde `from` (y que termine antes de `to`), o null. */
export function firstBlock(text: string, open: ScanOpen, close: ScanClose, from = 0, to = text.length): ScanBlock | null {
  return scanner(open, close)(text, from, to);
}

/** Todos los bloques, en orden, sin solapes. */
export function allBlocks(text: string, open: ScanOpen, close: ScanClose, from = 0): ScanBlock[] {
  const next = scanner(open, close);
  const out: ScanBlock[] = [];
  let cur = from;
  while (cur <= text.length) {
    const b = next(text, cur, text.length);
    if (!b) break;
    out.push(b);
    cur = b.end > cur ? b.end : cur + 1;
  }
  return out;
}

/** Último bloque (equivale a `[...matchAll()].pop()`). */
export function lastBlock(text: string, open: ScanOpen, close: ScanClose): ScanBlock | null {
  const all = allBlocks(text, open, close);
  return all.length ? all[all.length - 1] : null;
}

/** Reemplaza cada bloque (o solo el primero con `first`) por lo que devuelve `fn`; el resto del texto queda igual. */
export function replaceBlocks(text: string, open: ScanOpen, close: ScanClose, fn: (b: ScanBlock) => string, first = false): string {
  const blocks = first ? [firstBlock(text, open, close)].filter((b): b is ScanBlock => !!b) : allBlocks(text, open, close);
  if (!blocks.length) return text;
  let out = '';
  let cur = 0;
  for (const b of blocks) {
    out += text.slice(cur, b.start) + fn(b);
    cur = b.end;
  }
  return out + text.slice(cur);
}

/** Cuerpo del primer `<name>…</name>` (sin atributos), o null. */
export function tagInner(text: string, name: string, from = 0): string | null {
  const b = firstBlock(text, `<${name}>`, `</${name}>`, from);
  return b ? b.inner : null;
}

/** Quita comentarios y bloques `<style>`/`<script>` (lineal). Un bloque sin cierre queda como está (igual que la regex). */
export function stripCommentsAndBlocks(html: string, by = ' '): string {
  let s = replaceBlocks(html, '<!--', '-->', () => by);
  s = replaceBlocks(s, /<(style|script)\b/i, (m) => new RegExp(`</${m![1]}\\s*>`, 'i'), () => by);
  return s;
}

/** Quita etiquetas `<…>` en tiempo lineal (`<[^<>]*>`: una apertura sin `>` no se come el resto del texto). */
export function stripTags(html: string, by = ' '): string {
  return html.replace(/<[^<>]*>/g, by);
}

/** Inicio de la corrida de espacios que termina en `i` (equivale a un `(\s*)` delante de la apertura, sin backtracking). */
export function wsStart(text: string, i: number): number {
  let k = i;
  while (k > 0 && /\s/.test(text[k - 1])) k--;
  return k;
}

/** Bloque «codicioso»: desde el PRIMER `open` hasta el ÚLTIMO `close` (equivale a `/<x>[\s\S]*<\/x>/`). */
export function outerBlock(text: string, open: string, close: string): ScanBlock | null {
  const a = text.indexOf(open);
  if (a < 0) return null;
  const b = text.lastIndexOf(close);
  if (b < a + open.length) return null;
  return { start: a, end: b + close.length, innerStart: a + open.length, innerEnd: b, whole: text.slice(a, b + close.length), inner: text.slice(a + open.length, b), open: null, close: null };
}

/** Reemplaza un bloque concreto (por posición) por `by`. */
export function spliceBlock(text: string, b: { start: number; end: number }, by: string): string {
  return text.slice(0, b.start) + by + text.slice(b.end);
}

/** Escapa un texto para usarlo literal dentro de una RegExp. */
export const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bloques con la MISMA forma que `matchAll` de `/<apertura(grupos)>([\s\S]*?)<cierre>/g`:
 * `[entero, ...grupos de la apertura, cuerpo]` + `index`. Para migrar sin tocar el código que usa los índices.
 */
export function matchBlocks(text: string, open: ScanOpen, close: ScanClose, from = 0): Array<string[] & { index: number }> {
  return allBlocks(text, open, close, from).map((b) => Object.assign([b.whole, ...(b.open ? b.open.slice(1) : []), b.inner], { index: b.start }));
}

// ─── Etiquetas de apertura HTML (B12 ronda 1) ──────────────────────────────

export interface HtmlAttr { name: string; value: string | null; quote: '"' | "'" | '' }
export interface OpenTag {
  /** Índice del `<`. */
  start: number;
  /** Índice tras el `>`. */
  end: number;
  /** La etiqueta entera (`<a …>`). */
  text: string;
  attrs: HtmlAttr[];
}

/**
 * Fin (índice tras el `>`) de una etiqueta que empieza antes de `from`: el primer `>` fuera de comillas. -1 si no cierra
 * (una comilla o la etiqueta abierta hasta el final: según HTML, todo lo que sigue es parte de esa etiqueta).
 */
function tagEnd(html: string, from: number): number {
  let q = '';
  for (let k = from; k < html.length; k++) {
    const c = html[k];
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') return k + 1;
  }
  return -1;
}

/** Atributos de una etiqueta de apertura, en una pasada (nombre, valor entre comillas o suelto). */
export function parseAttrs(tag: string, from: number): HtmlAttr[] {
  const out: HtmlAttr[] = [];
  const n = tag.length;
  const ws = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  let i = from;
  while (i < n) {
    while (i < n && (ws(tag[i]) || tag[i] === '/')) i++;
    if (i >= n || tag[i] === '>') break;
    const s = i;
    while (i < n && !ws(tag[i]) && tag[i] !== '=' && tag[i] !== '>' && !(tag[i] === '/' && tag[i + 1] === '>')) i++;
    const name = tag.slice(s, i).toLowerCase();
    if (i === s) { i++; continue; }
    let j = i;
    while (j < n && ws(tag[j])) j++;
    if (tag[j] !== '=') { out.push({ name, value: null, quote: '' }); i = j; continue; }
    j++;
    while (j < n && ws(tag[j])) j++;
    const c = tag[j];
    if (c === '"' || c === "'") {
      let e = tag.indexOf(c, j + 1);
      if (e < 0) e = n;
      out.push({ name, value: tag.slice(j + 1, e), quote: c });
      i = e + 1;
    } else {
      let e = j;
      while (e < n && !ws(tag[e]) && tag[e] !== '>') e++;
      out.push({ name, value: tag.slice(j, e), quote: '' });
      i = e;
    }
  }
  return out;
}

/**
 * Etiquetas de apertura que empiezan con `opener` (p. ej. `/<a\b/i`), en orden y LINEAL: cada una termina en su primer
 * `>` fuera de comillas; una que no termina corta la lista (lo que sigue es parte de ella). `from` = desde dónde buscar.
 */
export function openTags(html: string, opener: RegExp, from = 0): OpenTag[] {
  const re = globalOf(opener);
  const out: OpenTag[] = [];
  let cur = from;
  for (;;) {
    re.lastIndex = cur;
    const m = re.exec(html);
    if (!m) break;
    const body = m.index + m[0].length;
    const end = tagEnd(html, body);
    if (end < 0) break;
    const text = html.slice(m.index, end);
    out.push({ start: m.index, end, text, attrs: parseAttrs(text, m[0].length) });
    cur = end;
  }
  return out;
}

/** Valor del primer atributo `name` (en minúsculas) de una etiqueta, o null. */
export const attrOf = (t: OpenTag, name: string): HtmlAttr | null => t.attrs.find((a) => a.name === name) ?? null;

/** Quita del final una cerca de código ``` (con los espacios de alrededor), sin regex (`\s*```\s*$` era cuadrática). */
export function stripTrailingFence(s: string): string {
  const t = s.trimEnd();
  return t.endsWith('```') ? t.slice(0, -3).trimEnd() : s;
}

/** Primer `ch` con espacios antes → sin esos espacios (equivale a `.replace(/\s+ch/, ch)`, lineal). */
export function dropWsBefore(s: string, ch: string): string {
  for (let i = s.indexOf(ch); i >= 0; i = s.indexOf(ch, i + 1)) {
    const k = wsStart(s, i);
    if (k < i) return s.slice(0, k) + s.slice(i);
  }
  return s;
}

/** Tokens de todos los atributos `class="…"` de un HTML (lineal; una comilla sin cerrar corta la búsqueda). */
export function classTokens(html: string): Set<string> {
  const out = new Set<string>();
  for (let i = html.indexOf('class="'); i >= 0; ) {
    const v = i + 7;
    const e = html.indexOf('"', v);
    if (e < 0) break;
    for (const t of html.slice(v, e).split(/\s+/)) if (t) out.add(t);
    i = html.indexOf('class="', e + 1);
  }
  return out;
}

/** Quita del final cualquier carácter de `chars` (lineal; `/[…]+$/` es cuadrática con una corrida que no llega al final). */
export function trimEndChars(s: string, chars: string): string {
  let k = s.length;
  while (k > 0 && chars.includes(s[k - 1])) k--;
  return s.slice(0, k);
}

/**
 * Quita las etiquetas de un HTML respetando las comillas de los atributos (`title="x < y"` no corta la etiqueta), en
 * tiempo lineal. `<` seguido de algo que no abre una etiqueta (espacio, número…) es texto y queda. Una etiqueta que no
 * termina (sin `>` fuera de comillas) queda tal cual, con todo lo que sigue. Para HTML que se ESCRIBE al paquete.
 */
export function stripTagsQuoted(html: string): string {
  let out = '';
  let cur = 0;
  for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', cur)) {
    const c = html[i + 1] ?? '';
    if (!/[A-Za-z\/!?]/.test(c)) { out += html.slice(cur, i + 1); cur = i + 1; continue; }
    const e = tagEnd(html, i + 1);
    if (e < 0) break;
    out += html.slice(cur, i);
    cur = e;
  }
  return out + html.slice(cur);
}

/**
 * Cada `marca` con TODO el espacio en blanco (\s) pegado a cada lado → `by`. Equivale a
 * `s.replace(new RegExp(`\\s*${marca}\\s*`, 'g'), by)` pero lineal (la regex es cuadrática con corridas de espacios).
 */
export function replaceMarkWithWs(s: string, mark: string, by: string): string {
  const isWs = (ch: string) => /\s/.test(ch);
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const k = s.indexOf(mark, i);
    if (k < 0) { parts.push(s.slice(i)); break; }
    let chunk = s.slice(i, k);
    let t = chunk.length;
    while (t > 0 && isWs(chunk[t - 1])) t--;
    chunk = chunk.slice(0, t);
    parts.push(chunk, by);
    i = k + mark.length;
    while (i < s.length && isWs(s[i])) i++;
  }
  return parts.join('');
}
