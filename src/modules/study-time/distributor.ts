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
  /** Tiempo objetivo del capítulo (modelo de tiempo, exacto) y lo que se puede generar hoy (sin la Actividad). */
  targetMinutes: number;
  generableMinutes: number;
}

export interface ProposedModule {
  id: string;
  title: string;
  examEnabled: boolean;
  chapters: ProposedChapter[];
}

export interface DistributionChange {
  type: 'add_practice_chapter' | 'add_content_chapter' | 'set_application_activity' | 'role_changed';
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
  /** Fase 2 · «Ajustar»: preferencias efectivas con las que se armó el diseño. */
  preferences: Required<DesignPreferences>;
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
export type ApplicationActivitiesMode = 'auto' | 'practice_only' | 'none';
export const DESIGN_EMPHASES: readonly DesignEmphasis[] = ['application', 'balanced', 'depth'];
export const APPLICATION_ACTIVITIES_MODES: readonly ApplicationActivitiesMode[] = ['auto', 'practice_only', 'none'];
export interface DesignPreferences {
  emphasis?: DesignEmphasis;
  applicationActivities?: ApplicationActivitiesMode;
}

export interface DistributorInput {
  snapshot: BlueprintSnapshotV2;
  /** Fase 2 · «Ajustar»: preferencias del docente (ausentes = las de siempre). */
  preferences?: DesignPreferences | null;
  /** Reglas del motor pedagógico (null = sin enfoque: política neutra). */
  rules: DesignRules | null;
  targetHours: number;
  /** Reglas de tipo de actividad del Manifest (2 = H5P v2: pausas del video y «Repaso»). */
  activityTypeRules?: 1 | 2;
  tolerance?: { pct?: number; minHours?: number };
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
  const appMode: ApplicationActivitiesMode = prefs.applicationActivities ?? 'auto';
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
  const baseHours = r1(estimateCourseStudyTime(toInput(false)).courseEstimatedMinutes / 60);

  const result = (status: DistributionStatus, recs: string[]): DistributionResult => {
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
      chapters: m.chapters.map((c) => ({
        id: c.id,
        proposed: c.proposed,
        kind: c.kind,
        title: c.title,
        objective: c.objective,
        role: roleOf(m, c),
        videoEnabled: c.kind === 'content' && c.videoEnabled,
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
      preferences: { emphasis: prefs.emphasis ?? 'balanced', applicationActivities: appMode },
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
  if (hasExisting && respectsMode && Math.abs(minutes() - target) <= tol) {
    priorityTrace.push('La estructura actual, con sus Actividades de Aplicación, ya cumple la carga horaria objetivo: no se propone ningún cambio.');
    return result('within_tolerance', []);
  }
  if (hasExisting) {
    for (const m of design) for (const c of m.chapters) c.applicationMinutes = null;
    reEval();
  }

  // 1) No rellenar: la estructura mínima ya supera el objetivo → informar y proponer, nunca recortar sola.
  if (minutes() > target + tol) {
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
    if (tier !== null && tier > capOf(m, c)) return false;
    // «Ajustar»: sin Actividades de Aplicación, o solo en los capítulos de práctica.
    if (tier !== null && (appMode === 'none' || (appMode === 'practice_only' && c.kind !== 'practice'))) return false;
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
      if (c.applicationMinutes === null || c.applicationMinutes <= capOf(m, c)) continue;
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
        if (m.chapters.filter((c) => c.kind === 'practice').length >= round) continue;
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
    for (let k = 0; k < DISTRIBUTOR_RULES.maxContentChaptersPerModule; k++) {
      for (const m of design) {
        if (reached()) return true;
        const content = m.chapters.filter((c) => c.kind === 'content');
        if (content.length >= DISTRIBUTOR_RULES.maxContentChaptersPerModule) continue;
        const n = content.filter((c) => c.proposed).length + 1;
        const usesVideo = content.some((c) => c.videoEnabled);
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

  const steps = { application: growApplication, practice: addPractice, content: addContent };
  for (const s of policy.order) {
    if (steps[s]()) break;
    growApplication();
  }
  // Ajuste fino: si se pasó, bajar niveles de a uno (empezando por las aperturas) SOLO mientras el total siga
  // dentro de la tolerancia por abajo (nunca descarta un diseño válido).
  for (const { c } of [...applicationOrder()].reverse()) {
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
  for (const m of design) for (const c of m.chapters) {
    if (c.applicationMinutes && !c.proposed) {
      changes.push({ type: 'set_application_activity', moduleId: m.id, chapterId: c.id, detail: `Actividad de Aplicación de ${c.applicationMinutes} min en «${c.title}».` });
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
  return result('cannot_reach_target', [
    `No alcanza ${fmtH(input.targetHours)} h sin rellenar: el diseño llega a ${fmtH(minutes() / 60)} h y faltan ${fmtH(gap / 60)} h.`,
    `Recomendación: agregar ${modulesNeeded} módulo(s) nuevo(s) (≈ ${fmtH(perModule / 60)} h cada uno con la misma estructura) o unos ${Math.ceil(gap / chapterAvg)} capítulos más en módulos nuevos. Los temas los decide el docente.`,
  ]);
}
