import { createHash } from 'crypto';

/**
 * Prebrief pedagógico · Plausibilidad de lo leído del documento (puro, determinista, sin IA).
 *
 * El extractor gratuito ya marca de dónde sale cada dato, pero no si el texto ES lo que dice ser. Un microcurrículo
 * institucional suele conservar instrucciones de la plantilla («INSTRUCCIÓN: Tomar ejemplos…»), bibliografía o
 * fragmentos que terminan leídos como resultados o evaluaciones (caso R10 del piloto). Presentar eso a un rector como
 * «resultado de aprendizaje del documento» es inaceptable: el Prebrief no se puede preparar mientras haya un dato del
 * documento con señales de duda, hasta que el docente lo confirme (o lo corrija / quite en «Lo que entendimos»).
 *
 * Solo se revisa lo que viene del documento: lo que escribió o confirmó el docente es suyo.
 */

export type DoubtKind = 'outcome' | 'competency' | 'evaluation' | 'objective' | 'learner';
export type DoubtReason = 'template' | 'bibliography' | 'fragment' | 'too_long' | 'duplicate';

export interface DoubtfulItem {
  kind: DoubtKind;
  /** Id del dato (RA1, CO2, índice de la evaluación…) para corregirlo en «Lo que entendimos». */
  id: string;
  text: string;
  reason: DoubtReason;
  /** Clave de confirmación (cambia si cambia el texto). */
  confirmKey: string;
}

export const DOUBT_REASON_TEXT: Record<DoubtReason, string> = {
  template: 'parece una instrucción de la plantilla del documento',
  bibliography: 'parece una referencia bibliográfica',
  fragment: 'parece un fragmento incompleto',
  too_long: 'parece un párrafo completo y no un dato puntual',
  duplicate: 'está repetido',
};

export const DOUBT_KIND_TEXT: Record<DoubtKind, string> = {
  outcome: 'Resultado de aprendizaje',
  competency: 'Competencia',
  evaluation: 'Evaluación',
  objective: 'Objetivo general',
  learner: 'Descripción del estudiante',
};

const TEMPLATE_RE = /(^|[^\p{L}])(instrucci[oó]n(es)?\s*:|tomar\s+ejemplos|diligenci(ar|e|a)\b|escriba\s+aqu[ií]|escribir\s+aqu[ií]|completar\s+con|ingrese\s+(aqu[ií]|el|la|los|las)|describa\s+aqu[ií]|nombre\s+de\s+la\s+asignatura\s*:|lorem\s+ipsum|x{3,}|_{4,}|\[\s*(nombre|texto|insertar|completar)[^\]]*\]|<\s*(nombre|texto|insertar)[^>]*>)/iu;
const CAPS_LEAD_RE = /^\s*[A-ZÁÉÍÓÚÑ]{4,}(\s+[A-ZÁÉÍÓÚÑ]{2,})*\s*:/u;
const BIB_RE = /^\s*(?:[-*•]|\d{1,3}[.)])?\s*[A-ZÁÉÍÓÚÑ][\p{L}'’-]+,\s+(?:[A-ZÁÉÍÓÚÑ]\.|[A-ZÁÉÍÓÚÑ][\p{L}'’-]+)[^\n]*?\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)/u;
const BIB_MARKERS_RE = /(\b(editorial|ed\.|isbn|issn|doi|pp\.|vol\.|recuperado\s+de|disponible\s+en)\b|https?:\/\/)/iu;
const YEAR_RE = /\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)|\b(?:19|20)\d{2}\b/u;

export function normalizeForKey(t: string): string {
  return String(t || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function confirmKeyOf(kind: DoubtKind, text: string): string {
  return createHash('sha256').update(`${kind}\u0000${normalizeForKey(text)}`).digest('hex').slice(0, 32);
}

const words = (t: string) => (String(t || '').match(/[\p{L}\p{N}]+/gu) || []).length;

/** Motivo de duda de UN texto (null = plausible). */
export function doubtOf(kind: DoubtKind, text: string): DoubtReason | null {
  const t = String(text || '').trim();
  if (!t) return null;
  if (TEMPLATE_RE.test(t) || CAPS_LEAD_RE.test(t)) return 'template';
  if (BIB_RE.test(t) || (BIB_MARKERS_RE.test(t) && YEAR_RE.test(t))) return 'bibliography';
  const n = words(t);
  const min = kind === 'evaluation' ? 2 : kind === 'learner' ? 3 : 4;
  if (n < min) return 'fragment';
  const max = kind === 'objective' || kind === 'learner' ? 120 : 70;
  if (n > max) return 'too_long';
  return null;
}

export interface PlausibilityInput {
  outcomes: { id: string; text: string; fromDocument: boolean }[];
  competencies: { id: string; text: string; fromDocument: boolean }[];
  evaluations: { id: string; text: string; fromDocument: boolean }[];
  objective: { text: string; fromDocument: boolean } | null;
  learner: { text: string; fromDocument: boolean } | null;
}

/** Datos del documento que requieren confirmación (sin los ya confirmados). Orden estable. */
export function doubtfulItems(input: PlausibilityInput, confirmed: ReadonlySet<string>): DoubtfulItem[] {
  const out: DoubtfulItem[] = [];
  const push = (kind: DoubtKind, id: string, text: string, reason: DoubtReason) => {
    const confirmKey = confirmKeyOf(kind, text);
    if (!confirmed.has(confirmKey)) out.push({ kind, id, text, reason, confirmKey });
  };
  const list = (kind: DoubtKind, xs: { id: string; text: string; fromDocument: boolean }[]) => {
    const seen = new Set<string>();
    for (const x of xs) {
      const k = normalizeForKey(x.text);
      if (x.fromDocument) {
        const r = doubtOf(kind, x.text);
        if (r) push(kind, x.id, x.text, r);
        else if (seen.has(k)) push(kind, x.id, x.text, 'duplicate');
      }
      seen.add(k);
    }
  };
  list('outcome', input.outcomes);
  list('competency', input.competencies);
  list('evaluation', input.evaluations);
  if (input.objective && input.objective.fromDocument) {
    const r = doubtOf('objective', input.objective.text);
    if (r) push('objective', 'objective', input.objective.text, r);
  }
  if (input.learner && input.learner.fromDocument) {
    const r = doubtOf('learner', input.learner.text);
    if (r) push('learner', 'learner', input.learner.text, r);
  }
  return out;
}
