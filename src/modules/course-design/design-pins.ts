/**
 * LOOP 8.3 · Valores del diseño FIJADOS por el docente (hoy: el video de un capítulo, cambiado a mano en el editor).
 * Viven en courses.metadata.designPins = { [chapterId]: { video: boolean } } (sin migración, como structureOrigin). El
 * distribuidor los respeta siempre (la prioridad audiovisual no los cambia) y «Liberar» los devuelve a Cursia.
 * Un id que ya no existe (capítulo borrado) simplemente se ignora.
 */
type Q = { query(sql: string, params?: any[]): Promise<any> };

export const DESIGN_PINS_KEY = 'designPins';
export type DesignPinsMap = Record<string, { video?: boolean; noLinks?: boolean }>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDesignPins(v: unknown): DesignPinsMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: DesignPinsMap = {};
  for (const [id, pin] of Object.entries(v as Record<string, unknown>)) {
    if (!UUID_RE.test(id) || !pin || typeof pin !== 'object') continue;
    const video = (pin as { video?: unknown }).video;
    const noLinks = (pin as { noLinks?: unknown }).noLinks === true;
    if (typeof video === 'boolean' || noLinks) out[id] = { ...(typeof video === 'boolean' ? { video } : {}), ...(noLinks ? { noLinks: true } : {}) };
  }
  return out;
}

export async function loadDesignPins(q: Q, courseId: number): Promise<DesignPinsMap> {
  const [row] = await q.query(`select metadata -> '${DESIGN_PINS_KEY}' as pins from public.courses where id = $1`, [courseId]);
  const v = row ? (typeof row.pins === 'string' ? JSON.parse(row.pins) : row.pins) : null;
  return parseDesignPins(v);
}

async function writePin(q: Q, courseId: number, chapterId: string, mutate: (pin: { video?: boolean; noLinks?: boolean }) => void): Promise<void> {
  const pins = await loadDesignPins(q, courseId);
  const pin = { ...(pins[chapterId] || {}) };
  mutate(pin);
  if (pin.video === undefined) delete pin.video;
  if (!pin.noLinks) delete pin.noLinks;
  if (Object.keys(pin).length) {
    await q.query(
      `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[],
              coalesce(metadata -> '${DESIGN_PINS_KEY}', '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), true)
        where id = $1`,
      [courseId, [DESIGN_PINS_KEY], chapterId, JSON.stringify(pin)],
    );
  } else {
    await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) #- $2::text[] where id = $1`, [courseId, [DESIGN_PINS_KEY, chapterId]]);
  }
}

/** Fija (boolean) o libera (null) el video de un capítulo, dentro de la transacción del llamador. */
export async function setVideoPin(q: Q, courseId: number, chapterId: string, video: boolean | null): Promise<void> {
  await writePin(q, courseId, chapterId, (p) => { if (video === null) delete p.video; else p.video = video; });
}

/**
 * LOOP 8.4 (review L84 I2) · El docente quitó A PROPÓSITO todos los vínculos de un capítulo: queda registrado y la
 * vinculación automática de Cursia no lo vuelve a vincular. Vincular algo después borra la marca.
 */
export async function setNoLinksDecision(q: Q, courseId: number, chapterId: string, cleared: boolean): Promise<void> {
  await writePin(q, courseId, chapterId, (p) => { if (cleared) p.noLinks = true; else delete p.noLinks; });
}

/** «Liberar»: todos los valores fijados vuelven a decidirlos Cursia. Devuelve cuántos había. */
export async function clearDesignPins(q: Q, courseId: number): Promise<number> {
  const before = await loadDesignPins(q, courseId);
  const ids = Object.keys(before).filter((id) => typeof before[id].video === 'boolean');
  // Review L83-2 m5: se informan solo los que el diseño usaba (capítulos de contenido que existen); los huérfanos se
  // limpian igual.
  const live: { n: number }[] = ids.length
    ? await q.query(`select count(*)::int n from public.course_chapters ch where course_id = $1 and id = any($2::uuid[]) and coalesce(to_jsonb(ch) ->> 'chapter_kind', 'content') <> 'practice'`, [courseId, ids])
    : [{ n: 0 }];
  // «Liberar» devuelve el VIDEO a Cursia; las decisiones de vínculos del docente se conservan.
  const keep: DesignPinsMap = {};
  for (const [id, p] of Object.entries(before)) if (p.noLinks) keep[id] = { noLinks: true };
  await q.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`, [courseId, [DESIGN_PINS_KEY], JSON.stringify(keep)]);
  return live[0] ? Number(live[0].n) : 0;
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
