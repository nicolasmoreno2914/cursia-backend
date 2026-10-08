/**
 * Prebrief pedagógico · Formatos comerciales S/M/L (catálogo de Cursia para propuestas B2B).
 *
 * Son ALTERNATIVAS: el curso tiene como mucho UN formato seleccionado (courses.metadata.courseFormat). Elegir M deja
 * S y L sin efecto; nunca se suman ni se crean tres variantes. El formato es una decisión de la institución (nivel 2 de
 * la jerarquía de 8.6C): fija la forma de contenidos (módulos × capítulos de contenido; las prácticas y las Actividades
 * de Aplicación NO cuentan) y el rango de horas, con el punto medio como meta (salvo horas elegidas explícitamente).
 * Si contradice un requisito obligatorio del documento, queda como «Excepción al requisito del documento» (con motivo).
 *
 * Puro (sin DB) salvo las dos funciones de lectura/escritura del final.
 */
export const COURSE_FORMAT_KEY = 'courseFormat';
export const COURSE_FORMAT_CATALOG_VERSION = 1;

export type CourseFormatCode = 'S' | 'M' | 'L';
export const COURSE_FORMAT_CODES: readonly CourseFormatCode[] = ['S', 'M', 'L'];

export interface CourseFormatDef {
  code: CourseFormatCode;
  label: string;
  modules: number;
  /** Capítulos de CONTENIDO por módulo (las prácticas no cuentan). */
  chaptersPerModule: number;
  hoursMin: number;
  hoursMax: number;
  /** Meta de diseño: el punto medio del rango (media hora más cercana). */
  targetHours: number;
}

const def = (code: CourseFormatCode, modules: number, chaptersPerModule: number, hoursMin: number, hoursMax: number): CourseFormatDef => ({
  code, label: `Formato ${code}`, modules, chaptersPerModule, hoursMin, hoursMax, targetHours: Math.round(((hoursMin + hoursMax) / 2) * 2) / 2,
});

/** Catálogo v1 (propuesta comercial vigente). Cambiarlo exige subir COURSE_FORMAT_CATALOG_VERSION. */
export const COURSE_FORMATS: Readonly<Record<CourseFormatCode, CourseFormatDef>> = Object.freeze({
  S: def('S', 3, 3, 20, 22),
  M: def('M', 3, 4, 40, 44),
  L: def('L', 4, 5, 60, 66),
});

export interface StoredCourseFormat {
  code: CourseFormatCode;
  catalogVersion: number;
  at: string;
  by: string | null;
}

export function isCourseFormatCode(v: unknown): v is CourseFormatCode {
  return typeof v === 'string' && (COURSE_FORMAT_CODES as readonly string[]).includes(v);
}

export function parseCourseFormat(v: unknown): StoredCourseFormat | null {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isCourseFormatCode(o.code)) return null;
  return {
    code: o.code,
    catalogVersion: typeof o.catalogVersion === 'number' ? o.catalogVersion : COURSE_FORMAT_CATALOG_VERSION,
    at: typeof o.at === 'string' ? o.at : '',
    by: typeof o.by === 'string' ? o.by : null,
  };
}

export function formatDef(code: CourseFormatCode | null | undefined): CourseFormatDef | null {
  return code && isCourseFormatCode(code) ? COURSE_FORMATS[code] : null;
}

/** «3 módulos · 12 capítulos · 40–44 horas». */
export function formatSummary(d: CourseFormatDef): string {
  return `${d.modules} módulos · ${d.modules * d.chaptersPerModule} capítulos · ${d.hoursMin}–${d.hoursMax} horas`;
}

export interface FormatFit {
  structureOk: boolean;
  hoursOk: boolean;
  /** Capítulos de contenido por módulo del diseño (sin prácticas). */
  contentShape: number[];
}

/** ¿El diseño respeta el formato? La forma se mide en capítulos de contenido; las horas, contra el rango. */
export function formatFit(d: CourseFormatDef, modules: { chapters: { kind?: string }[] }[], targetHours: number | null): FormatFit {
  const contentShape = modules.map((m) => m.chapters.filter((c) => (c.kind || 'content') !== 'practice').length);
  const structureOk = contentShape.length === d.modules && contentShape.every((n) => n === d.chaptersPerModule);
  const hoursOk = typeof targetHours === 'number' && targetHours >= d.hoursMin - 1e-9 && targetHours <= d.hoursMax + 1e-9;
  return { structureOk, hoursOk, contentShape };
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };
const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : (res && res.rows) || []);

export async function readCourseFormat(q: Q, courseId: number): Promise<StoredCourseFormat | null> {
  const rows = rowsOf(await q.query(`select metadata -> '${COURSE_FORMAT_KEY}' as f from public.courses where id = $1`, [courseId]));
  return rows.length ? parseCourseFormat(rows[0].f) : null;
}

/** null quita el formato (vuelve a mandar el documento / Cursia). */
export async function writeCourseFormat(q: Q, courseId: number, f: StoredCourseFormat | null): Promise<void> {
  if (!f) {
    await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${COURSE_FORMAT_KEY}' where id = $1`, [courseId]);
    return;
  }
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${COURSE_FORMAT_KEY}}', $2::jsonb, true) where id = $1`,
    [courseId, JSON.stringify(f)],
  );
}
