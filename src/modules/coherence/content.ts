import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr } from './canonical-json';
import {
  COHERENCE_THRESHOLDS as T,
  CoherenceFindingDraft,
  ContextSummaryInput,
  CoursePlanInput,
  Outline,
  OutlineChapter,
  buildOutline,
} from './coherence-types';
import { jaccard, norm, normTokens, round4, tokenJaccard } from './normalize';

/**
 * Fase 7 — capa de contenido (post-generación). Reglas C1–C7 sobre
 * Blueprint + `course_plan` (planeado, opcional) + sidecars `context_summary`
 * reales por `chapterId` (opcional). Función pura, sin red ni DB, nunca
 * modifica contenido.
 *
 * Identidad de un concepto: su forma normalizada (`norm`). La etiqueta
 * visible es la variante original lexicográficamente menor (estable ante
 * reordenamientos de la entrada).
 *
 * Base por capítulo para C1–C3 ("planeado o real"): el sidecar real si
 * existe, si no la entrada del plan. C4, C5 y C7 usan solo lo real; C6
 * compara real con planeado.
 */
export interface ContentCoherenceInput {
  blueprint: BlueprintSnapshotV1;
  coursePlan?: CoursePlanInput | null;
  /** chapterId → context_summary real. Claves que no están en el Blueprint se ignoran. */
  contextSummaries?: Record<string, ContextSummaryInput> | null;
  /** Conceptos del "contexto previo declarado" del curso (C3 no los reporta). */
  declaredPriorConcepts?: string[] | null;
}

interface ConceptSet {
  keys: Set<string>;
  labels: Map<string, string>;
}

type Basis = 'real' | 'plan';

export function normalizePlanChapters(plan: CoursePlanInput | null | undefined): Map<string, ContextSummaryInput> {
  const out = new Map<string, ContextSummaryInput>();
  if (!plan || !plan.chapters) return out;
  if (Array.isArray(plan.chapters)) {
    for (const c of plan.chapters) if (c && typeof c.chapterId === 'string') out.set(c.chapterId, c);
  } else {
    for (const [id, c] of Object.entries(plan.chapters)) if (c) out.set(id, c);
  }
  return out;
}

function conceptSet(list: string[] | null | undefined): ConceptSet {
  const keys = new Set<string>();
  const labels = new Map<string, string>();
  for (const raw of list ?? []) {
    if (typeof raw !== 'string') continue;
    const k = norm(raw);
    if (!k) continue;
    keys.add(k);
    const prev = labels.get(k);
    const lab = raw.trim();
    if (prev === undefined || cmpStr(lab, prev) < 0) labels.set(k, lab);
  }
  return { keys, labels };
}

function sortedKeys(s: ConceptSet): string[] {
  return [...s.keys].sort(cmpStr);
}

export function runContentRules(input: ContentCoherenceInput): CoherenceFindingDraft[] {
  const outline: Outline = buildOutline(input.blueprint);
  const planMap = normalizePlanChapters(input.coursePlan);
  const real = new Map<string, ContextSummaryInput>();
  for (const [id, s] of Object.entries(input.contextSummaries ?? {})) if (s) real.set(id, s);

  const labelOf = new Map<string, string>();
  const rememberLabels = (cs: ConceptSet) => {
    for (const [k, l] of cs.labels) {
      const prev = labelOf.get(k);
      if (prev === undefined || cmpStr(l, prev) < 0) labelOf.set(k, l);
    }
  };
  const label = (k: string) => labelOf.get(k) ?? k;

  // Base efectiva por capítulo (real > plan).
  const eff = new Map<string, { basis: Basis; intro: ConceptSet; assumed: ConceptSet }>();
  for (const ch of outline.chapters) {
    const r = real.get(ch.id);
    const p = planMap.get(ch.id);
    const src = r ?? p;
    if (!src) continue;
    const intro = conceptSet(src.concepts_introduced);
    const assumed = conceptSet(src.concepts_assumed);
    rememberLabels(intro);
    rememberLabels(assumed);
    eff.set(ch.id, { basis: r ? 'real' : 'plan', intro, assumed });
  }

  const out: CoherenceFindingDraft[] = [];
  const modOf = (chId: string) => outline.chapterById.get(chId)!.moduleId;
  const chTitle = (chId: string) => outline.chapterById.get(chId)!.title;
  const uniqModulesInCourseOrder = (chIds: string[]) => {
    const set = new Set(chIds.map(modOf));
    return outline.modules.filter((m) => set.has(m.id)).map((m) => m.id);
  };

  // Índice de introducciones: concepto → capítulos (orden de curso).
  const introducedIn = new Map<string, OutlineChapter[]>();
  for (const ch of outline.chapters) {
    const e = eff.get(ch.id);
    if (!e) continue;
    for (const k of sortedKeys(e.intro)) {
      const list = introducedIn.get(k) ?? [];
      list.push(ch);
      introducedIn.set(k, list);
    }
  }

  // C1 — concepto introducido en más de un capítulo.
  for (const k of [...introducedIn.keys()].sort(cmpStr)) {
    const list = introducedIn.get(k)!;
    if (list.length < 2) continue;
    const chapterIds = list.map((c) => c.id);
    const basis: Record<string, Basis> = {};
    for (const id of chapterIds) basis[id] = eff.get(id)!.basis;
    out.push({
      rule: 'C1',
      severity: 'warning',
      moduleIds: uniqModulesInCourseOrder(chapterIds),
      chapterIds,
      evidence: { concept: k, chapterIds, basis },
      message: `El concepto "${label(k)}" se introduce en ${chapterIds.length} capítulos: ${chapterIds.map(chTitle).join(', ')}.`,
      suggestion: 'Dejá la introducción en un solo capítulo y que los demás lo retomen como concepto asumido.',
      suggestedAction: 'review',
    });
  }

  // C2 / C3 — conceptos asumidos.
  const prior = new Set<string>();
  for (const raw of input.declaredPriorConcepts ?? []) {
    const k = norm(String(raw ?? ''));
    if (k) prior.add(k);
  }
  for (const ch of outline.chapters) {
    const e = eff.get(ch.id);
    if (!e) continue;
    for (const k of sortedKeys(e.assumed)) {
      const intros = introducedIn.get(k);
      if (intros && intros.length > 0) {
        const first = intros[0];
        if (first.index > ch.index) {
          out.push({
            rule: 'C2',
            severity: 'warning',
            moduleIds: uniqModulesInCourseOrder([ch.id, first.id]),
            chapterIds: [ch.id, first.id],
            evidence: { concept: k, assumedInChapterId: ch.id, introducedInChapterId: first.id },
            message: `"${ch.title}" asume "${label(k)}", que recién se introduce después, en "${first.title}".`,
            suggestion: 'Reordená los capítulos o introducí el concepto antes de que se use.',
            suggestedAction: 'review',
          });
        }
      } else if (!prior.has(k)) {
        out.push({
          rule: 'C3',
          severity: 'info',
          moduleIds: [ch.moduleId],
          chapterIds: [ch.id],
          evidence: { concept: k, chapterId: ch.id },
          message: `"${ch.title}" asume "${label(k)}", que no se introduce en ningún capítulo ni en el contexto previo declarado.`,
          suggestion: 'Declaralo como conocimiento previo del curso o agregá su introducción en un capítulo anterior.',
          suggestedAction: 'review',
        });
      }
    }
  }

  // Sets reales por capítulo (C4–C7).
  const realIntro = new Map<string, ConceptSet>();
  const realTerms = new Map<string, ConceptSet>();
  for (const ch of outline.chapters) {
    const r = real.get(ch.id);
    if (!r) continue;
    const intro = conceptSet(r.concepts_introduced);
    const terms = conceptSet(r.key_terms);
    rememberLabels(intro);
    rememberLabels(terms);
    realIntro.set(ch.id, intro);
    realTerms.set(ch.id, terms);
  }

  // C4 — objetivo del capítulo con cobertura baja por sus concepts_introduced reales.
  for (const ch of outline.chapters) {
    const intro = realIntro.get(ch.id);
    if (!intro || !ch.objective) continue;
    const objTokens = new Set(normTokens(ch.objective));
    if (objTokens.size === 0) continue;
    const covered = new Set<string>();
    for (const k of intro.keys) for (const t of k.split(' ')) covered.add(t);
    const uncovered = [...objTokens].filter((t) => !covered.has(t)).sort(cmpStr);
    const coverage = (objTokens.size - uncovered.length) / objTokens.size;
    if (coverage < T.C4_MIN_OBJECTIVE_COVERAGE) {
      out.push({
        rule: 'C4',
        severity: 'warning',
        moduleIds: [ch.moduleId],
        chapterIds: [ch.id],
        evidence: { chapterId: ch.id, uncoveredTokens: uncovered, coverage: round4(coverage) },
        message: `Los conceptos que introduce "${ch.title}" cubren poco su objetivo.`,
        suggestion: 'Revisá si el capítulo cumple su objetivo; si no, regeneralo o ajustá el objetivo.',
        suggestedAction: 'regenerate_chapter',
      });
    }
  }

  // C5 — explicaciones repetidas (key_terms reales parecidos).
  const withTerms = outline.chapters.filter((c) => (realTerms.get(c.id)?.keys.size ?? 0) > 0);
  for (let i = 0; i < withTerms.length; i++) {
    for (let j = i + 1; j < withTerms.length; j++) {
      const a = withTerms[i];
      const b = withTerms[j];
      const ta = realTerms.get(a.id)!;
      const tb = realTerms.get(b.id)!;
      const jac = jaccard(ta.keys, tb.keys);
      if (jac >= T.C5_KEY_TERMS_JACCARD_MIN) {
        const shared = sortedKeys(ta).filter((k) => tb.keys.has(k));
        out.push({
          rule: 'C5',
          severity: 'info',
          moduleIds: uniqModulesInCourseOrder([a.id, b.id]),
          chapterIds: [a.id, b.id],
          evidence: { chapterIds: [a.id, b.id], sharedKeyTerms: shared, jaccard: round4(jac) },
          message: `"${a.title}" y "${b.title}" comparten la mayoría de sus términos clave; puede haber explicaciones repetidas.`,
          suggestion: 'Revisá si ambos capítulos explican lo mismo y diferenciá sus enfoques.',
          suggestedAction: 'review',
        });
      }
    }
  }

  // C6 — desvío entre plan y real.
  for (const ch of outline.chapters) {
    const r = realIntro.get(ch.id);
    const p = planMap.get(ch.id);
    if (!r || !p) continue;
    const planned = conceptSet(p.concepts_introduced);
    rememberLabels(planned);
    if (planned.keys.size === 0) continue;
    const realKeys = sortedKeys(r);
    const plannedKeys = sortedKeys(planned);
    const matched = plannedKeys.filter((pk) =>
      realKeys.some((rk) => rk === pk || tokenJaccard(rk, pk) >= T.C6_CONCEPT_MATCH_TOKEN_JACCARD),
    );
    const overlap = matched.length / plannedKeys.length;
    if (overlap < T.C6_MIN_PLAN_OVERLAP) {
      out.push({
        rule: 'C6',
        severity: 'warning',
        moduleIds: [ch.moduleId],
        chapterIds: [ch.id],
        evidence: { chapterId: ch.id, planned: plannedKeys, real: realKeys, matched, overlap: round4(overlap) },
        message: `"${ch.title}" se desvió del plan: introduce conceptos distintos a los planeados.`,
        suggestion: 'Revisá el capítulo contra el plan del curso; regeneralo si el desvío afecta a otros capítulos.',
        suggestedAction: 'review',
      });
    }
  }

  // C7 — el mismo key_term es central (introducido) en capítulos de módulos distintos.
  const centralIn = new Map<string, string[]>();
  for (const ch of outline.chapters) {
    const terms = realTerms.get(ch.id);
    const intro = realIntro.get(ch.id);
    if (!terms || !intro) continue;
    for (const k of sortedKeys(terms)) {
      if (!intro.keys.has(k)) continue;
      const list = centralIn.get(k) ?? [];
      list.push(ch.id);
      centralIn.set(k, list);
    }
  }
  for (const k of [...centralIn.keys()].sort(cmpStr)) {
    const chapterIds = centralIn.get(k)!;
    const moduleIds = uniqModulesInCourseOrder(chapterIds);
    if (moduleIds.length < 2) continue;
    out.push({
      rule: 'C7',
      severity: 'info',
      moduleIds,
      chapterIds,
      evidence: { term: k, moduleIds, chapterIds },
      message: `El término "${label(k)}" es central en capítulos de ${moduleIds.length} módulos distintos.`,
      suggestion: 'Unificá dónde se define el término y que los otros módulos lo referencien.',
      suggestedAction: 'review',
    });
  }

  return out;
}
