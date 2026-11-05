// ─────────────────────────────────────────────────────────────────────────────
// r99 (re-review P2-A / backfill) — momento de ACTIVACIÓN de r99, persistido: el primer arranque de un build con r99.
//
// Para qué: nada de r99 es retroactivo sin una decisión explícita.
//  - Reanudación por decisión del dueño (presupuesto aprobado, suspensión levantada…): solo cuentan las decisiones
//    POSTERIORES a la activación (las aprobadas bajo D-21 «aprobar no relanza» no relanzan nada al desplegar).
//  - Backfill de la pausa por bug (fallos de los últimos 30 días): las reaperturas de pausas cuyo fallo ORIGINAL es
//    anterior a la activación quedan limitadas globalmente por hora (R99_BACKFILL_MAX_RESUMES_PER_HOUR).
// Persistencia: tabla mínima `public.cursia_feature_activations` (create if not exists + insert … on conflict do nothing:
// idempotente entre procesos e instancias). Override: env R99_OWNER_RESUME_SINCE (ISO). Si la tabla no se puede usar, el
// arranque del proceso (nunca retroactivo: el proceso arranca después del deploy).
// ─────────────────────────────────────────────────────────────────────────────

export const R99_ACTIVATION_KEY = 'r99';
export const R99_OWNER_RESUME_SINCE_ENV = 'R99_OWNER_RESUME_SINCE';
/** Kill switch de la reanudación por decisión del dueño (default encendido; 'false' la apaga). */
export const R99_OWNER_DECISION_AUTORESUME_ENV = 'R99_OWNER_DECISION_AUTORESUME';
/** Tope GLOBAL de runs reanudados por hora desde pausas del backfill (fallo original anterior a la activación). */
export const R99_BACKFILL_MAX_RESUMES_PER_HOUR_ENV = 'R99_BACKFILL_MAX_RESUMES_PER_HOUR';
export const R99_BACKFILL_MAX_RESUMES_PER_HOUR_DEFAULT = 10;

const PROCESS_START = new Date();
let cached: Date | null = null;

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

export function ownerDecisionAutoResumeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[R99_OWNER_DECISION_AUTORESUME_ENV] ?? '').trim().toLowerCase() !== 'false';
}

export function backfillMaxResumesPerHour(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env[R99_BACKFILL_MAX_RESUMES_PER_HOUR_ENV] ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : R99_BACKFILL_MAX_RESUMES_PER_HOUR_DEFAULT;
}

/** Activación de r99 (persistida la primera vez; cacheada por proceso). Nunca lanza. */
export async function r99ActivationAt(q: Q, env: Record<string, string | undefined> = process.env): Promise<Date> {
  const raw = String(env[R99_OWNER_RESUME_SINCE_ENV] ?? '').trim();
  if (raw) {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime())) return d;
  }
  if (cached) return cached;
  try {
    await q.query(`create table if not exists public.cursia_feature_activations (key text primary key, activated_at timestamptz not null default now())`);
    await q.query(`insert into public.cursia_feature_activations (key) values ($1) on conflict (key) do nothing`, [R99_ACTIVATION_KEY]);
    const rows = await q.query(`select activated_at from public.cursia_feature_activations where key = $1`, [R99_ACTIVATION_KEY]);
    const at = rows && rows[0] && rows[0].activated_at ? new Date(rows[0].activated_at) : null;
    if (at && Number.isFinite(at.getTime())) { cached = at; return at; }
  } catch {
    // sin permisos de DDL / tabla: el arranque del proceso (conservador).
  }
  return PROCESS_START;
}

/** Solo tests. */
export function resetR99ActivationCache(): void {
  cached = null;
}
