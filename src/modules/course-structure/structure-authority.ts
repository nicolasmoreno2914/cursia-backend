// LOOP 8.0 · Autoridad del microcurrículo sobre la estructura del curso.
//
// Problema (auditoría LOOP 8, hallazgo O1): «Generar estructura» aplicaba la propuesta de la IA antes de que el docente
// subiera el microcurrículo, y la estructura del documento solo se podía usar sobre el esqueleto vacío (1 módulo,
// 1 capítulo). Resultado: el documento nunca definía la estructura.
//
// Regla: cuando hay un contexto académico con unidades, su estructura manda. Puede reemplazar SIN preguntar:
//   - el esqueleto vacío;
//   - una estructura que puso Cursia (propuesta de la IA o una versión anterior del documento) y que nadie tocó desde
//     entonces (el contador de la estructura sigue en el valor con el que Cursia la dejó).
// Pide confirmación explícita (nunca se pisa en silencio) si:
//   - el docente editó la estructura después de que Cursia la armó (o no se sabe quién la armó);
//   - hay una versión confirmada (Blueprint vigente).
//
// El origen vive en courses.metadata.structureOrigin (sin migración): { source, counter, contextVersion, at }. Toda
// mutación de la estructura incrementa el contador, así que «nadie la tocó» = origin.counter === contador actual.
// Funciones puras: las prueba scripts/check-loop8-document-structure-authority.js.

export const STRUCTURE_ORIGIN_KEY = 'structureOrigin';
export const STRUCTURE_ORIGIN_SOURCES = ['ai_proposal', 'academic_context'] as const;
export type StructureOriginSource = (typeof STRUCTURE_ORIGIN_SOURCES)[number];

export interface StructureOrigin {
  source: StructureOriginSource;
  /** structure_version_counter con el que Cursia dejó la estructura. */
  counter: number;
  /** Versión del contexto académico aplicado (solo source = academic_context). */
  contextVersion: number | null;
  at: string;
  /**
   * Review piloto I5: capítulos por módulo (en orden) con los que Cursia dejó la estructura. «El docente cambió la
   * estructura» = cambió esta forma (agregó o quitó módulos o capítulos), no un título o un objetivo. Orígenes anteriores
   * (sin forma) se comparan por el contador, como antes.
   */
  shape?: number[];
}

export type StructureReplaceReason = 'user_edits' | 'confirmed_blueprint';

export interface StructureAuthority {
  /** Quién armó la estructura vigente (null = el docente, el esqueleto o un curso anterior a LOOP 8.0). */
  source: StructureOriginSource | null;
  contextVersion: number | null;
  /** Contador con el que Cursia dejó la estructura (el editor compara con su contador para saber si sigue intacta). */
  originCounter: number | null;
  /** Cursia la armó y nadie la cambió desde entonces. */
  untouched: boolean;
  /** Es el esqueleto vacío (1 módulo y 1 capítulo sin nombre ni contenido). */
  pristine: boolean;
  /** Motivos por los que reemplazarla exige confirmación explícita (vacío = se puede reemplazar sin preguntar). */
  replaceReasons: StructureReplaceReason[];
}

/** Títulos del esqueleto: mismos que el editor (48-dynamic-structure-proposal.js, DYN_AI_SKELETON_*). */
export const SKELETON_MODULE_TITLES: readonly string[] = Object.freeze(['Módulo 1', 'Nuevo módulo']);
export const SKELETON_CHAPTER_TITLES: readonly string[] = Object.freeze(['Nuevo capítulo']);

export function parseStructureOrigin(v: unknown): StructureOrigin | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!(STRUCTURE_ORIGIN_SOURCES as readonly string[]).includes(o.source as string)) return null;
  if (typeof o.counter !== 'number' || !Number.isInteger(o.counter) || o.counter < 0) return null;
  const cv = o.contextVersion;
  const contextVersion = typeof cv === 'number' && Number.isInteger(cv) && cv >= 1 ? cv : null;
  const shape = Array.isArray(o.shape) && o.shape.length > 0 && o.shape.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) ? (o.shape as number[]) : null;
  return { source: o.source as StructureOriginSource, counter: o.counter, contextVersion, at: typeof o.at === 'string' ? o.at : '', ...(shape ? { shape } : {}) };
}

const blank = (v: unknown) => v === null || v === undefined || !String(v).trim();

export interface SkeletonModuleInput {
  title: string | null;
  objective?: string | null;
  description?: string | null;
  chapters: { title: string | null; objective?: string | null; description?: string | null }[];
}

export function isPristineSkeleton(modules: SkeletonModuleInput[]): boolean {
  if (modules.length !== 1) return false;
  const m = modules[0];
  if (m.chapters.length !== 1) return false;
  const c = m.chapters[0];
  return (
    SKELETON_MODULE_TITLES.includes(String(m.title ?? '').trim()) &&
    SKELETON_CHAPTER_TITLES.includes(String(c.title ?? '').trim()) &&
    blank(m.objective) && blank(m.description) && blank(c.objective) && blank(c.description)
  );
}

export function structureAuthority(
  origin: StructureOrigin | null,
  counter: number,
  pristine: boolean,
  hasBlueprint: boolean,
): StructureAuthority {
  const untouched = !!origin && origin.counter === counter;
  const replaceReasons: StructureReplaceReason[] = [];
  if (!pristine && !untouched) replaceReasons.push('user_edits');
  if (hasBlueprint) replaceReasons.push('confirmed_blueprint');
  return {
    source: origin ? origin.source : null,
    contextVersion: origin ? origin.contextVersion : null,
    originCounter: origin ? origin.counter : null,
    untouched,
    pristine,
    replaceReasons,
  };
}

/**
 * Tras «Aplicar diseño» (el distribuidor de Cursia agrega capítulos y Actividades de Aplicación): si la estructura
 * seguía como la dejó Cursia, el diseño también es de Cursia y el origen avanza al nuevo contador. Si el docente ya la
 * había editado, el origen queda como estaba (sigue contando como editada).
 */
export function originAfterCursiaDesign(origin: StructureOrigin | null, counterBefore: number, counterAfter: number): StructureOrigin | null {
  if (!origin || origin.counter !== counterBefore) return null;
  return { ...origin, counter: counterAfter };
}

// ── Lectura / escritura del origen dentro de una transacción (structure, profiles) ──
type Q = { query(sql: string, params?: any[]): Promise<any> };

export async function readStructureOrigin(q: Q, courseId: number): Promise<StructureOrigin | null> {
  const res = await q.query(`select metadata -> 'structureOrigin' as o from public.courses where id = $1`, [courseId]);
  const rows: any[] = Array.isArray(res) ? res : res.rows;
  const raw = rows[0] ? rows[0].o : null;
  return parseStructureOrigin(typeof raw === 'string' ? JSON.parse(raw) : raw);
}

/** Capítulos por módulo de la estructura viva, en orden. */
export async function liveStructureShape(q: Q, courseId: number): Promise<number[]> {
  const res = await q.query(
    `select m.id, count(c.id)::int as n from public.course_modules m left join public.course_chapters c on c.module_id = m.id
      where m.course_id = $1 group by m.id, m.position order by m.position`,
    [courseId],
  );
  const rows: any[] = Array.isArray(res) ? res : res.rows;
  return rows.map((r) => Number(r.n));
}

export async function writeStructureOrigin(q: Q, courseId: number, origin: StructureOrigin): Promise<void> {
  // Review piloto I5: el origen guarda la forma con la que Cursia deja la estructura (dentro de la misma transacción).
  if (!origin.shape) origin = { ...origin, shape: await liveStructureShape(q, courseId) };
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
    [courseId, [STRUCTURE_ORIGIN_KEY], JSON.stringify(origin)],
  );
}

/** Un cambio que hace Cursia (diseño de horas, poda de vínculos de un contexto nuevo) no convierte la estructura en «editada». */
export async function advanceStructureOriginIfUntouched(q: Q, courseId: number, counterBefore: number, counterAfter: number): Promise<void> {
  const next = originAfterCursiaDesign(await readStructureOrigin(q, courseId), counterBefore, counterAfter);
  if (next) await writeStructureOrigin(q, courseId, { ...next, shape: undefined });
}
