// Cursia V2.1 / R7-core — utilidades compartidas por los validadores/builders H5P.
//
// Regla: la entrada (futuro JSON del LLM) es SIEMPRE texto plano. Cualquier
// etiqueta HTML se rechaza; los caracteres <, > y & se escapan y, donde H5P
// espera HTML, el texto se envuelve en <p>/<div>. Todo es puro y determinístico.
import { h5pSubContentId } from '../ids';
import { applyH5pL10n } from '../l10n';
import { h5pProfileVersion, CURSIA_H5P_PROFILE_V1, profileLibraryString } from '../profile';

export class H5pInputError extends Error {
  readonly errors: string[];
  constructor(kind: string, errors: string[]) {
    super(`H5P_INPUT_INVALID(${kind}): ${errors.join('; ')}`);
    this.name = 'H5pInputError';
    this.errors = errors;
  }
}

/** Colector de errores de validación: se acumulan todos y se lanza una sola vez. */
export class Issues {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    this.list.push(`${path}: ${msg}`);
  }
  throwIfAny(kind: string): void {
    if (this.list.length) throw new H5pInputError(kind, this.list);
  }
}

// Una etiqueta (<p>, </b>, <br/>, <img src=…>), un comentario o CDATA. "a < b" sigue siendo texto válido.
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>|<!--|<!\[CDATA\[/;
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function checkKeys(issues: Issues, path: string, obj: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) issues.add(path, `campo desconocido "${k}"`);
  }
}

export interface PlainTextRule {
  min?: number;
  max: number;
  multiline?: boolean;
}

/** Valida un texto plano (sin HTML, sin entidades, sin caracteres de control). */
export function checkPlainText(issues: Issues, path: string, v: unknown, rule: PlainTextRule): v is string {
  if (typeof v !== 'string') {
    issues.add(path, 'debe ser texto');
    return false;
  }
  const t = v.trim();
  const min = rule.min ?? 1;
  if (t.length < min) {
    issues.add(path, min === 1 ? 'no puede estar vacío' : `mínimo ${min} caracteres`);
    return false;
  }
  if (t.length > rule.max) issues.add(path, `máximo ${rule.max} caracteres`);
  if (HTML_TAG_RE.test(v)) issues.add(path, 'no se permite HTML (solo texto plano)');
  if (HTML_ENTITY_RE.test(v)) issues.add(path, 'no se permiten entidades HTML (solo texto plano)');
  if (CONTROL_RE.test(v)) issues.add(path, 'caracteres de control no permitidos');
  if (!rule.multiline && /[\r\n]/.test(v)) issues.add(path, 'debe ser una sola línea');
  return true;
}

const ITEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-/]{0,199}$/;

export function checkItemKey(issues: Issues, v: unknown): v is string {
  if (typeof v !== 'string' || !ITEM_KEY_RE.test(v)) {
    issues.add('itemKey', 'inválido (letras, dígitos y : _ . - /; sin "#")');
    return false;
  }
  return true;
}

export function checkInt(issues: Issues, path: string, v: unknown, min: number, max: number): v is number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    issues.add(path, `debe ser un entero entre ${min} y ${max}`);
    return false;
  }
  return true;
}

export function checkArray(issues: Issues, path: string, v: unknown, min: number, max: number): v is unknown[] {
  if (!Array.isArray(v)) {
    issues.add(path, 'debe ser una lista');
    return false;
  }
  if (v.length < min || v.length > max) {
    issues.add(path, `debe tener entre ${min} y ${max} elementos (tiene ${v.length})`);
    return false;
  }
  return true;
}

/** Escapa & < > (nada más: H5P re-escapa comillas en su validador). */
export function escapeText(s: string): string {
  return s.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlP(s: string): string {
  return `<p>${escapeText(s)}</p>`;
}

export function htmlDiv(s: string): string {
  return `<div>${escapeText(s)}</div>`;
}

/** Recorta un texto plano para usarlo en metadata.title (máx. 255 en H5P). */
export function shortTitle(s: string, max = 90): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ── Sub-contenidos compartidos: MultiChoice y TrueFalse ─────────────────────

export interface MultiChoiceAnswerInput {
  text: string;
  correct: boolean;
  feedback?: string;
}

export interface MultiChoiceQuestionInput {
  kind: 'multichoice';
  question: string;
  answers: MultiChoiceAnswerInput[];
}

export interface TrueFalseQuestionInput {
  kind: 'truefalse';
  question: string;
  correct: boolean;
  feedbackCorrect?: string;
  feedbackWrong?: string;
}

export type ChoiceQuestionInput = MultiChoiceQuestionInput | TrueFalseQuestionInput;

export interface ChoiceRules {
  minAnswers: number;
  maxAnswers: number;
  exactlyOneCorrect: boolean;
  extraKeys?: string[];
}

export function checkChoiceQuestion(issues: Issues, path: string, q: unknown, rules: ChoiceRules): void {
  if (!isPlainObject(q)) {
    issues.add(path, 'debe ser un objeto');
    return;
  }
  const extra = rules.extraKeys || [];
  if (q.kind === 'multichoice') {
    checkKeys(issues, path, q, ['kind', 'question', 'answers', ...extra]);
    checkPlainText(issues, `${path}.question`, q.question, { max: 400 });
    if (checkArray(issues, `${path}.answers`, q.answers, rules.minAnswers, rules.maxAnswers)) {
      let correct = 0;
      const seen = new Set<string>();
      (q.answers as unknown[]).forEach((a, j) => {
        const ap = `${path}.answers[${j}]`;
        if (!isPlainObject(a)) {
          issues.add(ap, 'debe ser un objeto');
          return;
        }
        checkKeys(issues, ap, a, ['text', 'correct', 'feedback']);
        if (checkPlainText(issues, `${ap}.text`, a.text, { max: 200 })) {
          const norm = (a.text as string).trim().toLowerCase();
          if (seen.has(norm)) issues.add(`${ap}.text`, 'respuesta duplicada');
          seen.add(norm);
        }
        if (typeof a.correct !== 'boolean') issues.add(`${ap}.correct`, 'debe ser booleano');
        else if (a.correct) correct++;
        if (a.feedback !== undefined) checkPlainText(issues, `${ap}.feedback`, a.feedback, { max: 300 });
      });
      if (rules.exactlyOneCorrect && correct !== 1) issues.add(`${path}.answers`, `debe haber exactamente 1 correcta (hay ${correct})`);
      if (!rules.exactlyOneCorrect && correct < 1) issues.add(`${path}.answers`, 'debe haber al menos 1 correcta');
    }
  } else if (q.kind === 'truefalse') {
    checkKeys(issues, path, q, ['kind', 'question', 'correct', 'feedbackCorrect', 'feedbackWrong', ...extra]);
    checkPlainText(issues, `${path}.question`, q.question, { max: 400 });
    if (typeof q.correct !== 'boolean') issues.add(`${path}.correct`, 'debe ser booleano');
    if (q.feedbackCorrect !== undefined) checkPlainText(issues, `${path}.feedbackCorrect`, q.feedbackCorrect, { max: 300 });
    if (q.feedbackWrong !== undefined) checkPlainText(issues, `${path}.feedbackWrong`, q.feedbackWrong, { max: 300 });
  } else {
    issues.add(`${path}.kind`, 'debe ser "multichoice" o "truefalse"');
  }
}

export interface H5pSubContent {
  library: string;
  subContentId: string;
  metadata: { contentType: string; license: string; title: string };
  params: Record<string, any>;
}

/** Sub-contenido MultiChoice/TrueFalse con subContentId determinístico y l10n completa. */
export function buildChoiceSubContent(
  q: ChoiceQuestionInput,
  itemKey: string,
  index: number,
  title: string,
): H5pSubContent {
  const subContentId = h5pSubContentId(itemKey, index, h5pProfileVersion);
  title = escapeText(title);
  if (!title) throw new Error('H5P_SUBCONTENT_TITLE_EMPTY');
  if (q.kind === 'multichoice') {
    const params = applyH5pL10n('H5P.MultiChoice', {
      media: { disableImageZooming: false },
      question: htmlP(q.question),
      answers: q.answers.map((a) => ({
        text: htmlDiv(a.text),
        correct: a.correct,
        tipsAndFeedback: {
          tip: '',
          chosenFeedback: a.feedback ? htmlDiv(a.feedback) : '',
          notChosenFeedback: '',
        },
      })),
      overallFeedback: [{ from: 0, to: 100 }],
      behaviour: {
        // HD-V21-22: sin reintento DENTRO del intento (ver solución → corregir → 100 no se permite);
        // mejorar la nota = intento nuevo (IV recargado / "Reintentar" final del QuestionSet).
        enableRetry: false,
        enableSolutionsButton: true,
        enableCheckButton: true,
        type: 'auto',
        singlePoint: true, // 1 punto por pregunta (§K.1)
        randomAnswers: true,
        showSolutionsRequiresInput: true,
        confirmCheckDialog: false,
        confirmRetryDialog: false,
        autoCheck: false,
        passPercentage: 100,
        showScorePoints: true,
      },
    });
    return {
      library: profileLibraryString(CURSIA_H5P_PROFILE_V1, 'H5P.MultiChoice'),
      subContentId,
      metadata: { contentType: 'Multiple Choice', license: 'U', title },
      params,
    };
  }
  const behaviour: Record<string, unknown> = {
    enableRetry: false, // HD-V21-22 (ver arriba)
    enableSolutionsButton: true,
    enableCheckButton: true,
    confirmCheckDialog: false,
    confirmRetryDialog: false,
    autoCheck: false,
  };
  if (q.feedbackCorrect) behaviour.feedbackOnCorrect = escapeText(q.feedbackCorrect);
  if (q.feedbackWrong) behaviour.feedbackOnWrong = escapeText(q.feedbackWrong);
  const params = applyH5pL10n('H5P.TrueFalse', {
    media: { disableImageZooming: false },
    question: htmlP(q.question),
    correct: q.correct ? 'true' : 'false',
    behaviour,
  });
  return {
    library: profileLibraryString(CURSIA_H5P_PROFILE_V1, 'H5P.TrueFalse'),
    subContentId,
    metadata: { contentType: 'True/False Question', license: 'U', title },
    params,
  };
}

/** Resultado común de todos los builders: listo para `buildContentOnlyH5p`. */
export interface H5pBuiltContent {
  mainLibrary: string;
  title: string;
  content: Record<string, any>;
  /** subContentIds en orden (vacío si la librería no tiene sub-contenidos). */
  subContentIds: string[];
  /** Puntaje máximo esperado (1 por pregunta / hueco / interacción). */
  maxScore: number;
}

export function titleRule(issues: Issues, v: unknown): void {
  checkPlainText(issues, 'title', v, { max: 200 });
}
