import { isSuperAdminEmail } from '../auth/super-admin';
import { spendBlockReason } from '../modules/finops/spend-controls';

/**
 * r58 (AU3 §H1 #12, 🔴): `POST /api/v1/video-engine` llamaba a Videogen (create / batch-create ≈ USD 0,94 por video) con
 * la clave de Cursia para CUALQUIER usuario autenticado, sin ledger ni tope. Ahora (puro, testeable):
 *   - dry-run (`payload.dryRun|dry_run === true` en create / batch-create): sin proveedor → cualquier usuario autenticado
 *     (preflight / QA, igual que antes);
 *   - toda otra acción (auth-test, status, batch-status, create, batch-create reales) exige rol: SuperAdmin (email
 *     verificado, ver super-admin.ts) o `sub` en VIDEO_ENGINE_ALLOWED_OWNERS (coma; `*` = todo usuario autenticado,
 *     opt-in explícito para conservar el v1 abierto) → si no, 403 `video_engine_forbidden`;
 *   - los renders REALES (create / batch-create) además exigen VIDEO_ENGINE_ENABLED=true (default false) → 503
 *     `video_engine_disabled`, y pasan por el kill switch / allow-list de FinOps (`videogen`) → 503 con su código.
 */
export const VIDEO_ENGINE_ACTIONS = ['auth-test', 'batch-create', 'create', 'status', 'batch-status'] as const;
export const VIDEO_ENGINE_RENDER_ACTIONS = new Set(['create', 'batch-create']);

export type VideoEngineDecision =
  | { allow: true; dryRun: boolean }
  | { allow: false; status: 400 | 403 | 503; code: string; message: string };

export function isVideoEngineDryRun(action: string, payload: Record<string, unknown> | null | undefined): boolean {
  if (!VIDEO_ENGINE_RENDER_ACTIONS.has(action)) return false;
  return payload?.['dryRun'] === true || payload?.['dry_run'] === true;
}

export function videoEngineRoleAllowed(user: { id?: string | null; email?: string | null } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!user || !user.id) return false;
  if (isSuperAdminEmail(user.email ?? null, env)) return true;
  const list = String(env.VIDEO_ENGINE_ALLOWED_OWNERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes('*') || list.includes(String(user.id).toLowerCase());
}

export function videoEngineRealRendersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.VIDEO_ENGINE_ENABLED ?? '').trim());
}

export function decideVideoEngineAccess(
  a: { action: unknown; payload?: Record<string, unknown> | null; user: { id?: string | null; email?: string | null } | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): VideoEngineDecision {
  const action = typeof a.action === 'string' ? a.action : '';
  if (!action) return { allow: false, status: 400, code: 'video_engine_bad_request', message: 'Campo "action" requerido.' };
  if (!(VIDEO_ENGINE_ACTIONS as readonly string[]).includes(action)) {
    return { allow: false, status: 400, code: 'video_engine_bad_request', message: 'Acción desconocida.' };
  }
  if (!a.user || !a.user.id) return { allow: false, status: 403, code: 'video_engine_forbidden', message: 'No autenticado.' };
  if (isVideoEngineDryRun(action, a.payload)) return { allow: true, dryRun: true };
  if (!videoEngineRoleAllowed(a.user, env)) {
    return { allow: false, status: 403, code: 'video_engine_forbidden', message: 'Esta cuenta no tiene acceso al Video Engine.' };
  }
  if (VIDEO_ENGINE_RENDER_ACTIONS.has(action)) {
    if (!videoEngineRealRendersEnabled(env)) {
      return { allow: false, status: 503, code: 'video_engine_disabled', message: 'Los renders reales del Video Engine están apagados en este entorno (VIDEO_ENGINE_ENABLED).' };
    }
    const blocked = spendBlockReason('videogen', env);
    if (blocked) return { allow: false, status: 503, code: blocked.code, message: blocked.message };
  }
  return { allow: true, dryRun: false };
}
