// r79 · «Ajustar al presupuesto» — función PURA (sin escrituras, sin IA, sin red).
//
//   horas objetivo + presupuesto de producción del curso (USD) + el mismo dry-run de siempre → el diseño de MEJOR calidad
//   pedagógica que llega a las horas con un costo esperado (+ margen) dentro del presupuesto; si no hay, dos alternativas.
//
// No modifica el distribuidor: genera candidatos con las palancas que YA existen y corre, para cada uno, el MISMO
// `runPedagogyDryRun` (distribuidor + Blueprint + Manifest materializados + estimación de costo) que usan la tarjeta
// «Cursia recomienda» y «Usar este diseño». Las horas y el costo salen de las mismas fórmulas.
//
// Palancas (todas existentes hoy):
//   - tope de capítulos de contenido por módulo (1–5): limita la PROFUNDIZACIÓN que agrega Cursia; nunca quita capítulos
//     que ya existen ni baja del mínimo que exige el documento (withContentChaptersCap). La diferencia de horas la cubren
//     los capítulos de práctica y las Actividades de Aplicación del propio distribuidor (con sus topes de siempre).
//   - contenido audiovisual: solo puede BAJAR respecto de la preferencia de base (más → recomendado → menos = 1 video por
//     módulo); nunca 0 videos (D4). Bloqueada si el docente o el documento fijaron el video.
//   - ejercicios guiados: auto o ninguno (solo actúan cuando el documento fija la forma, como siempre). Bloqueada si el
//     docente la eligió en «Ajustar».
//
// Garantías (condiciones vinculantes del owner, 2026-10-27):
//   1. Nada que exija el documento se quita: las restricciones del documento pasan intactas al distribuidor; el tope nunca
//      baja del mínimo del documento; los capítulos existentes nunca se recortan.
//   2. No se inflan horas: no hay tiempos nuevos. Las Actividades de Aplicación y la práctica guiada usan sus niveles de
//      siempre (cada nivel con su plan de ejercicios validado por el generador); además un candidato no puede subir la
//      proporción de Actividades de Aplicación por encima de la habitual del enfoque (o de la del diseño sin presupuesto).
//   3. Se elige por CALIDAD (exposición del contenido, cobertura audiovisual, Actividades cortas y repartidas, poca
//      práctica de relleno), no por el más barato ni por la cantidad cruda de capítulos.
//   4. Si no cabe manteniendo la calidad: alternativas claras (horas que alcanzan / presupuesto mínimo) y decide el usuario.
//   7. El presupuesto nunca se convierte en el «Tope autorizado»: esto solo diseña.
import { createHash } from 'crypto';
import type { DryRunInput, DryRunResult } from '../pedagogy/dry-run';
import { distributionProposalSha256, runPedagogyDryRun, seedPricing } from '../pedagogy/dry-run';
import { DISTRIBUTOR_RULES } from '../study-time/distributor';
import type { DistributorRequirementConstraints } from '../academic-context/requirements/requirement-authority';
import { CONTENT_CHAPTERS_CAP_MAX, CONTENT_CHAPTERS_CAP_MIN, isValidProductionBudgetUsd } from '../pedagogy/pedagogy-profile';
import { TierLockRow, isTierSelectable } from '../course-shell/application-kinds';
import { APPLICATION_KIND_LABEL } from '../study-time/application-kind-tiers';
import type { ApplicationKind } from '../study-time/application-kind-tiers';

/** r79.1: 2 = palanca de tipos de actividad, candado de proporcionalidad de niveles y búsqueda de horas más rápida. */
export const BUDGET_FIT_VERSION = 2 as const;
/** Interruptor: solo el string exacto 'true' lo enciende (off = la API ignora el campo y el frontend no lo muestra). */
export const BUDGET_FIT_FLAG_ENV = 'DYNAMIC_BUDGET_FIT';
/** Margen de seguridad (D1): el presupuesto se compara con el costo ESPERADO × (1 + margen). Default 0,10. */
export const BUDGET_FIT_MARGIN_ENV = 'BUDGET_FIT_MARGIN';
export const DEFAULT_BUDGET_FIT_MARGIN = 0.1;
/** Ejercicios guiados: proporción máxima de las horas que el ajuste usa por su cuenta (la misma del aviso de la tarjeta). */
export const GUIDED_SHARE_MAX = 0.3;

type Env = Record<string, string | undefined>;

export function isBudgetFitEnabled(env: Env = process.env): boolean {
  return env[BUDGET_FIT_FLAG_ENV] === 'true';
}

/** Margen del ajuste (0–0,5). Un valor inválido lanza (nunca se ignora en silencio). */
export function readBudgetFitMargin(env: Env = process.env): number {
  const raw = env[BUDGET_FIT_MARGIN_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_FIT_MARGIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 0.5) throw new Error(`BUDGET_FIT_CONFIG: ${BUDGET_FIT_MARGIN_ENV} inválido (${raw}): número de 0 a 0,5`);
  return n;
}

export type AudiovisualLevel = 'less' | 'recommended' | 'more';
export type GuidedMode = 'auto' | 'none';
const AV_ORDER: readonly AudiovisualLevel[] = ['less', 'recommended', 'more'];

export type EmphasisLevel = 'application' | 'balanced' | 'depth';
export interface BudgetFitLevers {
  /** Preferencia audiovisual de base (la del docente o la de Cursia sin presupuesto) y si el ajuste puede bajarla. */
  audiovisual: { base: AudiovisualLevel; locked: boolean };
  guidedPractice: { base: GuidedMode; locked: boolean };
  /**
   * §11.1 · Orden de crecimiento: «aplicación primero» agrega capítulos de práctica (Práctica integradora / de casos, con
   * su Actividad de Aplicación) ANTES que profundización. Es un orden que el distribuidor ya tiene; ausente = bloqueada.
   */
  emphasis?: { base: EmphasisLevel; locked: boolean };
  /**
   * r79.1 · Tipos de actividad (estudio de caso, proyecto integrador, retroalimentación formativa): se exploran 'auto' y
   * 'none'. No cambian minutos ni capítulos (re-forman Actividades que el diseño ya tiene, solo donde un criterio de valor
   * lo pide): no pueden usarse para «rellenar». Ausente = bloqueada en 'none' (comportamiento r79).
   */
  activityKinds?: { base: ActivityKindsLever; locked: boolean };
}
export type ActivityKindsLever = 'auto' | 'none';

export interface BudgetFitInput {
  /** El MISMO input del dry-run del curso (estructura viva, perfil efectivo con targetHours, pines, requisitos, precios). */
  base: DryRunInput;
  budgetUsd: number;
  /** Default DEFAULT_BUDGET_FIT_MARGIN. */
  margin?: number;
  levers: BudgetFitLevers;
  /** Buscar alternativas cuando no cabe (default true; la sub-búsqueda de horas no las busca). */
  searchAlternatives?: boolean;
  /**
   * Poda por presupuesto (solo la sub-búsqueda de horas): si la versión más barata de un tope no entra, las más ricas
   * tampoco se evalúan. La búsqueda principal recorre SIEMPRE todas las combinaciones válidas (§11.1).
   */
  prune?: boolean;
  /** r79.1: candado de proporcionalidad de los niveles (ausente = el de la especificación vigente). Para los checks. */
  tierLock?: readonly TierLockRow[] | null;
}

export interface BudgetFitDesign {
  targetHours: number;
  estimatedHours: number;
  distributionStatus: string;
  structure: {
    modules: number;
    chapters: number;
    contentChapters: number;
    practiceChapters: number;
    /** Capítulos de contenido / de práctica de cada módulo (en orden). */
    contentByModule: number[];
    practiceByModule: number[];
    /** Capítulos de contenido que agrega Cursia (profundización) y que exige o ya tiene la estructura. */
    proposedContentChapters: number;
    videoChapters: number;
    activities: number;
    applicationActivities: number;
    applicationMinutes: number;
    /** Actividades de Aplicación por nivel de minutos ({ "30": 2, "120": 6 }). */
    applicationTiers: Record<string, number>;
    guidedPractices: number;
    guidedPracticeMinutes: number;
    moduleExams: number;
    finalExam: boolean;
    /** r79.1: Actividades de Aplicación por tipo nuevo ({ case_study: 2, integrative_project: 1 }); vacío = solo las de siempre. */
    applicationKinds: Partial<Record<ApplicationKind, number>>;
  };
  hoursByComponent: Record<string, number>;
  cost: { min: string; expected: string; max: string; byCategory: Record<string, string> | null; byProvider: Record<string, string> };
  /** Esperado × (1 + margen), redondeado a centavos: lo que se compara con el presupuesto. */
  expectedWithMarginUsd: number;
  preferences: { audiovisual: AudiovisualLevel; guidedPractice: GuidedMode; maxContentChaptersPerModule: number | null; emphasis: EmphasisLevel; activityKinds: ActivityKindsLever };
  /** Esperado (USD) y cantidad por tipo de item (explica el costo). */
  costByItemType: Record<string, { expected: string; items: number }>;
  quality: { score: number; contentExposure: number; videoCoverage: number; applicationShare: number; shortActivities: number; guidedShare: number; kindFit: number };
  proposalSha256: string;
}

export interface BudgetFitAlternative {
  kind: 'hours_at_budget' | 'budget_for_hours' | 'minimum_budget';
  /** Lo que la interfaz manda en «Ajustar» para aplicarla con un clic. */
  adjust: { targetHours?: number; productionBudgetUsd?: number };
  design: BudgetFitDesign;
  text: string;
}

export type BudgetFitStatus = 'fits' | 'does_not_fit' | 'impossible';

export interface BudgetFitResult {
  version: typeof BUDGET_FIT_VERSION;
  dryRun: true;
  providersCalled: 0;
  status: BudgetFitStatus;
  reason: null | 'document_requirements' | 'structure_minimum' | 'hours_unreachable';
  budgetUsd: number;
  margin: number;
  targetHours: number;
  /** Diseño elegido (solo «Cabe»). */
  chosen: BudgetFitDesign | null;
  alternatives: BudgetFitAlternative[];
  message: string;
  /** Por qué este diseño (frases cortas, sin jerga). */
  reasons: string[];
  provisionalPricing: { gamma: boolean; label: string | null };
  candidatesEvaluated: number;
  /** §11.6 · Opción académicamente viable más económica y los factores que explican su costo (solo si no cabe). */
  minimumExplanation: MinimumCostExplanation | null;
  /** §11.1 · Lo que se exploró antes de decir «No cabe» (palancas y candidatos válidos a las horas pedidas). */
  searchSpace: { caps: (number | null)[]; audiovisual: AudiovisualLevel[]; guidedPractice: GuidedMode[]; emphasis: EmphasisLevel[]; activityKinds: ActivityKindsLever[]; candidates: number; valid: number; rejected: Record<string, number> };
  /** El dry-run completo del diseño elegido (para que el servicio no lo recalcule). No se serializa. */
  chosenResult?: DryRunResult;
  /** Interno (búsqueda de horas): esperado del candidato válido más económico que llega a estas horas. No se serializa. */
  cheapestReachingUsd?: number | null;
}

interface Params {
  cap: number | null;
  av: AudiovisualLevel;
  gp: GuidedMode;
  em: EmphasisLevel;
  /** r79.1: tipos de actividad. */
  ak: ActivityKindsLever;
}

/** §11.6 · Un factor del costo mínimo («6 capítulos de contenido × (texto + presentación + audiolibro) = USD X»). */
export interface MinimumCostFactor {
  key: 'content' | 'videos' | 'interactive' | 'application' | 'guided' | 'assessment' | 'frame' | 'margin';
  label: string;
  /** Piezas que lo componen (capítulos, videos, exámenes…); null en el margen. */
  count: number | null;
  /** USD esperados del factor (el margen: esperado × margen). */
  usd: number;
  /** Tipos de item del Manifest que suma (trazabilidad con el estimador). */
  itemTypes: string[];
}
export interface MinimumCostExplanation {
  /** Para qué es el mínimo: las horas pedidas (opción viable más económica) o la estructura mínima (Imposible). */
  basis: 'target_hours' | 'structure_minimum';
  targetHours: number;
  estimatedHours: number;
  /** Lo que se le propone escribir: ceil(esperado × (1 + margen)). */
  minimumUsd: number;
  expectedUsd: number;
  margin: number;
  /** Suman esperado × (1 + margen) (±1 % del mínimo). */
  factors: MinimumCostFactor[];
  text: string[];
}

interface Evaluated {
  params: Params;
  targetHours: number;
  result: DryRunResult;
  valid: boolean;
  expected: number;
  design: BudgetFitDesign | null;
  signature: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const fmtUsd = (n: number) => `USD ${Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')}`;
const fmtH = (n: number) => String(r1(n)).replace('.', ',');
/** USD enteros hacia arriba (lo que se le propone escribir al usuario). */
const ceilUsd = (n: number) => Math.ceil(n - 1e-9);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

/** Perfil del candidato: el de base con las palancas aplicadas (el tope, solo si existe). */
function candidateProfile(profile: unknown, targetHours: number, p: Params): Record<string, unknown> {
  const out = (clone(profile) || {}) as Record<string, any>;
  out.targetHours = targetHours;
  const dp: Record<string, unknown> = { ...(out.designPreferences || {}) };
  delete dp.maxContentChaptersPerModule;
  dp.audiovisual = p.av;
  if (p.gp === 'none') dp.guidedPractice = 'none';
  else delete dp.guidedPractice;
  if (p.cap !== null) dp.maxContentChaptersPerModule = p.cap;
  if (p.em === 'balanced') delete dp.emphasis;
  else dp.emphasis = p.em;
  if (p.ak === 'auto') dp.activityKinds = 'auto';
  else delete dp.activityKinds;
  out.designPreferences = dp;
  return out;
}

function docMinContent(rq: DistributorRequirementConstraints | null | undefined): number {
  return rq?.contentChaptersPerModule?.min ?? 0;
}

/** ¿El documento limita la estructura? (para decir «Imposible por el documento» y no «por tu estructura»). */
function documentBound(rq: DistributorRequirementConstraints | null | undefined): boolean {
  if (!rq) return false;
  return !!rq.noContentAdditions || typeof rq.modulesFixed === 'number' || (rq.contentChaptersPerModule?.min ?? 0) > 0 || (rq.chaptersPerModule?.min ?? 0) > 0
    || rq.contentChaptersPerModule?.max !== undefined || rq.chaptersPerModule?.max !== undefined || !!rq.videosAllContent;
}

function designOf(e: { result: DryRunResult; targetHours: number; params: Params }, margin: number, ref: Evaluated | null): BudgetFitDesign | null {
  const d = e.result.distribution;
  if (!d || !d.materialized || !d.materialized.providers.estimateUsd) return null;
  const prov = d.materialized.providers;
  const est = prov.estimateUsd!;
  const chapters = d.modules.flatMap((m) => m.chapters);
  const tiers: Record<string, number> = {};
  for (const c of chapters) if (c.applicationMinutes) tiers[String(c.applicationMinutes)] = (tiers[String(c.applicationMinutes)] || 0) + 1;
  const expected = Number(est.expected);
  const content = Number(d.hoursByComponent.content || 0);
  const refD = ref && ref.result.distribution;
  const refContent = refD ? Number(refD.hoursByComponent.content || 0) : content;
  const refVideos = refD ? refD.counts.videoChapters : d.counts.videoChapters;
  const appAvg = d.counts.applicationActivities ? d.counts.applicationMinutes / d.counts.applicationActivities : 30;
  const guidedShare = d.estimatedHours > 0 ? ((d.counts.guidedPracticeMinutes || 0) / 60) / d.estimatedHours : 0;
  const contentExposure = refContent > 0 ? clamp01(content / refContent) : 1;
  const videoCoverage = refVideos > 0 ? clamp01(d.counts.videoChapters / refVideos) : 1;
  const shortActivities = clamp01(1 - (appAvg - 30) / 90);
  // r79.1: tipos de actividad. `kindFit` = Actividades con el tipo que su criterio de valor pide / Actividades que cumplen
  // un criterio (K1–K3, con sus topes). Con «automático» es 1 si alguna cumple (0 sin ninguna); con «ninguno», 0.
  const kinds: Partial<Record<ApplicationKind, number>> = {};
  for (const c of chapters) if (c.applicationKind) kinds[c.applicationKind] = (kinds[c.applicationKind] || 0) + 1;
  const assigned = chapters.filter((c) => !!c.applicationKind).length;
  const kindFit = assigned > 0 ? 1 : 0;
  // Calidad pedagógica (0–8): exposición del contenido (lectura, presentación, audio y video) frente al diseño sin
  // presupuesto, cobertura audiovisual, Actividades de Aplicación cortas y repartidas, poca práctica de relleno y (r79.1)
  // tipos de actividad donde aportan (análisis → caso, síntesis → proyecto, práctica evaluable → retroalimentación).
  const score = 4 * contentExposure + 2 * videoCoverage + 1 * shortActivities - 1 * guidedShare + 1 * kindFit;
  return {
    targetHours: e.targetHours,
    estimatedHours: d.estimatedHours,
    distributionStatus: d.status,
    structure: {
      modules: d.counts.modules,
      chapters: d.counts.chapters,
      contentChapters: d.counts.contentChapters,
      practiceChapters: d.counts.practiceChapters,
      contentByModule: d.modules.map((m) => m.chapters.filter((c) => c.kind === 'content').length),
      practiceByModule: d.modules.map((m) => m.chapters.filter((c) => c.kind === 'practice').length),
      proposedContentChapters: chapters.filter((c) => c.kind === 'content' && c.proposed).length,
      videoChapters: d.counts.videoChapters,
      activities: d.counts.activities,
      applicationActivities: d.counts.applicationActivities,
      applicationMinutes: d.counts.applicationMinutes,
      applicationTiers: Object.fromEntries(Object.keys(tiers).sort((a, b) => Number(a) - Number(b)).map((k) => [k, tiers[k]])),
      guidedPractices: d.counts.guidedPractices || 0,
      guidedPracticeMinutes: d.counts.guidedPracticeMinutes || 0,
      moduleExams: d.modules.filter((m) => m.examEnabled).length,
      finalExam: d.counts.evaluations > d.modules.filter((m) => m.examEnabled).length,
      applicationKinds: Object.fromEntries(Object.keys(kinds).sort().map((k) => [k, kinds[k as ApplicationKind]])),
    },
    hoursByComponent: { ...d.hoursByComponent },
    cost: { min: est.min, expected: est.expected, max: est.max, byCategory: prov.byCategory ? { ...prov.byCategory } : null, byProvider: { ...est.byProvider } },
    expectedWithMarginUsd: r2(expected * (1 + margin)),
    preferences: { audiovisual: e.params.av, guidedPractice: e.params.gp, maxContentChaptersPerModule: e.params.cap, emphasis: e.params.em, activityKinds: e.params.ak },
    costByItemType: { ...(prov.byItemType || {}) },
    quality: { score: Math.round(score * 1000) / 1000, contentExposure: r2(contentExposure), videoCoverage: r2(videoCoverage), applicationShare: d.applicationShare, shortActivities: r2(shortActivities), guidedShare: r2(guidedShare), kindFit },
    proposalSha256: d.proposalSha256,
  };
}

/** Plan pedagógico de base de un módulo: ¿tenía video en el diseño sin presupuesto? (D4: nunca se queda sin video). */
function videoModules(r: DryRunResult): Set<string> {
  const d = r.distribution;
  return new Set(d ? d.modules.filter((m) => m.chapters.some((c) => c.videoEnabled)).map((m) => m.id) : []);
}

/** Ids de los capítulos de CONTENIDO de la estructura recibida (cada concepto obligatorio conserva el suyo, §11.4). */
function existingContentIds(base: DryRunInput): Set<string> {
  const s: any = base.structure;
  const out = new Set<string>();
  ((s && s.modules) || []).forEach((m: any, mi: number) => {
    const mid = m.id || `m${mi + 1}`;
    (m.chapters || []).forEach((c: any, ci: number) => { if ((c.kind ?? c.chapter_kind) !== 'practice') out.add(String(c.id || `${mid}c${ci + 1}`)); });
  });
  return out;
}

/** §11.6 · Agrupación del costo por factor (tipos de item del Manifest → lo que el usuario entiende). */
const FACTOR_GROUPS: readonly { key: MinimumCostFactor['key']; types: readonly string[] }[] = [
  { key: 'content', types: ['content', 'experience', 'presentation', 'audiobook_chapter'] },
  { key: 'videos', types: ['video', 'video_interactions'] },
  { key: 'interactive', types: ['activity', 'review'] },
  { key: 'application', types: ['application_activity'] },
  { key: 'guided', types: ['guided_practice'] },
  { key: 'assessment', types: ['exam', 'final_exam'] },
];

/** r79.1: «; incluye 2 estudios de caso y 1 proyecto integrador» (vacío sin tipos nuevos). */
function kindsText(k: Partial<Record<ApplicationKind, number>> | undefined): string {
  const NAMES: Record<ApplicationKind, [string, string]> = { case_study: ['estudio de caso', 'estudios de caso'], integrative_project: ['proyecto integrador', 'proyectos integradores'], formative_feedback: ['retroalimentación formativa', 'retroalimentaciones formativas'] };
  const parts = (Object.keys(k || {}) as ApplicationKind[]).filter((x) => (k as any)[x] > 0).map((x) => `${(k as any)[x]} ${(k as any)[x] === 1 ? NAMES[x][0] : NAMES[x][1]}`);
  if (!parts.length) return '';
  return `; incluye ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`}`;
}

export function minimumCostExplanation(d: BudgetFitDesign, margin: number, basis: MinimumCostExplanation['basis']): MinimumCostExplanation {
  const by = d.costByItemType || {};
  const used = new Set<string>();
  const factors: MinimumCostFactor[] = [];
  const s = d.structure;
  const plural = (n: number, a: string, b: string) => `${n} ${n === 1 ? a : b}`;
  for (const g of FACTOR_GROUPS) {
    const types = g.types.filter((t) => by[t]);
    types.forEach((t) => used.add(t));
    const usd = types.reduce((n, t) => n + Number(by[t].expected), 0);
    if (usd <= 0) continue;
    const label = g.key === 'content' ? `${plural(s.contentChapters, 'capítulo de contenido', 'capítulos de contenido')} × (texto + experiencia + presentación + audiolibro)`
      : g.key === 'videos' ? `${plural(s.videoChapters, 'video', 'videos')} con sus preguntas`
        : g.key === 'interactive' ? `${plural(s.activities, 'actividad interactiva', 'actividades interactivas')}`
          : g.key === 'application' ? `${plural(s.applicationActivities, 'Actividad de Aplicación', 'Actividades de Aplicación')} (con solucionario${kindsText(s.applicationKinds)})`
            : g.key === 'guided' ? `${plural(s.guidedPractices, 'capítulo con ejercicios guiados', 'capítulos con ejercicios guiados')}`
              : `${plural(s.moduleExams + (s.finalExam ? 1 : 0), 'evaluación', 'evaluaciones')} (bancos de preguntas)`;
    const count = g.key === 'content' ? s.contentChapters : g.key === 'videos' ? s.videoChapters : g.key === 'interactive' ? s.activities
      : g.key === 'application' ? s.applicationActivities : g.key === 'guided' ? s.guidedPractices : s.moduleExams + (s.finalExam ? 1 : 0);
    factors.push({ key: g.key, label, count, usd: r2(usd), itemTypes: types });
  }
  const rest = Object.keys(by).filter((t) => !used.has(t));
  const restUsd = rest.reduce((n, t) => n + Number(by[t].expected), 0);
  if (restUsd > 0) factors.push({ key: 'frame', label: 'Marco del curso (plan, bienvenida con audio, introducciones de módulo)', count: null, usd: r2(restUsd), itemTypes: rest.sort() });
  const expected = Number(d.cost.expected);
  factors.push({ key: 'margin', label: `Margen de seguridad (${Math.round(margin * 100)} %)`, count: null, usd: r2(expected * margin), itemTypes: [] });
  const minimumUsd = ceilUsd(expected * (1 + margin));
  return {
    basis, targetHours: d.targetHours, estimatedHours: d.estimatedHours, minimumUsd, expectedUsd: r2(expected), margin, factors,
    text: factors.map((f) => `${f.label} = ${fmtUsd(f.usd)}`),
  };
}

export function fitDesignToBudget(input: BudgetFitInput): BudgetFitResult {
  if (!input || !input.base) throw new Error('BUDGET_FIT_INVALID: falta el input del dry-run');
  if (!isValidProductionBudgetUsd(input.budgetUsd)) throw new Error(`BUDGET_FIT_INVALID: presupuesto inválido (${JSON.stringify(input.budgetUsd)})`);
  const margin = input.margin ?? DEFAULT_BUDGET_FIT_MARGIN;
  if (!(margin >= 0 && margin <= 0.5)) throw new Error(`BUDGET_FIT_INVALID: margen inválido (${margin})`);
  // F2: siempre con precios explícitos (los del servicio; si no vienen, el seed) para poder explicar el costo.
  const base: DryRunInput = { ...input.base, pricing: input.base.pricing ?? seedPricing(), ...(input.tierLock ? { tierLock: input.tierLock } : {}) };
  const tierLock = input.tierLock ?? null;
  const profile = (base.profile || {}) as Record<string, any>;
  const targetHours = profile.targetHours;
  if (typeof targetHours !== 'number') throw new Error('BUDGET_FIT_INVALID: el perfil necesita targetHours');
  const budget = input.budgetUsd;
  const rq = base.requirementConstraints ?? null;
  const memo = new Map<string, Evaluated>();
  let evaluated = 0;
  const mandatoryContent = existingContentIds(base);

  const run = (p: Params, hours: number): Evaluated => {
    const key = `${hours}|${p.cap}|${p.av}|${p.gp}|${p.em}|${p.ak}`;
    const hit = memo.get(key);
    if (hit) return hit;
    evaluated++;
    const result = runPedagogyDryRun({ ...base, profile: candidateProfile(base.profile, hours, p), distributionOnly: true });
    const d = result.distribution;
    const valid = !!d && !!d.materialized && !d.materialized.manifestErrors.length && !!d.materialized.providers.estimateUsd;
    const e: Evaluated = {
      params: p, targetHours: hours, result, valid,
      expected: valid ? Number(d!.materialized.providers.estimateUsd!.expected) : Infinity,
      design: null,
      // Firma de la ESTRUCTURA (sin el tope): dos topes que dan el mismo diseño son el mismo candidato.
      signature: d ? distributionProposalSha256(d) : createHash('sha256').update(key).digest('hex'),
    };
    memo.set(key, e);
    return e;
  };
  const withDesign = (e: Evaluated, ref: Evaluated | null): Evaluated => {
    if (!e.design && e.valid) e.design = designOf(e, margin, ref);
    if (!e.design) e.valid = false;
    return e;
  };

  // Valores de cada palanca (de base primero; la audiovisual solo baja; el orden de crecimiento puede pasar a «aplicación primero»).
  const avBaseIdx = AV_ORDER.indexOf(input.levers.audiovisual.base);
  const avValues: AudiovisualLevel[] = input.levers.audiovisual.locked ? [input.levers.audiovisual.base] : AV_ORDER.slice(0, avBaseIdx + 1).reverse() as AudiovisualLevel[];
  const gpValues: GuidedMode[] = input.levers.guidedPractice.locked ? [input.levers.guidedPractice.base] : input.levers.guidedPractice.base === 'none' ? ['none'] : ['auto', 'none'];
  const emBase: EmphasisLevel = input.levers.emphasis ? input.levers.emphasis.base : ((profile.designPreferences && profile.designPreferences.emphasis) || 'balanced');
  let emValues: EmphasisLevel[] = !input.levers.emphasis || input.levers.emphasis.locked || emBase === 'application' ? [emBase] : [emBase, 'application'];
  // r79.1: tipos de actividad. Bloqueada (o ausente) → su valor de base; libre → la de base y la otra.
  const akBase: ActivityKindsLever = input.levers.activityKinds ? input.levers.activityKinds.base : (profile.designPreferences && profile.designPreferences.activityKinds === 'auto' ? 'auto' : 'none');
  const akValues: ActivityKindsLever[] = !input.levers.activityKinds || input.levers.activityKinds.locked ? [akBase] : akBase === 'auto' ? ['auto', 'none'] : ['none', 'auto'];
  const baseParams: Params = { cap: null, av: input.levers.audiovisual.base, gp: input.levers.guidedPractice.base, em: emBase, ak: akBase };
  const cheapAv = avValues[avValues.length - 1];
  const cheapGp = gpValues[gpValues.length - 1];
  const minCap = Math.max(CONTENT_CHAPTERS_CAP_MIN, docMinContent(rq));

  const fits = (e: Evaluated) => e.valid && e.expected * (1 + margin) <= budget + 1e-9;
  const reaches = (e: Evaluated) => e.valid && e.result.distribution!.status === 'within_tolerance';
  let lastSpace: BudgetFitResult['searchSpace'] | null = null;

  /**
   * Búsqueda completa a unas horas: todos los candidatos válidos (con poda por presupuesto). r79.1: `feasibleOnly` responde
   * solo si ALGÚN candidato válido llega a las horas y cabe (lo mismo que `status === 'fits'` de la búsqueda con poda), y se
   * detiene en el primero (más barato primero): lo usa la búsqueda de «horas que alcanzan».
   */
  const search = (hours: number, feasibleOnly = false, pruned = !!input.prune): { ref: Evaluated; pool: Evaluated[]; feasible: boolean; maxHours: number } => {
    const ref = withDesign(run(baseParams, hours), null);
    // «Aplicación primero» que da el MISMO diseño (el enfoque ya crece así) no es otra combinación: no se recorre dos veces.
    if (emValues.length > 1 && hours === targetHours) {
      const alt = run({ ...baseParams, em: emValues[1] }, hours);
      if (alt.signature === ref.signature) emValues = [emValues[0]];
    }
    const refD = ref.result.distribution;
    const refMax = refD ? Math.max(...refD.modules.map((m) => m.chapters.filter((c) => c.kind === 'content').length)) : CONTENT_CHAPTERS_CAP_MAX;
    const caps: (number | null)[] = [null];
    for (let k = Math.min(refMax - 1, CONTENT_CHAPTERS_CAP_MAX); k >= minCap; k--) caps.push(k);
    const refVideoModules = videoModules(ref.result);
    const refShare = refD ? refD.applicationShare : 0;
    const refAlign: any = refD && refD.materialized ? (refD.materialized as any).alignment : null;
    const rejected: Record<string, number> = {};
    const reject = (why: string) => { rejected[why] = (rejected[why] || 0) + 1; };
    const pool: Evaluated[] = [];
    const seen = new Set<string>();
    let candidates = 0;
    // r79.1: las horas máximas que llega a dar CUALQUIER combinación materializable (apuntando a estas horas).
    let maxHours = ref.valid ? ref.result.distribution!.estimatedHours : 0;
    for (const em of emValues) for (const cap of caps) {
      // Primero la versión más barata de este tope (con poda, si no entra, las más ricas tampoco se evalúan).
      // Los tipos de actividad nunca abaratan (sus unidades de salida ≥ las de la Actividad de siempre del mismo nivel,
      // APPLICATION_OUTPUT_UNITS; lo afirma el check): la versión más barata es la de «ninguno».
      const cheapAk: ActivityKindsLever = akValues.includes('none') ? 'none' : akValues[0];
      const cheapest = withDesign(run({ cap, av: cheapAv, gp: cheapGp, em, ak: cheapAk }, hours), ref);
      const variants: Params[] = [];
      for (const av of avValues) for (const gp of gpValues) for (const ak of akValues) variants.push({ cap, av, gp, em, ak });
      const list = !(pruned || feasibleOnly) || fits(cheapest) ? variants : [{ cap, av: cheapAv, gp: cheapGp, em, ak: cheapAk }];
      // Factibilidad: «automático» tiene las MISMAS horas que «ninguno» (los tipos no cambian minutos) y nunca cuesta menos:
      // si la versión con «ninguno» de esas palancas no llega o no cabe, la de «automático» tampoco (se salta).
      const noneFailed = new Set<string>();
      if (feasibleOnly) {
        // La versión más barata primero (la que define la poda); las demás, en el orden de siempre.
        const key = (p: Params) => `${p.av}|${p.gp}|${p.ak}`;
        const ck = key({ cap, av: cheapAv, gp: cheapGp, em, ak: cheapAk });
        list.sort((a, b) => (key(a) === ck ? -1 : 0) - (key(b) === ck ? -1 : 0) || (a.ak === 'none' ? 0 : 1) - (b.ak === 'none' ? 0 : 1));
      }
      // Factibilidad: la variante que MÁS horas da (más video, con ejercicios guiados) va segunda; si ni ella llega a estas
      // horas, ninguna de este tope llega (más video y ejercicios guiados solo suman horas) y el tope se descarta.
      if (feasibleOnly && list.length > 2) {
        const richKey = `${avValues[0]}|${gpValues[0] === 'auto' || gpValues.includes('auto') ? 'auto' : gpValues[0]}|none`;
        const ri = list.findIndex((p) => `${p.av}|${p.gp}|${p.ak}` === richKey);
        if (ri > 1) list.splice(1, 0, list.splice(ri, 1)[0]);
      }
      let richTried = false;
      for (const p of list) {
        if (feasibleOnly && p.ak === 'auto' && noneFailed.has(`${p.av}|${p.gp}`)) continue;
        if (feasibleOnly && richTried) {
          const rich = run(list[1], hours);
          if (rich.valid && rich.result.distribution!.estimatedHours < hours - Math.max(hours * DISTRIBUTOR_RULES.tolerance.pct, DISTRIBUTOR_RULES.tolerance.minHours) - 1e-9 && rich.result.distribution!.status === 'cannot_reach_target') break;
        }
        if (feasibleOnly && p === list[1]) richTried = true;
        candidates++;
        const e = withDesign(run(p, hours), ref);
        if (feasibleOnly && p.ak === 'none' && !(reaches(e) && fits(e))) noneFailed.add(`${p.av}|${p.gp}`);
        if (!e.valid) { reject('not_materializable'); continue; }
        const d = e.result.distribution!;
        if (d.estimatedHours > maxHours) maxHours = d.estimatedHours;
        // §11.4: cada concepto obligatorio (capítulo de contenido que ya existe o que exige el documento) conserva su capítulo teórico.
        const contentNow = new Set(d.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content').map((c) => c.id)));
        if ([...mandatoryContent].some((id) => !contentNow.has(id)) || d.modules.some((m) => m.chapters.filter((c) => c.kind === 'content').length < docMinContent(rq))) { reject('mandatory_content'); continue; }
        // Garantía 2 / §11.3: la proporción de Actividades de Aplicación no supera la habitual del enfoque (ni la del diseño
        // sin presupuesto, si ya era mayor): el presupuesto no se compensa alargando actividades.
        if (d.applicationShare > Math.max(d.policy.maxApplicationShare, refShare) + 1e-9) { reject('application_share'); continue; }
        // D4: un módulo que tenía video en el diseño sin presupuesto conserva al menos uno.
        if ([...refVideoModules].some((id) => !d.modules.some((m) => m.id === id && m.chapters.some((c) => c.videoEnabled)))) { reject('video_per_module'); continue; }
        // Carga máxima por capítulo (4 h): la impone el distribuidor; se verifica igual.
        if (d.modules.some((m) => m.chapters.some((c) => c.targetMinutes > DISTRIBUTOR_RULES.maxChapterMinutes + 1e-9))) { reject('chapter_over_4h'); continue; }
        if (d.status === 'minimum_exceeds_target') { reject('minimum_exceeds_target'); continue; }
        // r79.1 · candado de proporcionalidad (§12.1): ningún nivel que Cursia elija puede tener el candado cerrado (lo que
        // fijó el docente se respeta igual). Con la especificación vigente, todos abiertos.
        if (d.modules.some((m) => m.chapters.some((c) => c.applicationMinutes !== null && !c.applicationPinned && !isTierSelectable(c.applicationKind ?? 'standard', c.applicationMinutes, tierLock)))) { reject('tier_spec_lock'); continue; }
        // Ejercicios guiados: formativos (sin nota). Más del 30 % de las horas exige que la institución lo acepte en la
        // propuesta; el ajuste no llega ahí por su cuenta (salvo que el diseño de base ya lo tenga).
        const gShare = d.estimatedHours > 0 ? ((d.counts.guidedPracticeMinutes || 0) / 60) / d.estimatedHours : 0;
        const refG = refD && refD.estimatedHours > 0 ? ((refD.counts.guidedPracticeMinutes || 0) / 60) / refD.estimatedHours : 0;
        if (gShare > Math.max(GUIDED_SHARE_MAX, refG) + 1e-9) { reject('guided_share'); continue; }
        // §11.2: relación con los resultados de aprendizaje: ningún resultado queda sin cubrir y no aparecen problemas
        // críticos de alineación que el diseño sin presupuesto no tenía.
        const al: any = d.materialized ? (d.materialized as any).alignment : null;
        if (refAlign && refAlign.available && al && al.available && (al.coverage.uncovered > refAlign.coverage.uncovered || al.counts.critical > refAlign.counts.critical)) { reject('alignment'); continue; }
        if (feasibleOnly && reaches(e) && fits(e)) return { ref, pool: [e], feasible: true, maxHours };
        if (seen.has(e.signature)) { reject('duplicate'); continue; }
        seen.add(e.signature);
        pool.push(e);
      }
    }
    if (hours === targetHours && !feasibleOnly) lastSpace = { caps, audiovisual: avValues, guidedPractice: gpValues, emphasis: emValues, activityKinds: akValues, candidates, valid: pool.length, rejected };
    return { ref, pool, feasible: pool.some((e) => reaches(e) && fits(e)), maxHours };
  };

  /** Mejor calidad; a igual calidad, el más cercano al diseño sin presupuesto y después el más económico. */
  const distance = (p: Params) => (p.cap === null ? 0 : 1) + (p.av !== baseParams.av ? 1 : 0) + (p.gp !== baseParams.gp ? 1 : 0) + (p.em !== baseParams.em ? 1 : 0) + (p.ak !== baseParams.ak ? 1 : 0);
  const better = (a: Evaluated, b: Evaluated) => {
    const qa = a.design!.quality.score;
    const qb = b.design!.quality.score;
    if (Math.abs(qa - qb) > 1e-6) return qb - qa;
    const da = distance(a.params);
    const db = distance(b.params);
    if (da !== db) return da - db;
    if (Math.abs(a.expected - b.expected) > 1e-9) return a.expected - b.expected;
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  };
  const best = (xs: Evaluated[]) => [...xs].sort(better)[0] ?? null;

  const { ref, pool, maxHours: reachMax } = search(targetHours);
  const provisional = (e: Evaluated | null) => {
    const pp = e && e.result.distribution && e.result.distribution.materialized.providers.provisionalPricing;
    return pp ? { gamma: pp.gamma, label: pp.label } : { gamma: false, label: null };
  };
  const reasonsOf = (e: Evaluated): string[] => {
    const d = e.design!;
    const out: string[] = [];
    const s = d.structure;
    out.push(`${s.modules} ${s.modules === 1 ? 'módulo' : 'módulos'} con ${s.contentChapters} ${s.contentChapters === 1 ? 'capítulo de contenido' : 'capítulos de contenido'} y ${s.practiceChapters} de práctica.`);
    if (e.params.cap !== null) out.push(`Hasta ${e.params.cap} ${e.params.cap === 1 ? 'capítulo de contenido' : 'capítulos de contenido'} por módulo: el resto de las horas es práctica real (capítulos de práctica y Actividades de Aplicación con instrucciones, ejercicios, entregable y criterios).`);
    if (s.guidedPractices > 0 && !(ref.design && ref.design.structure.guidedPractices > 0)) out.push(`Ejercicios guiados en ${s.guidedPractices} ${s.guidedPractices === 1 ? 'capítulo' : 'capítulos'} de contenido (${fmtH(s.guidedPracticeMinutes / 60)} h): casos, problemas resueltos o análisis de decisiones con consignas, producto esperado, criterios y respuesta modelo.`);
    if (e.params.em !== baseParams.em) out.push('Primero práctica y después profundización: cada módulo suma capítulos de práctica integradora y de casos antes que capítulos de profundización.');
    if (e.params.av !== baseParams.av) out.push(e.params.av === 'less' ? 'Un video por módulo (en el capítulo que lo abre), en lugar de uno en casi cada capítulo.' : 'Video en los capítulos que abren y desarrollan cada módulo.');
    if (e.params.gp !== baseParams.gp) out.push('Sin ejercicios guiados para completar horas.');
    if (e.params.ak === 'auto' && Object.keys(s.applicationKinds).length) {
      out.push(`Tipos de actividad donde aportan (mismas horas)${kindsText(s.applicationKinds).replace('; incluye', ':')}. El estudio de caso va donde el capítulo pide analizar o decidir; el proyecto integrador, donde el módulo pide crear o producir; la retroalimentación formativa, después de una práctica evaluable.`);
    }
    if (distance(e.params) === 0) out.push('Es el mismo diseño que Cursia recomienda sin presupuesto: cabe completo.');
    return out;
  };

  const fitPool = pool.filter((e) => reaches(e) && fits(e));
  const chosen = best(fitPool);
  const space = lastSpace as BudgetFitResult['searchSpace'] | null;
  const out = (status: BudgetFitStatus, reason: BudgetFitResult['reason'], c: Evaluated | null, alternatives: BudgetFitAlternative[], message: string, reasons: string[], minimum: MinimumCostExplanation | null): BudgetFitResult => ({
    version: BUDGET_FIT_VERSION, dryRun: true, providersCalled: 0, status, reason, budgetUsd: budget, margin, targetHours,
    chosen: c ? c.design : null, alternatives, message, reasons,
    provisionalPricing: provisional(c ?? ref), candidatesEvaluated: evaluated,
    minimumExplanation: minimum,
    searchSpace: space ?? { caps: [], audiovisual: avValues, guidedPractice: gpValues, emphasis: emValues, activityKinds: akValues, candidates: 0, valid: 0, rejected: {} },
    // El elegido, con la salida COMPLETA del dry-run (la búsqueda usa la versión liviana: misma `distribution`).
    ...(c && input.searchAlternatives !== false ? { chosenResult: runPedagogyDryRun({ ...base, profile: candidateProfile(base.profile, c.targetHours, c.params) }) } : {}),
  });
  if (chosen) {
    const d = chosen.design!;
    return out('fits', null, chosen, [],
      `${fmtH(targetHours)} h por ≈ ${fmtUsd(r2(Number(d.cost.expected)))} (esperado). Cabe en tu presupuesto de ${fmtUsd(budget)} con un margen de seguridad del ${Math.round(margin * 100)} %.`,
      reasonsOf(chosen), null);
  }
  if (input.searchAlternatives === false) {
    const reach = pool.filter(reaches);
    return { ...out('does_not_fit', null, null, [], '', [], null), cheapestReachingUsd: reach.length ? Math.min(...reach.map((e) => e.expected)) : null };
  }

  const alternatives: BudgetFitAlternative[] = [];
  // B) Presupuesto mínimo realista para las horas pedidas: la opción académicamente viable más económica que llega
  // (todas las combinaciones válidas ya se exploraron); con ese presupuesto, la de mejor calidad.
  const reaching = pool.filter(reaches);
  let budgetForHours: BudgetFitAlternative | null = null;
  let cheapestViable: Evaluated | null = null;
  if (reaching.length) {
    cheapestViable = [...reaching].sort((a, b) => a.expected - b.expected || better(a, b))[0];
    const need = ceilUsd(cheapestViable.expected * (1 + margin));
    if (need <= 5000) {
      const at = best(reaching.filter((e) => e.expected * (1 + margin) <= need + 1e-9))!;
      budgetForHours = {
        kind: 'budget_for_hours', adjust: { productionBudgetUsd: need }, design: at.design!,
        text: `Para ${fmtH(targetHours)} h el mínimo realista es ${fmtUsd(need)} (esperado ≈ ${fmtUsd(r2(Number(at.design!.cost.expected)))}).`,
      };
    }
  }
  // Piso: la estructura más chica posible (sin profundización, menos video, sin ejercicios guiados, práctica primero) a 1 h:
  // lo que cuesta producir lo que la estructura y el documento ya exigen. Si ni eso entra, es «Imposible» con este presupuesto.
  const floor = withDesign(run({ cap: minCap, av: cheapAv, gp: cheapGp, em: emValues[emValues.length - 1], ak: akValues.includes('none') ? 'none' : akValues[0] }, 1), ref);
  const floorNeed = floor.valid ? ceilUsd(floor.expected * (1 + margin)) : null;
  if (floorNeed !== null && floor.expected * (1 + margin) > budget + 1e-9) {
    const docBound = documentBound(rq);
    const n = floor.design!.structure.contentChapters;
    const msg = docBound
      ? `El documento exige ${n} ${n === 1 ? 'capítulo de contenido' : 'capítulos de contenido'}, cada uno con su presentación y su audiolibro. El mínimo para producirlos es ${fmtUsd(floorNeed)}. Cursia no quita contenidos que exige el documento.`
      : `La estructura actual tiene ${n} ${n === 1 ? 'capítulo de contenido' : 'capítulos de contenido'}, cada uno con su presentación y su audiolibro. Producirla cuesta como mínimo ${fmtUsd(floorNeed)}. Cursia no quita capítulos por su cuenta.`;
    alternatives.push({ kind: 'minimum_budget', adjust: { productionBudgetUsd: floorNeed }, design: floor.design!, text: `El mínimo para producir esta estructura es ${fmtUsd(floorNeed)} (≈ ${fmtH(floor.design!.estimatedHours)} h).` });
    if (budgetForHours) alternatives.push(budgetForHours);
    // El mínimo que se explica: el de las horas pedidas si se pueden alcanzar; si no, el de la estructura mínima.
    const minimum = cheapestViable ? minimumCostExplanation(cheapestViable.design!, margin, 'target_hours') : minimumCostExplanation(floor.design!, margin, 'structure_minimum');
    return out('impossible', docBound ? 'document_requirements' : 'structure_minimum', null, alternatives, msg, [], minimum);
  }
  // A) Horas que se alcanzan con el presupuesto: la meta más alta (en pasos de media hora) cuyo diseño cabe.
  // r79.1 (rendimiento, misma respuesta): búsqueda binaria sobre la grilla de medias horas [estructura mínima, meta − 0,5] con
  // pruebas de FACTIBILIDAD (¿algún candidato válido llega y cabe? — se detiene en el primero, más barato primero) y una sola
  // búsqueda completa al final, en la meta encontrada (el diseño de mejor calidad de esa meta, como siempre). Supone que si
  // una meta no cabe, una más alta tampoco (el costo mínimo crece con las horas); check-r79-1 lo compara con la búsqueda
  // EXHAUSTIVA (todas las medias horas) en la matriz de cursos: mismas horas y mismo diseño.
  let hoursAtBudget: BudgetFitAlternative | null = null;
  // Las metas posibles empiezan donde termina la estructura mínima (por debajo, «la estructura ya supera la meta»).
  const minH = Math.max(1, Math.ceil(((ref.result.distribution ? ref.result.distribution.baseHours : 1)) * 2) / 2);
  const hi = targetHours - 0.5;
  let found: BudgetFitResult | null = null;
  if (hi >= minH) {
    // Cota superior segura: apuntando a la meta pedida, cada combinación crece hasta donde puede (`reachMax` = lo máximo que
    // dio alguna); una meta h solo se alcanza si reachMax ≥ h − tolerancia(h) (±5 % o ±1 h, la del distribuidor).
    const tolOf = (h: number) => Math.max(h * DISTRIBUTOR_RULES.tolerance.pct, DISTRIBUTOR_RULES.tolerance.minHours);
    const grid: number[] = [];
    for (let h = minH; h <= hi + 1e-9; h += 0.5) { const g = Math.round(h * 2) / 2; if (g - tolOf(g) <= reachMax + 1e-9) grid.push(g); }
    const feasible = new Map<number, boolean>();
    const at = (i: number): boolean => {
      const h = grid[i];
      if (!feasible.has(h)) feasible.set(h, search(h, true).feasible);
      return feasible.get(h)!;
    };
    // Punto de partida: la meta en la que el costo (lineal entre la estructura mínima y el más barato que llega a la meta
    // pedida, o el que más horas da) iguala el presupuesto. Desde ahí, saltos que se duplican hasta encerrar la frontera y
    // después bisección: la MISMA frontera que la bisección sobre toda la grilla, con menos pruebas (sobre todo menos pruebas
    // que no caben, que son las caras). Solo cambia el orden de las pruebas, nunca la respuesta.
    let bestI = -1;
    if (grid.length) {
      const reachingAtT = pool.filter(reaches);
      const anchorB = reachingAtT.length
        ? [...reachingAtT].sort((a, b) => a.expected - b.expected)[0]
        : [...pool].sort((a, b) => b.result.distribution!.estimatedHours - a.result.distribution!.estimatedHours || a.expected - b.expected)[0];
      const hA = floor.valid ? floor.result.distribution!.estimatedHours : grid[0];
      const cA = floor.valid ? floor.expected : NaN;
      const hB = anchorB ? (reachingAtT.length ? targetHours : anchorB.result.distribution!.estimatedHours) : NaN;
      const cB = anchorB ? anchorB.expected : NaN;
      const want = budget / (1 + margin);
      let start = grid.length - 1;
      if (Number.isFinite(cA) && Number.isFinite(cB) && cB > cA && hB > hA) {
        const hEst = hA + ((want - cA) / (cB - cA)) * (hB - hA);
        start = Math.max(0, Math.min(grid.length - 1, Math.floor((hEst - grid[0]) * 2)));
      }
      let lo = -1; // última posición que cabe (conocida)
      let hiI = grid.length; // primera posición que NO cabe (conocida; grid.length = ninguna)
      if (at(start)) {
        lo = start;
        for (let step = 1; lo + step < grid.length; step *= 2) {
          if (at(lo + step)) lo += step;
          else { hiI = lo + step; break; }
        }
        if (hiI === grid.length && lo < grid.length - 1) hiI = grid.length; // llegó al final sin fallar: lo = última probada
      } else {
        hiI = start;
        for (let step = 1; ; step *= 2) {
          const i = hiI - step;
          if (i < 0) { if (hiI > 0 && at(0)) lo = 0; break; }
          if (at(i)) { lo = i; break; }
          hiI = i;
        }
      }
      if (lo >= 0) {
        if (hiI === grid.length) hiI = grid.length; // sin frontera conocida arriba
        while (hiI - lo > 1) {
          const mid = (lo + hiI) >> 1;
          if (mid >= grid.length) break;
          if (at(mid)) lo = mid; else hiI = mid;
        }
        bestI = lo;
      }
    }
    if (bestI >= 0) {
      // La meta encontrada: la misma búsqueda con poda que hacía la prueba anidada (mismo diseño elegido), pero con los
      // dry-runs ya calculados en esta búsqueda.
      const h = grid[bestI];
      const fitAt = search(h, false, true).pool.filter((e) => reaches(e) && fits(e));
      const chosenAt = best(fitAt);
      if (chosenAt) found = { targetHours: h, chosen: chosenAt.design } as BudgetFitResult;
    }
  }
  if (found && found.chosen) {
    hoursAtBudget = {
      kind: 'hours_at_budget', adjust: { targetHours: found.targetHours, productionBudgetUsd: budget }, design: found.chosen,
      text: `Con ${fmtUsd(budget)} llegamos a ${fmtH(found.targetHours)} h (esperado ≈ ${fmtUsd(r2(Number(found.chosen.cost.expected)))}).`,
    };
  }
  if (hoursAtBudget) alternatives.push(hoursAtBudget);
  if (budgetForHours) alternatives.push(budgetForHours);
  const unreachable = !reaching.length;
  const minimum = cheapestViable ? minimumCostExplanation(cheapestViable.design!, margin, 'target_hours') : floor.valid ? minimumCostExplanation(floor.design!, margin, 'structure_minimum') : null;
  const message = unreachable
    ? `Con esta estructura el diseño no llega a ${fmtH(targetHours)} h (sin rellenar). ${hoursAtBudget ? hoursAtBudget.text : ''}`.trim()
    : `${fmtH(targetHours)} h no caben completas en ${fmtUsd(budget)} manteniendo la calidad del diseño. Elige una de estas opciones:`;
  return out('does_not_fit', unreachable ? 'hours_unreachable' : null, null, alternatives, message, [], minimum);
}

/** Lo público del resultado (sin el dry-run completo del elegido). */
export function publicBudgetFit(r: BudgetFitResult): Omit<BudgetFitResult, 'chosenResult' | 'cheapestReachingUsd'> {
  const { chosenResult: _omit, cheapestReachingUsd: _c, ...rest } = r;
  return rest;
}
