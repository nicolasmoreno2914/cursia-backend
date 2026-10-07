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

/** Fija (boolean) o libera (null) el video de un capítulo, dentro de la transacción del llamador. */
export async function setVideoPin(q: Q, courseId: number, chapterId: string, video: boolean | null): Promise<void> {
  if (video === null) {
    await q.query(
      `update public.courses set metadata = coalesce(metadata, '{}'::jsonb) #- $2::text[] where id = $1`,
      [courseId, [DESIGN_PINS_KEY, chapterId]],
    );
    return;
  }
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[],
            coalesce(metadata -> '${DESIGN_PINS_KEY}', '{}'::jsonb) || jsonb_build_object($3::text, jsonb_build_object('video', $4::boolean)), true)
      where id = $1`,
    [courseId, [DESIGN_PINS_KEY], chapterId, video],
  );
}

/** «Liberar»: todos los valores fijados vuelven a decidirlos Cursia. Devuelve cuántos había. */
export async function clearDesignPins(q: Q, courseId: number): Promise<number> {
  const before = await loadDesignPins(q, courseId);
  await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${DESIGN_PINS_KEY}' where id = $1`, [courseId]);
  return Object.keys(before).length;
}
