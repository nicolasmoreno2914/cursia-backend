import { isSuperAdminEmail } from '../auth/super-admin';
import { spendBlockReason } from '../modules/finops/spend-controls';

/**
 * r58 (AU3 §H1 #12, 🔴): `POST /api/v1/video-engine` llamaba a Videogen (create / batch-create ≈ USD 0,94 por video) con
 * la clave de Cursia para CUALQUIER usuario autenticado, sin ledger ni tope. Ahora (puro, testeable):
 *   - dry-run (`payload.dryRun|dry_run === true` en create / batch-create): sin proveedor → cualquier usuario autenticado
 *     (preflight / QA, igual que antes);
 *   - review r1 (I-2): `status` / `batch-status` (solo lectura, costo 0) → cualquier usuario autenticado: así el v1 en
 *     producción sigue pudiendo seguir los renders que ya envió aunque VIDEO_ENGINE_* no esté configurado. El job_id /
 *     batch_id de Videogen es opaco (lo devuelve el create al mismo dueño) y actúa como capacidad: no hay registro
 *     local de dueño por render v1; se valida su forma;
 *   - toda otra acción (auth-test, create, batch-create reales) exige rol: SuperAdmin (email
 *     verificado, ver super-admin.ts) o `sub` en VIDEO_ENGINE_ALLOWED_OWNERS (coma; `*` = todo usuario autenticado,
 *     opt-in explícito para conservar el v1 abierto) → si no, 403 `video_engine_forbidden`;
 *   - los renders REALES (create / batch-create) además exigen VIDEO_ENGINE_ENABLED=true (default false) → 503
 *     `video_engine_disabled`, y pasan por el kill switch / allow-list de FinOps (`videogen`) → 503 con su código.
 */
export const VIDEO_ENGINE_ACTIONS = ['auth-test', 'batch-create', 'create', 'status', 'batch-status'] as const;
export const VIDEO_ENGINE_RENDER_ACTIONS = new Set(['create', 'batch-create']);
/** Review r1 (I-2): acciones de solo lectura (sin proveedor pagado) abiertas a todo usuario autenticado. */
export const VIDEO_ENGINE_READ_ACTIONS = new Set(['status', 'batch-status']);
const VIDEO_ENGINE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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
  if (VIDEO_ENGINE_READ_ACTIONS.has(action)) {
    const id = action === 'status' ? a.payload?.['job_id'] : a.payload?.['batch_id'];
    if (id !== undefined && id !== null && !(typeof id === 'string' && VIDEO_ENGINE_ID_RE.test(id))) {
      return { allow: false, status: 400, code: 'video_engine_bad_request', message: 'Identificador de render inválido.' };
    }
    return { allow: true, dryRun: false };
  }
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

// ─── r75 B1 (H3): el job_id / batch_id de status y batch-status es del que pregunta ─────────────────────────────────
//
// Antes (review r1 I-2) el id de Videogen actuaba como capacidad: CUALQUIER usuario autenticado podía consultar el
// estado (con `download_url`) de los renders de otros, con la clave compartida. Ahora el id tiene que estar ligado al
// usuario en el servidor; si no, 404 `video_engine_not_found` (no revela si existe). Fuentes de propiedad:
//   1. Registro del propio proxy: cada create / batch-create REAL que pasa por `POST /video-engine` deja una fila
//      `usage_events` con `event_type = 'server.video_engine_render'` (solo el servidor la escribe: `POST /events`
//      rechaza los tipos `server.*`) y los ids devueltos por Videogen en `metadata`.
//   2. V2: `generation_item_runs.output_summary.external.videogenJobId|videogenBatchId` de un run del usuario.
//   3. Legacy (video-worker): `production_jobs.output_summary.videogenJobs[].jobId` / `batchId` de un job del usuario.
// SuperAdmin: cualquier id (soporte). Renders reales enviados ANTES de este cambio por el v1 del navegador no tienen
// registro (1): su estado deja de consultarse por esta ruta (riesgo aceptado: hoy los renders reales requieren SA o
// VIDEO_ENGINE_ALLOWED_OWNERS, y VIDEO_ENGINE_ENABLED está apagado por defecto).
export const VIDEO_ENGINE_RENDER_EVENT = 'server.video_engine_render';
export const VIDEO_ENGINE_NOT_FOUND = 'video_engine_not_found';

export type VideoEngineQuery = (sql: string, params?: unknown[]) => Promise<any[]>;

/** Ids devueltos por Videogen en un create / batch-create (job_id, batch_id, jobs[].job_id, videos[].job_id). */
export function videoEngineIdsFromResponse(parsed: unknown): { jobIds: string[]; batchId: string | null } {
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, any>;
  const ids = new Set<string>();
  const push = (v: unknown) => { if (typeof v === 'string' && VIDEO_ENGINE_ID_RE.test(v)) ids.add(v); else if (typeof v === 'number') ids.add(String(v)); };
  push(o.job_id);
  push(o.id);
  for (const list of [o.jobs, o.videos]) if (Array.isArray(list)) for (const j of list) if (j && typeof j === 'object') { push((j as any).job_id); push((j as any).id); }
  const batch = typeof o.batch_id === 'string' && VIDEO_ENGINE_ID_RE.test(o.batch_id) ? o.batch_id : null;
  return { jobIds: [...ids].slice(0, 500), batchId: batch };
}

export async function recordVideoEngineRender(query: VideoEngineQuery, userId: string, action: string, parsed: unknown): Promise<void> {
  const { jobIds, batchId } = videoEngineIdsFromResponse(parsed);
  if (!jobIds.length && !batchId) return;
  await query(
    `insert into public.usage_events (user_id, event_type, metadata) values ($1, $2, $3::jsonb)`,
    [userId, VIDEO_ENGINE_RENDER_EVENT, JSON.stringify({ source: 'video_engine_proxy', action, jobIds, batchId })],
  );
}

/** ¿El render `id` (job o batch) es de `userId`? Lecturas con `::text` en ambos lados (deriva de tipos de prod). */
export async function videoEngineIdOwnedBy(query: VideoEngineQuery, userId: string, kind: 'job' | 'batch', id: string): Promise<boolean> {
  if (!userId || !id || !VIDEO_ENGINE_ID_RE.test(id)) return false;
  const tryQ = async (sql: string, params: unknown[]): Promise<boolean> => {
    try {
      const rows = await query(sql, params);
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false; // tabla / columna ausente en esta base → esa fuente no aplica
    }
  };
  const registry = kind === 'job'
    ? `select 1 from public.usage_events where user_id::text = $1 and event_type = '${VIDEO_ENGINE_RENDER_EVENT}' and (metadata->'jobIds') ? $2 limit 1`
    : `select 1 from public.usage_events where user_id::text = $1 and event_type = '${VIDEO_ENGINE_RENDER_EVENT}' and metadata->>'batchId' = $2 limit 1`;
  if (await tryQ(registry, [userId, id])) return true;
  const v2Key = kind === 'job' ? 'videogenJobId' : 'videogenBatchId';
  if (await tryQ(
    `select 1 from public.generation_item_runs g join public.production_jobs pj on pj.id::text = g.job_id::text
      where pj.owner_id::text = $1 and (g.output_summary->'external'->>'${v2Key}' = $2 or g.output_summary->>'${v2Key}' = $2) limit 1`,
    [userId, id],
  )) return true;
  const legacy = kind === 'job'
    ? `select 1 from public.production_jobs pj where pj.owner_id::text = $1
         and jsonb_typeof(pj.output_summary->'videogenJobs') = 'array'
         and exists (select 1 from jsonb_array_elements(pj.output_summary->'videogenJobs') e where e->>'jobId' = $2 or e->>'job_id' = $2) limit 1`
    : `select 1 from public.production_jobs pj where pj.owner_id::text = $1 and pj.output_summary->>'batchId' = $2 limit 1`;
  return tryQ(legacy, [userId, id]);
}
