/**
 * r85 — resumen de SOLO LECTURA del run V2 más reciente de cada curso dynamic, para «Mis cursos».
 *
 * Problema: la biblioteca del frontend solo ve GET /courses y `courses.status` queda en 'draft' aunque
 * el run haya terminado y el paquete Moodle esté listo → toda tarjeta V2 decía «Curso V2 · Configurar».
 * `courses.status` NO cambia de semántica: el listado agrega `v2LatestRun` a cada curso dynamic.
 *
 * Una sola consulta para todo el listado (sin N+1, sin tabla nueva): el último job `dynamic_generation`
 * por curso + los paquetes `dynamic_package` completados de ESE run (solo los campos que deciden si es
 * un paquete final: packageKind, artifactId y las señales de vista previa).
 *
 * Es una aproximación barata de `RunDto.completion` (run-completion.ts): no reevalúa los items ni la
 * frescura del paquete contra la estructura actual (eso sigue en GET …/manifest/runs/:runId, que es la
 * fuente autoritativa al abrir el curso). Un fallo de la consulta nunca rompe el listado: se omite el campo.
 */
import { isDeliverableKind, packageKindOf } from '../dynamic-packaging/package-freshness';
import { ACTIVE_RUN_WORKER_STATUSES, isCancelledLike, isPausedRun } from '../dynamic-generation/item-transitions';

export type V2LatestRunCompletionState = 'in_progress' | 'paused' | 'packaging' | 'complete' | 'preview' | 'needs_attention' | 'cancelled';

export interface V2LatestRunSummary {
  runId: string;
  /** worker_status del run ('queued' | 'running' | 'retrying' | 'paused' | 'completed' | 'preview' | 'failed' | 'cancelled'…). */
  status: string;
  completionState: V2LatestRunCompletionState;
  /** Hay un paquete FINAL completado (con artifact) de este run. */
  packageReady: boolean;
  finishedAt: string | null;
}

interface Q {
  query: (sql: string, params?: any[]) => Promise<any[]>;
}

// El paquete se busca SOLO para el último run de cada curso (CTE primero, subconsulta después: nunca por cada run viejo).
export const V2_LATEST_RUN_SQL = `with latest as (
  select distinct on (pj.course_id) pj.course_id, pj.id, pj.status, pj.worker_status, pj.finished_at
    from public.production_jobs pj
   where pj.execution_mode = 'dynamic_generation' and pj.course_id = any($1::int[])
   order by pj.course_id, pj.created_at desc, pj.id desc
)
select l.course_id, l.id, l.status, l.worker_status, l.finished_at,
       coalesce((
         select json_agg(json_build_object(
                  'inputKind', pk.input_payload->>'packageKind',
                  'kind', pk.output_summary->>'packageKind',
                  'artifactId', pk.output_summary->>'artifactId',
                  'pendingVideos', pk.output_summary->'pendingVideos',
                  'mockProviderItems', pk.output_summary->'mockProviderItems'))
           from public.production_jobs pk
          where pk.execution_mode = 'dynamic_package' and pk.worker_status = 'completed'
            and pk.input_payload->>'runId' = l.id::text
       ), '[]'::json) as packages
  from latest l`;

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** PURA: fila de V2_LATEST_RUN_SQL → resumen. */
export function summarizeV2LatestRun(row: any): V2LatestRunSummary {
  const packages: any[] = Array.isArray(row?.packages) ? row.packages : typeof row?.packages === 'string' ? JSON.parse(row.packages) : [];
  const packageReady = !isCancelledLike(row) && packages.some((p) => {
    if (!p || !p.artifactId) return false;
    const job = {
      input_payload: { packageKind: p.inputKind ?? undefined },
      output_summary: { packageKind: p.kind ?? undefined, pendingVideos: p.pendingVideos ?? undefined, mockProviderItems: p.mockProviderItems ?? undefined },
    };
    return isDeliverableKind(packageKindOf(job));
  });
  const ws = String(row?.worker_status ?? '');
  let completionState: V2LatestRunCompletionState;
  if (isCancelledLike(row)) completionState = 'cancelled';
  else if (packageReady) completionState = 'complete';
  else if (isPausedRun(row)) completionState = 'paused';
  else if (ACTIVE_RUN_WORKER_STATUSES.includes(ws)) completionState = 'in_progress';
  else if (ws === 'completed') completionState = 'packaging';
  else if (ws === 'preview') completionState = 'preview';
  else completionState = 'needs_attention';
  return {
    runId: String(row?.id ?? ''),
    status: isCancelledLike(row) ? 'cancelled' : ws,
    completionState,
    packageReady,
    finishedAt: iso(row?.finished_at),
  };
}

/**
 * Agrega `v2LatestRun` a cada curso dynamic de `courses` (in place). Cursos sin run quedan sin el campo
 * (`null` explícito) y los legacy nunca lo llevan. Con la consulta caída, ningún curso lo lleva.
 */
export async function attachV2LatestRuns<T extends { id: number; structureVersion?: string }>(
  q: Q,
  courses: T[],
  logger?: { warn: (msg: string) => void },
): Promise<T[]> {
  const dyn = courses.filter((c) => c && c.structureVersion === 'dynamic');
  if (dyn.length === 0) return courses;
  try {
    const rows = await q.query(V2_LATEST_RUN_SQL, [dyn.map((c) => Number(c.id))]);
    const byCourse = new Map<number, V2LatestRunSummary>();
    for (const r of rows) byCourse.set(Number(r.course_id), summarizeV2LatestRun(r));
    for (const c of dyn) (c as any).v2LatestRun = byCourse.get(Number(c.id)) ?? null;
  } catch (err) {
    logger?.warn(`attachV2LatestRuns: ${err instanceof Error ? err.message : String(err)}`);
  }
  return courses;
}
