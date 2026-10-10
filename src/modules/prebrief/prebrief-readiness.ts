import type { PrebriefModel } from './prebrief-model';
import { missingContextFields } from './prebrief-model';
import { DOUBT_KIND_TEXT, DOUBT_REASON_TEXT, DoubtfulItem } from './plausibility';

/**
 * Prebrief pedagógico · ¿Se puede preparar para aprobación? (puro). La propuesta que se aprueba YA pasó la
 * verificación: con cualquier bloqueo, el servidor no prepara la versión (409 PREBRIEF_NOT_READY con esta lista) y la
 * interfaz dice qué resolver y dónde.
 */

export type BlockerCode =
  | 'design_unavailable'
  | 'design_not_applicable'
  | 'critical'
  | 'pending_changes'
  | 'design_not_saved'
  | 'doubtful_data'
  | 'exception_reason'
  | 'context_incomplete'
  | 'no_outcomes'
  | 'no_structure'
  | 'language';

export interface PrebriefBlocker {
  code: BlockerCode;
  title: string;
  detail?: string;
  /** Dónde se resuelve: diseño, «Lo que entendimos», motivo de excepción, confirmación de un dato. */
  where: 'design' | 'understood' | 'reason' | 'confirm';
  /** requirementKey (motivo) / confirmKey (confirmación) / id del check crítico. */
  ref?: string;
  /** Texto del dato dudoso (para mostrarlo al confirmar). */
  text?: string;
  /** LOOP 9.2 (capacidades): requisito que Cursia no cubre; se resuelve con la aceptación de la institución. */
  capability?: true;
  /** Texto sugerido para la aceptación (el docente lo revisa y lo guarda; nunca se guarda solo). */
  suggestion?: string;
  /** Alternativa que propone Cursia para el requisito no cubierto (con lo que ya produce). */
  proposal?: string;
}

/** Nombre, para el docente, de cada dato del curso que pide la propuesta (nunca la clave interna). */
const CONTEXT_FIELD_LABEL: Record<string, string> = {
  nombre: 'el nombre del curso', sector: 'el sector', pais: 'el país', ciudad: 'la ciudad', contexto: 'el contexto educativo',
  nivel: 'el conocimiento previo del estudiante', tono: 'el tono del contenido', obj: 'el objetivo', comp: 'las competencias',
};

export interface PrebriefReadiness {
  ready: boolean;
  blockers: PrebriefBlocker[];
}

export function prebriefReadiness(model: PrebriefModel, card: any, doubts: DoubtfulItem[], languageFindings: string[]): PrebriefReadiness {
  const b: PrebriefBlocker[] = [];
  const design = card && card.design;
  const v = card && card.verification;
  if (!design || !v) {
    b.push({ code: 'design_unavailable', title: 'Cursia todavía no tiene un diseño verificado para este curso.', where: 'design' });
    return { ready: false, blockers: b };
  }
  if (!model.structure.totals.chapters) b.push({ code: 'no_structure', title: 'El curso todavía no tiene módulos ni capítulos.', where: 'design' });
  if (design.applicable !== true) b.push({ code: 'design_not_applicable', title: 'El diseño no se puede preparar así: revísalo en «Diseño».', where: 'design' });
  for (const c of (v.checks || []) as any[]) {
    if (c.severity === 'critical' && !c.summary) b.push({ code: 'critical', title: String(c.title), detail: c.detail ? String(c.detail) : undefined, where: 'design', ref: String(c.id) });
  }
  const proposed = (design.modules || []).reduce((n: number, m: any) => n + (m.chapters || []).filter((c: any) => c.proposed).length, 0);
  const pending = Math.max((design.changes || []).length, proposed);
  if (pending > 0) b.push({ code: 'pending_changes', title: `Hay ${pending === 1 ? 'un cambio recomendado' : `${pending} cambios recomendados`} sin aplicar: usa «Usar este diseño» en «Diseño».`, where: 'design' });
  else if (card.profileChanged === true) b.push({ code: 'design_not_saved', title: 'El diseño que propone Cursia no está guardado: usa «Usar este diseño» en «Diseño».', where: 'design' });
  if (!model.goals.outcomes.length) b.push({ code: 'no_outcomes', title: 'El curso no tiene resultados de aprendizaje: agrégalos en «Lo que entendimos».', where: 'understood' });
  for (const d of doubts) {
    b.push({ code: 'doubtful_data', title: `${DOUBT_KIND_TEXT[d.kind]} por confirmar: ${DOUBT_REASON_TEXT[d.reason]}.`, where: 'confirm', ref: d.confirmKey, text: d.text, detail: d.id });
  }
  // LOOP 9.2 (QA): una excepción cubierta por otra de la misma limitación (p. ej. «8 videos» por «2 videos por capítulo»)
  // no pide su propio motivo: el de la que la cubre vale para las dos (antes la propuesta mostraba dos campos).
  const keys = new Set(model.exceptions.map((e) => e.requirementKey));
  for (const e of model.exceptions) {
    if (e.reason || (e.coveredBy && keys.has(e.coveredBy))) continue;
    const covered = model.exceptions.filter((o) => o.coveredBy === e.requirementKey).map((o) => `«${o.requirementText}»`);
    if (e.capability) {
      // LOOP 9.2 (capacidades): requisito no cubierto → solo se continúa si la institución acepta la diferencia.
      b.push({ code: 'exception_reason', capability: true, title: `Requisito no cubierto: ${e.requirementText}${covered.length ? ` (también ${covered.join(' y ')})` : ''}. Para continuar, la institución debe aceptar la diferencia.`,
        detail: `El microcurrículo solicita ${e.requirementText}. Actualmente, ${e.appliedText.replace(/^Cursia /, 'Cursia ')}.`, where: 'reason', ref: e.requirementKey,
        ...(e.proposal ? { proposal: e.proposal } : {}),
        suggestion: e.proposal
          ? `Se acepta la alternativa que propone Cursia para ${e.requirementText}${covered.length ? ` (${covered.join(' y ')})` : ''}: ${e.proposal.replace(/^Proponemos /, '').replace(/\s*No reemplaza al segundo video: la institución decide si lo acepta\.$/, '')}`
          : `Se acepta la propuesta de Cursia: ${e.appliedText.replace(/^Cursia (contempla|produce|diseña) /, '')}, en lugar de lo solicitado en el documento: ${e.requirementText}${covered.length ? ` (${covered.join(' y ')})` : ''}.` });
    } else b.push({ code: 'exception_reason', title: `Falta el motivo de la excepción: ${e.requirementText}${covered.length ? ` (el mismo motivo cubre también ${covered.join(' y ')})` : ''}.`,
      detail: `El documento pide ${e.requirementText}; el diseño tiene ${e.appliedText}.`, where: 'reason', ref: e.requirementKey });
  }
  const missing = missingContextFields(model);
  if (missing.length) b.push({ code: 'context_incomplete', title: `Faltan datos del curso: ${missing.map((k) => CONTEXT_FIELD_LABEL[k] || k).join(', ')}.`, where: 'understood' });
  for (const f of languageFindings.slice(0, 5)) b.push({ code: 'language', title: `Texto que no está en español neutro: ${f}`, where: 'understood' });
  return { ready: b.length === 0, blockers: b };
}
