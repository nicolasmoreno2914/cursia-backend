// T4/T5 (r57) — Entrega de las Actividades de Aplicación y archivos de trabajo (recursos de práctica).
//
// Dos claves OPCIONALES del perfil de evaluación (course_profiles kind 'assessment'). Ausentes → el perfil, su sha, la
// evaluación resuelta y el .mbz son byte a byte los de siempre (la AA es una página + solucionario oculto + PDF).
//
//   applicationDelivery   cómo se entrega la AA: `page` (hoy) o `assign` (Tarea de Moodle) para todo el curso, con
//                         excepción por capítulo (`chapterModes`); tipos de entrega, límite de archivos/tamaño, fecha
//                         límite relativa (días desde el inicio del curso) y calificación: formativa (sin ítem de nota)
//                         o calificada (nota máxima, nota de referencia, categoría del libro de calificaciones y rúbrica).
//   practiceResources     archivos de trabajo por capítulo: subidos por el usuario (artifact `practice_file`, con su
//                         sha256 y tamaño congelados en el perfil) o generados de forma determinística desde una tabla
//                         (CSV/XLSX, sin dependencias nuevas). Se empaquetan como mod_resource del capítulo y la AA
//                         los enlaza («archivo de trabajo de la Actividad de Aplicación»).
//
// Son insumos del EMPAQUE (como el resto del perfil de evaluación): cambiarlos re-empaqueta (el sha del perfil entra en
// la clave de reuse) y NUNCA invalida contenido generado ni llama a un proveedor (USD 0). Puro: sin DB ni reloj.

export interface DeliveryValidationError {
  path: string;
  code: string;
  message: string;
}

export const APPLICATION_DELIVERY_MODES = ['page', 'assign'] as const;
export type ApplicationDeliveryMode = (typeof APPLICATION_DELIVERY_MODES)[number];
export const APPLICATION_GRADE_CATEGORIES = ['applications', 'practice'] as const;
export type ApplicationGradeCategory = (typeof APPLICATION_GRADE_CATEGORIES)[number];

/** Límites de la entrega (Moodle: assignsubmission_file maxfilesubmissions / maxsubmissionsizebytes). */
export const DELIVERY_LIMITS = Object.freeze({
  maxFilesMin: 1,
  maxFilesMax: 20,
  maxBytesMin: 1024,
  maxBytesMax: 100 * 1024 * 1024,
  dueOffsetDaysMin: 1,
  dueOffsetDaysMax: 365,
  maxGradeMin: 1,
  maxGradeMax: 100,
});

export interface ApplicationSubmissionSettings {
  /** Texto en línea (assignsubmission_onlinetext). */
  onlineText: boolean;
  /** Archivos (assignsubmission_file). */
  file: boolean;
  /** Archivos por entrega (1–20). */
  maxFiles: number;
  /** Tamaño máximo POR ARCHIVO en bytes (1 KB – 100 MB; Moodle: assignsubmission_file maxsubmissionsizebytes). */
  maxBytes: number;
  /** Extensiones aceptadas (p. ej. [".pdf", ".docx"]); vacío = cualquiera de la lista permitida del sitio. */
  fileTypes: string[];
}

export type ApplicationGrading =
  | { graded: false }
  | {
      graded: true;
      /** Nota máxima de la tarea (1–100). */
      maxGrade: number;
      /** Nota de referencia de la tarea (0–maxGrade): informativa, el curso se aprueba por la nota final (r55). */
      gradepass: number;
      /** Categoría del libro de calificaciones: una propia («Actividades de Aplicación», con su peso) o la de práctica. */
      category: ApplicationGradeCategory;
      /** Rúbrica nativa de Moodle desde los criterios de la AA (gradingform_rubric). */
      rubric: boolean;
    };

export interface ApplicationDeliveryProfile {
  mode: ApplicationDeliveryMode;
  /** Excepciones por capítulo (chapterId → modo). Ausente = todos con `mode`. */
  chapterModes?: Record<string, ApplicationDeliveryMode>;
  submission: ApplicationSubmissionSettings;
  /**
   * Fecha límite = fecha de inicio del curso DEL BACKUP + N días; null o ausente = sin fecha (default). Moodle corre
   * todas las fechas al restaurar con otra fecha de inicio (la relación se conserva); restaurado conservando la fecha
   * original del backup (p. ej. CLI), la fecha límite queda N días después del momento del empaque.
   */
  dueOffsetDays?: number | null;
  grading: ApplicationGrading;
}

/** Extensiones permitidas (archivo de trabajo y tipos de entrega) → mimetype de Moodle. */
export const PRACTICE_FILE_MIMETYPES: Readonly<Record<string, string>> = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
});

export const PRACTICE_RESOURCE_LIMITS = Object.freeze({
  perChapter: 10,
  perCourse: 40,
  fileBytesMax: 20 * 1024 * 1024,
  courseBytesMax: 60 * 1024 * 1024,
  tableColumnsMax: 30,
  tableRowsMax: 2000,
  tableCellMax: 500,
});

export const PRACTICE_RESOURCE_RELATIONS = ['application', 'chapter'] as const;
export type PracticeResourceRelation = (typeof PRACTICE_RESOURCE_RELATIONS)[number];

export type PracticeTableCell = string | number | null;

export type PracticeResourceSource =
  | { kind: 'artifact'; artifactId: string; filename: string; mimetype: string; bytes: number; sha256: string }
  | { kind: 'table'; format: 'csv' | 'xlsx'; filename: string; columns: string[]; rows: PracticeTableCell[][] };

export interface PracticeResourceSpec {
  /** Identificador estable dentro del curso (idnumber `cv3:ch:<capítulo>:resource:<id>`). */
  id: string;
  chapterId: string;
  title: string;
  /** Instrucciones para el estudiante (puede ser vacío). */
  instructions: string;
  /** `application`: archivo de trabajo de la AA del capítulo (la AA lo enlaza); `chapter`: material del capítulo. */
  relation: PracticeResourceRelation;
  source: PracticeResourceSource;
}

const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CHAPTER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Nombre de archivo seguro (sin rutas): letras, números, espacio, punto, guion y guion bajo; extensión permitida.
const FILENAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,118}\.[a-z0-9]{2,5}$/u;

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function keys(obj: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string, errors: DeliveryValidationError[]): void {
  for (const k of required) if (!(k in obj)) errors.push({ path: `${path}.${k}`, code: 'MISSING_FIELD', message: `Falta el campo "${path}.${k}"` });
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) errors.push({ path: `${path}.${k}`, code: 'UNKNOWN_FIELD', message: `Campo desconocido "${path}.${k}"` });
  }
}

export function extensionOf(filename: string): string {
  const m = /(\.[A-Za-z0-9]{2,5})$/.exec(filename);
  return m ? m[1].toLowerCase() : '';
}

/** Valida `applicationDelivery`. Errores con códigos estables (el panel los traduce). */
export function validateApplicationDelivery(d: unknown, path = 'applicationDelivery'): DeliveryValidationError[] {
  const errors: DeliveryValidationError[] = [];
  const err = (p: string, code: string, message: string) => errors.push({ path: p, code, message });
  if (!isObj(d)) return [{ path, code: 'INVALID_TYPE', message: `${path} debe ser un objeto` }];
  // Review r1 (M): `dueOffsetDays` es opcional — ausente ≡ null (sin fecha límite, el default).
  keys(d, ['mode', 'submission', 'grading'], ['chapterModes', 'dueOffsetDays'], path, errors);
  if ('mode' in d && !(APPLICATION_DELIVERY_MODES as readonly unknown[]).includes(d.mode)) err(`${path}.mode`, 'INVALID_DELIVERY_MODE', `${path}.mode debe ser page o assign`);
  if ('chapterModes' in d) {
    const cm = d.chapterModes;
    if (!isObj(cm)) err(`${path}.chapterModes`, 'INVALID_TYPE', `${path}.chapterModes debe ser un objeto`);
    else {
      for (const [k, v] of Object.entries(cm)) {
        if (!CHAPTER_ID_RE.test(k)) err(`${path}.chapterModes`, 'INVALID_CHAPTER_ID', `capítulo inválido en chapterModes: ${JSON.stringify(k)}`);
        if (!(APPLICATION_DELIVERY_MODES as readonly unknown[]).includes(v)) err(`${path}.chapterModes.${k}`, 'INVALID_DELIVERY_MODE', `chapterModes.${k} debe ser page o assign`);
      }
    }
  }
  const L = DELIVERY_LIMITS;
  if ('submission' in d) {
    const s = d.submission;
    const sp = `${path}.submission`;
    if (!isObj(s)) err(sp, 'INVALID_TYPE', `${sp} debe ser un objeto`);
    else {
      keys(s, ['onlineText', 'file', 'maxFiles', 'maxBytes', 'fileTypes'], [], sp, errors);
      if (typeof s.onlineText !== 'boolean') err(`${sp}.onlineText`, 'INVALID_SUBMISSION', 'onlineText debe ser boolean');
      if (typeof s.file !== 'boolean') err(`${sp}.file`, 'INVALID_SUBMISSION', 'file debe ser boolean');
      if (s.onlineText === false && s.file === false) err(sp, 'SUBMISSION_TYPE_REQUIRED', 'la entrega necesita al menos un tipo (texto en línea o archivo)');
      if (!(isInt(s.maxFiles) && s.maxFiles >= L.maxFilesMin && s.maxFiles <= L.maxFilesMax)) err(`${sp}.maxFiles`, 'INVALID_MAX_FILES', `maxFiles debe ser un entero de ${L.maxFilesMin} a ${L.maxFilesMax}`);
      if (!(isInt(s.maxBytes) && s.maxBytes >= L.maxBytesMin && s.maxBytes <= L.maxBytesMax)) err(`${sp}.maxBytes`, 'INVALID_MAX_BYTES', `maxBytes debe ser un entero de ${L.maxBytesMin} a ${L.maxBytesMax}`);
      if (!Array.isArray(s.fileTypes)) err(`${sp}.fileTypes`, 'INVALID_FILE_TYPES', 'fileTypes debe ser una lista de extensiones');
      else {
        const seen = new Set<string>();
        for (const t of s.fileTypes) {
          if (typeof t !== 'string' || !(t in PRACTICE_FILE_MIMETYPES)) err(`${sp}.fileTypes`, 'INVALID_FILE_TYPES', `extensión no permitida: ${JSON.stringify(t)} (permitidas: ${Object.keys(PRACTICE_FILE_MIMETYPES).join(' ')})`);
          else if (seen.has(t)) err(`${sp}.fileTypes`, 'INVALID_FILE_TYPES', `extensión repetida: ${t}`);
          else seen.add(t);
        }
      }
    }
  }
  if ('dueOffsetDays' in d && d.dueOffsetDays !== null && !(isInt(d.dueOffsetDays) && d.dueOffsetDays >= L.dueOffsetDaysMin && d.dueOffsetDays <= L.dueOffsetDaysMax)) {
    err(`${path}.dueOffsetDays`, 'INVALID_DUE_OFFSET', `dueOffsetDays debe ser null o un entero de ${L.dueOffsetDaysMin} a ${L.dueOffsetDaysMax}`);
  }
  if ('grading' in d) {
    const g = d.grading;
    const gp = `${path}.grading`;
    if (!isObj(g) || typeof g.graded !== 'boolean') err(gp, 'INVALID_GRADING', `${gp} debe ser un objeto con graded boolean`);
    else if (g.graded === false) keys(g, ['graded'], [], gp, errors);
    else {
      keys(g, ['graded', 'maxGrade', 'gradepass', 'category', 'rubric'], [], gp, errors);
      if (!(isInt(g.maxGrade) && g.maxGrade >= L.maxGradeMin && g.maxGrade <= L.maxGradeMax)) err(`${gp}.maxGrade`, 'INVALID_MAX_GRADE', `maxGrade debe ser un entero de ${L.maxGradeMin} a ${L.maxGradeMax}`);
      else if (!(isInt(g.gradepass) && g.gradepass >= 0 && g.gradepass <= g.maxGrade)) err(`${gp}.gradepass`, 'INVALID_GRADEPASS', `gradepass debe ser un entero de 0 a ${g.maxGrade}`);
      if (!(APPLICATION_GRADE_CATEGORIES as readonly unknown[]).includes(g.category)) err(`${gp}.category`, 'INVALID_GRADE_CATEGORY', 'category debe ser applications o practice');
      if (typeof g.rubric !== 'boolean') err(`${gp}.rubric`, 'INVALID_RUBRIC', 'rubric debe ser boolean');
    }
  }
  return errors;
}

/** true si la entrega califica en una categoría PROPIA (los pesos del perfil deben traer `applications`). */
export function deliveryNeedsOwnCategory(d: ApplicationDeliveryProfile | undefined | null): boolean {
  return !!d && d.grading.graded === true && d.grading.category === 'applications';
}

function validateTable(src: Record<string, any>, sp: string, err: (p: string, c: string, m: string) => void): void {
  const L = PRACTICE_RESOURCE_LIMITS;
  if (src.format !== 'csv' && src.format !== 'xlsx') err(`${sp}.format`, 'INVALID_TABLE', 'format debe ser csv o xlsx');
  if (!Array.isArray(src.columns) || src.columns.length < 1 || src.columns.length > L.tableColumnsMax) err(`${sp}.columns`, 'INVALID_TABLE', `columns debe tener de 1 a ${L.tableColumnsMax} columnas`);
  else src.columns.forEach((c: unknown, i: number) => { if (typeof c !== 'string' || !c.trim() || c.length > 80) err(`${sp}.columns[${i}]`, 'INVALID_TABLE', 'cada columna es un texto de 1 a 80 caracteres'); });
  if (!Array.isArray(src.rows) || src.rows.length < 1 || src.rows.length > L.tableRowsMax) err(`${sp}.rows`, 'INVALID_TABLE', `rows debe tener de 1 a ${L.tableRowsMax} filas`);
  else {
    const n = Array.isArray(src.columns) ? src.columns.length : 0;
    src.rows.forEach((r: unknown, i: number) => {
      if (!Array.isArray(r) || r.length !== n) return err(`${sp}.rows[${i}]`, 'INVALID_TABLE', `la fila ${i + 1} debe tener ${n} celdas`);
      r.forEach((c: unknown, j: number) => {
        const ok = c === null || (typeof c === 'number' && Number.isFinite(c)) || (typeof c === 'string' && c.length <= L.tableCellMax);
        if (!ok) err(`${sp}.rows[${i}][${j}]`, 'INVALID_TABLE', `celda inválida (texto ≤ ${L.tableCellMax}, número finito o null)`);
      });
    });
  }
  const ext = typeof src.filename === 'string' ? extensionOf(src.filename) : '';
  if (ext && ext !== `.${src.format}`) err(`${sp}.filename`, 'FILE_EXTENSION_MISMATCH', `el archivo generado ${src.format} debe terminar en .${src.format}`);
}

/** Valida `practiceResources` (forma; los capítulos se cruzan con el curso al empaquetar). */
export function validatePracticeResources(list: unknown, path = 'practiceResources'): DeliveryValidationError[] {
  const errors: DeliveryValidationError[] = [];
  const err = (p: string, code: string, message: string) => errors.push({ path: p, code, message });
  if (!Array.isArray(list)) return [{ path, code: 'INVALID_TYPE', message: `${path} debe ser una lista` }];
  const L = PRACTICE_RESOURCE_LIMITS;
  if (list.length > L.perCourse) err(path, 'TOO_MANY_RESOURCES', `máximo ${L.perCourse} archivos de trabajo por curso`);
  const ids = new Set<string>();
  const perChapter = new Map<string, number>();
  const filenames = new Set<string>();
  let total = 0;
  list.forEach((r, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(r)) return err(p, 'INVALID_TYPE', `${p} debe ser un objeto`);
    keys(r, ['id', 'chapterId', 'title', 'instructions', 'relation', 'source'], [], p, errors);
    if (typeof r.id !== 'string' || !RESOURCE_ID_RE.test(r.id)) err(`${p}.id`, 'INVALID_RESOURCE_ID', 'id: minúsculas, números y guiones (1–32), empieza con letra o número');
    else if (ids.has(r.id)) err(`${p}.id`, 'DUPLICATE_RESOURCE_ID', `id repetido: ${r.id}`);
    else ids.add(r.id);
    if (typeof r.chapterId !== 'string' || !CHAPTER_ID_RE.test(r.chapterId)) err(`${p}.chapterId`, 'INVALID_CHAPTER_ID', 'chapterId inválido');
    else perChapter.set(r.chapterId, (perChapter.get(r.chapterId) ?? 0) + 1);
    if (typeof r.title !== 'string' || r.title.trim().length < 3 || r.title.length > 160) err(`${p}.title`, 'INVALID_RESOURCE_TITLE', 'title: texto de 3 a 160 caracteres');
    if (typeof r.instructions !== 'string' || r.instructions.length > 1200) err(`${p}.instructions`, 'INVALID_RESOURCE_INSTRUCTIONS', 'instructions: texto de hasta 1200 caracteres');
    if (!(PRACTICE_RESOURCE_RELATIONS as readonly unknown[]).includes(r.relation)) err(`${p}.relation`, 'INVALID_RESOURCE_RELATION', 'relation debe ser application o chapter');
    const s = r.source;
    const sp = `${p}.source`;
    if (!isObj(s) || (s.kind !== 'artifact' && s.kind !== 'table')) return err(sp, 'INVALID_RESOURCE_SOURCE', 'source.kind debe ser artifact o table');
    if (typeof s.filename !== 'string' || !FILENAME_RE.test(s.filename)) err(`${sp}.filename`, 'INVALID_FILENAME', 'filename: nombre simple (sin carpetas) con extensión');
    const ext = typeof s.filename === 'string' ? extensionOf(s.filename) : '';
    if (!(ext in PRACTICE_FILE_MIMETYPES)) err(`${sp}.filename`, 'FILE_TYPE_NOT_ALLOWED', `extensión no permitida (${ext || 'sin extensión'}); permitidas: ${Object.keys(PRACTICE_FILE_MIMETYPES).join(' ')}`);
    else if (typeof s.filename === 'string') {
      const k = `${r.chapterId}|${s.filename.toLowerCase()}`;
      if (filenames.has(k)) err(`${sp}.filename`, 'DUPLICATE_FILENAME', `archivo repetido en el capítulo: ${s.filename}`);
      filenames.add(k);
    }
    if (s.kind === 'artifact') {
      keys(s, ['kind', 'artifactId', 'filename', 'mimetype', 'bytes', 'sha256'], [], sp, errors);
      if (typeof s.artifactId !== 'string' || !UUID_RE.test(s.artifactId)) err(`${sp}.artifactId`, 'INVALID_ARTIFACT_ID', 'artifactId debe ser un uuid');
      if (ext in PRACTICE_FILE_MIMETYPES && s.mimetype !== PRACTICE_FILE_MIMETYPES[ext]) err(`${sp}.mimetype`, 'MIMETYPE_MISMATCH', `mimetype de ${ext} debe ser ${PRACTICE_FILE_MIMETYPES[ext]}`);
      if (!(isInt(s.bytes) && s.bytes >= 1 && s.bytes <= L.fileBytesMax)) err(`${sp}.bytes`, 'FILE_TOO_LARGE', `bytes debe ser un entero de 1 a ${L.fileBytesMax}`);
      else total += s.bytes;
      if (typeof s.sha256 !== 'string' || !SHA256_RE.test(s.sha256)) err(`${sp}.sha256`, 'INVALID_SHA256', 'sha256: 64 hex en minúsculas');
    } else {
      keys(s, ['kind', 'format', 'filename', 'columns', 'rows'], [], sp, errors);
      validateTable(s, sp, err);
    }
  });
  for (const [ch, n] of perChapter) if (n > L.perChapter) err(path, 'TOO_MANY_RESOURCES', `máximo ${L.perChapter} archivos de trabajo por capítulo (${ch} tiene ${n})`);
  if (total > L.courseBytesMax) err(path, 'RESOURCES_TOO_LARGE', `los archivos de trabajo suman ${total} bytes (máximo ${L.courseBytesMax})`);
  return errors;
}

/** Copia con orden de claves fijo (el perfil normalizado se hashea con JSON canónico, pero se guarda legible). */
export function normalizeApplicationDelivery(d: ApplicationDeliveryProfile): ApplicationDeliveryProfile {
  const g = d.grading;
  return {
    mode: d.mode,
    ...(d.chapterModes && Object.keys(d.chapterModes).length
      ? { chapterModes: Object.fromEntries(Object.keys(d.chapterModes).sort().map((k) => [k, (d.chapterModes as Record<string, ApplicationDeliveryMode>)[k]])) }
      : {}),
    submission: {
      onlineText: d.submission.onlineText,
      file: d.submission.file,
      maxFiles: d.submission.maxFiles,
      maxBytes: d.submission.maxBytes,
      fileTypes: [...d.submission.fileTypes],
    },
    dueOffsetDays: typeof d.dueOffsetDays === 'number' ? d.dueOffsetDays : null,
    grading: g.graded ? { graded: true, maxGrade: g.maxGrade, gradepass: g.gradepass, category: g.category, rubric: g.rubric } : { graded: false },
  };
}

export function normalizePracticeResources(list: PracticeResourceSpec[]): PracticeResourceSpec[] {
  return list.map((r) => ({
    id: r.id,
    chapterId: r.chapterId,
    title: r.title,
    instructions: r.instructions,
    relation: r.relation,
    source: r.source.kind === 'artifact'
      ? { kind: 'artifact', artifactId: r.source.artifactId, filename: r.source.filename, mimetype: r.source.mimetype, bytes: r.source.bytes, sha256: r.source.sha256 }
      : { kind: 'table', format: r.source.format, filename: r.source.filename, columns: [...r.source.columns], rows: r.source.rows.map((x) => [...x]) },
  }));
}

/** Modo efectivo de la AA de un capítulo (null si el capítulo no tiene AA). */
export function chapterDeliveryMode(d: ApplicationDeliveryProfile | undefined | null, chapterId: string, hasApplication: boolean): ApplicationDeliveryMode | null {
  if (!hasApplication) return null;
  if (!d) return 'page';
  return d.chapterModes?.[chapterId] ?? d.mode;
}

/**
 * Capítulos con AA entregada como Tarea, desde los items del Manifest (`application_activity:<capítulo>`) — una sola
 * fuente para la evaluación (conteo de ítems calificables), los facts y el builder.
 */
export function assignChapterIds(manifest: { items: ReadonlyArray<{ type: string; key?: string; chapterId?: string | null }> }, d: ApplicationDeliveryProfile | undefined | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const it of manifest.items) {
    if (!it || it.type !== 'application_activity') continue;
    const ch = String(it.chapterId ?? String(it.key ?? '').slice('application_activity:'.length));
    if (chapterDeliveryMode(d, ch, true) === 'assign') out.push(ch);
  }
  return out;
}

/** Cantidad de Tareas CALIFICADAS (ítems de nota) y su categoría. */
export function gradedAssignCount(manifest: { items: ReadonlyArray<{ type: string; key?: string; chapterId?: string | null }> }, d: ApplicationDeliveryProfile | undefined | null): { count: number; category: ApplicationGradeCategory | null } {
  if (!d || d.grading.graded !== true) return { count: 0, category: null };
  return { count: assignChapterIds(manifest, d).length, category: d.grading.category };
}

/**
 * Archivo de trabajo RESUELTO al empaquetar (bytes ya cargados o generados y MEDIDOS): lo que entra en facts y lo que
 * el validador del .mbz compara contra el blob del paquete (sha256 y tamaño).
 */
export interface ResolvedPracticeResource {
  id: string;
  chapterId: string;
  title: string;
  instructions: string;
  relation: PracticeResourceRelation;
  filename: string;
  mimetype: string;
  bytes: number;
  sha256: string;
  /** `upload` (artifact del usuario) o el generador determinístico que lo produjo. */
  origin: 'upload' | 'csv' | 'xlsx';
}
