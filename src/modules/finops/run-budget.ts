/**
 * V2.1 RF-b — gates de presupuesto de un run (audit §W.7, HD-V21-19). Puro:
 * sin DB, sin reloj, sin random.
 *
 * - Items del Manifest (v1/v2/v3) → items del estimador. En un run MOCK los
 *   items de proveedor de worker (video/presentation/audio_*) se excluyen: el
 *   worker devuelve fixtures y el ledger los registra como MOCK a 0.
 * - Un run con algún proveedor pagado REAL (Videogen, Gamma, TTS) que va a
 *   GENERAR/REGENERAR requiere siempre aprobación humana (ADMIN_APPROVAL).
 * - El LLM corre en el navegador: el backend no puede pre-bloquearlo. Con
 *   política, superar sus límites con el estimado LLM ⇒ ADMIN_APPROVAL
 *   (nunca BLOCK); sin política ⇒ AUTO (se registra el estimado igual).
 */
import { FinopsError } from './errors';
import { cmpDec, normalizeDecimal, DecimalLike } from './decimal';
import { BudgetDecision, BudgetPolicy, EvaluateBudgetResult, SpentSoFar, evaluateBudget } from './budget';
import type { EstimateItem, EstimateResult } from './estimator';

export const BUDGET_APPROVAL_REQUIRED = 'budget_approval_required';
export const BUDGET_BLOCKED = 'budget_blocked';
export const BUDGET_EXCEEDED = 'budget_exceeded';
export const FINOPS_UNAVAILABLE = 'finops_unavailable';

/** Item types que produce un worker del backend contra un proveedor pagado. */
export const WORKER_PAID_ITEM_TYPES: readonly string[] = ['video', 'presentation', 'audio_welcome', 'audiobook_chapter'];

/** Proveedor pagado de cada item type de worker (el que el runtime guard vigila). */
export function paidProviderOfItemType(itemType: string): 'videogen' | 'gamma' | 'openai' | null {
  if (itemType === 'video') return 'videogen';
  if (itemType === 'presentation') return 'gamma';
  if (itemType === 'audio_welcome' || itemType === 'audiobook_chapter') return 'openai';
  return null;
}

export type RunSpendMode = 'mock' | 'real';

/**
 * Modo de gasto POR PROVEEDOR de un run: video = `input_payload.videoMode`;
 * presentation/audio = `input_payload.providerModes` (R5 fix round 1; default
 * real). Un string aplica el mismo modo a todo (compatibilidad).
 */
export interface RunSpendModes {
  video: RunSpendMode;
  presentation: RunSpendMode;
  audio: RunSpendMode;
}

/**
 * Modos de gasto de un run desde lo congelado. providerModes ausente/corrupto ⇒
 * `real` para el presupuesto (fail safe: nunca se asume gratis un proveedor pagado).
 */
export function runSpendModes(
  videoMode: string | null | undefined,
  providerModes: { presentation?: string | null; audio?: string | null } | null | undefined,
): RunSpendModes {
  return {
    video: videoMode === 'real' ? 'real' : 'mock',
    presentation: providerModes?.presentation === 'mock' ? 'mock' : 'real',
    audio: providerModes?.audio === 'mock' ? 'mock' : 'real',
  };
}

function asModes(mode: RunSpendMode | RunSpendModes): RunSpendModes {
  if (mode === 'mock' || mode === 'real') return { video: mode, presentation: mode, audio: mode };
  if (!mode || typeof mode !== 'object') throw new FinopsError('INVALID_INPUT', `modo inválido: ${String(mode)}`);
  for (const k of ['video', 'presentation', 'audio'] as const) {
    if (mode[k] !== 'mock' && mode[k] !== 'real') throw new FinopsError('INVALID_INPUT', `modo inválido para ${k}: ${String(mode[k])}`);
  }
  return mode;
}

/** Modo de gasto de un item type de worker pagado (null = no es de worker pagado: LLM). */
export function spendModeOfItemType(mode: RunSpendMode | RunSpendModes, itemType: string): RunSpendMode | null {
  const m = asModes(mode);
  if (itemType === 'video') return m.video;
  if (itemType === 'presentation') return m.presentation;
  if (itemType === 'audio_welcome' || itemType === 'audiobook_chapter') return m.audio;
  return null;
}

export interface RunManifestItem {
  key: string;
  type: string;
  moduleId?: string | null;
  chapterId?: string | null;
}

const GENERATING = new Set(['GENERATE', 'REGENERATE']);

/**
 * Manifest → items del estimador. `actions` (itemKey → acción del plan de
 * invalidación o de la regeneración) default GENERATE. Mock: sin items de worker.
 */
export function estimateItemsForRun(
  items: readonly RunManifestItem[],
  mode: RunSpendMode | RunSpendModes,
  actions?: Readonly<Record<string, string>> | null,
): EstimateItem[] {
  if (!Array.isArray(items)) throw new FinopsError('INVALID_INPUT', 'estimateItemsForRun necesita items[]');
  const modes = asModes(mode);
  const out: EstimateItem[] = [];
  for (const it of items) {
    if (WORKER_PAID_ITEM_TYPES.includes(it.type) && spendModeOfItemType(modes, it.type) === 'mock') continue;
    out.push({
      itemKey: it.key,
      itemType: it.type,
      moduleId: it.moduleId ?? null,
      chapterId: it.chapterId ?? null,
      action: (actions && actions[it.key]) || 'GENERATE',
    });
  }
  return out;
}

/** Proveedores pagados REALES que el run va a usar (ordenados, sin repetidos). */
export function paidRealProviders(items: readonly EstimateItem[], mode: RunSpendMode | RunSpendModes): string[] {
  const modes = asModes(mode);
  const set = new Set<string>();
  for (const it of items) {
    const p = paidProviderOfItemType(String(it.itemType));
    if (p && spendModeOfItemType(modes, String(it.itemType)) === 'real' && GENERATING.has(String(it.action ?? 'GENERATE'))) set.add(p);
  }
  return Array.from(set).sort();
}

export interface RunBudgetDecision extends EvaluateBudgetResult {
  paidRealProviders: string[];
}

const RANK: Record<BudgetDecision, number> = { AUTO_WITHIN_POLICY: 0, ADMIN_APPROVAL: 1, BLOCK: 2 };

export function decideRunBudget(input: {
  estimate: Pick<EstimateResult, 'totals'>;
  policy: BudgetPolicy | null;
  spentSoFar?: SpentSoFar | null;
  paidRealProviders: readonly string[];
}): RunBudgetDecision {
  if (!input || !input.estimate || !input.estimate.totals) throw new FinopsError('INVALID_INPUT', 'decideRunBudget necesita estimate.totals');
  const paid = [...(input.paidRealProviders || [])].sort();
  if (paid.length === 0) {
    if (!input.policy) return { decision: 'AUTO_WITHIN_POLICY', reasons: ['no_paid_worker_provider', 'no_budget_policy'], paidRealProviders: paid };
    // Solo LLM (navegador): los límites de la política aplican, pero nunca bloquean.
    const r = evaluateBudget({
      estimate: input.estimate,
      policy: { ...input.policy, requireHumanApprovalForRealSpend: false },
      spentSoFar: input.spentSoFar ?? null,
      realSpend: true,
    });
    const decision: BudgetDecision = r.decision === 'BLOCK' ? 'ADMIN_APPROVAL' : r.decision;
    const reasons = r.decision === 'BLOCK' ? [...r.reasons, 'llm_only_block_downgraded_to_admin_approval'] : r.reasons;
    return { decision, reasons, paidRealProviders: paid };
  }
  const r = evaluateBudget({
    estimate: input.estimate,
    policy: input.policy,
    spentSoFar: input.spentSoFar ?? null,
    realSpend: true,
  });
  let decision = r.decision;
  const reasons = [...r.reasons];
  if (RANK[decision] < RANK.ADMIN_APPROVAL) decision = 'ADMIN_APPROVAL';
  reasons.push(`paid_real_provider_requires_admin_approval:${paid.join(',')}`);
  return { decision, reasons, paidRealProviders: paid };
}

/** Una aprobación cubre el estimado si authorized_budget >= expected. */
export function approvalCovers(authorizedBudget: DecimalLike, estimate: Pick<EstimateResult, 'totals'>): boolean {
  return cmpDec(normalizeDecimal(authorizedBudget, 'authorizedBudget'), estimate.totals.expected) >= 0;
}

/** Resumen compacto del estimado para el cuerpo del 409 (sin líneas). */
export function estimateSummary(estimate: EstimateResult): {
  currency: string;
  min: string;
  expected: string;
  max: string;
  byProvider: EstimateResult['totals']['byProvider'];
} {
  return {
    currency: estimate.currency,
    min: estimate.totals.min,
    expected: estimate.totals.expected,
    max: estimate.totals.max,
    byProvider: estimate.totals.byProvider,
  };
}
