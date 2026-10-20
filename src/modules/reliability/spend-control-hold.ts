// ─────────────────────────────────────────────────────────────────────────────
// r62 (K3) — partes frenadas por un CONTROL DE GASTO del servidor (finops/spend-controls.ts): el kill switch
// (FINOPS_KILL_SWITCH) o la allow-list de proveedores (FINOPS_PROVIDER_ALLOWLIST). Nada se reservó ni se llamó
// (0 gasto). El freno es legítimo (decisión de operación), pero la VUELTA no tiene por qué ser manual: mientras el
// control siga activo la parte espera (D `wait_provider`, attention `config`); cuando el operador lo revierte, el barrido
// del servidor (RunsService.autoResumeSpendControlHolds) la reabre sola, sin consumir rondas del auto-healer.
//
// Formatos reales que se reconocen (sin depender del código de adelante, que cambia según el camino):
//  - navegador (04-api.js): `finops_kill_switch: …` / `provider_not_allowed: …`;
//  - workers: `…finops_ledger_write_failed: la reserva … — el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) …`
//    o `… el proveedor gamma no está en FINOPS_PROVIDER_ALLOWLIST: no se llama`.
// `unattributed_ceiling_reached` NO entra: es un techo de gasto SIN atribuir (ventana móvil de 24 h), nunca lo dispara
// una parte de un run. Un fallo con riesgo de pago (reconciliación / ambiguo) nunca se reconoce acá.
// Puro.
// ─────────────────────────────────────────────────────────────────────────────

export type SpendControlHoldCode = 'finops_kill_switch' | 'provider_not_allowed';

export interface SpendControlHold {
  code: SpendControlHoldCode;
  /** Proveedor de la llamada frenada (del mensaje o del tipo de item). null = desconocido. */
  provider: string | null;
}

export const SPEND_CONTROL_RESUME_STRATEGY = 'spend_control_resume';

const KILL_RE = /(?:^|[^A-Za-z0-9_])(?:finops_kill_switch|FINOPS_KILL_SWITCH)(?![A-Za-z0-9_])/;
const ALLOW_RE = /(?:^|[^A-Za-z0-9_])(?:provider_not_allowed|FINOPS_PROVIDER_ALLOWLIST)(?![A-Za-z0-9_])/;
const PAID_RISK_RE = /provider_reconciliation_required|ambiguous|ambigu[oa]|budget_exceeded|presupuesto/i;
const PROVIDER_RE = /\b(openai|anthropic|gamma|videogen)\b/i;

function providerOfItemType(itemType: string | null | undefined): string | null {
  if (itemType === 'video') return 'videogen';
  if (itemType === 'presentation') return 'gamma';
  if (itemType === 'audio_welcome' || itemType === 'audiobook_chapter') return 'openai';
  if (itemType) return 'anthropic'; // partes de la IA (navegador o worker de IA)
  return null;
}

export function spendControlHoldOf(error: string | null | undefined, itemType?: string | null): SpendControlHold | null {
  const e = String(error ?? '');
  if (!e || PAID_RISK_RE.test(e)) return null;
  const code: SpendControlHoldCode | null = KILL_RE.test(e) ? 'finops_kill_switch' : ALLOW_RE.test(e) ? 'provider_not_allowed' : null;
  if (!code) return null;
  const m = PROVIDER_RE.exec(e);
  return { code, provider: m ? m[1].toLowerCase() : providerOfItemType(itemType) };
}
