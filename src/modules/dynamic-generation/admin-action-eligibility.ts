// ─────────────────────────────────────────────────────────────────────────────
// r106 — compuertas de ESTADO de las acciones de admin de una parte (fuente única). Las usa RunsService
// (retryItem / regenerateItem / resolveYoutubeUpload) y el clasificador central (failure-classifier.ts) para
// que el `adminAction` de cada fallo sea una acción que el endpoint ACEPTA en el estado en que el fallo deja
// la parte (antes: EXAM_BANK_*_CAPACITY → regenerate_item sobre una parte `failed` = 409 item_not_completed).
// scripts/check-rel-admin-actions.js recorre cada regla del clasificador contra estas mismas funciones.
// Puro (sin I/O).
// ─────────────────────────────────────────────────────────────────────────────
import { BUDGET_EXCEEDED, PROVIDER_RECONCILIATION_REQUIRED } from '../finops/run-budget';
import { VIDEOGEN_RENDER_OVERDUE } from './videogen-render-cap';

type ItemState = { status?: string | null; error?: string | null; output_summary?: Record<string, any> | null };

/** Tipos de item que ejecuta el worker de proveedores (reenvío con resubmitProvider). */
export const RESUBMIT_PROVIDER_ITEM_TYPES: readonly string[] = Object.freeze(['presentation', 'audio_welcome', 'audiobook_chapter']);

/** V2.1 RF-b: item bloqueado por el runtime guard de presupuesto (reanudable con retry). */
export function isBudgetBlocked(row: ItemState): boolean {
  return row.status === 'blocked' && String(row.error ?? '').startsWith(BUDGET_EXCEEDED);
}

/** retryItem: solo una parte `failed` (o `blocked` por presupuesto). */
export function retryAcceptsItem(row: ItemState): boolean {
  return row.status === 'failed' || isBudgetBlocked(row);
}

/** regenerateItem: solo una parte `completed` (una `failed` se reintenta: blocker item_not_completed). */
export function regenerateAcceptsStatus(status: string | null | undefined): boolean {
  return status === 'completed';
}

/** Subida a YouTube sin confirmar: la resuelve youtube-resolution; el retry simple la rechaza (youtube_upload_ambiguous). */
export function isAmbiguousYoutubeUpload(row: { error?: string | null; output_summary?: Record<string, any> | null }): boolean {
  const os = row.output_summary ?? {};
  if (os.external?.youtubeVideoId) return false;
  return (
    os.delivery === 'ambiguous' ||
    String(row.error ?? '').startsWith('ambiguous_youtube_upload') ||
    (!!os.youtubeUploadStartedAt && os.delivery !== 'blocked_auth' && os.delivery !== 'blocked_quota')
  );
}

/** retryItem con resubmitProvider: el último error que admite el reenvío explícito (sin el chequeo del tipo). */
export function resubmitProviderErrorEligible(type: string | null | undefined, error: string | null | undefined): boolean {
  const err = String(error ?? '');
  return type === 'presentation'
    ? err.startsWith('gamma_submit_ambiguous') || err.startsWith('gamma_generation_failed') || err.startsWith(PROVIDER_RECONCILIATION_REQUIRED)
    : err.startsWith(PROVIDER_RECONCILIATION_REQUIRED);
}

/**
 * retryItem con resubmitVideo pedido por una PERSONA (sin auto-heal): el último error que admite un render nuevo.
 * `videogen_render_overdue` solo con la excepción ya registrada para ESE error (la conciliación lo declinó).
 */
export function manualResubmitVideoEligible(error: string | null | undefined, outputSummary: Record<string, any> | null | undefined): boolean {
  const err = String(error ?? '');
  const prc = outputSummary?.providerReconcile;
  return err.startsWith('videogen_failed') || err.startsWith('ambiguous_video_submission')
    || err.startsWith('videogen_submit_rejected') || err.startsWith(PROVIDER_RECONCILIATION_REQUIRED)
    || (err.startsWith(VIDEOGEN_RENDER_OVERDUE) && !!prc?.declined && String(prc?.declinedError ?? '') === err);
}

/**
 * Acción de conciliación EJECUTABLE para un fallo con pago incierto, según el tipo de la parte y su error:
 *  - video con un error que admite resubmitVideo → `reconcile_videogen`;
 *  - presentación / audio con un error que admite resubmitProvider → `reconcile_provider`;
 *  - parte de la IA (contenido, examen, …: ningún reenvío a proveedor aplica) → `retry_item` (como llm_response_lost; al
 *    dueño lo frena el guard de cobro duplicado, el SUPER_ADMIN decide);
 *  - video / presentación / audio con un error que NINGÚN reenvío explícito admite → null: no hay acción de conciliación
 *    ejecutable (decisión pendiente; el clasificador conserva la de la regla y el check la lista como conocida).
 */
export function reconcileActionFor(
  itemType: string | null | undefined, error: string | null | undefined, outputSummary?: Record<string, any> | null,
): 'reconcile_videogen' | 'reconcile_provider' | 'retry_item' | null {
  if (itemType === 'video') return manualResubmitVideoEligible(error, outputSummary) ? 'reconcile_videogen' : null;
  if (itemType && RESUBMIT_PROVIDER_ITEM_TYPES.includes(itemType)) return resubmitProviderErrorEligible(itemType, error) ? 'reconcile_provider' : null;
  return itemType ? 'retry_item' : null;
}
