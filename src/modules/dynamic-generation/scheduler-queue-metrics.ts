import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DISPATCHABLE_RUN_WORKER_STATUSES } from './item-transitions';
import { claimablePredicate } from './scheduler.service';
import { ALL_MANIFEST_ITEM_TYPES } from '../generation-manifests/generation-manifest-builder';
import { ADMITTED_RUN_WORKER_STATUSES, FairSchedulingConfig, capOccupancySql, fairSchedulingConfig } from './fair-scheduling';

/**
 * r63 (SC) — métricas de la cola del scheduler de la generación dinámica (SOLO LECTURA).
 *
 * Una función (`computeSchedulerQueueMetrics`) para el endpoint de SuperAdmin (GET /admin/dynamic-runs/scheduler-queue)
 * y para la simulación de carga (scripts/e2e/r63-load-sim.js). Corre dentro de una transacción READ ONLY que siempre
 * termina en ROLLBACK (el servicio); sin locks y sin proveedores.
 *
 * - `byType`: por tipo de parte, cuántas hay pendientes (`pending`), reclamables AHORA (mismo predicado que el claim:
 *   dependencias completas, backoff vencido, sin lease), en espera de backoff (`retryingWaiting`), `running` y la
 *   espera de la reclamable más vieja (`oldestReadyWaitSec`). «Lista desde» = el mayor entre su alta, su próximo
 *   reintento y el fin de la última de sus dependencias (aproximación: no hay un registro del instante exacto).
 * - `runs`: runs despachables con su estado de admisión (admitido / en cola con posición), avance y último servicio.
 * - `caps`: uso de cada tope configurado. `config`: la configuración efectiva (y los valores ignorados por inválidos).
 */
export const SCHEDULER_QUEUE_METRICS_VERSION = 'scheduler-queue-v1';

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

export async function computeSchedulerQueueMetrics(q: Q, cfg: FairSchedulingConfig = fairSchedulingConfig()): Promise<Record<string, unknown>> {
  const [{ now }] = await q.query(`select now() as now`);
  const byType: Array<Record<string, unknown>> = (await q.query(
    `with live as (
       select g.type, g.status, g.next_retry_at, ${claimablePredicate('g', '$2')} as claimable,
              greatest(g.created_at, coalesce(g.next_retry_at, g.created_at),
                       coalesce((select max(d.finished_at) from public.generation_item_runs d
                                  where d.job_id = g.job_id and d.manifest_id = g.manifest_id and d.item_key = any(g.depends_on)),
                                g.created_at)) as ready_since
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
        where pj.execution_mode = 'dynamic_generation' and pj.worker_status = any($1::text[])
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and g.status in ('pending', 'retrying', 'running'))
     select l.type,
            count(*) filter (where l.status in ('pending', 'retrying'))::int as pending,
            count(*) filter (where l.claimable)::int as claimable,
            count(*) filter (where l.status = 'retrying' and l.next_retry_at > now())::int as retrying_waiting,
            count(*) filter (where l.status = 'running')::int as running,
            max(case when l.claimable then extract(epoch from (now() - l.ready_since)) end)::float as oldest_ready_wait_sec
       from live l
      group by l.type
      order by l.type`,
    // Todos los tipos: la métrica mira la cola entera (cada clase de worker filtra los suyos en su claim).
    [DISPATCHABLE_RUN_WORKER_STATUSES, [...ALL_MANIFEST_ITEM_TYPES]],
  )).map((r: any) => ({
    type: r.type, pending: r.pending, claimable: r.claimable, retryingWaiting: r.retrying_waiting, running: r.running,
    oldestReadyWaitSec: r.oldest_ready_wait_sec === null ? null : Math.round(Number(r.oldest_ready_wait_sec)),
  }));
  // Runs despachables + pausados (visibles), del más viejo al más nuevo; la posición de admisión es entre los `queued`.
  const runRows: any[] = await q.query(
    `select pj.id, pj.owner_id, pj.worker_status, pj.created_at, pj.started_at,
            count(g.id)::int as items,
            count(g.id) filter (where g.status = 'completed')::int as completed,
            count(g.id) filter (where g.status = 'running')::int as running,
            count(g.id) filter (where g.status in ('failed', 'blocked'))::int as failed_or_blocked,
            max(g.claimed_at) as last_claimed_at
       from public.production_jobs pj
       left join public.generation_item_runs g on g.job_id = pj.id
      where pj.execution_mode = 'dynamic_generation' and pj.worker_status = any($1::text[])
        and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
      group by pj.id
      order by pj.created_at, pj.id`,
    [[...DISPATCHABLE_RUN_WORKER_STATUSES, 'paused']],
  );
  let queuedPos = 0;
  const admittedCount = runRows.filter((r) => ADMITTED_RUN_WORKER_STATUSES.includes(String(r.worker_status))).length;
  const runs = runRows.map((r) => {
    const queued = String(r.worker_status) === 'queued';
    return {
      runId: r.id, ownerId: r.owner_id, workerStatus: r.worker_status,
      createdAt: r.created_at, startedAt: r.started_at, lastClaimedAt: r.last_claimed_at,
      waitSec: queued ? Math.round((new Date(now).getTime() - new Date(r.created_at).getTime()) / 1000) : null,
      admission: ADMITTED_RUN_WORKER_STATUSES.includes(String(r.worker_status)) ? 'admitted' : queued ? 'queued' : String(r.worker_status),
      ...(queued && cfg.admission.enabled ? { queuePosition: ++queuedPos } : {}),
      items: r.items, completed: r.completed, running: r.running, failedOrBlocked: r.failed_or_blocked,
    };
  });
  const caps: Array<Record<string, unknown>> = [];
  for (const c of cfg.caps) {
    const [x] = await q.query(`select count(*)::int as n from public.generation_item_runs where status = 'running' and type = any($1::text[])`, [c.types]);
    const [o] = await q.query(capOccupancySql('$1', '$2'), [c.types, cfg.capGraceSeconds]);
    caps.push({ key: c.key, max: c.max, running: Number(x.n), occupied: Number(o.n), types: c.types });
  }
  return {
    version: SCHEDULER_QUEUE_METRICS_VERSION,
    generatedAt: now,
    config: { policy: cfg.policy, caps: cfg.caps, capGraceSeconds: cfg.capGraceSeconds, admission: cfg.admission, configErrors: cfg.errors },
    totals: {
      dispatchableRuns: runs.filter((r) => r.workerStatus !== 'paused').length,
      admittedRuns: admittedCount,
      queuedRuns: runs.filter((r) => r.admission === 'queued').length,
      pausedRuns: runs.filter((r) => r.workerStatus === 'paused').length,
      claimableItems: byType.reduce((a, t) => a + Number(t.claimable), 0),
      runningItems: byType.reduce((a, t) => a + Number(t.running), 0),
    },
    byType,
    caps,
    runs,
  };
}

@Injectable()
export class SchedulerQueueMetricsService {
  constructor(private readonly dataSource: DataSource) {}

  async snapshot(): Promise<Record<string, unknown>> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('start transaction read only');
      return await computeSchedulerQueueMetrics(qr);
    } finally {
      try { await qr.query('rollback'); } catch { /* ya cerrada */ }
      await qr.release();
    }
  }
}
