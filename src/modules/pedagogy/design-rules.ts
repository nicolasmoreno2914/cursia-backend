import { ApproachVote, PedagogicalApproachDefinition, PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import {
  PedagogicalProfile,
  isEmptyPedagogicalProfile,
  normalizePedagogicalProfile,
  pedagogicalProfileSha256,
} from './pedagogy-profile';
import {
  ChapterRole,
  ENUM_TARGETS,
  EnumTarget,
  LIST_TARGETS,
  ListTarget,
  PEDAGOGICAL_DIMENSIONS,
  PEDAGOGY_ENGINE_VERSION,
  PedagogicalDimension,
  PedagogicalDimensions,
  SectionKind,
  clamp01,
  round2,
} from './vocabulary';

/**
 * Motor pedagógico V1 — Perfil → Reglas de diseño.
 *
 * Algoritmo (independiente de qué enfoques existan):
 *  1. Pesos: principal 0,6 y secundarios 0,4 repartido en partes iguales (sin
 *     secundarios, el principal pesa 1).
 *  2. Dimensiones = mezcla ponderada de las dimensiones de cada enfoque, más
 *     ajustes por el perfil del estudiante y por las respuestas (P3–P5).
 *  3. Metas de elección única: voto ponderado (peso del enfoque × peso del
 *     voto); empate → el voto del enfoque con más peso; luego, orden del
 *     vocabulario. Los votos perdedores quedan en la traza como `overridden`.
 *  4. Metas de lista: Borda ponderado.
 *  5. Secuencia del capítulo: la del principal + los pasos firma de cada
 *     secundario (al inicio o al final).
 *  6. Votos por rol (primer/último capítulo del módulo) con el mismo voto ponderado.
 *  7. Derivados: profundidad, nivel de interacción, escenarios ramificados,
 *     pesos de evaluación sugeridos.
 * Pura y determinística: mismo perfil + mismo registro ⇒ mismas reglas.
 */

export interface AppliedRule {
  ruleId: string;
  approach: string | null; // null = regla del perfil (estudiante / respuestas)
  target: string;
  value: string;
  weight: number;
  outcome: 'applied' | 'overridden' | 'adjustment';
  rationale: string;
}

export type ContentDepth = 'introductory' | 'standard' | 'advanced';
export type InteractionLevel = 'high' | 'medium' | 'low';

export interface DesignRules {
  engineVersion: number;
  profileSha256: string;
  approaches: { id: string; role: 'primary' | 'secondary'; weight: number }[];
  dimensions: PedagogicalDimensions;
  targets: Record<EnumTarget, string>;
  roleTargets: Partial<Record<ChapterRole, Partial<Record<EnumTarget, string>>>>;
  lists: Record<ListTarget, string[]>;
  sequence: SectionKind[];
  objectiveVerbs: string[];
  contentDepth: ContentDepth;
  interactionLevel: InteractionLevel;
  scenarioBranching: boolean;
  suggestedWeights: { practice: number; moduleExams: number; finalExam: number };
  principles: string[];
  applied: AppliedRule[];
}

const PRIMARY_WEIGHT_WITH_SECONDARIES = 0.6;

function approachWeights(profile: PedagogicalProfile): { id: string; role: 'primary' | 'secondary'; weight: number }[] {
  const secs = profile.secondaryApproaches;
  if (secs.length === 0) return [{ id: profile.primaryApproach as string, role: 'primary', weight: 1 }];
  const each = round2((1 - PRIMARY_WEIGHT_WITH_SECONDARIES) / secs.length);
  return [
    { id: profile.primaryApproach as string, role: 'primary', weight: PRIMARY_WEIGHT_WITH_SECONDARIES },
    ...secs.map((id) => ({ id, role: 'secondary' as const, weight: each })),
  ];
}

interface ProfileAdjustment {
  ruleId: string;
  when: (p: PedagogicalProfile) => boolean;
  dims: Partial<Record<PedagogicalDimension, number>>;
  rationale: string;
  /** Recursos que la respuesta agrega (si el enfoque no los trae). */
  resources?: string[];
}

/**
 * Ajustes por el estudiante y por las respuestas: hablan del PERFIL, no de un
 * enfoque, por eso viven en el motor (valen igual para cualquier enfoque).
 */
const PROFILE_ADJUSTMENTS: readonly ProfileAdjustment[] = [
  { ruleId: 'learner.novice', when: (p) => p.learner.priorKnowledge === 'none', dims: { guidance: 0.15, priorKnowledge: 0.1, conceptualDepth: -0.1 }, rationale: 'Sin conocimientos previos: más guía y más anclaje en lo conocido.' },
  { ruleId: 'learner.advanced', when: (p) => p.learner.priorKnowledge === 'advanced', dims: { guidance: -0.15, selfRegulation: 0.1 }, rationale: 'Conocimientos avanzados: menos andamiaje y más autonomía.' },
  { ruleId: 'learner.experienced', when: (p) => p.learner.experience === 'extensive', dims: { authenticity: 0.1 }, rationale: 'Experiencia amplia: situaciones más cercanas a su práctica real.' },
  { ruleId: 'learner.children', when: (p) => p.learner.ageGroup === 'children', dims: { guidance: 0.2, selfRegulation: -0.2 }, rationale: 'Niños: guía explícita y menos autorregulación exigida.' },
  { ruleId: 'answer.mode.challenges', when: (p) => p.experienceTypes.includes('challenges'), dims: { problemFirst: 0.1 }, rationale: 'Pidieron una experiencia basada en retos.' },
  { ruleId: 'answer.exp.autonomous', when: (p) => p.experienceTypes.includes('autonomous'), dims: { guidance: -0.1, selfRegulation: 0.1 }, rationale: 'Pidieron una experiencia principalmente autónoma.' },
  { ruleId: 'answer.exp.guided', when: (p) => p.experienceTypes.includes('teacher_guided'), dims: { guidance: 0.1 }, rationale: 'Pidieron una experiencia guiada.' },
  { ruleId: 'answer.mode.collaborative', when: (p) => p.learningModes.includes('collaborative') || p.experienceTypes.includes('interactive_collaborative'), dims: { interactivity: 0.05 }, rationale: 'Pidieron aprendizaje colaborativo (se sugiere el foro del curso).' },
  { ruleId: 'answer.assess.reflection', when: (p) => p.assessmentMethods.includes('self_reflection'), dims: { reflection: 0.1 }, rationale: 'Quieren comprobar el aprendizaje con autoevaluación y reflexión.', resources: ['reflection_journal'] },
  { ruleId: 'answer.assess.evidence', when: (p) => p.assessmentMethods.includes('products_evidence'), dims: { evidence: 0.1 }, rationale: 'Quieren comprobar el aprendizaje con productos o evidencias.', resources: ['performance_rubric'] },
  { ruleId: 'answer.assess.cases', when: (p) => p.assessmentMethods.includes('cases'), dims: { authenticity: 0.05 }, rationale: 'Quieren comprobar el aprendizaje con casos.', resources: ['case_library'] },
];

/** Atajo para callers: `null` si el perfil está vacío (no hay pedagogía que aplicar). */
export function deriveDesignRulesOrNull(
  profile: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): DesignRules | null {
  if (isEmptyPedagogicalProfile(profile)) return null;
  return deriveDesignRules(profile, registry);
}

export function deriveDesignRules(
  profileIn: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): DesignRules {
  if (isEmptyPedagogicalProfile(profileIn)) {
    throw new Error('PEDAGOGY_PROFILE_EMPTY: el perfil no tiene enfoque principal (usar deriveDesignRulesOrNull)');
  }
  const profile = normalizePedagogicalProfile(profileIn, registry);
  const weights = approachWeights(profile);
  const defs: { def: PedagogicalApproachDefinition; weight: number; role: 'primary' | 'secondary' }[] = weights.map((w) => ({
    def: registry.get(w.id),
    weight: w.weight,
    role: w.role,
  }));
  const applied: AppliedRule[] = [];

  // 2. Dimensiones
  const dims = {} as PedagogicalDimensions;
  for (const d of PEDAGOGICAL_DIMENSIONS) dims[d] = defs.reduce((acc, x) => acc + x.weight * x.def.dimensions[d], 0);
  const extraResources: string[] = [];
  for (const adj of PROFILE_ADJUSTMENTS) {
    if (!adj.when(profile)) continue;
    for (const [d, delta] of Object.entries(adj.dims) as [PedagogicalDimension, number][]) dims[d] = dims[d] + delta;
    if (adj.resources) extraResources.push(...adj.resources);
    applied.push({
      ruleId: adj.ruleId, approach: null, target: 'dimensions', value: Object.entries(adj.dims).map(([d, v]) => `${d}${v > 0 ? '+' : ''}${v}`).join(','),
      weight: 1, outcome: 'adjustment', rationale: adj.rationale,
    });
  }
  for (const d of PEDAGOGICAL_DIMENSIONS) dims[d] = round2(clamp01(dims[d]));

  // 3. Metas de elección única
  const targets = {} as Record<EnumTarget, string>;
  for (const target of Object.keys(ENUM_TARGETS) as EnumTarget[]) {
    const votes = defs
      .filter((x) => x.def.votes[target])
      .map((x) => ({ approach: x.def.id, approachWeight: x.weight, vote: x.def.votes[target] as ApproachVote }));
    const winner = resolveVote(target, votes);
    targets[target] = winner;
    for (const v of votes) {
      applied.push({
        ruleId: v.vote.ruleId, approach: v.approach, target, value: v.vote.value, weight: round2(v.approachWeight * v.vote.weight),
        outcome: v.vote.value === winner ? 'applied' : 'overridden', rationale: v.vote.rationale,
      });
    }
  }
  // Un estudiante sin conocimientos previos o un niño necesita retroalimentación inmediata (regla de perfil).
  if ((profile.learner.priorKnowledge === 'none' || profile.learner.ageGroup === 'children') && targets['feedback.timing'] !== 'immediate') {
    targets['feedback.timing'] = 'immediate';
    applied.push({ ruleId: 'learner.immediate_feedback', approach: null, target: 'feedback.timing', value: 'immediate', weight: 1, outcome: 'adjustment', rationale: 'Estudiantes sin conocimientos previos (o niños): la retroalimentación es inmediata.' });
  }

  // 6. Votos por rol
  const roleTargets: DesignRules['roleTargets'] = {};
  for (const role of ['module_opening', 'core', 'module_closing', 'single'] as ChapterRole[]) {
    const byTarget = new Map<EnumTarget, { approach: string; approachWeight: number; vote: ApproachVote }[]>();
    for (const x of defs) {
      for (const [t, v] of Object.entries(x.def.roleOverrides?.[role] ?? {}) as [EnumTarget, ApproachVote][]) {
        const list = byTarget.get(t) ?? [];
        list.push({ approach: x.def.id, approachWeight: x.weight, vote: v });
        byTarget.set(t, list);
      }
    }
    if (byTarget.size === 0) continue;
    const out: Partial<Record<EnumTarget, string>> = {};
    for (const t of Object.keys(ENUM_TARGETS) as EnumTarget[]) {
      const roleVotes = byTarget.get(t);
      if (!roleVotes) continue;
      // El voto por rol compite con los votos generales de los enfoques que NO opinaron para ese rol.
      const general = defs
        .filter((x) => x.def.votes[t] && !roleVotes.some((r) => r.approach === x.def.id))
        .map((x) => ({ approach: x.def.id, approachWeight: x.weight, vote: x.def.votes[t] as ApproachVote }));
      const winner = resolveVote(t, [...roleVotes, ...general]);
      if (winner !== targets[t]) out[t] = winner;
      for (const v of roleVotes) {
        applied.push({
          ruleId: v.vote.ruleId, approach: v.approach, target: `${role}:${t}`, value: v.vote.value, weight: round2(v.approachWeight * v.vote.weight),
          outcome: v.vote.value === winner ? 'applied' : 'overridden', rationale: v.vote.rationale,
        });
      }
    }
    if (Object.keys(out).length > 0) roleTargets[role] = out;
  }

  // 4. Listas (Borda ponderado)
  const lists = {} as Record<ListTarget, string[]>;
  for (const target of Object.keys(LIST_TARGETS) as ListTarget[]) {
    const vocab = LIST_TARGETS[target] as readonly string[];
    const score = new Map<string, number>();
    for (const x of defs) {
      const l = x.def.lists[target];
      if (!l) continue;
      const n = l.items.length;
      l.items.forEach((item, i) => score.set(item, (score.get(item) ?? 0) + x.weight * l.weight * ((n - i) / n)));
      applied.push({ ruleId: l.ruleId, approach: x.def.id, target, value: l.items.join(','), weight: round2(x.weight * l.weight), outcome: 'applied', rationale: l.rationale });
    }
    const ranked = [...score.entries()]
      .sort((a, b) => b[1] - a[1] || vocab.indexOf(a[0]) - vocab.indexOf(b[0]))
      .map(([k]) => k);
    lists[target] = ranked;
  }
  for (const r of extraResources) if (!lists.resources.includes(r)) lists.resources.push(r);
  if (targets['reviewCards.policy'] === 'enable' && !lists.resources.includes('review_cards')) lists.resources.push('review_cards');

  // 5. Secuencia
  const sequence: SectionKind[] = [...defs[0].def.sequence];
  let startInserts = 0;
  for (const x of defs.slice(1)) {
    for (const s of x.def.signatureSteps) {
      if (sequence.includes(s.step)) continue;
      if (s.at === 'start') sequence.splice(startInserts++, 0, s.step);
      else sequence.push(s.step);
      applied.push({ ruleId: `${x.def.id}.sequence.${s.step}`, approach: x.def.id, target: 'chapter.sequence', value: `${s.step}@${s.at}`, weight: x.weight, outcome: 'applied', rationale: `Paso aportado por el enfoque secundario ${x.def.shortLabel}.` });
    }
  }

  // Verbos: los del principal primero, luego los de los secundarios (sin repetidos).
  const objectiveVerbs: string[] = [];
  for (const x of defs) for (const v of x.def.objectiveVerbs) if (!objectiveVerbs.includes(v)) objectiveVerbs.push(v);

  // 7. Derivados
  const depthBase: ContentDepth =
    profile.learner.priorKnowledge === 'none' ? 'introductory'
      : profile.learner.priorKnowledge === 'advanced' ? 'advanced'
        : 'standard';
  const contentDepth: ContentDepth =
    depthBase === 'standard' && dims.conceptualDepth >= 0.8 ? 'advanced' : depthBase;
  const interactionLevel: InteractionLevel = dims.interactivity >= 0.7 ? 'high' : dims.interactivity >= 0.45 ? 'medium' : 'low';
  const scenarioBranching = targets['activity.intent'] === 'decide' || targets['activity.intent'] === 'simulate';
  const practiceWeight = Math.min(50, Math.max(20, roundTo5(15 + 35 * ((dims.practice + dims.evidence) / 2))));
  const finalWeight = 20;
  const suggestedWeights = { practice: practiceWeight, moduleExams: 100 - practiceWeight - finalWeight, finalExam: finalWeight };

  return {
    engineVersion: PEDAGOGY_ENGINE_VERSION,
    profileSha256: pedagogicalProfileSha256(profile),
    approaches: weights,
    dimensions: dims,
    targets,
    roleTargets,
    lists,
    sequence,
    objectiveVerbs,
    contentDepth,
    interactionLevel,
    scenarioBranching,
    suggestedWeights,
    principles: [...profile.principles],
    applied,
  };
}

function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

function resolveVote(
  target: EnumTarget,
  votes: { approach: string; approachWeight: number; vote: ApproachVote }[],
): string {
  const vocab = ENUM_TARGETS[target] as readonly string[];
  if (votes.length === 0) return vocab[0];
  const score = new Map<string, number>();
  const best = new Map<string, number>(); // mayor peso de enfoque que votó ese valor (desempate)
  for (const v of votes) {
    score.set(v.vote.value, (score.get(v.vote.value) ?? 0) + v.approachWeight * v.vote.weight);
    best.set(v.vote.value, Math.max(best.get(v.vote.value) ?? 0, v.approachWeight));
  }
  return [...score.entries()].sort(
    (a, b) => round2(b[1]) - round2(a[1]) || (best.get(b[0]) ?? 0) - (best.get(a[0]) ?? 0) || vocab.indexOf(a[0]) - vocab.indexOf(b[0]),
  )[0][0];
}

/** Reglas efectivas de un capítulo según su rol en el módulo. */
export function targetsForRole(rules: DesignRules, role: ChapterRole): Record<EnumTarget, string> {
  return { ...rules.targets, ...(rules.roleTargets[role] ?? {}) } as Record<EnumTarget, string>;
}

/** Resumen persistible de las reglas (lo que se guarda junto al perfil). */
export function designRulesRecord(rules: DesignRules): {
  engineVersion: number;
  profileSha256: string;
  approaches: DesignRules['approaches'];
  targets: DesignRules['targets'];
  roleTargets: DesignRules['roleTargets'];
  lists: DesignRules['lists'];
  sequence: SectionKind[];
  contentDepth: ContentDepth;
  interactionLevel: InteractionLevel;
  scenarioBranching: boolean;
  suggestedWeights: DesignRules['suggestedWeights'];
  appliedRuleIds: string[];
} {
  return {
    engineVersion: rules.engineVersion,
    profileSha256: rules.profileSha256,
    approaches: rules.approaches,
    targets: rules.targets,
    roleTargets: rules.roleTargets,
    lists: rules.lists,
    sequence: rules.sequence,
    contentDepth: rules.contentDepth,
    interactionLevel: rules.interactionLevel,
    scenarioBranching: rules.scenarioBranching,
    suggestedWeights: rules.suggestedWeights,
    appliedRuleIds: rules.applied.filter((a) => a.outcome !== 'overridden').map((a) => a.ruleId),
  };
}
