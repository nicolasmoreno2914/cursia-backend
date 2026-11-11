/**
 * r107 B4 · motor de parches — escritura de campos HTML dentro de los XML del paquete.
 *
 * Reglas (las de los builders, CLAUDE.md «Convenciones de ids» y changelog #1):
 *   - el texto nuevo se escribe con `xmlEsc` EXACTO de los builders (`src/package/mbz-common.ts`: `& < > "`, SIN
 *     apóstrofes) — nunca otro escape;
 *   - todo reemplazo es POR POSICIÓN (concatenación de bytes): jamás `String.replace` con un string de reemplazo, que
 *     expande `$&`, `$1`, `$$`… (el bug que rompía los tokens);
 *   - antes de tocar un campo se verifica que sus bytes sean los que dice el inventario (sha1 del crudo): si una
 *     operación anterior del plan lo cambió, la operación falla (`stale_target`), nunca escribe a ciegas;
 *   - el contenido nuevo no trae tokens inválidos, `<style>`/`<script>` nuevos (Moodle los elimina con forceclean:
 *     estilos inline) ni archivos `@@PLUGINFILE@@` que la actividad no tenga.
 */
import { xmlEsc } from '../../../package/mbz-common';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { TokenContext, WorkshopActivity, WorkshopCourse, WorkshopHtmlField, extractTokens, pluginfileRefs, tokenKindShape } from '../course-model';
import { PatchState, sha1Of } from './container';
import { PatchError } from './types';
import { matchBlocks } from '../xml-scan';

export { xmlEsc };

/** Concatena trozos (nunca String.replace). */
export const spliceStr = (s: string, start: number, end: number, ins: string): string => s.slice(0, start) + ins + s.slice(end);
export const spliceBuf = (b: Buffer, start: number, end: number, ins: Buffer): Buffer => Buffer.concat([b.subarray(0, start), ins, b.subarray(end)]);

const ENTITY = /^&(?:lt|gt|quot|amp|#39);/;

/**
 * Para un contenido CRUDO (escapado), el índice crudo de cada límite de carácter desescapado: `map[i]` = posición en el
 * crudo donde empieza el carácter desescapado i (`map[len]` = largo del crudo). Inversa exacta de `xmlUnescape`.
 */
export function rawIndexMap(raw: string): number[] {
  const map: number[] = [];
  let i = 0;
  while (i < raw.length) {
    map.push(i);
    const m = raw.charCodeAt(i) === 0x26 ? ENTITY.exec(raw.slice(i, i + 6)) : null;
    i += m ? m[0].length : 1;
  }
  map.push(raw.length);
  return map;
}

/** Ubicación de un campo en el estado actual, verificada contra el inventario. */
export interface LocatedField {
  field: WorkshopHtmlField;
  entry: string;
  entryBuf: Buffer;
  raw: string;
}

export async function locateField(state: PatchState, f: WorkshopHtmlField): Promise<LocatedField> {
  const entryBuf = await state.read(f.entry);
  const slice = entryBuf.subarray(f.rawOffset, f.rawOffset + f.rawBytes);
  if (sha1Of(slice) !== f.rawSha1) throw new PatchError('stale_target', `El campo ${f.field} de ${f.entry} no coincide con el inventario (cambió por otra operación): no se escribe a ciegas.`);
  return { field: f, entry: f.entry, entryBuf, raw: slice.toString('utf8') };
}

/** Escribe el crudo nuevo del campo en su entrada (por posición en bytes). Devuelve el crudo nuevo. */
export function writeField(state: PatchState, loc: LocatedField, newRaw: string): void {
  const start = loc.field.rawOffset;
  state.write(loc.entry, spliceBuf(loc.entryBuf, start, start + loc.field.rawBytes, Buffer.from(newRaw, 'utf8')));
}

// ─── Validación del contenido nuevo ─────────────────────────────────────────

// B12 (H1): bloques <style>/<script> con escaneo lineal (antes `[\s\S]*?` con referencia hacia atrás).
const blocksIn = (h: string): string[][] => matchBlocks(h, /<(style|script)\b/i, (o) => new RegExp(`</${o![1]}\\s*>`, 'i'));
const OPEN_BLOCK = /<(style|script)\b/gi;

export interface HtmlValidationCtx {
  tokenCtx: TokenContext;
  /** HTML anterior del campo (lo que ya estaba se acepta: estilos/scripts y archivos que ya usaba). */
  oldHtml: string;
  /** Nombres de archivo de la actividad (para `@@PLUGINFILE@@`). */
  files: string[];
  where: string;
}

/** Tokens no válidos en un HTML (desescapado o crudo: los tokens no llevan caracteres que xmlEsc escape). */
export function badTokens(html: string, tokenCtx: TokenContext): Array<{ token: string; status: string; count: number }> {
  return extractTokens(html, { field: 'x', entry: 'x' }, tokenCtx)
    .filter((t) => t.status !== 'ok' && t.status !== 'unchecked')
    .map((t) => ({ token: t.status === 'malformed' ? `${t.token}${t.context ?? ''}` : t.token, status: t.status, count: t.count }));
}

/**
 * Fix round 1 (P1-1): en el HTML NUEVO un token solo pasa si es de un tipo que Moodle conoce y, si su tipo lleva id,
 * trae los ids que corresponden y apunta a algo que existe en su espacio de ids (estado `ok`). Un tipo inventado
 * (`$@ACTIVITYVIEWBYID*9@$`, `$@FOOBAR*7@$`), un token sin id (`$@SCORMVIEWBYID@$`) o uno que no se puede verificar →
 * la operación falla. Sin id solo los tipos que existen así (`WWWROOT`).
 */
export function strictTokenProblems(html: string, tokenCtx: TokenContext): string[] {
  const out: string[] = [];
  const resolved = new Map(extractTokens(html, { field: 'x', entry: 'x' }, tokenCtx).filter((t) => t.status !== 'malformed').map((t) => [t.token, t]));
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)((?:\*\d+)*)@(\$)?/g)) {
    const tok = m[0];
    if (m[3] === undefined) { out.push(`«${tok}» está mal formado (no cierra en @$)`); continue; }
    const shape = tokenKindShape(m[1]);
    const ids = (m[2].match(/\*\d+/g) || []).length;
    if (shape.shape === 'unknown') { out.push(`«${tok}» no es un tipo de token que Moodle conozca`); continue; }
    if (shape.shape === 'idless') { if (ids) out.push(`«${tok}» no lleva id`); continue; }
    if (ids !== shape.ids) { out.push(`«${tok}» necesita ${shape.ids} id(s)`); continue; }
    const t = resolved.get(tok);
    const st = t ? t.status : 'unchecked';
    if (st !== 'ok') out.push(`«${tok}» ${st === 'orphan' ? 'apunta a una actividad que no existe' : st === 'wrong_type' ? 'apunta a una actividad de otro tipo' : st === 'external' ? 'apunta a otro curso' : 'no se puede verificar contra el paquete'}`);
  }
  return out;
}

/**
 * Valida un FRAGMENTO nuevo (lo que la operación escribe). `full` = el campo completo resultante: además se exige que
 * no tenga más tokens inválidos que antes (un reemplazo por rango que corta un token lo rompería).
 */
export function validateNewHtml(fragment: string, full: string, v: HtmlValidationCtx): void {
  const bad = strictTokenProblems(fragment, v.tokenCtx);
  if (bad.length) {
    throw new PatchError('invalid_content', `El HTML nuevo de ${v.where} trae un token inválido: ${bad[0]}. El motor nunca escribe un token inventado.`);
  }
  const count = (h: string) => badTokens(h, v.tokenCtx).reduce((s, t) => s + t.count, 0);
  if (count(full) > count(v.oldHtml)) throw new PatchError('invalid_content', `El cambio en ${v.where} rompe un token $@…@$ existente.`);
  const oldBlocks = new Set(blocksIn(v.oldHtml).map((m) => m[0]));
  for (const m of blocksIn(full)) {
    if (!oldBlocks.has(m[0])) throw new PatchError('invalid_content', `El HTML nuevo de ${v.where} trae un bloque <${m[1].toLowerCase()}>: Moodle lo elimina (forceclean). Los estilos van inline (style="…").`);
  }
  const opens = (h: string) => (h.match(OPEN_BLOCK) || []).length;
  const closed = (h: string) => blocksIn(h).length;
  if (opens(full) - closed(full) > opens(v.oldHtml) - closed(v.oldHtml)) throw new PatchError('invalid_content', `El HTML nuevo de ${v.where} abre un <style>/<script> sin cerrarlo.`);
  const okFiles = new Set([...pluginfileRefs(v.oldHtml), ...v.files]);
  for (const f of pluginfileRefs(fragment)) {
    if (!okFiles.has(f)) throw new PatchError('invalid_content', `El HTML nuevo de ${v.where} usa el archivo «${f}» (@@PLUGINFILE@@), que la actividad no tiene.`);
  }
}

// ─── Cambios ────────────────────────────────────────────────────────────────

export interface FieldEditResult { newRaw: string; fragment: string; newHtml: string; notes: string[] }

/** Reemplazo completo. */
export function replaceAll(html: string): FieldEditResult {
  return { newRaw: xmlEsc(html), fragment: html, newHtml: html, notes: [] };
}

/** Reemplazo de un rango de BYTES del crudo del campo. El rango no puede cortar un carácter UTF-8 ni una entidad. */
export function replaceRange(raw: string, rawByteOffset: number, rawBytes: number, html: string): FieldEditResult {
  const b = Buffer.from(raw, 'utf8');
  if (!Number.isInteger(rawByteOffset) || !Number.isInteger(rawBytes) || rawByteOffset < 0 || rawBytes < 0 || rawByteOffset + rawBytes > b.length) {
    throw new PatchError('invalid_params', `Rango ${rawByteOffset}+${rawBytes} fuera del campo (${b.length} bytes).`);
  }
  const cont = (i: number) => i < b.length && (b[i] & 0xc0) === 0x80;
  if (cont(rawByteOffset) || cont(rawByteOffset + rawBytes)) throw new PatchError('invalid_params', 'El rango corta un carácter UTF-8 a la mitad.');
  const before = b.subarray(0, rawByteOffset).toString('utf8');
  const after = b.subarray(rawByteOffset + rawBytes).toString('utf8');
  const map = new Set(rawIndexMap(raw));
  if (!map.has(before.length) || !map.has(before.length + b.subarray(rawByteOffset, rawByteOffset + rawBytes).toString('utf8').length)) {
    throw new PatchError('invalid_params', 'El rango corta una entidad XML (&amp;, &lt;…) a la mitad.');
  }
  const newRaw = before + xmlEsc(html) + after;
  return { newRaw, fragment: html, newHtml: xmlUnescape(newRaw), notes: [`rango ${rawByteOffset}+${rawBytes} bytes reemplazado`] };
}


/** Ocurrencias (índices en el HTML desescapado) de un token exacto. */
function tokenPositions(html: string, token: string): number[] {
  const out: number[] = [];
  for (let i = html.indexOf(token); i >= 0; i = html.indexOf(token, i + token.length)) {
    // El token tiene que terminar ahí (no prefijo de otro id: `*12@$` vs `*123@$` no aplica porque cierra en `@$`).
    out.push(i);
  }
  return out;
}

/**
 * Cambios sobre un token exacto, mapeados al crudo (por posición). `unlink`: cada `<a …>` cuyo atributo href contiene el
 * token se reemplaza por su texto interno; una aparición fuera de un enlace hace fallar la operación.
 */
export function editToken(raw: string, token: string, action: 'unlink' | 'retarget', to?: string): FieldEditResult {
  if (!/^\$@[A-Z0-9_]+(\*\d+){0,2}@\$$/.test(token)) throw new PatchError('invalid_params', `«${token}» no es un token $@…@$.`);
  const html = xmlUnescape(raw);
  const pos = tokenPositions(html, token);
  if (!pos.length) throw new PatchError('target_not_found', `El campo no tiene el token ${token}.`);
  const map = rawIndexMap(raw);
  // Ediciones en el HTML desescapado [start, end) → texto nuevo; se aplican al crudo de atrás hacia adelante.
  const edits: Array<{ start: number; end: number; ins: string }> = [];
  if (action === 'retarget') {
    if (!to || !/^\$@[A-Z0-9_]+(\*\d+){0,2}@\$$/.test(to)) throw new PatchError('invalid_params', `El token nuevo «${to ?? ''}» no es un token $@…@$.`);
    for (const p of pos) edits.push({ start: p, end: p + token.length, ins: to });
  } else {
    // Fix round 1 (P2-8): etiqueta de apertura con atributos entre comillas (pueden traer «>»), cierre `</a >` /
    // `</A\n>` incluidos; un `<a` antes del cierre (enlace anidado o sin cerrar) → falla, nunca deja un enlace abierto.
    const OPEN_A = /<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    const covered = new Set<number>();
    for (const a of html.matchAll(OPEN_A)) {
      const s = a.index ?? 0;
      const hrefs = [...a[0].matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((h) => h[1] ?? h[2] ?? h[3] ?? '');
      if (!hrefs.some((h) => h.includes(token))) continue;
      const after = s + a[0].length;
      const closeRe = /<\/a\s*>/gi; closeRe.lastIndex = after;
      const cm = closeRe.exec(html);
      if (!cm) throw new PatchError('invalid_content', `El enlace con ${token} no cierra (</a>): no se puede quitar sin romper el HTML.`);
      const nextOpen = /<a\b/gi; nextOpen.lastIndex = after;
      const no = nextOpen.exec(html);
      if (no && no.index < cm.index) throw new PatchError('invalid_content', `El enlace con ${token} tiene otro enlace adentro o no cierra antes del siguiente: no se quita a ciegas.`);
      edits.push({ start: s, end: cm.index + cm[0].length, ins: html.slice(after, cm.index) });
      for (const p of pos) if (p >= s && p < after) covered.add(p);
    }
    const loose = pos.filter((p) => !covered.has(p));
    if (loose.length) throw new PatchError('unsupported', `El token ${token} aparece fuera de un enlace <a href> (p. ej. en un iframe o una imagen): no se puede sanear sin dejar el contenido roto.`);
  }
  edits.sort((x, y) => y.start - x.start);
  let out = raw;
  for (const e of edits) out = spliceStr(out, map[e.start], map[e.end], xmlEsc(e.ins));
  return { newRaw: out, fragment: action === 'retarget' ? (to as string) : '', newHtml: xmlUnescape(out), notes: [`${token}: ${action === 'unlink' ? `${edits.length} enlace(s) quitado(s), texto conservado` : `→ ${to} (${edits.length})`}`] };
}

/** Campo HTML destino (actividad o sección) en el inventario actual. */
export function findField(inv: WorkshopCourse, target: { moduleId?: number; sectionId?: number; field?: string }): { field: WorkshopHtmlField; activity: WorkshopActivity | null; sectionId: number | null; where: string } {
  if (typeof target.moduleId === 'number') {
    const a = inv.activities.find((x) => x.moduleId === target.moduleId);
    if (!a) throw new PatchError('target_not_found', `No existe la actividad ${target.moduleId} en el paquete.`);
    const f = a.html.find((h) => h.field === target.field);
    if (!f) throw new PatchError('target_not_found', `La actividad ${a.dir} no tiene el campo «${target.field}» (tiene: ${a.html.map((h) => h.field).join(', ') || 'ninguno'}).`);
    if (f.field === 'externalurl') throw new PatchError('unsupported', 'El enlace de un recurso URL no es HTML: no se edita con edit_html.');
    return { field: f, activity: a, sectionId: null, where: `${a.dir} (${f.field})` };
  }
  if (typeof target.sectionId === 'number') {
    const s = inv.sections.find((x) => x.id === target.sectionId);
    if (!s) throw new PatchError('target_not_found', `No existe la sección ${target.sectionId} en el paquete.`);
    const f = s.html.find((h) => h.field === (target.field ?? 'summary'));
    if (!f) throw new PatchError('target_not_found', `La sección ${s.id} no tiene resumen editable.`);
    return { field: f, activity: null, sectionId: s.id, where: `sección ${s.number ?? s.id} (resumen)` };
  }
  throw new PatchError('invalid_params', 'Falta el destino: moduleId + field, o sectionId.');
}
