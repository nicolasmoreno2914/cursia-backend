import {
  ActivityEngine,
  BlueprintSnapshotV2,
  RawChapterRowV2,
  RawModuleRow,
  buildBlueprintSnapshotV2,
  isActivityEngine,
  snapshotSha256V2,
  snapshotV2ToRows,
  validateBlueprintInputV2,
} from '../course-blueprints/blueprint-snapshot';
import {
  GenerationManifestV1,
  ManifestSource,
  buildGenerationManifestV3,
  manifestSha256,
  validateGenerationManifestV3,
} from '../generation-manifests/generation-manifest-builder';
import type { ActivityTypeRulesVersion } from '../generation-manifests/activity-type-rules';
import { estimateCost } from '../finops/estimator';
import { DistributionResult, distributeCourseHours, estimateCourseStudyTime, StudyTimeEstimate, studyTimeInputFromManifest } from '../study-time';
import { ITEM_TYPE_OPERATIONS, isFinopsItemType, providerOfOperation } from '../finops/operations';
import { estimateItemsForRun } from '../finops/run-budget';
import { usageModelPriorsV1 } from '../finops/usage-model';
import * as pricingSeedJson from '../finops/pricing-seed.v1.json';
import { PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import { AppliedRule, DesignRules, deriveDesignRulesOrNull } from './design-rules';
import {
  ObjectiveLint,
  StructureChange,
  applyPedagogyToSnapshot,
  effectiveChapterDesign,
  lintObjectives,
  proposeStructureAdjustments,
} from './pedagogical-blueprint';
import { ItemPedagogyBrief, OverrideLevel, PEDAGOGY_GENERATOR_COVERAGE, buildItemPedagogyBrief } from './generator-directives';
import { PedagogicalProfile, isEmptyPedagogicalProfile, normalizePedagogicalProfile, profileTargetHours } from './pedagogy-profile';
import { PEDAGOGY_ENGINE_VERSION } from './vocabulary';

/**
 * Motor pedagógico V1 — DRY RUN.
 *
 *   Perfil pedagógico → reglas → Blueprint → Manifest → (alto)
 *
 * Corre SOLO lógica pura: el builder del Blueprint, el builder y el validador
 * del Manifest y el estimador de FinOps (precios del seed versionado, sin DB).
 * No importa ningún cliente de proveedor, no abre conexiones, no escribe nada:
 * `providersCalled` es 0 por construcción (lo verifica check-pedagogy-engine.js
 * con la red bloqueada). El costo es una ESTIMACIÓN de lo que costaría generar,
 * nunca un gasto.
 *
 * Compara siempre dos diseños del MISMO curso: `baseline` (sin pedagogía, lo
 * que Cursia hace hoy) y `pedagogical` (con el perfil), y lista qué cambió.
 */

export interface DryRunChapterInput {
  id?: string;
  title: string;
  objective?: string | null;
  description?: string | null;
  videoEnabled?: boolean;
  activityEnabled?: boolean;
  /** Motor de carga horaria: 'practice' = capítulo de práctica (sin video). Ausente = contenido. */
  kind?: 'content' | 'practice';
}
export interface DryRunModuleInput {
  id?: string;
  title: string;
  objective?: string | null;
  description?: string | null;
  examEnabled?: boolean;
  chapters: DryRunChapterInput[];
}
export interface DryRunStructureInput {
  course: { id?: number; title: string; finalExam?: boolean; activityEngine?: ActivityEngine; reviewCards?: boolean };
  modules: DryRunModuleInput[];
}

export interface DryRunInput {
  /** Estructura propuesta (ids opcionales) o un Blueprint snapshot v2 (p.ej. la estructura viva del curso). */
  structure: DryRunStructureInput | BlueprintSnapshotV2;
  /** Perfil pedagógico (null/vacío → solo la línea base). */
  profile: unknown;
  /** Reglas de tipo de actividad del Manifest (default 2 = H5P v2, el de staging). */
  activityTypeRules?: ActivityTypeRulesVersion;
  /** Aplicar los cambios de estructura sugeridos en la vista pedagógica (default true). */
  applyStructureAdjustments?: boolean;
  registry?: PedagogicalApproachRegistry;
}

export interface ProviderPlan {
  /** Por proveedor: operaciones que se ejecutarían al generar (nada se ejecuta en el dry-run). */
  byProvider: Record<string, { items: number; operations: Record<string, number> }>;
  estimateUsd: { min: string; expected: string; max: string; byProvider: Record<string, string> } | null;
  estimateNote: string;
}

export interface DryRunSide {
  blueprint: BlueprintSnapshotV2;
  blueprintSha256: string;
  manifest: GenerationManifestV1;
  manifestSha256: string;
  manifestErrors: { code: string; message: string; key?: string }[];
  providers: ProviderPlan;
  /** Motor de carga horaria: tiempo de estudio PLANIFICADO (modelo study-time; nada se genera). */
  studyTime: StudyTimeEstimate;
}

export interface DryRunChapterRow {
  moduleNumber: number;
  chapterNumber: number;
  chapterId: string;
  title: string;
  role: string | null;
  sequence: string[] | null;
  contentType: string | null;
  depth: string | null;
  video: { baselineEnabled: boolean; enabled: boolean; style: string | null; interactions: string | null };
  activity: { baselineEnabled: boolean; enabled: boolean; baselineType: string | null; type: string | null; intent: string | null };
  scenario: { type: string; branching: boolean } | null;
  feedback: { mode: string; timing: string } | null;
  resources: string[] | null;
}

/** Fase 2: lo que recibe el generador de cada trabajo del Manifest pedagógico. */
export interface DryRunGeneratorRow {
  itemKey: string;
  type: string;
  moduleNumber: number | null;
  chapterNumber: number | null;
  /** Generador que produce el trabajo (texto) y si consume el diseño. */
  generator: string;
  consumes: boolean;
  /** Por qué no consume (solo consumes=false). */
  reason: string | null;
  /** Dónde entra el texto: bloque del prompt LLM, content_txt de Videogen o additionalInstructions de Gamma. */
  deliveredAs: string | null;
  brief: ItemPedagogyBrief | null;
}

/** Fase 2: reglas pedagógicas que pierden frente a una restricción del CURSO (toggles del docente). */
export interface DryRunCourseOverride {
  chapterId: string;
  title: string;
  target: string;
  value: string;
  by: OverrideLevel;
  rule: string;
  effect: string;
}

export interface DryRunResult {
  dryRun: true;
  providersCalled: 0;
  spendUsd: '0.00';
  engineVersion: number;
  activityTypeRules: ActivityTypeRulesVersion;
  profile: PedagogicalProfile | null;
  profileEmpty: boolean;
  rules: DesignRules | null;
  /** Motor de carga horaria: horas objetivo del curso (null = sin objetivo, comportamiento anterior). */
  targetHours: number | null;
  /** Objetivo vs. estimado de la vista final (pedagógica o línea base). null sin objetivo. */
  workload: { targetHours: number; estimatedHours: number; deltaHours: number } | null;
  /**
   * Motor de carga horaria (Loop 3): diseño propuesto por el distribuidor para alcanzar targetHours (null sin
   * objetivo). Solo propuesta: no cambia el Blueprint ni el Manifest de este dry-run.
   */
  distribution: DistributionResult | null;
  baseline: DryRunSide;
  pedagogical: DryRunSide | null;
  structureChanges: StructureChange[];
  objectives: ObjectiveLint[];
  modules: { moduleNumber: number; moduleId: string; title: string; opening: string | null; closing: string | null; examEnabled: boolean; examStyle: string | null }[];
  chapters: DryRunChapterRow[];
  assessment: null | { strategy: string; examStyle: string; finalExamStyle: string; feedbackMode: string; feedbackTiming: string; suggestedWeights: { practice: number; moduleExams: number; finalExam: number } };
  diff: {
    itemsAdded: string[];
    itemsRemoved: string[];
    h5pTypeChanges: { chapterId: string; title: string; from: string | null; to: string | null }[];
    itemsWithDesign: number;
    totals: { baseline: Record<string, number>; pedagogical: Record<string, number> | null };
    estimateExpectedUsd: { baseline: string | null; pedagogical: string | null };
    /** Horas de estudio estimadas (modelo study-time). */
    estimatedHours: { baseline: number; pedagogical: number | null };
    summary: string[];
  };
  appliedRules: AppliedRule[];
  /** Fase 2: brief de cada trabajo (vacío sin perfil: los prompts son los de siempre). */
  generators: DryRunGeneratorRow[];
  courseOverrides: DryRunCourseOverride[];
}

const DELIVERED_AS: Readonly<Record<string, string>> = Object.freeze({
  presentation: 'Gamma: al final de additionalInstructions (después de las reglas de siempre)',
  video: 'Videogen: cabecera de content_txt (antes del capítulo)',
});

/** Brief de cada trabajo del Manifest (las mismas funciones que usa el claim del backend). */
export function generatorPlanFor(side: DryRunSide, registry: PedagogicalApproachRegistry): DryRunGeneratorRow[] {
  const rules = (side.manifest as any).features?.activityTypeRules ?? null;
  return side.manifest.items.map((it) => {
    const cov = PEDAGOGY_GENERATOR_COVERAGE[it.type];
    if (!cov) throw new Error(`DRY_RUN_COVERAGE: el tipo ${it.type} no está en PEDAGOGY_GENERATOR_COVERAGE`);
    const brief = buildItemPedagogyBrief({ item: it as any, snapshot: side.blueprint, activityTypeRules: rules, registry });
    return {
      itemKey: it.key,
      type: it.type,
      moduleNumber: it.moduleNumber ?? null,
      chapterNumber: it.chapterNumber ?? null,
      generator: cov.generator,
      consumes: cov.consumes,
      reason: cov.consumes ? null : cov.reason,
      deliveredAs: brief ? DELIVERED_AS[brief.generator] ?? 'Prompt LLM del navegador: bloque «DISEÑO PEDAGÓGICO DE ESTE RECURSO»' : null,
      brief,
    };
  });
}

/** Toggles del docente (restricción del curso, prioridad 3) que dejan sin efecto una regla pedagógica. */
function courseOverridesFor(snapshot: BlueprintSnapshotV2): DryRunCourseOverride[] {
  if (!snapshot.course.pedagogy) return [];
  const out: DryRunCourseOverride[] = [];
  for (const m of [...snapshot.modules].sort((a, b) => a.position - b.position)) {
    for (const c of [...m.chapters].sort((a, b) => a.position - b.position)) {
      if (!c.design) continue;
      const d = effectiveChapterDesign(snapshot, c.id);
      if (!c.videoEnabled) {
        out.push({ chapterId: c.id, title: c.title, target: 'video.style', value: d.video.style, by: 'course', rule: 'El docente apagó el video de este capítulo', effect: 'No hay video ni preguntas de video: el estilo de video no se aplica.' });
      }
      if (c.activityEnabled !== true) {
        out.push({ chapterId: c.id, title: c.title, target: 'activity.intent', value: d.activity.intent, by: 'course', rule: 'El docente apagó la actividad de este capítulo', effect: 'No hay actividad: la intención de la actividad no se aplica.' });
      }
    }
  }
  return out;
}

const DRY_RUN_SOURCE_BASE = { blueprintId: 0, blueprintNumber: 0 };

function isSnapshot(s: unknown): s is BlueprintSnapshotV2 {
  return !!s && typeof s === 'object' && (s as any).schemaVersion === 2;
}

/** Estructura propuesta → Blueprint v2 (ids estables m1, m1c1… si no vienen). Falla fuerte si no valida. */
export function snapshotFromStructure(input: DryRunStructureInput): BlueprintSnapshotV2 {
  if (!input || typeof input !== 'object' || !input.course || !Array.isArray(input.modules)) {
    throw new Error('DRY_RUN_INVALID_STRUCTURE: se espera { course: { title, … }, modules: [ { title, chapters: [ … ] } ] }');
  }
  const engine = input.course.activityEngine ?? 'h5p';
  if (!isActivityEngine(engine)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: activityEngine inválido ${JSON.stringify(engine)}`);
  const course = {
    id: Number.isInteger(input.course.id) ? (input.course.id as number) : 0,
    title: String(input.course.title ?? ''),
    finalExam: input.course.finalExam !== false,
    activityEngine: engine,
    reviewCards: input.course.reviewCards === true,
  };
  const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(input.course)) throw new Error('DRY_RUN_INVALID_STRUCTURE: course debe ser un objeto');
  input.modules.forEach((m, mi) => {
    if (!isObj(m)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: modules[${mi}] debe ser un objeto`);
    if (m.id !== undefined && (typeof m.id !== 'string' || !m.id)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: modules[${mi}].id debe ser texto`);
    if (m.chapters !== undefined && !Array.isArray(m.chapters)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: modules[${mi}].chapters debe ser un array`);
    (m.chapters ?? []).forEach((c, ci) => {
      if (!isObj(c)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: modules[${mi}].chapters[${ci}] debe ser un objeto`);
      if (c.id !== undefined && (typeof c.id !== 'string' || !c.id)) throw new Error(`DRY_RUN_INVALID_STRUCTURE: modules[${mi}].chapters[${ci}].id debe ser texto`);
    });
  });
  const modules: RawModuleRow[] = [];
  const chapters: RawChapterRowV2[] = [];
  input.modules.forEach((m, mi) => {
    const mid = m.id || `m${mi + 1}`;
    modules.push({ id: mid, position: mi, title: String(m.title ?? ''), objective: m.objective ?? null, description: m.description ?? null, exam_enabled: m.examEnabled !== false });
    (Array.isArray(m.chapters) ? m.chapters : []).forEach((c, ci) => {
      chapters.push({
        id: c.id || `${mid}c${ci + 1}`, module_id: mid, position: ci, title: String(c.title ?? ''), objective: c.objective ?? null,
        description: c.description ?? null, video_enabled: c.kind === 'practice' ? false : c.videoEnabled !== false, activity_enabled: c.activityEnabled !== false,
        ...(c.kind !== undefined ? { chapter_kind: c.kind } : {}),
      });
    });
  });
  const errors = validateBlueprintInputV2(course, modules, chapters);
  if (errors.length > 0) throw new Error(`DRY_RUN_INVALID_STRUCTURE: ${errors.map((e) => e.message).join('; ')}`);
  return buildBlueprintSnapshotV2(course, modules, chapters);
}

/**
 * Snapshot v2 recibido (estructura viva o enviado por el cliente) → snapshot SIN diseño, validado
 * como en el lock. Una forma rota da DRY_RUN_INVALID_STRUCTURE (400), nunca un TypeError (500).
 */
function snapshotFromSnapshot(s: BlueprintSnapshotV2): BlueprintSnapshotV2 {
  let rows: ReturnType<typeof snapshotV2ToRows>;
  try {
    const bad = (x: any) => !x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id;
    if (!Array.isArray((s as any).modules) || (s as any).modules.some((m: any) => bad(m) || !Array.isArray(m.chapters) || m.chapters.some(bad))) {
      throw new Error('modules[] y chapters[] con id de texto obligatorios');
    }
    rows = snapshotV2ToRows(s);
  } catch (err) {
    throw new Error(`DRY_RUN_INVALID_STRUCTURE: snapshot ilegible (${(err as Error).message})`);
  }
  const errors = validateBlueprintInputV2(rows.course, rows.modules, rows.chapters);
  if (errors.length > 0) throw new Error(`DRY_RUN_INVALID_STRUCTURE: ${errors.map((e) => e.message).join('; ')}`);
  return buildBlueprintSnapshotV2(rows.course, rows.modules, rows.chapters);
}

/** El mismo snapshot con `course.targetHours` (pasa por el builder: orden canónico y validación). */
export function withTargetHours(s: BlueprintSnapshotV2, targetHours: number | null): BlueprintSnapshotV2 {
  const rows = snapshotV2ToRows(s);
  return buildBlueprintSnapshotV2({ ...rows.course, targetHours }, rows.modules, rows.chapters, rows.pedagogy);
}

let catalogCache: any[] | null = null;
function seedCatalog(): any[] {
  if (!catalogCache) {
    const seed = ((pricingSeedJson as any).default ?? pricingSeedJson) as { rows: any[] };
    catalogCache = seed.rows.map((r, i) => ({ id: `seed-${i}`, ...r, unit_size: String(r.unit_size), unit_price: String(r.unit_price), effective_to: r.effective_to ?? null }));
  }
  return catalogCache;
}

/** Proveedores y operaciones que dispararía el Manifest + estimación con el seed de precios (sin DB, sin red). */
export function providerPlanFor(manifest: GenerationManifestV1): ProviderPlan {
  const byProvider: ProviderPlan['byProvider'] = {};
  for (const it of manifest.items) {
    if (!isFinopsItemType(it.type)) continue;
    const seen = new Set<string>();
    for (const op of ITEM_TYPE_OPERATIONS[it.type]) {
      const p = providerOfOperation(op) ?? 'unknown';
      byProvider[p] = byProvider[p] ?? { items: 0, operations: {} };
      byProvider[p].operations[op] = (byProvider[p].operations[op] ?? 0) + 1;
      if (!seen.has(p)) {
        byProvider[p].items += 1;
        seen.add(p);
      }
    }
  }
  const sorted: ProviderPlan['byProvider'] = {};
  for (const k of Object.keys(byProvider).sort()) sorted[k] = byProvider[k];
  let estimateUsd: ProviderPlan['estimateUsd'] = null;
  let estimateNote = 'Estimación con los precios del seed versionado (pricing-seed.v1) y el modelo de uso v1. Nada se ejecuta ni se cobra en el dry-run.';
  try {
    const items = estimateItemsForRun(manifest.items, 'real');
    const est = estimateCost({ items, catalog: seedCatalog(), usageModel: usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
    const byP: Record<string, string> = {};
    for (const k of Object.keys(est.totals.byProvider).sort()) byP[k] = est.totals.byProvider[k].expected;
    estimateUsd = { min: est.totals.min, expected: est.totals.expected, max: est.totals.max, byProvider: byP };
  } catch (e) {
    estimateNote = `Sin estimación de costo: ${(e as Error).message}`;
  }
  return { byProvider: sorted, estimateUsd, estimateNote };
}

function side(snapshot: BlueprintSnapshotV2, activityTypeRules: ActivityTypeRulesVersion): DryRunSide {
  const sha = snapshotSha256V2(snapshot);
  const source: ManifestSource = { courseId: snapshot.course.id, ...DRY_RUN_SOURCE_BASE, blueprintSha256: sha };
  const manifest = buildGenerationManifestV3(snapshot, source, { activityTypeRules });
  return {
    blueprint: snapshot,
    blueprintSha256: sha,
    manifest,
    manifestSha256: manifestSha256(manifest),
    manifestErrors: validateGenerationManifestV3(manifest, snapshot, source),
    providers: providerPlanFor(manifest),
    studyTime: estimateCourseStudyTime(studyTimeInputFromManifest(manifest, snapshot)),
  };
}

export function runPedagogyDryRun(input: DryRunInput): DryRunResult {
  const registry = input.registry ?? defaultApproachRegistry();
  const activityTypeRules: ActivityTypeRulesVersion = input.activityTypeRules ?? 2;
  if (activityTypeRules !== 0 && activityTypeRules !== 1 && activityTypeRules !== 2) {
    throw new Error(`DRY_RUN_INVALID: activityTypeRules ${JSON.stringify(activityTypeRules)} (0 | 1 | 2)`);
  }
  const base0 = isSnapshot(input.structure) ? snapshotFromSnapshot(input.structure) : snapshotFromStructure(input.structure as DryRunStructureInput);
  // Motor de carga horaria: el objetivo de horas viene del perfil (con o sin enfoque); sin él, el del snapshot recibido.
  const profileHours = profileTargetHours(input.profile);
  const base = profileHours !== null ? withTargetHours(base0, profileHours) : base0;
  const targetHours = base.course.targetHours ?? null;
  const profileEmpty = isEmptyPedagogicalProfile(input.profile);
  const profile = profileEmpty ? null : normalizePedagogicalProfile(input.profile, registry);
  const rules = profile ? deriveDesignRulesOrNull(profile, registry) : null;

  const baseline = side(base, activityTypeRules);
  let pedagogical: DryRunSide | null = null;
  let structureChanges: StructureChange[] = [];
  if (rules) {
    let shaped = base;
    if (input.applyStructureAdjustments !== false) {
      const proposal = proposeStructureAdjustments(base, rules);
      shaped = proposal.snapshot;
      structureChanges = proposal.changes;
    }
    pedagogical = side(applyPedagogyToSnapshot(shaped, rules), activityTypeRules);
  }

  const view = pedagogical ?? baseline;
  const baseItems = new Map(baseline.manifest.items.map((i) => [i.key, i]));
  const viewItems = new Map(view.manifest.items.map((i) => [i.key, i]));
  const chapters: DryRunChapterRow[] = [];
  const modules: DryRunResult['modules'] = [];
  const ped = view.blueprint.course.pedagogy ?? null;
  const baseChapterById = new Map(base.modules.flatMap((m) => m.chapters).map((c) => [c.id, c]));
  [...view.blueprint.modules].sort((a, b) => a.position - b.position).forEach((m, mi) => {
    modules.push({
      moduleNumber: mi + 1, moduleId: m.id, title: m.title, opening: m.design?.opening ?? null, closing: m.design?.closing ?? null,
      examEnabled: !!m.examEnabled, examStyle: ped && m.examEnabled ? ped.assessment.examStyle : null,
    });
  });
  for (const it of view.manifest.items) {
    if (it.type !== 'content') continue;
    const c = view.blueprint.modules.flatMap((m) => m.chapters).find((x) => x.id === it.chapterId)!;
    const b = baseChapterById.get(c.id)!;
    const d = c.design ? effectiveChapterDesign(view.blueprint, c.id) : null;
    chapters.push({
      moduleNumber: it.moduleNumber as number,
      chapterNumber: it.chapterNumber as number,
      chapterId: c.id,
      title: c.title,
      role: d?.role ?? null,
      sequence: d ? [...d.sequence] : null,
      contentType: d?.contentType ?? null,
      depth: d?.depth ?? null,
      video: { baselineEnabled: !!b.videoEnabled, enabled: !!c.videoEnabled, style: d && c.videoEnabled ? d.video.style : null, interactions: d && c.videoEnabled ? d.video.interactions : null },
      activity: {
        baselineEnabled: b.activityEnabled === true,
        enabled: c.activityEnabled === true,
        baselineType: (baseItems.get(`activity:${c.id}`)?.h5pType as string | undefined) ?? (baseItems.has(`activity:${c.id}`) ? 'rotación' : null),
        type: (viewItems.get(`activity:${c.id}`)?.h5pType as string | undefined) ?? (viewItems.has(`activity:${c.id}`) ? 'rotación' : null),
        intent: d && c.activityEnabled ? d.activity.intent : null,
      },
      scenario: d ? { ...d.scenario } : null,
      feedback: d ? { ...d.feedback } : null,
      resources: d ? [...d.resources] : null,
    });
  }

  const itemsAdded = [...viewItems.keys()].filter((k) => !baseItems.has(k));
  const itemsRemoved = [...baseItems.keys()].filter((k) => !viewItems.has(k));
  const h5pTypeChanges = chapters
    .filter((c) => c.activity.baselineType !== c.activity.type)
    .map((c) => ({ chapterId: c.chapterId, title: c.title, from: c.activity.baselineType, to: c.activity.type }));
  const itemsWithDesign = view.manifest.items.filter((i) => i.design !== undefined).length;
  const summary: string[] = [];
  if (!rules) summary.push('Sin perfil pedagógico: el diseño es el de siempre (línea base).');
  else {
    summary.push(`Enfoque: ${rules.approaches.map((a) => `${registry.get(a.id).shortLabel}${a.role === 'secondary' ? ' (secundario)' : ''}`).join(' + ')}.`);
    summary.push(`${itemsWithDesign} de ${view.manifest.items.length} trabajos llevan diseño pedagógico propio.`);
    if (structureChanges.length) summary.push(`${structureChanges.length} cambio(s) de estructura sugerido(s) (videos/actividades/repaso).`);
    if (h5pTypeChanges.length) summary.push(`${h5pTypeChanges.length} actividad(es) cambian de tipo por el diseño.`);
    if (itemsAdded.length || itemsRemoved.length) summary.push(`Trabajos: +${itemsAdded.length} / −${itemsRemoved.length} respecto de la línea base.`);
    const lint = lintObjectives(view.blueprint, rules).filter((l) => !l.ok).length;
    if (lint) summary.push(`${lint} objetivo(s) no cumplen el estilo del enfoque (con sugerencia).`);
  }

  return {
    dryRun: true,
    providersCalled: 0,
    spendUsd: '0.00',
    engineVersion: PEDAGOGY_ENGINE_VERSION,
    activityTypeRules,
    profile,
    profileEmpty,
    rules,
    targetHours,
    distribution: targetHours === null
      ? null
      : distributeCourseHours({ snapshot: view.blueprint, rules, targetHours, activityTypeRules: activityTypeRules === 2 ? 2 : 1 }),
    workload: targetHours === null
      ? null
      : {
        targetHours,
        estimatedHours: view.studyTime.courseEstimatedHours,
        deltaHours: Math.round((view.studyTime.courseEstimatedHours - targetHours) * 10) / 10,
      },
    baseline,
    pedagogical,
    structureChanges,
    objectives: rules ? lintObjectives(view.blueprint, rules) : [],
    modules,
    chapters,
    assessment: ped
      ? {
        strategy: ped.assessment.strategy, examStyle: ped.assessment.examStyle, finalExamStyle: ped.assessment.finalExamStyle,
        feedbackMode: ped.assessment.feedbackMode, feedbackTiming: ped.assessment.feedbackTiming, suggestedWeights: { ...ped.assessment.suggestedWeights },
      }
      : null,
    diff: {
      itemsAdded,
      itemsRemoved,
      h5pTypeChanges,
      itemsWithDesign,
      totals: { baseline: { ...(baseline.manifest.totals as any) }, pedagogical: pedagogical ? { ...(pedagogical.manifest.totals as any) } : null },
      estimateExpectedUsd: { baseline: baseline.providers.estimateUsd?.expected ?? null, pedagogical: pedagogical?.providers.estimateUsd?.expected ?? null },
      estimatedHours: { baseline: baseline.studyTime.courseEstimatedHours, pedagogical: pedagogical ? pedagogical.studyTime.courseEstimatedHours : null },
      summary,
    },
    appliedRules: rules ? rules.applied : [],
    generators: pedagogical ? generatorPlanFor(pedagogical, registry) : [],
    courseOverrides: pedagogical ? courseOverridesFor(pedagogical.blueprint) : [],
  };
}
