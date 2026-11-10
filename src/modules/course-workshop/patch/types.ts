/**
 * r107 B4 · Taller de cursos — motor de parches determinista, Fase 2: tipos de las operaciones y del INFORME DE CAMBIOS.
 *
 * Catálogo CERRADO (diseño §4): `edit_html`, `edit_libro_section`, `exam_question_replace` / `_add` / `_remove`,
 * `brand_replace`, `remove_activity`. No existe «editar XML»: cada operación recibe parámetros YA RESUELTOS (el contenido
 * nuevo viene en los parámetros; en B4 no hay IA) y el motor decide CÓMO se escribe con las reglas de los builders.
 */

// ─── Operaciones ────────────────────────────────────────────────────────────

/** Campo HTML destino: de una actividad (`intro`, `content`, `chapter:<id>` de un book…) o el resumen de una sección. */
export type HtmlTarget =
  | { moduleId: number; field: string }
  | { sectionId: number; field?: 'summary' };

/**
 * Cambio de un campo HTML:
 *  - `replace`: HTML nuevo completo del campo;
 *  - `range`: reemplazo puntual de un rango en BYTES del contenido CRUDO (escapado) del campo — lo que trae el hallazgo
 *    `dead_link` de B3 (`linkRawByteOffset` / `linkRawBytes`); `html` es el HTML (sin escapar) que va en su lugar;
 *  - `token`: un token `$@…@$` exacto del campo → `unlink` (quita el `<a>` que lo usa y deja su texto) o `retarget`
 *    (lo cambia por otro token, que se valida contra el inventario).
 */
export type HtmlChange =
  | { kind: 'replace'; html: string }
  | { kind: 'range'; rawByteOffset: number; rawBytes: number; html: string }
  | { kind: 'token'; token: string; action: 'unlink' }
  | { kind: 'token'; token: string; action: 'retarget'; to: string };

export interface EditHtmlOp {
  op: 'edit_html';
  target: HtmlTarget;
  /** Precondición: sha1 del contenido crudo del campo (el `rawSha1` / `fieldRawSha1` del inventario o del hallazgo). */
  expectRawSha1?: string;
  change: HtmlChange;
}

/** Capítulo del Libro Guía V1: número (el del título «Capítulo N: …»), HTML del cuerpo y, opcional, título nuevo. */
export interface LibroChapterInput {
  number: number;
  html: string;
  title?: string;
}

export interface EditLibroSectionOp {
  op: 'edit_libro_section';
  moduleId: number;
  /**
   * Libro que cierra en `</html>`: se reemplaza el CUERPO de cada capítulo dado (el resto del documento queda igual).
   * Libro cortado (no cierra en `</html>`): se recompone el documento completo — portada + índice del original (si
   * están completos, o `front` si se da) + los capítulos completos que sobrevivieron + los dados acá + cierre. Tienen
   * que venir TODOS los capítulos que el corte se llevó.
   */
  chapters: LibroChapterInput[];
  /** Solo para recomponer: `<head>` (contenido interno) y portada + índice cuando el corte también se los llevó. */
  front?: { headHtml: string; coverHtml: string };
}

/** Pregunta nueva (contenido ya resuelto). HTML en enunciado, opciones y retroalimentación. */
export type NewQuestion =
  | {
    qtype: 'multichoice';
    name?: string;
    text: string;
    generalFeedback?: string;
    /** true (por defecto): una sola respuesta → exactamente una opción al 100 %. false: varias, fracciones que suman 1. */
    single?: boolean;
    answers: Array<{ html: string; fraction: number; feedback?: string }>;
  }
  | {
    qtype: 'truefalse';
    name?: string;
    text: string;
    generalFeedback?: string;
    correct: boolean;
    feedbackTrue?: string;
    feedbackFalse?: string;
  };

export interface ExamQuestionReplaceOp {
  op: 'exam_question_replace';
  quizModuleId: number;
  questionId: number;
  question: NewQuestion;
}
export interface ExamQuestionAddOp {
  op: 'exam_question_add';
  quizModuleId: number;
  question: NewQuestion;
  /**
   * Categoría del banco donde va. Examen con ranuras fijas: por defecto la categoría de sus preguntas (si es una sola).
   * Examen con ranuras aleatorias: obligatoria (una categoría de la que sortea alguna ranura).
   */
  categoryId?: number;
  /** Nota de la ranura nueva (solo ranuras fijas). Por defecto la más común del examen. */
  maxmark?: number;
}
export interface ExamQuestionRemoveOp {
  op: 'exam_question_remove';
  quizModuleId: number;
  questionId: number;
}

export interface BrandReplaceOp {
  op: 'brand_replace';
  /** Logo: `currentSha1` = sha1 de los BYTES del logo actual (blob o imagen embebida en base64). */
  logo?: { currentSha1: string; image: { base64: string; mimetype: string } };
  /** `#hex viejo → #hex nuevo`, aplicado SOLO dentro de atributos `style=""` de los campos HTML. */
  colors?: Record<string, string>;
}

export interface RemoveActivityOp {
  op: 'remove_activity';
  moduleId: number;
}

export type PatchOperation =
  | EditHtmlOp | EditLibroSectionOp | ExamQuestionReplaceOp | ExamQuestionAddOp | ExamQuestionRemoveOp
  | BrandReplaceOp | RemoveActivityOp;

export const PATCH_OPERATIONS_PHASE2 = Object.freeze([
  'edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add', 'exam_question_remove', 'brand_replace', 'remove_activity',
] as const);

// ─── Informe de cambios ─────────────────────────────────────────────────────

export interface FieldChange {
  entry: string;
  field: string;
  moduleId: number | null;
  sectionId: number | null;
  questionId?: number | null;
  /** HTML desescapado antes / después (completo: B5 lo muestra en el plan). */
  before: string;
  after: string;
  beforeRawSha1: string;
  afterRawSha1: string;
}

export interface FileChange {
  fileId: number;
  filename: string;
  component: string;
  filearea: string;
  before: { contenthash: string; filesize: number; mimetype: string | null };
  after: { contenthash: string; filesize: number; mimetype: string | null };
}

export interface OperationReport {
  index: number;
  op: PatchOperation['op'];
  /** Qué tocó, en español para el plan («Etiqueta “Bienvenida” — intro»). */
  summary: string;
  fields: FieldChange[];
  files: FileChange[];
  /** Entradas del paquete agregadas / quitadas / modificadas (rutas). */
  entriesAdded: string[];
  entriesRemoved: string[];
  entriesModified: string[];
  /** Ids nuevos asignados, por tipo (`question`, `answer`, `question_bank_entry`, `question_instance`…). */
  idsAssigned: Record<string, number[]>;
  /** Avisos de desalineación (D7): lo que quedó desalineado y NO se arregló solo. */
  misalignment: string[];
  /** Detalle adicional (capítulos recompuestos, tokens saneados, colores por campo…). */
  notes: string[];
}

export interface DiagnosisDelta {
  /** Conteos error/warning/info antes y después. */
  before: { error: number; warning: number; info: number };
  after: { error: number; warning: number; info: number };
  /** Hallazgos error/warning del original que ya no aparecen. */
  resolved: Array<{ signature: string; title: string; severity: string }>;
  /** Hallazgos error/warning que NO estaban en el original (el plan falla si hay alguno). */
  introduced: Array<{ signature: string; title: string; severity: string }>;
}

export type PatchFailureCode =
  | 'invalid_params' | 'target_not_found' | 'stale_target' | 'unsupported' | 'unavailable' | 'invalid_content'
  | 'invariant' | 'new_findings' | 'package_unreadable' | 'inventory_mismatch';

export interface PatchFailure {
  /** Índice (desde 0) y operación que falló; null = falla del plan entero (p. ej. hallazgos nuevos). */
  opIndex: number | null;
  op: string | null;
  code: PatchFailureCode;
  message: string;
}

export interface PatchResult {
  ok: boolean;
  /** Paquete nuevo (mismo contenedor que el original). Solo si ok. */
  package: Buffer | null;
  container: 'zip' | 'tar.gz';
  sha1: string | null;
  operations: OperationReport[];
  diagnosis: DiagnosisDelta | null;
  /** Entradas que no se tocaron y conservan sus bytes comprimidos tal cual (zip). */
  preservedEntries: number;
  failure: PatchFailure | null;
}

/** Falla de una operación (motivo en español; el plan entero falla con ella). */
export class PatchError extends Error {
  constructor(readonly code: PatchFailureCode, message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export function emptyReport(index: number, op: PatchOperation['op']): OperationReport {
  return { index, op, summary: '', fields: [], files: [], entriesAdded: [], entriesRemoved: [], entriesModified: [], idsAssigned: {}, misalignment: [], notes: [] };
}
