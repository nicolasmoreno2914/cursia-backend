import { academicOutcomeIds } from '../academic-context/academic-context';
import type { AcademicContextV1 } from '../academic-context/academic-context';
import { ALIGNMENT_RULESET, ALIGNMENT_VERSION, AlignmentReport, AlignmentUnavailable, buildAlignmentReport } from '../coherence/alignment';
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
import { createHash } from 'crypto';
import { estimateCost } from '../finops/estimator';
import type { RetryPolicy } from '../finops/estimator';
import type { PricingCatalogRow } from '../finops/pricing';
import type { DistributorRequirementConstraints } from '../academic-context/requirements/requirement-authority';
import { DeclaredHoursInput, DistributionResult, HoursReport, buildHoursReport, distributeCourseHours, estimateCourseStudyTime, estimateCourseStudyTimeDetailed, StudyTimeEstimate, studyTimeInputFromManifest, timeModelConfigOf } from '../study-time';
import { ITEM_TYPE_OPERATIONS, isFinopsItemType, providerOfOperation } from '../finops/operations';
import { estimateItemsForRun } from '../finops/run-budget';
import { usageModelPriorsV1 } from '../finops/usage-model';
import * as pricingSeedJson from '../finops/pricing-seed.v1.json';
import { PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import { AppliedRule, DesignRules, deriveDesignRulesOrNull } from './design-rules';
import {
  ObjectiveLint,
  PedagogicalActivityDecision,
  StructureChange,
  applyPedagogyToSnapshot,
  choosePedagogicalActivityTypes,
  effectiveChapterDesign,
  lintObjectives,
  proposeStructureAdjustments,
} from './pedagogical-blueprint';
import { ItemPedagogyBrief, OverrideLevel, PEDAGOGY_GENERATOR_COVERAGE, buildItemPedagogyBrief } from './generator-directives';
import { PedagogicalProfile, isEmptyPedagogicalProfile, normalizePedagogicalProfile, profileApplicationContext, profileContentChaptersMax, profileDesignPreferences, profileHoursModel, profileTargetHours } from './pedagogy-profile';
import { LearningType, PEDAGOGY_ENGINE_VERSION } from './vocabulary';
import { ChapterLearningTypeDesign, LEARNING_TYPE_LABELS, classifyLearningType, learningTypeJustification } from './learning-type';
import { defaultFrameworkRegistry, frameworkSlotLabels } from './instructional-frameworks';
import { profileLearningPlan, profileActivityKinds } from './pedagogy-profile';
import { ActivityKindsReport, assignApplicationKinds } from '../study-time/activity-kinds';
import { TierLockRow, isTierSelectable } from '../course-shell/application-kinds';
import { PracticeMixEvaluation, evaluatePracticeMix } from '../study-time/practice-mix';

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
  /** Fase 2: minutos de la Actividad de Aplicación (30/60/90/120; ausente/null = sin actividad). */
  applicationMinutes?: number | null;
  /** Loop 9 B: minutos de la práctica guiada (40/60/80/120; ausente/null/0 = sin práctica guiada; solo contenido). */
  guidedPracticeMinutes?: number | null;
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
  /** Fase 4: datos del contexto académico que no viven en el Blueprint (P2: ¿declara conocimientos previos?). */
  alignment?: { priorKnowledgeDeclared?: boolean | null };
  /** LOOP 8.3: valores fijados por el docente (courses.metadata.designPins) que el distribuidor respeta. */
  designPins?: Record<string, { video?: boolean }> | null;
  /** LOOP 8.6C: requisitos obligatorios del documento que el distribuidor cumple (null = sin requisitos). */
  requirementConstraints?: DistributorRequirementConstraints | null;
  /**
   * r58 (I3): pedir el registro de horas (`hoursReport`) — con las horas del documento si las hay. Sin pedirlo y sin
   * `hoursModel` en el perfil, el resultado no lleva la clave (salida byte a byte la de antes).
   */
  hoursReport?: boolean | { declared?: DeclaredHoursInput | null };
  /**
   * r79 (F2 · una sola cifra de costo): catálogo de precios y política de reintentos con los que se estima el costo. Los
   * servicios pasan los MISMOS que usa la «Estimación de producción» (`pricing_catalog` de la base y
   * `readEstimateRetryPolicy`). Ausente = el seed versionado con 1 reintento (lógica pura de siempre: checks y goldens).
   */
  pricing?: DryRunPricing | null;
  /**
   * r79 · búsqueda del ajuste al presupuesto: omite lo que NO entra en `distribution` (briefs de los generadores, toggles
   * del curso, lint de objetivos y alineación del diseño actual). `distribution` sale idéntica (lo prueba
   * check-r79-budget-fit.js). Ausente = salida completa de siempre.
   */
  distributionOnly?: boolean;
  /**
   * r79.1 · candado de proporcionalidad de los niveles de la Actividad (§12.1). Ausente = el de la especificación vigente
   * (course-shell/application-kinds.ts, `applicationTierLock()`); los checks pasan otro para probar el candado cerrado.
   */
  tierLock?: readonly TierLockRow[] | null;
}

/** r79 (F2): precios de la estimación en seco. `source` dice de dónde salió el catálogo (se informa en la respuesta). */
export interface DryRunPricing {
  catalog: readonly PricingCatalogRow[];
  retryPolicy: RetryPolicy;
  /** Instante de los precios (las filas vigentes en ese momento); ausente = filas abiertas. */
  asOf?: string | Date | null;
  source: 'pricing_catalog' | 'seed_fallback';
}

/** r79 · Gamma: texto obligatorio de toda estimación que depende de Gamma mientras su precio no esté verificado. */
export const GAMMA_PROVISIONAL_LABEL = 'estimación provisional (precio de Gamma sin verificar)';

export interface ProviderPlan {
  /** Por proveedor: operaciones que se ejecutarían al generar (nada se ejecuta en el dry-run). */
  byProvider: Record<string, { items: number; operations: Record<string, number> }>;
  estimateUsd: { min: string; expected: string; max: string; byProvider: Record<string, string> } | null;
  estimateNote: string;
  /**
   * LOOP 7 (A3 I3/I4/I7): desglose por categoría (esperado, USD) — audiovisual (video, presentaciones, audio y guion
   * del audiolibro), Actividades de Aplicación, texto con IA —, proveedores con tarifa PROVISIONAL (no verificada) y
   * los supuestos del estimado. Ausentes si no hay estimación.
   */
  byCategory?: { audiovisual: string; application: string; text: string };
  unverifiedProviders?: string[];
  assumptions?: string[];
  /** r79 (F2): de dónde salieron los precios (SOLO si se pasaron precios; sin ellos, la salida de siempre). */
  pricingSource?: DryRunPricing['source'];
  /**
   * r79 · Gamma: la estimación depende de Gamma y su precio por crédito no está verificado (SOLO si se pasaron precios).
   * Mientras sea así, la cifra se rotula como provisional y no es una estimación comercial definitiva.
   */
  provisionalPricing?: { gamma: boolean; label: string | null };
  /** r79: esperado (USD) y cantidad por tipo de item (SOLO si se pasaron precios): explica el costo mínimo. */
  byItemType?: Record<string, { expected: string; items: number }>;
}

/** LOOP 7: categoría de costo visible de un tipo de item (fuente única para panel, impacto y modal). */
export const COST_CATEGORY_OF_ITEM_TYPE: Readonly<Record<string, 'audiovisual' | 'application' | 'text'>> = Object.freeze({
  video: 'audiovisual', presentation: 'audiovisual', audio_welcome: 'audiovisual', audiobook_chapter: 'audiovisual',
  application_activity: 'application',
  // Loop 9 B (fix M2): los ejercicios guiados son texto formativo del capítulo (nunca «Actividades de Aplicación»).
  guided_practice: 'text',
});
export const ESTIMATE_ASSUMPTIONS: readonly string[] = Object.freeze([
  'Es una estimación: el uso de cada recurso sale de un modelo típico por tipo (aún no medido con cursos reales), no del contenido de tu curso.',
  'El texto con IA se valúa con el modelo recomendado (Sonnet 4.6); con un modelo más económico costaría menos.',
  'Cada recurso puede necesitar un reintento: por eso hay un rango.',
]);

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
  /**
   * T2 (r57): SOLO con plan de aprendizaje — tipo de aprendizaje con su justificación (regla + evidencia, puntos de
   * cada tipo) y la decisión de la actividad calificada (regla de la tabla, candidatos y por qué quedó ese tipo).
   */
  learningType?: ChapterLearningTypeDesign & { label: string; justification: string; scores: Partial<Record<LearningType, number>> };
  framework?: { id: string; label: string; phaseLabels: Partial<Record<string, string>> };
  activityDecision?: { type: string; reason: PedagogicalActivityDecision['reason']; ruleId: string; candidates: string[]; rationale: string } | null;
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
   * r58 (I3): registro de horas (líneas por recurso con categoría, base, evidencia, regla y configuración; declarado /
   * objetivo / estimado / asignado / observado / gap). Del diseño que se congelaría (la propuesta materializada si hay
   * distribución; si no, la vista final). SOLO si se pidió (`hoursReport`) o el perfil trae `hoursModel`.
   */
  hoursReport?: HoursReport;
  /**
   * Motor de carga horaria (Loop 3): diseño propuesto por el distribuidor para alcanzar targetHours (null sin
   * objetivo). Solo propuesta: no cambia el Blueprint ni el Manifest de este dry-run.
   */
  distribution: (DistributionResult & {
    materialized: DistributionMaterialized;
    proposalSha256: string;
    /** r79: tope de capítulos de contenido por módulo que fijó el ajuste al presupuesto (solo si existe). */
    contentChaptersMax?: number;
    /** r79.1: tipos de Actividad asignados y por qué (solo con la preferencia «Tipos de actividad: automático»). */
    activityKinds?: ActivityKindsReport;
    /** T3 (r57): mezcla de práctica del plan de aprendizaje (solo si está configurada). */
    practiceMix?: Pick<PracticeMixEvaluation, 'status' | 'ruleId' | 'plan' | 'fit' | 'notes'>;
  }) | null;
  /**
   * Fase 4 · Coherence Engine (capa A): alineación resultado → evidencia del diseño que se ve (con diseño pedagógico si
   * hay perfil). La clave existe SOLO si el Blueprint trae contexto académico (los dry-runs de siempre no cambian).
   */
  alignment?: AlignmentReport | AlignmentUnavailable;
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
  /**
   * T2 (r57): SOLO si el perfil activa el plan de aprendizaje — marco del curso con sus fases y las fijaciones del
   * docente que no corresponden a ningún capítulo de la estructura (se ignoran al congelar; se muestran para corregir).
   */
  learningPlan?: {
    framework: { id: string; label: string; summary: string; phases: { id: string; order: number; label: string; studentLabel: string; slots: string[]; required: boolean; elements: string[] }[] };
    phaseLabels: boolean;
    unknownOverrides: string[];
  };
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
        ...(c.applicationMinutes !== undefined ? { application_minutes: c.applicationMinutes } : {}),
        ...(c.guidedPracticeMinutes !== undefined ? { guided_practice_minutes: c.guidedPracticeMinutes } : {}),
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

/**
 * Motor de carga horaria: la propuesta del distribuidor llevada a un Blueprint EN MEMORIA (capítulos propuestos
 * con ids deterministas; los de práctica con kind) y por el Manifest real, su validador, el modelo de tiempo y el
 * estimador de costo. Prueba que el diseño propuesto es representable y dice cuánto costaría generarlo HOY (sin
 * las Actividades de aplicación, que son Fase 2). No se guarda nada.
 */
export interface DistributionMaterialized {
  /** null si la materialización falló (el error va en manifestErrors). */
  blueprintSha256: string | null;
  manifestSha256: string | null;
  manifestErrors: { code: string; message: string; key?: string }[];
  items: number;
  totals: Record<string, number>;
  providers: ProviderPlan;
  /** Horas del Manifest materializado (deben ser las `generableHours` del distribuidor); null si falló. */
  generableHours: number | null;
  /** Fase 4: alineación del diseño PROPUESTO (solo con contexto académico). */
  alignment?: AlignmentReport | AlignmentUnavailable;
}

/** Fase 4: reporte de alineación de un lado del dry-run (undefined sin contexto académico). */
function alignmentOf(s: DryRunSide, extras: DryRunInput['alignment'], registry: PedagogicalApproachRegistry): AlignmentReport | AlignmentUnavailable | undefined {
  if (!s.blueprint.course.academicContext) return undefined;
  // Review F4 M4: un fallo de la alineación nunca rompe el dry-run ni se disfraza de «propuesta no materializable».
  try {
    const r: AlignmentReport | AlignmentUnavailable = buildAlignmentReport({
      snapshot: s.blueprint, manifest: s.manifest, studyTime: s.studyTime, blueprintSha256: s.blueprintSha256,
      priorKnowledgeDeclared: extras?.priorKnowledgeDeclared ?? null, registry,
    });
    return r.available ? r : undefined;
  } catch {
    return { alignmentVersion: ALIGNMENT_VERSION, ruleset: ALIGNMENT_RULESET, available: false, reason: 'ALIGNMENT_FAILED' };
  }
}

/**
 * Fase 2 · «Aplicar diseño»: huella de la propuesta (estructura + actividades + preferencias). El servidor recalcula
 * la propuesta al aplicar y exige la MISMA huella que vio el docente (si la estructura o el perfil cambiaron, 409).
 */
export function distributionProposalSha256(dist: DistributionResult, extra?: { contentChaptersMax?: number | null } | null): string {
  const canon = {
    targetHours: dist.targetHours,
    preferences: dist.preferences,
    // r79: el tope de capítulos de contenido por módulo del ajuste al presupuesto entra a la huella SOLO si existe (sin él,
    // la huella de siempre: ninguna propuesta aprobada cambia).
    ...(extra && typeof extra.contentChaptersMax === 'number' ? { contentChaptersMax: extra.contentChaptersMax } : {}),
    modules: dist.modules.map((m) => ({
      id: m.id,
      // Loop 9 B: la práctica guiada entra a la huella solo si el capítulo la tiene (las propuestas sin ella, huella de siempre).
      // r79.1: el tipo de la Actividad entra a la huella solo si el capítulo lo tiene (sin tipos, huella de siempre).
      chapters: m.chapters.map((c) => ({ id: c.id, proposed: c.proposed, kind: c.kind, title: c.title, objective: c.objective, videoEnabled: c.videoEnabled, activityEnabled: c.activityEnabled, applicationMinutes: c.applicationMinutes, ...(c.applicationKind ? { applicationKind: c.applicationKind } : {}), ...(c.guidedPracticeMinutes ? { guidedPracticeMinutes: c.guidedPracticeMinutes } : {}) })),
    })),
  };
  return createHash('sha256').update(JSON.stringify(canon), 'utf8').digest('hex');
}

/** UUID v4 determinista para un capítulo propuesto (solo en el dry-run). */
export function proposedChapterUuid(id: string): string {
  const h = createHash('sha256').update(id, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * LOOP 8.4 (review L84-2 N4) · Un capítulo de CONTENIDO que propone el diseño (profundización) trabaja los resultados de su
 * módulo: hereda la unión de los vínculos de sus capítulos de contenido. Así no aparece «sin resultado» después de aplicar
 * ni se le pide al docente algo que el sistema puede decidir. Las prácticas no heredan (como en la vinculación automática).
 */
export function moduleOutcomeIds(chapters: { module_id: string; outcome_ids?: unknown; chapter_kind?: unknown }[], moduleId: string, known?: ReadonlySet<string> | null): string[] {
  const set = new Set<string>();
  for (const c of chapters) {
    if (c.module_id !== moduleId || c.chapter_kind === 'practice') continue;
    const ids = typeof c.outcome_ids === 'string' ? JSON.parse(c.outcome_ids) : c.outcome_ids;
    // Review L84-3 Mn2: un vínculo a un resultado que el contexto vigente ya no define no se hereda.
    if (Array.isArray(ids)) for (const x of ids) if (typeof x === 'string' && (!known || known.has(x))) set.add(x);
  }
  return [...set].sort();
}

export function materializeDistribution(base: BlueprintSnapshotV2, dist: DistributionResult, applicationContext: unknown = null): BlueprintSnapshotV2 {
  const rows = snapshotV2ToRows(base);
  // Fase 2: el contexto del perfil que congelaría el lock (entra solo si la propuesta tiene Actividades de Aplicación).
  if (applicationContext !== null && applicationContext !== undefined) rows.course = { ...rows.course, applicationContext };
  const byId = new Map(rows.chapters.map((c) => [c.id, c]));
  const ctx = rows.course && (rows.course as { academicContext?: unknown }).academicContext;
  const knownOutcomes = ctx && typeof ctx === 'object' ? academicOutcomeIds(ctx as AcademicContextV1) : null;
  const chapters: RawChapterRowV2[] = [];
  for (const m of dist.modules) {
    m.chapters.forEach((c, ci) => {
      const existing = byId.get(c.id);
      if (existing) {
        // Fase 2: la propuesta fija (o quita) la Actividad de Aplicación de cada capítulo existente.
        // LOOP 8.3: y el video de los capítulos de contenido (prioridad audiovisual / valores fijados por el docente).
        chapters.push({ ...existing, position: ci, application_minutes: c.applicationMinutes ?? null, application_kind: c.applicationKind ?? null, ...(c.kind === 'content' ? { video_enabled: c.videoEnabled } : {}),
          // Loop 9 B: la propuesta fija (o quita) la práctica guiada de cada capítulo de contenido.
          guided_practice_minutes: c.kind === 'content' ? c.guidedPracticeMinutes ?? null : null });
        return;
      }
      const inherited = c.kind === 'practice' ? [] : moduleOutcomeIds(rows.chapters, m.id, knownOutcomes);
      chapters.push({
        id: proposedChapterUuid(c.id), module_id: m.id, position: ci, title: c.title, objective: c.objective, description: null,
        video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled, ...(c.kind === 'practice' ? { chapter_kind: 'practice' } : {}),
        application_minutes: c.applicationMinutes ?? null,
        ...(c.applicationKind ? { application_kind: c.applicationKind } : {}),
        ...(c.kind === 'content' && c.guidedPracticeMinutes ? { guided_practice_minutes: c.guidedPracticeMinutes } : {}),
        ...(inherited.length ? { outcome_ids: inherited } : {}),
      });
    });
  }
  // Misma validación de entrada que el camino real (snapshotFromSnapshot / lock): títulos, video en práctica, etc.
  const errors = validateBlueprintInputV2(rows.course, rows.modules, chapters);
  if (errors.length > 0) {
    throw new Error(`DISTRIBUTION_MATERIALIZE_INVALID: ${errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`);
  }
  return buildBlueprintSnapshotV2(rows.course, rows.modules, chapters);
}

/**
 * LOOP 7 (A2 A4): la tarjeta y lo que se congela salen de dos cálculos (distribuidor vs Manifest materializado).
 * Cualquier diferencia de horas o de conteos es un error visible (nunca una tarjeta que miente en silencio).
 */
export function distributionModelMismatch(
  dist: DistributionResult,
  ms: { manifest: GenerationManifestV1; studyTime: StudyTimeEstimate },
): { code: string; message: string }[] {
  const t = ms.manifest.totals as unknown as Record<string, number | undefined>;
  const n = (k: string) => Number(t[k] ?? 0);
  const pairs: [string, number, number][] = [
    ['horas', dist.estimatedHours, ms.studyTime.courseEstimatedHours],
    ['capítulos', dist.counts.chapters, n('experienceCount')],
    ['capítulos con video', dist.counts.videoChapters, n('videoCount')],
    ['actividades', dist.counts.activities, n('activityCount')],
    ['Actividades de Aplicación', dist.counts.applicationActivities, n('applicationActivityCount')],
    ['ejercicios guiados', dist.counts.guidedPractices ?? 0, n('guidedPracticeCount')],
    ['evaluaciones', dist.counts.evaluations, n('examCount') + n('finalExamCount')],
  ];
  const off = pairs.filter(([, a, b]) => Math.abs(a - b) > 1e-6);
  return off.length
    ? [{ code: 'DISTRIBUTION_MODEL_MISMATCH', message: `DISTRIBUTION_MODEL_MISMATCH: la propuesta no coincide con su Manifest (${off.map(([k, a, b]) => `${k} ${a} ≠ ${b}`).join('; ')}); no se puede aplicar.` }]
    : [];
}

/**
 * La propuesta materializada; si falla (bug del materializador o diseño no representable) el error queda VISIBLE en
 * `manifestErrors` sin tumbar la línea base ni la vista pedagógica del dry-run.
 */
export function materializeOrError(
  base: BlueprintSnapshotV2,
  dist: DistributionResult,
  build: (plain: BlueprintSnapshotV2) => DistributionMaterialized,
  applicationContext: unknown = null,
): DistributionMaterialized {
  try {
    return build(materializeDistribution(base, dist, applicationContext));
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    return {
      blueprintSha256: null,
      manifestSha256: null,
      manifestErrors: [{ code: 'DISTRIBUTION_MATERIALIZE_FAILED', message }],
      items: 0,
      totals: {},
      providers: { byProvider: {}, estimateUsd: null, estimateNote: `Sin estimación de costo: la propuesta no se pudo materializar (${message})` },
      generableHours: null,
    };
  }
}

/**
 * Fase 2: el mismo snapshot con el contexto de las Actividades de Aplicación del perfil (el builder lo congela solo
 * si algún capítulo tiene una; si no, el snapshot no cambia).
 */
export function withApplicationContext(s: BlueprintSnapshotV2, applicationContext: unknown): BlueprintSnapshotV2 {
  const rows = snapshotV2ToRows(s);
  return buildBlueprintSnapshotV2({ ...rows.course, applicationContext }, rows.modules, rows.chapters, rows.pedagogy);
}

/** r58 (I3): el mismo snapshot con `course.hoursModel` (pasa por el builder: forma canónica y validación). */
export function withHoursModel(s: BlueprintSnapshotV2, hoursModel: unknown): BlueprintSnapshotV2 {
  const rows = snapshotV2ToRows(s);
  return buildBlueprintSnapshotV2({ ...rows.course, hoursModel }, rows.modules, rows.chapters, rows.pedagogy);
}

/** El mismo snapshot con `course.targetHours` (pasa por el builder: orden canónico y validación). */
/**
 * r79 · El tope de capítulos de contenido por módulo del ajuste al presupuesto como restricción del distribuidor: el
 * máximo más bajo entre el del documento y el tope, y nunca por debajo del mínimo que exige el documento (los contenidos
 * del documento no se recortan por presupuesto). Sin tope, las restricciones de siempre (mismo objeto).
 */
export function withContentChaptersCap(rq: DistributorRequirementConstraints | null, cap: number | null, modules?: number): DistributorRequirementConstraints | null {
  if (cap === null) return rq;
  const docMin = rq?.contentChaptersPerModule?.min ?? 0;
  const docMax = rq?.contentChaptersPerModule?.max;
  const max = Math.max(docMin, docMax !== undefined ? Math.min(docMax, cap) : cap);
  const base: DistributorRequirementConstraints = rq ? { ...rq } : { sources: {} };
  // Con el tope, la forma (módulos actuales × hasta N contenidos) queda fija para el distribuidor: la diferencia de horas
  // se completa con lo que el distribuidor ya hace con una forma fija (capítulos de práctica, Actividades de Aplicación y
  // ejercicios guiados, cada uno con su especificación), nunca agregando módulos ni alargando tiempos.
  return { ...base, contentChaptersPerModule: { ...(rq?.contentChaptersPerModule ?? {}), max }, ...(typeof rq?.modulesFixed !== 'number' && typeof modules === 'number' ? { modulesFixed: modules } : {}) };
}

export function withTargetHours(s: BlueprintSnapshotV2, targetHours: number | null): BlueprintSnapshotV2 {
  const rows = snapshotV2ToRows(s);
  return buildBlueprintSnapshotV2({ ...rows.course, targetHours }, rows.modules, rows.chapters, rows.pedagogy);
}

/** r79: los precios del seed como `DryRunPricing` (lo que usa la lógica pura cuando la base no responde). */
export function seedPricing(): DryRunPricing {
  return { catalog: seedCatalog(), retryPolicy: { maxRetries: 1 }, asOf: null, source: 'seed_fallback' };
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
export function providerPlanFor(manifest: GenerationManifestV1, opts?: { coverageItems?: GenerationManifestV1['items']; pricing?: DryRunPricing | null }): ProviderPlan {
  const pricing = opts?.pricing ?? null;
  const catalog = pricing ? pricing.catalog : seedCatalog();
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
  let estimateNote = pricing && pricing.source === 'pricing_catalog'
    ? 'Estimación con el catálogo de precios vigente (el mismo de la «Estimación de producción») y el modelo de uso v1. Nada se ejecuta ni se cobra en el dry-run.'
    : 'Estimación con los precios del seed versionado (pricing-seed.v1) y el modelo de uso v1. Nada se ejecuta ni se cobra en el dry-run.';
  try {
    const items = estimateItemsForRun(manifest.items, 'real', null, opts?.coverageItems ? { coverageItems: opts.coverageItems } : null);
    const est = estimateCost({ items, catalog, usageModel: usageModelPriorsV1(), retryPolicy: pricing ? pricing.retryPolicy : { maxRetries: 1 }, ...(pricing && pricing.asOf ? { pricingAsOf: pricing.asOf } : {}) });
    const byP: Record<string, string> = {};
    for (const k of Object.keys(est.totals.byProvider).sort()) byP[k] = est.totals.byProvider[k].expected;
    estimateUsd = { min: est.totals.min, expected: est.totals.expected, max: est.totals.max, byProvider: byP };
    const cat = { audiovisual: 0, application: 0, text: 0 };
    for (const [type, v] of Object.entries(est.totals.byItemType)) cat[COST_CATEGORY_OF_ITEM_TYPE[type] ?? 'text'] += Number(v.expected);
    const unverified = new Set<string>();
    for (const l of est.lines) {
      // Los multiplicadores de caché son derivados (×1,25 / ×0,1 de la tarifa verificada) y de peso marginal: no
      // vuelven «provisional» a un proveedor cuyas tarifas principales están verificadas.
      // r79: la fila USADA (las líneas copian su verificación); sin precios propios, el seed como siempre.
      if (pricing) {
        const used = (l as { pricingVersions?: string[] }).pricingVersions ?? [];
        const rows = catalog.filter((r) => r.provider === l.provider && r.product_or_model === l.product && !/^cache_/.test(String(r.meter)) && used.includes(String(r.pricing_version)));
        if (!rows.length || rows.some((r) => r.verified !== true)) unverified.add(l.provider);
        continue;
      }
      const rows = seedCatalog().filter((r) => r.provider === l.provider && r.product_or_model === l.product && !/^cache_/.test(String(r.meter)));
      if (rows.some((r) => r.verified !== true)) unverified.add(l.provider);
    }
    const unverifiedProviders = [...unverified].sort();
    const gammaProvisional = !!pricing && unverifiedProviders.includes('gamma') && Number(est.totals.byProvider.gamma?.expected ?? 0) > 0;
    return {
      byProvider: sorted, estimateUsd, estimateNote,
      byCategory: { audiovisual: cat.audiovisual.toFixed(2), application: cat.application.toFixed(2), text: cat.text.toFixed(2) },
      unverifiedProviders,
      assumptions: [...ESTIMATE_ASSUMPTIONS, ...(unverifiedProviders.length ? [`Tarifa provisional (no verificada con la factura) para: ${unverifiedProviders.join(', ')}.`] : []),
        ...(gammaProvisional ? [`Es una ${GAMMA_PROVISIONAL_LABEL}: no es una estimación comercial definitiva.`] : [])],
      ...(pricing ? {
        pricingSource: pricing.source, provisionalPricing: { gamma: gammaProvisional, label: gammaProvisional ? GAMMA_PROVISIONAL_LABEL : null },
        byItemType: Object.fromEntries(Object.keys(est.totals.byItemType).sort().map((t) => [t, { expected: est.totals.byItemType[t].expected, items: items.filter((i) => i.itemType === t).length }])),
      } : {}),
    };
  } catch (e) {
    estimateNote = `Sin estimación de costo: ${(e as Error).message}`;
  }
  return { byProvider: sorted, estimateUsd, estimateNote };
}

function side(snapshot: BlueprintSnapshotV2, activityTypeRules: ActivityTypeRulesVersion, pricing: DryRunPricing | null = null, skipCost = false): DryRunSide {
  const sha = snapshotSha256V2(snapshot);
  const source: ManifestSource = { courseId: snapshot.course.id, ...DRY_RUN_SOURCE_BASE, blueprintSha256: sha };
  const manifest = buildGenerationManifestV3(snapshot, source, { activityTypeRules });
  return {
    blueprint: snapshot,
    blueprintSha256: sha,
    manifest,
    manifestSha256: manifestSha256(manifest),
    manifestErrors: validateGenerationManifestV3(manifest, snapshot, source),
    providers: skipCost ? { byProvider: {}, estimateUsd: null, estimateNote: 'Sin estimación: búsqueda del ajuste al presupuesto (solo se estima el diseño propuesto).' } : providerPlanFor(manifest, pricing ? { pricing } : undefined),
    studyTime: estimateCourseStudyTime(studyTimeInputFromManifest(manifest, snapshot), timeModelConfigOf(snapshot)),
  };
}

/** r58 (I3): registro de horas de un lado del dry-run (mismo modelo y misma configuración que su `studyTime`). */
function hoursReportOf(sd: { blueprint: BlueprintSnapshotV2; manifest: GenerationManifestV1 }, declared: DeclaredHoursInput | null, hoursBounds: { min?: number; max?: number } | null): HoursReport {
  const cfg = timeModelConfigOf(sd.blueprint);
  const { estimate, lines } = estimateCourseStudyTimeDetailed(studyTimeInputFromManifest(sd.manifest, sd.blueprint), cfg);
  return buildHoursReport({ stage: 'design', estimate, lines, config: cfg, targetHours: sd.blueprint.course.targetHours ?? null, hoursBounds, declared });
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
  const base1h = profileHours !== null ? withTargetHours(base0, profileHours) : base0;
  // r58 (I3): configuración propia del modelo de tiempo del perfil (lo mismo que congela el lock; sin ella, nada cambia).
  const profileHm = profileHoursModel(input.profile);
  const base1 = profileHm ? withHoursModel(base1h, profileHm) : base1h;
  const wantHoursReport = (input.hoursReport !== undefined && input.hoursReport !== false) || profileHm !== null;
  let materializedSide: { blueprint: BlueprintSnapshotV2; manifest: GenerationManifestV1 } | null = null;
  // Fase 2: estudiante + resultados de aprendizaje del perfil (lo mismo que congela el lock).
  const appContext = profileApplicationContext(input.profile);
  const base = appContext ? withApplicationContext(base1, appContext) : base1;
  const targetHours = base.course.targetHours ?? null;
  const profileEmpty = isEmptyPedagogicalProfile(input.profile);
  const profile = profileEmpty ? null : normalizePedagogicalProfile(input.profile, registry);
  const rules = profile ? deriveDesignRulesOrNull(profile, registry) : null;

  const pricing = input.pricing ?? null;
  const lite = input.distributionOnly === true;
  // r79.1 (rendimiento): en la búsqueda del ajuste (distributionOnly) no se arman la línea base ni la vista pedagógica
  // (Blueprint + Manifest + validación + tiempo de cada lado): la propuesta del distribuidor no las usa. `distribution` sale
  // idéntica (BF19); `baseline`/`pedagogical`/`chapters`/`workload` quedan vacíos en ese modo (nadie más lo usa).
  if (lite) return liteDryRun(input, base, rules, profile, profileEmpty, targetHours, activityTypeRules, registry, appContext, pricing, profileHm);
  const baseline = side(base, activityTypeRules, pricing, lite);
  let pedagogical: DryRunSide | null = null;
  let structureChanges: StructureChange[] = [];
  if (rules) {
    let shaped = base;
    if (input.applyStructureAdjustments !== false) {
      const proposal = proposeStructureAdjustments(base, rules);
      shaped = proposal.snapshot;
      structureChanges = proposal.changes;
    }
    pedagogical = side(applyPedagogyToSnapshot(shaped, rules), activityTypeRules, pricing, lite);
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
  // T2 (r57): decisiones de la actividad con el plan de aprendizaje (mismas funciones que el Manifest).
  const planOn = !!ped?.learningPlan;
  const decisions = planOn ? choosePedagogicalActivityTypes(view.blueprint, activityTypeRules) : null;
  for (const it of view.manifest.items) {
    if (it.type !== 'content') continue;
    const c = view.blueprint.modules.flatMap((m) => m.chapters).find((x) => x.id === it.chapterId)!;
    const b = baseChapterById.get(c.id)!;
    const d = c.design ? effectiveChapterDesign(view.blueprint, c.id) : null;
    const lt = d?.learningType as ChapterLearningTypeDesign | undefined;
    const dec = decisions?.get(c.id);
    const planFields = planOn && lt && d
      ? {
        learningType: { ...lt, label: LEARNING_TYPE_LABELS[lt.type], justification: learningTypeJustification(lt), scores: classifyLearningType(c).scores },
        framework: (() => {
          const fw = defaultFrameworkRegistry().get(d.framework as string);
          return { id: fw.id, label: fw.label, phaseLabels: frameworkSlotLabels(fw) };
        })(),
        activityDecision: dec?.learningType
          ? { type: dec.type, reason: dec.reason, ruleId: dec.learningType.ruleId, candidates: [...dec.learningType.candidates], rationale: dec.learningType.rationale }
          : null,
      }
      : {};
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
      ...planFields,
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

  // Fase 4: la alineación del diseño ACTUAL se mide sobre lo que el lock congelaría hoy (estructura viva + diseño), no
  // sobre la vista con los cambios de estructura sugeridos (esos no se aplican solos y ocultarían vacíos reales).
  const alignment = base.course.academicContext && !lite
    ? alignmentOf(rules ? side(applyPedagogyToSnapshot(base, rules), activityTypeRules) : baseline, input.alignment, registry)
    : undefined;
  const learningPlan = (() => {
    if (!planOn || !rules?.learningPlan) return undefined;
    const fw = defaultFrameworkRegistry().get(rules.learningPlan.framework);
    const lp = profileLearningPlan(profile)!;
    const ids = new Set(view.blueprint.modules.flatMap((m) => [m.id, ...m.chapters.map((c) => c.id)]));
    const unknownOverrides = [...Object.keys(lp.chapterOverrides ?? {}), ...Object.keys(lp.moduleFrameworks ?? {})].filter((k) => !ids.has(k)).sort();
    return {
      framework: { id: fw.id, label: fw.label, summary: fw.summary, phases: fw.phases.map((p) => ({ id: p.id, order: p.order, label: p.label, studentLabel: p.studentLabel, slots: [...p.slots], required: p.required, elements: [...p.elements] })) },
      phaseLabels: ped!.learningPlan!.phaseLabels,
      unknownOverrides,
    };
  })();
  if (learningPlan) {
    summary.push(`Metodología: ${learningPlan.framework.label}${learningPlan.phaseLabels ? ' (fases visibles en el curso)' : ''}.`);
    const byType = new Map<string, number>();
    for (const ch of chapters) if (ch.learningType) byType.set(ch.learningType.label, (byType.get(ch.learningType.label) ?? 0) + 1);
    summary.push(`Tipos de aprendizaje: ${[...byType.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}.`);
    if (learningPlan.unknownOverrides.length) summary.push(`${learningPlan.unknownOverrides.length} ajuste(s) del plan apuntan a capítulos o módulos que ya no existen (se ignoran).`);
  }
  const out: DryRunResult = {
    ...(alignment ? { alignment } : {}),
    ...(learningPlan ? { learningPlan } : {}),
    dryRun: true,
    providersCalled: 0,
    spendUsd: '0.00',
    engineVersion: PEDAGOGY_ENGINE_VERSION,
    activityTypeRules,
    profile,
    profileEmpty,
    rules,
    targetHours,
    distribution: targetHours === null ? null : distributionFor(input, base, rules, targetHours, activityTypeRules, registry, appContext, pricing, profileHm, chapters, planOn, (ms) => { materializedSide = ms; }),
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
    objectives: rules && !lite ? lintObjectives(view.blueprint, rules) : [],
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
    generators: pedagogical && !lite ? generatorPlanFor(pedagogical, registry) : [],
    courseOverrides: pedagogical && !lite ? courseOverridesFor(pedagogical.blueprint) : [],
  };
  if (!wantHoursReport) return out;
  // r58 (I3): el registro de horas del diseño que se congelaría (propuesta materializada; si no hay, la vista final).
  const declared = typeof input.hoursReport === 'object' && input.hoursReport ? input.hoursReport.declared ?? null : null;
  const sd = materializedSide ?? view;
  return { ...out, hoursReport: hoursReportOf(sd, declared, input.requirementConstraints?.hoursBounds ?? null) };
}

const DIST_MEMO = new WeakMap<object, Map<string, DistributionResult>>();
const DIST_MEMO_MAX = 4000;
function memoDistributor(input: DryRunInput, lock: readonly TierLockRow[] | null, run: () => DistributionResult): DistributionResult {
  const owner = input.structure as unknown as object;
  if (!owner || typeof owner !== 'object') return run();
  const p = (input.profile && typeof input.profile === 'object' ? JSON.parse(JSON.stringify(input.profile)) : input.profile) as any;
  if (p && p.designPreferences) delete p.designPreferences.activityKinds;
  let key: string;
  try {
    key = JSON.stringify({ p, pins: input.designPins ?? null, rq: input.requirementConstraints ?? null, atr: input.activityTypeRules ?? 2, lock, adj: input.applyStructureAdjustments ?? true, reg: input.registry ? 'custom' : 'default' });
  } catch {
    return run();
  }
  if (input.registry) return run();
  let m = DIST_MEMO.get(owner);
  if (!m) { m = new Map(); DIST_MEMO.set(owner, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const r = run();
  if (m.size >= DIST_MEMO_MAX) m.clear();
  m.set(key, r);
  return r;
}

/** La propuesta del distribuidor materializada (la misma en el dry-run completo y en el liviano). */
function distributionFor(
  input: DryRunInput,
  base: BlueprintSnapshotV2,
  rules: DesignRules | null,
  targetHours: number,
  activityTypeRules: ActivityTypeRulesVersion,
  registry: PedagogicalApproachRegistry,
  appContext: ReturnType<typeof profileApplicationContext>,
  pricing: DryRunPricing | null,
  profileHm: ReturnType<typeof profileHoursModel>,
  chapters: DryRunChapterRow[],
  planOn: boolean,
  onMaterialized: (ms: { blueprint: BlueprintSnapshotV2; manifest: GenerationManifestV1 }) => void,
): NonNullable<DryRunResult['distribution']> {
  let materializedSide: { blueprint: BlueprintSnapshotV2; manifest: GenerationManifestV1 } | null = null;

      // Fase 2 (review I1): el distribuidor dimensiona sobre lo que el lock congelaría HOY (estructura viva + diseño),
      // NUNCA sobre la vista con los cambios de estructura sugeridos (videos/actividades/repaso): esos no los escribe
      // «Aplicar diseño» (los decide el docente en el editor), y contarlos haría que lo mostrado ≠ lo aplicado.
      const lockShaped = rules ? applyPedagogyToSnapshot(base, rules) : base;
      // T3 (r57): mezcla de práctica del plan de aprendizaje → restricciones del distribuidor (el documento manda).
      const mixSpec = rules?.learningPlan?.composition?.practiceMix;
      const mix = mixSpec
        ? evaluatePracticeMix(mixSpec, [...lockShaped.modules].sort((a, b) => a.position - b.position), input.requirementConstraints ?? null)
        : null;
      // r79 · ajuste al presupuesto: tope de capítulos de contenido por módulo (preferencia del perfil). Va como un máximo
      // más de las restricciones (nunca por debajo del mínimo del documento: ver withContentChaptersCap); sin la preferencia,
      // las restricciones de siempre (byte a byte).
      const contentCap = profileContentChaptersMax(input.profile);
      const requirements = withContentChaptersCap(mix ? mix.constraints : input.requirementConstraints ?? null, contentCap, lockShaped.modules.length);
      const lock = input.tierLock ?? null;
      const runDistributor = () => distributeCourseHours({ snapshot: lockShaped, rules, targetHours, activityTypeRules: activityTypeRules === 2 ? 2 : 1, preferences: profileDesignPreferences(input.profile), pins: input.designPins ?? null, requirements, ...(profileHm ? { timeModelConfig: timeModelConfigOf(lockShaped) } : {}), ...(lock ? { tierSelectable: (t: number) => isTierSelectable('standard', t, lock) } : {}) });
      // r79.1 (rendimiento): en la búsqueda del ajuste (distributionOnly) el distribuidor se corre UNA vez por combinación
      // que lo afecta: los tipos de actividad no cambian su entrada (se asignan después), así que «automático» y «ninguno»
      // comparten el resultado. Caché por la estructura recibida (misma identidad en toda la búsqueda) y el resto de la
      // entrada serializada. Función pura: mismo resultado; solo en el modo liviano (sus lectores no modifican el diseño).
      const dist0 = input.distributionOnly === true ? memoDistributor(input, lock, runDistributor) : runDistributor();
      // r79.1 · tipos de Actividad de Aplicación (estudio de caso / proyecto integrador / retroalimentación formativa):
      // con «automático», donde aportan valor (criterios K1–K3); sin la preferencia y sin tipos en la estructura, el
      // diseño de siempre (byte a byte). Sin la preferencia pero con tipos aplicados antes, la propuesta los quita.
      const kindsMode = profileActivityKinds(input.profile);
      const kindsInStructure = lockShaped.modules.some((m) => m.chapters.some((c) => (c as { applicationKind?: unknown }).applicationKind !== undefined));
      const kinds = kindsMode === 'auto' || kindsInStructure ? assignApplicationKinds(dist0, lockShaped, kindsMode, lock) : null;
      const dist = kinds ? kinds.dist : dist0;
      const materialized = materializeOrError(lockShaped, dist, (plain) => {
        const ms = side(rules ? applyPedagogyToSnapshot(plain, rules) : plain, activityTypeRules, pricing);
        materializedSide = ms;
        onMaterialized(ms);
        // F1 (r57): con plan de aprendizaje, la decisión de actividad que ve el docente sale del Manifest materializado
        // (con los capítulos de práctica incluidos), no de la estructura previa: fuente única = lo que se congela.
        if (planOn && ms.blueprint.course.pedagogy) {
          const finalDec = choosePedagogicalActivityTypes(ms.blueprint, activityTypeRules);
          const manifestType = new Map(ms.manifest.items.filter((i) => i.type === 'activity').map((i) => [i.chapterId as string, i.h5pType as string | undefined]));
          for (const ch of chapters) {
            const cur = ch.activityDecision;
            const fin = finalDec.get(ch.chapterId);
            const mt = manifestType.get(ch.chapterId);
            if (!cur || !fin || !fin.learningType) continue;
            const type = mt ?? fin.type;
            if (type === cur.type && fin.reason === cur.reason) continue;
            const moved = type !== cur.type;
            ch.activityDecision = {
              type, reason: fin.reason, ruleId: fin.learningType.ruleId, candidates: [...fin.learningType.candidates],
              rationale: moved
                ? `${fin.learningType.rationale} El tope/balance del curso completo (con los capítulos de práctica) lo mueve de «${cur.type}» a «${type}».`
                : fin.learningType.rationale,
            };
          }
        }
        return {
          blueprintSha256: ms.blueprintSha256,
          manifestSha256: ms.manifestSha256,
          // LOOP 7 (A2 A4): la tarjeta «Cursia recomienda» muestra horas y conteos del modelo del distribuidor; si no
          // coinciden con el Manifest materializado (lo que se congelaría), el error es visible y «Aplicar» se bloquea.
          manifestErrors: [...ms.manifestErrors, ...distributionModelMismatch(dist, ms)],
          items: ms.manifest.items.length,
          totals: { ...(ms.manifest.totals as any) },
          providers: ms.providers,
          generableHours: ms.studyTime.courseEstimatedHours,
          ...(() => { const a = alignmentOf(ms, input.alignment, registry); return a ? { alignment: a } : {}; })(),
        };
      }, appContext);
      // Fase 2 · «Aplicar diseño»: huella de la propuesta que ve el docente (el servidor la recalcula al aplicar).
      const mixView = mix ? { practiceMix: { status: mix.status, ruleId: mix.ruleId, plan: mix.plan, fit: mix.fit, notes: [...mix.notes] } } : {};
      return { ...dist, materialized, proposalSha256: distributionProposalSha256(dist, contentCap !== null ? { contentChaptersMax: contentCap } : null), ...mixView, ...(contentCap !== null ? { contentChaptersMax: contentCap } : {}), ...(kinds && kindsMode === 'auto' ? { activityKinds: kinds.report } : {}) };
}

/** r79.1 · dry-run liviano de la búsqueda del ajuste: solo `distribution` (idéntica a la del completo). */
function liteDryRun(
  input: DryRunInput,
  base: BlueprintSnapshotV2,
  rules: DesignRules | null,
  profile: PedagogicalProfile | null,
  profileEmpty: boolean,
  targetHours: number | null,
  activityTypeRules: ActivityTypeRulesVersion,
  registry: PedagogicalApproachRegistry,
  appContext: ReturnType<typeof profileApplicationContext>,
  pricing: DryRunPricing | null,
  profileHm: ReturnType<typeof profileHoursModel>,
): DryRunResult {
  const ped = rules ? applyPedagogyToSnapshot(base, rules).course.pedagogy ?? null : null;
  const planOn = !!ped?.learningPlan;
  return {
    dryRun: true, providersCalled: 0, spendUsd: '0.00', engineVersion: PEDAGOGY_ENGINE_VERSION, activityTypeRules,
    profile, profileEmpty, rules, targetHours,
    distribution: targetHours === null ? null : distributionFor(input, base, rules, targetHours, activityTypeRules, registry, appContext, pricing, profileHm, [], planOn, () => undefined),
    workload: null,
    baseline: null as unknown as DryRunSide,
    pedagogical: null,
    structureChanges: [], objectives: [], modules: [], chapters: [], assessment: null,
    diff: { itemsAdded: [], itemsRemoved: [], h5pTypeChanges: [], itemsWithDesign: 0, totals: { baseline: {}, pedagogical: null }, estimateExpectedUsd: { baseline: null, pedagogical: null }, estimatedHours: { baseline: 0, pedagogical: null }, summary: [] },
    appliedRules: rules ? rules.applied : [], generators: [], courseOverrides: [],
  };
}
