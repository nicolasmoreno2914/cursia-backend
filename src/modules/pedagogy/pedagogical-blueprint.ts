import {
  BlueprintSnapshotV2,
  buildBlueprintSnapshotV2,
  snapshotV2ToRows,
  chapterKindOf,
} from '../course-blueprints/blueprint-snapshot';
import {
  INTENT_TO_TYPE_V1,
  classifyChapterIntent,
  foldText,
} from '../generation-manifests/activity-type-rules';
import { INTENT_TO_TYPE_V2, classifyChapterIntentV2 } from '../generation-manifests/activity-type-rules-v2';
import {
  BlueprintPedagogyInput,
  ChapterDesign,
  CoursePedagogyDesign,
  ModuleDesign,
} from './blueprint-design';
import { DesignRules, deriveDesignRulesOrNull } from './design-rules';
import { defaultFrameworkRegistry } from './instructional-frameworks';
import { learningTypeActivityRule, resolveChapterLearningType } from './learning-type';
import { ChapterRole, LearningType } from './vocabulary';

/** T2 (r57): versión del plan de aprendizaje congelado (clasificador + marcos + derivación de la actividad). */
export const LEARNING_PLAN_VERSION = 1;

/**
 * Motor pedagógico V1 — Reglas → Blueprint.
 *
 * - `deriveBlueprintPedagogy`: diseño de cada módulo y capítulo (según su rol
 *   en el módulo) + resumen del curso. Es lo que congela el lock del Blueprint.
 * - `applyPedagogyToSnapshot`: el mismo snapshot con el diseño adentro.
 * - `proposeStructureAdjustments`: cambios de estructura SUGERIDOS por las
 *   reglas (video/actividad por capítulo, repaso). El lock NUNCA los aplica
 *   solo (los toggles son del docente); el dry-run los muestra y los aplica a
 *   su vista «propuesta».
 * - `choosePedagogicalActivityTypes`: tipo H5P por capítulo (lo congela el Manifest).
 * - `lintObjectives`: objetivos que no cumplen el estilo del enfoque, con sugerencia.
 * Puro: sin DB, sin red, sin proveedores.
 */

export function chapterRole(index: number, count: number): ChapterRole {
  if (count <= 1) return 'single';
  if (index === 0) return 'module_opening';
  if (index === count - 1) return 'module_closing';
  return 'core';
}

function sortedModules(s: BlueprintSnapshotV2) {
  return [...s.modules].sort((a, b) => a.position - b.position).map((m) => ({
    ...m,
    chapters: [...m.chapters].sort((a, b) => a.position - b.position),
  }));
}

export function coursePedagogyFromRules(rules: DesignRules): CoursePedagogyDesign {
  return {
    engineVersion: rules.engineVersion,
    profileSha256: rules.profileSha256,
    approaches: rules.approaches.map((a) => ({ id: a.id, role: a.role, weight: a.weight })),
    objectivesStyle: rules.targets['objectives.style'],
    contentDepth: rules.contentDepth,
    interactionLevel: rules.interactionLevel,
    assessment: {
      strategy: rules.targets['assessment.strategy'],
      examStyle: rules.targets['assessment.examStyle'],
      finalExamStyle: rules.targets['assessment.finalExamStyle'],
      feedbackMode: rules.targets['feedback.mode'],
      feedbackTiming: rules.targets['feedback.timing'],
      suggestedWeights: { ...rules.suggestedWeights },
    },
    principles: [...rules.principles],
    roleTargets: JSON.parse(JSON.stringify(rules.roleTargets)),
    ...(rules.learningPlan
      ? {
        learningPlan: {
          version: LEARNING_PLAN_VERSION,
          framework: rules.learningPlan.framework,
          phaseLabels: rules.learningPlan.phaseLabels ?? defaultFrameworkRegistry().get(rules.learningPlan.framework).phaseLabelsDefault,
        },
      }
      : {}),
  };
}

/** T2 (r57): marco de un módulo (override del módulo o el del curso). null sin plan. */
export function moduleFrameworkId(rules: DesignRules, moduleId: string): string | null {
  const lp = rules.learningPlan;
  if (!lp) return null;
  return lp.moduleFrameworks?.[moduleId] ?? lp.framework;
}

/** T2 (r57): marco de un capítulo (override del capítulo > módulo > curso). null sin plan. */
export function chapterFrameworkId(rules: DesignRules, moduleId: string, chapterId: string): string | null {
  const lp = rules.learningPlan;
  if (!lp) return null;
  return lp.chapterOverrides?.[chapterId]?.framework ?? moduleFrameworkId(rules, moduleId);
}

/** Diseño base de un capítulo (sin rol: las variaciones por rol viven en course.pedagogy.roleTargets). */
export function chapterDesignFromRules(rules: DesignRules): ChapterDesign {
  const t = rules.targets;
  return {
    sequence: [...rules.sequence],
    objectiveStyle: t['objectives.style'],
    objectiveVerbs: [...rules.objectiveVerbs],
    contentType: t['content.type'],
    depth: rules.contentDepth,
    video: { style: t['video.style'], interactions: t['video.interactions'] },
    activity: { intent: t['activity.intent'], preferredTypes: [...rules.lists['activity.preferredTypes']] },
    scenario: { type: t['scenarios.type'], branching: t['activity.intent'] === 'decide' || t['activity.intent'] === 'simulate' },
    feedback: { mode: t['feedback.mode'], timing: t['feedback.timing'] },
    resources: [...rules.lists.resources],
  };
}

export function moduleDesignFromRules(rules: DesignRules): ModuleDesign {
  return { opening: rules.targets['module.opening'], closing: rules.targets['module.closing'] };
}

export function deriveBlueprintPedagogy(snapshot: BlueprintSnapshotV2, rules: DesignRules): BlueprintPedagogyInput {
  const out: BlueprintPedagogyInput = { course: coursePedagogyFromRules(rules), modules: {}, chapters: {} };
  const lp = rules.learningPlan;
  for (const m of sortedModules(snapshot)) {
    const md = moduleDesignFromRules(rules);
    // T2 (r57): con plan de aprendizaje, el marco del módulo y, por capítulo, su tipo de aprendizaje (reglas u override) y marco.
    out.modules[m.id] = lp ? { ...md, framework: moduleFrameworkId(rules, m.id)! } : md;
    for (const c of m.chapters) {
      const cd = chapterDesignFromRules(rules);
      out.chapters[c.id] = lp
        ? { ...cd, learningType: resolveChapterLearningType(c, lp.chapterOverrides?.[c.id]?.learningType ?? null), framework: chapterFrameworkId(rules, m.id, c.id)! }
        : cd;
    }
  }
  return out;
}

/**
 * Diseño pedagógico que congela el lock para un perfil (null si no hay perfil o está vacío). Fuente
 * ÚNICA del lock (CourseBlueprintsService.lockV2) y de la comparación «estructura viva = Blueprint
 * vigente» (CourseStructureService): si divergieran, la estructura nunca figuraría confirmada (review I1).
 */
export function lockPedagogyInput(plain: BlueprintSnapshotV2, profile: unknown): BlueprintPedagogyInput | null {
  const rules = deriveDesignRulesOrNull(profile);
  return rules ? deriveBlueprintPedagogy(plain, rules) : null;
}

/** Meta del vocabulario → campo del diseño de capítulo que la expresa (las demás metas no viven en el capítulo). */
const CHAPTER_TARGET_FIELDS: Readonly<Record<string, (d: EffectiveChapterDesign, v: string) => void>> = Object.freeze({
  'objectives.style': (d: EffectiveChapterDesign, v: string) => { d.objectiveStyle = v; },
  'content.type': (d: EffectiveChapterDesign, v: string) => { d.contentType = v; },
  'video.style': (d: EffectiveChapterDesign, v: string) => { d.video.style = v; },
  'video.interactions': (d: EffectiveChapterDesign, v: string) => { d.video.interactions = v; },
  'activity.intent': (d: EffectiveChapterDesign, v: string) => { d.activity.intent = v; },
  'scenarios.type': (d: EffectiveChapterDesign, v: string) => { d.scenario.type = v; },
  'feedback.mode': (d: EffectiveChapterDesign, v: string) => { d.feedback.mode = v; },
  'feedback.timing': (d: EffectiveChapterDesign, v: string) => { d.feedback.timing = v; },
});

export interface EffectiveChapterDesign extends ChapterDesign {
  role: ChapterRole;
}

/**
 * Diseño EFECTIVO de un capítulo: su diseño congelado + las variaciones del rol que le da su posición
 * actual en el módulo. Lo usan el Manifest (builder y validador), el tipo H5P y el dry-run.
 */
/**
 * r79.1 (rendimiento): posición de cada capítulo en su módulo (ordenado), por snapshot. El builder y el validador del
 * Manifest piden el diseño de cada item (≈ 7 por capítulo) y antes cada pedido re-ordenaba todos los módulos. El resultado
 * de effectiveChapterDesign sigue siendo un objeto NUEVO en cada llamada (mismo valor).
 */
const CHAPTER_POS = new WeakMap<BlueprintSnapshotV2, Map<string, { m: number; idx: number; len: number }>>();
function chapterPosOf(snapshot: BlueprintSnapshotV2): Map<string, { m: number; idx: number; len: number }> {
  let pos = CHAPTER_POS.get(snapshot);
  if (pos) return pos;
  pos = new Map();
  snapshot.modules.forEach((m, mi) => {
    const chs = [...m.chapters].sort((a, b) => a.position - b.position);
    chs.forEach((c, idx) => { if (!pos!.has(c.id)) pos!.set(c.id, { m: mi, idx, len: chs.length }); });
  });
  CHAPTER_POS.set(snapshot, pos);
  return pos;
}

export function effectiveChapterDesign(snapshot: BlueprintSnapshotV2, chapterId: string): EffectiveChapterDesign {
  const ped = snapshot.course.pedagogy;
  if (!ped) throw new Error('effectiveChapterDesign: el snapshot no tiene diseño pedagógico');
  const at = chapterPosOf(snapshot).get(chapterId);
  if (at) {
    const m = snapshot.modules[at.m];
    const chs = [...m.chapters].sort((a, b) => a.position - b.position);
    const idx = at.idx;
    const base = chs[idx].design;
    if (!base) throw new Error(`effectiveChapterDesign: el capítulo ${chapterId} no tiene diseño`);
    const role = chapterRole(idx, chs.length);
    const d: EffectiveChapterDesign = { role, ...JSON.parse(JSON.stringify(base)) };
    const overrides = ped.roleTargets?.[role] ?? {};
    for (const [t, v] of Object.entries(overrides)) CHAPTER_TARGET_FIELDS[t]?.(d, v);
    d.scenario.branching = d.activity.intent === 'decide' || d.activity.intent === 'simulate';
    return d;
  }
  throw new Error(`effectiveChapterDesign: capítulo ${chapterId} inexistente en el snapshot`);
}

/**
 * r79.1 (rendimiento): el mismo diseño efectivo, COMPARTIDO por snapshot y capítulo, para lectores que solo copian campos
 * (manifestItemDesign: ≈ 7 pedidos por capítulo en el builder y otros tantos en el validador del Manifest). No modificar.
 */
const SHARED_DESIGN = new WeakMap<BlueprintSnapshotV2, Map<string, EffectiveChapterDesign>>();
export function effectiveChapterDesignShared(snapshot: BlueprintSnapshotV2, chapterId: string): Readonly<EffectiveChapterDesign> {
  let m = SHARED_DESIGN.get(snapshot);
  if (!m) { m = new Map(); SHARED_DESIGN.set(snapshot, m); }
  let d = m.get(chapterId);
  if (!d) { d = effectiveChapterDesign(snapshot, chapterId); m.set(chapterId, d); }
  return d;
}

/** El snapshot con el diseño pedagógico adentro (null/undefined rules → el snapshot sin diseño). */
export function applyPedagogyToSnapshot(snapshot: BlueprintSnapshotV2, rules: DesignRules | null): BlueprintSnapshotV2 {
  const { course, modules, chapters } = snapshotV2ToRows(snapshot);
  return buildBlueprintSnapshotV2(course, modules, chapters, rules ? deriveBlueprintPedagogy(snapshot, rules) : null);
}

// ── Cambios de estructura sugeridos ─────────────────────────────────────────

export interface StructureChange {
  path: string;
  entityId: string | number;
  title: string;
  field: 'videoEnabled' | 'activityEnabled' | 'reviewCards';
  from: boolean;
  to: boolean;
  target: string;
  value: string;
  ruleIds: string[];
  reason: string;
}

function ruleIdsFor(rules: DesignRules, target: string, value: string): string[] {
  return rules.applied.filter((a) => a.target === target && a.value === value && a.outcome === 'applied').map((a) => a.ruleId);
}

function rationaleFor(rules: DesignRules, target: string, value: string): string {
  return rules.applied.find((a) => a.target === target && a.value === value && a.outcome === 'applied')?.rationale ?? '';
}

export function proposeStructureAdjustments(
  snapshot: BlueprintSnapshotV2,
  rules: DesignRules,
): { snapshot: BlueprintSnapshotV2; changes: StructureChange[] } {
  const rows = snapshotV2ToRows(snapshot);
  const changes: StructureChange[] = [];
  const videoPolicy = rules.targets['video.policy'];
  const activityPolicy = rules.targets['activity.policy'];
  const reviewPolicy = rules.targets['reviewCards.policy'];
  const byId = new Map(rows.chapters.map((c) => [c.id, c]));

  sortedModules(snapshot).forEach((m, mi) => {
    m.chapters.forEach((c, ci) => {
      const row = byId.get(c.id)!;
      const path = `modules[${mi}].chapters[${ci}]`;
      // Motor de carga horaria: un capítulo de práctica nunca lleva video (regla de producto > pedagogía).
      if (videoPolicy !== 'keep' && chapterKindOf(c) !== 'practice') {
        // «Solo el primero» = el primer capítulo de CONTENIDO del módulo (una práctica al inicio no cuenta).
        const contentIdx = m.chapters.filter((x) => chapterKindOf(x) !== 'practice').indexOf(c);
        const want = videoPolicy === 'every_chapter' ? true : contentIdx === 0;
        if (row.video_enabled !== want) {
          changes.push({
            path: `${path}.videoEnabled`, entityId: c.id, title: c.title, field: 'videoEnabled', from: row.video_enabled, to: want,
            target: 'video.policy', value: videoPolicy, ruleIds: ruleIdsFor(rules, 'video.policy', videoPolicy), reason: rationaleFor(rules, 'video.policy', videoPolicy),
          });
          row.video_enabled = want;
        }
      }
      if (activityPolicy === 'every_chapter' && row.activity_enabled !== true) {
        changes.push({
          path: `${path}.activityEnabled`, entityId: c.id, title: c.title, field: 'activityEnabled', from: row.activity_enabled, to: true,
          target: 'activity.policy', value: activityPolicy, ruleIds: ruleIdsFor(rules, 'activity.policy', activityPolicy), reason: rationaleFor(rules, 'activity.policy', activityPolicy),
        });
        row.activity_enabled = true;
      }
    });
  });
  if (reviewPolicy === 'enable' && rows.course.reviewCards !== true) {
    changes.push({
      path: 'course.reviewCards', entityId: rows.course.id, title: rows.course.title, field: 'reviewCards', from: false, to: true,
      target: 'reviewCards.policy', value: reviewPolicy, ruleIds: ruleIdsFor(rules, 'reviewCards.policy', reviewPolicy), reason: rationaleFor(rules, 'reviewCards.policy', reviewPolicy),
    });
    rows.course.reviewCards = true;
  }
  return { snapshot: buildBlueprintSnapshotV2(rows.course, rows.modules, rows.chapters, rows.pedagogy), changes };
}

// ── Tipo de actividad H5P por capítulo ─────────────────────────────────────

export type PedagogicalH5pType = 'questionset' | 'dragtext' | 'blanks' | 'branchingscenario';
const ROTATION_TYPES: readonly PedagogicalH5pType[] = ['questionset', 'dragtext', 'blanks'];

/** Tipo que expresa cada intención de diseño (si el motor de actividades lo admite). */
const DESIGN_INTENT_TYPE: Readonly<Record<string, PedagogicalH5pType>> = Object.freeze({
  decide: 'branchingscenario',
  simulate: 'branchingscenario',
  apply: 'questionset',
  relate: 'dragtext',
  self_check: 'questionset',
});

export interface PedagogicalActivityDecision {
  type: PedagogicalH5pType;
  reason: 'design_intent' | 'objective' | 'branching_cap' | 'variety' | 'learning_type';
  /** T2 (r57): SOLO con plan de aprendizaje — regla de la tabla tipo de aprendizaje → actividad y sus candidatos. */
  learningType?: { type: LearningType; level: string | null; ruleId: string; candidates: PedagogicalH5pType[]; rationale: string };
}

/** Tipos permitidos según las reglas de actividad del Manifest (branchingscenario solo con H5P v2 = 2). */
export function allowedPedagogicalTypes(activityTypeRules: number | undefined | null): readonly PedagogicalH5pType[] {
  return activityTypeRules === 2 ? [...ROTATION_TYPES, 'branchingscenario'] : ROTATION_TYPES;
}

/**
 * Elige el tipo H5P de cada actividad desde el diseño del capítulo:
 *  1. candidato principal = el tipo de la intención de diseño (decidir → escenario ramificado…);
 *  2. si el objetivo del capítulo pide claramente otro tipo y ese tipo está entre los 2 primeros
 *     preferidos del enfoque, gana el objetivo (coherencia con el objetivo, dentro del enfoque);
 *  3. tope de escenarios ramificados por curso max(1, floor(n/4)) (mismo ruling de tamaño de
 *     paquete que las reglas H5P v2): se conservan primero en cierres y aperturas de módulo;
 *  4. variedad: ningún tipo ocupa más de max(2, ceil(0,6·n)) actividades.
 * Requiere un snapshot CON diseño pedagógico. Determinística.
 */
export function choosePedagogicalActivityTypes(
  snapshot: BlueprintSnapshotV2,
  activityTypeRules: number | undefined | null,
): Map<string, PedagogicalActivityDecision> {
  if (!snapshot.course.pedagogy) throw new Error('choosePedagogicalActivityTypes: el snapshot no tiene diseño pedagógico');
  const allowed = allowedPedagogicalTypes(activityTypeRules);
  const v2 = activityTypeRules === 2;
  const chapters: { id: string; role: string; candidates: PedagogicalH5pType[]; objectiveType: PedagogicalH5pType | null; lt?: PedagogicalActivityDecision['learningType'] }[] = [];
  for (const m of sortedModules(snapshot)) {
    for (const c of m.chapters) {
      if (c.activityEnabled !== true) continue;
      if (!c.design) throw new Error(`choosePedagogicalActivityTypes: el capítulo ${c.id} no tiene diseño`);
      const d = effectiveChapterDesign(snapshot, c.id);
      if (d.learningType) {
        // T2 (r57): el tipo de aprendizaje decide los candidatos (tabla de datos); el balance solo se mueve dentro de ellos.
        const r = learningTypeActivityRule(d.learningType.type as LearningType, d.learningType.level, allowed);
        const lt = { type: d.learningType.type as LearningType, level: d.learningType.level, ruleId: r.ruleId, candidates: r.candidates, rationale: r.rationale };
        chapters.push({ id: c.id, role: d.role, candidates: r.candidates, objectiveType: null, lt });
        continue;
      }
      const prefs = d.activity.preferredTypes.filter((t): t is PedagogicalH5pType => (allowed as readonly string[]).includes(t));
      for (const t of allowed) if (!prefs.includes(t)) prefs.push(t);
      const intentType = DESIGN_INTENT_TYPE[d.activity.intent];
      const first = intentType && allowed.includes(intentType) ? intentType : prefs[0];
      const candidates = [first, ...prefs.filter((t) => t !== first)];
      const intent = v2 ? classifyChapterIntentV2(c) : classifyChapterIntent(c);
      const objType = intent ? ((v2 ? INTENT_TO_TYPE_V2 : INTENT_TO_TYPE_V1) as Record<string, string>)[intent] as PedagogicalH5pType : null;
      chapters.push({ id: c.id, role: d.role, candidates, objectiveType: objType && allowed.includes(objType) ? objType : null });
    }
  }
  const out = new Map<string, PedagogicalActivityDecision>();
  for (const ch of chapters) {
    if (ch.lt) {
      out.set(ch.id, { type: ch.candidates[0], reason: 'learning_type', learningType: ch.lt });
      continue;
    }
    const top2 = ch.candidates.slice(0, 2);
    if (ch.objectiveType && ch.objectiveType !== ch.candidates[0] && top2.includes(ch.objectiveType)) {
      out.set(ch.id, { type: ch.objectiveType, reason: 'objective' });
    } else {
      out.set(ch.id, { type: ch.candidates[0], reason: 'design_intent' });
    }
  }
  const n = chapters.length;
  const nextOther = (ch: (typeof chapters)[number], avoid: Set<PedagogicalH5pType>): PedagogicalH5pType | null =>
    ch.candidates.find((t) => !avoid.has(t)) ?? null;

  // 3. Tope de escenarios ramificados.
  if (allowed.includes('branchingscenario')) {
    const cap = Math.max(1, Math.floor(n / 4));
    const priority = (role: string) => (role === 'module_closing' ? 0 : role === 'module_opening' ? 1 : role === 'single' ? 1 : 2);
    const bs = chapters
      .map((ch, idx) => ({ ch, idx }))
      .filter(({ ch }) => out.get(ch.id)!.type === 'branchingscenario')
      .sort((a, b) => priority(a.ch.role) - priority(b.ch.role) || a.idx - b.idx);
    for (const { ch } of bs.slice(cap)) {
      const t = nextOther(ch, new Set(['branchingscenario']));
      if (t) out.set(ch.id, { type: t, reason: 'branching_cap', ...(ch.lt ? { learningType: ch.lt } : {}) });
    }
  }
  // 4. Variedad.
  if (n >= 3) {
    const maxSame = Math.max(2, Math.ceil(0.6 * n));
    for (let guard = 0; guard < n; guard++) {
      const counts = new Map<PedagogicalH5pType, number>();
      for (const d of out.values()) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
      const over = [...counts.entries()].find(([, k]) => k > maxSame);
      if (!over) break;
      const [dominant] = over;
      // Se cambia el último capítulo (en orden del curso) que tiene el tipo dominante y alguna alternativa.
      const bsCount = counts.get('branchingscenario') ?? 0;
      const bsCap = Math.max(1, Math.floor(n / 4));
      const victim = [...chapters].reverse().find((ch) => {
        if (out.get(ch.id)!.type !== dominant) return false;
        return ch.candidates.some((t) => t !== dominant && (t !== 'branchingscenario' || bsCount < bsCap));
      });
      if (!victim) break;
      const alt = victim.candidates.find((t) => t !== dominant && (t !== 'branchingscenario' || bsCount < bsCap))!;
      out.set(victim.id, { type: alt, reason: 'variety', ...(victim.lt ? { learningType: victim.lt } : {}) });
    }
  }
  return out;
}

// ── Objetivos ───────────────────────────────────────────────────────────────

/** Verbos que no describen un desempeño observable (no se pueden verificar). */
export const NON_OBSERVABLE_VERBS: readonly string[] = Object.freeze([
  'comprender', 'conocer', 'entender', 'saber', 'aprender', 'familiarizarse', 'familiarizar', 'apreciar', 'valorar',
  'interiorizar', 'concienciar', 'sensibilizar', 'asimilar', 'memorizar',
]);

export interface ObjectiveLint {
  entity: 'module' | 'chapter';
  id: string;
  title: string;
  objective: string | null;
  ok: boolean;
  issue: 'missing_objective' | 'non_observable_verb' | null;
  verb: string | null;
  suggestion: string | null;
}

/** Primer infinitivo entre las primeras 8 palabras (índice en `text.trim().split(/\s+/)`). */
function firstInfinitive(text: string): { verb: string; index: number } | null {
  const words = String(text).trim().split(/\s+/);
  for (let i = 0; i < words.length && i < 8; i++) {
    const w = foldText(words[i])[0] ?? '';
    if (/^[a-z]{2,}(ar|er|ir)(se)?$/.test(w)) return { verb: w.replace(/(ar|er|ir)se$/, '$1'), index: i };
  }
  return null;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Revisa los objetivos de módulos y capítulos contra el estilo del enfoque:
 * todos los estilos piden verbos verificables; un objetivo que empieza con
 * «comprender», «conocer»… se marca y se sugiere el primer verbo del enfoque
 * (la reformulación final la hace el docente o la IA en la fase de contenido).
 */
export function lintObjectives(snapshot: BlueprintSnapshotV2, rules: DesignRules): ObjectiveLint[] {
  const out: ObjectiveLint[] = [];
  const verb0 = rules.objectiveVerbs[0];
  const check = (entity: 'module' | 'chapter', id: string, title: string, objective: string | null) => {
    if (!objective || !objective.trim()) {
      out.push({ entity, id, title, objective, ok: false, issue: 'missing_objective', verb: null, suggestion: `${capitalize(verb0)} … (redactar un objetivo con verbo observable)` });
      return;
    }
    const inf = firstInfinitive(objective);
    // Solo cuenta si el objetivo EMPIEZA con ese verbo (como mucho una palabra antes: «Comprender…», «Hoy comprender…»).
    if (inf && inf.index <= 1 && NON_OBSERVABLE_VERBS.includes(inf.verb)) {
      const words = objective.trim().split(/\s+/);
      const rest = words.slice(inf.index + 1).join(' ');
      out.push({ entity, id, title, objective, ok: false, issue: 'non_observable_verb', verb: inf.verb, suggestion: `${capitalize(verb0)} ${rest}`.trim() });
      return;
    }
    out.push({ entity, id, title, objective, ok: true, issue: null, verb: inf?.verb ?? null, suggestion: null });
  };
  for (const m of sortedModules(snapshot)) {
    check('module', m.id, m.title, m.objective);
    for (const c of m.chapters) check('chapter', c.id, c.title, c.objective);
  }
  return out;
}
