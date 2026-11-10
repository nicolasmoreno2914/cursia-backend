/**
 * r107 B3 · Taller de cursos — diagnóstico técnico: tipos del HALLAZGO (diseño §5, «Técnico»).
 *
 * Un hallazgo dice QUÉ está mal (título en español claro para un docente, sin jerga), DÓNDE (curso / capítulo /
 * actividad `activities/<dir>`), con qué EVIDENCIA (entrada del paquete + fragmento corto) y, si existe, qué operación
 * del catálogo cerrado del motor de parches (diseño §4) lo arreglaría (`suggestedFix`, insumo de «Arreglar esto» en
 * B5/B7). El detalle técnico va aparte (`detail`): el docente nunca ve ids, tokens ni nombres de XML en el título.
 *
 * Puro: sin Nest, sin base, sin red.
 */
import { createHash } from 'crypto';

/** Checks técnicos T01–T12 (diseño §5). */
export type CheckId = 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10' | 'T11' | 'T12';
export const CHECK_IDS: readonly CheckId[] = Object.freeze(['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12']) as readonly CheckId[];

/**
 * error   = algo que se rompe o no se ve al restaurar / al usar el curso (el estudiante lo sufre);
 * warning = funciona, pero algo falta, está desalineado o va a fallar en otro Moodle;
 * info    = dato útil que no cambia el semáforo (p. ej. duración y bitrate del audiolibro).
 */
export type Severity = 'error' | 'warning' | 'info';
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ info: 0, warning: 1, error: 2 });

/** Catálogo CERRADO de operaciones del motor de parches (diseño §4). No hay «editar XML». */
export type WorkshopOperation =
  | 'edit_html' | 'edit_libro_section' | 'exam_question_replace' | 'exam_question_add' | 'exam_question_remove'
  | 'brand_replace' | 'remove_activity' | 'regenerate_scorm' | 'regenerate_video' | 'regenerate_gamma'
  | 'regenerate_audio' | 'add_chapter' | 'add_module';
export const WORKSHOP_OPERATIONS: readonly WorkshopOperation[] = Object.freeze([
  'edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add', 'exam_question_remove',
  'brand_replace', 'remove_activity', 'regenerate_scorm', 'regenerate_video', 'regenerate_gamma',
  'regenerate_audio', 'add_chapter', 'add_module',
]) as readonly WorkshopOperation[];

export interface FindingActivityRef {
  moduleId: number;
  /** `activities/<modname>_<moduleid>` — la carpeta del paquete. */
  dir: string;
  modname: string;
  title: string;
}

export interface FindingScope {
  level: 'course' | 'chapter' | 'activity';
  /** Capítulo del curso (número global), si la actividad o el hallazgo es de un capítulo. */
  chapterNumber: number | null;
  /** Módulo (unidad) del curso, si se sabe. */
  moduleNumber: number | null;
  activity: FindingActivityRef | null;
}

export interface FindingEvidence {
  /** Entrada exacta del paquete donde se vio (`activities/label_954/label.xml`, `files/77/77…`, `questions.xml`…). */
  entry: string | null;
  /** Fragmento corto (≤ 160 caracteres) de lo que se vio. */
  excerpt: string | null;
  /** Archivo de files.xml involucrado. */
  file: { fileId: number; component: string; filearea: string; filename: string; contenthash: string } | null;
  /** Pregunta del banco (questions.xml). */
  questionId: number | null;
  /** Token `$@…@$` exacto. */
  token: string | null;
}

export interface SuggestedFix {
  operation: WorkshopOperation;
  /** Parámetros de la operación (destino exacto); B4/B5 los validan contra el paquete antes de aplicar. */
  params: Record<string, unknown>;
}

/** Hallazgo de otra fuente (el validador v3 del builder) que describe lo MISMO: se adjunta, no se duplica. */
export interface Corroboration {
  source: 'mbz-validator-v3';
  code: string;
  where: string;
  message: string;
}

export interface Finding {
  /** Id estable: mismo paquete → mismo id (B5/B7 lo usan para «Arreglar esto»). */
  id: string;
  check: CheckId;
  /** Sub-código estable dentro del check (`blob_missing`, `token_orphan`…). */
  code: string;
  severity: Severity;
  scope: FindingScope;
  /** Para el docente: qué pasa y dónde, sin jerga. */
  title: string;
  /** Técnico: ids, entradas, tokens, valores. */
  detail: string;
  evidence: FindingEvidence;
  suggestedFix: SuggestedFix | null;
  corroboratedBy: Corroboration[];
  /**
   * r107 B4 fix round 1: el arreglo sugerido se PRUEBA con el motor de parches sobre este mismo paquete (sin contenido
   * nuevo: lo estructural). `ok` = aplica; `fallback` = el sugerido no aplica y se ofrece otro (`suggestedFix` ya es el
   * nuevo, `original` el que no aplicaba); `unavailable` = ninguno aplica (`suggestedFix` null, `reason` dice por qué);
   * `not_checked` = operación de otra fase (regenerar), que el motor de la Fase 2 no puede probar.
   */
  fixPrecheck: FixPrecheck | null;
}

export interface FixPrecheck {
  status: 'ok' | 'fallback' | 'unavailable' | 'not_checked';
  reason: string | null;
  original: SuggestedFix | null;
}

/** Estado de un check en un diagnóstico: corrió, no aplica a este paquete (con el motivo) o queda para otro momento. */
export interface CheckStatus {
  check: CheckId;
  title: string;
  status: 'ran' | 'not_applicable' | 'deferred';
  /** Motivo cuando no corrió (en español, visible). */
  reason: string | null;
}

export const EXCERPT_MAX = 160;

/** Fragmento corto y de una línea (nunca un blob entero en el hallazgo). */
export function excerptOf(s: string | null | undefined, max = EXCERPT_MAX): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const emptyEvidence = (): FindingEvidence => ({ entry: null, excerpt: null, file: null, questionId: null, token: null });

export interface FindingInput {
  check: CheckId;
  code: string;
  severity: Severity;
  scope: FindingScope;
  title: string;
  detail: string;
  evidence?: Partial<FindingEvidence>;
  suggestedFix?: SuggestedFix | null;
  /** Discrimina dos hallazgos del mismo código sobre el mismo destino (p. ej. dos tokens del mismo campo). */
  key?: string;
}

/**
 * Arma el hallazgo con su id estable: `T04.token_orphan.<12 hex>` sobre (check, código, actividad, entrada, archivo,
 * pregunta, token, key). Nada que dependa del reloj ni del orden de ejecución.
 */
export function makeFinding(i: FindingInput): Finding {
  const evidence: FindingEvidence = { ...emptyEvidence(), ...(i.evidence ?? {}) };
  evidence.excerpt = excerptOf(evidence.excerpt);
  const k = [
    i.check, i.code, i.scope.level, i.scope.chapterNumber ?? '', i.scope.activity?.dir ?? '',
    evidence.entry ?? '', evidence.file ? `${evidence.file.fileId}` : '', evidence.questionId ?? '', evidence.token ?? '', i.key ?? '',
  ].join('|');
  const h = createHash('sha1').update(k).digest('hex').slice(0, 12);
  return {
    id: `${i.check}.${i.code}.${h}`,
    check: i.check,
    code: i.code,
    severity: i.severity,
    scope: i.scope,
    title: i.title,
    detail: i.detail,
    evidence,
    suggestedFix: i.suggestedFix ?? null,
    corroboratedBy: [],
    fixPrecheck: null,
  };
}
