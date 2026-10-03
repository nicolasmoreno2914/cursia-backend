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
import { bankAskCount, expectedExamPlan } from '../course-shell/exam-bank';

export const BUDGET_APPROVAL_REQUIRED = 'budget_approval_required';
export const BUDGET_BLOCKED = 'budget_blocked';
export const BUDGET_EXCEEDED = 'budget_exceeded';
/** Calibración #2: item con una operación pagada de resultado ambiguo (no se reintenta solo). */
export const PROVIDER_RECONCILIATION_REQUIRED = 'provider_reconciliation_required';
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
 * V542 — escala del banco de un examen para el estimador. Los priors de `llm.exam` / `llm.final_exam`
 * (usage-model.priors.v1.json v1.2) están calibrados con el curso #542 (2 módulos × 2 capítulos): un
 * examen de módulo de 2 capítulos y un final de 2×2. El banco se genera como el ejecutor del navegador
 * (45-dynamic-generation-executor.js, `_dynRunExamBank`): por hoja se piden 2·slots + 2 (selección
 * múltiple) o 2·slots + 1 (V/F, emparejamiento) preguntas (`bankAskCount`, holgura BANKOPT), repartidas entre los capítulos de la hoja; cada capítulo es una unidad que se parte
 * en llamadas de ≤ 3500 tokens de salida estimados (MC 660, VF 265, EM 335 por pregunta), y CADA
 * llamada lleva el texto del capítulo. Por eso la entrada escala con las llamadas y la salida con los
 * tokens pedidos: { input_tokens: llamadas / llamadas_ref, output_tokens: salida / salida_ref }.
 * null = sin capítulos en el Manifest (escala 1).
 */
export const EXAM_BANK_REFERENCE = Object.freeze({
  exam: [{ id: 'r1', moduleId: 'm1' }, { id: 'r2', moduleId: 'm1' }],
  final_exam: [{ id: 'r1', moduleId: 'm1' }, { id: 'r2', moduleId: 'm1' }, { id: 'r3', moduleId: 'm2' }, { id: 'r4', moduleId: 'm2' }],
});
/**
 * = DYN_EXAM_BANK_TOKENS_EST y DYN_EXAM_BANK_MAX_OUTPUT_EST del ejecutor. Hotfix #583 (fix/bank-call-timeout):
 * tope de 3.500 tokens estimados por llamada (antes 6.500: ~7.500-8.000 reales tardaban > 100 s y Cloudflare
 * cortaba con 524) y tokens por pregunta medidos en #542 (MC 660, V/F 265, EM 335).
 */
export const EXAM_BANK_TOKENS_EST = Object.freeze({ multichoice: 660, truefalse: 265, match: 335 } as Record<string, number>);
export const EXAM_BANK_CALL_OUTPUT_EST = 3500;

export function examBankShape(scope: 'module' | 'final', chapters: ReadonlyArray<{ id: string; moduleId: string }>): { questions: number; calls: number; outputEst: number; units: number } {
  const perChapter = new Map<string, number>();
  let questions = 0;
  for (const leaf of expectedExamPlan(scope, chapters)) {
    const n = bankAskCount(leaf.slots, leaf.type);
    questions += n;
    const owners = 'chapterId' in leaf ? [leaf.chapterId] : chapters.filter((c) => c.moduleId === leaf.moduleId).map((c) => c.id);
    const base = Math.floor(n / owners.length);
    const extra = n - base * owners.length;
    owners.forEach((ch, j) => perChapter.set(ch, (perChapter.get(ch) ?? 0) + (base + (j < extra ? 1 : 0)) * (EXAM_BANK_TOKENS_EST[leaf.type] ?? 660)));
  }
  let calls = 0;
  let outputEst = 0;
  let units = 0;
  for (const est of perChapter.values()) {
    if (est <= 0) continue;
    units++;
    calls += Math.max(1, Math.ceil(est / EXAM_BANK_CALL_OUTPUT_EST));
    outputEst += est;
  }
  return { questions, calls, outputEst, units };
}

/**
 * BANKOPT (caché de prompts): cada capítulo (unidad) ESCRIBE su prefijo una vez (fuente + tarea) y las demás
 * llamadas del capítulo lo LEEN → cache_write_tokens escala con las unidades y cache_read_tokens con las
 * llamadas (input_tokens, el tail sin caché, también).
 */
export type ExamBankUsageScale = { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number };

export function examBankUsageScale(itemType: 'exam' | 'final_exam', chapters: ReadonlyArray<{ id: string; moduleId: string }>): ExamBankUsageScale | null {
  if (!chapters.length) return null;
  const scope = itemType === 'exam' ? 'module' : 'final';
  const ref = examBankShape(scope, EXAM_BANK_REFERENCE[itemType]);
  const got = examBankShape(scope, chapters);
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  // Lecturas: las llamadas que siguen a la primera de cada capítulo (hermanas y reparaciones) crecen con las
  // llamadas, igual que el tail sin caché.
  return {
    input_tokens: r4(got.calls / ref.calls),
    output_tokens: r4(got.outputEst / ref.outputEst),
    cache_write_tokens: r4(got.units / ref.units),
    cache_read_tokens: r4(got.calls / ref.calls),
  };
}

/**
 * r19 (bloque A) — el audiolibro narra el capítulo COMPLETO: su costo (guion LLM por bloque + TTS) es
 * proporcional a las palabras del capítulo. Los priors de `llm.audiobook_script` / `tts.audiobook_chapter`
 * (usage-model.priors.v1.json v1.6, bloque audiobookR19) corresponden a un capítulo dinámico estándar de
 * 2.800 palabras. Con las palabras conocidas (p. ej. una regeneración con el contenido ya generado), la
 * escala es palabras / 2.800; antes de generar, la referencia (escala 1).
 */
export const AUDIOBOOK_REFERENCE_CHAPTER_WORDS = 2800;

export function audiobookUsageScale(chapterWords: number | null | undefined): number | null {
  const w = Number(chapterWords);
  if (!Number.isFinite(w) || w <= 0) return null;
  return Math.round((w / AUDIOBOOK_REFERENCE_CHAPTER_WORDS) * 10000) / 10000;
}

/** Capítulos (orden del Manifest) por módulo, desde los items de capítulo. */
function manifestChapters(items: readonly RunManifestItem[]): Array<{ id: string; moduleId: string }> {
  const out: Array<{ id: string; moduleId: string }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it.chapterId || !it.moduleId || seen.has(it.chapterId)) continue;
    seen.add(it.chapterId);
    out.push({ id: it.chapterId, moduleId: it.moduleId });
  }
  return out;
}

/**
 * Manifest → items del estimador. `actions` (itemKey → acción del plan de
 * invalidación o de la regeneración) default GENERATE. Mock: sin items de worker.
 */
export function estimateItemsForRun(
  items: readonly RunManifestItem[],
  mode: RunSpendMode | RunSpendModes,
  actions?: Readonly<Record<string, string>> | null,
  opts?: { chapterWords?: Readonly<Record<string, number>> | null } | null,
): EstimateItem[] {
  if (!Array.isArray(items)) throw new FinopsError('INVALID_INPUT', 'estimateItemsForRun necesita items[]');
  const modes = asModes(mode);
  const out: EstimateItem[] = [];
  const chapters = manifestChapters(items);
  for (const it of items) {
    if (WORKER_PAID_ITEM_TYPES.includes(it.type) && spendModeOfItemType(modes, it.type) === 'mock') continue;
    // V542: el banco del examen escala con los capítulos que cubre (módulo: los suyos; final: todos).
    const scale =
      it.type === 'exam' ? examBankUsageScale('exam', chapters.filter((c) => c.moduleId === it.moduleId))
        : it.type === 'final_exam' ? examBankUsageScale('final_exam', chapters)
          : it.type === 'audiobook_chapter' && it.chapterId ? audiobookUsageScale(opts?.chapterWords?.[it.chapterId])
            : null;
    out.push({
      itemKey: it.key,
      itemType: it.type,
      moduleId: it.moduleId ?? null,
      chapterId: it.chapterId ?? null,
      action: (actions && actions[it.key]) || 'GENERATE',
      ...(scale !== null && (typeof scale === 'number' ? scale !== 1 : Object.values(scale).some((v) => v !== 1)) ? { usageScale: scale } : {}),
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
