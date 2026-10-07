/**
 * LOOP 8.3 · Valores del diseño FIJADOS por el docente (hoy: el video de un capítulo, cambiado a mano en el editor).
 * Viven en courses.metadata.designPins = { [chapterId]: { video: boolean } } (sin migración, como structureOrigin). El
 * distribuidor los respeta siempre (la prioridad audiovisual no los cambia) y «Liberar» los devuelve a Cursia.
 * Un id que ya no existe (capítulo borrado) simplemente se ignora.
 */
type Q = { query(sql: string, params?: any[]): Promise<any> };

export const DESIGN_PINS_KEY = 'designPins';
export type DesignPinsMap = Record<string, { video?: boolean }>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDesignPins(v: unknown): DesignPinsMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: DesignPinsMap = {};
  for (const [id, pin] of Object.entries(v as Record<string, unknown>)) {
    if (!UUID_RE.test(id) || !pin || typeof pin !== 'object') continue;
    const video = (pin as { video?: unknown }).video;
    if (typeof video === 'boolean') out[id] = { video };
  }
  return out;
}

export async function loadDesignPins(q: Q, courseId: number): Promise<DesignPinsMap> {
  const [row] = await q.query(`select metadata -> '${DESIGN_PINS_KEY}' as pins from public.courses where id = $1`, [courseId]);
  const v = row ? (typeof row.pins === 'string' ? JSON.parse(row.pins) : row.pins) : null;
  return parseDesignPins(v);
}

/**
 * Un cambio sobre el valor fijado de UN capítulo: `value` null lo libera. `unlessPractice`: si el capítulo es de práctica
 * (que nunca lleva video) se libera en vez de fijarse.
 */
export interface PinOp { field: 'video'; value: boolean | null; unlessPractice?: boolean }

/**
 * Expresión SQL (jsonb) que aplica `ops` sobre la columna `col` de courses.metadata, con el id del capítulo en el
 * parámetro `chapterParam` (p. ej. '$7'). Permite plegar el cambio en el MISMO UPDATE que sube el contador de la
 * estructura (sin idas y vueltas extra). Los nombres de campo y los booleanos son constantes, nunca datos del cliente.
 */
export function pinsMetadataExpr(col: string, chapterParam: string, ops: PinOp[]): string {
  const ch = `${chapterParam}::text`;
  let e = `coalesce(${col}, '{}'::jsonb)`;
  for (const op of ops) {
    const clear = `(${e} #- array['${DESIGN_PINS_KEY}', ${ch}, '${op.field}'])`;
    if (op.value === null) { e = clear; continue; }
    const set = `jsonb_set(${e}, array['${DESIGN_PINS_KEY}'], coalesce(${e} -> '${DESIGN_PINS_KEY}', '{}'::jsonb) || ` +
      `jsonb_build_object(${ch}, coalesce(${e} -> '${DESIGN_PINS_KEY}' -> ${ch}, '{}'::jsonb) || jsonb_build_object('${op.field}', ${op.value ? 'true' : 'false'})), true)`;
    e = op.unlessPractice
      ? `(case when exists (select 1 from public.course_chapters px where px.id::text = ${ch} and coalesce(to_jsonb(px) ->> 'chapter_kind', 'content') = 'practice') then ${clear} else ${set} end)`
      : set;
  }
  return e;
}

/** Fija (boolean) o libera (null) el video de un capítulo, dentro de la transacción del llamador (una sentencia). */
export async function setVideoPin(q: Q, courseId: number, chapterId: string, video: boolean | null): Promise<void> {
  await q.query(`update public.courses set metadata = ${pinsMetadataExpr('metadata', '$2', [{ field: 'video', value: video }])} where id = $1`, [courseId, chapterId]);
}

/** «Liberar»: todos los valores fijados vuelven a decidirlos Cursia. Devuelve cuántos había. */
export async function clearDesignPins(q: Q, courseId: number): Promise<number> {
  const before = await loadDesignPins(q, courseId);
  await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${DESIGN_PINS_KEY}' where id = $1`, [courseId]);
  return Object.keys(before).length;
}

/**
 * LOOP 8.3 (review L83 I-3) · Horas que PROPUSO Cursia y el docente aceptó con «Usar este diseño»: no son una decisión
 * del docente. courses.metadata.designHours = { proposed: número }. Mientras el perfil tenga ese mismo valor, «Lo que
 * sabemos» las muestra como propuestas y un microcurrículo posterior las reemplaza por las suyas.
 */
export const DESIGN_HOURS_KEY = 'designHours';
export function parseProposedHours(v: unknown): number | null {
  const p = v && typeof v === 'object' && !Array.isArray(v) ? (v as { proposed?: unknown }).proposed : null;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}
export async function loadProposedHours(q: Q, courseId: number): Promise<number | null> {
  const [row] = await q.query(`select metadata -> '${DESIGN_HOURS_KEY}' as h from public.courses where id = $1`, [courseId]);
  return parseProposedHours(row ? (typeof row.h === 'string' ? JSON.parse(row.h) : row.h) : null);
}
export async function setProposedHours(q: Q, courseId: number, proposed: number | null): Promise<void> {
  if (proposed === null) {
    await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${DESIGN_HOURS_KEY}' where id = $1`, [courseId]);
    return;
  }
  await q.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], jsonb_build_object('proposed', $3::numeric), true) where id = $1`, [courseId, [DESIGN_HOURS_KEY], proposed]);
}
