/**
 * LOOP 8.3 · Valores del diseño FIJADOS por el docente (hoy: el video de un capítulo, cambiado a mano en el editor).
 * Viven en courses.metadata.designPins = { [chapterId]: { video: boolean } } (sin migración, como structureOrigin). El
 * distribuidor los respeta siempre (la prioridad audiovisual no los cambia) y «Liberar» los devuelve a Cursia.
 * Un id que ya no existe (capítulo borrado) simplemente se ignora.
 */
type Q = { query(sql: string, params?: any[]): Promise<any> };

export const DESIGN_PINS_KEY = 'designPins';
/**
 * LOOP 9.2 (review C1/I1/I2): `activity` = la actividad interactiva de un capítulo, cambiada a mano por el docente;
 * `noPractice` (clave = id del MÓDULO) = el docente quitó la práctica de ese módulo: Cursia no la vuelve a proponer allí
 * y la diferencia con el documento queda como su excepción. «Liberar» devuelve las dos a Cursia.
 */
export type DesignPinsMap = Record<string, { video?: boolean; application?: number; noLinks?: boolean; activity?: boolean; noPractice?: boolean }>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDesignPins(v: unknown): DesignPinsMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: DesignPinsMap = {};
  for (const [id, pin] of Object.entries(v as Record<string, unknown>)) {
    if (!UUID_RE.test(id) || !pin || typeof pin !== 'object') continue;
    const video = (pin as { video?: unknown }).video;
    const noLinks = (pin as { noLinks?: unknown }).noLinks === true;
    const app = (pin as { application?: unknown }).application;
    const application = typeof app === 'number' && Number.isInteger(app) && app >= 0 && app <= 240 ? app : undefined;
    const activity = (pin as { activity?: unknown }).activity;
    const noPractice = (pin as { noPractice?: unknown }).noPractice === true;
    if (typeof video === 'boolean' || noLinks || application !== undefined || typeof activity === 'boolean' || noPractice) {
      out[id] = { ...(typeof video === 'boolean' ? { video } : {}), ...(application !== undefined ? { application } : {}), ...(noLinks ? { noLinks: true } : {}),
        ...(typeof activity === 'boolean' ? { activity } : {}), ...(noPractice ? { noPractice: true } : {}) };
    }
  }
  return out;
}

export async function loadDesignPins(q: Q, courseId: number): Promise<DesignPinsMap> {
  const [row] = await q.query(`select metadata -> '${DESIGN_PINS_KEY}' as pins from public.courses where id = $1`, [courseId]);
  const v = row ? (typeof row.pins === 'string' ? JSON.parse(row.pins) : row.pins) : null;
  return parseDesignPins(v);
}

/**
 * Un cambio sobre lo fijado de UN capítulo: `value` null lo libera.
 *  - `unlessPractice`: si el capítulo es de práctica (que nunca lleva video) se libera en vez de fijarse.
 *  - `onlyIfLinked`: solo si el capítulo TENÍA vínculos antes de este cambio (review L84-2 N5: «sin vínculos» es una
 *    decisión del docente solo cuando los quita; mandar null a un capítulo que ya no tenía no decide nada).
 * Las condiciones leen la fila tal como estaba ANTES de la sentencia (las CTE de Postgres ven la misma instantánea).
 */
export interface PinOp { field: 'video' | 'noLinks' | 'application' | 'activity' | 'noPractice'; value: boolean | number | null; unlessPractice?: boolean; onlyIfLinked?: boolean }

/**
 * Expresión SQL (jsonb) que aplica `ops` sobre la columna `col` de courses.metadata, con el id del capítulo en el
 * parámetro `chapterParam` (p. ej. '$7'). Permite plegar el cambio en el MISMO UPDATE que sube el contador de la
 * estructura (sin idas y vueltas extra). Los nombres de campo y los booleanos son constantes, nunca datos del cliente.
 */
/** Literal SQL de un valor fijado: booleano o minutos enteros (validados antes; nunca texto del cliente). */
function pinLiteral(v: boolean | number): string {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 240) throw new Error(`valor fijado inválido: ${v}`);
    return `${v}`;
  }
  return v ? 'true' : 'false';
}

export function pinsMetadataExpr(col: string, chapterParam: string, ops: PinOp[], cond?: { isPractice: string; wasLinked: string }): string {
  const ch = `${chapterParam}::text`;
  // Review L84-3 Mn3: por la clave primaria (uuid), y una sola vez si el llamador ya calculó las condiciones (CTE).
  const isPractice = cond ? cond.isPractice : `exists (select 1 from public.course_chapters px where px.id = ${chapterParam}::uuid and coalesce(to_jsonb(px) ->> 'chapter_kind', 'content') = 'practice')`;
  const wasLinked = cond ? cond.wasLinked : `exists (select 1 from public.course_chapters px where px.id = ${chapterParam}::uuid and (case when jsonb_typeof(to_jsonb(px) -> 'outcome_ids') = 'array' then jsonb_array_length(to_jsonb(px) -> 'outcome_ids') else 0 end) > 0)`;
  let e = `coalesce(${col}, '{}'::jsonb)`;
  for (const op of ops) {
    const clear = `(${e} #- array['${DESIGN_PINS_KEY}', ${ch}, '${op.field}'])`;
    if (op.value === null) { e = clear; continue; }
    const set = `jsonb_set(${e}, array['${DESIGN_PINS_KEY}'], coalesce(${e} -> '${DESIGN_PINS_KEY}', '{}'::jsonb) || ` +
      `jsonb_build_object(${ch}, coalesce(${e} -> '${DESIGN_PINS_KEY}' -> ${ch}, '{}'::jsonb) || jsonb_build_object('${op.field}', ${pinLiteral(op.value)})), true)`;
    if (op.unlessPractice) {
      e = `(case when ${isPractice} then ${clear} else ${set} end)`;
    } else if (op.onlyIfLinked) {
      e = `(case when ${wasLinked} then ${set} else ${e} end)`;
    } else e = set;
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
  const videoIds = Object.keys(before).filter((id) => typeof before[id].video === 'boolean');
  const appIds = Object.keys(before).filter((id) => typeof before[id].application === 'number');
  // Review L83-2 m5: se informan solo los que el diseño usaba (capítulos de contenido que existen); los huérfanos se
  // limpian igual.
  // Capítulos que existen con algo fijado que el diseño usa (video en contenido; Actividad de Aplicación en cualquiera).
  const live: { n: number }[] = videoIds.length || appIds.length
    ? await q.query(`select count(*)::int n from public.course_chapters ch where course_id = $1 and ((id = any($2::uuid[]) and coalesce(to_jsonb(ch) ->> 'chapter_kind', 'content') <> 'practice') or id = any($3::uuid[]))`, [courseId, videoIds, appIds])
    : [{ n: 0 }];
  // «Liberar» devuelve el VIDEO a Cursia; las decisiones de vínculos del docente se conservan (solo de capítulos que
  // existen: review L84-2 N5).
  const noLinkIds = Object.keys(before).filter((id) => before[id].noLinks);
  const alive: { id: string }[] = noLinkIds.length ? await q.query(`select id::text id from public.course_chapters where course_id = $1 and id = any($2::uuid[])`, [courseId, noLinkIds]) : [];
  const keep: DesignPinsMap = {};
  for (const r of alive) keep[r.id] = { noLinks: true };
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
