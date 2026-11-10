/**
 * r107 B5 · Taller de cursos — pedidos, preguntas y plan: tipos (diseño §4 «requests» / «clarify» / «plan», D5–D9).
 *
 * Un PEDIDO de cambio entra como texto libre, documento (DOCX / PDF / TXT / MD) o «Arreglar esto» de un hallazgo de B3.
 * La IA (una llamada, con herramienta forzada) lo convierte en una lista de pedidos ESTRUCTURADOS; el servidor valida cada
 * uno contra un esquema estricto y contra el inventario de ESTA sesión (nunca se acepta un destino que el paquete no
 * tiene) y decide el estado:
 *   - `resolved`     destino único + operación del catálogo de la Fase 2 → se arma su ítem del plan;
 *   - `needs_answer` ambiguo (D6): 1–3 preguntas, cerradas cuando se puede; nunca se elige por el docente;
 *   - `phase_later`  regenerar SCORM / video / Gamma / audio, agregar capítulo o módulo: visible en el plan, no
 *                    disponible todavía, con su costo estimado;
 *   - `out_of_scope` no es un cambio que el Taller haga (con el motivo);
 *   - `unavailable`  es del catálogo pero el motor no lo puede aplicar a ESTE paquete (Libro en PDF, logo sin imagen…);
 *   - `failed`       la IA no produjo un contenido válido tras el reintento, o el motor lo rechaza (motivo visible);
 *   - `preparing`    en curso (contenido nuevo + prueba en seco del motor); `withdrawn` = el docente lo quitó.
 *
 * Puro: sin Nest, sin base, sin red.
 */
import type { EditHtmlOp, EditLibroSectionOp, ExamQuestionAddOp, ExamQuestionRemoveOp, ExamQuestionReplaceOp, BrandReplaceOp, RemoveActivityOp, FieldChange, PatchOperation } from '../patch/types';
import type { MinExpMax } from '../../finops/estimator';
import { PHASE3_OPERATIONS } from '../regenerate/types';

export const PLAN_CODE_VERSION = 'b5-r0';

/** Operaciones que el motor de la Fase 2 aplica (B4). */
export const PHASE2_OPERATIONS = Object.freeze([
  'edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add', 'exam_question_remove', 'brand_replace', 'remove_activity',
] as const);
export type Phase2Operation = (typeof PHASE2_OPERATIONS)[number];

/**
 * r107 B10: operaciones de la Fase 3 (rehacer una actividad con proveedores pagos): se resuelven como las de la Fase 2,
 * pero su contenido se PRODUCE con aprobación y tope (etapa de estimado → `…/plans/:id/generate`) antes de aplicar.
 */
export { PHASE3_OPERATIONS } from '../regenerate/types';
export type Phase3Operation = (typeof PHASE3_OPERATIONS)[number];

/** Operaciones de fases posteriores: visibles en el plan como «no disponible todavía», con su costo (D8). */
export const LATER_OPERATIONS = Object.freeze(['add_chapter', 'add_module'] as const);
export type LaterOperation = (typeof LATER_OPERATIONS)[number];

export type RequestOperation = Phase2Operation | Phase3Operation | LaterOperation;

/** Lo que la IA puede responder en `operation` (catálogo cerrado + las dos salidas sin operación). */
export const AI_OPERATION_VALUES = Object.freeze([...PHASE2_OPERATIONS, ...PHASE3_OPERATIONS, ...LATER_OPERATIONS, 'fuera_de_alcance', 'necesita_respuesta'] as const);

/**
 * Ronda de decisiones: `awaiting_confirmation` = la re-interpretación (IA) espera que el docente apruebe su costo;
 * `awaiting_generation` = resuelto, su contenido nuevo (IA) espera aprobación con tope (`POST …/plans/:id/generate`).
 */
export type RequestStatus = 'needs_answer' | 'awaiting_confirmation' | 'awaiting_generation' | 'preparing' | 'resolved' | 'phase_later' | 'out_of_scope' | 'unavailable' | 'failed' | 'withdrawn';

export type IntakeSource = 'text' | 'document' | 'finding' | 'misalignment';

/** Destino RESUELTO contra el inventario (ids de ESTE paquete). */
export type ResolvedTarget =
  | { kind: 'html'; moduleId: number | null; sectionId?: number | null; field: string; title: string; chapterNumber: number | null }
  | { kind: 'libro'; moduleId: number; chapters: number[]; title: string; recompose: boolean; pdf?: boolean }
  | { kind: 'question'; quizModuleId: number; questionId: number; title: string; chapterNumber: number | null }
  | { kind: 'exam'; quizModuleId: number; title: string }
  | { kind: 'activity'; moduleId: number; title: string; chapterNumber: number | null }
  | { kind: 'course'; title: string }
  | { kind: 'module'; moduleNumber: number; title: string };

/** Pregunta al docente (D6). Cerrada (opciones) cuando se puede; cada opción puede traer la resolución concreta. */
export interface ClarifyQuestion {
  id: string;
  text: string;
  options: ClarifyOption[];
  /** true = además de las opciones, se acepta una respuesta escrita. */
  allowText: boolean;
  /** Quién la hizo: la IA o el servidor (destino que no resuelve único). */
  origin: 'ai' | 'server';
  /** Qué resuelve la respuesta (solo las del servidor): el destino (opciones con `resolves`) o la instrucción (texto). */
  purpose: 'target' | 'instruction' | 'other';
}
export interface ClarifyOption {
  id: string;
  label: string;
  /** Resolución concreta de la opción (un destino del inventario), si la tiene. */
  resolves: { moduleId?: number; field?: string; chapterNumber?: number; questionId?: number; quizModuleId?: number; moduleNumber?: number } | null;
}
export interface ClarifyAnswer {
  questionId: string;
  optionId?: string | null;
  text?: string | null;
}

/** Un pedido estructurado (lo que sale de la interpretación o de «Arreglar esto»). */
export interface InterpretedRequest {
  /** Texto ORIGINAL citado (literal del pedido o título del hallazgo). */
  quote: string;
  /** Qué cambiar, en una frase (lo usa la generación de contenido). */
  instruction: string;
  operation: RequestOperation | null;
  status: Exclude<RequestStatus, 'preparing' | 'withdrawn' | 'awaiting_confirmation' | 'awaiting_generation'>;
  target: ResolvedTarget | null;
  /** Lo que la IA o el hallazgo dijeron del destino (sin resolver), para re-interpretar. */
  rawTarget: Record<string, unknown> | null;
  details: RequestDetails;
  questions: ClarifyQuestion[];
  /** Motivo visible (fuera de alcance, no disponible, fallado, por qué se pregunta). */
  reason: string | null;
}

export interface RequestDetails {
  colors?: Array<{ from: string; to: string }>;
  /** Cambio estructural ya resuelto que NO necesita contenido nuevo (viene de un hallazgo). */
  fixedChange?: EditHtmlOp['change'] | null;
  /** Precondición del campo (sha1 del crudo) cuando viene de un hallazgo. */
  expectRawSha1?: string | null;
  /** Tokens que el contenido nuevo NO puede traer (el roto que se quiere quitar). */
  forbiddenTokens?: string[];
  /** Archivos @@PLUGINFILE@@ que el contenido nuevo puede usar además de los del campo (p. ej. volver a enlazar el audio). */
  allowFiles?: string[];
  /** Regenerar audio: audiolibro o bienvenida. */
  audioTarget?: 'audiobook' | 'welcome';
  /** r107 B10: resultado producido de una regeneración (artifact del Taller) y sus cifras verificables. */
  regenResult?: { artifactId: string; sha256: string; bytes: number } | null;
  /** Agregar capítulos / módulo: cuántos (para el costo). */
  chapters?: number | null;
  /** Enlace muerto (`href="#"`) de un hallazgo: se reemplaza el enlace por su texto (sin IA). */
  deadLink?: { entry: string; fieldRawOffset: number; rawByteOffset: number; rawBytes: number } | null;
  /** Hallazgo de B3 de donde salió («Arreglar esto»). */
  findingId?: string | null;
  /** Ítem del plan del que salió (aviso de desalineación agregado como pedido aparte). */
  fromItemId?: string | null;
  fromWarningId?: string | null;
}

// ─── Plan ──────────────────────────────────────────────────────────────────

export type RiskLevel = 'bajo' | 'medio' | 'alto';
export interface PlanRisk { level: RiskLevel; reasons: string[] }

/** Aviso de desalineación (D7): informativo; agregarlo al plan es un pedido aparte con su costo, nunca automático. */
export interface MisalignmentWarning {
  id: string;
  kind: 'text_match' | 'same_chapter' | 'references' | 'engine';
  activity: { moduleId: number; title: string; modname: string; chapterNumber: number | null } | null;
  /** Pregunta de examen que sigue diciendo el dato viejo (aviso sobre un examen). */
  questionId: number | null;
  /** En español para el docente («El video del capítulo 2 todavía menciona «1990»»). */
  message: string;
  /** Términos del dato viejo que se encontraron (coincidencia de texto). */
  terms: string[];
  /** Operación con que se arreglaría como pedido aparte (null = no se puede desde el Taller). */
  suggestedOperation: RequestOperation | null;
  /** Costo estimado de ese pedido aparte (estimator de FinOps). */
  estimate: MinExpMax | null;
}

export interface PlanItemCost {
  /** IA YA gastada en este ítem (contenido nuevo + re-interpretación). USD. */
  spentUsd: string;
  /** Lo que falta gastar al aplicarlo (estimator). Fase 2: 0 (el contenido ya está generado). */
  apply: MinExpMax;
  /** Estimado de la IA de contenido antes de llamarla (para comparar con lo gastado). */
  contentEstimate: MinExpMax | null;
  basis: string;
}

export interface PlanItemDryRun {
  ok: boolean;
  failure: { code: string; message: string } | null;
  /** Hallazgos de B3 que el cambio resuelve / quita (prueba en seco). */
  resolved: number;
  removed: number;
  engineVersion: string;
}

export interface PlanItemView {
  operation: RequestOperation;
  /** Operación del motor con sus parámetros RESUELTOS (lo que B6 aplica). null = no disponible todavía. */
  params: PatchOperation | null;
  available: boolean;
  summary: string;
  /** Antes / después reales del informe de cambios del motor (D5). */
  changes: FieldChange[];
  files: Array<{ filename: string; before: string; after: string }>;
  entries: { added: string[]; removed: string[]; modified: string[] };
  risk: PlanRisk;
  cost: PlanItemCost;
  misalignment: MisalignmentWarning[];
  dryRun: PlanItemDryRun | null;
  /** Fix round 1 (P2-4): riesgo alto → B6 exige confirmarlo uno por uno al aplicar. */
  requiresItemConfirm: boolean;
  /** false = etapa de ESTIMADO: todavía sin contenido generado (sin antes/después); se genera al aprobarlo con tope. */
  generated: boolean;
  /** La llamada de IA que generaría el contenido (estimado + cota), mientras no se generó. */
  plannedCall?: { model?: string; kind: string; promptChars: number; maxTokens: number; size: { promptChars: number; outputChars?: number; chapters?: number }; expectedUsd: string; boundUsd: string } | null;
}

export type Phase2Op = EditHtmlOp | EditLibroSectionOp | ExamQuestionReplaceOp | ExamQuestionAddOp | ExamQuestionRemoveOp | BrandReplaceOp | RemoveActivityOp;

/** Límites del Taller para los pedidos (también defensa contra documentos enormes / hostiles). */
export const PLAN_LIMITS = Object.freeze({
  /** Texto escrito en el formulario. */
  textMaxChars: 20_000,
  /** Texto extraído de un documento (lo demás se rechaza con motivo: «envía solo los cambios»). */
  documentTextMaxChars: 40_000,
  /** Documento subido (DOCX / PDF / TXT / MD). */
  documentMaxBytes: 10 * 1024 * 1024,
  /** Pedidos por entrada. */
  requestsPerIntake: 15,
  /** Preguntas por pedido (D6: 1–3). */
  questionsMin: 1,
  questionsMax: 3,
  optionsMax: 8,
  /** Rondas de preguntas por pedido. */
  roundsMax: 3,
  answerTextMaxChars: 600,
  /** Contexto del capítulo que se le pasa a la generación de contenido. */
  chapterContextChars: 6_000,
});

export const DOCUMENT_EXTENSIONS = Object.freeze(['.docx', '.pdf', '.txt', '.md'] as const);
