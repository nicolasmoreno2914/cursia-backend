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
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { DesignRules } from '../pedagogy/design-rules';
import { chapterRole } from '../pedagogy/pedagogical-blueprint';
import type { ChapterRole } from '../pedagogy/vocabulary';
import { STRUCTURE_TITLE_MAX } from '../course-structure/structure-titles';
import { isValidTargetHours } from './target-hours';
import { STUDY_TIME_RULES, StudyTimeCourseInput, StudyTimeEstimate, estimateCourseStudyTime } from './time-model';
import type { DistributorRequirementConstraints } from '../academic-context/requirements/requirement-authority';

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
  /** LOOP 8.3: el video de este capítulo lo fijó el docente (el diseño lo respeta). */
  videoPinned: boolean;
  /** Review L84-4: la Actividad de Aplicación la fijó el docente. */
  applicationPinned: boolean;
  /** LOOP 9.2: la actividad interactiva la fijó el docente. */
  activityPinned?: boolean;
  /** Tiempo objetivo del capítulo (modelo de tiempo, exacto) y lo que se puede generar hoy (sin la Actividad). */
  targetMinutes: number;
  generableMinutes: number;
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
  type: 'add_practice_chapter' | 'add_content_chapter' | 'set_application_activity' | 'remove_application_activity' | 'role_changed' | 'set_video' | 'set_activity';
  /** LOOP 8.6C: el cambio lo pide un requisito del documento (id del requisito). */
  requirementId?: string;
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
    evaluations: number;
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
export type DesignPins = Readonly<Record<string, { video?: boolean; application?: number; activity?: boolean; noPractice?: boolean }>>;
export type ApplicationActivitiesMode = 'auto' | 'practice_only' | 'none';
export const DESIGN_EMPHASES: readonly DesignEmphasis[] = ['application', 'balanced', 'depth'];
export const APPLICATION_ACTIVITIES_MODES: readonly ApplicationActivitiesMode[] = ['auto', 'practice_only', 'none'];
export interface DesignPreferences {
  emphasis?: DesignEmphasis;
  applicationActivities?: ApplicationActivitiesMode;
  audiovisual?: AudiovisualPriority;
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

export function distributeCourseHours(input: DistributorInput): DistributionResult {
  const { snapshot, rules } = input ?? ({} as DistributorInput);
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
  if (prefs.emphasis !== undefined && !DESIGN_EMPHASES.includes(prefs.emphasis)) throw new DistributorError(`emphasis inválido (${JSON.stringify(prefs.emphasis)})`);
  if (prefs.applicationActivities !== undefined && !APPLICATION_ACTIVITIES_MODES.includes(prefs.applicationActivities)) {
    throw new DistributorError(`applicationActivities inválido (${JSON.stringify(prefs.applicationActivities)})`);
  }
  if (prefs.audiovisual !== undefined && !AUDIOVISUAL_PRIORITIES.includes(prefs.audiovisual)) throw new DistributorError(`audiovisual inválido (${JSON.stringify(prefs.audiovisual)})`);
  const appMode: ApplicationActivitiesMode = prefs.applicationActivities ?? 'auto';
  const av: AudiovisualPriority | null = prefs.audiovisual ?? null;
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
      })),
    }));
  if (design.some((m) => m.chapters.length === 0)) throw new DistributorError('cada módulo necesita al menos un capítulo');
  // Review L84-4: una Actividad de Aplicación fijada a mano por el docente se respeta siempre (como el video fijado).
  for (const m of design) for (const c of m.chapters) { const p = pinnedApp(c.id); if (p !== undefined) c.applicationMinutes = p; }
  for (const m of design) for (const c of m.chapters) { const a = pinnedActivity(c.id); if (a !== undefined) c.activityEnabled = a; }

  // LOOP 8.3 · prioridad audiovisual sobre los capítulos de contenido existentes (antes de crecer: el video cambia las
  // horas y el resto del diseño compensa). Lo fijado por el docente manda; la práctica nunca lleva video.
  const initialVideo = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.videoEnabled] as const)));
  const initialActivity = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.activityEnabled] as const)));
  const avFor = (contentIndex: number, contentCount: number, proposedDeepening: boolean): boolean => {
    if (av === 'more') return true;
    if (proposedDeepening) return false;
    if (av === 'less') return contentIndex === 0;
    return contentCount === 1 || contentIndex < contentCount - 1; // recommended: abre o desarrolla, no el cierre
  };
  if (av) {
    for (const m of design) {
      const content = m.chapters.filter((c) => c.kind === 'content');
      content.forEach((c, i) => {
        const pin = pinnedVideo(c.id);
        c.videoEnabled = pin !== undefined ? pin : avFor(i, content.length, false);
      });
      for (const c of m.chapters) if (c.kind === 'practice') c.videoEnabled = false;
    }
  } else {
    for (const m of design) for (const c of m.chapters) { const pin = pinnedVideo(c.id); if (pin !== undefined && c.kind === 'content') c.videoEnabled = pin; }
  }
  // LOOP 8.6C · requisitos del documento: video en todos los capítulos de contenido (o en ninguno). Lo fijado manda.
  const rq = input.requirements ?? null;
  const reqVideo: boolean | null = rq && rq.videosAllContent ? true : rq && rq.videosNone ? false : null;
  if (reqVideo !== null) {
    for (const m of design) for (const c of m.chapters) if (c.kind === 'content' && pinnedVideo(c.id) === undefined) c.videoEnabled = reqVideo;
  }
  const minCh = rq?.chaptersPerModule?.min ?? 0;
  const maxCh = rq?.chaptersPerModule?.max ?? Infinity;
  // LOOP 9.2 · Requisitos del documento por tipo de capítulo, lugar de las Actividades de Aplicación y total de actividades.
  // Fase 2/4: con una forma elegida por la institución no se agregan capítulos de contenido (ni para mínimos ni para horas).
  const noContentAdditions = !!rq?.noContentAdditions;
  const contentMin = noContentAdditions ? 0 : rq?.contentChaptersPerModule?.min ?? 0;
  const contentMax = rq?.contentChaptersPerModule?.max ?? Infinity;
  const practiceMin = rq?.practicePerModule?.min ?? 0;
  const practiceMax = rq?.practicePerModule?.max ?? Infinity;
  const appInPractice = !!rq?.applicationInPractice;
  const practiceTotalMin = rq?.practiceTotal?.min ?? 0;
  const practiceTotalMax = rq?.practiceTotal?.max ?? Infinity;
  const practiceTotal = () => design.reduce((n, m) => n + m.chapters.filter((c) => c.kind === 'practice').length, 0);
  const contentCount = (cs: WorkChapter[]) => cs.filter((c) => c.kind !== 'practice').length;
  const practiceCount = (cs: WorkChapter[]) => cs.filter((c) => c.kind === 'practice').length;
  const appModuleMax = rq?.applicationPerModule?.max ?? Infinity;
  const appModuleMin = rq?.applicationPerModule?.min ?? 0;
  const appTotalMax = rq?.applicationTotal?.max ?? Infinity;
  const appTotalMin = rq?.applicationTotal?.min ?? 0;
  const appCount = (cs: WorkChapter[]) => cs.filter((c) => c.applicationMinutes).length;
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

  const toInput = (withApplication: boolean): StudyTimeCourseInput => ({
    frame: true,
    welcomeAudio: true,
    forum: true,
    finalExam: snapshot.course.finalExam === true,
    modules: design.map((m) => ({
      moduleId: m.id,
      intro: true,
      exam: m.examEnabled,
      chapters: m.chapters.map((c) => ({
        chapterId: c.id,
        kind: c.kind,
        libro: c.kind === 'content',
        presentation: c.kind === 'content',
        video: c.kind === 'content' && c.videoEnabled,
        ivAdvanced,
        activity: c.activityEnabled,
        review,
        ...(withApplication && c.applicationMinutes ? { applicationMinutes: c.applicationMinutes } : {}),
      })),
    })),
  });
  let est = estimateCourseStudyTime(toInput(true));
  const reEval = () => (est = estimateCourseStudyTime(toInput(true)));
  const minutes = () => est.courseEstimatedMinutes;
  const reached = () => minutes() >= target - tol;
  const chapterMinutes = (id: string) => est.modules.flatMap((m) => m.chapters).find((c) => c.chapterId === id)?.chapterEstimatedMinutes ?? 0;
  const roleOf = (m: WorkModule, c: WorkChapter) => chapterRole(m.chapters.indexOf(c), m.chapters.length);
  const changes: DistributionChange[] = [];
  const priorityTrace: string[] = [];
  // Fase 2 (review I2): minutos de Actividad de Aplicación con los que llegó cada capítulo existente; quitar o cambiar
  // una actividad ES un cambio (si no, «Ninguna» dejaría las actividades en la base y se generarían igual).
  const initialMinutes = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, c.applicationMinutes] as const)));
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
      changes.push({ type: 'set_video', moduleId: m.id, chapterId: c.id, detail: c.videoEnabled ? `«${c.title}» lleva video.` : `«${c.title}» queda sin video.` });
    }
  };
  const result = (status: DistributionStatus, recs: string[]): DistributionResult => {
    // LOOP 9.2: el total de actividades interactivas que exige el documento se cumple en cualquier salida.
    fitActivities();
    // Review 2.ª (I5): la prioridad audiovisual se aplica sobre la lista FINAL de capítulos de contenido (con los que se
    // agregaron), igual que la verá la siguiente pasada: así aplicar el diseño es un punto fijo.
    if (av) {
      let changed = false;
      for (const m of design) {
        const content = m.chapters.filter((c) => c.kind === 'content');
        content.forEach((c, i) => {
          if (pinnedVideo(c.id) !== undefined) return;
          // La profundización que propone Cursia sigue la regla de 8.3 (sin video con «Recomendado»).
          const v = reqVideo !== null ? reqVideo : avFor(i, content.length, !!c.proposed);
          if (c.videoEnabled !== v) { c.videoEnabled = v; changed = true; }
        });
      }
      if (changed) reEval();
    }
    pushRemovals();
    pushVideoChanges();
    for (const m of design) for (const c of m.chapters) {
      if (c.proposed || initialActivity.get(c.id) === c.activityEnabled) continue;
      changes.push({ type: 'set_activity', moduleId: m.id, chapterId: c.id, detail: c.activityEnabled ? `«${c.title}» lleva actividad interactiva.` : `«${c.title}» queda sin actividad interactiva (el documento pide un total exacto de actividades interactivas).` });
    }
    const generable = est; // Fase 2: las Actividades de Aplicación se generan
    // Re-revisión L3: los capítulos de práctica no tienen tope de aplicación; si el diseño queda por encima de la
    // proporción del enfoque, se dice explícitamente.
    const share = est.byComponent.application / est.courseEstimatedMinutes;
    const recommendations = share > policy.maxApplicationShare + 1e-9
      ? [...recs, `El ${Math.round(share * 100)} % de este diseño son Actividades de Aplicación (más que el ${Math.round(policy.maxApplicationShare * 100)} % habitual del enfoque). Si el curso es chico, conviene sumar capítulos de contenido o un módulo en lugar de más práctica.`]
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
        targetMinutes: estChapter.get(c.id) as number,
        generableMinutes: genChapter.get(c.id) as number,
      })),
    }));
    const all = modules.flatMap((m) => m.chapters);
    const appMinutes = all.reduce((n, c) => n + (c.applicationMinutes ?? 0), 0);
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
        evaluations: modules.filter((m) => m.examEnabled).length + (snapshot.course.finalExam ? 1 : 0),
      },
      hoursByComponent: Object.fromEntries(Object.entries(est.byComponent).map(([k, v]) => [k, r1(v / 60)])),
      studyTime: est,
    };
  };

  const fmtH = (n: number) => String(r1(n)).replace('.', ',');
  const initialRoles = new Map(design.flatMap((m) => m.chapters.map((c) => [c.id, roleOf(m, c)] as const)));

  // Fase 2 — «ya cumple»: si la estructura ACTUAL, con sus Actividades de Aplicación (p. ej. un diseño ya aplicado o
  // fijado a mano), queda dentro de la tolerancia y respeta las preferencias, no se propone nada (el distribuidor es
  // estable sobre su propio resultado). Si no, se rediseña desde cero (las actividades existentes no condicionan).
  const hasExisting = design.some((m) => m.chapters.some((c) => c.applicationMinutes !== null));
  const respectsMode = design.every((m) => m.chapters.every((c) => c.applicationMinutes === null || (appMode !== 'none' && (appMode !== 'practice_only' || c.kind === 'practice'))));
  // LOOP 8.6C: «ya cumple» también exige cumplir los requisitos del documento que el distribuidor maneja.
  const meetsRequirements = () => design.every((m) => m.chapters.length >= minCh && m.chapters.length <= maxCh && appCount(m.chapters) >= appModuleMin && appCount(m.chapters) <= appModuleMax
      && contentCount(m.chapters) >= contentMin && contentCount(m.chapters) <= contentMax && practiceCount(m.chapters) >= practiceMin && practiceCount(m.chapters) <= practiceMax
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
    reEval();
  }

  // LOOP 8.6C · 0) Estructura exigida por el documento: un módulo con MENOS capítulos que el mínimo se completa con
  // capítulos PROPUESTOS (primero uno de práctica — D1: cuenta dentro de «X capítulos por módulo» —, después de
  // profundización). Es una propuesta como cualquier otra: el docente la ve y la aplica con «Usar este diseño».
  const filledPractice = new Set<string>();
  // LOOP 9.2 · «N capítulos de práctica por módulo» y «N capítulos de contenido por módulo»: el documento los exige aunque
  // las horas ya alcancen (antes la práctica se descartaba «porque no hacía falta para estas horas»).
  if (practiceMin > 0 || contentMin > 0 || practiceTotalMin > 0) {
    for (const m of design) {
      let k = practiceCount(m.chapters);
      // Review I1: sin pasar del máximo de capítulos por módulo del documento (D1: ahí la práctica cuenta).
      while (k < practiceMin && m.chapters.length < maxCh && !noPracticeModule(m.id)) {
        k++;
        const pc: WorkChapter = { id: `proposed:practice:${m.id}:${k}`, proposed: true, kind: 'practice', title: proposedTitle(k === 1 ? 'Práctica integradora' : 'Práctica de casos', m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`, videoEnabled: false, activityEnabled: true, applicationMinutes: null };
        m.chapters.push(pc);
        filledPractice.add(pc.id);
        changes.push({ type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id, detail: `Capítulo de práctica «${pc.title}» (el documento pide ${practiceMin} ${practiceMin === 1 ? 'capítulo de práctica' : 'capítulos de práctica'} por módulo).`, ...(rq?.sources.practice ? { requirementId: rq.sources.practice } : {}) });
      }
      let n = m.chapters.filter((c) => c.kind === 'content' && c.proposed).length;
      while (contentCount(m.chapters) < contentMin) {
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
        if (m.chapters.length >= maxCh || practiceCount(m.chapters) >= practiceMax || noPracticeModule(m.id)) continue;
        const k = practiceCount(m.chapters) + 1;
        const pc: WorkChapter = { id: `proposed:practice:${m.id}:${k}`, proposed: true, kind: 'practice', title: proposedTitle(k === 1 ? 'Práctica integradora' : 'Práctica de casos', m.title),
          objective: `Aplicar lo aprendido en «${m.title}» en una situación completa`, videoEnabled: false, activityEnabled: true, applicationMinutes: null };
        m.chapters.push(pc);
        filledPractice.add(pc.id);
        changes.push({ type: 'add_practice_chapter', moduleId: m.id, chapterId: pc.id, detail: `Capítulo de práctica «${pc.title}» (el documento pide ${practiceTotalMin} ${practiceTotalMin === 1 ? 'capítulo de práctica' : 'capítulos de práctica'} en el curso).`, ...(rq?.sources.practice ? { requirementId: rq.sources.practice } : {}) });
      }
    }
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
        n++;
        const cc: WorkChapter = { id: `proposed:content:${m.id}:${n}`, proposed: true, kind: 'content', title: proposedTitle(`Profundización ${n}`, m.title),
          objective: `Analizar casos complejos de «${m.title}»`, videoEnabled: reqVideo !== null ? reqVideo : av ? av === 'more' : m.chapters.some((c) => c.kind === 'content' && c.videoEnabled), activityEnabled: true, applicationMinutes: null };
        let last = -1;
        m.chapters.forEach((c, i) => { if (c.kind === 'content') last = i; });
        m.chapters.splice(last + 1, 0, cc);
        changes.push({ type: 'add_content_chapter', moduleId: m.id, chapterId: cc.id, detail: `Capítulo de profundización «${cc.title}»${cc.videoEnabled ? ' con video' : ''}${why}.`, ...(reqId ? { requirementId: reqId } : {}) });
      }
    }
    reEval();
    // Review L86C I2: las horas base incluyen los capítulos que exige el documento (con ellas Cursia propone la meta y
    // el botón «Diseñar para N h»; sin esto proponía una meta que el diseño exigido ya superaba).
    if (filledPractice.size || changes.some((x) => x.requirementId)) baseHours = r1(estimateCourseStudyTime(toInput(false)).courseEstimatedMinutes / 60);
  }

  // 1) No rellenar: la estructura mínima ya supera el objetivo → informar y proponer, nunca recortar sola.
  if (minutes() > target + tol) {
    // LOOP 9.2: aun así, las Actividades de Aplicación que exige el documento (por módulo / en el curso) se ubican, con el
    // nivel más corto, en la práctica (o donde el documento diga): un requisito no desaparece porque sobren horas.
    const t0 = (STUDY_TIME_RULES.applicationActivityTiers as readonly number[])[0];
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

  const tiers = STUDY_TIME_RULES.applicationActivityTiers as readonly number[];
  const contentChapters = () => design.flatMap((m) => m.chapters.filter((c) => c.kind === 'content').map((c) => ({ m, c })));
  // Orden de la aplicación: primero los cierres de módulo (integran el módulo), después el núcleo, al final las aperturas.
  const rank = (role: ChapterRole) => (role === 'module_closing' || role === 'single' ? 0 : role === 'module_opening' ? 2 : 1);
  const applicationOrder = () => contentChapters().map((x, i) => ({ ...x, i })).sort((a, b) => rank(roleOf(a.m, a.c)) - rank(roleOf(b.m, b.c)) || a.i - b.i);
  const capOf = (m: WorkModule, c: WorkChapter) => (c.kind === 'practice' || roleOf(m, c) === 'module_closing' ? policy.closingTierMax : policy.contentTierMax);
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
    if (chapterMinutes(c.id) > DISTRIBUTOR_RULES.maxChapterMinutes || (raises && applicationShare() > policy.maxApplicationShare + 1e-9)) {
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
        if (existing.length < round && existing.length >= practiceMax) continue; // LOOP 9.2: ni del máximo de prácticas
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
        clampToRoleCaps();
        trySetTier(m, cc, tiers[0]);
        changes.push({
          type: 'add_content_chapter', moduleId: m.id, chapterId: cc.id,
          detail: `Capítulo de profundización «${cc.title}»${usesVideo ? ' con video' : ''}, actividad${review ? ', repaso' : ''}${cc.applicationMinutes ? ` y Actividad de Aplicación de ${cc.applicationMinutes} min` : ''}.`,
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
        if (minutes() <= target + tol && applicationShare() <= policy.maxApplicationShare + 1e-9) break;
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
        && Math.abs(minutes() - target) <= tol && applicationShare() <= policy.maxApplicationShare + 1e-9;
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
  if (addedPractice || addedContent) priorityTrace.push(`Se proponen ${addedPractice} capítulo(s) de práctica y ${addedContent} de profundización: la estructura actual no alcanza ${fmtH(input.targetHours)} h sin ellos.`);

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
  return result('cannot_reach_target', [
    `No alcanza ${fmtH(input.targetHours)} h sin rellenar: el diseño llega a ${fmtH(minutes() / 60)} h y faltan ${fmtH(gap / 60)} h.`,
    advice,
  ]);
}
