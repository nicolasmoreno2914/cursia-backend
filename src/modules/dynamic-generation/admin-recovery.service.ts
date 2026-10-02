import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GenerationManifestsService } from '../generation-manifests/generation-manifests.service';
import { RunsService } from './runs.service';
import { RunAdminAction, RunAdminActionCode, RunCompletion } from './run-completion';

/**
 * EV6 DoD BE-B — cola de recuperación de admin (SOLO LECTURA).
 *
 * Lista la ejecución VIGENTE (la más reciente) de cada curso dinámico cuyo `completion.state` es
 * `needs_attention`, y aparte las ejecuciones de VISTA PREVIA anteriores a la DoD («cursos viejos»:
 * worker_status `completed` que hoy se evalúan `preview`). Cada acción de admin lleva el endpoint EXISTENTE
 * que la resuelve. Nunca escribe (no barre leases ni recalcula), nunca devuelve el texto técnico de un
 * error (solo su código), ni secretos ni datos personales (solo ids).
 */

export interface AdminActionEndpoint {
  method: 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** Alternativas del mismo endpoint (p.ej. las dos resoluciones de YouTube). */
  bodyAlternatives?: Array<Record<string, unknown>>;
  /** Paso previo obligatorio (p.ej. aprobar el presupuesto antes de reintentar). */
  before?: { method: 'POST'; path: string; body?: Record<string, unknown> };
  note: string;
}

export interface AdminActionWithEndpoint extends RunAdminAction {
  endpoint: AdminActionEndpoint;
}

export interface NeedsAttentionEntry {
  runId: string;
  courseId: number;
  ownerId: string;
  blueprintNumber: number;
  manifestId: number;
  rulesVersion: number;
  workerStatus: string;
  state: RunCompletion['state'];
  updatedAt: string | null;
  finishedAt: string | null;
  /** Componentes no hechos que NO son de vista previa (fallidos, bloqueados, sin validar). */
  failedComponents: Array<{ itemKey: string; type: string; status: string; failureCode: string | null }>;
  missingComponents: string[];
  previewComponents: string[];
  packageJob: RunCompletion['packageJob'] | null;
  adminActions: AdminActionWithEndpoint[];
}

export interface NeedsAttentionListing {
  generatedAt: string;
  /** Ejecuciones evaluadas (las vigentes, terminadas, más recientes primero; tope `limit`). */
  scanned: number;
  needsAttention: NeedsAttentionEntry[];
  /** Cursos de VISTA PREVIA anteriores a la DoD (run `completed` que hoy se evalúa `preview`). */
  legacyPreview: Array<NeedsAttentionEntry & { legacyPreview: true; packageBuilt: boolean; packageDownloadable: boolean }>;
  /**
   * Fix round 1 (M7): runs con la generación COMPLETA sin paquete final vigente y fuera del empaque
   * automático (completados antes de BE-B, o con el empaque automático apagado): `packageJob.status`
   * none|stale. Acción: `retry_package` (POST …/package, idempotente).
   */
  manualPackage: NeedsAttentionEntry[];
  /**
   * V542 (G6): runs (cualquier estado terminal, también `complete`) con reservas de Videogen sin liquidar
   * que solo un SUPER_ADMIN puede conciliar. Acción: `reconcile_videogen` con su `reservationKey`.
   */
  pendingReservations: NeedsAttentionEntry[];
  /** Ejecuciones que no se pudieron evaluar (integridad): solo ids y un código. */
  errors: Array<{ runId: string; courseId: number; code: string }>;
}

/** Código estable del error de un item (prefijo `^[a-z][a-z0-9_]*`), nunca el texto. */
export function failureCodeOf(error: unknown): string | null {
  const m = /^\s*(?:❌\s*)?([a-z][a-z0-9_]*)/.exec(String(error ?? ''));
  if (!m) return error ? 'unclassified' : null;
  return m[1];
}

/** Endpoint EXISTENTE que resuelve cada acción (paths relativos a /api/v1). */
export function endpointForAction(a: RunAdminAction, ids: { courseId: number; blueprintNumber: number; runId: string }): AdminActionEndpoint {
  const run = `/api/v1/courses/${ids.courseId}/blueprints/${ids.blueprintNumber}/manifest/runs/${ids.runId}`;
  const item = a.itemKey ? `${run}/items/${encodeURIComponent(a.itemKey)}` : null;
  const code: RunAdminActionCode = a.code;
  switch (code) {
    case 'retry_video_render':
      return { method: 'POST', path: `${item}/retry`, body: { resubmitVideo: true }, note: 'resubmitVideo (SUPER_ADMIN): nuevo render pagado, pasa por el gate de FinOps' };
    case 'reconcile_videogen':
      // V542 (G6): reserva de Videogen sin liquidar (resultado incierto) → decisión explícita, append-only.
      if (a.reservationKey) {
        return {
          method: 'POST', path: `/api/v1/admin/dynamic-runs/${ids.runId}/videogen-reservations/reconcile`,
          bodyAlternatives: [
            { reservationKey: a.reservationKey, outcome: 'not_charged', reason: '<qué se verificó en la cuenta de Videogen>' },
            { reservationKey: a.reservationKey, outcome: 'charged', reason: '<qué se verificó en la cuenta de Videogen>' },
          ],
          note: `reserva de Videogen PENDIENTE (USD ${a.amount ?? '?'}) de un intento que no se va a liquidar solo: Videogen no informa si cobró un job fallido; verificar en su cuenta y registrar «no cobrado» (la reserva va a 0) o «cobrado» (queda contada). SUPER_ADMIN, con motivo; nunca automático`,
        };
      }
      return {
        method: 'POST', path: `${item}/retry`, body: { resubmitVideo: true },
        note: 'verificar primero en Videogen que el envío ambiguo no generó (ni cobró) un video; luego resubmitVideo (SUPER_ADMIN)',
      };
    case 'resolve_youtube':
      return {
        method: 'POST', path: `${item}/youtube-resolution`,
        bodyAlternatives: [{ action: 'confirm_existing', youtubeVideoId: '<11 chars>' }, { action: 'authorize_reupload' }],
        note: 'resolución explícita de la subida a YouTube (sin Videogen)',
      };
    case 'reconcile_provider':
      return {
        method: 'POST', path: `${item}/retry`, body: { resubmitProvider: true },
        note: 'verificar primero en la cuenta del proveedor (Gamma/OpenAI/Anthropic); luego resubmitProvider',
      };
    case 'approve_budget':
      return {
        method: 'POST', path: `${item}/retry`, body: {},
        before: { method: 'POST', path: `/api/v1/finops/courses/${ids.courseId}/authorizations`, body: { runId: ids.runId, authorizedBudget: '<presupuesto TOTAL del run>' } },
        note: 'aprobar el presupuesto total del run (SUPER_ADMIN) y reintentar el item',
      };
    case 'retry_item':
      return { method: 'POST', path: `${item}/retry`, body: {}, note: 'reintento del item' };
    case 'regenerate_item':
      return { method: 'POST', path: `${item}/regenerate`, body: { confirmPaid: true }, note: 'regenerar el item sin validar (dryRun:true primero para ver el plan)' };
    case 'generate_real_videos':
      return {
        method: 'POST', path: `${run}/video-upgrade`, body: { estimateHash: '<de la vista previa>' },
        before: { method: 'POST', path: `${run}/video-upgrade/preview` },
        note: '«Recuperar videos (admin)»: vista previa del upgrade y confirmación (SUPER_ADMIN)',
      };
    case 'retry_package':
      return { method: 'POST', path: `${run}/package`, note: 'vuelve a armar el paquete final (idempotente con el empaque automático)' };
    case 'resolve_package_block':
      return {
        method: 'POST', path: `${run}/package`,
        note: `el paquete está bloqueado (${a.reason ?? 'precheck'}): resolver primero la causa (ver packageJob.blocked.message); después pedir el paquete`,
      };
    default:
      return { method: 'POST', path: run, note: 'sin endpoint dedicado' };
  }
}

@Injectable()
export class AdminRecoveryService {
  private readonly logger = new Logger(AdminRecoveryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
    private readonly runs: RunsService,
  ) {}

  async listNeedsAttention(opts: { limit?: number } = {}): Promise<NeedsAttentionListing> {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    // La ejecución vigente de cada curso (la más reciente); solo terminadas (las activas están en curso).
    const runs: any[] = await this.dataSource.query(
      `with latest as (
         select distinct on (r.course_id) r.*
           from public.production_jobs r
          where r.execution_mode = 'dynamic_generation'
          order by r.course_id, r.created_at desc, r.id desc
       )
       select l.*, b.blueprint_number, (l.input_payload->>'manifestId')::bigint as manifest_id_num
         from latest l
         left join public.course_generation_manifests m on m.id = (l.input_payload->>'manifestId')::bigint
         left join public.course_blueprints b on b.id = m.blueprint_id
        where coalesce(l.worker_status, '') not in ('queued', 'running', 'retrying')
        order by l.updated_at desc nulls last, l.id desc
        limit $1`,
      [limit],
    );
    const out: NeedsAttentionListing = { generatedAt: new Date().toISOString(), scanned: runs.length, needsAttention: [], legacyPreview: [], manualPackage: [], pendingReservations: [], errors: [] };
    for (const job of runs) {
      try {
        const bp = Number(job.blueprint_number);
        const manifest = await this.manifests.getById(Number(job.course_id), String(job.owner_id), bp, Number(job.manifest_id_num));
        const { completion, rows } = await this.runs.completionForAdmin(job, manifest);
        const legacy = completion.state === 'preview' && job.worker_status === 'completed';
        const manual = completion.state === 'packaging' && !!completion.packageJob && !completion.packageJob.auto &&
          ['none', 'stale'].includes(completion.packageJob.status);
        const reservationActions = completion.adminActions.filter((a) => a.code === 'reconcile_videogen' && !!a.reservationKey);
        if (completion.state !== 'needs_attention' && !legacy && !manual && !reservationActions.length) continue;
        const ids = { courseId: Number(job.course_id), blueprintNumber: bp, runId: String(job.id) };
        const byKey = new Map<string, any>(rows.map((r: any) => [r.item_key, r]));
        const failed = completion.missingComponents
          .filter((k) => !completion.previewComponents.includes(k))
          .map((k) => {
            const r = byKey.get(k);
            return { itemKey: k, type: String(r?.type ?? ''), status: String(r?.status ?? 'missing'), failureCode: failureCodeOf(r?.error) };
          });
        const entry: NeedsAttentionEntry = {
          runId: String(job.id),
          courseId: Number(job.course_id),
          ownerId: String(job.owner_id),
          blueprintNumber: bp,
          manifestId: manifest.id,
          rulesVersion: manifest.rulesVersion,
          workerStatus: String(job.worker_status),
          state: completion.state,
          updatedAt: job.updated_at ? new Date(job.updated_at).toISOString() : null,
          finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
          failedComponents: failed,
          missingComponents: completion.missingComponents,
          previewComponents: completion.previewComponents,
          packageJob: completion.packageJob ?? null,
          adminActions: completion.adminActions.map((a) => {
            const endpoint = endpointForAction(a, ids);
            // Fix round 1 (I2): acción derivada de un bloqueo del paquete → se dice por qué.
            if (a.reason && a.code !== 'resolve_package_block') endpoint.note = `${endpoint.note} — bloquea el paquete final (${a.reason}); al resolverlo el paquete se arma solo`;
            return { ...a, endpoint };
          }),
        };
        if (completion.state === 'needs_attention') out.needsAttention.push(entry);
        if (reservationActions.length) {
          out.pendingReservations.push({ ...entry, adminActions: reservationActions.map((a) => ({ ...a, endpoint: endpointForAction(a, ids) })) });
        }
        if (manual) {
          const a: RunAdminAction = { code: 'retry_package' };
          out.manualPackage.push({ ...entry, adminActions: [{ ...a, endpoint: endpointForAction(a, ids) }] });
        }
        if (legacy) {
          const [pkg] = await this.dataSource.query(
            `select count(*)::int as built,
                    count(*) filter (where (output_summary->>'artifactId') is not null)::int as downloadable
               from public.production_jobs
              where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 and worker_status = 'completed'`,
            [String(job.id)],
          );
          out.legacyPreview.push({ ...entry, legacyPreview: true, packageBuilt: (pkg?.built ?? 0) > 0, packageDownloadable: (pkg?.downloadable ?? 0) > 0 });
        }
      } catch (err) {
        const status = (err as { getStatus?: () => number })?.getStatus?.();
        out.errors.push({ runId: String(job.id), courseId: Number(job.course_id), code: status ? `http_${status}` : 'evaluation_failed' });
        this.logger.warn(`needs-attention: no se pudo evaluar el run ${job.id}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
    return out;
  }
}
