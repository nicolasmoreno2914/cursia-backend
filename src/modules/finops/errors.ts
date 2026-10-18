/**
 * V2.1 RF-a — error tipado de FinOps. `code` es estable (los tests y RF-b lo
 * comparan): PRICING_MISSING, PRICING_AMBIGUOUS, CURRENCY_MISMATCH,
 * INVALID_USAGE, INVALID_DECIMAL, INVALID_IDEMPOTENCY_PART,
 * UNKNOWN_IDEMPOTENCY_KIND, UNKNOWN_ITEM_TYPE, UNKNOWN_ACTION,
 * USAGE_MODEL_MISSING, INVALID_POLICY, INVALID_INPUT, ORIGINAL_NOT_FOUND.
 * r58 (controles de gasto, spend-controls.ts): FINOPS_KILL_SWITCH, PROVIDER_NOT_ALLOWED, UNATTRIBUTED_CEILING,
 * ITEM_RUN_NOT_FOUND (HTTP 409 con el código en minúsculas; ver SPEND_CONTROL_HTTP_CODES).
 */
export class FinopsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = 'FinopsError';
    this.code = code;
    this.details = details;
  }
}
