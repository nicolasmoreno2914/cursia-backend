// Motor de carga horaria — Loop 3: DISTRIBUIDOR de horas.
//
//   targetHours + reglas del motor pedagógico (DesignRules) + Blueprint actual → DISEÑO PROPUESTO
//
// Función pura y determinista: no genera contenido, no llama a proveedores y no escribe nada. Decide
// cuántos capítulos de contenido y de práctica hacen falta, su rol, si llevan video / actividad / repaso,
// el nivel de la Actividad de aplicación (Fase 2) y el tiempo objetivo de cada capítulo. Los minutos los
// pone SIEMPRE el modelo de tiempo (time-model.ts), nunca la IA ni este archivo.
//
// Reglas (validadas en la Fase 0):
//   - No rellena: si la estructura mínima ya supera el objetivo, NO quita contenido; informa y propone
//     una reducción (decisión del docente).
//   - No inventa horas: crece con aplicación, práctica y profundidad (estructura), nunca inflando textos o
//     tiempos. Si con los topes razonables no alcanza, propone capítulos o un módulo nuevo.
//   - Tolerancia configurable (por defecto ±5 % o ±1 h, lo que sea mayor).
//   - Pedagogía primero: el ORDEN de crecimiento sale de las dimensiones del motor pedagógico
//     (competencias → aplicación y práctica; significativo → profundidad). No hay un segundo motor.
//   - Prioridad: técnica > producto > curso (targetHours, toggles del docente) > pedagogía > preferencias.
//     targetHours obliga a cambiar la estructura, pero esos cambios son PROPUESTAS: el lock nunca las aplica.
//
// Fase 2: la Actividad de Aplicación SE GENERA (item `application_activity` del Manifest). El distribuidor fija
// su nivel por capítulo y las horas generables son las del diseño completo (`generableHours` se conserva por
// compatibilidad: es igual a `estimatedHours`).
//
// Loop 9 B: si con las Actividades de Aplicación en su máximo (o fijadas por el documento) el diseño sigue por debajo
// del objetivo, la diferencia se completa con PRÁCTICA GUIADA en los capítulos de contenido (formativa, sin nota; niveles
// 40/60/80/120), repartida lo más pareja posible y apuntando al objetivo (no al borde de la tolerancia). No agrega
// capítulos ni Actividades de Aplicación; si ni con 120 min en todos los capítulos de contenido se llega, lo dice.
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { DesignRules } from '../pedagogy/design-rules';
import { chapterRole } from '../pedagogy/pedagogical-blueprint';
import type { ChapterRole } from '../pedagogy/vocabulary';
import { STRUCTURE_TITLE_MAX } from '../course-structure/structure-titles';
import { isValidTargetHours } from './target-hours';
import { STUDY_TIME_RULES, StudyTimeCourseInput, StudyTimeEstimate, estimateCourseStudyTime as estimateCourseStudyTimeWith } from './time-model';
import { DEFAULT_TIME_MODEL_CONFIG, TimeModelConfig } from './time-model-config';
import { GUIDED_PRACTICE_TIERS } from './guided-practice-tiers';
import type { DistributorRequirementConstraints } from '../academic-context/requirements/requirement-authority';
import { classifyLearningType } from '../pedagogy/learning-type';
import type { LearningType } from '../pedagogy/vocabulary';
import type { ApplicationKind } from './application-kind-tiers';
import { isTierSelectable } from '../course-shell/application-kinds';
import { VIDEO_COMPOSITION_VERSION, VIDEO_NEED_BY_LEARNING_TYPE, VideoCompositionResult, VideoNeed, decideVideosByNeed } from './video-composition';
import { TOPIC_SPLIT_VERSION, chapterSubtopics, joinList, maxPartsFor, partDescription, partTitle, partitionSubtopics } from './topic-split';

export const DISTRIBUTOR_VERSION = 2 as const;

export interface DistributorPolicy {
  /** Nivel máximo de la Actividad de aplicación en capítulos de contenido y en los cierres de módulo / práctica. */
  contentTierMax: number;
  closingTierMax: number;
  /**
   * Proporción máxima de aplicación para SUBIR niveles en capítulos de contenido: más allá se crece con
   * ESTRUCTURA (capítulos de práctica o de profundización), no alargando actividades. No limita a los
   * capítulos de práctica, cuya razón de ser es la aplicación: la proporción real se informa en el resultado.
   */
  maxApplicationShare: number;
  /** Capítulos de práctica por módulo antes (o después) de profundizar. */
  practicePerModule: number;
  /** Orden de crecimiento. */
  order: ReadonlyArray<'application' | 'practice' | 'content'>;
}

export const DISTRIBUTOR_RULES = Object.freeze({
  version: DISTRIBUTOR_VERSION,
  tolerance: Object.freeze({ pct: 0.05, minHours: 1 }),
  /** Carga máxima de un capítulo (4 h): más sería sobrecargar al estudiante. */
  maxChapterMinutes: 240,
  maxContentChaptersPerModule: 5,
  /**
   * Ejercicios guiados: proporción máxima de las horas que Cursia usa por su cuenta (la del aviso de la tarjeta y la del
   * ajuste al presupuesto, budget-fit GUIDED_SHARE_MAX). r80: también el tope del relleno con capítulos reales.
   */
  guidedShareMax: 0.3,
  /** Enfoque centrado en aplicación / desempeño (o sin enfoque). */
  applicationFirst: Object.freeze({ contentTierMax: 90, closingTierMax: 120, maxApplicationShare: 0.5, practicePerModule: 2, order: Object.freeze(['application', 'practice', 'content'] as const) }) as DistributorPolicy,
  /** Enfoque centrado en profundidad conceptual / conexiones. */
  depthFirst: Object.freeze({ contentTierMax: 60, closingTierMax: 90, maxApplicationShare: 0.4, practicePerModule: 1, order: Object.freeze(['application', 'content', 'practice'] as const) }) as DistributorPolicy,
});

export type DistributionStatus = 'within_tolerance' | 'above_tolerance' | 'minimum_exceeds_target' | 'cannot_reach_target';

export interface ProposedChapter {
  /** Id real del Blueprint, o `proposed:…` para un capítulo que el distribuidor sugiere agregar. */
  id: string;
  proposed: boolean;
  kind: 'content' | 'practice';
  title: string;
  objective: string | null;
  role: ChapterRole;
  videoEnabled: boolean;
  activityEnabled: boolean;
  review: boolean;
  /** Nivel de la Actividad de Aplicación (minutos; null = sin actividad). Se genera con el curso (Fase 2). */
  applicationMinutes: number | null;
  /**
   * r79.1: tipo de la Actividad de Aplicación (estudio de caso / proyecto integrador / retroalimentación formativa). SOLO
   * si lo asignó `assignApplicationKinds` (preferencia «Tipos de actividad: automático»); el distribuidor nunca lo pone.
   */
  applicationKind?: ApplicationKind;
  /** LOOP 8.3: el video de este capítulo lo fijó el docente (el diseño lo respeta). */
  videoPinned: boolean;
  /** Review L84-4: la Actividad de Aplicación la fijó el docente. */
  applicationPinned: boolean;
  /** LOOP 9.2: la actividad interactiva la fijó el docente. */
  activityPinned?: boolean;
  /** Loop 9 B: minutos de la práctica guiada (solo capítulos de contenido; null = sin práctica guiada). */
  guidedPracticeMinutes: number | null;
  /** Loop 9 B: la práctica guiada la fijó el docente. */
  guidedPracticePinned: boolean;
  /**
   * T3 (r57): por qué este capítulo de contenido lleva (o no) video — SOLO con la composición por necesidad del plan de
   * aprendizaje (`learningPlan.composition.videos = 'by_need'`); sin ella la clave no existe (salida de siempre).
   */
  videoDecision?: { ruleId: string; need: VideoNeed; learningType: LearningType; reason: string };
  /** Tiempo objetivo del capítulo (modelo de tiempo, exacto) y lo que se puede generar hoy (sin la Actividad). */
  targetMinutes: number;
  generableMinutes: number;
  /**
   * r80 · capítulos reales: SOLO en los capítulos que salen de dividir un contenido del documento en sus subtemas (el
   * capítulo de origen, con su título nuevo, y los capítulos propuestos). Sin división la clave no existe (salida de siempre).
   */
  split?: ChapterSplit;
  /** r80: descripción del capítulo dividido (sus subtemas y el contenido del documento del que vienen). */
  description?: string;
}

/** r80 · un contenido del documento repartido en `parts` capítulos: este es el `part` (0 = el capítulo de origen). */
export interface ChapterSplit {
  version: typeof TOPIC_SPLIT_VERSION;
  sourceChapterId: string;
  /** Título que tenía el capítulo de origen (el contenido completo del documento). */
  sourceTitle: string;
  part: number;
  parts: number;
  subtopics: string[];
  /** Resultados de aprendizaje del capítulo de origen (los capítulos nuevos los heredan: vienen del mismo contenido). */
  outcomeIds: string[];
}

export interface ProposedModule {
  id: string;
  title: string;
  examEnabled: boolean;
  chapters: ProposedChapter[];
  /** LOOP 9.2: el docente quitó la práctica de este módulo (Cursia no la vuelve a proponer). */
  practiceRemovedByTeacher?: boolean;
}

export interface DistributionChange {
  type: 'add_practice_chapter' | 'add_content_chapter' | 'split_content_chapter' | 'set_application_activity' | 'remove_application_activity' | 'set_guided_practice' | 'remove_guided_practice' | 'role_changed' | 'set_video' | 'set_activity' | 'set_application_kind' | 'remove_application_kind';
  /** LOOP 8.6C: el cambio lo pide un requisito del documento (id del requisito). */
  requirementId?: string;
  /** r80: subtemas del documento que cubre el capítulo (división de un contenido; sin división la clave no existe). */
  subtopics?: string[];
  moduleId: string;
  chapterId: string;
  /** Texto para el docente. */
  detail: string;
}

export interface DistributionResult {
  distributorVersion: typeof DISTRIBUTOR_VERSION;
  dryRun: true;
  providersCalled: 0;
  targetHours: number;
  toleranceHours: number;
  status: DistributionStatus;
  /** Horas de la estructura actual (sin Actividades de aplicación). */
  baseHours: number;
  /** Horas del diseño propuesto completo. */
  estimatedHours: number;
  /** Horas que se pueden generar HOY: desde la Fase 2, todo el diseño (= estimatedHours). */
  generableHours: number;
  deltaHours: number;
  /** Proporción del diseño en Actividades de aplicación (0–1), incluidos los capítulos de práctica. */
  applicationShare: number;
  policy: { kind: 'application_first' | 'depth_first'; weights: { application: number; depth: number } | null } & DistributorPolicy;
  /** Fase 2 · «Ajustar»: preferencias efectivas con las que se armó el diseño (audiovisual null = comportamiento anterior). */
  preferences: { emphasis: DesignEmphasis; applicationActivities: ApplicationActivitiesMode; audiovisual?: AudiovisualPriority };
  modules: ProposedModule[];
  changes: DistributionChange[];
  recommendations: string[];
  /** Por qué la estructura cambió (prioridad de reglas). */
  priorityTrace: string[];
  /** Meta fuera de alcance con la forma fija: lo que daría la capacidad que el documento limita (no se aplica sola). */
  hoursAlternative?: HoursAlternative;
  /** Meta fuera de alcance con la forma fija: las Actividades las limita el documento (true) o los topes de Cursia (false). */
  applicationLimitedByDocument?: boolean;
  counts: {
    modules: number;
    chapters: number;
    contentChapters: number;
    practiceChapters: number;
    videoChapters: number;
    activities: number;
    reviews: number;
    applicationActivities: number;
    applicationMinutes: number;
    /** Loop 9 B: capítulos de contenido con práctica guiada y sus minutos (SOLO si hay alguna: sin ella, salida de siempre). */
    guidedPractices?: number;
    guidedPracticeMinutes?: number;
    evaluations: number;
  };
  /** Loop 9 B: la práctica guiada completó la diferencia (o no alcanzó: shortfall en horas, > 0). */
  guidedPracticeFill?: { used: boolean; shortfallHours: number };
  /** T3 (r57): composición por necesidad (solo con `learningPlan.composition.videos = 'by_need'`). */
  composition?: {
    version: typeof VIDEO_COMPOSITION_VERSION;
    videos: Pick<VideoCompositionResult, 'hoursBudgetVideos' | 'counts' | 'unmet'> & { minVideos?: number; maxVideos?: number };
  };
  /** Horas por componente del diseño propuesto. */
  hoursByComponent: Record<string, number>;
  studyTime: StudyTimeEstimate;
}

/**
 * Fase 2 · «Ajustar» (preferencias del docente, guardadas en el perfil pedagógico como `designPreferences`):
 *   - emphasis: 'application' fuerza la política de aplicación primero; 'depth', la de profundidad; 'balanced'
 *     (por defecto) usa la que deriva el enfoque.
 *   - applicationActivities: 'auto' (por defecto: donde el diseño las necesite), 'practice_only' (solo en capítulos
 *     de práctica) o 'none' (ninguna: el curso crece solo con capítulos).
 */
export type DesignEmphasis = 'application' | 'balanced' | 'depth';
/**
 * LOOP 8.3 · Prioridad audiovisual (preferencia del diseño, no una estructura fija). Ausente = comportamiento anterior
 * (el video de cada capítulo es el que tiene la estructura; la profundización hereda el del módulo).
 *   - less: video solo en el capítulo de contenido que abre cada módulo;
 *   - recommended: en los que abren o desarrollan el módulo (no en el que lo cierra ni en la profundización agregada);
 *   - more: en todos los capítulos de contenido (también la profundización).
 * Los capítulos de práctica nunca llevan video; un capítulo FIJADO por el docente conserva su valor.
 */
export type AudiovisualPriority = 'less' | 'recommended' | 'more';
export const AUDIOVISUAL_PRIORITIES: readonly AudiovisualPriority[] = ['less', 'recommended', 'more'];
/** Valores que el docente fijó a mano en el editor (por id de capítulo). El distribuidor los respeta siempre. */
/** LOOP 8.3: video fijado a mano · review L84-4: Actividad de Aplicación fijada a mano (minutos; 0 = sin actividad). */
export type DesignPins = Readonly<Record<string, { video?: boolean; application?: number; guided?: number; activity?: boolean; noPractice?: boolean }>>;
export type ApplicationActivitiesMode = 'auto' | 'practice_only' | 'none';
export const DESIGN_EMPHASES: readonly DesignEmphasis[] = ['application', 'balanced', 'depth'];
export const APPLICATION_ACTIVITIES_MODES: readonly ApplicationActivitiesMode[] = ['auto', 'practice_only', 'none'];
/** Loop 9 B (fix I1) · «Ejercicios guiados»: auto (por defecto: solo si el documento fija la forma o las Actividades) o none. */
export type GuidedPracticeMode = 'auto' | 'none';
export const GUIDED_PRACTICE_MODES: readonly GuidedPracticeMode[] = ['auto', 'none'];
export interface DesignPreferences {
  emphasis?: DesignEmphasis;
  applicationActivities?: ApplicationActivitiesMode;
  audiovisual?: AudiovisualPriority;
  guidedPractice?: GuidedPracticeMode;
}

export interface DistributorInput {
  snapshot: BlueprintSnapshotV2;
  /** Fase 2 · «Ajustar»: preferencias del docente (ausentes = las de siempre). */
  preferences?: DesignPreferences | null;
  /** LOOP 8.3: valores fijados por el docente (video por capítulo). */
  pins?: DesignPins | null;
  /** Reglas del motor pedagógico (null = sin enfoque: política neutra). */
  rules: DesignRules | null;
  targetHours: number;
  /** Reglas de tipo de actividad del Manifest (2 = H5P v2: pausas del video y «Repaso»). */
  activityTypeRules?: 1 | 2;
  tolerance?: { pct?: number; minHours?: number };
  /**
   * LOOP 8.6C · requisitos OBLIGATORIOS del documento que el distribuidor puede cumplir solo (ver requirement-authority):
   * capítulos por módulo (no pasar del máximo; completar el mínimo con capítulos propuestos), video en cada capítulo de
   * contenido o ninguno, y topes de Actividades de Aplicación. Lo que no se puede cumplir lo explica Verificación.
   */
  requirements?: DistributorRequirementConstraints | null;
  /**
   * r58 (I3): configuración del modelo de tiempo (tasas / minutos acreditados por nivel). Ausente = el default: mismos
   * minutos y misma propuesta de siempre.
   */
  timeModelConfig?: TimeModelConfig | null;
  /**
   * r79.1 · candado de proporcionalidad (§12.1): ¿Cursia puede elegir este nivel de la Actividad de siempre? Ausente = el
   * de la especificación vigente (course-shell/application-kinds.ts). Un nivel cerrado nunca lo elige el distribuidor (lo
   * fijado por el docente o por el documento se respeta igual). Los checks lo reemplazan para probar el candado cerrado.
   */
  tierSelectable?: ((minutes: number) => boolean) | null;
  /**
   * r80 · capítulos reales: para llegar a la carga horaria, los capítulos de contenido nuevos salen de los SUBTEMAS que el
   * documento enumera en un contenido (nunca una «Profundización N» genérica). Sin subtemas que repartir no se agrega
   * contenido: el resto lo completan la práctica, las Actividades y los ejercicios guiados, o se informa la diferencia.
   * Ausente / false = comportamiento de siempre (byte a byte).
   */
  realChapters?: boolean;
}

export class DistributorError extends Error {
  readonly code = 'DISTRIBUTOR_INPUT_INVALID';
  constructor(message: string) {
    super(`DISTRIBUTOR_INPUT_INVALID: ${message}`);
    this.name = 'DistributorError';
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const ROLE_TEXT: Readonly<Record<ChapterRole, string>> = Object.freeze({ module_opening: 'apertura', core: 'núcleo', module_closing: 'cierre', single: 'capítulo único' });
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Política de crecimiento según las dimensiones del motor pedagógico (sin enfoque: aplicación primero). */
export function distributorPolicyFor(rules: DesignRules | null): DistributionResult['policy'] {
  if (!rules) return { kind: 'application_first', weights: null, ...DISTRIBUTOR_RULES.applicationFirst };
  const d = rules.dimensions;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const weights = { application: r2(avg([d.practice, d.evidence, d.authenticity])), depth: r2(avg([d.conceptualDepth, d.priorKnowledge])) };
  const appFirst = avg([d.practice, d.evidence, d.authenticity]) >= avg([d.conceptualDepth, d.priorKnowledge]);
  return appFirst
    ? { kind: 'application_first', weights, ...DISTRIBUTOR_RULES.applicationFirst }
    : { kind: 'depth_first', weights, ...DISTRIBUTOR_RULES.depthFirst };
}

interface WorkChapter {
  id: string;
  proposed: boolean;
  kind: 'content' | 'practice';
  title: string;
  objective: string | null;
  videoEnabled: boolean;
  activityEnabled: boolean;
  applicationMinutes: number | null;
  /** Loop 9 B: práctica guiada (solo contenido). Ausente en los capítulos que agrega el distribuidor = null. */
  guidedPracticeMinutes?: number | null;
  /** r80: descripción y resultados del capítulo (para dividir un contenido en sus subtemas). */
  description?: string | null;
  outcomeIds?: string[];
  split?: ChapterSplit;
}
interface WorkModule {
  id: string;
  title: string;
  examEnabled: boolean;
  chapters: WorkChapter[];
}

/**
 * Título de un capítulo propuesto: «Prefijo: título del módulo» si cabe en el máximo de la estructura; si no, solo
 * el prefijo (el módulo ya va en el objetivo). Así la propuesta materializada es la misma que crearía el editor.
 */
export function proposedTitle(prefix: string, moduleTitle: string): string {
  const full = `${prefix}: ${String(moduleTitle ?? '').trim()}`;
  return full.length <= STRUCTURE_TITLE_MAX ? full : prefix;
}

/**
 * Agotar capacidades (2026-10-10): con la forma fija y la meta fuera de alcance, ¿qué daría la capacidad que Cursia YA tiene
 * y que el documento limita? Una Actividad de Aplicación en cada capítulo de contenido (30/60/90 min), FIJADA por el docente
 * (así se aplica en «Estructura»). Se calcula corriendo el mismo distribuidor con esas fijaciones: las horas son las que
 * daría de verdad (Cursia reequilibra el resto). El nivel más bajo que entra en la tolerancia, o el máximo si ninguno entra.
 * Solo informa: aplicarlo se aparta de las cantidades del documento y lo decide la institución.
 */
export interface HoursAlternative {
  /** Capítulos de contenido que llevarían la Actividad (todos los que el docente no fijó). */
  contentChapters: number;
  tier: number;
  hours: number;
  reaches: boolean;
  /** Actividades de Aplicación que se suman (neto) respecto del diseño actual. */
  added: number;
}

export function distributeCourseHours(input: DistributorInput): DistributionResult {
  const d = distributeCore(input);
  if (d.status !== 'cannot_reach_target' || !input.requirements?.noContentAdditions) return d;
  const rq = input.requirements;
  // Qué frena las Actividades: el documento (cuántas y dónde) o los topes propios de Cursia (proporción, 4 h por capítulo).
  const byDocument = !!rq.applicationInPractice || rq.applicationPerModule?.max !== undefined || rq.applicationTotal?.max !== undefined;
  const out: DistributionResult = { ...d, applicationLimitedByDocument: byDocument };
  // «Ninguna» o «Solo en prácticas» los eligió el docente: Cursia no propone pasar por encima de esa decisión.
  const mode = input.preferences?.applicationActivities;
  if (mode === 'none' || mode === 'practice_only') return out;
  // Todos los capítulos de contenido que el docente no fijó (también los que ya tienen una Actividad de Cursia).
  const target = d.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content' && !c.applicationPinned && !c.proposed));
  if (!target.length) return out;
  const tierOk = input.tierSelectable ?? ((t: number) => isTierSelectable('standard', t));
  const tiers = (STUDY_TIME_RULES.applicationActivityTiers as readonly number[]).filter((t) => t <= DISTRIBUTOR_RULES.applicationFirst.contentTierMax && tierOk(t));
  let alt: HoursAlternative | null = null;
  for (const tier of tiers) {
    const pins: Record<string, DesignPins[string]> = { ...(input.pins ?? {}) };
    for (const c of target) pins[c.id] = { ...(pins[c.id] || {}), application: tier };
    const r = distributeCore({ ...input, pins });
    const reaches = r.status !== 'cannot_reach_target';
    alt = { contentChapters: target.length, tier, hours: r.estimatedHours, reaches, added: r.counts.applicationActivities - d.counts.applicationActivities };
    if (reaches) break;
  }
  return alt && alt.added > 0 ? { ...out, hoursAlternative: alt } : out;
}

function distributeCore(input: DistributorInput): DistributionResult {
  const { snapshot, rules } = input ?? ({} as DistributorInput);
  // r58 (I3): la misma configuración del modelo de tiempo en TODAS las estimaciones del distribuidor.
  const timeCfg = input?.timeModelConfig ?? DEFAULT_TIME_MODEL_CONFIG;
  const estimateCourseStudyTime = (x: StudyTimeCourseInput): StudyTimeEstimate => estimateCourseStudyTimeWith(x, timeCfg);
  if (!snapshot || snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.modules) || snapshot.modules.length === 0) {
    throw new DistributorError('se necesita un Blueprint v2 con al menos un módulo');
  }
  if (!isValidTargetHours(input.targetHours)) throw new DistributorError(`targetHours inválido (${JSON.stringify(input.targetHours)})`);
  const atr = input.activityTypeRules ?? 2;
  if (atr !== 1 && atr !== 2) throw new DistributorError(`activityTypeRules inválido (${JSON.stringify(atr)})`);
  const tolPct = input.tolerance?.pct ?? DISTRIBUTOR_RULES.tolerance.pct;
  const tolMinH = input.tolerance?.minHours ?? DISTRIBUTOR_RULES.tolerance.minHours;
  if (!(tolPct >= 0 && tolPct <= 0.5) || !(tolMinH >= 0 && tolMinH <= 10)) throw new DistributorError('tolerancia fuera de rango (pct 0–0,5; minHours 0–10)');

  const prefs = input.preferences ?? {};
  const tierOk = input.tierSelectable ?? ((t: number) => isTierSelectable('standard', t));
  if (prefs.emphasis !== undefined && !DESIGN_EMPHASES.includes(prefs.emphasis)) throw new DistributorError(`emphasis inválido (${JSON.stringify(prefs.emphasis)})`);
  if (prefs.applicationActivities !== undefined && !APPLICATION_ACTIVITIES_MODES.includes(prefs.applicationActivities)) {
    throw new DistributorError(`applicationActivities inválido (${JSON.stringify(prefs.applicationActivities)})`);
  }
  if (prefs.audiovisual !== undefined && !AUDIOVISUAL_PRIORITIES.includes(prefs.audiovisual)) throw new DistributorError(`audiovisual inválido (${JSON.stringify(prefs.audiovisual)})`);
  if (prefs.guidedPractice !== undefined && !GUIDED_PRACTICE_MODES.includes(prefs.guidedPractice)) throw new DistributorError(`guidedPractice inválido (${JSON.stringify(prefs.guidedPractice)})`);
  const guidedMode: GuidedPracticeMode = prefs.guidedPractice ?? 'auto';
  const appMode: ApplicationActivitiesMode = prefs.applicationActivities ?? 'auto';
  const av: AudiovisualPriority | null = prefs.audiovisual ?? null;
  // r80 · capítulos reales (ver DistributorInput.realChapters).
  const realChapters = input.realChapters === true;
  // T3 (r57): composición por necesidad (plan de aprendizaje). Ausente = comportamiento de siempre (byte a byte).
  const lpComp = rules?.learningPlan?.composition ?? null;
  const compOn = !!lpComp && lpComp.videos === 'by_need';
  const pins: DesignPins = input.pins ?? {};
  const pinnedVideo = (id: string): boolean | undefined => (pins[id] && typeof pins[id].video === 'boolean' ? pins[id].video : undefined);
  /** Minutos fijados por el docente (null = fijada SIN actividad); undefined = la decide Cursia. */
  // LOOP 9.2 (review C1/I1/I2): actividad fijada por el docente y módulos de los que quitó la práctica.
  const pinnedActivity = (id: string): boolean | undefined => (pins[id] && typeof pins[id].activity === 'boolean' ? pins[id].activity : undefined);
  const noPracticeModule = (id: string): boolean => !!(pins[id] && pins[id].noPractice);
  const pinnedApp = (id: string): number | null | undefined => {
    const a = pins[id] && pins[id].application;
    return typeof a === 'number' && Number.isFinite(a) ? (a > 0 ? a : null) : undefined;
  };
  /** Loop 9 B: práctica guiada fijada por el docente (null = fijada SIN práctica guiada); undefined = la decide Cursia. */
  const pinnedGuided = (id: string): number | null | undefined => {
    const g = pins[id] && pins[id].guided;
    return typeof g === 'number' && Number.isFinite(g) ? (g > 0 ? g : null) : undefined;
  };
  const basePolicy = distributorPolicyFor(rules);
  const policy: DistributionResult['policy'] = prefs.emphasis === 'application'
    ? { ...basePolicy, kind: 'application_first', ...DISTRIBUTOR_RULES.applicationFirst }
    : prefs.emphasis === 'depth'
      ? { ...basePolicy, kind: 'depth_first', ...DISTRIBUTOR_RULES.depthFirst }
      : basePolicy;
  const target = input.targetHours * 60;
  const tol = Math.max(target * tolPct, tolMinH * 60);
  const review = snapshot.course.reviewCards === true && atr === 2 && snapshot.course.activityEngine === 'h5p';
  const ivAdvanced = atr === 2;

  const design: WorkModule[] = [...snapshot.modules]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      id: m.id,
      title: m.title,
      examEnabled: !!m.examEnabled,
      chapters: [...m.chapters].sort((a, b) => a.position - b.position).map((c) => ({
        id: c.id,
        proposed: false,
        kind: (c as { kind?: string }).kind === 'practice' ? ('practice' as const) : ('content' as const),
        title: c.title,
        objective: c.objective ?? null,
        videoEnabled: !!c.videoEnabled,
        activityEnabled: c.activityEnabled === true,
        // Fase 2: se arranca con las Actividades de Aplicación que la estructura YA tiene (ver «ya cumple», abajo).
        applicationMinutes: typeof (c as { applicationMinutes?: unknown }).applicationMinutes === 'number' ? ((c as { applicationMinutes?: number }).applicationMinutes as number) : null,
        guidedPracticeMinutes: typeof (c as { guidedPracticeMinutes?: unknown }).guidedPracticeMinutes === 'number' ? ((c as { guidedPracticeMinutes?: number }).guidedPracticeMinutes as number) : null,
        ...(input.realChapters ? { description: (c as { description?: string }).description ?? null, outcomeIds: Array.isArray((c as { outcomeIds?: unknown }).outcomeIds) ? [...((c as { outcomeIds?: string[] }).outcomeIds as string[])] : [] } : {}),
      })),
    }));
  if (design.some((m) => m.chapters.length === 0)) throw new DistributorError('cada módulo necesita al menos un capítulo');
  // Review L84-4: una Actividad de Aplicación fijada a mano por el docente se respeta siempre (como el video fijado).
  for (const m of design) for (const c of m.chapters) { const p = pinnedApp(c.id); if (p !== undefined) c.applicationMinutes = p; }
  for (const m of design) for (const c of m.chapters) { const a = pinnedActivity(c.id); if (a !== undefined) c.activityEnabled = a; }
  // Loop 9 B: la práctica guiada fijada por el docente se respeta siempre (solo en capítulos de contenido).
  for (const m of design) for (const c of m.chapters) { const g = pinnedGuided(c.id); if (g !== undefined && c.kind === 'content') c.guidedPracticeMinutes = g; }

  // LOOP 8.3 · prioridad audiovisual sobre los capítulos de contenido existentes (antes de crecer: el video cambia las
  // horas y el resto del diseño compensa). Lo fijado por el docente manda; la práctica nunca lleva video.
  const initialVideo = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.videoEnabled] as const)));
  const initialActivity = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.activityEnabled] as const)));
  /** r72 · Capítulo de profundización que creó Cursia (propuesto o ya aplicado, con el título que le puso Cursia). */
  const isCursiaDeepening = (c: { proposed?: boolean; kind: string; title: string; split?: ChapterSplit }) => c.kind === 'content' && !c.split && (!!c.proposed || /^Profundizaci[oó]n \d+: /.test(String(c.title || '')));
  // r80 · ¿el tipo de aprendizaje del capítulo NECESITA video (procedimiento, protocolo, comunicación)? Mismo clasificador
  // y tabla que la composición por necesidad (learning-type + video-composition); el tipo congelado por el lock manda.
  const lockedType = new Map<string, LearningType>();
  for (const m of snapshot.modules) for (const c of m.chapters) {
    const t = (c as { design?: { learningType?: { type?: string } } }).design?.learningType?.type;
    if (typeof t === 'string') lockedType.set(c.id, t as LearningType);
  }
  const needsVideo = (c: { id: string; title: string; objective: string | null }): boolean =>
    VIDEO_NEED_BY_LEARNING_TYPE[lockedType.get(c.id) ?? classifyLearningType({ title: c.title, objective: c.objective, description: null }).type].need !== 'optional';
  const avFor = (contentIndex: number, contentCount: number, proposedDeepening: boolean): boolean => {
    if (av === 'more') return true;
    if (proposedDeepening) return false;
    if (av === 'less') return contentIndex === 0;
    return contentCount === 1 || contentIndex < contentCount - 1; // recommended: abre o desarrolla, no el cierre
  };
  if (compOn) {
    // T3: el video lo decide la composición por necesidad (más abajo, con los requisitos del documento ya leídos).
    for (const m of design) for (const c of m.chapters) if (c.kind === 'practice') c.videoEnabled = false;
  } else if (av) {
    for (const m of design) {
      const content = m.chapters.filter((c) => c.kind === 'content');
      content.forEach((c, i) => {
        const pin = pinnedVideo(c.id);
        c.videoEnabled = pin !== undefined ? pin : avFor(i, content.length, isCursiaDeepening(c)) || (realChapters && av === 'recommended' && needsVideo(c));
      });
      for (const c of m.chapters) if (c.kind === 'practice') c.videoEnabled = false;
    }
  } else {
    for (const m of design) for (const c of m.chapters) { const pin = pinnedVideo(c.id); if (pin !== undefined && c.kind === 'content') c.videoEnabled = pin; }
  }
  // LOOP 8.6C · requisitos del documento: video en todos los capítulos de contenido (o en ninguno). Lo fijado manda.
  const rq = input.requirements ?? null;
  const reqVideo: boolean | null = rq && rq.videosAllContent ? true : rq && rq.videosNone ? false : null;
  if (reqVideo !== null && !compOn) {
    for (const m of design) for (const c of m.chapters) if (c.kind === 'content' && pinnedVideo(c.id) === undefined) c.videoEnabled = reqVideo;
  }
  // T3 (r57) · composición por necesidad: tipo de aprendizaje congelado en el diseño del capítulo (lock); para un capítulo
  // que propone el distribuidor, el mismo clasificador sobre su título y objetivo (lo que congelará el lock al aplicarlo).
  const frozenType = new Map<string, LearningType>();
  for (const m of snapshot.modules) for (const c of m.chapters) {
    const t = (c as { design?: { learningType?: { type?: string } } }).design?.learningType?.type;
    if (typeof t === 'string') frozenType.set(c.id, t as LearningType);
  }
  const learningTypeOf = (c: WorkChapter): LearningType => frozenType.get(c.id) ?? classifyLearningType({ title: c.title, objective: c.objective, description: null }).type;
  let videoComp: VideoCompositionResult | null = null;
  /** Recalcula el video de TODOS los capítulos de contenido (la decisión depende del conjunto). true = algo cambió. */
  const applyComposition = (): boolean => {
    if (!compOn) return false;
    const list = design.flatMap((m) => m.chapters.filter((c) => c.kind === 'content'));
    videoComp = decideVideosByNeed({
      chapters: list.map((c, order) => { const p = pinnedVideo(c.id); return { chapterId: c.id, order, learningType: learningTypeOf(c), ...(p !== undefined ? { pinned: p } : {}) }; }),
      targetHours: input.targetHours,
      audiovisual: av,
      documentVideo: reqVideo,
      ...(lpComp!.minVideos !== undefined ? { minVideos: lpComp!.minVideos } : {}),
      ...(lpComp!.maxVideos !== undefined ? { maxVideos: lpComp!.maxVideos } : {}),
    });
    const byId = new Map(videoComp.decisions.map((d) => [d.chapterId, d.enabled]));
    let changed = false;
    for (const c of list) { const v = byId.get(c.id)!; if (c.videoEnabled !== v) { c.videoEnabled = v; changed = true; } }
    return changed;
  };
  applyComposition();
  const minCh = rq?.chaptersPerModule?.min ?? 0;
  const maxCh = rq?.chaptersPerModule?.max ?? Infinity;
  // LOOP 9.2 · Requisitos del documento por tipo de capítulo, lugar de las Actividades de Aplicación y total de actividades.
  // Fase 2/4: con una forma elegida por la institución no se agregan capítulos de contenido (ni para mínimos ni para horas).
  const noContentAdditions = !!rq?.noContentAdditions;
  const contentMin = noContentAdditions ? 0 : rq?.contentChaptersPerModule?.min ?? 0;
  const contentMax = rq?.contentChaptersPerModule?.max ?? Infinity;
  const practiceMin = rq?.practicePerModule?.min ?? 0;
  const practiceMax = rq?.practicePerModule?.max ?? Infinity;
  // T3 (r57): práctica EXACTA por módulo (mezcla de práctica del plan de aprendizaje). Sin ella, los límites de siempre.
  const byModule = Array.isArray(rq?.practiceByModule) ? rq!.practiceByModule! : null;
  const moduleIndex = new Map(design.map((m, i) => [m.id, i] as const));
  const pMin = (m: WorkModule) => (byModule ? byModule[moduleIndex.get(m.id) as number] ?? 0 : practiceMin);
  const pMax = (m: WorkModule) => (byModule ? byModule[moduleIndex.get(m.id) as number] ?? 0 : practiceMax);
  const practiceTitle = (k: number, moduleTitle: string) => proposedTitle(k === 1 ? 'Práctica integradora' : byModule && k > 2 ? `Práctica de casos ${k - 1}` : 'Práctica de casos', moduleTitle);
  const appInPractice = !!rq?.applicationInPractice;
  const practiceTotalMin = rq?.practiceTotal?.min ?? 0;
  const practiceTotalMax = rq?.practiceTotal?.max ?? Infinity;
  const practiceTotal = () => design.reduce((n, m) => n + m.chapters.filter((c) => c.kind === 'practice').length, 0);
  const contentCount = (cs: WorkChapter[]) => cs.filter((c) => c.kind !== 'practice').length;
  const practiceCount = (cs: WorkChapter[]) => cs.filter((c) => c.kind === 'practice').length;
  // r80 · capítulos reales: cada contenido del documento que enumera subtemas puede repartirse en más capítulos (en orden,
  // al menos 2 subtemas por capítulo). `parts[0]` es el capítulo de origen (cambia su título por el de sus subtemas).
  interface SplitSource { m: WorkModule; items: string[]; sourceText: string; sourceTitle: string; sourceObjective: string | null; outcomeIds: string[]; parts: WorkChapter[] }
  const splitSources: SplitSource[] = [];
  if (realChapters) for (const m of design) for (const c of m.chapters) {
    if (c.kind !== 'content' || c.proposed || isCursiaDeepening(c)) continue;
    const st = chapterSubtopics({ title: c.title, description: c.description ?? null });
    if (st.items.length >= 2 && maxPartsFor(st.items.length) > 1) {
      splitSources.push({ m, items: st.items, sourceText: st.source, sourceTitle: c.title, sourceObjective: c.objective, outcomeIds: [...(c.outcomeIds ?? [])], parts: [c] });
    }
  }
  /** Reparte de nuevo los subtemas de un contenido entre sus capítulos (títulos y descripciones salen del documento). */
  const relabel = (src: SplitSource) => {
    const groups = partitionSubtopics(src.items, src.parts.length);
    src.parts.forEach((c, i) => {
      c.title = partTitle(groups[i]);
      c.description = partDescription(groups[i], src.sourceText);
      c.objective = i === 0 ? src.sourceObjective : null;
      c.split = { version: TOPIC_SPLIT_VERSION, sourceChapterId: src.parts[0].id, sourceTitle: src.sourceTitle, part: i, parts: src.parts.length, subtopics: groups[i], outcomeIds: [...src.outcomeIds] };
    });
  };
  /**
   * r80: el próximo capítulo de contenido del módulo sale de dividir su contenido con más subtemas por capítulo (sin pasar
   * del máximo de capítulos de contenido). null = el documento no trae más subtemas en este módulo: no se agrega nada.
   */
  const splitNext = (m: WorkModule): WorkChapter | null => {
    if (contentCount(m.chapters) >= DISTRIBUTOR_RULES.maxContentChaptersPerModule || m.chapters.length >= maxCh || contentCount(m.chapters) >= contentMax) return null;
    const cand = splitSources.filter((x) => x.m === m && x.parts.length < maxPartsFor(x.items.length))
      .sort((a, b) => b.items.length / b.parts.length - a.items.length / a.parts.length)[0];
    if (!cand) return null;
    const n = m.chapters.filter((c) => c.kind === 'content' && c.proposed).length + 1;
    const cc: WorkChapter = { id: `proposed:content:${m.id}:${n}`, proposed: true, kind: 'content', title: '', objective: null, videoEnabled: cand.parts[0].videoEnabled,
      activityEnabled: cand.parts[0].activityEnabled, applicationMinutes: null, description: null, outcomeIds: [...cand.outcomeIds] };
    m.chapters.splice(m.chapters.indexOf(cand.parts[cand.parts.length - 1]) + 1, 0, cc);
    cand.parts.push(cc);
    relabel(cand);
    // El video del módulo se decide YA con la regla final (la misma que aplica result()): el crecimiento mide las horas
    // con los videos que tendrá el diseño (antes, un video que result() quitaba dejaba el total fuera de la tolerancia).
    if (!compOn && av) {
      const content = m.chapters.filter((c) => c.kind === 'content');
      content.forEach((c, i) => {
        if (pinnedVideo(c.id) !== undefined) return;
        c.videoEnabled = reqVideo !== null ? reqVideo : avFor(i, content.length, !c.split && (!!c.proposed || isCursiaDeepening(c))) || (av === 'recommended' && needsVideo(c));
      });
    } else if (reqVideo !== null) cc.videoEnabled = reqVideo;
    reEval();
    return cc;
  };
  /** r80: módulos donde el documento pide más capítulos de contenido que subtemas trae (no se inventan). */
  const unmetContentMin = new Set<string>();
  const splitDetail = (cc: WorkChapter) => `Capítulo «${cc.title}» con los subtemas del documento ${cc.split ? `(${joinList(cc.split.subtopics)}, del contenido «${cc.split.sourceTitle}»)` : ''}`;
  const appModuleMax = rq?.applicationPerModule?.max ?? Infinity;
  const appModuleMin = rq?.applicationPerModule?.min ?? 0;
  const appTotalMax = rq?.applicationTotal?.max ?? Infinity;
  const appTotalMin = rq?.applicationTotal?.min ?? 0;
  // Cupo de Actividades del documento. Si el documento las ubica en el capítulo de práctica, la que el docente fija en un
  // capítulo de contenido queda fuera de ese lugar: es su excepción y no ocupa el cupo de la práctica (que se conserva).
  const inQuota = (c: WorkChapter) => !!c.applicationMinutes && !(appInPractice && c.kind !== 'practice' && pinnedApp(c.id) !== undefined);
  const appCount = (cs: WorkChapter[]) => cs.filter(inQuota).length;
  const appTotal = () => design.reduce((n, m) => n + appCount(m.chapters), 0);
  const actMin = rq?.activitiesTotal?.min ?? 0;
  const actMax = rq?.activitiesTotal?.max ?? Infinity;
  const actTotal = () => design.reduce((n, m) => n + m.chapters.filter((c) => c.activityEnabled).length, 0);
  const activitiesOk = () => actTotal() >= actMin && actTotal() <= actMax;
  /**
   * LOOP 9.2 · «Exactamente N actividades interactivas»: si sobran, se quitan primero de las prácticas (su Actividad de
   * Aplicación se queda) y después de los últimos capítulos de contenido; si faltan, se agregan en el contenido.
   */
  const fitActivities = () => {
    if (activitiesOk()) return;
    // Review C1 / 3.ª I1: nunca una actividad que fijó el docente (Cursia ajusta las demás). Review 3.ª I2: con «1 por
    // capítulo de contenido», solo se apagan las de práctica; si no alcanza, la diferencia la explica Verificación.
    const order = design.flatMap((m) => m.chapters).filter((c) => pinnedActivity(c.id) === undefined).sort((a, b) => (a.kind === 'practice' ? 0 : 1) - (b.kind === 'practice' ? 0 : 1));
    for (const c of order) { if (actTotal() <= actMax) break; if (c.activityEnabled && !(rq?.activitiesInEveryContent && c.kind !== 'practice')) c.activityEnabled = false; }
    for (const c of [...order].reverse()) { if (actTotal() >= actMin) break; if (!c.activityEnabled && c.kind !== 'practice') c.activityEnabled = true; }
    // Review M1: si con el contenido no alcanza, también las prácticas.
    for (const c of order) { if (actTotal() >= actMin) break; if (!c.activityEnabled) c.activityEnabled = true; }
    reEval();
  };

  // r79.1 (rendimiento): la entrada de cada capítulo se reutiliza (mismo objeto) mientras su estado no cambie; el modelo de
  // tiempo reconoce el objeto y no vuelve a calcular el capítulo. Misma entrada, mismo resultado.
  const chInputs = new Map<string, StudyTimeCourseInput['modules'][number]['chapters'][number]>();
  // Número estable por capítulo (el objeto del diseño no cambia de identidad aunque cambien sus campos).
  const chNo = new WeakMap<WorkChapter, number>();
  let chSeq = 0;
  const noOf = (c: WorkChapter) => { let n = chNo.get(c); if (n === undefined) { n = ++chSeq; chNo.set(c, n); } return n; };
  /** Estado del capítulo que cambia su tiempo: tipo, video, actividad, Actividad y ejercicios guiados. */
  const chState = (c: WorkChapter, withApplication: boolean) => {
    const app = withApplication && c.applicationMinutes ? c.applicationMinutes : 0;
    const gp = withApplication && c.kind === 'content' && c.guidedPracticeMinutes ? c.guidedPracticeMinutes : 0;
    return `${noOf(c)}${c.kind === 'practice' ? 'p' : 'c'}${c.videoEnabled ? 1 : 0}${c.activityEnabled ? 1 : 0}.${app}.${gp}`;
  };
  const chapterInput = (c: WorkChapter, withApplication: boolean, k = chState(c, withApplication)) => {
    let x = chInputs.get(k);
    if (!x) {
      const app = withApplication && c.applicationMinutes ? c.applicationMinutes : 0;
      const gp = withApplication && c.kind === 'content' && c.guidedPracticeMinutes ? c.guidedPracticeMinutes : 0;
      x = {
        chapterId: c.id,
        kind: c.kind,
        libro: c.kind === 'content',
        presentation: c.kind === 'content',
        video: c.kind === 'content' && c.videoEnabled,
        ivAdvanced,
        activity: c.activityEnabled,
        review,
        ...(app ? { applicationMinutes: app } : {}),
        ...(gp ? { guidedPracticeMinutes: gp } : {}),
      };
      chInputs.set(k, x);
    }
    return x;
  };
  const toInput = (withApplication: boolean): StudyTimeCourseInput => ({
    frame: true,
    welcomeAudio: true,
    forum: true,
    finalExam: snapshot.course.finalExam === true,
    modules: design.map((m) => ({
      moduleId: m.id,
      intro: true,
      exam: m.examEnabled,
      chapters: m.chapters.map((c) => chapterInput(c, withApplication)),
    })),
  });
  // r79.1 (rendimiento): el crecimiento prueba un nivel, mide y vuelve atrás cientos de veces; la estimación depende solo del
  // estado del diseño (tipo, video, actividad, Actividad y ejercicios guiados de cada capítulo, en orden). Caché local de
  // ESTA llamada (mismo resultado; los objetos no se modifican).
  const estMemo = new Map<string, StudyTimeEstimate>();
  const estimateNow = (): StudyTimeEstimate => {
    const keys = design.map((m) => m.chapters.map((c) => chState(c, true)));
    const k = design.map((m, i) => `${i}${m.examEnabled ? '+' : '-'}${m.chapters.length}:${keys[i].join(',')}`).join('|');
    const hit = estMemo.get(k);
    if (hit) return hit;
    const e = estimateCourseStudyTime({
      frame: true, welcomeAudio: true, forum: true, finalExam: snapshot.course.finalExam === true,
      modules: design.map((m, i) => ({ moduleId: m.id, intro: true, exam: m.examEnabled, chapters: m.chapters.map((c, j) => chapterInput(c, true, keys[i][j])) })),
    });
    estMemo.set(k, e);
    return e;
  };
  let est = estimateNow();
  const reEval = () => (est = estimateNow());
  const minutes = () => est.courseEstimatedMinutes;
  const reached = () => minutes() >= target - tol;
  const chapterMinutes = (id: string) => est.modules.flatMap((m) => m.chapters).find((c) => c.chapterId === id)?.chapterEstimatedMinutes ?? 0;
  const roleOf = (m: WorkModule, c: WorkChapter) => chapterRole(m.chapters.indexOf(c), m.chapters.length);
  const changes: DistributionChange[] = [];
  const priorityTrace: string[] = [];
  // Fase 2 (review I2): minutos de Actividad de Aplicación con los que llegó cada capítulo existente; quitar o cambiar
  // una actividad ES un cambio (si no, «Ninguna» dejaría las actividades en la base y se generarían igual).
  const initialMinutes = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.applicationMinutes] as const)));
  const initialGuided = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.guidedPracticeMinutes ?? null] as const)));
  let guidedFill: DistributionResult['guidedPracticeFill'];
  const pushRemovals = () => {
    for (const m of design) for (const c of m.chapters) {
      if (c.proposed || initialMinutes.get(c.id) == null || c.applicationMinutes !== null) continue;
      if (changes.some((x) => x.type === 'remove_application_activity' && x.chapterId === c.id)) continue;
      changes.push({ type: 'remove_application_activity', moduleId: m.id, chapterId: c.id, detail: `Se quita la Actividad de Aplicación de ${initialMinutes.get(c.id)} min de «${c.title}».` });
    }
  };
  let baseHours = r1(estimateCourseStudyTime(toInput(false)).courseEstimatedMinutes / 60);

  const pushVideoChanges = () => {
    for (const m of design) for (const c of m.chapters) {
      if (c.proposed || c.kind !== 'content' || initialVideo.get(c.id) === c.videoEnabled) continue;
      if (changes.some((x) => x.type === 'set_video' && x.chapterId === c.id)) continue;
      const why = compOn && videoComp ? videoComp.decisions.find((d) => d.chapterId === c.id)?.reason : undefined;
      changes.push({ type: 'set_video', moduleId: m.id, chapterId: c.id, detail: (c.videoEnabled ? `«${c.title}» lleva video.` : `«${c.title}» queda sin video.`) + (why ? ` ${why}` : '') });
    }
  };
  const result = (status: DistributionStatus, recs: string[]): DistributionResult => {
    // LOOP 9.2: el total de actividades interactivas que exige el documento se cumple en cualquier salida.
    fitActivities();
    // Review 2.ª (I5): la prioridad audiovisual se aplica sobre la lista FINAL de capítulos de contenido (con los que se
    // agregaron), igual que la verá la siguiente pasada: así aplicar el diseño es un punto fijo.
    if (compOn) {
      if (applyComposition()) reEval();
    } else if (av) {
      let changed = false;
      for (const m of design) {
        const content = m.chapters.filter((c) => c.kind === 'content');
        content.forEach((c, i) => {
          if (pinnedVideo(c.id) !== undefined) return;
          // La profundización que propone Cursia sigue la regla de 8.3 (sin video con «Recomendado»).
          // r72: también la que ya se aplicó (sigue llamándose «Profundización N: <módulo>»): antes, al aplicarla dejaba de ser
          // «propuesta», la regla le ponía video y la siguiente pasada recomendaba otros ~30 cambios (#87: 36 → 31 → 0).
          // r80: un capítulo que sale de los subtemas del documento es contenido real (no profundización).
          // r80 · con capítulos reales y «Recomendado», además del reparto de siempre lleva video todo capítulo cuyo tipo de
          // aprendizaje lo necesita (procedimiento, protocolo, comunicación: learning-type + video-composition), aunque cierre.
          const v = reqVideo !== null ? reqVideo : avFor(i, content.length, !c.split && (!!c.proposed || isCursiaDeepening(c)))
            || (realChapters && av === 'recommended' && needsVideo(c));
          if (c.videoEnabled !== v) { c.videoEnabled = v; changed = true; }
        });
      }
      if (changed) reEval();
    }
    // r80 · salvaguarda: el estado se confirma con las horas FINALES (después de la regla de video); nunca se informa
    // «dentro de la tolerancia» con un total que no lo está.
    if (realChapters && status === 'within_tolerance' && Math.abs(minutes() - target) > tol + 1e-9) {
      const g = target - minutes();
      status = g > 0 ? 'cannot_reach_target' : 'above_tolerance';
      recs = [...recs, `El diseño queda en ${fmtH(minutes() / 60)} h, ${fmtH(Math.abs(g) / 60)} h ${g > 0 ? 'por debajo' : 'por encima'} del objetivo.`];
    }
    // r80 · los títulos de los capítulos divididos se fijan al final (cada división nueva reparte de nuevo los subtemas):
    // los textos de sus cambios se escriben con el estado final, y el capítulo de origen registra su nuevo título.
    if (realChapters) {
      for (const src of splitSources) {
        if (src.parts.length < 2) continue;
        for (const c of src.parts.slice(1)) {
          const ch = changes.find((x) => x.type === 'add_content_chapter' && x.chapterId === c.id);
          if (!ch) continue;
          const req = ch.requirementId ? ' (lo pide el documento)' : '';
          ch.subtopics = [...(c.split?.subtopics ?? [])];
          ch.detail = `${splitDetail(c)}${c.videoEnabled ? ', con video' : ''}, actividad${review ? ', repaso' : ''}${c.applicationMinutes ? ` y Actividad de Aplicación de ${c.applicationMinutes} min` : ''}${req}.`;
        }
        const c0 = src.parts[0];
        if (!changes.some((x) => x.type === 'split_content_chapter' && x.chapterId === c0.id)) {
          changes.push({ type: 'split_content_chapter', moduleId: src.m.id, chapterId: c0.id, subtopics: [...(c0.split?.subtopics ?? [])],
            detail: `«${src.sourceTitle}» se reparte en ${src.parts.length} capítulos con sus subtemas del documento: ${src.parts.map((p) => `«${p.title}»`).join(', ')}. Este capítulo pasa a llamarse «${c0.title}».` });
        }
      }
      if (unmetContentMin.size) recs = [...recs, `El documento pide más capítulos de contenido de los que permiten sus subtemas en ${[...unmetContentMin].map((t) => `«${t}»`).join(', ')}: Cursia no inventa capítulos sin tema. Agrega los temas en el editor o revisa el documento.`];
    }
    pushRemovals();
    pushVideoChanges();
    // Loop 9 B: cambios de la práctica guiada en los capítulos existentes (los propuestos la llevan en su detalle).
    for (const m of design) for (const c of m.chapters) {
      const had = initialGuided.get(c.id) ?? null;
      const now = c.kind === 'content' ? c.guidedPracticeMinutes ?? null : null;
      if (c.proposed || had === now || changes.some((x) => (x.type === 'set_guided_practice' || x.type === 'remove_guided_practice') && x.chapterId === c.id)) continue;
      changes.push(now
        ? { type: 'set_guided_practice', moduleId: m.id, chapterId: c.id, detail: had ? `Ejercicios guiados de «${c.title}»: de ${had} a ${now} min.` : `Ejercicios guiados de ${now} min en el capítulo «${c.title}».` }
        : { type: 'remove_guided_practice', moduleId: m.id, chapterId: c.id, detail: `Se quitan los ejercicios guiados de ${had} min de «${c.title}».` });
    }
    for (const m of design) for (const c of m.chapters) {
      if (c.proposed || initialActivity.get(c.id) === c.activityEnabled) continue;
      changes.push({ type: 'set_activity', moduleId: m.id, chapterId: c.id, detail: c.activityEnabled ? `«${c.title}» lleva actividad interactiva.` : `«${c.title}» queda sin actividad interactiva (el documento pide un total exacto de actividades interactivas).` });
    }
    const generable = est; // Fase 2: las Actividades de Aplicación se generan
    // Re-revisión L3: los capítulos de práctica no tienen tope de aplicación; si el diseño queda por encima de la
    // proporción del enfoque, se dice explícitamente.
    const share = est.byComponent.application / est.courseEstimatedMinutes;
    const vc = compOn ? (videoComp as VideoCompositionResult | null) : null;
    if (vc && vc.unmet.length) recs = [...recs, ...vc.unmet];
    if (vc && !priorityTrace.some((t) => t.startsWith('Composición por necesidad'))) {
      priorityTrace.push(`Composición por necesidad (plan de aprendizaje): ${vc.counts.videos} de ${vc.counts.contentChapters} capítulos de contenido llevan video — ${vc.counts.byNeed} porque su tipo de aprendizaje lo necesita (demostración o modelado), ${vc.counts.optional} opcionales${vc.counts.pinned ? ` y ${vc.counts.pinned} fijados por el docente` : ''}. Presupuesto de horas: hasta ${vc.hoursBudgetVideos} videos en ${fmtH(input.targetHours)} h para los opcionales.`);
    }
    const decisionOf = new Map((vc ? vc.decisions : []).map((d) => [d.chapterId, d]));
    const recommendations = share > policy.maxApplicationShare + 1e-9
      ? [...recs, `El ${Math.round(share * 100)} % de este diseño son Actividades de Aplicación (más que el ${Math.round(policy.maxApplicationShare * 100)} % habitual del enfoque). ${realChapters && !splitSources.some((x) => x.parts.length < maxPartsFor(x.items.length))
        ? 'El documento no trae más subtemas para nuevos capítulos de contenido (Cursia no inventa temas): si la institución quiere más contenido, agrega temas al microcurrículo o baja la carga horaria.'
        : 'Si el curso es chico, conviene sumar capítulos de contenido o un módulo en lugar de más práctica.'}`]
      : recs;
    const estChapter = new Map(est.modules.flatMap((m) => m.chapters).map((c) => [c.chapterId, c.chapterEstimatedMinutes]));
    const genChapter = new Map(generable.modules.flatMap((m) => m.chapters).map((c) => [c.chapterId, c.chapterEstimatedMinutes]));
    const modules: ProposedModule[] = design.map((m) => ({
      id: m.id,
      title: m.title,
      examEnabled: m.examEnabled,
      ...(noPracticeModule(m.id) ? { practiceRemovedByTeacher: true } : {}),
      chapters: m.chapters.map((c) => ({
        id: c.id,
        proposed: c.proposed,
        kind: c.kind,
        title: c.title,
        objective: c.objective,
        role: roleOf(m, c),
        videoEnabled: c.kind === 'content' && c.videoEnabled,
        videoPinned: pinnedVideo(c.id) !== undefined,
        applicationPinned: pinnedApp(c.id) !== undefined,
        activityPinned: pinnedActivity(c.id) !== undefined,
        activityEnabled: c.activityEnabled,
        review,
        applicationMinutes: c.applicationMinutes,
        guidedPracticeMinutes: c.kind === 'content' ? c.guidedPracticeMinutes ?? null : null,
        guidedPracticePinned: pinnedGuided(c.id) !== undefined,
        ...(vc && c.kind === 'content' && decisionOf.has(c.id) ? (() => { const d = decisionOf.get(c.id)!; return { videoDecision: { ruleId: d.ruleId, need: d.need, learningType: d.learningType, reason: d.reason } }; })() : {}),
        targetMinutes: estChapter.get(c.id) as number,
        generableMinutes: genChapter.get(c.id) as number,
        ...(c.split && c.split.parts > 1 ? { split: { ...c.split, subtopics: [...c.split.subtopics], outcomeIds: [...c.split.outcomeIds] }, ...(c.description ? { description: c.description } : {}) } : {}),
      })),
    }));
    const all = modules.flatMap((m) => m.chapters);
    const appMinutes = all.reduce((n, c) => n + (c.applicationMinutes ?? 0), 0);
    const gpMinutes = all.reduce((n, c) => n + (c.guidedPracticeMinutes ?? 0), 0);
    return {
      distributorVersion: DISTRIBUTOR_VERSION,
      dryRun: true,
      providersCalled: 0,
      targetHours: input.targetHours,
      toleranceHours: r1(tol / 60),
      status,
      baseHours,
      estimatedHours: est.courseEstimatedHours,
      generableHours: generable.courseEstimatedHours,
      deltaHours: r1(est.courseEstimatedHours - input.targetHours),
      applicationShare: Math.round((est.byComponent.application / est.courseEstimatedMinutes) * 100) / 100,
      policy,
      preferences: { emphasis: prefs.emphasis ?? 'balanced', applicationActivities: appMode, ...(av ? { audiovisual: av } : {}) },
      modules,
      changes,
      recommendations,
      priorityTrace,
      counts: {
        modules: modules.length,
        chapters: all.length,
        contentChapters: all.filter((c) => c.kind === 'content').length,
        practiceChapters: all.filter((c) => c.kind === 'practice').length,
        videoChapters: all.filter((c) => c.videoEnabled).length,
        activities: all.filter((c) => c.activityEnabled).length,
        reviews: all.filter((c) => c.review).length,
        applicationActivities: all.filter((c) => c.applicationMinutes).length,
        applicationMinutes: appMinutes,
        ...(gpMinutes > 0 ? { guidedPractices: all.filter((c) => c.guidedPracticeMinutes).length, guidedPracticeMinutes: gpMinutes } : {}),
        evaluations: modules.filter((m) => m.examEnabled).length + (snapshot.course.finalExam ? 1 : 0),
      },
      ...(vc ? { composition: { version: VIDEO_COMPOSITION_VERSION, videos: { hoursBudgetVideos: vc.hoursBudgetVideos, counts: { ...vc.counts }, unmet: [...vc.unmet], ...(lpComp!.minVideos !== undefined ? { minVideos: lpComp!.minVideos } : {}), ...(lpComp!.maxVideos !== undefined ? { maxVideos: lpComp!.maxVideos } : {}) } } } : {}),
      hoursByComponent: Object.fromEntries(Object.entries(est.byComponent).map(([k, v]) => [k, r1(v / 60)])),
      studyTime: est,
      ...(guidedFill ? { guidedPracticeFill: guidedFill } : {}),
    };
  };

  const fmtH = (n: number) => String(r1(n)).replace('.', ',');
  const initialRoles = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, roleOf(m, c)] as const)));

  // Fase 2 — «ya cumple»: si la estructura ACTUAL, con sus Actividades de Aplicación (p. ej. un diseño ya aplicado o
  // fijado a mano), queda dentro de la tolerancia y respeta las preferencias, no se propone nada (el distribuidor es
  // estable sobre su propio resultado). Si no, se rediseña desde cero (las actividades existentes no condicionan).
  const hasExisting = design.some((m) => m.chapters.some((c) => c.applicationMinutes !== null || (c.guidedPracticeMinutes ?? null) !== null));
  const respectsMode = design.every((m) => m.chapters.every((c) => (c.applicationMinutes === null || (appMode !== 'none' && (appMode !== 'practice_only' || c.kind === 'practice')))
    && (guidedMode !== 'none' || !c.guidedPracticeMinutes || pinnedGuided(c.id) !== undefined)));
  // LOOP 8.6C: «ya cumple» también exige cumplir los requisitos del documento que el distribuidor maneja.
  const meetsRequirements = () => design.every((m) => m.chapters.length >= minCh && m.chapters.length <= maxCh && appCount(m.chapters) >= appModuleMin && appCount(m.chapters) <= appModuleMax
      && contentCount(m.chapters) >= contentMin && contentCount(m.chapters) <= contentMax && practiceCount(m.chapters) >= pMin(m) && practiceCount(m.chapters) <= pMax(m)
      && (!appInPractice || m.chapters.every((c) => !c.applicationMinutes || c.kind === 'practice')))
    && appTotal() >= appTotalMin && appTotal() <= appTotalMax && activitiesOk();
  if (hasExisting && respectsMode && Math.abs(minutes() - target) <= tol && meetsRequirements()) {
    priorityTrace.push('La estructura actual, con sus Actividades de Aplicación, ya cumple la carga horaria objetivo: no se propone ningún cambio.');
    // LOOP 7 (A2 A2): «Ajustar» el énfasis o el enfoque sobre un diseño que ya cumple no cambia nada; se dice (y por
    // qué) en lugar de mostrar un «diseño ya aplicado» mudo con preferencias nuevas.
    return result('within_tolerance', [
      `El diseño vigente ya cumple ${fmtH(input.targetHours)} h con sus capítulos y Actividades de Aplicación: no hay cambios que proponer. Cursia no quita capítulos ni actividades por su cuenta; si cambiaste el énfasis o el enfoque y quieres otra estructura, ajústala en el editor (quitar o agregar capítulos) y vuelve a ver el diseño.`,
    ]);
  }
  if (hasExisting) {
    for (const m of design) for (const c of m.chapters) if (pinnedApp(c.id) === undefined) c.applicationMinutes = null;
    // Loop 9 B: la práctica guiada no fijada también se rediseña (se vuelve a calcular al final, si hace falta).
    for (const m of design) for (const c of m.chapters) if (pinnedGuided(c.id) === undefined) c.guidedPracticeMinutes = null;
    reEval();
  }

  // LOOP 8.6C · 0) Estructura exigida por el documento: un módulo con MENOS capítulos que el mínimo se completa con
  // capítulos PROPUESTOS (primero uno de práctica — D1: cuenta dentro de «X capítulos por módulo» —, después de
  // profundización). Es una propuesta como cualquier otra: el docente la ve y la aplica con «Usar este diseño».
  const filledPractice = new Set<string>();
  // LOOP 9.2 · «N capítulos de práctica por módulo» y «N capítulos de contenido por módulo»: el documento los exige aunque
  // las horas ya alcancen (antes la práctica se descartaba «porque no hacía falta para estas horas»).
  if (practiceMin > 0 || contentMin > 0 || practiceTotalMin > 0 || (byModule && byModule.some((n) => n > 0))) {
    for (const m of design) {
      let k = practiceCount(m.chapters);
      // Review I1: sin pasar del máximo de capítulos por módulo del documento (D1: ahí la práctica cuenta).
      while (k < pMin(m) && m.chapters.length < maxCh && !noPracticeModule(m.id)) {
        k++;
        const pc: WorkChapter = { id: `proposed:practice:${m.id}:${k}`, proposed: true, kind: 'practice', title: practiceTitle(k, m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`, videoEnabled: false, activityEnabled: true, applicationMinutes: null };
        m.chapters.push(pc);
        filledPractice.add(pc.id);
        const want = pMin(m);
        changes.push({ type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id, detail: byModule
          ? `Capítulo de práctica «${pc.title}» (la mezcla de práctica del curso pide ${want} ${want === 1 ? 'capítulo de práctica' : 'capítulos de práctica'} en este módulo).`
          : `Capítulo de práctica «${pc.title}» (el documento pide ${practiceMin} ${practiceMin === 1 ? 'capítulo de práctica' : 'capítulos de práctica'} por módulo).`, ...(rq?.sources.practice ? { requirementId: rq.sources.practice } : {}) });
      }
      let n = m.chapters.filter((c) => c.kind === 'content' && c.proposed).length;
      while (contentCount(m.chapters) < contentMin) {
        if (realChapters) {
          // r80: el mínimo del documento se completa con sus propios subtemas; si no hay más, no se inventa un capítulo.
          const sc = splitNext(m);
          if (!sc) { unmetContentMin.add(m.title); break; }
          changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: sc.id, detail: `${splitDetail(sc)} (el documento pide ${contentMin} capítulos de contenido por módulo).`, subtopics: [...(sc.split?.subtopics ?? [])], ...(rq?.sources.chapters ? { requirementId: rq.sources.chapters } : {}) });
          continue;
        }
        n++;
        const cc: WorkChapter = { id: `proposed:content:${m.id}:${n}`, proposed: true, kind: 'content', title: proposedTitle(`Profundización ${n}`, m.title),
          objective: `Analizar casos complejos de «${m.title}»`, videoEnabled: reqVideo !== null ? reqVideo : m.chapters.some((c) => c.kind === 'content' && c.videoEnabled), activityEnabled: true, applicationMinutes: null };
        let last = -1;
        m.chapters.forEach((c, i) => { if (c.kind === 'content') last = i; });
        m.chapters.splice(last + 1, 0, cc);
        changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: cc.id, detail: `Capítulo de profundización «${cc.title}» (el documento pide ${contentMin} capítulos de contenido por módulo).`, ...(rq?.sources.chapters ? { requirementId: rq.sources.chapters } : {}) });
      }
    }
    // Review I11: «N capítulos de práctica» en el curso: uno por módulo por turno (sin pasar de los máximos del documento).
    for (let round = 0; practiceTotal() < practiceTotalMin && round < 4; round++) {
      for (const m of design) {
        if (practiceTotal() >= practiceTotalMin) break;
        if (m.chapters.length >= maxCh || practiceCount(m.chapters) >= pMax(m) || noPracticeModule(m.id)) continue;
        const k = practiceCount(m.chapters) + 1;
        const pc: WorkChapter = { id: `proposed:practice:${m.id}:${k}`, proposed: true, kind: 'practice', title: proposedTitle(k === 1 ? 'Práctica integradora' : 'Práctica de casos', m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`, videoEnabled: false, activityEnabled: true, applicationMinutes: null };
        m.chapters.push(pc);
        filledPractice.add(pc.id);
        changes.push({ type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id, detail: `Capítulo de práctica «${pc.title}» (el documento pide ${practiceTotalMin} ${practiceTotalMin === 1 ? 'capítulo de práctica' : 'capítulos de práctica'} en el curso).`, ...(rq?.sources.practice ? { requirementId: rq.sources.practice } : {}) });
      }
    }
    applyComposition();
    fitActivities();
    reEval();
    if (filledPractice.size || changes.some((x) => x.requirementId)) baseHours = r1(estimateCourseStudyTime(toInput(false)).courseEstimatedMinutes / 60);
  }
  if (minCh > 0) {
    const reqId = rq?.sources.chapters;
    const why = ` (el documento pide ${minCh === maxCh ? minCh : `al menos ${minCh}`} capítulos por módulo)`;
    for (const m of design) {
      if (m.chapters.length < minCh && !m.chapters.some((c) => c.kind === 'practice')) {
        const pc: WorkChapter = { id: `proposed:practice:${m.id}:1`, proposed: true, kind: 'practice', title: proposedTitle('Práctica integradora', m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`, videoEnabled: false, activityEnabled: true, applicationMinutes: null };
        m.chapters.push(pc);
        filledPractice.add(pc.id);
        changes.push({ type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id, detail: `Capítulo de práctica «${pc.title}»${why}.`, ...(reqId ? { requirementId: reqId } : {}) });
      }
      let n = m.chapters.filter((c) => c.kind === 'content' && c.proposed).length;
      while (m.chapters.length < minCh) {
        if (realChapters) {
          const sc = splitNext(m);
          if (!sc) { unmetContentMin.add(m.title); break; }
          changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: sc.id, detail: `${splitDetail(sc)}${why}.`, subtopics: [...(sc.split?.subtopics ?? [])], ...(reqId ? { requirementId: reqId } : {}) });
          continue;
        }
        n++;
        const cc: WorkChapter = { id: `proposed:content:${m.id}:${n}`, proposed: true, kind: 'content', title: proposedTitle(`Profundización ${n}`, m.title),
          objective: `Analizar casos complejos de «${m.title}»`, videoEnabled: reqVideo !== null ? reqVideo : av ? av === 'more' : m.chapters.some((c) => c.kind === 'content' && c.videoEnabled), activityEnabled: true, applicationMinutes: null };
        let last = -1;
        m.chapters.forEach((c, i) => { if (c.kind === 'content') last = i; });
        m.chapters.splice(last + 1, 0, cc);
        changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: cc.id, detail: `Capítulo de profundización «${cc.title}»${cc.videoEnabled ? ' con video' : ''}${why}.`, ...(reqId ? { requirementId: reqId } : {}) });
      }
    }
    applyComposition();
    reEval();
    // Review L86C I2: las horas base incluyen los capítulos que exige el documento (con ellas Cursia propone la meta y
    // el botón «Diseñar para N h»; sin esto proponía una meta que el diseño exigido ya superaba).
    if (filledPractice.size || changes.some((x) => x.requirementId)) baseHours = r1(estimateCourseStudyTime(toInput(false)).courseEstimatedMinutes / 60);
  }

  // 1) No rellenar: la estructura mínima ya supera el objetivo → informar y proponer, nunca recortar sola.
  if (minutes() > target + tol) {
    // LOOP 9.2: aun así, las Actividades de Aplicación que exige el documento (por módulo / en el curso) se ubican, con el
    // nivel más corto, en la práctica (o donde el documento diga): un requisito no desaparece porque sobren horas.
    const t0 = (STUDY_TIME_RULES.applicationActivityTiers as readonly number[]).filter((t) => tierOk(t))[0];
    const place = (m: WorkModule) => {
      const c = m.chapters.filter((x) => !x.applicationMinutes && pinnedApp(x.id) === undefined && (!appInPractice || x.kind === 'practice') && appMode !== 'none' && (appMode !== 'practice_only' || x.kind === 'practice'))
        .sort((a, b) => (a.kind === 'practice' ? 0 : 1) - (b.kind === 'practice' ? 0 : 1))[0];
      if (!c) return false;
      c.applicationMinutes = t0;
      return true;
    };
    if (appModuleMin > 0) for (const m of design) while (appCount(m.chapters) < appModuleMin && appCount(m.chapters) < appModuleMax && appTotal() < appTotalMax && place(m));
    if (appTotalMin > 0) for (const m of design) { while (appTotal() < appTotalMin && appCount(m.chapters) < appModuleMax && place(m)); }
    reEval();
    const chs = est.modules.flatMap((m) => m.chapters);
    const contentChapterAvg = avg(chs.map((c) => c.chapterEstimatedMinutes));
    const remove = Math.ceil((minutes() - target) / contentChapterAvg);
    const reduce = remove < chs.length
      ? `Para acercarse habría que quitar unos ${remove} capítulo(s) de contenido (≈ ${fmtH(contentChapterAvg)} min cada uno) o un módulo completo, o apagar videos o actividades.`
      : `Ni quitando capítulos se llega: el marco del curso (bienvenida, foro y evaluaciones) ya ocupa buena parte del tiempo. Conviene revisar si el objetivo de ${fmtH(input.targetHours)} h es el correcto.`;
    return result('minimum_exceeds_target', [
      `La estructura mínima actual supera la carga horaria objetivo: ${fmtH(minutes() / 60)} h frente a ${fmtH(input.targetHours)} h (tolerancia ±${fmtH(tol / 60)} h).`,
      `${reduce} Cursia no recorta contenido por su cuenta: es una decisión del docente.`,
    ]);
  }

  // r79.1: solo los niveles con el candado abierto (con la especificación vigente, todos).
  const tiers = (STUDY_TIME_RULES.applicationActivityTiers as readonly number[]).filter((t) => tierOk(t));
  const contentChapters = () => design.flatMap((m) => m.chapters.filter((c) => c.kind === 'content').map((c) => ({ m, c })));
  // Orden de la aplicación: primero los cierres de módulo (integran el módulo), después el núcleo, al final las aperturas.
  const rank = (role: ChapterRole) => (role === 'module_closing' || role === 'single' ? 0 : role === 'module_opening' ? 2 : 1);
  const applicationOrder = () => contentChapters().map((x, i) => ({ ...x, i })).sort((a, b) => rank(roleOf(a.m, a.c)) - rank(roleOf(b.m, b.c)) || a.i - b.i);
  // Topes de la Actividad de Aplicación en uso: los del enfoque; con la forma fija y la meta fuera de alcance, los más amplios
  // que Cursia ya produce (ver «agotar capacidades» abajo).
  const caps = { contentTierMax: policy.contentTierMax, closingTierMax: policy.closingTierMax, maxApplicationShare: policy.maxApplicationShare };
  const capOf = (m: WorkModule, c: WorkChapter) => (c.kind === 'practice' || roleOf(m, c) === 'module_closing' ? caps.closingTierMax : caps.contentTierMax);
  const applicationShare = () => est.byComponent.application / minutes();

  /**
   * Fija el nivel de la Actividad de un capítulo SOLO si respeta el tope de su rol y los 240 min por capítulo; al
   * SUBIR un nivel ya asignado (alargar actividades) también la proporción máxima de aplicación del enfoque.
   */
  const trySetTier = (m: WorkModule, c: WorkChapter, tier: number | null): boolean => {
    if (pinnedApp(c.id) !== undefined) return false; // fijada por el docente
    if (tier !== null && tier > capOf(m, c)) return false;
    // «Ajustar»: sin Actividades de Aplicación, o solo en los capítulos de práctica.
    if (tier !== null && (appMode === 'none' || (appMode === 'practice_only' && c.kind !== 'practice'))) return false;
    // LOOP 9.2: el documento las ubica en el capítulo de práctica.
    if (tier !== null && appInPractice && c.kind !== 'practice') return false;
    // LOOP 8.6C: topes de Actividades de Aplicación del documento (por módulo y en el curso) para una actividad NUEVA.
    if (tier !== null && c.applicationMinutes === null && (appCount(m.chapters) >= appModuleMax || appTotal() >= appTotalMax)) return false;
    const prev = c.applicationMinutes;
    c.applicationMinutes = tier;
    reEval();
    const raises = prev !== null && (tier ?? 0) > prev;
    if (chapterMinutes(c.id) > DISTRIBUTOR_RULES.maxChapterMinutes || (raises && applicationShare() > caps.maxApplicationShare + 1e-9)) {
      c.applicationMinutes = prev;
      reEval();
      return false;
    }
    return true;
  };
  /** Tras insertar un capítulo los roles se recalculan por posición: ningún nivel queda por encima del tope de su rol nuevo. */
  const clampToRoleCaps = () => {
    for (const m of design) for (const c of m.chapters) {
      if (c.applicationMinutes === null || c.applicationMinutes <= capOf(m, c) || pinnedApp(c.id) !== undefined) continue;
      c.applicationMinutes = [...tiers].reverse().find((t) => t <= capOf(m, c)) ?? null;
    }
    reEval();
  };

  // 2) Aplicación: subir el nivel de la Actividad por rondas (30 → tope) en los capítulos de contenido.
  const growApplication = (): boolean => {
    for (const tier of tiers) {
      for (const { m, c } of applicationOrder()) {
        if (reached()) return true;
        if (c.applicationMinutes !== null && c.applicationMinutes >= tier) continue;
        trySetTier(m, c, tier);
      }
    }
    return reached();
  };
  // 3) Práctica: capítulos de práctica (sin video, Gamma ni audiolibro). El primero cierra el módulo; el segundo va al medio.
  //    Su Actividad toma el nivel de cierre del enfoque (es estructura de aplicación, no una actividad alargada).
  const addPractice = (): boolean => {
    for (let round = 1; round <= policy.practicePerModule; round++) {
      for (const m of design) {
        if (reached()) return true;
        const existing = m.chapters.filter((c) => c.kind === 'practice');
        if (existing.length < round && m.chapters.length >= maxCh) continue; // LOOP 8.6C: no pasar del máximo del documento
        if (existing.length < round && existing.length >= pMax(m)) continue; // LOOP 9.2: ni del máximo de prácticas
        if (existing.length < round && practiceTotal() >= practiceTotalMax) continue; // ni del total de prácticas del curso
        if (existing.length < round && noPracticeModule(m.id)) continue; // el docente quitó la práctica de este módulo
        if (existing.length >= round) {
          // LOOP 7 (A1): la práctica que YA existe en esta ronda recibe su Actividad igual que al crearla (mismo momento y
          // nivel de cierre). Antes, el rediseño la dejaba sin actividad y el diseño aplicado no era un punto fijo.
          const pc0 = existing[round - 1];
          if ((!pc0.proposed || filledPractice.has(pc0.id)) && pc0.applicationMinutes === null) for (const t of [...tiers].reverse()) if (trySetTier(m, pc0, t)) break;
          continue;
        }
        const pc: WorkChapter = {
          id: `proposed:practice:${m.id}:${round}`,
          proposed: true,
          kind: 'practice',
          title: proposedTitle(round === 1 ? 'Práctica integradora' : 'Práctica de casos', m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`,
          videoEnabled: false,
          activityEnabled: true,
          applicationMinutes: null,
        };
        if (round === 1) m.chapters.push(pc);
        else m.chapters.splice(Math.ceil(m.chapters.length / 2), 0, pc);
        clampToRoleCaps();
        for (const t of [...tiers].reverse()) if (trySetTier(m, pc, t)) break;
        changes.push({
          type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id,
          detail: `Capítulo de práctica «${pc.title}»: sin video, presentación ni audiolibro; actividad H5P${review ? ', repaso' : ''}${pc.applicationMinutes ? ` y Actividad de Aplicación de ${pc.applicationMinutes} min` : ''}.`,
        });
      }
    }
    return reached();
  };
  // 4) Profundización: capítulos de contenido (con video si el curso usa video) hasta el tope por módulo.
  const addContent = (): boolean => {
    if (noContentAdditions) return reached();
    for (let k = 0; k < DISTRIBUTOR_RULES.maxContentChaptersPerModule; k++) {
      for (const m of design) {
        if (reached()) return true;
        const content = m.chapters.filter((c) => c.kind === 'content');
        if (content.length >= DISTRIBUTOR_RULES.maxContentChaptersPerModule) continue;
        if (m.chapters.length >= maxCh) continue; // LOOP 8.6C: no pasar del máximo del documento
        if (content.length >= contentMax) continue; // LOOP 9.2: ni del máximo de capítulos de contenido
        if (realChapters) {
          // r80: el capítulo nuevo sale de los subtemas del documento; sin subtemas, este módulo no crece en contenido.
          const sc = splitNext(m);
          if (!sc) continue;
          applyComposition();
          clampToRoleCaps();
          trySetTier(m, sc, tiers[0]);
          changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: sc.id, subtopics: [...(sc.split?.subtopics ?? [])],
            detail: `${splitDetail(sc)}${sc.videoEnabled ? ', con video' : ''}, actividad${review ? ', repaso' : ''}${sc.applicationMinutes ? ` y Actividad de Aplicación de ${sc.applicationMinutes} min` : ''}.` });
          growApplication();
          continue;
        }
        const n = content.filter((c) => c.proposed).length + 1;
        // Sin preferencia: como siempre (hereda el video del módulo). Con preferencia: solo «Más» pone video en la profundización.
        const usesVideo = reqVideo !== null ? reqVideo : av ? avFor(content.length, content.length + 1, true) : content.some((c) => c.videoEnabled);
        const cc: WorkChapter = {
          id: `proposed:content:${m.id}:${n}`,
          proposed: true,
          kind: 'content',
          title: proposedTitle(`Profundización ${n}`, m.title),
          objective: `Analizar casos complejos de «${m.title}»`,
          videoEnabled: usesVideo,
          activityEnabled: true,
          applicationMinutes: null,
        };
        // Después del último capítulo de contenido (las prácticas siguen cerrando el módulo).
        let last = -1;
        m.chapters.forEach((c, i) => { if (c.kind === 'content') last = i; });
        m.chapters.splice(last + 1, 0, cc);
        applyComposition(); // T3: la profundización también se decide por necesidad (clampToRoleCaps recalcula)
        clampToRoleCaps();
        trySetTier(m, cc, tiers[0]);
        changes.push({
          type: 'add_content_chapter', moduleId: m.id, chapterId: cc.id,
          detail: `Capítulo de profundización «${cc.title}»${cc.videoEnabled ? ' con video' : ''}, actividad${review ? ', repaso' : ''}${cc.applicationMinutes ? ` y Actividad de Aplicación de ${cc.applicationMinutes} min` : ''}.`,
        });
        growApplication();
      }
    }
    return reached();
  };

  // LOOP 7 (A1 + REVIEW-L7 I1): una práctica que YA existe y a la que la etapa de práctica no llegó (el objetivo se
  // alcanzó antes) recupera su Actividad SOLO con un nivel que mantenga el total dentro de la tolerancia y la
  // proporción de aplicación del enfoque (si ninguno cabe, queda sin actividad: nunca empeora el estado del diseño).
  const seedLeftoverPractice = () => {
    for (const m of design) for (const c of m.chapters) {
      // LOOP 8.6C: la práctica propuesta para completar la estructura del documento también recibe su Actividad aquí.
      if (c.kind !== 'practice' || (c.proposed && !filledPractice.has(c.id)) || c.applicationMinutes !== null) continue;
      for (const t of [...tiers].reverse()) {
        if (!trySetTier(m, c, t)) continue;
        if (minutes() <= target + tol && applicationShare() <= caps.maxApplicationShare + 1e-9) break;
        c.applicationMinutes = null;
        reEval();
      }
    }
  };

  const steps = { application: growApplication, practice: addPractice, content: addContent };
  for (const s of policy.order) {
    if (steps[s]()) break;
    growApplication();
  }
  seedLeftoverPractice();
  // Fase 2/4 · punto fijo: con la forma de la institución (sin capítulos de contenido nuevos) y sin llegar al objetivo, el
  // orden en que se reparten los niveles cambia el resultado (las prácticas nuevas toman su nivel al crearse; al rediseñar
  // ya están). Se repite el reparto como lo hará el rediseño después de «Usar este diseño»: así lo aplicado no vuelve a
  // proponer cambios (la propuesta podría quedar bloqueada para siempre por «cambios sin aplicar»).
  if (noContentAdditions && !reached()) {
    // Agotar capacidades: antes de declarar que no se llega, se usa lo que Cursia ya produce dentro de la forma fija. Las
    // Actividades de Aplicación toman los topes más amplios que existen (los de «aplicación primero»: 90 min en contenido,
    // 120 en prácticas y cierres, hasta el 50 % del curso) aunque el enfoque prefiera actividades más cortas. No agrega
    // capítulos y los topes del documento (cuántas Actividades, dónde van) siguen mandando en trySetTier.
    const AF = DISTRIBUTOR_RULES.applicationFirst;
    const wider = { contentTierMax: Math.max(caps.contentTierMax, AF.contentTierMax), closingTierMax: Math.max(caps.closingTierMax, AF.closingTierMax), maxApplicationShare: Math.max(caps.maxApplicationShare, AF.maxApplicationShare) };
    if (wider.contentTierMax !== caps.contentTierMax || wider.closingTierMax !== caps.closingTierMax || wider.maxApplicationShare !== caps.maxApplicationShare) {
      Object.assign(caps, wider);
      priorityTrace.push(`La carga horaria objetivo no se alcanza con la forma fijada: las Actividades de Aplicación que se pueden incluir usan los niveles máximos de Cursia (hasta ${wider.contentTierMax} min en contenido y ${wider.closingTierMax} min en prácticas y cierres) antes de declarar la diferencia.`);
    }
    for (const m of design) for (const c of m.chapters) {
      if (c.kind === 'practice' && c.proposed) filledPractice.add(c.id);
      if (pinnedApp(c.id) === undefined) c.applicationMinutes = null;
    }
    reEval();
    for (const s of policy.order) {
      if (steps[s]()) break;
      growApplication();
    }
    seedLeftoverPractice();
  }
  // Ajuste fino: si se pasó, bajar niveles de a uno (empezando por las aperturas) SOLO mientras el total siga
  // dentro de la tolerancia por abajo (nunca descarta un diseño válido).
  // LOOP 9.2 (QA): las Actividades de los capítulos de práctica también se ajustan (al final). Antes solo se bajaban las de
  // contenido: con «AA en el capítulo de práctica» el diseño quedaba 1,4 h por encima del objetivo (120 + 30 min).
  const practiceApps = () => design.flatMap((m) => m.chapters.filter((c) => c.kind === 'practice').map((c) => ({ m, c })));
  for (const { c } of [...[...applicationOrder()].reverse(), ...[...practiceApps()].reverse()]) {
    if (pinnedApp(c.id) !== undefined) continue; // review L84-5: lo fijado por el docente no se ajusta
    while (c.applicationMinutes !== null && minutes() > target + tol / 2) {
      const i = tiers.indexOf(c.applicationMinutes);
      const lower = i > 0 ? tiers[i - 1] : null;
      if (lower === null) break;
      const prev = c.applicationMinutes;
      c.applicationMinutes = lower;
      reEval();
      if (minutes() < target - tol) {
        c.applicationMinutes = prev;
        reEval();
        break;
      }
    }
  }
  // LOOP 9.2 (QA): las prácticas del curso son la misma pieza en cada módulo; sus Actividades llevan el mismo nivel (antes
  // 120 min en un módulo y 30 en otro). Se elige el nivel común más cercano al objetivo que respete topes y tolerancia;
  // si ninguno cabe, queda como estaba. Lo fijado por el docente no se toca.
  const balancePractice = () => {
    const free = practiceApps().filter(({ c }) => c.applicationMinutes !== null && pinnedApp(c.id) === undefined);
    if (free.length < 2 || free.every(({ c }) => c.applicationMinutes === free[0].c.applicationMinutes)) return;
    const prev = free.map(({ c }) => c.applicationMinutes);
    const restore = () => { free.forEach(({ c }, i) => { c.applicationMinutes = prev[i]; }); reEval(); };
    let best: { t: number; dist: number } | null = null;
    for (const t of tiers) {
      if (free.some(({ m, c }) => t > capOf(m, c))) continue;
      free.forEach(({ c }) => { c.applicationMinutes = t; });
      reEval();
      const ok = free.every(({ c }) => chapterMinutes(c.id) <= DISTRIBUTOR_RULES.maxChapterMinutes)
        && Math.abs(minutes() - target) <= tol && applicationShare() <= caps.maxApplicationShare + 1e-9;
      const dist = Math.abs(minutes() - target);
      if (ok && (!best || dist < best.dist - 1e-9)) best = { t, dist };
    }
    restore();
    if (best) { free.forEach(({ c }) => { c.applicationMinutes = best!.t; }); reEval(); }
  };
  balancePractice();
  // LOOP 8.6C · mínimos de Actividades de Aplicación del documento (por módulo y en el curso): en el capítulo que
  // integra el módulo (práctica, después cierre, después el resto), con el nivel más corto que quepa.
  const ensureApplication = (m: WorkModule): boolean => {
    const order = [...m.chapters].filter((c) => !c.applicationMinutes).sort((a, b) => (a.kind === 'practice' ? 0 : 1) - (b.kind === 'practice' ? 0 : 1) || rank(roleOf(m, a)) - rank(roleOf(m, b)));
    for (const c of order) for (const t of tiers) if (trySetTier(m, c, t)) return true;
    return false;
  };
  if (appModuleMin > 0) for (const m of design) while (appCount(m.chapters) < appModuleMin && ensureApplication(m));
  if (appTotalMin > 0) for (const m of design) { if (appTotal() >= appTotalMin) break; while (appTotal() < appTotalMin && ensureApplication(m)); }
  // Review QA I1: los mínimos del documento pueden haber agregado Actividades en prácticas: se vuelven a emparejar.
  balancePractice();

  // Loop 9 B · práctica guiada: con las Actividades de Aplicación ya en su máximo (o fijadas por el documento) y el
  // diseño todavía por debajo del objetivo, la diferencia se completa con práctica guiada en los capítulos de CONTENIDO.
  // Reparto parejo: todos los capítulos libres en un nivel o en el siguiente (0 → 40 → 60 → 80 → 120), el que deja el
  // total más cerca del objetivo (no del borde de la tolerancia), sin pasar de 4 h por capítulo. Lo fijado por el
  // docente no se toca. Los minutos de la práctica guiada suman exactos (el modelo de tiempo los toma tal cual).
  // Fix I1: solo cuando el documento fija la forma (Cursia no puede agregar capítulos) o la cantidad/lugar de las
  // Actividades de Aplicación; en otro caso, lo de siempre (recomendación de estructura o la carga real declarada). Fix I2:
  // con horas obligatorias del documento (y la meta dentro de ellas) el relleno nunca queda por debajo de su mínimo.
  // «Fija la forma» = la institución eligió la forma (noContentAdditions) o el documento fija módulos Y capítulos por módulo
  // (el mismo criterio con el que la recomendación final dice que Cursia no agrega nada).
  const shapeFixedByDocument = !!rq && typeof rq.modulesFixed === 'number' && (rq.contentChaptersPerModule?.max !== undefined || rq.chaptersPerModule?.max !== undefined);
  // r80: con capítulos reales el contenido solo crece con los subtemas del documento; agotados, la diferencia se completa
  // con ejercicios guiados (formativos) en lugar de capítulos de relleno.
  const guidedByDocument = !!rq && (noContentAdditions || shapeFixedByDocument || !!rq.applicationInPractice
    || rq.applicationPerModule?.max !== undefined || rq.applicationTotal?.max !== undefined);
  const guidedAllowed = guidedMode !== 'none' && (guidedByDocument || realChapters);
  const realOnlyGuided = realChapters && !guidedByDocument;
  const hb = rq?.hoursBounds;
  const hbOn = !!hb && (hb.min === undefined || input.targetHours >= hb.min) && (hb.max === undefined || input.targetHours <= hb.max);
  const hbMin = hbOn && hb!.min !== undefined ? hb!.min * 60 : -Infinity;
  const hbMax = hbOn && hb!.max !== undefined ? hb!.max * 60 : Infinity;
  if (guidedAllowed && (!reached() || minutes() < hbMin - 1e-9)) {
    const free = design.flatMap((m) => m.chapters.filter((c) => c.kind === 'content' && pinnedGuided(c.id) === undefined).map((c) => ({ m, c })));
    // Orden de los capítulos que suben primero al nivel siguiente: cierres, núcleo, aperturas (igual que la aplicación).
    const ordered = free.map((x, i) => ({ ...x, i })).sort((a, b) => rank(roleOf(a.m, a.c)) - rank(roleOf(b.m, b.c)) || a.i - b.i);
    const base = minutes() - ordered.reduce((n, { c }) => n + (c.guidedPracticeMinutes ?? 0), 0);
    const capOfGuided = ordered.map(({ c }) => DISTRIBUTOR_RULES.maxChapterMinutes - (chapterMinutes(c.id) - (c.guidedPracticeMinutes ?? 0)));
    const levels = [0, ...(GUIDED_PRACTICE_TIERS as readonly number[])];
    const fit = (want: number, k: number) => [...levels].reverse().find((l) => l <= want && l <= capOfGuided[k]) ?? 0;
    let best: { assign: number[]; total: number; dist: number; sum: number; out: number } | null = null;
    for (let li = 0; li < levels.length; li++) {
      const lo = levels[li];
      const hi = levels[Math.min(li + 1, levels.length - 1)];
      for (let j = 0; j <= ordered.length; j++) {
        const assign = ordered.map((_, k) => fit(k < j ? hi : lo, k));
        const sum = assign.reduce((a, b) => a + b, 0);
        const total = base + sum;
        const dist = Math.abs(total - target);
        // Fuera de las horas del documento (por debajo del mínimo o por encima del máximo) solo si ningún candidato entra.
        const out = total < hbMin - 1e-9 || total > hbMax + 1e-9 ? 1 : 0;
        // r80: con capítulos reales (sin forma ni Actividades fijadas por el documento) los ejercicios guiados no pasan del
        // tope de Cursia: más sería inflar el curso; la diferencia se informa (no alcanza) en lugar de rellenar.
        if (realOnlyGuided && sum > DISTRIBUTOR_RULES.guidedShareMax * total + 1e-9) continue;
        if (!best || out < best.out || (out === best.out && (dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) <= 1e-9 && sum < best.sum)))) best = { assign, total, dist, sum, out };
        if (hi === lo) break;
      }
    }
    if (best && best.sum > 0) {
      ordered.forEach(({ c }, k) => { c.guidedPracticeMinutes = best!.assign[k] || null; });
      reEval();
      const n = best.assign.filter((x) => x > 0).length;
      const why = appMode === 'none' ? 'Sin Actividades de Aplicación (decisión del docente)'
        : appMode === 'practice_only' ? 'Con las Actividades de Aplicación solo en las prácticas (decisión del docente)'
          : 'Con las Actividades de Aplicación en lo que permiten el documento y los topes de Cursia';
      priorityTrace.push(`${why} y la forma o las Actividades fijadas por el documento, la diferencia con el objetivo se completa con ejercicios guiados (formativos, sin nota) en ${n} capítulo(s) de contenido: ${fmtH(best.sum / 60)} h de ${fmtH(best.total / 60)} h de trabajo estimado del estudiante (modelo de tiempo de Cursia), ${Math.round((best.sum / best.total) * 100)} %. No se agregan capítulos ni Actividades de Aplicación.`);
    }
    const short = Math.max(0, target - tol - minutes());
    guidedFill = { used: !!(best && best.sum > 0), shortfallHours: r1(short / 60) };
  }

  for (const m of design) for (const c of m.chapters) {
    const had = initialMinutes.get(c.id) ?? null;
    if (c.applicationMinutes && !c.proposed && c.applicationMinutes !== had) {
      changes.push({ type: 'set_application_activity', moduleId: m.id, chapterId: c.id, detail: had
        ? `Actividad de Aplicación de «${c.title}»: de ${had} a ${c.applicationMinutes} min.`
        : `Actividad de Aplicación de ${c.applicationMinutes} min en «${c.title}».` });
    }
    const before = initialRoles.get(c.id);
    if (!c.proposed && before && before !== roleOf(m, c)) {
      changes.push({ type: 'role_changed', moduleId: m.id, chapterId: c.id, detail: `«${c.title}» deja de ser ${ROLE_TEXT[before]} y pasa a ${ROLE_TEXT[roleOf(m, c)]} del módulo: lo nuevo cambia su lugar en el módulo.` });
    }
  }

  const addedPractice = changes.filter((c) => c.type === 'add_practice_chapter').length;
  const addedContent = changes.filter((c) => c.type === 'add_content_chapter').length;
  priorityTrace.push(`La carga horaria objetivo (${fmtH(input.targetHours)} h) es una restricción del curso: manda sobre la estructura sugerida por el enfoque, pero los capítulos nuevos son propuestas que el docente aprueba (confirmar la estructura nunca las aplica sola).`);
  priorityTrace.push(policy.kind === 'application_first'
    ? 'El enfoque prioriza aplicación y desempeño: primero Actividades de aplicación, después capítulos de práctica y solo al final profundización.'
    : 'El enfoque prioriza profundidad y conexiones: primero Actividades de aplicación cortas, después capítulos de profundización y al final práctica.');
  if (addedPractice || addedContent) priorityTrace.push(realChapters
    ? `Se proponen ${addedPractice} capítulo(s) de práctica y ${addedContent} capítulo(s) con subtemas del documento: la estructura actual no alcanza ${fmtH(input.targetHours)} h sin ellos.`
    : `Se proponen ${addedPractice} capítulo(s) de práctica y ${addedContent} de profundización: la estructura actual no alcanza ${fmtH(input.targetHours)} h sin ellos.`);

  const gap = target - minutes();
  if (Math.abs(gap) <= tol) return result('within_tolerance', []);
  if (gap < 0) {
    return result('above_tolerance', [addedPractice || addedContent
      ? `El diseño quedó ${fmtH(-gap / 60)} h por encima del objetivo: el último capítulo agregado no se puede partir. El docente puede quitarlo o bajar actividades.`
      : `El diseño quedó ${fmtH(-gap / 60)} h por encima del objetivo por el tamaño mínimo de las Actividades de aplicación (30 min). El docente puede quitar alguna.`]);
  }
  // 5) No alcanza con los topes razonables: proponer estructura, nunca inflar.
  const perModule = minutes() / design.length;
  const modulesNeeded = Math.ceil(gap / perModule);
  const chapterAvg = avg(est.modules.flatMap((m) => m.chapters).map((c) => c.chapterEstimatedMinutes));
  // La recomendación nunca contradice lo fijado: una forma elegida por la institución (formato o personalizada) no admite
  // nada nuevo; capítulos por módulo fijos → solo módulos nuevos con la misma estructura; módulos fijos por el documento →
  // solo capítulos (hasta el máximo por módulo); los dos fijos → nada. La diferencia la decide la institución.
  const chaptersFixed = rq?.contentChaptersPerModule?.max !== undefined || rq?.chaptersPerModule?.max !== undefined;
  const modsFixed = typeof rq?.modulesFixed === 'number';
  const room = design.reduce((n, m) => n + Math.max(0, DISTRIBUTOR_RULES.maxContentChaptersPerModule - m.chapters.filter((c) => c.kind === 'content').length), 0);
  const noRoom = `La estructura la fijan la institución o el documento: Cursia no agrega módulos ni capítulos por su cuenta ni rellena para llegar. La diferencia queda para que la institución la decida (ver «Verificación»).`;
  const advice = noContentAdditions || (chaptersFixed && modsFixed)
    ? noRoom
    : chaptersFixed
      ? `Recomendación: agregar ${modulesNeeded} módulo(s) nuevo(s) con la misma estructura (≈ ${fmtH(perModule / 60)} h cada uno). Los temas los decide el docente.`
      : modsFixed
        ? room > 0
          ? `Recomendación: agregar hasta ${Math.min(room, Math.ceil(gap / chapterAvg))} capítulo(s) en los módulos actuales (el documento fija ${rq!.modulesFixed} módulos). Los temas los decide el docente.`
          : noRoom
        : `Recomendación: agregar ${modulesNeeded} módulo(s) nuevo(s) (≈ ${fmtH(perModule / 60)} h cada uno con la misma estructura) o unos ${Math.ceil(gap / chapterAvg)} capítulos más en módulos nuevos. Los temas los decide el docente.`;
  const guidedNote = guidedFill && guidedFill.used
    ? [`Ni con ejercicios guiados en los capítulos de contenido (hasta ${GUIDED_PRACTICE_TIERS[GUIDED_PRACTICE_TIERS.length - 1]} min por capítulo) se llega: faltan ${fmtH(gap / 60)} h.`]
    : [];
  return result('cannot_reach_target', [
    `No alcanza ${fmtH(input.targetHours)} h sin rellenar: el diseño llega a ${fmtH(minutes() / 60)} h y faltan ${fmtH(gap / 60)} h.`,
    advice,
    ...guidedNote,
  ]);
}
