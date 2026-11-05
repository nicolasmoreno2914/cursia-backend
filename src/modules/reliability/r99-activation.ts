// ─────────────────────────────────────────────────────────────────────────────
// r99 (re-review P2-A / backfill) — momento de ACTIVACIÓN de r99, persistido: el primer arranque de un build con r99.
//
// Para qué: nada de r99 es retroactivo sin una decisión explícita.
//  - Reanudación por decisión del dueño (presupuesto aprobado, suspensión levantada…): solo cuentan las decisiones
//    POSTERIORES a la activación (las aprobadas bajo D-21 «aprobar no relanza» no relanzan nada al desplegar).
//  - Backfill de la pausa por bug (fallos de los últimos 30 días): las reaperturas de pausas cuyo fallo ORIGINAL es
//    anterior a la activación quedan limitadas globalmente por hora (R99_BACKFILL_MAX_RESUMES_PER_HOUR).
// Persistencia (re-review 3, P1): tabla `public.cursia_feature_activations` creada por la MIGRACIÓN
// supabase-migration-r99-activation.sql (RLS + sin privilegios para anon/authenticated). El código NUNCA hace DDL: solo
// lee, inserta (on conflict do nothing) y actualiza el latido. Latido `last_seen_at`: si pasó más de 1 h sin latido
// (rollback a un build sin r99 y vuelta, o la API caída), la activación se renueva a «ahora» — nunca se reutiliza una
// activación vieja. Sin la tabla (producción antes de aplicar la migración) o ilegible: R99_OWNER_RESUME_SINCE o el
// arranque del proceso (nunca una fecha anterior al deploy).
// ─────────────────────────────────────────────────────────────────────────────

export const R99_ACTIVATION_KEY = 'r99';
export const R99_OWNER_RESUME_SINCE_ENV = 'R99_OWNER_RESUME_SINCE';
/** Kill switch de la reanudación por decisión del dueño (default encendido; 'false' la apaga). */
export const R99_OWNER_DECISION_AUTORESUME_ENV = 'R99_OWNER_DECISION_AUTORESUME';
/** Tope GLOBAL de runs reanudados por hora desde pausas del backfill (fallo original anterior a la activación). */
export const R99_BACKFILL_MAX_RESUMES_PER_HOUR_ENV = 'R99_BACKFILL_MAX_RESUMES_PER_HOUR';
export const R99_BACKFILL_MAX_RESUMES_PER_HOUR_DEFAULT = 10;

const PROCESS_START = new Date();
/** Latido: se escribe como mucho cada este intervalo; sin latido por más de REACTIVATE, la activación se renueva. */
export const R99_HEARTBEAT_EVERY_MS = 5 * 60_000;
export const R99_REACTIVATE_AFTER_MS = 60 * 60_000;
let cached: { at: Date; seenAt: number } | null = null;

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

export function ownerDecisionAutoResumeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[R99_OWNER_DECISION_AUTORESUME_ENV] ?? '').trim().toLowerCase() !== 'false';
}

export function backfillMaxResumesPerHour(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env[R99_BACKFILL_MAX_RESUMES_PER_HOUR_ENV] ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : R99_BACKFILL_MAX_RESUMES_PER_HOUR_DEFAULT;
}

/**
 * Activación de r99. Nunca lanza. `buildId` queda registrado junto a la activación / el latido (auditoría).
 */
export async function r99ActivationAt(q: Q, env: Record<string, string | undefined> = process.env, buildId: string | null = null, now: Date = new Date()): Promise<Date> {
  const raw = String(env[R99_OWNER_RESUME_SINCE_ENV] ?? '').trim();
  if (raw) {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime())) return d;
  }
  if (cached && now.getTime() - cached.seenAt < R99_HEARTBEAT_EVERY_MS) return cached.at;
  try {
    const rows = await q.query(`select activated_at, last_seen_at, now() as db_now from public.cursia_feature_activations where key = $1`, [R99_ACTIVATION_KEY]);
    const row = rows && rows[0];
    if (!row) {
      await q.query(
        `insert into public.cursia_feature_activations (key, activated_at, last_seen_at, build_id) values ($1, now(), now(), $2) on conflict (key) do nothing`,
        [R99_ACTIVATION_KEY, buildId],
      );
    } else {
      const dbNow = new Date(row.db_now).getTime();
      const lastSeen = new Date(row.last_seen_at).getTime();
      if (!Number.isFinite(lastSeen) || dbNow - lastSeen > R99_REACTIVATE_AFTER_MS) {
        // Re-activación: el latido se cortó (r99 ausente o la API caída) → nada de lo decidido mientras tanto es retroactivo.
        await q.query(
          `update public.cursia_feature_activations set activated_at = now(), last_seen_at = now(), build_id = $2
            where key = $1 and last_seen_at < now() - make_interval(secs => $3::int)`,
          [R99_ACTIVATION_KEY, buildId, Math.floor(R99_REACTIVATE_AFTER_MS / 1000)],
        );
      } else {
        await q.query(`update public.cursia_feature_activations set last_seen_at = now(), build_id = coalesce($2, build_id) where key = $1`, [R99_ACTIVATION_KEY, buildId]);
      }
    }
    const again = await q.query(`select activated_at from public.cursia_feature_activations where key = $1`, [R99_ACTIVATION_KEY]);
    const at = again && again[0] && again[0].activated_at ? new Date(again[0].activated_at) : null;
    if (at && Number.isFinite(at.getTime())) {
      cached = { at, seenAt: now.getTime() };
      return at;
    }
  } catch {
    // Tabla ausente / sin permisos: el arranque del proceso (conservador, nunca retroactivo).
  }
  return PROCESS_START;
}

/** Solo tests. */
export function resetR99ActivationCache(): void {
  cached = null;
}
