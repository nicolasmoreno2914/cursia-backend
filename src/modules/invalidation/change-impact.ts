import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { GenerationManifestV1, ManifestItem } from '../generation-manifests/generation-manifest-builder';
import { ProviderPlan, providerPlanFor } from '../pedagogy/dry-run';
import type { StudyTimeEstimate } from '../study-time/time-model';
import type { InvalidationAction, InvalidationActionType, InvalidationPlan } from './plan';
import { ALIGNMENT_FINGERPRINT_TYPES } from './fingerprints';
import { PROVIDER_PAID_ITEM_TYPES_V3 } from './plan-v3';

/**
 * Fase 5 — Regeneración parcial inteligente: ¿qué cambió, qué depende de eso, qué hay que regenerar, qué queda intacto
 * y cuánto cuesta? Puro y determinista (sin DB, red ni proveedores): resume el plan de invalidación v3 EXISTENTE
 * (huellas por item, Fase 8 + R26) y simula el costo con el estimador de FinOps. NUNCA ejecuta ni cobra nada.
 *
 *   regenerar  = REGENERATE / GENERATE de items LLM (texto) — se ejecutarían al confirmar
 *   revisar    = REVIEW (el item se reutiliza; su contexto cambió: Coherence lo revisa)
 *   intacto    = REUSE
 *   pagado sin regenerar = STALE_NO_AUTO (video, Gamma, audio): sigue en el curso, marcado; regenerarlo exige
 *                confirmación explícita (regenerate con confirmPaid) y su costo se informa aparte
 *   apagado    = SOFT_DISABLE (toggles ON→OFF)
 */

export const CHANGE_IMPACT_VERSION = 1 as const;

/** Qué alimenta a cada tipo de item (5.1): las aristas del Manifest + lo que entra en su huella. */
export const DEPENDENCY_DOC: Readonly<Record<string, { dependsOn: string; inputs: string; paid: boolean }>> = Object.freeze({
  course_plan: { dependsOn: '—', inputs: 'estructura completa (títulos, objetivos, orden), contexto del curso', paid: false },
  course_intro: { dependsOn: 'course_plan', inputs: 'estructura completa', paid: false },
  audio_welcome: { dependsOn: 'course_intro', inputs: 'texto de bienvenida', paid: true },
  module_intro: { dependsOn: 'course_plan', inputs: 'módulo + capítulos del módulo, diseño del módulo', paid: false },
  content: { dependsOn: 'course_plan', inputs: 'título, objetivo, descripción y diseño del capítulo; posición y contexto (revisión)', paid: false },
  experience: { dependsOn: 'content (práctica: contenidos del módulo)', inputs: 'content + resultados vinculados', paid: false },
  presentation: { dependsOn: 'content', inputs: 'content (Gamma)', paid: true },
  video: { dependsOn: 'content', inputs: 'content (Videogen)', paid: true },
  video_interactions: { dependsOn: 'video + content', inputs: 'video vigente + content + resultados vinculados', paid: false },
  activity: { dependsOn: 'content (práctica: contenidos del módulo)', inputs: 'content, motor, tipo H5P, diseño por rol, resultados vinculados', paid: false },
  application_activity: { dependsOn: 'content (práctica: contenidos del módulo)', inputs: 'content, minutos, estudiante y resultados congelados', paid: false },
  audiobook_chapter: { dependsOn: 'content', inputs: 'content (guion + TTS)', paid: true },
  exam: { dependsOn: 'contents del módulo', inputs: 'contents del módulo, diseño de evaluación, resultados del módulo', paid: false },
  final_exam: { dependsOn: 'todos los contents', inputs: 'contents del curso, diseño de evaluación, todos los resultados', paid: false },
});

export interface ChangeImpactChapter {
  chapterId: string;
  moduleId: string;
  title: string;
  /** Items del capítulo por acción. */
  regenerate: string[];
  review: string[];
  paidStale: string[];
  generate: string[];
  /** Pagados que se volverían a ejecutar (fallidos o reactivados); no son «nuevos». */
  paidRetry: string[];
  disable: string[];
  /** true = ningún item del capítulo cambia (todo REUSE). */
  untouched: boolean;
}

export interface ChangeImpact {
  changeImpactVersion: typeof CHANGE_IMPACT_VERSION;
  dryRun: true;
  providersCalled: 0;
  spendUsd: '0.00';
  totals: Record<InvalidationActionType, number>;
  /** Items que se ejecutarían al confirmar (LLM): REGENERATE + GENERATE no pagados. */
  toRun: string[];
  /** Items pagados cuyos inputs cambiaron: NO se regeneran solos. */
  paidStale: string[];
  /** Items pagados NUEVOS (p. ej. un video de un capítulo agregado): se generarían al confirmar. */
  paidNew: string[];
  /** Items pagados que se volverían a ejecutar al confirmar (fallidos o reactivados), distintos de los nuevos. */
  paidRetry: string[];
  chapters: ChangeImpactChapter[];
  untouchedChapters: number;
  /** Costo simulado de lo que se ejecutaría (texto + pagos nuevos) y, aparte, de regenerar los pagados marcados. */
  cost: { toRun: ProviderPlan; paidStaleIfRegenerated: ProviderPlan };
  /**
   * 5.5 · «Costo estimado de los cambios: USD X» — lo que se ejecutaría al confirmar (texto + pagados nuevos o a
   * reintentar). Simulado: nada se cobra. null = sin tarifas configuradas.
   */
  estimatedChangeCostUsd: string | null;
  hours: { from: number; to: number; delta: number } | null;
  /** Por qué cambia cada item (motivos del plan), solo de los que no se reutilizan. */
  reasons: Record<string, string[]>;
}

// Fuente única de los tipos pagados: el plan v3 (review F5: sin listas duplicadas).
const PAID_TYPES = new Set(PROVIDER_PAID_ITEM_TYPES_V3);

function itemsOf(manifest: GenerationManifestV1, keys: string[]): ManifestItem[] {
  const set = new Set(keys);
  return manifest.items.filter((i) => set.has(i.key));
}

export function summarizeChangeImpact(input: {
  plan: InvalidationPlan;
  to: { blueprint: BlueprintSnapshotV2; manifest: GenerationManifestV1; studyTime?: StudyTimeEstimate | null };
  from?: { manifest: GenerationManifestV1; studyTime?: StudyTimeEstimate | null };
}): ChangeImpact {
  const { plan, to } = input;
  const inTarget = (a: InvalidationAction) => a.inTargetManifest;
  const run = (a: InvalidationAction) => inTarget(a) && (a.action === 'REGENERATE' || a.action === 'GENERATE');
  const toRun = plan.actions.filter((a) => run(a) && !PAID_TYPES.has(a.type)).map((a) => a.itemKey);
  const paidNew = plan.actions.filter((a) => run(a) && PAID_TYPES.has(a.type) && a.action === 'GENERATE').map((a) => a.itemKey);
  const paidRetry = plan.actions.filter((a) => run(a) && PAID_TYPES.has(a.type) && a.action === 'REGENERATE').map((a) => a.itemKey);
  const paidStale = plan.actions.filter((a) => inTarget(a) && a.action === 'STALE_NO_AUTO').map((a) => a.itemKey);

  const byChapter = new Map<string, ChangeImpactChapter>();
  for (const m of [...to.blueprint.modules].sort((a, b) => a.position - b.position)) {
    for (const c of [...m.chapters].sort((a, b) => a.position - b.position)) {
      byChapter.set(c.id, { chapterId: c.id, moduleId: m.id, title: c.title, regenerate: [], review: [], paidStale: [], generate: [], paidRetry: [], disable: [], untouched: true });
    }
  }
  const reasons: Record<string, string[]> = {};
  for (const a of plan.actions) {
    if (a.action !== 'REUSE') reasons[a.itemKey] = [...a.reasons];
    const ch = a.chapterId ? byChapter.get(a.chapterId) : undefined;
    if (!ch || !a.inTargetManifest && a.action !== 'SOFT_DISABLE') continue;
    if (a.action === 'REUSE') continue;
    ch.untouched = false;
    if (a.action === 'REGENERATE') (PAID_TYPES.has(a.type) ? ch.paidRetry : ch.regenerate).push(a.itemKey);
    else if (a.action === 'GENERATE') ch.generate.push(a.itemKey);
    else if (a.action === 'REVIEW') ch.review.push(a.itemKey);
    else if (a.action === 'STALE_NO_AUTO') ch.paidStale.push(a.itemKey);
    else if (a.action === 'SOFT_DISABLE') ch.disable.push(a.itemKey);
  }
  const chapters = [...byChapter.values()];
  const coverage = { coverageItems: to.manifest.items };
  const toRunPlan = providerPlanFor({ ...to.manifest, items: itemsOf(to.manifest, [...toRun, ...paidNew, ...paidRetry]) }, coverage);
  const hFrom = input.from?.studyTime?.courseEstimatedHours ?? null;
  const hTo = to.studyTime?.courseEstimatedHours ?? null;
  return {
    changeImpactVersion: CHANGE_IMPACT_VERSION,
    dryRun: true,
    providersCalled: 0,
    spendUsd: '0.00',
    totals: { ...plan.totals },
    toRun,
    paidStale,
    paidNew,
    paidRetry,
    chapters,
    untouchedChapters: chapters.filter((c) => c.untouched).length,
    cost: {
      toRun: toRunPlan,
      paidStaleIfRegenerated: providerPlanFor({ ...to.manifest, items: itemsOf(to.manifest, paidStale) }, coverage),
    },
    estimatedChangeCostUsd: toRunPlan.estimateUsd ? Number(toRunPlan.estimateUsd.expected).toFixed(2) : null,
    hours: hFrom !== null && hTo !== null ? { from: hFrom, to: hTo, delta: Math.round((hTo - hFrom) * 10) / 10 } : null,
    reasons,
  };
}

/** 5.1: tabla de dependencias (documentación viva para la UI y el reporte). */
export function dependencyTable(): { type: string; dependsOn: string; inputs: string; paid: boolean; outcomesInFingerprint: boolean }[] {
  return Object.entries(DEPENDENCY_DOC).map(([type, d]) => ({ type, ...d, outcomesInFingerprint: ALIGNMENT_FINGERPRINT_TYPES.includes(type) }));
}

/**
 * LOOP 7 (A1 I1): costo estimado de APLICAR un plan de invalidación («Generar solo lo que cambió»): lo que se
 * ejecutaría (texto/LLM + pagados nuevos o a reintentar), con el mismo estimador que la vista previa del impacto.
 * Puro (precios de referencia del seed, nada se cobra). Antes el modal no mostraba ninguna cifra: cambiar el enfoque
 * podía regenerar decenas de items LLM sin que el docente viera un monto.
 */
export interface PlanCostEstimate {
  estimatedChangeCostUsd: string | null;
  range: { min: string; max: string } | null;
  llmItems: number;
  paidItems: number;
  cost: ProviderPlan;
  note: string;
}
export function planCostEstimate(plan: InvalidationPlan, manifest: GenerationManifestV1): PlanCostEstimate {
  const keys = plan.actions.filter((a) => a.inTargetManifest && (a.action === 'REGENERATE' || a.action === 'GENERATE')).map((a) => a.itemKey);
  const items = itemsOf(manifest, keys);
  const cost = providerPlanFor({ ...manifest, items }, { coverageItems: manifest.items });
  const paid = items.filter((i) => PAID_TYPES.has(i.type)).length;
  return {
    estimatedChangeCostUsd: cost.estimateUsd ? Number(cost.estimateUsd.expected).toFixed(2) : null,
    range: cost.estimateUsd ? { min: Number(cost.estimateUsd.min).toFixed(2), max: Number(cost.estimateUsd.max).toFixed(2) } : null,
    llmItems: items.length - paid,
    paidItems: paid,
    cost,
    note: 'Estimación con precios de referencia y uso típico por tipo de recurso (no medido); el texto se valúa con el modelo recomendado. Nada se cobra al calcularla.',
  };
}
