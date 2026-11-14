import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { returningRows } from '../../../common/db/returning-rows';
import { ArtifactsService } from '../../artifacts/artifacts.service';
import { isUuid } from '../../authz/schema-probe';
import { isMbzReaderError } from '../mbz-reader';
import { isCourseWorkshopEnabled } from '../../features/course-workshop-flag';
import { CourseWorkshopService, MemoryWaitTimeoutError, WORKSHOP_BUCKET, WORKSHOP_ERRORS, WorkshopActor, WorkshopPlanSession } from '../course-workshop.service';
import { DIAGNOSIS_CODE_VERSION, DiagnosisReport } from '../diagnosis/diagnose';
import type { Finding } from '../diagnosis/finding';
import { planWarnings } from '../plan/risk';
import type { PlanItemView } from '../plan/types';
import type { PatchOperation } from '../patch/types';
import {
  APPLY_CODE_VERSION, ApplyApproval, ApplyCandidate, approvalMismatch, itemContentHash, planContentHash, ApplyRunFail, ApplyRunItem, RESTORE_NOT_AVAILABLE_MESSAGE, RestoreChecker, applyMemoryFactor, chainOf, confirmationsMissing,
  nextVersionNumber, runApply, selectApplyItems, versionStoragePath, isStructuralOperation, STRUCTURAL_COMBINATION, STRUCTURAL_COMBINATION_MESSAGE, structuralLast,
} from './apply-core';
import { LibroV3SourceResolver, libroV3ResolverOf, regenerateLibroV3Pdf } from './libro-v3';
import { ModuleRef } from '@nestjs/core';
import { isPaidOperation } from '../regenerate/types';
import { resolveRegenParams } from '../regenerate/store';
import { buildDynamicMbzV3 } from '../../../package/dynamic-mbz-builder-v3';

/**
 * r107 B6 · Taller de cursos — APLICAR un plan aprobado y VERSIONES (diseño §4 «apply» / «verify» / «version», D9, D10).
 *
 *   POST …/sessions/:id/plans/:planId/apply { planHash, items: [{id, contentHash}], confirm: [{id, contentHash}] } → 202 versión `queued`
 *     - solo un plan `draft` (o `failed`, para reintentar) cuyos ítems de la Fase 2 tienen su contenido generado, cuya
 *       prueba en seco COMBINADA (sobre el original verificado) sigue pasando para exactamente esos ítems, y con la
 *       confirmación INDIVIDUAL de cada ítem de riesgo alto (`requiresItemConfirm`, B5 P2-4): sin ella → 409 con los ids
 *       que faltan y los avisos del plan (REMOVALS / BULK_REMOVALS / MANY_HIGH_RISK) otra vez;
 *     - el plan pasa a `applying` y los ítems + sus operaciones quedan CONGELADOS en la versión (editar el plan después
 *       no cambia lo que se aplica); aplicar la Fase 2 NO llama a la IA (costo de aplicar = USD 0; D9).
 *   El TRABAJO corre fuera del request, en el proceso de la API (el mismo mecanismo que el diagnóstico de B3, sin un
 *   proceso pm2 nuevo — ver B6-report §worker): la fila de la versión ES la cola (reclamo `<arranque>.<uuid>` + latido
 *   cada 10 s; una fila de un arranque que dejó de latir hace 30 s la reclama cualquier proceso: el barrido periódico,
 *   el sondeo GET o el próximo POST), carril de 1 por proceso y presupuesto de memoria (motor = original + resultado +
 *   diagnóstico(s): factor medido zip 7× / tar.gz 10×; espera a que haya lugar; nunca entra → falla con el motivo).
 *     building  → descarga y VERIFICA el original (sha1/sha256), corre el motor B4 con la compuerta antes/después;
 *     verifying → validador (v3) / estructura; restauración: no hay un Moodle en este entorno → `not_available` con su
 *                 texto (ruling B6; nunca «restaurado» sin hacerlo);
 *     ready     → paquete nuevo subido a la carpeta del dueño y registrado como artifact `workshop_version` (solo del
 *                 servidor, protegido contra borrado como el original) en LA MISMA transacción que la versión `ready`;
 *     failed    → motivo visible + plan `failed` (reintentable si el motivo es transitorio); el original y las versiones
 *                 anteriores no cambian nunca; si el paquete ya se había subido y la registración falló, se borra (nunca un
 *                 objeto huérfano).
 *   GET …/sessions/:id/versions → versiones de la sesión + la CADENA (original → arreglo 1 → arreglo 2…);
 *   GET …/sessions/:id/versions/:versionId → una versión con su informe; …/download → URL firmada de 5 min;
 *   POST …/sessions/:id/versions/:versionId/session → sesión HIJA cuyo original es esa versión (encadenar arreglos).
 * Compuertas: las de B1 (ajeno → 404; SuperAdmin; miembro de la institución con permiso en enforce): aplicar / abrir
 * sesión = `courses.edit`; ver / descargar = `courses.view`.
 */

export const APPLY_ERRORS = Object.freeze({
  PLAN_NOT_FOUND: 'WORKSHOP_PLAN_NOT_FOUND',
  PLAN_NOT_DRAFT: 'WORKSHOP_PLAN_NOT_DRAFT',
  ITEMS_REQUIRED: 'WORKSHOP_APPLY_ITEMS_INVALID',
  PLAN_CHANGED: 'WORKSHOP_APPLY_PLAN_CHANGED',
  NOT_READY: 'WORKSHOP_APPLY_NOT_READY',
  EMPTY: 'WORKSHOP_APPLY_EMPTY',
  CONFIRM_REQUIRED: 'WORKSHOP_APPLY_CONFIRM_REQUIRED',
  DRY_RUN_STALE: 'WORKSHOP_APPLY_DRY_RUN_STALE',
  DRY_RUN_FAILED: 'WORKSHOP_APPLY_DRY_RUN_FAILED',
  TOO_LARGE: 'WORKSHOP_APPLY_TOO_LARGE',
  INTERRUPTED: 'WORKSHOP_APPLY_INTERRUPTED',
  FAILED: 'WORKSHOP_APPLY_FAILED',
  UPLOAD_FAILED: 'WORKSHOP_APPLY_UPLOAD_FAILED',
  VERSION_NOT_FOUND: 'WORKSHOP_VERSION_NOT_FOUND',
  VERSION_NOT_READY: 'WORKSHOP_VERSION_NOT_READY',
  VERSION_CHANGED: 'WORKSHOP_VERSION_CHANGED',
});

export const APPLY_HEARTBEAT_MS = 10_000;
export const APPLY_HEARTBEAT_STALE_MS = 3 * APPLY_HEARTBEAT_MS;
/** Barrido de versiones abandonadas (pm2 reload, OOM) en cada proceso de la API con el flag encendido. */
export const APPLY_SWEEP_MS = 15_000;
/** Reclamos máximos de una versión (cada arranque que la toma cuenta uno): más → falla con el motivo, sin repetir para siempre. */
export const APPLY_MAX_ATTEMPTS = 3;
export const VERSION_DOWNLOAD_SECONDS = 300;
export const WORKSHOP_VERSION_MIME = 'application/vnd.moodle.backup';

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };
const iso = (d: Date | string | null | undefined) => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

interface VersionRow {
  id: string; session_id: string; plan_id: string; number: number; parent_version_id: string | null; base_sha1: string;
  status: 'queued' | 'building' | 'verifying' | 'ready' | 'failed'; claim_id: string | null; attempts: number;
  item_ids: string[]; operations: PatchOperation[]; confirmed_item_ids: string[];
  artifact_id: string | null; storage_path: string | null; sha1: string | null; sha256: string | null; size_bytes: string | number | null; container: 'zip' | 'tar.gz' | null;
  report: any; diagnosis: any; validation: any; restore_check: 'passed' | 'failed' | 'not_available' | null; restore_check_message: string | null;
  cost: any; error: any; created_by: string; created_at: Date; updated_at: Date; finished_at: Date | null;
}

@Injectable()
export class WorkshopApplyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkshopApplyService.name);
  /** Trabajos de este proceso (las pruebas los esperan). */
  readonly inFlight = new Map<string, Promise<void>>();
  /** Aplicaciones efectivamente corridas por el motor en este proceso (las pruebas lo leen). */
  runs = 0;
  /** Pico de aplicaciones corriendo a la vez en este proceso (carril de 1: nunca > 1). */
  maxConcurrent = 0;
  private lane: string | null = null;
  private readonly queue: Array<{ versionId: string; claimId: string; done: () => void }> = [];
  private readonly beating = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private dead = false;
  /** Verificador de restauración (un Moodle). En staging no hay ninguno: null → `not_available` (ruling B6). */
  restoreChecker: RestoreChecker | null = null;
  /** Fuente del Libro v3 (entrada del builder del curso). En B6 el del servidor responde `unavailable` (ver libro-v3.ts). */
  libroSource: LibroV3SourceResolver;
  /** SOLO pruebas: corre antes de cada etapa (simular una falla o una caída a mitad). */
  testHook: ((stage: 'building' | 'verifying' | 'upload' | 'register', versionId: string) => Promise<void> | void) | null = null;
  now: () => Date = () => new Date();

  constructor(
    private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactsService,
    private readonly workshop: CourseWorkshopService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    // r107 B10: el resolvedor del SERVIDOR (entrada del builder v3 desde la base, con la composición compartida con el
    // dynamic-package-worker); sin los servicios del generador en el proceso, el de B6 (no disponible, con motivo).
    this.libroSource = { resolve: (s) => libroV3ResolverOf(this.dataSource, this.artifacts, this.moduleRef).resolve(s) };
  }

  onModuleInit(): void {
    if (!isCourseWorkshopEnabledSafe()) return;
    this.sweepTimer = setInterval(() => { void this.sweep().catch((e) => this.logger.warn(`taller versiones: barrido falló: ${e instanceof Error ? e.message : String(e)}`)); }, APPLY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sweepTimer = null;
    this.heartbeatTimer = null;
  }

  private get bootId(): string {
    return this.workshop.bootId;
  }

  private async q<T = any>(m: Q, sql: string, params: unknown[] = []): Promise<T> {
    try {
      return await m.query(sql, params);
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703') {
        throw new ServiceUnavailableException({ code: WORKSHOP_ERRORS.NOT_MIGRATED, message: 'El Taller de cursos todavía no está disponible en este entorno (falta la migración r107).' });
      }
      throw err;
    }
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  // ── aprobar y aplicar ──

  private async itemsOf(planId: string): Promise<ApplyCandidate[]> {
    const rows = await this.q<any[]>(this.dataSource,
      `select i.id, i.request_id, i.operation, i.status, i.stage, i.available, i.params, i.view, i.requires_item_confirm, i.risk_level, r.status as request_status, r.quote
         from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
        where i.plan_id = $1 order by i.created_at, i.id`, [planId]);
    return rows.map((r) => ({
      id: r.id, requestId: r.request_id, operation: r.operation, status: r.status, requestStatus: r.request_status, stage: r.stage, available: r.available === true,
      params: r.params ?? null, requiresItemConfirm: r.requires_item_confirm === true, summary: (r.view as PlanItemView)?.summary ?? r.operation, quote: r.quote, riskLevel: r.risk_level,
      contentHash: itemContentHash({ operation: r.operation, stage: r.stage, params: r.params ?? null, view: r.view ?? null }),
    }));
  }

  private async planWarningsOf(planId: string) {
    const rows = await this.q<any[]>(this.dataSource,
      `select i.id, i.operation, i.view, i.status, r.intake_id, r.status as request_status from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id where i.plan_id = $1`, [planId]);
    return planWarnings(rows.map((r) => ({ id: r.id, operation: r.operation, risk: (r.view as PlanItemView).risk, intakeId: r.intake_id, live: r.status === 'proposed' && r.request_status !== 'withdrawn' })));
  }

  /** Fix round 1 (P2-2): `{ planHash, items: [{id, contentHash}], confirm: [{id, contentHash}] }` → validado (400 si no). */
  static parseApproval(body: unknown): ApplyApproval {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const bad = (m: string) => new BadRequestException({ code: APPLY_ERRORS.ITEMS_REQUIRED, message: m });
    const hex = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
    const list = (raw: unknown, what: string, required: boolean) => {
      if (raw === undefined && !required) return [];
      if (!Array.isArray(raw) || (required && !raw.length) || raw.length > 100) throw bad(`Indica ${what} (lista de { id, contentHash } tal como los muestra el plan).`);
      const out = raw.map((x) => (x && typeof x === 'object' ? x as Record<string, unknown> : {}));
      if (out.some((x) => typeof x.id !== 'string' || !isUuid(x.id) || !hex(x.contentHash))) throw bad(`${what}: cada uno con su id y su huella de contenido (contentHash).`);
      const ids = out.map((x) => String(x.id).toLowerCase());
      if (new Set(ids).size !== ids.length) throw bad(`${what}: sin repetir.`);
      return out.map((x) => ({ id: String(x.id).toLowerCase(), contentHash: String(x.contentHash) }));
    };
    if (!hex(b.planHash)) throw bad('Falta la huella del plan que revisaste (planHash).');
    return { planHash: String(b.planHash), items: list(b.items, 'los ítems que apruebas aplicar', true), confirm: list(b.confirm, 'las confirmaciones de los cambios de riesgo alto', false) };
  }

  async apply(actor: WorkshopActor, sessionId: string, planId: string, body: unknown) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    if (!isUuid(planId)) throw new NotFoundException({ code: APPLY_ERRORS.PLAN_NOT_FOUND, message: 'Plan no encontrado.' });
    const [plan] = await this.q<any[]>(this.dataSource, `select * from public.workshop_plans where id = $1 and session_id = $2 and original_sha1 = $3`, [planId.toLowerCase(), s.id, s.originalSha1]);
    if (!plan) throw new NotFoundException({ code: APPLY_ERRORS.PLAN_NOT_FOUND, message: 'Plan no encontrado.' });
    if (plan.status === 'applying' || plan.status === 'applied') {
      const v = await this.versionOfPlan(plan.id);
      throw new ConflictException({ code: APPLY_ERRORS.PLAN_NOT_DRAFT, message: plan.status === 'applied' ? 'Este plan ya se aplicó: para seguir arreglando, abre una sesión desde su versión.' : 'Este plan ya se está aplicando.', status: plan.status, version: v ? this.versionView(v, s) : null });
    }
    const approval = WorkshopApplyService.parseApproval(body);

    const items = await this.itemsOf(plan.id);
    const sel = selectApplyItems(items);
    const warnings = await this.planWarningsOf(plan.id);
    const view = (i: ApplyCandidate) => ({ id: i.id, operation: i.operation, summary: i.summary, risk: i.riskLevel, requiresItemConfirm: i.requiresItemConfirm, contentHash: i.contentHash });
    if (sel.blocking.length) throw new ConflictException({ code: APPLY_ERRORS.NOT_READY, message: 'Hay ítems del plan que todavía no se pueden aplicar.', blocking: sel.blocking });
    if (sel.apply.filter((i) => isStructuralOperation(i.operation)).length > 1) throw new ConflictException({ code: STRUCTURAL_COMBINATION, message: STRUCTURAL_COMBINATION_MESSAGE, items: sel.apply.filter((i) => isStructuralOperation(i.operation)).map(view) });
    if (!sel.apply.length) throw new ConflictException({ code: APPLY_ERRORS.EMPTY, message: 'El plan no tiene ítems para aplicar en esta fase.', later: sel.later.map(view) });
    const applyIds = sel.apply.map((i) => i.id);
    const current = sel.apply.map((i) => ({ id: i.id, contentHash: i.contentHash as string }));
    const mm = approvalMismatch(current, approval);
    if (mm.changed.length || mm.missing.length || mm.extra.length || !mm.planHashOk) {
      throw new ConflictException({
        code: APPLY_ERRORS.PLAN_CHANGED, message: 'El plan cambió desde que lo revisaste (contenido o ítems): vuelve a revisarlo y aprueba otra vez.',
        changedItemIds: mm.changed, missingItemIds: mm.missing, extraItemIds: mm.extra, planHash: planContentHash(current), items: sel.apply.map(view),
      });
    }
    // Confirmaciones: cada una con la huella del contenido ACTUAL (confirmar un cambio que después cambió no vale).
    const byId = new Map(sel.apply.map((i) => [i.id, i]));
    const unknown = approval.confirm.filter((c) => !byId.has(c.id)).map((c) => c.id);
    if (unknown.length) throw new BadRequestException({ code: APPLY_ERRORS.ITEMS_REQUIRED, message: 'Confirmaste ítems que no están entre los que se aplican.', unknownItemIds: unknown });
    const confirmed = approval.confirm.filter((c) => byId.get(c.id)?.contentHash === c.contentHash).map((c) => c.id);
    const conf = confirmationsMissing(sel.apply, confirmed);
    if (conf.missing.length) {
      throw new ConflictException({
        code: APPLY_ERRORS.CONFIRM_REQUIRED, message: `Confirma uno por uno los ${conf.missing.length} cambio(s) de riesgo alto antes de aplicar.`,
        missingItemIds: conf.missing, items: sel.apply.filter((i) => conf.missing.includes(i.id)).map(view), warnings,
      });
    }
    // La prueba en seco COMBINADA (sobre el original verificado, la guarda el plan) tiene que estar al día para ESTOS ítems.
    const combined = plan.combined;
    // Fix round 2 (nota): por ids Y por la huella del contenido de cada ítem (si el ítem cambió y la prueba en seco no se
    // rehízo todavía, está vencida).
    // r107 B11: la prueba combinada corre con los estructurales al final (mismo orden que al aplicar).
    const ordered = structuralLast(sel.apply);
    const hashes = ordered.map((i) => i.contentHash as string);
    if (!combined || !Array.isArray(combined.itemIds) || combined.itemIds.join(',') !== ordered.map((i) => i.id).join(',')
      || !Array.isArray(combined.itemHashes) || combined.itemHashes.join(',') !== hashes.join(',')) {
      throw new ConflictException({ code: APPLY_ERRORS.DRY_RUN_STALE, message: 'La prueba en seco del plan todavía no está al día con estos cambios: espera unos segundos y vuelve a intentar.' });
    }
    if (combined.ok !== true) {
      const failedId = combined.failedItemId ?? null;
      throw new ConflictException({ code: APPLY_ERRORS.DRY_RUN_FAILED, message: `La prueba en seco del plan combinado no pasa: ${combined.failure?.message ?? 'motivo desconocido'}. Quita o corrige el ítem que falla.`, failedItemId: failedId, failure: combined.failure ?? null });
    }
    const factor = applyMemoryFactor(s.container);
    const estimate = Math.ceil(Number(s.originalSize ?? 0) * factor);
    if (estimate > this.workshop.memoryBudgetBytes) {
      throw new ConflictException({ code: APPLY_ERRORS.TOO_LARGE, message: `Este paquete pesa ${Math.round(Number(s.originalSize ?? 0) / 1048576)} MB: aplicar en línea admite hasta ${Math.floor(this.workshop.memoryBudgetBytes / factor / 1048576)} MB${s.container === 'tar.gz' ? ' en tar.gz' : ''} (necesita ~${factor}× su tamaño en memoria). Avísanos para aplicarlo aparte.` });
    }

    const parentVersionId = await this.workshop.parentVersionOf(s.id);
    const parent = parentVersionId ? await this.versionById(parentVersionId) : null;
    const number = nextVersionNumber(parent);
    const claimId = `${this.bootId}.${randomUUID()}`;
    const ops = sel.apply.map((i) => i.params as PatchOperation);
    let version: VersionRow | null = null;
    let raced = false;
    await this.dataSource.transaction(async (m) => {
      const [p] = await this.q<any[]>(m, `select status from public.workshop_plans where id = $1 for update`, [plan.id]);
      if (!p || (p.status !== 'draft' && p.status !== 'failed')) return;
      // P2-2: el contenido se vuelve a leer BLOQUEADO y se congela ese: si cambió entre la lectura y acá, no se aplica.
      const locked = await this.q<any[]>(m, `select id, operation, stage, params, view from public.workshop_plan_items where id = any($1::uuid[]) for update`, [applyIds]);
      const lockedHash = new Map(locked.map((r) => [r.id, itemContentHash({ operation: r.operation, stage: r.stage, params: r.params ?? null, view: r.view ?? null })]));
      if (locked.length !== applyIds.length || applyIds.some((id) => lockedHash.get(id) !== byId.get(id)?.contentHash)) { raced = true; return; }
      const [prev] = await this.q<VersionRow[]>(m, `select * from public.workshop_versions where plan_id = $1 for update`, [plan.id]);
      const failures = prev ? [...(Array.isArray(prev.report?.previousFailures) ? prev.report.previousFailures : []), ...(prev.error ? [{ ...prev.error, at: iso(prev.finished_at ?? prev.updated_at) }] : [])] : [];
      const report = JSON.stringify({ previousFailures: failures.slice(-10), approval: { planHash: approval.planHash, items: approval.items, confirm: approval.confirm, by: actor.id } });
      if (prev && prev.status !== 'failed') return; // otra versión viva del plan (no debería: el plan estaba draft/failed)
      [version] = prev
        ? returningRows(await this.q(m,
          `update public.workshop_versions set status = 'queued', claim_id = $2, attempts = 0, item_ids = $3::jsonb, operations = $4::jsonb, confirmed_item_ids = $5::jsonb,
                  number = $6, parent_version_id = $7, base_sha1 = $8, report = $9::jsonb, diagnosis = null, validation = null, error = null, cost = null,
                  restore_check = null, restore_check_message = null, storage_path = null, artifact_id = null, created_by = $10, finished_at = null, updated_at = now()
            where id = $1 and status = 'failed' returning *`,
          [prev.id, claimId, JSON.stringify(applyIds), JSON.stringify(ops), JSON.stringify(confirmed), number, parentVersionId, s.originalSha1, report, actor.id])) as VersionRow[]
        : await this.q<VersionRow[]>(m,
          `insert into public.workshop_versions (session_id, plan_id, number, parent_version_id, base_sha1, status, claim_id, item_ids, operations, confirmed_item_ids, report, created_by)
                values ($1, $2, $3, $4, $5, 'queued', $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11) returning *`,
          [s.id, plan.id, number, parentVersionId, s.originalSha1, claimId, JSON.stringify(applyIds), JSON.stringify(ops), JSON.stringify(confirmed), report, actor.id]);
      await this.q(m, `update public.workshop_plans set status = 'applying', updated_at = now() where id = $1`, [plan.id]);
    });
    if (raced) throw new ConflictException({ code: APPLY_ERRORS.PLAN_CHANGED, message: 'El plan cambió mientras lo aprobabas: vuelve a revisarlo y aprueba otra vez.' });
    if (!version) throw new ConflictException({ code: APPLY_ERRORS.PLAN_NOT_DRAFT, message: 'Este plan ya se está aplicando.' });
    this.enqueue((version as VersionRow).id, claimId);
    return { version: this.versionView(version as VersionRow, s), plan: { id: plan.id, status: 'applying' as const }, warnings, later: sel.later.map(view) };
  }

  // ── trabajo (carril de 1 + memoria + reclamo / latido) ──

  private enqueue(versionId: string, claimId: string): void {
    const key = `apply:${versionId}`;
    if (this.inFlight.has(key)) return;
    let done!: () => void;
    const p = new Promise<void>((r) => { done = r; }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    this.beat(claimId, true);
    this.queue.push({ versionId, claimId, done });
    this.pump();
  }

  private pump(): void {
    if (this.dead || this.lane !== null) return;
    const job = this.queue.shift();
    if (!job) return;
    this.lane = job.versionId; // síncrono: ningún otro llamado pasa entre el chequeo y la toma
    (async () => {
      const [v] = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where id = $1`, [job.versionId]);
      if (!v || v.claim_id !== job.claimId) return;
      const s = await this.workshop.planSessionById(v.session_id);
      // r107 B10: los resultados de regeneraciones (audiolibro, video, PDF) también se cargan en memoria.
      const regenBytes = (Array.isArray(v.operations) ? v.operations : []).filter((o: any) => isPaidOperation(o?.op)).reduce((n: number, o: any) => n + 2 * Number(o?.result?.bytes ?? 0), 0);
      const bytes = Math.ceil(Number(s?.originalSize ?? 0) * applyMemoryFactor(s?.container)) + regenBytes;
      let release: () => void;
      try {
        release = await this.workshop.acquireMemory(`apply:${job.versionId}`, bytes);
      } catch (err) {
        // Fix round 2 (N1): la espera por memoria venció → la versión falla con el motivo, reintentable.
        if (err instanceof MemoryWaitTimeoutError) { await this.failVersion(job.versionId, job.claimId, { stage: 'queued', code: err.code, message: err.message, retryable: true }); return; }
        throw err;
      }
      try {
        this.maxConcurrent = Math.max(this.maxConcurrent, 1);
        await this.runVersion(job.versionId, job.claimId);
      } finally {
        release();
      }
    })()
      .catch((err) => this.logger.error(`taller versión ${job.versionId}: terminó con error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => {
        this.lane = null;
        this.beat(job.claimId, false);
        job.done();
        this.pump();
      });
  }

  private beat(claimId: string, on: boolean): void {
    if (on) this.beating.add(claimId); else this.beating.delete(claimId);
    if (this.beating.size && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, APPLY_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    } else if (!this.beating.size && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Latido: refresca `updated_at` de las versiones de este proceso (en cola o trabajando). */
  async heartbeat(): Promise<void> {
    if (!this.beating.size || this.dead) return;
    await this.q(this.dataSource, `update public.workshop_versions set updated_at = now() where claim_id = any($1::text[]) and status in ('queued', 'building', 'verifying')`, [[...this.beating]])
      .catch((err) => this.logger.warn(`taller versiones: latido falló: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** ¿Versión en curso de un proceso que ya no late (o de este arranque pero perdida)? */
  private abandoned(v: VersionRow): boolean {
    if (!['queued', 'building', 'verifying'].includes(v.status)) return false;
    const owner = String(v.claim_id ?? '').split('.')[0];
    if (owner === this.bootId) return !this.beating.has(String(v.claim_id));
    return this.now().getTime() - new Date(v.updated_at).getTime() >= APPLY_HEARTBEAT_STALE_MS;
  }

  /** Reclama una versión abandonada (condicional a lo que se vio: dos procesos a la vez → uno solo gana) y la encola acá. */
  private async reclaim(v: VersionRow): Promise<VersionRow | null> {
    if (this.dead || !this.abandoned(v)) return null;
    if (v.attempts >= APPLY_MAX_ATTEMPTS) {
      await this.failVersion(v.id, v.claim_id, { code: APPLY_ERRORS.INTERRUPTED, message: `La aplicación se interrumpió ${v.attempts} veces (reinicios del servidor): no se reintenta sola. Vuelve a aplicar el plan.`, retryable: true }, { conditionalOnClaim: true });
      return null;
    }
    const claimId = `${this.bootId}.${randomUUID()}`;
    const [r] = returningRows(await this.q(this.dataSource,
      `update public.workshop_versions set status = 'queued', claim_id = $2, updated_at = now()
        where id = $1 and claim_id is not distinct from $3 and status = $4 returning *`,
      [v.id, claimId, v.claim_id, v.status])) as VersionRow[];
    if (!r) return null;
    this.logger.warn(`taller versión ${v.id}: reclamada (arranque anterior ${String(v.claim_id ?? '').split('.')[0] || '—'} sin latido)`);
    this.enqueue(r.id, claimId);
    return r;
  }

  /** Barrido periódico: toma las versiones abandonadas de cualquier sesión (el navegador pudo cerrarse: el arreglo sigue). */
  async sweep(limit = 5): Promise<number> {
    const rows = await this.q<VersionRow[]>(this.dataSource,
      `select * from public.workshop_versions where status in ('queued', 'building', 'verifying') order by updated_at limit 50`);
    let n = 0;
    for (const v of rows) {
      if (n >= limit) break;
      if (await this.reclaim(v)) n++;
    }
    return n;
  }

  /** SOLO pruebas: simula que este proceso murió (deja de latir y de tomar trabajo). */
  simulateDeathForTests(): void {
    this.beating.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.queue.length = 0;
    this.dead = true;
  }

  /**
   * Versión → `failed` (+ plan `failed`) bajo el reclamo dado. Fix round 1 (P2-3): si el paquete ya se había subido
   * (la ruta queda en la fila ANTES de subir) y no hay artifact, el objeto se borra — en CUALQUIER falla, también al
   * agotar los reclamos tras caídas entre la subida y el registro: nunca un objeto huérfano.
   */
  private async failVersion(versionId: string, claimId: string | null, error: { code: string; message: string; retryable: boolean; stage?: string; failedItemId?: string | null }, opts: { conditionalOnClaim?: boolean; diagnosis?: unknown; validation?: unknown } = {}): Promise<boolean> {
    const failed = await this.dataSource.transaction(async (m) => {
      const [v] = await this.q<VersionRow[]>(m, `select * from public.workshop_versions where id = $1 for update`, [versionId]);
      if (!v || v.status === 'ready' || v.status === 'failed') return null;
      if (claimId !== null && v.claim_id !== claimId) return null;
      await this.q(m, `update public.workshop_versions set status = 'failed', claim_id = null, error = $2::jsonb, diagnosis = coalesce($3::jsonb, diagnosis), validation = coalesce($4::jsonb, validation), finished_at = now(), updated_at = now() where id = $1`,
        [versionId, JSON.stringify(error), opts.diagnosis ? JSON.stringify(opts.diagnosis) : null, opts.validation ? JSON.stringify(opts.validation) : null]);
      await this.q(m, `update public.workshop_plans set status = 'failed', updated_at = now() where id = $1 and status = 'applying'`, [v.plan_id]);
      return v;
    });
    if (!failed) return false;
    if (failed.storage_path && !failed.artifact_id) {
      const s = await this.workshop.planSessionById(failed.session_id);
      if (s) {
        try {
          const gone = await this.artifacts.deleteUnreferencedServerObject(s.ownerId, WORKSHOP_BUCKET, failed.storage_path);
          if (gone) this.logger.warn(`taller versión ${versionId}: paquete subido sin registrar borrado (${failed.storage_path})`);
        } catch (err) {
          this.logger.warn(`taller versión ${versionId}: no se pudo borrar el paquete sin registrar ${failed.storage_path} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    return true;
  }

  private async baselineOf(s: WorkshopPlanSession): Promise<{ originalSha1: string; report: DiagnosisReport } | null> {
    const [d] = await this.q<any[]>(this.dataSource, `select id, report from public.workshop_diagnoses where session_id = $1 and original_sha1 = $2 and code_version = $3 and status = 'ready'`, [s.id, s.originalSha1, DIAGNOSIS_CODE_VERSION]);
    if (!d?.report) return null;
    const fs = await this.q<any[]>(this.dataSource, `select finding from public.workshop_findings where diagnosis_id = $1 order by ordinal`, [d.id]);
    return { originalSha1: s.originalSha1 as string, report: { ...(d.report as DiagnosisReport), findings: fs.map((r) => r.finding as Finding) } };
  }

  /** Costo total del arreglo (D9): la IA del plan (interpretar + generar el contenido) + aplicar (Fase 2: USD 0). */
  private async costOf(s: WorkshopPlanSession): Promise<Record<string, unknown>> {
    const [r] = await this.q<any[]>(this.dataSource,
      `select coalesce((select sum(spent_usd) from public.workshop_intakes where session_id = $1 and original_sha1 = $2), 0)::text as intakes,
              coalesce((select sum(r.spent_usd) from public.workshop_requests r join public.workshop_intakes i on i.id = r.intake_id where r.session_id = $1 and i.original_sha1 = $2), 0)::text as requests,
              (select count(*)::int from public.workshop_ai_approvals where session_id = $1) as approvals,
              (select count(*)::int from public.workshop_ai_approvals where session_id = $1 and status = 'ambiguous') as ambiguous`,
      [s.id, s.originalSha1]);
    const plan = (Number(r.intakes) + Number(r.requests)).toFixed(6);
    return {
      currency: 'USD', planAiUsd: plan, applyUsd: '0.000000', totalUsd: plan, approvals: r.approvals, ambiguousApprovals: r.ambiguous,
      note: r.ambiguous > 0
        ? `Incluye solo lo cobrado y registrado; ${r.ambiguous} aprobación(es) quedaron con una llamada de resultado desconocido (su reserva sigue pendiente hasta que un administrador la concilie).`
        : 'IA del plan (interpretar y generar el contenido, con aprobación y tope) + aplicar (la Fase 2 no usa IA: USD 0).',
    };
  }

  /**
   * Corre la versión reclamada (`claimId`). Nunca lanza: termina `ready` (paquete + artifact + versión en UNA
   * transacción) o `failed` con el motivo visible; si el reclamo ya no es suyo, no escribe nada.
   */
  async runVersion(versionId: string, claimId: string): Promise<void> {
    const started = returningRows(await this.q(this.dataSource,
      `update public.workshop_versions set status = 'building', attempts = attempts + 1, updated_at = now() where id = $1 and claim_id = $2 and status = 'queued' returning *`,
      [versionId, claimId])) as VersionRow[];
    const v = started[0];
    if (!v) return;
    if (v.attempts > APPLY_MAX_ATTEMPTS) {
      await this.failVersion(v.id, claimId, { code: APPLY_ERRORS.INTERRUPTED, message: `La aplicación se interrumpió ${v.attempts - 1} veces: no se reintenta sola. Vuelve a aplicar el plan.`, retryable: true });
      return;
    }
    const fail = (e: { code: string; message: string; retryable: boolean; stage?: string; failedItemId?: string | null }, extra: { diagnosis?: unknown; validation?: unknown } = {}) => this.failVersion(v.id, claimId, e, extra);
    try {
      await this.testHook?.('building', v.id);
      const s = await this.workshop.planSessionById(v.session_id);
      if (!s || s.status !== 'identified' || s.originalSha1 !== v.base_sha1) {
        await fail({ stage: 'verify_original', code: WORKSHOP_ERRORS.ORIGINAL_CHANGED, message: 'El original de la sesión ya no es aquel sobre el que se aprobó el plan: no se aplica nada.', retryable: false });
        return;
      }
      let original: { buffer: Buffer; sha1: string; sha256: string };
      try {
        original = await this.workshop.loadVerifiedOriginal(s.id);
      } catch (err) {
        const body = (err as { getResponse?: () => any })?.getResponse?.();
        const code = String(body?.code ?? WORKSHOP_ERRORS.STORAGE_UNAVAILABLE);
        const terminal = code === WORKSHOP_ERRORS.ORIGINAL_CHANGED || code === WORKSHOP_ERRORS.ORIGINAL_MISSING;
        await fail({ stage: 'verify_original', code, message: String(body?.message ?? 'No se pudo leer el original; vuelve a aplicar en unos minutos.'), retryable: !terminal });
        return;
      }
      // B12 (H2): la reserva pasa a lo que el paquete ABIERTO puede ocupar (+ los resultados producidos ya contados).
      try {
        const key = `apply:${v.id}`;
        const base = Math.ceil(Number(s.originalSize ?? 0) * applyMemoryFactor(s.container));
        await this.workshop.reserveForPackage(key, original.buffer, applyMemoryFactor(s.container), Math.max(0, this.workshop.reservedFor(key) - base));
      } catch (err) {
        if (err instanceof MemoryWaitTimeoutError) { await fail({ stage: 'verify_original', code: err.code, message: err.message, retryable: true }); return; }
        if (isMbzReaderError(err)) { await fail({ stage: 'verify_original', code: `WORKSHOP_${err.code.toUpperCase()}`, message: err.message, retryable: false }); return; }
        throw err;
      }
      const items = await this.itemsOf(v.plan_id);
      const byId = new Map(items.map((i) => [i.id, i]));
      const runItems: ApplyRunItem[] = v.item_ids.map((id, idx) => {
        const it = byId.get(id);
        return { id, requestId: it?.requestId ?? '', operation: (v.operations[idx] as PatchOperation).op, quote: it?.quote ?? '', summary: it?.summary ?? '', params: v.operations[idx] };
      });
      // r107 B10: una regeneración aprobada → su RESULTADO producido (artifact del Taller), con dueño, sesión y sha256
      // verificados; el motor lo vuelve a validar antes de insertarlo. Sin resultado (o alterado) → falla visible.
      for (const it of runItems) {
        if (!isPaidOperation((it.params as { op?: string })?.op) && !((it.params as any)?.op === 'edit_libro_section' && (it.params as any)?.libroV3?.result)) continue;
        try {
          it.params = await resolveRegenParams(this.dataSource, this.artifacts, s, it.params);
        } catch (err) {
          await fail({ stage: 'engine', code: 'WORKSHOP_APPLY_REGEN_RESULT', message: `No se pudo cargar el resultado producido de «${it.summary || it.operation}»: ${err instanceof Error ? err.message : String(err)}. No se aplica nada.`, retryable: false, failedItemId: it.id });
          return;
        }
      }
      // Libro v3 (PDF): el markdown aprobado → PDF con el builder existente, solo si reproduce el del original.
      for (const it of runItems) {
        const op = it.params as PatchOperation & { libroV3?: { chapters: Array<{ number: number; md: string }> }; pdf?: unknown };
        if (op.op !== 'edit_libro_section' || !op.libroV3 || op.pdf) continue;
        const src = await this.libroSource.resolve(s);
        const regen = 'unavailable' in src
          ? { ok: false as const, reason: src.unavailable }
          : await regenerateLibroV3Pdf(original.buffer, src, op.libroV3.chapters, (i) => buildDynamicMbzV3(i));
        if (regen.ok !== true) {
          await fail({ stage: 'libro', code: 'WORKSHOP_APPLY_LIBRO_UNAVAILABLE', message: `No se pudo regenerar el Libro Guía en PDF: ${(regen as { reason: string }).reason}`, retryable: false, failedItemId: it.id });
          return;
        }
        it.params = { ...op, libroV3: undefined, pdf: { base64: regen.pdf.toString('base64'), previousSha1: regen.previousSha1 } } as PatchOperation;
      }
      this.runs++;
      const res = await runApply({
        original: original.buffer, expectedSha1: v.base_sha1, filename: s.filename, items: runItems, baseline: await this.baselineOf(s), restoreChecker: this.restoreChecker,
        onStage: async () => {
          await this.testHook?.('verifying', v.id);
          await this.q(this.dataSource, `update public.workshop_versions set status = 'verifying', updated_at = now() where id = $1 and claim_id = $2 and status = 'building'`, [v.id, claimId]);
        },
      });
      original = null as unknown as typeof original;
      if (!res.ok) {
        const f = res as ApplyRunFail;
        await fail({ stage: f.stage, code: f.code, message: f.message, retryable: f.retryable, failedItemId: f.failedItemId }, { diagnosis: f.diagnosis, validation: f.validation });
        return;
      }
      // Paquete nuevo → Storage (ruta determinista en la carpeta del dueño) → artifact + versión `ready` en una transacción.
      const path = versionStoragePath(s.ownerId, s.id, v.number, res.sha1);
      // P2-3: la ruta queda en la fila ANTES de subir: si el proceso muere entre la subida y el registro, quien falle la
      // versión (incluso al agotar los reclamos) sabe qué objeto borrar.
      const marked = returningRows(await this.q(this.dataSource, `update public.workshop_versions set storage_path = $3, updated_at = now() where id = $1 and claim_id = $2 and status = 'verifying' returning id`, [v.id, claimId, path]));
      if (!marked.length) return; // el reclamo ya no es nuestro
      await this.testHook?.('upload', v.id);
      try {
        await this.artifacts.putStorageObject({ ownerId: s.ownerId, storagePath: path, buffer: res.package, mimeType: WORKSHOP_VERSION_MIME, storageBucket: WORKSHOP_BUCKET, upsert: true });
      } catch (err) {
        this.logger.warn(`taller versión ${v.id}: no se pudo subir el paquete (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
        await fail({ stage: 'upload', code: APPLY_ERRORS.UPLOAD_FAILED, message: 'No se pudo guardar el paquete nuevo en el almacenamiento; vuelve a aplicar en unos minutos.', retryable: true }, { diagnosis: res.diagnosis, validation: res.validation });
        return; // failVersion borra lo que haya llegado a subirse
      }
      const cost = await this.costOf(s);
      const filename = `${(s.filename ?? 'curso.mbz').replace(/\.mbz$/i, '')}-v${v.number}.mbz`;
      let registered = false;
      try {
        await this.testHook?.('register', v.id);
        registered = await this.dataSource.transaction(async (m) => {
          const [still] = await this.q<any[]>(m, `select 1 as ok from public.workshop_versions where id = $1 and claim_id = $2 and status = 'verifying' for update`, [v.id, claimId]);
          if (!still) return false;
          const [a] = await this.q<any[]>(m,
            `insert into public.artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, size_bytes, checksum_sha256, metadata)
             values ($1, null, 'workshop_version', 'supabase', $2, $3, $4, $5, $6, $7, $8::jsonb) returning id::text as id`,
            [s.ownerId, WORKSHOP_BUCKET, path, filename, WORKSHOP_VERSION_MIME, res.size, res.sha256,
              JSON.stringify({ workshopSessionId: s.id, workshopVersionId: v.id, number: v.number, sha1: res.sha1, container: res.container, parentVersionId: v.parent_version_id, baseSha1: v.base_sha1, applyCodeVersion: APPLY_CODE_VERSION })]);
          const report = { ...(v.report ?? {}), applyCodeVersion: APPLY_CODE_VERSION, items: res.items, preservedEntries: res.preservedEntries, filename };
          await this.q(m,
            `update public.workshop_versions set status = 'ready', claim_id = null, artifact_id = $2, storage_path = $3, sha1 = $4, sha256 = $5, size_bytes = $6, container = $7,
                    report = $8::jsonb, diagnosis = $9::jsonb, validation = $10::jsonb, restore_check = $11, restore_check_message = $12, cost = $13::jsonb, error = null,
                    finished_at = now(), updated_at = now() where id = $1`,
            [v.id, a.id, path, res.sha1, res.sha256, res.size, res.container, JSON.stringify(report), JSON.stringify(res.diagnosis), JSON.stringify(res.validation),
              res.restoreCheck.status, res.restoreCheck.message, JSON.stringify({ ...cost, restoreChecker: res.restoreCheck.checker })]);
          await this.q(m, `update public.workshop_plans set status = 'applied', applied_version_id = $2, updated_at = now() where id = $1`, [v.plan_id, v.id]);
          return true;
        });
      } catch (err) {
        this.logger.error(`taller versión ${v.id}: no se pudo registrar la versión: ${err instanceof Error ? err.message : String(err)}`);
        await fail({ stage: 'register', code: APPLY_ERRORS.FAILED, message: 'No se pudo registrar la versión nueva; vuelve a aplicar.', retryable: true }, { diagnosis: res.diagnosis, validation: res.validation });
        return; // failVersion borró el paquete subido
      }
      if (!registered) await this.cleanupOrphan(s.ownerId, path, v.id, claimId);
    } catch (err) {
      this.logger.error(`taller versión ${v.id}: falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      await fail({ stage: 'engine', code: APPLY_ERRORS.FAILED, message: 'No se pudo aplicar el plan (falla interna); vuelve a intentarlo. Si se repite, avísanos.', retryable: true });
    }
  }

  /**
   * Nunca un objeto huérfano: si el paquete se subió pero la versión no quedó registrada por ESTE reclamo (y nadie más
   * lo tomó), se borra. Si otro proceso reclamó la versión, la ruta es la suya también (determinista): no se toca.
   */
  private async cleanupOrphan(ownerId: string, path: string, versionId: string, claimId: string): Promise<void> {
    const [v] = await this.q<VersionRow[]>(this.dataSource, `select status, claim_id from public.workshop_versions where id = $1`, [versionId]);
    if (v && v.status !== 'failed' && v.claim_id !== null && v.claim_id !== claimId) return;
    try {
      await this.artifacts.deleteUnreferencedServerObject(ownerId, WORKSHOP_BUCKET, path);
    } catch (err) {
      this.logger.warn(`taller versión ${versionId}: no se pudo borrar el paquete huérfano ${path} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // ── versiones ──

  private async versionById(id: string): Promise<VersionRow | null> {
    const [v] = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where id = $1`, [id]);
    return v ?? null;
  }
  private async versionOfPlan(planId: string): Promise<VersionRow | null> {
    const [v] = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where plan_id = $1`, [planId]);
    return v ?? null;
  }
  private async versionOfSession(s: WorkshopPlanSession, versionId: string): Promise<VersionRow> {
    if (!isUuid(versionId)) throw new NotFoundException({ code: APPLY_ERRORS.VERSION_NOT_FOUND, message: 'Versión no encontrada.' });
    const [v] = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where id = $1 and session_id = $2`, [versionId.toLowerCase(), s.id]);
    if (!v) throw new NotFoundException({ code: APPLY_ERRORS.VERSION_NOT_FOUND, message: 'Versión no encontrada.' });
    return v;
  }

  versionView(v: VersionRow, s: Pick<WorkshopPlanSession, 'id'>, opts: { full?: boolean } = {}) {
    const restore = v.restore_check
      ? { status: v.restore_check, message: v.restore_check_message ?? (v.restore_check === 'not_available' ? RESTORE_NOT_AVAILABLE_MESSAGE : '') }
      : null;
    return {
      id: v.id, sessionId: s.id, planId: v.plan_id, number: v.number, status: v.status,
      parent: v.parent_version_id ? { kind: 'version' as const, versionId: v.parent_version_id } : { kind: 'original' as const, versionId: null },
      baseSha1: v.base_sha1, itemIds: v.item_ids ?? [], confirmedItemIds: v.confirmed_item_ids ?? [], attempts: Number(v.attempts ?? 0),
      artifactId: v.artifact_id, sha1: v.sha1, sha256: v.sha256, sizeBytes: v.size_bytes === null ? null : Number(v.size_bytes), container: v.container,
      restoreCheck: restore, cost: v.cost ?? null,
      error: v.error && typeof v.error === 'object' ? { code: String(v.error.code), message: String(v.error.message), retryable: v.error.retryable === true, stage: v.error.stage ?? null, failedItemId: v.error.failedItemId ?? null } : null,
      ...(opts.full ? { report: v.report ?? null, diagnosis: v.diagnosis ?? null, validation: v.validation ?? null } : { summary: this.reportSummary(v) }),
      createdAt: iso(v.created_at), updatedAt: iso(v.updated_at), finishedAt: iso(v.finished_at),
    };
  }

  private reportSummary(v: VersionRow) {
    const items = Array.isArray(v.report?.items) ? v.report.items : [];
    return { items: items.map((i: any) => ({ itemId: i.itemId, operation: i.operation, summary: i.summary })), resolved: v.diagnosis?.resolved?.length ?? 0, introduced: v.diagnosis?.introduced?.length ?? 0 };
  }

  /** GET …/sessions/:id/versions — versiones de la sesión + la cadena desde el original. Reclama las abandonadas. */
  async listVersions(actor: WorkshopActor, sessionId: string) {
    const s = await this.workshop.sessionForActor(actor, sessionId, 'courses.view');
    const rows = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where session_id = $1 order by created_at, id`, [s.id]);
    for (const v of rows) if (this.abandoned(v)) await this.reclaim(v);
    const fresh = await this.q<VersionRow[]>(this.dataSource, `select * from public.workshop_versions where session_id = $1 order by created_at, id`, [s.id]);
    const parentVersionId = await this.workshop.parentVersionOf(s.id);
    // Cadena: desde la versión de origen de esta sesión hacia atrás (cada eslabón es de su propia sesión).
    const links = new Map<string, { versionId: string; sessionId: string; number: number; parentVersionId: string | null }>();
    let cur = parentVersionId;
    while (cur && !links.has(cur)) {
      const p = await this.versionById(cur);
      if (!p) break;
      links.set(p.id, { versionId: p.id, sessionId: p.session_id, number: p.number, parentVersionId: p.parent_version_id });
      cur = p.parent_version_id;
    }
    const leaf = parentVersionId ? links.get(parentVersionId) ?? null : null;
    const chain = chainOf(leaf, links);
    const own = fresh.find((v) => v.status === 'ready') ?? null;
    return {
      sessionId: s.id, parentVersionId,
      chain: [
        { kind: 'original' as const, label: 'Original', sessionId: chain[0]?.sessionId ?? s.id, versionId: null, number: 0 },
        ...chain.map((c) => ({ kind: 'version' as const, label: `Arreglo ${c.number}`, sessionId: c.sessionId, versionId: c.versionId, number: c.number })),
        ...(own ? [{ kind: 'version' as const, label: `Arreglo ${own.number}`, sessionId: s.id, versionId: own.id, number: own.number }] : []),
      ],
      versions: fresh.map((v) => this.versionView(v, s)),
    };
  }

  /** GET …/sessions/:id/versions/:versionId — la versión con su informe completo (antes/después por ítem). */
  async getVersion(actor: WorkshopActor, sessionId: string, versionId: string) {
    const s = await this.workshop.sessionForActor(actor, sessionId, 'courses.view');
    let v = await this.versionOfSession(s, versionId);
    if (this.abandoned(v)) v = (await this.reclaim(v)) ?? (await this.versionOfSession(s, versionId));
    return this.versionView(v, s, { full: true });
  }

  /**
   * GET …/sessions/:id/versions/:versionId/download — URL firmada de corta duración (5 min) del paquete de una versión
   * lista, solo para quien ve la sesión. Antes de firmar se confirma que el objeto siga teniendo el tamaño registrado.
   */
  async downloadVersion(actor: WorkshopActor, sessionId: string, versionId: string) {
    const s = await this.workshop.sessionForActor(actor, sessionId, 'courses.view');
    const v = await this.versionOfSession(s, versionId);
    if (v.status !== 'ready' || !v.artifact_id || !v.storage_path) throw new ConflictException({ code: APPLY_ERRORS.VERSION_NOT_READY, message: 'Esta versión todavía no está lista para descargar.', status: v.status });
    const bytes = await this.artifacts.headStorageObjectBytes(WORKSHOP_BUCKET, v.storage_path);
    if (bytes === null || bytes !== Number(v.size_bytes)) {
      throw new ConflictException({ code: APPLY_ERRORS.VERSION_CHANGED, message: 'El paquete de esta versión ya no está (o cambió) en el almacenamiento: no se entrega. Avísanos.' });
    }
    const url = await this.artifacts.getDownloadUrl(v.artifact_id, s.ownerId, VERSION_DOWNLOAD_SECONDS, { workshopRoute: true });
    return { versionId: v.id, number: v.number, filename: v.report?.filename ?? null, sizeBytes: Number(v.size_bytes), sha256: v.sha256, expiresInSeconds: VERSION_DOWNLOAD_SECONDS, ...url };
  }

  /** POST …/sessions/:id/versions/:versionId/session — sesión HIJA cuyo original es esta versión (202; idempotente). */
  async openChildSession(actor: WorkshopActor, sessionId: string, versionId: string) {
    const s = await this.workshop.sessionForActor(actor, sessionId, 'courses.edit');
    const v = await this.versionOfSession(s, versionId);
    if (v.status !== 'ready' || !v.storage_path || !v.sha1 || !v.sha256 || v.size_bytes === null) {
      throw new ConflictException({ code: APPLY_ERRORS.VERSION_NOT_READY, message: 'Solo se puede seguir arreglando desde una versión lista.', status: v.status });
    }
    const out = await this.workshop.openChildSession(actor, {
      parentSessionId: s.id, ownerId: s.ownerId, institutionId: s.institutionId, versionId: v.id, versionNumber: v.number, storagePath: v.storage_path,
      filename: v.report?.filename ?? `version-${v.number}.mbz`, sha1: v.sha1, sha256: v.sha256, size: Number(v.size_bytes), inheritCourseId: s.identifiedCourseId,
    });
    return { ...out, fromVersion: { id: v.id, number: v.number, sessionId: s.id } };
  }
}

function isCourseWorkshopEnabledSafe(): boolean {
  try {
    return isCourseWorkshopEnabled();
  } catch {
    return false;
  }
}
