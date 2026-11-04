import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GenerationManifestsService } from '../generation-manifests/generation-manifests.service';
import { AuditLogService } from '../access/audit-log.service';
import { cmpDec, normalizeDecimal } from '../finops/decimal';
import { RunsService, ADMIN_APPROVAL_WAITING_CODES, PENDING_APPROVAL_CREATED_BY_PREFIX, adminPlainRetryHint } from './runs.service';
import { failureCodeOf } from './admin-recovery.service';

/**
 * r95 · Bloque Admin (SuperAdmin) — operaciones sobre cursos de OTROS usuarios, sin migraciones:
 *  - `latestRunForCourse`: resumen de la última generación V2 de cualquier curso + sus partes no completadas (SOLO LECTURA).
 *    GET …/runs/:runId responde 404 a quien no es el dueño; esto es la vista de admin equivalente.
 *  - `pendingApprovals`: «Generaciones que esperan aprobación»: cursos cuyo ÚLTIMO estimado guardado sin run es de un
 *    arranque que necesitó un administrador (`runs.service:budget_approval_required` / `runs.service:approval_forbidden`),
 *    sin una aprobación de admin posterior ni un run creado después. Se aprueba con el endpoint EXISTENTE
 *    POST /finops/courses/:courseId/authorizations {estimateId, authorizedBudget}.
 *  - `retryItem`: reintento SIMPLE de una parte (nunca resubmitVideo / resubmitProvider desde aquí) en nombre del dueño.
 * Todo queda en admin_audit_log (recordSafe: sin la tabla de r75 no bloquea la acción, solo se avisa en el log).
 */
export interface AdminRunItem {
  itemKey: string;
  type: string;
  status: string;
  failureCode: string | null;
  attempts: number;
  maxAttempts: number | null;
  generation: number;
  updatedAt: string | null;
  /**
   * Se puede hacer el reintento SIMPLE: misma regla que retryItem({adminPlain}) (fallida o bloqueada por presupuesto, sin
   * resultado pagado ambiguo, sin reservas abiertas, con saldo y sin re-render de video). El servidor la re-evalúa bajo lock.
   */
  retryable: boolean;
  /** Código de por qué no (null si se puede) y qué hacer, en palabras. */
  retryBlockedReason: string | null;
  retryHint: string | null;
}

export interface AdminCourseRunView {
  course: { id: number; title: string | null; ownerId: string | null; ownerEmail: string | null };
  run: null | {
    runId: string;
    blueprintNumber: number;
    manifestId: number;
    workerStatus: string;
    state: string;
    createdAt: string | null;
    updatedAt: string | null;
    finishedAt: string | null;
    startedBy: string | null;
    counts: Record<string, number>;
    packageReady: boolean;
  };
  /** Partes que NO están completadas (pendientes, en curso, fallidas, bloqueadas, canceladas). */
  items: AdminRunItem[];
}

export interface PendingApprovalEntry {
  courseId: number;
  courseTitle: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  estimateId: string;
  manifestId: number | null;
  reason: string;
  currency: string;
  expected: string;
  max: string;
  /** Tope de seguridad del estimado si existe (PR #225); null = no viene en el estimado. */
  safetyCap: string | null;
  /** Monto que la UI propone aprobar: el tope de seguridad, o el máximo del estimado. */
  suggestedAmount: string;
  createdAt: string;
  /** Review P2-3: presupuesto del mes del dueño (quien iniciará la generación); null = presupuestos apagados. */
  userBudget: { mode: string; assigned: boolean; availableUsd: string } | null;
  /**
   * Review P2-3: con presupuestos en `enforce`, el arranque del usuario también tiene que entrar en SU disponible: si no
   * entra, aprobar no basta y hay que asignarle o ampliarle el presupuesto (Usuarios › Presupuesto).
   */
  budgetMustBeRaised: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de la bandeja: un estimado más viejo ya no se puede aprobar útilmente (la aprobación vence a las 24 h). */
export const PENDING_APPROVALS_WINDOW_DAYS = 14;

export interface AdminActor { id: string; email?: string | null }

@Injectable()
export class AdminCourseOpsService {
  private readonly logger = new Logger(AdminCourseOpsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
    private readonly runs: RunsService,
    private readonly audit: AuditLogService,
  ) {}

  private actorOf(a: AdminActor) {
    return { actorId: a.id, actorEmail: a.email ?? null, actorIsSuperAdmin: true };
  }

  async latestRunForCourse(courseId: number, actor: AdminActor): Promise<AdminCourseRunView> {
    const [course] = await this.dataSource.query(`select id, title, owner_id::text as owner_id, owner_email from public.courses where id = $1`, [courseId]);
    if (!course) throw new NotFoundException({ code: 'not_found', message: `No existe el curso #${courseId}` });
    // production_jobs.course_id es text en producción e integer en staging: se compara como texto (r85).
    const [job] = await this.dataSource.query(
      `select r.*, b.blueprint_number, (r.input_payload->>'manifestId')::bigint as manifest_id_num
         from public.production_jobs r
         left join public.course_generation_manifests m on m.id = (r.input_payload->>'manifestId')::bigint
         left join public.course_blueprints b on b.id = m.blueprint_id
        where r.execution_mode = 'dynamic_generation' and r.course_id::text = $1::text
        order by r.created_at desc, r.id desc
        limit 1`,
      [String(courseId)],
    );
    const view: AdminCourseRunView = {
      course: { id: Number(course.id), title: course.title ?? null, ownerId: course.owner_id ?? null, ownerEmail: course.owner_email ?? null },
      run: null,
      items: [],
    };
    if (job) {
      const bp = Number(job.blueprint_number);
      const manifest = await this.manifests.getById(Number(job.course_id), String(job.owner_id), bp, Number(job.manifest_id_num));
      const { completion, rows } = await this.runs.completionForAdmin(job, manifest);
      const counts: Record<string, number> = {};
      for (const r of rows) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
      counts.total = rows.length;
      view.run = {
        runId: String(job.id),
        blueprintNumber: bp,
        manifestId: Number(manifest.id),
        workerStatus: String(job.worker_status ?? ''),
        state: String(completion.state),
        createdAt: job.created_at ? new Date(job.created_at).toISOString() : null,
        updatedAt: job.updated_at ? new Date(job.updated_at).toISOString() : null,
        finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
        startedBy: (job.input_payload && typeof job.input_payload.startedBy === 'string') ? job.input_payload.startedBy : null,
        counts,
        packageReady: !!completion.packageReady,
      };
      const verdicts = await this.runs.adminPlainRetryVerdicts(job, rows);
      view.items = rows
        .filter((r: any) => r.status !== 'completed')
        .sort((a: any, b: any) => String(a.item_key).localeCompare(String(b.item_key)))
        .map((r: any) => ({
          itemKey: String(r.item_key),
          type: String(r.type),
          status: String(r.status),
          failureCode: failureCodeOf(r.error),
          attempts: Number(r.attempt_count ?? 0),
          maxAttempts: r.max_attempts === null || r.max_attempts === undefined ? null : Number(r.max_attempts),
          generation: Number(r.generation ?? 1),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
          ...(() => {
            const v = verdicts.get(String(r.item_key)) ?? { retryable: false, reason: 'not_failed' };
            return { retryable: v.retryable, retryBlockedReason: v.reason, retryHint: v.retryable ? null : adminPlainRetryHint(v.reason) };
          })(),
        }));
    }
    await this.audit.recordSafe({
      ...this.actorOf(actor), action: 'course.admin_view_run', targetType: 'course', targetId: String(courseId),
      after: { runId: view.run?.runId ?? null, state: view.run?.state ?? null, openItems: view.items.length },
    });
    return view;
  }

  async pendingApprovals(actor: AdminActor, opts: { limit?: number } = {}): Promise<{ generatedAt: string; windowDays: number; items: PendingApprovalEntry[] }> {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
    const codes = ADMIN_APPROVAL_WAITING_CODES.map((c) => `${PENDING_APPROVAL_CREATED_BY_PREFIX}${c}`);
    const rows: any[] = await this.dataSource.query(
      `with latest as (
         select distinct on (e.course_id) e.id, e.course_id, e.owner_id, e.manifest_id, e.totals, e.currency, e.created_at, e.created_by
           from public.cost_estimates e
          where e.scope = 'run' and e.run_id is null and e.course_id is not null
            and e.created_by like $1
            and e.created_at > now() - make_interval(days => ${PENDING_APPROVALS_WINDOW_DAYS})
          order by e.course_id, e.created_at desc, e.id desc
       )
       select l.*, c.title, c.owner_email, c.owner_id::text as course_owner_id
         from latest l
         left join public.courses c on c.id = l.course_id
        where l.created_by = any($2::text[])
          and not exists (select 1 from public.cost_budget_authorizations a
                           where a.course_id = l.course_id and a.decision = 'ADMIN_APPROVED' and a.created_at >= l.created_at)
          and not exists (select 1 from public.production_jobs j
                           where j.execution_mode = 'dynamic_generation' and j.course_id::text = l.course_id::text and j.created_at > l.created_at)
        order by l.created_at desc, l.id desc
        limit $3`,
      [`${PENDING_APPROVAL_CREATED_BY_PREFIX}%`, codes, limit],
    );
    const budgets = new Map<string, Awaited<ReturnType<RunsService['userBudgetForPayer']>>>();
    for (const r of rows) {
      const uid = String(r.owner_id ?? r.course_owner_id ?? '');
      if (uid && UUID_RE.test(uid) && !budgets.has(uid)) budgets.set(uid, await this.runs.userBudgetForPayer(uid).catch(() => null));
    }
    const items: PendingApprovalEntry[] = rows.map((r) => {
      const t = (r.totals && typeof r.totals === 'object') ? r.totals : {};
      const max = normalizeDecimal(t.max ?? 0);
      const safety = t.safetyCap !== undefined && t.safetyCap !== null ? normalizeDecimal(t.safetyCap) : null;
      return {
        courseId: Number(r.course_id),
        courseTitle: r.title ?? null,
        ownerId: r.owner_id ?? r.course_owner_id ?? null,
        ownerEmail: r.owner_email ?? null,
        estimateId: String(r.id),
        manifestId: r.manifest_id === null || r.manifest_id === undefined ? null : Number(r.manifest_id),
        reason: String(r.created_by).slice(PENDING_APPROVAL_CREATED_BY_PREFIX.length),
        currency: String(r.currency || 'USD').trim(),
        expected: normalizeDecimal(t.expected ?? 0),
        max,
        safetyCap: safety,
        suggestedAmount: safety ?? max,
        createdAt: new Date(r.created_at).toISOString(),
        ...(() => {
          const ub = budgets.get(String(r.owner_id ?? r.course_owner_id ?? '')) ?? null;
          return {
            userBudget: ub ? { mode: ub.mode, assigned: ub.assigned, availableUsd: ub.available } : null,
            budgetMustBeRaised: !!ub && ub.mode === 'enforce' && cmpDec(safety ?? max, ub.available) > 0,
          };
        })(),
      };
    });
    await this.audit.recordSafe({ ...this.actorOf(actor), action: 'finops.pending_approvals_view', targetType: 'finops', targetId: null, after: { count: items.length } });
    return { generatedAt: new Date().toISOString(), windowDays: PENDING_APPROVALS_WINDOW_DAYS, items };
  }

  /** Reintento simple de una parte del run (en nombre del dueño del curso), auditado. Nunca reenvía pagos a proveedores. */
  async retryItem(runId: string, itemKey: string, actor: AdminActor, reason: string | null): Promise<unknown> {
    if (!UUID_RE.test(String(runId))) throw new BadRequestException('runId debe ser UUID');
    if (typeof itemKey !== 'string' || !itemKey.trim() || itemKey.length > 300) throw new BadRequestException('itemKey inválido');
    const [job] = await this.dataSource.query(
      `select r.id, r.course_id, r.owner_id::text as owner_id, b.blueprint_number
         from public.production_jobs r
         left join public.course_generation_manifests m on m.id = (r.input_payload->>'manifestId')::bigint
         left join public.course_blueprints b on b.id = m.blueprint_id
        where r.id = $1 and r.execution_mode = 'dynamic_generation'`,
      [runId],
    );
    if (!job) throw new NotFoundException({ code: 'not_found', message: `No existe la generación ${runId}` });
    const base = { ...this.actorOf(actor), action: 'course.admin_retry_item', targetType: 'course', targetId: String(job.course_id) };
    try {
      const res = await this.runs.retryItem(Number(job.course_id), String(job.owner_id), Number(job.blueprint_number), String(job.id), itemKey,
        false, false, undefined, { id: actor.id, email: actor.email ?? null }, { adminPlain: true });
      await this.audit.recordSafe({ ...base, after: { runId, itemKey, ok: true, reason: reason ?? null } });
      return res;
    } catch (err) {
      const r = (err as { getResponse?: () => unknown })?.getResponse?.() as { code?: string } | undefined;
      const status = (err as { getStatus?: () => number })?.getStatus?.();
      await this.audit.recordSafe({ ...base, after: { runId, itemKey, ok: false, code: (r && r.code) || (status ? `http_${status}` : 'error'), reason: reason ?? null } });
      throw err;
    }
  }
}
