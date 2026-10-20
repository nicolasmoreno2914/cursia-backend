/**
 * r62 (K5) — visibilidad del HOLD persistente de workers (solo lectura, pura).
 *
 * En staging, `worker_off` (deploy-staging.yml → scripts/staging-v21-calibration.js) deja `DYNAMIC_WORKERS_HOLD=true`
 * en el .env y el deploy lo respeta: el worker de proveedores (Gamma/TTS) y el de IA quedan APAGADOS hasta un
 * `worker_on` explícito (r58 AU3 §J2). La acción reinicia también la API (`--update-env`), así que la API ve el mismo
 * valor. Antes nada lo mostraba en el run: las partes de proveedor quedaban `pending`/`queued` sin motivo visible.
 *
 * `RunDto.workersHold` lo expone con estado y motivo. No cambia la lógica de los workers ni el interruptor (sigue
 * siendo una herramienta legítima de operación). Sin hold → null.
 */
import { isProviderWorkerDeployed } from './provider-modes';

export const WORKERS_HOLD_ENV = 'DYNAMIC_WORKERS_HOLD';
/** Tipos que ejecuta el worker de proveedores (los que quedan parados con el hold). */
export const PROVIDER_WORKER_ITEM_TYPES: readonly string[] = Object.freeze(['presentation', 'audio_welcome', 'audiobook_chapter']);
const OPEN_STATUSES = new Set(['pending', 'queued', 'running', 'retrying', 'blocked']);

export type WorkersHoldReason = 'worker_off_persistent' | 'provider_worker_disabled';

export interface WorkersHoldView {
  /** `held`: los workers del servidor no toman trabajo hasta que un operador los vuelva a encender. */
  state: 'held';
  reason: WorkersHoldReason;
  /** Variable que lo explica (para el operador). */
  env: string;
  /** Workers afectados. */
  workers: string[];
  /** Partes de ESTE run que esperan a esos workers (pueden quedar vacías: el hold se muestra igual). */
  affectedItemKeys: string[];
  /** Acción de operación que lo levanta. */
  resolution: 'worker_on';
  message: string;
}

export function workersHoldActive(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[WORKERS_HOLD_ENV] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Hold de workers visible en el run. `worker_off_persistent` siempre que el HOLD esté activo; sin HOLD pero con el
 * worker de proveedores apagado, solo si este run tiene partes de proveedor abiertas (si no, no afecta al run).
 */
export function workersHoldViewOf(
  rows: ReadonlyArray<{ item_key: string; type: string; status: string }>,
  env: Record<string, string | undefined> = process.env,
): WorkersHoldView | null {
  const affected = rows
    .filter((r) => PROVIDER_WORKER_ITEM_TYPES.includes(String(r.type)) && OPEN_STATUSES.has(String(r.status)))
    .map((r) => String(r.item_key));
  if (workersHoldActive(env)) {
    return {
      state: 'held',
      reason: 'worker_off_persistent',
      env: `${WORKERS_HOLD_ENV}=true`,
      workers: ['dynamic-provider-worker', 'dynamic-llm-worker'],
      affectedItemKeys: affected,
      resolution: 'worker_on',
      message: 'Los workers del servidor (proveedores e IA) están retenidos por un worker_off persistente: las partes de Gamma/TTS no avanzan hasta un worker_on.',
    };
  }
  if (!isProviderWorkerDeployed(env) && affected.length > 0) {
    return {
      state: 'held',
      reason: 'provider_worker_disabled',
      env: 'DYNAMIC_PROVIDER_WORKER_ENABLED≠true',
      workers: ['dynamic-provider-worker'],
      affectedItemKeys: affected,
      resolution: 'worker_on',
      message: 'El worker de proveedores está apagado: las partes de Gamma/TTS de este run no avanzan hasta encenderlo.',
    };
  }
  return null;
}
