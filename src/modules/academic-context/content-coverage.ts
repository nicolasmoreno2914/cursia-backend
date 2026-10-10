// Fase 3 · Trazabilidad y cobertura de los contenidos del documento.
//
// Cuando la estructura sale del documento (su propia forma o redistribuida en otra: «4 × 5 → 3 × 4»), el curso guarda de
// qué contenidos del documento viene cada capítulo: courses.metadata.contentMap (sin migración) =
//   { version: 1, contextVersion, chapters: { [chapterId]: [contentId, …] }, at }.
// La cobertura se calcula contra la estructura VIVA: un capítulo borrado deja sus contenidos sin cubrir (nunca en
// silencio: Verificación lo marca como crítico y la propuesta no se puede preparar), un contenido en dos capítulos es
// un duplicado, y un mapa armado con OTROS contenidos (el documento cambió sus contenidos) queda «desactualizado». Una
// versión nueva del contexto que no toca los contenidos (p. ej. confirmar los resultados) no lo desactualiza. Mover o
// renombrar un capítulo no cambia nada (el id se conserva). Funciones puras salvo leer y escribir el mapa.

import { createHash } from 'crypto';
import type { AcademicContextV1 } from './academic-context';

export const CONTENT_MAP_KEY = 'contentMap';

export interface ContentMap {
  version: 1;
  /** Versión del contexto académico con la que se armó la estructura. */
  contextVersion: number;
  /** Capítulo → contenidos del documento que trabaja. */
  chapters: Record<string, string[]>;
  /** Huella de los contenidos (id + texto) con los que se armó: los ids son posicionales (U1.1…), el texto distingue. */
  contentsSha?: string;
  at: string;
}

export interface CoverageItem { id: string; text: string; unit: string }

export interface ContentCoverage {
  /** Hay un mapa de trazabilidad (la estructura salió del documento). */
  available: boolean;
  /** El mapa es de otra versión del documento: la estructura se armó con un documento anterior. */
  stale: boolean;
  total: number;
  covered: number;
  omitted: CoverageItem[];
  duplicated: (CoverageItem & { chapters: number })[];
}

export function parseContentMap(v: unknown): ContentMap | null {
  const o = (typeof v === 'string' ? safeJson(v) : v) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.version !== 1 || typeof o.contextVersion !== 'number' || !o.chapters || typeof o.chapters !== 'object' || Array.isArray(o.chapters)) return null;
  const chapters: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(o.chapters as Record<string, unknown>)) {
    if (Array.isArray(ids)) chapters[k] = ids.filter((x): x is string => typeof x === 'string');
  }
  return { version: 1, contextVersion: o.contextVersion, chapters, ...(typeof o.contentsSha === 'string' ? { contentsSha: o.contentsSha } : {}), at: typeof o.at === 'string' ? o.at : '' };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** Contenidos del documento (de las unidades con contenidos), en orden, con su unidad. */
export function documentContents(ctx: AcademicContextV1): CoverageItem[] {
  return ctx.units.filter((u) => u.contents.length > 0).flatMap((u) => u.contents.map((c) => ({ id: c.id, text: c.text, unit: u.title })));
}

/** Huella de los contenidos del documento (id, unidad y texto, en orden). */
export function contentsFingerprint(ctx: AcademicContextV1): string {
  const norm = (s: string) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(JSON.stringify(documentContents(ctx).map((c) => [c.id, norm(c.unit), norm(c.text)]))).digest('hex');
}

/** ¿El mapa se armó con otros contenidos del documento? (mismos ids con otros textos también cuenta). */
export function contentMapIsStale(ctx: AcademicContextV1, map: ContentMap): boolean {
  if (map.contentsSha) return map.contentsSha !== contentsFingerprint(ctx);
  const now = new Set(documentContents(ctx).map((c) => c.id));
  const known = new Set(Object.values(map.chapters).flat());
  if (now.size !== known.size) return true;
  for (const id of now) if (!known.has(id)) return true;
  return false;
}

export function contentCoverage(ctx: AcademicContextV1, contextVersion: number, map: ContentMap | null, liveChapterIds: string[]): ContentCoverage {
  const contents = documentContents(ctx);
  if (!map) return { available: false, stale: false, total: contents.length, covered: 0, omitted: [], duplicated: [] };
  void contextVersion; // la versión queda registrada en el mapa; la vigencia la deciden los contenidos
  const live = new Set(liveChapterIds);
  const count = new Map<string, number>();
  for (const [chapterId, ids] of Object.entries(map.chapters)) {
    if (!live.has(chapterId)) continue; // capítulo borrado: sus contenidos dejan de estar cubiertos
    for (const id of new Set(ids)) count.set(id, (count.get(id) || 0) + 1);
  }
  const omitted = contents.filter((c) => !count.get(c.id));
  const duplicated = contents.filter((c) => (count.get(c.id) || 0) > 1).map((c) => ({ ...c, chapters: count.get(c.id)! }));
  return { available: true, stale: contentMapIsStale(ctx, map), total: contents.length, covered: contents.length - omitted.length, omitted, duplicated };
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

export async function readContentMap(q: Q, courseId: number): Promise<ContentMap | null> {
  const res = await q.query(`select metadata -> '${CONTENT_MAP_KEY}' as m from public.courses where id = $1`, [courseId]);
  const rows: any[] = Array.isArray(res) ? res : (res && res.rows) || [];
  return rows[0] ? parseContentMap(rows[0].m) : null;
}

export async function writeContentMap(q: Q, courseId: number, map: ContentMap | null): Promise<void> {
  if (!map) {
    await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${CONTENT_MAP_KEY}' where id = $1`, [courseId]);
    return;
  }
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
    [courseId, [CONTENT_MAP_KEY], JSON.stringify(map)],
  );
}
