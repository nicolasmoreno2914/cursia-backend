// ─────────────────────────────────────────────────────────────────────────────
// r99 — «Todo error tiene una solución»: tabla EXPLÍCITA y EXHAUSTIVA de estrategias de remediación.
//
// Principios del dueño (vinculantes):
//  1. Un error conocido lleva SOLO a un intento DISTINTO — nunca al mismo reintento idéntico.
//  2. El creador del curso nunca necesita la autorización de un admin para recibir su curso.
//  3. Sin revisión manual por curso.
//  4. El curso no se entrega con errores, pero cada error tiene una solución (sin entrega degradada / parcial).
//
// Cada regla del clasificador (failure-classifier.ts: tablas de item, paquete y restauración) tiene acá una estrategia
// por defecto y, si la regla tiene variantes (refine), una por variante (clave = Strategy del veredicto). Cada estrategia
// del catálogo declara QUÉ CAMBIA en el próximo intento (`changes`) y los caminos de código REALES que la ejecutan
// (`codePaths`: archivo + símbolo). scripts/check-r99-remediation-strategies.js falla si:
//   - una regla del clasificador no tiene entrada, o una variante no se resuelve;
//   - un código emitido (rel-error-emitters) no resuelve una estrategia del catálogo;
//   - una estrategia es «el mismo reintento idéntico» (changes = 'nothing'), o un fallo DETERMINISTA (clase B) resuelve
//     una estrategia que no cambia la entrada;
//   - un camino de código declarado no existe en el archivo.
// Lo desconocido / sin estrategia automática es un BUG DE CURSIA (bug-hold.ts): la parte se pausa desde la PRIMERA vez,
// sale el reporte para desarrollo («Falla común», umbral 1) y se reanuda sola cuando el arreglo está desplegado.
// Puro (sin I/O).
// ─────────────────────────────────────────────────────────────────────────────
import type { FailureVerdict, Strategy } from './failure-classifier';

/** Qué cambia el próximo intento respecto del anterior. `nothing` está PROHIBIDO (el check falla). */
export type StrategyChange =
  | 'input' // el pedido cambia (hallazgos en el prompt, piezas más chicas, otro enfoque, dependencia regenerada)
  | 'external_condition' // espera una condición EXTERNA verificable (red/5xx/lease/cuota/proveedor): el intento siguiente corre en otro estado del mundo
  | 'provider_evidence' // decide con la evidencia del proveedor / del ledger (conciliación, re-poll del MISMO id)
  | 'package' // el empaque se rearma / repara el componente / re-verifica (otro build)
  | 'code_fix' // bug de Cursia: pausa + reporte; se reanuda cuando cambia el código (deploy / reclasificación)
  | 'owner_decision' // no es un error: una decisión del dueño de la cuenta / del usuario (pausa, presupuesto, acceso)
  | 'nothing';

export type RemediationStrategyId =
  | 'wait_backoff'
  | 'wait_storage_breaker'
  | 'wait_finops'
  | 'provider_probe'
  | 'repoll_provider'
  | 'youtube_wait'
  | 'prompt_with_findings'
  | 'split_smaller'
  | 'self_adaptive'
  | 'regenerate_dependency'
  | 'extend_item_budget'
  | 'reconcile_provider'
  | 'reconcile_llm_review'
  | 'spend_control_resume'
  | 'repackage'
  | 'repair_package'
  | 'reverify_restore'
  | 'cursia_issue_hold'
  | 'package_cursia_issue_hold'
  | 'owner_decision';

export interface StrategyDef {
  id: RemediationStrategyId;
  changes: StrategyChange;
  /** Qué hace (para el reporte / la documentación). */
  what: string;
  /** Caminos de código que la ejecutan (archivo relativo a src/ + símbolo definido ahí). El check verifica cada uno. */
  codePaths: ReadonlyArray<{ file: string; symbol: string }>;
}

const DG = 'modules/dynamic-generation';
const REL = 'modules/reliability';

export const STRATEGY_CATALOG: Readonly<Record<RemediationStrategyId, StrategyDef>> = Object.freeze({
  wait_backoff: {
    id: 'wait_backoff', changes: 'external_condition',
    what: 'transitorio (red, 5xx/529, lease vencido, worker reiniciado): otro intento tras espera exponencial con jitter; fase extendida acotada (72 h) y después pausa como bug de Cursia',
    codePaths: [{ file: `${DG}/item-transitions.ts`, symbol: 'applyItemFailure' }, { file: `${DG}/auto-heal.ts`, symbol: 'classAwareDecision' }],
  },
  wait_storage_breaker: {
    id: 'wait_storage_breaker', changes: 'external_condition',
    what: 'Storage caído: el breaker retiene los claims hasta que la sonda responde (sin consumir intento)',
    codePaths: [{ file: `${REL}/storage-breaker.ts`, symbol: 'storageClaimGate' }],
  },
  wait_finops: {
    id: 'wait_finops', changes: 'external_condition',
    what: 'ledger FinOps no disponible: el intento siguiente espera a que el ledger responda (nunca se llama sin reservar)',
    codePaths: [{ file: `${DG}/auto-heal.ts`, symbol: 'classAwareDecision' }],
  },
  provider_probe: {
    id: 'provider_probe', changes: 'external_condition',
    what: 'crédito/cuota del proveedor agotados: pausa por proveedor + sonda canario; se reanuda sola al volver el cupo',
    codePaths: [{ file: `${REL}/provider-probe.ts`, symbol: 'planProviderProbes' }, { file: `${DG}/runs.service.ts`, symbol: 'autoProbeProviderCredit' }],
  },
  repoll_provider: {
    id: 'repoll_provider', changes: 'provider_evidence',
    what: 're-pollear / re-descargar el MISMO id del proveedor ya persistido (gratis, sin envío nuevo)',
    codePaths: [{ file: `${REL}/auto-heal-rules.ts`, symbol: 'AUTO_HEAL_ALLOW_LIST' }, { file: `${DG}/auto-heal.ts`, symbol: 'classAwareDecision' }],
  },
  youtube_wait: {
    id: 'youtube_wait', changes: 'external_condition',
    what: 'cuota / sonda de autorización de YouTube: espera persistente sin gasto (el video ya está pagado)',
    codePaths: [{ file: 'workers/dynamic-item-worker.ts', symbol: 'publishYoutubeAndComplete' }, { file: 'workers/dynamic-item-worker.ts', symbol: 'probeYoutubeBeforeRetry' }],
  },
  prompt_with_findings: {
    id: 'prompt_with_findings', changes: 'input',
    what: 'salida de la IA inválida: los hallazgos del validador vuelven al prompt desde el PRIMER rechazo (rung 1); en el segundo, reescritura desde cero con todos los hallazgos acumulados (rung 2); agotada → pausa como bug de Cursia',
    codePaths: [{ file: `${REL}/remediation-ladder.ts`, symbol: 'ladderStep' }, { file: `${REL}/remediation-ladder.ts`, symbol: 'feedbackFor' },
      { file: 'modules/pedagogy/generator-directives.ts', symbol: 'withRemediationFeedback' }, { file: `${DG}/scheduler.service.ts`, symbol: 'prevalidateV3' }],
  },
  split_smaller: {
    id: 'split_smaller', changes: 'input',
    what: 'salida truncada / pedido demasiado grande: regenerar en piezas más chicas (pista de recuperación del claim) + hallazgos en el prompt',
    codePaths: [{ file: `${DG}/auto-heal.ts`, symbol: 'classAwareDecision' }, { file: `${REL}/remediation-ladder.ts`, symbol: 'ladderStep' }],
  },
  self_adaptive: {
    id: 'self_adaptive', changes: 'input',
    what: 'código con escalera PROPIA que cambia la entrada en cada intento (audio A2: instructions → split → speed; banco de examen: reanuda desde el borrador)',
    codePaths: [{ file: 'package/audio/audiobook-policy.ts', symbol: 'remainingAudioStrategies' }, { file: `${DG}/auto-heal.ts`, symbol: 'audioStrategiesLeftOf' }],
  },
  regenerate_dependency: {
    id: 'regenerate_dependency', changes: 'input',
    what: 'el artifact de entrada falta o está incompleto: se regenera la parte productora (o se espera a que se complete) y se reabre',
    codePaths: [{ file: `${REL}/claim-payload-recovery.ts`, symbol: 'claimPayloadRecoveryDecision' }, { file: `${DG}/runs.service.ts`, symbol: 'autoRecoverClaimPayloadUnavailable' }],
  },
  extend_item_budget: {
    id: 'extend_item_budget', changes: 'input',
    what: 'la parte agotó su tope interno: UNA ronda extra sin streaming y con max_tokens × 1,5, si el saldo del run la cubre; si vuelve a agotarlo → pausa como bug de Cursia',
    codePaths: [{ file: `${DG}/runs.service.ts`, symbol: 'autoExtendItemRecoveryBudget' }],
  },
  reconcile_provider: {
    id: 'reconcile_provider', changes: 'provider_evidence',
    what: 'pago incierto: se consulta la evidencia del proveedor / ledger, se concilia la reserva y se reenvía acotado (nunca a ciegas)',
    codePaths: [{ file: `${DG}/provider-reconcile.ts`, symbol: 'providerReconcileDecision' }, { file: `${DG}/auto-heal.ts`, symbol: 'ambiguousAudioResubmitDecision' }],
  },
  reconcile_llm_review: {
    id: 'reconcile_llm_review', changes: 'provider_evidence',
    what: 'resultados desconocidos de la IA (cortes): liquida las reservas como posible duplicado, sonda de salud sin costo y UNA reapertura',
    codePaths: [{ file: `${DG}/runs.service.ts`, symbol: 'autoReopenLlmPendingReview' }],
  },
  spend_control_resume: {
    id: 'spend_control_resume', changes: 'external_condition',
    what: 'frenado por el kill switch / allow-list de FinOps: se reabre sola cuando el control ya no la frena',
    codePaths: [{ file: `${REL}/spend-control-hold.ts`, symbol: 'spendControlHoldOf' }, { file: `${DG}/runs.service.ts`, symbol: 'autoResumeSpendControlHolds' }],
  },
  repackage: {
    id: 'repackage', changes: 'package',
    what: 'transitorio del empaque: el barrido rearma el paquete con espera creciente',
    codePaths: [{ file: 'modules/dynamic-packaging/auto-package.service.ts', symbol: 'sweep' }],
  },
  repair_package: {
    id: 'repair_package', changes: 'input',
    what: 'el validador del paquete rechazó un componente: se regenera SOLO ese componente y se reempaqueta',
    codePaths: [{ file: 'modules/dynamic-packaging/auto-package.service.ts', symbol: 'repairOrBlock' }],
  },
  reverify_restore: {
    id: 'reverify_restore', changes: 'external_condition',
    what: 'infraestructura de la restauración de verificación: se re-verifica',
    codePaths: [{ file: 'modules/dynamic-packaging/auto-package.service.ts', symbol: 'sweep' }],
  },
  cursia_issue_hold: {
    id: 'cursia_issue_hold', changes: 'code_fix',
    what: 'bug de Cursia (código sin regla, contrato roto, configuración de Cursia, estrategia agotada): pausa la parte desde la PRIMERA vez sin gastar, reporte para desarrollo («Falla común», umbral 1) y reanudación automática al desplegar el arreglo',
    codePaths: [{ file: `${REL}/bug-hold.ts`, symbol: 'bugHoldResumeDecision' }, { file: `${DG}/item-transitions.ts`, symbol: 'applyCursiaIssueHold' },
      { file: `${DG}/runs.service.ts`, symbol: 'sweepCursiaIssues' }],
  },
  package_cursia_issue_hold: {
    id: 'package_cursia_issue_hold', changes: 'code_fix',
    what: 'bug de Cursia en el empaque (validador/builder del .mbz): el curso nunca queda «listo» con el paquete roto; el barrido vuelve a armarlo al desplegar el arreglo (acotado por build)',
    codePaths: [{ file: 'modules/dynamic-packaging/auto-package.service.ts', symbol: 'resumeCursiaIssues' }],
  },
  owner_decision: {
    id: 'owner_decision', changes: 'owner_decision',
    what: 'no es un error del curso: pausa del usuario, presupuesto autorizado del run o acceso de la cuenta (lo decide el dueño de la cuenta)',
    codePaths: [{ file: `${DG}/owner-retry.ts`, symbol: 'budgetScopeOf' }],
  },
} as Record<RemediationStrategyId, StrategyDef>);

export const STRATEGY_IDS: readonly RemediationStrategyId[] = Object.freeze(Object.keys(STRATEGY_CATALOG) as RemediationStrategyId[]);

/** Entrada de la tabla: estrategia por defecto + por variante (Strategy del veredicto tras los refines). */
export interface RuleStrategyEntry {
  default: RemediationStrategyId;
  when?: Partial<Record<Strategy, RemediationStrategyId>>;
  /** Variantes por código exacto (cuando una regla agrupa códigos con soluciones distintas). */
  byCode?: Readonly<Record<string, RemediationStrategyId>>;
}

const E = (d: RemediationStrategyId, when?: RuleStrategyEntry['when'], byCode?: RuleStrategyEntry['byCode']): RuleStrategyEntry =>
  Object.freeze({ default: d, ...(when ? { when } : {}), ...(byCode ? { byCode } : {}) });

/** Tabla de ITEMS: regla del clasificador → estrategia. EXHAUSTIVA (el check compara con classifierRuleIds()). */
export const ITEM_RULE_STRATEGIES: Readonly<Record<string, RuleStrategyEntry>> = Object.freeze({
  // Infraestructura / transporte (A): condición externa.
  lease_expired: E('wait_backoff'),
  worker_draining: E('wait_backoff'),
  prior_call_in_flight: E('wait_backoff'),
  run_paused: E('owner_decision'),
  unexpected_error: E('wait_backoff', { wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  unknown_error: E('wait_backoff'),
  download_failed: E('wait_backoff'),
  exam_bank_chapter_md_missing: E('wait_backoff', { hold_for_human: 'cursia_issue_hold' }),
  storage_unavailable: E('wait_storage_breaker'),
  artifact_upload_failed: E('wait_backoff'),
  complete_rejected: E('wait_backoff'),
  finops_unavailable: E('wait_finops'),
  browser_auth: E('wait_backoff'),
  user_stopped: E('owner_decision'),
  // IA.
  llm_transient: E('wait_backoff', { wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  llm_config: E('cursia_issue_hold', undefined, { llm_credit_exhausted: 'provider_probe' }),
  llm_pending_review: E('reconcile_llm_review'),
  llm_response_lost: E('cursia_issue_hold'),
  llm_request_rejected: E('cursia_issue_hold', { regenerate_split: 'split_smaller' }),
  llm_output_cut_repeated: E('cursia_issue_hold'),
  llm_too_large: E('split_smaller'),
  output_truncated: E('split_smaller'),
  budget: E('owner_decision'),
  item_recovery_budget: E('extend_item_budget'),
  attribution_rejected: E('cursia_issue_hold'),
  spend_control_denied: E('cursia_issue_hold', { wait_provider: 'spend_control_resume' }),
  user_budget_denied: E('owner_decision'),
  generation_access_denied: E('owner_decision'),
  // Validación (B): la entrada cambia.
  v3_payload_invalid: E('prompt_with_findings'),
  validation_invalid: E('prompt_with_findings'),
  exam_bank_invalid: E('prompt_with_findings', { hold_for_human: 'cursia_issue_hold' }, { EXAM_BANK_INCOMPLETE: 'self_adaptive' }),
  corrupt_dependency: E('regenerate_dependency'),
  presentation_output_invalid: E('cursia_issue_hold', { repoll_external: 'repoll_provider' }),
  presentation_slide_count: E('cursia_issue_hold'),
  gamma_generation_failed: E('cursia_issue_hold', { provider_check: 'reconcile_provider' }),
  audio_invalid: E('self_adaptive'),
  audio_strategies_exhausted: E('cursia_issue_hold'),
  audiobook_script_failed: E('wait_backoff', { wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  // Contrato / producto (D): bug de Cursia (claim_payload_unavailable de la dependencia → regenerar la dependencia).
  contract: E('cursia_issue_hold', { regenerate_dependency: 'regenerate_dependency' }),
  v3_validator_infra: E('wait_backoff'),
  // Video.
  video_repoll: E('repoll_provider', { retry_backoff: 'wait_backoff' }),
  videogen_submit_rejected: E('wait_backoff', { wait_provider: 'cursia_issue_hold', hold_for_human: 'cursia_issue_hold' }),
  video_ambiguous: E('reconcile_provider'),
  videogen_failed: E('cursia_issue_hold', { provider_check: 'reconcile_provider' }),
  videogen_render_overdue: E('reconcile_provider'),
  provider_config: E('cursia_issue_hold', undefined, { insufficient_quota: 'provider_probe' }),
  // YouTube.
  youtube_upload_failed: E('wait_backoff'),
  youtube_ambiguous: E('reconcile_provider'),
  youtube_quota: E('youtube_wait'),
  youtube_quota_exhausted: E('cursia_issue_hold'),
  youtube_auth: E('cursia_issue_hold'),
  youtube_auth_probe: E('youtube_wait'),
  youtube_upload_unconfirmed: E('repoll_provider'),
  youtube_upload_rejected: E('cursia_issue_hold'),
  youtube_verify: E('repoll_provider'),
  youtube_delivery: E('regenerate_dependency'),
  // Gamma.
  gamma_repoll: E('repoll_provider', { retry_backoff: 'wait_backoff' }),
  gamma_submit_failed: E('wait_backoff', { wait_provider: 'cursia_issue_hold', hold_for_human: 'cursia_issue_hold' }),
  gamma_ambiguous: E('cursia_issue_hold'),
  gamma_cover_render: E('wait_backoff'),
  // TTS.
  tts_failed: E('wait_backoff', { auto_resubmit_once: 'reconcile_provider', wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  tts_chunk_cut_exhausted: E('wait_backoff', { wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  tts_provider_unhealthy: E('wait_backoff', { wait_provider: 'provider_probe', hold_for_human: 'cursia_issue_hold' }),
  audio_segment_upload_failed: E('wait_backoff'),
  provider_reconciliation: E('reconcile_provider', { hold_for_human: 'cursia_issue_hold' }),
});

/** Tabla de PAQUETE. */
export const PACKAGE_RULE_STRATEGIES: Readonly<Record<string, RuleStrategyEntry>> = Object.freeze({
  package_transient: E('repackage'),
  package_component: E('repair_package'),
  package_product: E('package_cursia_issue_hold'),
  package_precheck: E('package_cursia_issue_hold'),
});

/** Tabla de RESTAURACIÓN (verificación en Moodle). */
export const RESTORE_RULE_STRATEGIES: Readonly<Record<string, RuleStrategyEntry>> = Object.freeze({
  restore_infra: E('reverify_restore'),
  restore_precheck: E('repair_package'),
  restore_product: E('package_cursia_issue_hold'),
});

/**
 * Reglas cuya estrategia es una DECISIÓN DEL DUEÑO (no un error del curso). Lista cerrada: el check falla si otra
 * regla resuelve `owner_decision`.
 */
export const OWNER_DECISION_RULES: readonly string[] = Object.freeze(['run_paused', 'user_stopped', 'budget', 'user_budget_denied', 'generation_access_denied']);

export interface ResolvedStrategy {
  strategy: RemediationStrategyId;
  changes: StrategyChange;
  /** De dónde salió: regla de la tabla, variante, código, o un override genérico. */
  source: 'unmapped' | 'money_floor' | 'spend_control' | 'provider_config' | 'rule' | 'variant' | 'code';
  rule: string;
}

function tableFor(scope: string | null | undefined): Readonly<Record<string, RuleStrategyEntry>> {
  return scope === 'package' ? { ...PACKAGE_RULE_STRATEGIES, ...RESTORE_RULE_STRATEGIES } : ITEM_RULE_STRATEGIES;
}

/**
 * Estrategia de remediación de un veredicto del clasificador. Nunca lanza; lo que no tiene entrada es un bug de Cursia
 * (`cursia_issue_hold`, source 'unmapped').
 */
export function remediationStrategyFor(
  v: Pick<FailureVerdict, 'class' | 'code' | 'rule' | 'strategy' | 'scope' | 'provider' | 'humanReason'> & { unclassified?: boolean; moneyFloor?: boolean; providerConfigIssue?: boolean },
): ResolvedStrategy {
  const pkg = v.scope === 'package';
  const hold: RemediationStrategyId = pkg ? 'package_cursia_issue_hold' : 'cursia_issue_hold';
  const out = (strategy: RemediationStrategyId, source: ResolvedStrategy['source']): ResolvedStrategy =>
    ({ strategy, changes: STRATEGY_CATALOG[strategy].changes, source, rule: v.rule });
  if (v.unclassified || v.rule === 'unclassified') return out(hold, 'unmapped');
  // Piso de dinero (texto de presupuesto/reconciliación detrás de otro código): sin camino automático seguro → bug.
  if (v.moneyFloor) return out(v.humanReason === 'budget' ? 'owner_decision' : hold, 'money_floor');
  // Control de gasto (kill switch / allow-list): espera a que el operador lo revierta (autoResumeSpendControlHolds).
  if (v.provider === 'finops' && v.strategy === 'wait_provider' && v.class === 'D') return out('spend_control_resume', 'spend_control');
  const entry = tableFor(v.scope)[v.rule];
  if (!entry) return out(hold, 'unmapped');
  if (entry.byCode && Object.prototype.hasOwnProperty.call(entry.byCode, v.code)) return out(entry.byCode[v.code], 'code');
  // Cuota/crédito/auth del proveedor detrás de una regla de llamada (I1): sonda (crédito) o bug de configuración.
  if (v.providerConfigIssue) {
    const w = entry.when?.[v.strategy];
    if (w) return out(w, 'provider_config');
    return out(v.strategy === 'wait_provider' && (v.provider === 'anthropic' || v.provider === 'openai') ? 'provider_probe' : hold, 'provider_config');
  }
  const w = entry.when?.[v.strategy];
  if (w) return out(w, 'variant');
  return out(entry.default, 'rule');
}

/** ¿La estrategia pausa la parte como bug de Cursia? */
export function isCursiaIssueStrategy(s: RemediationStrategyId): boolean {
  return s === 'cursia_issue_hold' || s === 'package_cursia_issue_hold';
}
