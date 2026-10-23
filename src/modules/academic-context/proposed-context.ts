import { ACADEMIC_LIMITS, AcademicContextV1, Competency, LearningOutcome, emptyAcademicContext } from './academic-context';
import { bloomLevelOf, outcomeDomainOf } from './bloom';

/**
 * LOOP 8.2 · «Lo que entendimos» sin documento y edición de los resultados de aprendizaje.
 *
 * Puro: sin DB, sin red, sin reloj. El resultado se guarda por el camino de siempre (perfil versionado 'academic'), así
 * la derivación del perfil pedagógico (8.1), la poda de vínculos y el Blueprint funcionan igual que con un documento.
 *
 *  - buildProposedContext: lo que Cursia interpretó del pedido (consulta pequeña de IA en el cliente) queda como
 *    contexto académico SIN documentos, cada dato `inferred` con la regla PROPOSAL_BASIS. Nunca reemplaza un contexto
 *    que viene de un documento (el documento manda).
 *  - rewriteOutcomes: el docente corrige la lista de resultados. Lo que no cambió conserva su origen (y su cita del
 *    documento); lo editado o nuevo pasa a `provided` («escrito por ti»). `accept` confirma los propuestos sin
 *    cambiarlos (pasan a `provided`). Los ids se conservan para no romper vínculos con capítulos.
 */

export const PROPOSAL_BASIS = 'Propuesto por Cursia a partir de tu pedido';
export const PROPOSAL_LIMITS = Object.freeze({ outcomes: 12, competencies: 10, priorKnowledge: 8 });

export class ProposedContextError extends Error {
  constructor(readonly code: 'DOCUMENT_CONTEXT' | 'USER_CONTEXT' | 'NO_OUTCOMES' | 'DUPLICATE_OUTCOME_ID' | 'TOO_MANY_OUTCOMES' | 'EMPTY_OUTCOME', message: string) {
    super(`${code}: ${message}`);
  }
}

export interface CourseProposal {
  subjectName?: string | null;
  generalObjective?: string | null;
  learnerProfile?: string | null;
  priorKnowledge?: string[] | null;
  outcomes: string[];
  competencies?: string[] | null;
}

function clean(s: unknown, max: number): string {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanList(v: unknown, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = clean(x, maxLen);
    if (t && !out.some((y) => y.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}
const inferred = <T>(value: T) => ({ status: 'inferred' as const, value, sources: [], basis: PROPOSAL_BASIS });

function outcomeOf(id: string, text: string, status: 'inferred' | 'provided'): LearningOutcome {
  const level = bloomLevelOf(text);
  return { id, text, level, domain: outcomeDomainOf(level), status, sources: [], ...(status === 'inferred' ? { basis: PROPOSAL_BASIS } : {}) };
}

/** ¿El contexto viene de un documento? (un contexto propuesto o escrito a mano no tiene documentos). */
export function hasDocuments(ctx: AcademicContextV1 | null | undefined): boolean {
  return !!ctx && Array.isArray(ctx.documents) && ctx.documents.length > 0;
}

/** ¿Un dato lo propuso Cursia desde el pedido (y nadie lo confirmó)? */
export function isProposed(x: { status: string; basis?: string } | null | undefined): boolean {
  return !!x && x.status === 'inferred' && x.basis === PROPOSAL_BASIS;
}

/**
 * ¿El contexto vigente se puede reemplazar por una propuesta nueva? Solo si está vacío o es una propuesta de Cursia
 * sin confirmar (review L82 I1): nunca un documento ni algo que el docente escribió o confirmó.
 */
export function isReplaceableByProposal(ctx: AcademicContextV1 | null | undefined): boolean {
  if (!ctx) return true;
  if (hasDocuments(ctx)) return false;
  const fields = [ctx.identity.subjectName, ctx.identity.program, ctx.identity.educationLevel, ctx.identity.generalObjective, ctx.identity.description, ctx.learner.profile, ctx.learner.priorKnowledge];
  if (fields.some((f) => f.status !== 'missing' && !isProposed(f))) return false;
  return [...ctx.outcomes, ...ctx.competencies].every((x) => isProposed(x)) && ctx.units.length === 0 && ctx.evaluation.length === 0;
}

/**
 * Contexto académico propuesto por Cursia (sin documentos). Lanza DOCUMENT_CONTEXT si el vigente viene de un documento
 * y USER_CONTEXT si tiene datos que escribió o confirmó el docente.
 */
export function buildProposedContext(current: AcademicContextV1 | null, p: CourseProposal): AcademicContextV1 {
  if (hasDocuments(current)) throw new ProposedContextError('DOCUMENT_CONTEXT', 'el curso ya tiene un contexto académico leído de un documento; el documento manda.');
  if (!isReplaceableByProposal(current)) throw new ProposedContextError('USER_CONTEXT', 'el contexto académico tiene datos que escribiste o confirmaste; Cursia no los reemplaza.');
  const outcomes = cleanList(p.outcomes, PROPOSAL_LIMITS.outcomes, ACADEMIC_LIMITS.outcomeText);
  if (!outcomes.length) throw new ProposedContextError('NO_OUTCOMES', 'la propuesta no trae resultados de aprendizaje.');
  const ctx = emptyAcademicContext();
  const subject = clean(p.subjectName, ACADEMIC_LIMITS.title);
  const objective = clean(p.generalObjective, ACADEMIC_LIMITS.text);
  const profile = clean(p.learnerProfile, ACADEMIC_LIMITS.text);
  const prior = cleanList(p.priorKnowledge, PROPOSAL_LIMITS.priorKnowledge, ACADEMIC_LIMITS.text);
  if (subject) ctx.identity.subjectName = inferred(subject);
  if (objective) ctx.identity.generalObjective = inferred(objective);
  if (profile) ctx.learner.profile = inferred(profile);
  if (prior.length) ctx.learner.priorKnowledge = inferred(prior);
  ctx.outcomes = outcomes.map((t, i) => outcomeOf(`RA${i + 1}`, t, 'inferred'));
  ctx.competencies = cleanList(p.competencies, PROPOSAL_LIMITS.competencies, ACADEMIC_LIMITS.outcomeText)
    .map((t, i): Competency => ({ id: `CO${i + 1}`, text: t, status: 'inferred', sources: [], basis: PROPOSAL_BASIS }));
  return ctx;
}

export interface OutcomeEdit { id?: string | null; text: string }

const sameText = (a: string, b: string) => clean(a, 10000).toLowerCase() === clean(b, 10000).toLowerCase();

/**
 * Lista de resultados corregida por el docente sobre el contexto vigente (o uno vacío). Conserva ids y orígenes de lo
 * que no cambió; lo editado o nuevo queda `provided`. Quita de unidades, contenidos y evaluaciones los vínculos a
 * resultados eliminados (los de los capítulos los poda el guardado del perfil).
 */
export function rewriteOutcomes(current: AcademicContextV1 | null, edits: OutcomeEdit[], accept = false): AcademicContextV1 {
  const base: AcademicContextV1 = current ? JSON.parse(JSON.stringify(current)) : emptyAcademicContext();
  const list = (Array.isArray(edits) ? edits : []).map((e) => ({ id: e && e.id ? String(e.id) : null, text: clean(e && e.text, ACADEMIC_LIMITS.outcomeText) }));
  if (list.some((e) => !e.text)) throw new ProposedContextError('EMPTY_OUTCOME', 'un resultado de aprendizaje no puede quedar vacío.');
  if (!list.length) throw new ProposedContextError('NO_OUTCOMES', 'el curso necesita al menos un resultado de aprendizaje.');
  if (list.length > ACADEMIC_LIMITS.outcomes) throw new ProposedContextError('TOO_MANY_OUTCOMES', `como máximo ${ACADEMIC_LIMITS.outcomes} resultados.`);
  const byId = new Map(base.outcomes.map((o) => [o.id, o]));
  const seen = new Set<string>();
  for (const e of list) {
    if (!e.id || !byId.has(e.id)) continue;
    if (seen.has(e.id)) throw new ProposedContextError('DUPLICATE_OUTCOME_ID', `el resultado ${e.id} aparece dos veces.`);
    seen.add(e.id);
  }
  let next = base.outcomes.reduce((m, o) => Math.max(m, Number(o.id.slice(2)) || 0), 0);
  const outcomes: LearningOutcome[] = list.map((e) => {
    const prev = e.id ? byId.get(e.id) : undefined;
    if (prev && sameText(prev.text, e.text)) {
      // Solo lo que propuso Cursia; un resultado inferido DEL DOCUMENTO conserva su cita (review L82 I2).
      if (accept && isProposed(prev)) return outcomeOf(prev.id, prev.text, 'provided');
      return prev;
    }
    return outcomeOf(prev ? prev.id : `RA${++next}`, e.text, 'provided');
  });
  const keep = new Set(outcomes.map((o) => o.id));
  const live = (ids: string[]) => ids.filter((id) => !/^RA/.test(id) || keep.has(id));
  base.outcomes = outcomes;
  base.units = base.units.map((u) => ({ ...u, outcomeIds: live(u.outcomeIds), contents: u.contents.map((c) => ({ ...c, outcomeIds: live(c.outcomeIds) })) }));
  base.evaluation = base.evaluation.map((ev) => ({ ...ev, outcomeIds: live(ev.outcomeIds) }));
  if (accept) {
    // Confirmar la propuesta: lo demás que propuso Cursia (nombre, estudiante, competencias) también queda confirmado.
    const confirm = <T>(f: { status: string; value: T | null; sources: unknown[]; basis?: string }) =>
      f.status === 'inferred' && f.basis === PROPOSAL_BASIS ? { status: 'provided' as const, value: f.value, sources: [] } : f;
    base.identity.subjectName = confirm(base.identity.subjectName) as any;
    base.identity.generalObjective = confirm(base.identity.generalObjective) as any;
    base.learner.profile = confirm(base.learner.profile) as any;
    base.learner.priorKnowledge = confirm(base.learner.priorKnowledge) as any;
    base.competencies = base.competencies.map((c) => (c.status === 'inferred' && c.basis === PROPOSAL_BASIS ? { id: c.id, text: c.text, status: 'provided' as const, sources: [] } : c));
  }
  return base;
}
