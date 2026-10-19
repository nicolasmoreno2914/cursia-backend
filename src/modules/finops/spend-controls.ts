import { FinopsError } from './errors';

/**
 * r58 (AU3 §H4 Layer 1) — controles de gasto del SERVIDOR, leídos del entorno en CADA llamada (sin caché: un cambio del
 * `.env` + `pm2 restart --update-env` aplica de inmediato; ningún deploy los reescribe porque el deploy no gestiona
 * estas claves). Todos tienen default = comportamiento actual (apagados / sin límite).
 *
 *   FINOPS_KILL_SWITCH=true                 → ninguna RESERVA nueva de una llamada pagada por Cursia (proxy LLM del
 *                                             navegador, worker de IA, worker de proveedores, Videogen) y ninguna llamada
 *                                             directa (/tts/speech, extracción de marca / «Datos del curso» / lectura
 *                                             avanzada). Los cargos POSTERIORES a una llamada ya hecha se siguen
 *                                             registrando (el dinero ya se gastó: nunca se pierde un cargo).
 *   FINOPS_PROVIDER_ALLOWLIST=anthropic,…   → solo esos proveedores pueden reservar / ser llamados directamente.
 *                                             Vacío / ausente = todos (sin cambio).
 *   FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER → techo de gasto SIN atribuir (sin run ni curso) por dueño, ventana móvil
 *   FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL      de 24 h, y global. Ausente = sin techo (decisión pendiente del usuario).
 *   LEGACY_PAID_JOBS_ENABLED=false          → los jobs v1 pagados (/jobs/{gamma,audio,videos,full}, requeue/retry) no
 *                                             se encolan y sus workers no los reclaman. Default true (producción v1).
 *                                             Valor de modo fábrica / experimento: false.
 */

export const FINOPS_KILL_SWITCH_ENV = 'FINOPS_KILL_SWITCH';
export const FINOPS_PROVIDER_ALLOWLIST_ENV = 'FINOPS_PROVIDER_ALLOWLIST';
export const FINOPS_UNATTRIBUTED_PER_OWNER_ENV = 'FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER';
export const FINOPS_UNATTRIBUTED_GLOBAL_ENV = 'FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL';
export const LEGACY_PAID_JOBS_ENABLED_ENV = 'LEGACY_PAID_JOBS_ENABLED';

/** Códigos estables (HTTP `code`, FinopsError.code en minúsculas para el navegador; reglas en failure-classifier). */
export const SPEND_CONTROL_CODES = Object.freeze({
  killSwitch: 'finops_kill_switch',
  providerNotAllowed: 'provider_not_allowed',
  unattributedCeiling: 'unattributed_ceiling_reached',
  itemRunNotFound: 'item_run_not_found',
  legacyPaidJobsDisabled: 'legacy_paid_jobs_disabled',
});

/** Proveedores que cuestan dinero (el resto — 'cursia', 'youtube' cuota — nunca se frena acá). */
const PAID_PROVIDERS = new Set(['anthropic', 'openai', 'gamma', 'videogen']);

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

export function finopsKillSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[FINOPS_KILL_SWITCH_ENV]);
}

/** null = sin lista (todos permitidos). */
export function finopsProviderAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = String(env[FINOPS_PROVIDER_ALLOWLIST_ENV] ?? '').trim();
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Motivo de rechazo de una llamada pagada NUEVA al proveedor, o null si está permitida. Puro. */
export function spendBlockReason(provider: string, env: NodeJS.ProcessEnv = process.env): null | { code: string; message: string } {
  const p = String(provider || '').trim().toLowerCase();
  if (!PAID_PROVIDERS.has(p)) return null;
  if (finopsKillSwitchOn(env)) {
    return { code: SPEND_CONTROL_CODES.killSwitch, message: `el interruptor de gasto del servidor (${FINOPS_KILL_SWITCH_ENV}) está activo: no se hacen llamadas pagadas nuevas (${p})` };
  }
  const allow = finopsProviderAllowlist(env);
  if (allow && !allow.includes(p)) {
    return { code: SPEND_CONTROL_CODES.providerNotAllowed, message: `el proveedor ${p} no está en ${FINOPS_PROVIDER_ALLOWLIST_ENV}: no se llama` };
  }
  return null;
}

/**
 * Punto de control de las RESERVAS del ledger y de las llamadas directas: lanza FinopsError FINOPS_KILL_SWITCH /
 * PROVIDER_NOT_ALLOWED (el worker la convierte en finops_ledger_write_failed → no llama; el ingest del proxy → 409).
 */
export function assertProviderSpendAllowed(provider: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spendBlockReason(provider, env);
  if (!r) return;
  throw new FinopsError(r.code === SPEND_CONTROL_CODES.killSwitch ? 'FINOPS_KILL_SWITCH' : 'PROVIDER_NOT_ALLOWED', r.message, { provider: String(provider || '').slice(0, 32) });
}

function usd(raw: string | undefined, name: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^\d+(\.\d{1,10})?$/.test(s)) throw new FinopsError('INVALID_POLICY', `${name} inválido (${s.slice(0, 32)}): USD decimal ≥ 0`);
  return s;
}

/** Techos del gasto sin atribuir (USD decimal como string). null = sin techo. */
export function unattributedCeilings(env: NodeJS.ProcessEnv = process.env): { perOwner: string | null; global: string | null } {
  return {
    perOwner: usd(env[FINOPS_UNATTRIBUTED_PER_OWNER_ENV], FINOPS_UNATTRIBUTED_PER_OWNER_ENV),
    global: usd(env[FINOPS_UNATTRIBUTED_GLOBAL_ENV], FINOPS_UNATTRIBUTED_GLOBAL_ENV),
  };
}

/** Default true: producción v1 sigue igual. Solo el valor explícito 'false'/'0'/'off'/'no' lo apaga. */
export function legacyPaidJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[LEGACY_PAID_JOBS_ENABLED_ENV] ?? '').trim();
  if (!raw) return true;
  return !/^(0|false|off|no)$/i.test(raw);
}

export function legacyPaidJobsDisabledMessage(kind: string): string {
  return `${SPEND_CONTROL_CODES.legacyPaidJobsDisabled}: los jobs pagados v1 (${kind}) están apagados en este entorno (${LEGACY_PAID_JOBS_ENABLED_ENV}=false). No se creó ningún job ni se llamó a ningún proveedor.`;
}
