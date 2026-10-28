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

export const BUDGET_FIT_VERSION = 1 as const;
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
}

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
  };
  hoursByComponent: Record<string, number>;
  cost: { min: string; expected: string; max: string; byCategory: Record<string, string> | null; byProvider: Record<string, string> };
  /** Esperado × (1 + margen), redondeado a centavos: lo que se compara con el presupuesto. */
  expectedWithMarginUsd: number;
  preferences: { audiovisual: AudiovisualLevel; guidedPractice: GuidedMode; maxContentChaptersPerModule: number | null; emphasis: EmphasisLevel };
  /** Esperado (USD) y cantidad por tipo de item (explica el costo). */
  costByItemType: Record<string, { expected: string; items: number }>;
  quality: { score: number; contentExposure: number; videoCoverage: number; applicationShare: number; shortActivities: number; guidedShare: number };
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
  searchSpace: { caps: (number | null)[]; audiovisual: AudiovisualLevel[]; guidedPractice: GuidedMode[]; emphasis: EmphasisLevel[]; candidates: number; valid: number; rejected: Record<string, number> };
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
  // Calidad pedagógica (0–7): exposición del contenido (lectura, presentación, audio y video) frente al diseño sin
  // presupuesto, cobertura audiovisual, Actividades de Aplicación cortas y repartidas, y poca práctica de relleno.
  const score = 4 * contentExposure + 2 * videoCoverage + 1 * shortActivities - 1 * guidedShare;
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
    },
    hoursByComponent: { ...d.hoursByComponent },
    cost: { min: est.min, expected: est.expected, max: est.max, byCategory: prov.byCategory ? { ...prov.byCategory } : null, byProvider: { ...est.byProvider } },
    expectedWithMarginUsd: r2(expected * (1 + margin)),
    preferences: { audiovisual: e.params.av, guidedPractice: e.params.gp, maxContentChaptersPerModule: e.params.cap, emphasis: e.params.em },
    costByItemType: { ...(prov.byItemType || {}) },
    quality: { score: Math.round(score * 1000) / 1000, contentExposure: r2(contentExposure), videoCoverage: r2(videoCoverage), applicationShare: d.applicationShare, shortActivities: r2(shortActivities), guidedShare: r2(guidedShare) },
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
          : g.key === 'application' ? `${plural(s.applicationActivities, 'Actividad de Aplicación', 'Actividades de Aplicación')} (con solucionario)`
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
  const base: DryRunInput = { ...input.base, pricing: input.base.pricing ?? seedPricing() };
  const profile = (base.profile || {}) as Record<string, any>;
  const targetHours = profile.targetHours;
  if (typeof targetHours !== 'number') throw new Error('BUDGET_FIT_INVALID: el perfil necesita targetHours');
  const budget = input.budgetUsd;
  const rq = base.requirementConstraints ?? null;
  const memo = new Map<string, Evaluated>();
  let evaluated = 0;
  const mandatoryContent = existingContentIds(base);

  const run = (p: Params, hours: number): Evaluated => {
    const key = `${hours}|${p.cap}|${p.av}|${p.gp}|${p.em}`;
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
  const baseParams: Params = { cap: null, av: input.levers.audiovisual.base, gp: input.levers.guidedPractice.base, em: emBase };
  const cheapAv = avValues[avValues.length - 1];
  const cheapGp = gpValues[gpValues.length - 1];
  const minCap = Math.max(CONTENT_CHAPTERS_CAP_MIN, docMinContent(rq));

  const fits = (e: Evaluated) => e.valid && e.expected * (1 + margin) <= budget + 1e-9;
  const reaches = (e: Evaluated) => e.valid && e.result.distribution!.status === 'within_tolerance';
  let lastSpace: BudgetFitResult['searchSpace'] | null = null;

  /** Búsqueda completa a unas horas: todos los candidatos válidos (con poda por presupuesto). */
  const search = (hours: number): { ref: Evaluated; pool: Evaluated[] } => {
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
    for (const em of emValues) for (const cap of caps) {
      // Primero la versión más barata de este tope (con poda, si no entra, las más ricas tampoco se evalúan).
      const cheapest = withDesign(run({ cap, av: cheapAv, gp: cheapGp, em }, hours), ref);
      const variants: Params[] = [];
      for (const av of avValues) for (const gp of gpValues) variants.push({ cap, av, gp, em });
      const list = !input.prune || fits(cheapest) ? variants : [{ cap, av: cheapAv, gp: cheapGp, em }];
      for (const p of list) {
        candidates++;
        const e = withDesign(run(p, hours), ref);
        if (!e.valid) { reject('not_materializable'); continue; }
        const d = e.result.distribution!;
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
        // Ejercicios guiados: formativos (sin nota). Más del 30 % de las horas exige que la institución lo acepte en la
        // propuesta; el ajuste no llega ahí por su cuenta (salvo que el diseño de base ya lo tenga).
        const gShare = d.estimatedHours > 0 ? ((d.counts.guidedPracticeMinutes || 0) / 60) / d.estimatedHours : 0;
        const refG = refD && refD.estimatedHours > 0 ? ((refD.counts.guidedPracticeMinutes || 0) / 60) / refD.estimatedHours : 0;
        if (gShare > Math.max(GUIDED_SHARE_MAX, refG) + 1e-9) { reject('guided_share'); continue; }
        // §11.2: relación con los resultados de aprendizaje: ningún resultado queda sin cubrir y no aparecen problemas
        // críticos de alineación que el diseño sin presupuesto no tenía.
        const al: any = d.materialized ? (d.materialized as any).alignment : null;
        if (refAlign && refAlign.available && al && al.available && (al.coverage.uncovered > refAlign.coverage.uncovered || al.counts.critical > refAlign.counts.critical)) { reject('alignment'); continue; }
        if (seen.has(e.signature)) { reject('duplicate'); continue; }
        seen.add(e.signature);
        pool.push(e);
      }
    }
    if (hours === targetHours) lastSpace = { caps, audiovisual: avValues, guidedPractice: gpValues, emphasis: emValues, candidates, valid: pool.length, rejected };
    return { ref, pool };
  };

  /** Mejor calidad; a igual calidad, el más cercano al diseño sin presupuesto y después el más económico. */
  const distance = (p: Params) => (p.cap === null ? 0 : 1) + (p.av !== baseParams.av ? 1 : 0) + (p.gp !== baseParams.gp ? 1 : 0) + (p.em !== baseParams.em ? 1 : 0);
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

  const { ref, pool } = search(targetHours);
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
    searchSpace: space ?? { caps: [], audiovisual: avValues, guidedPractice: gpValues, emphasis: emValues, candidates: 0, valid: 0, rejected: {} },
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
  const floor = withDesign(run({ cap: minCap, av: cheapAv, gp: cheapGp, em: emValues[emValues.length - 1] }, 1), ref);
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
  let hoursAtBudget: BudgetFitAlternative | null = null;
  const underBudget = pool.filter(fits);
  // Las metas posibles empiezan donde termina la estructura mínima (por debajo, «la estructura ya supera la meta»).
  const minH = Math.max(1, Math.ceil(((ref.result.distribution ? ref.result.distribution.baseHours : 1)) * 2) / 2);
  let lo = Math.max(minH, underBudget.length ? Math.floor(Math.max(...underBudget.map((e) => e.design!.estimatedHours)) * 2) / 2 : minH);
  const hi = targetHours - 0.5;
  const probe = (h: number): BudgetFitResult => fitDesignToBudget({ ...input, base: { ...base, profile: { ...profile, targetHours: h } }, searchAlternatives: false, prune: true });
  let found: BudgetFitResult | null = null;
  if (lo > hi) lo = hi;
  // Búsqueda de la meta con un intervalo [cabe, no cabe]: el próximo intento interpola el costo esperado entre los dos
  // extremos (el costo crece casi lineal con las horas) y, si la interpolación no avanza, parte el intervalo. ≤ 6 intentos;
  // cada intento es una búsqueda completa a esas horas (con poda por presupuesto).
  if (hi >= lo) {
    const target = budget / (1 + margin);
    const costAt = (r: BudgetFitResult): number => (r.chosen ? Number(r.chosen.cost.expected) : Infinity);
    let a: { h: number; cost: number } | null = null; // la meta más alta que cabe
    let b: { h: number; cost: number } = { h: targetHours, cost: cheapestViable ? cheapestViable.expected : (reaching.length ? reaching[0].expected : Infinity) };
    const first = probe(lo);
    evaluated += first.candidatesEvaluated;
    if (first.status === 'fits') { a = { h: lo, cost: costAt(first) }; found = first; }
    else {
      // La meta de partida no entra: se baja (como mucho 4 pasos) hasta encontrar una que sí.
      for (let step = 0, h = Math.floor((lo - Math.max(1, lo * 0.15)) * 2) / 2; step < 4 && h >= minH; step++, h = Math.floor((h - Math.max(1, h * 0.15)) * 2) / 2) {
        const r = probe(h);
        evaluated += r.candidatesEvaluated;
        if (r.status === 'fits') { a = { h, cost: costAt(r) }; found = r; break; }
      }
    }
    for (let step = 0; a && step < 8 && b.h - a.h > 0.5; step++) {
      // Pasos pares: interpolación; impares: bisección (el costo sube a saltos: la interpolación sola se arrastra).
      let next = step % 2 === 0 && Number.isFinite(b.cost) && b.cost > a.cost ? a.h + ((target - a.cost) / (b.cost - a.cost)) * (b.h - a.h) : (a.h + b.h) / 2;
      next = Math.floor(next * 2) / 2;
      if (next <= a.h || next >= b.h) next = Math.floor(((a.h + b.h) / 2) * 2) / 2;
      if (next <= a.h || next >= b.h) break;
      const r = probe(next);
      evaluated += r.candidatesEvaluated;
      if (r.status === 'fits') { a = { h: next, cost: costAt(r) }; found = r; }
      else {
        // Sin diseño que quepa a esas horas: el costo del más barato que llega (si lo hay) acota la interpolación.
        b = { h: next, cost: typeof r.cheapestReachingUsd === 'number' ? r.cheapestReachingUsd : Infinity };
      }
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
