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
  /** r71: resultados del hallazgo crítico (alineación). */
  outcomeIds?: string[];
  /**
   * r71 · Acción en línea (sin ir a otra pantalla): vincular el resultado al capítulo que propone Cursia (el docente puede
   * elegir otro), o completar un dato del curso con la sugerencia de Cursia.
   */
  inline?: { kind: 'link_outcome'; outcomeId: string; chapterId: string | null; chapterTitle: string | null };
  /** r71: datos del curso que faltan (context_incomplete), con la sugerencia de Cursia si la hay y si se completan aquí. */
  fields?: { key: string; label: string; editable: boolean; suggestion: string | null }[];
}

/** Nombre, para el docente, de cada dato del curso que pide la propuesta (nunca la clave interna). */
const CONTEXT_FIELD_LABEL: Record<string, string> = {
  nombre: 'el nombre del curso', sector: 'el sector', pais: 'el país', ciudad: 'la ciudad', contexto: 'el contexto educativo',
  nivel: 'el conocimiento previo del estudiante', tono: 'el tono del contenido', obj: 'el objetivo', comp: 'las competencias',
};

/** r71: datos que se completan en línea en la propuesta (los demás tienen su control en «Lo que entendimos»). */
const INLINE_CONTEXT_FIELDS = ['sector', 'pais', 'ciudad', 'tono'];
const CONTEXT_FIELD_INPUT_LABEL: Record<string, string> = { nombre: 'Nombre del curso', sector: 'Sector', pais: 'País', ciudad: 'Ciudad', contexto: 'Contexto educativo', nivel: 'Conocimiento previo', tono: 'Tono del contenido' };

export interface PrebriefReadiness {
  ready: boolean;
  blockers: PrebriefBlocker[];
  /** r71: correcciones confiables que Cursia todavía no aplicó (la interfaz las aplica sola y vuelve a verificar). */
  autofixPending?: number;
  /** r71: capítulos de contenido para elegir otro destino en «Vincular a…». */
  chapters?: { id: string; title: string; moduleTitle: string }[];
}

/**
 * r71 · Cada bloqueo que Cursia no resuelve sola trae su acción en línea (nunca un callejón sin salida): el resultado sin
 * capítulo, «Vincular a <capítulo que propone Cursia>»; el dato que falta, su campo con la sugerencia de Cursia.
 */
export function withInlineActions(r: PrebriefReadiness, autofix: { pending: number; suggestions: Record<string, { chapterId: string; chapterTitle: string } | null>; chapters: { id: string; title: string; moduleTitle: string }[]; contextSuggestions: { sector: string | null } } | null | undefined): PrebriefReadiness {
  if (!autofix) return r;
  const blockers = r.blockers.map((b) => {
    if (b.code === 'critical' && b.outcomeIds && b.outcomeIds.length === 1 && /^alignment:/.test(String(b.ref || ''))) {
      const sug = autofix.suggestions[b.outcomeIds[0]];
      return { ...b, inline: { kind: 'link_outcome' as const, outcomeId: b.outcomeIds[0], chapterId: sug ? sug.chapterId : null, chapterTitle: sug ? sug.chapterTitle : null } };
    }
    if (b.code === 'context_incomplete' && b.fields) {
      return { ...b, fields: b.fields.map((f) => ({ ...f, suggestion: f.key === 'sector' ? autofix.contextSuggestions.sector : f.suggestion })) };
    }
    return b;
  });
  return { ...r, blockers, autofixPending: autofix.pending, chapters: autofix.chapters };
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
    if (c.severity === 'critical' && !c.summary) b.push({ code: 'critical', title: String(c.title), detail: c.detail ? String(c.detail) : undefined, where: 'design', ref: String(c.id), ...(Array.isArray(c.outcomeIds) && c.outcomeIds.length ? { outcomeIds: c.outcomeIds.map(String) } : {}) });
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
    if (e.capability && e.requirementKey === 'guided_practice_share@course') {
      // Loop 9 B (fix round 2 · a): proporción de ejercicios guiados > 30 %: la institución la acepta de forma explícita.
      b.push({ code: 'exception_reason', capability: true, title: `${e.requirementText}. Supera el 30 %: para continuar, la institución debe aceptar esa proporción.`,
        detail: `Los ejercicios guiados (formativos, sin nota) completan las horas porque el documento fija la estructura o las Actividades de Aplicación: ${e.appliedText.replace(/^los ejercicios guiados suman /, '')}.`, where: 'reason', ref: e.requirementKey,
        ...(e.proposal ? { proposal: e.proposal } : {}),
        suggestion: `Se acepta que ${e.appliedText.replace(/^los ejercicios guiados suman /, '')} del curso sean ejercicios guiados formativos (sin nota), con respuesta modelo, para completar las horas que pide el documento.` });
      continue;
    }
    if (e.capability) {
      // LOOP 9.2 (capacidades): requisito no cubierto → solo se continúa si la institución acepta la diferencia.
      b.push({ code: 'exception_reason', capability: true, title: `Requisito no cubierto: ${e.requirementText}${covered.length ? ` (también ${covered.join(' y ')})` : ''}. Para continuar, la institución debe aceptar la diferencia.`,
        detail: `El microcurrículo solicita ${e.requirementText}. Actualmente, ${e.appliedText}.`, where: 'reason', ref: e.requirementKey,
        ...(e.proposal ? { proposal: e.proposal } : {}),
        // Horas: la propuesta explica y ofrece una alternativa; aceptarla aquí = declarar la carga real (texto corto, cabe en el motivo).
        suggestion: e.proposal && /^target_hours@/.test(e.requirementKey)
          ? `Se acepta declarar la carga real que estima Cursia para ${e.requirementText}: ${e.appliedText}.${/Alternativa con lo que Cursia ya produce/.test(e.proposal) ? ' La institución no agrega las Actividades de Aplicación adicionales que propone Cursia como alternativa.' : ''}`
          : e.proposal
          ? `Se acepta la alternativa que propone Cursia para ${e.requirementText}${covered.length ? ` (${covered.join(' y ')})` : ''}: ${e.proposal.replace(/^Proponemos /, '').replace(/\s*No reemplaza al segundo video: la institución decide si lo acepta\.$/, '')}`
          : `Se acepta la propuesta de Cursia: ${e.appliedText.replace(/^Cursia (contempla|produce|diseña) /, '')}, en lugar de lo solicitado en el documento: ${e.requirementText}${covered.length ? ` (${covered.join(' y ')})` : ''}.` });
    } else b.push({ code: 'exception_reason', title: `Falta el motivo de la excepción: ${e.requirementText}${covered.length ? ` (el mismo motivo cubre también ${covered.join(' y ')})` : ''}.`,
      detail: `El documento pide ${e.requirementText}; el diseño tiene ${e.appliedText}.`, where: 'reason', ref: e.requirementKey });
  }
  const missing = missingContextFields(model);
  if (missing.length) b.push({ code: 'context_incomplete', title: `Faltan datos del curso: ${missing.map((k) => CONTEXT_FIELD_LABEL[k] || k).join(', ')}.`, where: 'understood',
    fields: missing.map((k) => ({ key: k, label: CONTEXT_FIELD_INPUT_LABEL[k] || k, editable: INLINE_CONTEXT_FIELDS.includes(k), suggestion: null })) });
  for (const f of languageFindings.slice(0, 5)) b.push({ code: 'language', title: `Texto que no está en español neutro: ${f}`, where: 'understood' });
  return { ready: b.length === 0, blockers: b };
}
