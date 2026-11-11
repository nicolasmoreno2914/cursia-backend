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
