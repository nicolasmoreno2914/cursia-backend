import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { returningRows } from '../../../common/db/returning-rows';
import { isCourseWorkshopEnabled } from '../../features/course-workshop-flag';
import { isUuid } from '../../authz/schema-probe';
import { CourseWorkshopService, MemoryWaitTimeoutError, WORKSHOP_ERRORS, WorkshopActor, WorkshopPlanSession, diagnosisMemoryFactor } from '../course-workshop.service';
import { openMbz } from '../mbz-reader';
import { builderLineOf, familyOf, readPackageFacts } from '../identify';
import { buildDiagnosisContext, DiagnosisContext } from '../diagnosis/context';
import { DIAGNOSIS_CODE_VERSION } from '../diagnosis/diagnose';
import { AiUnavailableError, PlannedCall, plannedCallOf } from '../plan/builder';
import type { WorkshopPricing } from '../plan/cost';
import { ApprovalEstimate, PLAN_ERRORS, WorkshopPlanService } from '../plan/workshop-plan.service';
import type { ChapterPacket } from './ai-review';
import { chapterPacket } from './ai-review';
import { AskAnswer, AskEvidence, noEvidenceAnswer, retrieveEvidence } from './ask';
import { qualityDocs } from './docs';
import { answerQuestion, askCall, precheckFindings, prepareQuality, qualityLights, reviewChapter, sortQuality } from './run';
import { NO_EVIDENCE_MESSAGE, QUALITY_CHECK_IDS, QUALITY_CHECK_TITLES, QUALITY_CODE_VERSION, QUALITY_ERRORS, QUALITY_LIMITS, QUALITY_SCHEMA, QualityCheckId, QualityFinding } from './types';

/**
 * r107 B8 · Taller de cursos — diagnóstico de CALIDAD (Q01–Q05) y PREGUNTAS PUNTUALES (diseño §5 «Calidad», D8/D9).
 *
 *   `POST …/sessions/:id/quality` sin confirmación → la parte DETERMINISTA (gratis) corre como trabajo y deja, por
 *   capítulo, la evidencia y la llamada exacta con su estimado. Con `{ chapters, confirmEstimateUsd, capUsd }` → se
 *   APRUEBA revisar con IA ese alcance con las MISMAS aprobaciones de B5 (estimado confirmado, tope ≥ estimado y ≥ cota de
 *   una llamada, reserva del tope en FinOps, guarda del tope antes de cada llamada, llamadas sent → charged / not_charged /
 *   ambiguous / not_sent, liberación solo si nada quedó dudoso). Sin aprobación: CERO llamadas.
 *   `POST …/sessions/:id/questions { text }` → la evidencia se recupera SIN IA y queda el estimado; `{ questionId,
 *   confirmEstimateUsd, capUsd }` → se aprueba responderla (misma aprobación). La respuesta cita la evidencia y el
 *   servidor verifica cada cita; sin citas válidas: «No encontré evidencia suficiente en el curso para responder».
 *
 * Trabajos en el proceso de la API (como B3 / B5 / B6): carril de 1, en el presupuesto de memoria COMPARTIDO y FIFO del
 * Taller (`withMemory`), reclamo `<arranque>.<uuid>` + latido cada 10 s; una fila de otro arranque que deja de latir 30 s
 * se da por interrumpida (barrido cada 15 s y al leer) y su aprobación se cierra por el camino de B5.
 *
 * Compuertas de B1 (flag + `planSessionFor`: ajeno → 404, SuperAdmin, miembro con permiso en enforce): pedir / aprobar =
 * `courses.edit`; ver = `courses.view`. Todo sale de los textos del original verificado de ESTA sesión.
 */

export const QUALITY_HEARTBEAT_MS = 10_000;
export const QUALITY_HEARTBEAT_STALE_MS = 3 * QUALITY_HEARTBEAT_MS;
export const QUALITY_STALE_MS = 15 * 60_000;
export const QUALITY_SWEEP_MS = 15_000;

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };
const iso = (d: Date | string | null | undefined) => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const usd = (v: unknown) => (v === null || v === undefined ? '0' : String(v));

export type ChapterAiStatus = 'not_applicable' | 'not_reviewed' | 'queued' | 'reviewing' | 'reviewed' | 'failed' | 'stopped';
interface ChapterState { status: ChapterAiStatus; approvalId: string | null; spentUsd: string; aiCalls: number; accepted: number; rejected: number; reason: string | null; reviewedAt: string | null }
interface RunRow { id: string; session_id: string; original_sha1: string; code_version: string; created_by: string; diagnosis_id: string | null; status: 'queued' | 'running' | 'ready' | 'failed'; claim_id: string | null; report: any; packets: ChapterPacket[] | null; calls: Array<{ chapterNumber: number; call: PlannedCall | null; promptChars: number; reason: string | null }> | null; chapters: Record<string, ChapterState>; ai_claim_id: string | null; error: any; started_at: Date; finished_at: Date | null; created_at: Date; updated_at: Date }
interface QuestionRow { id: string; session_id: string; original_sha1: string; code_version: string; created_by: string; question: string; status: 'retrieving' | 'awaiting_confirmation' | 'answering' | 'answered' | 'failed'; evidence: (AskEvidence & { courseTitle: string | null }) | null; estimate: ApprovalEstimate | null; approval_id: string | null; answer: AskAnswer | null; error: any; spent_usd: string; ai_calls: number; claim_id: string | null; created_at: Date; updated_at: Date }

type Job =
  | { kind: 'prepare'; runId: string }
  | { kind: 'review'; runId: string; approvalId: string; chapters: number[] }
  | { kind: 'retrieve'; questionId: string }
  | { kind: 'answer'; questionId: string; approvalId: string };

const REVIEWABLE: ReadonlySet<ChapterAiStatus> = new Set(['not_reviewed', 'failed', 'stopped']);
const IN_FLIGHT: ReadonlySet<ChapterAiStatus> = new Set(['queued', 'reviewing']);

@Injectable()
export class WorkshopQualityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkshopQualityService.name);
  /** Trabajos de este proceso (las pruebas los esperan). */
  readonly inFlight = new Map<string, Promise<void>>();
  private readonly queue: Array<{ job: Job; claimId: string; done: () => void }> = [];
  private laneBusy = false;
  private dead = false;
  /** Filas con trabajo en cola o corriendo en ESTE proceso (no se dan por interrumpidas). */
  private readonly activeIds = new Set<string>();
  private readonly beating = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** SOLO pruebas: reemplaza la lectura del contexto (p. ej. para medir memoria). */
  contextBuilder: (buf: Buffer) => Promise<{ ctx: DiagnosisContext; pkg: Awaited<ReturnType<typeof openMbz>> }> = async (buf) => {
    const pkg = await openMbz(buf);
    const facts = await readPackageFacts(pkg, null);
    const ctx = await buildDiagnosisContext({ pkg, packageBytes: buf, family: familyOf(facts), builderLine: builderLineOf(facts), builderVersion: null });
    return { ctx, pkg };
  };

  constructor(private readonly dataSource: DataSource, private readonly workshop: CourseWorkshopService, private readonly plan: WorkshopPlanService) {}

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

  // ── cola, carril, reclamo y latido ──

  private enqueue(job: Job, claimId: string): void {
    const id = 'runId' in job ? job.runId : job.questionId;
    const key = `${job.kind}:${id}:${randomUUID()}`;
    this.activeIds.add(id);
    this.beat(claimId, true);
    let done!: () => void;
    const p = new Promise<void>((r) => { done = r; }).finally(() => { this.inFlight.delete(key); this.activeIds.delete(id); this.beat(claimId, false); });
    this.inFlight.set(key, p);
    this.queue.push({ job, claimId, done });
    this.pump();
  }

  private pump(): void {
    if (this.laneBusy || this.dead) return;
    const next = this.queue.shift();
    if (!next) return;
    this.laneBusy = true;
    this.runJob(next.job, next.claimId)
      .catch((err) => this.logger.error(`taller calidad: trabajo ${next.job.kind} terminó con error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => { this.laneBusy = false; next.done(); this.pump(); });
  }

  private beat(claimId: string, on: boolean): void {
    if (on) this.beating.add(claimId); else this.beating.delete(claimId);
    if (this.beating.size && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, QUALITY_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    } else if (!this.beating.size && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Latido: refresca las filas en curso que este proceso tiene reclamadas (diagnóstico, revisión con IA, preguntas). */
  async heartbeat(): Promise<void> {
    if (!this.beating.size) return;
    const claims = [...this.beating];
    try {
      await this.q(this.dataSource, `update public.workshop_quality_runs set updated_at = now() where (claim_id = any($1::text[]) and status in ('queued', 'running')) or ai_claim_id = any($1::text[])`, [claims]);
      await this.q(this.dataSource, `update public.workshop_questions set updated_at = now() where claim_id = any($1::text[]) and status in ('retrieving', 'answering')`, [claims]);
    } catch (err) {
      this.logger.warn(`taller calidad: latido falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** SOLO pruebas: simula que este proceso murió (deja de latir y de tomar trabajo). */
  simulateDeathForTests(): void {
    this.beating.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.queue.length = 0;
    this.dead = true;
  }

  private claimOf(): string {
    return `${this.workshop.bootId}.${randomUUID()}`;
  }

  /** ¿Abandonada? Otro arranque sin latir 30 s; este arranque y nadie la tiene; sin reclamo y 15 min. */
  private abandoned(claim: string | null, updatedAt: Date | string, id: string, now = Date.now()): boolean {
    if (this.activeIds.has(id)) return false;
    const age = now - new Date(updatedAt).getTime();
    if (!claim) return age > QUALITY_STALE_MS;
    if (claim.split('.')[0] === this.workshop.bootId) return !this.beating.has(claim);
    return age > QUALITY_HEARTBEAT_STALE_MS;
  }

  /**
   * Lo que quedó colgado de un proceso muerto → fallido reintentable, visible. Las revisiones con IA en curso: el capítulo
   * queda `failed` con el motivo y la aprobación se cierra por el camino de B5 (ambigua si una llamada pudo cobrarse).
   */
  async expireStale(sessionId: string | null): Promise<void> {
    const runs = await this.q<RunRow[]>(this.dataSource, `select id, status, claim_id, ai_claim_id, chapters, updated_at from public.workshop_quality_runs where ($1::uuid is null or session_id = $1::uuid)
        and (status in ('queued', 'running') or chapters::text ~ '"status": ?"(queued|reviewing)"')`, [sessionId]);
    for (const r of runs) {
      if ((r.status === 'queued' || r.status === 'running') && this.abandoned(r.claim_id, r.updated_at, r.id)) {
        await this.q(this.dataSource, `update public.workshop_quality_runs set status = 'failed', claim_id = null, error = $3::jsonb, updated_at = now() where id = $1 and claim_id is not distinct from $2 and status in ('queued', 'running')`,
          [r.id, r.claim_id, JSON.stringify({ code: QUALITY_ERRORS.INTERRUPTED, message: 'El diagnóstico de calidad se interrumpió (reinicio del servidor); vuelve a pedirlo.', retryable: true })]);
      }
      const live = Object.entries(r.chapters ?? {}).filter(([, c]) => IN_FLIGHT.has(c.status));
      if (live.length && this.abandoned(r.ai_claim_id, r.updated_at, `ai:${r.id}`)) {
        const approvals = new Set<string>();
        await this.updateChapters(r.id, r.ai_claim_id, (ch) => {
          for (const [n, c] of Object.entries(ch)) if (IN_FLIGHT.has(c.status)) { if (c.approvalId) approvals.add(c.approvalId); ch[n] = { ...c, status: 'failed', reason: 'La revisión se interrumpió (reinicio del servidor); vuelve a aprobarla.' }; }
          return true;
        }, true);
        for (const a of approvals) await this.plan.closeApproval(a, 'failed', 'Se interrumpió (reinicio del servidor).');
      }
    }
    const qs = await this.q<QuestionRow[]>(this.dataSource, `select id, status, claim_id, approval_id, updated_at from public.workshop_questions where ($1::uuid is null or session_id = $1::uuid) and status in ('retrieving', 'answering')`, [sessionId]);
    for (const x of qs) {
      if (!this.abandoned(x.claim_id, x.updated_at, x.id)) continue;
      const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_questions set status = 'failed', claim_id = null, error = $3::jsonb, updated_at = now() where id = $1 and claim_id is not distinct from $2 and status in ('retrieving', 'answering') returning approval_id`,
        [x.id, x.claim_id, JSON.stringify({ code: QUALITY_ERRORS.INTERRUPTED, message: 'La pregunta se interrumpió (reinicio del servidor); vuelve a hacerla.', retryable: true })])) as any[];
      if (r?.approval_id && x.status === 'answering') await this.plan.closeApproval(r.approval_id, 'failed', 'Se interrumpió (reinicio del servidor).');
    }
  }

  async sweep(): Promise<void> {
    if (this.dead) return;
    await this.expireStale(null);
  }

  onModuleInit(): void {
    let on = false;
    try { on = isCourseWorkshopEnabled(); } catch { on = false; }
    if (!on) return;
    this.sweepTimer = setInterval(() => { void this.sweep().catch((e) => this.logger.warn(`taller calidad: barrido falló: ${e instanceof Error ? e.message : String(e)}`)); }, QUALITY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sweepTimer = null;
    this.heartbeatTimer = null;
  }

  /** Cambia el mapa de capítulos de un run con lock (`expectClaim`: solo si el reclamo de la IA sigue siendo ese). */
  private async updateChapters(runId: string, expectClaim: string | null, fn: (ch: Record<string, ChapterState>) => boolean, clearClaim = false): Promise<Record<string, ChapterState> | null> {
    return this.dataSource.transaction(async (m) => {
      const [r] = await this.q<RunRow[]>(m, `select chapters, ai_claim_id from public.workshop_quality_runs where id = $1 for update`, [runId]);
      if (!r || (expectClaim !== undefined && r.ai_claim_id !== expectClaim && expectClaim !== null)) return null;
      const ch = JSON.parse(JSON.stringify(r.chapters ?? {})) as Record<string, ChapterState>;
      if (!fn(ch)) return null;
      await this.q(m, `update public.workshop_quality_runs set chapters = $2::jsonb, ai_claim_id = case when $3::boolean then null else ai_claim_id end, updated_at = now() where id = $1`, [runId, JSON.stringify(ch), clearClaim]);
      return ch;
    });
  }

  // ── API: diagnóstico de calidad ──

  private async diagnosisReady(s: WorkshopPlanSession): Promise<string> {
    const [d] = await this.q<any[]>(this.dataSource, `select id, status from public.workshop_diagnoses where session_id = $1 and original_sha1 = $2 and code_version = $3`, [s.id, s.originalSha1, DIAGNOSIS_CODE_VERSION]);
    if (!d || d.status !== 'ready') throw new ConflictException({ code: QUALITY_ERRORS.DIAGNOSIS_NOT_READY, message: 'Primero hay que correr el diagnóstico técnico del paquete (y esperar a que termine): la calidad se revisa sobre él.' });
    return d.id;
  }

  private async runOf(s: WorkshopPlanSession): Promise<RunRow | null> {
    const [r] = await this.q<RunRow[]>(this.dataSource, `select * from public.workshop_quality_runs where session_id = $1 and original_sha1 = $2 and code_version = $3`, [s.id, s.originalSha1, QUALITY_CODE_VERSION]);
    return r ?? null;
  }

  /**
   * POST …/quality. Sin confirmación: arranca (o devuelve, idempotente) el diagnóstico de calidad — su parte determinista
   * gratis + el estimado por capítulo. Con `confirmEstimateUsd` + `capUsd`: aprueba revisar con IA `chapters` ('all' o
   * los números elegidos) y recién entonces se llama a la IA.
   */
  async startQuality(actor: WorkshopActor, sessionId: string, body: { chapters?: unknown; confirmEstimateUsd?: unknown; capUsd?: unknown } = {}) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    const diagnosisId = await this.diagnosisReady(s);
    await this.expireStale(s.id);
    const confirming = body.confirmEstimateUsd !== undefined || body.capUsd !== undefined;
    let run = await this.runOf(s);
    if (!run || (run.status === 'failed' && run.error?.retryable === true)) {
      if (confirming) throw new ConflictException({ code: QUALITY_ERRORS.NOT_READY, message: 'El diagnóstico de calidad todavía se está preparando: espera su estimado y vuelve a aprobarlo.', status: run?.status ?? 'queued' });
      const claimId = this.claimOf();
      const [r] = returningRows(await this.q(this.dataSource,
        `insert into public.workshop_quality_runs (session_id, original_sha1, code_version, created_by, diagnosis_id, status, claim_id)
              values ($1, $2, $3, $4, $5, 'queued', $6)
         on conflict (session_id, original_sha1, code_version) do update set status = 'queued', claim_id = excluded.claim_id, created_by = excluded.created_by, diagnosis_id = excluded.diagnosis_id,
              error = null, report = null, packets = null, calls = null, chapters = '{}'::jsonb, started_at = now(), finished_at = null, updated_at = now()
           where workshop_quality_runs.status = 'failed' and (workshop_quality_runs.error->>'retryable') = 'true'
         returning *`, [s.id, s.originalSha1, QUALITY_CODE_VERSION, actor.id, diagnosisId, claimId])) as RunRow[];
      if (r) this.enqueue({ kind: 'prepare', runId: r.id }, claimId);
      run = r ?? (await this.runOf(s));
      return this.qualityView(s, run);
    }
    if (!confirming) return this.qualityView(s, run);
    if (run.status !== 'ready') throw new ConflictException({ code: QUALITY_ERRORS.NOT_READY, message: run.status === 'failed' ? 'El diagnóstico de calidad falló: revisa el motivo.' : 'El diagnóstico de calidad todavía se está preparando: espera su estimado y vuelve a aprobarlo.', status: run.status });
    if (Object.values(run.chapters ?? {}).some((c) => IN_FLIGHT.has(c.status))) throw new ConflictException({ code: QUALITY_ERRORS.BUSY, message: 'Ya hay una revisión con IA en curso para este curso: espera a que termine.' });
    const chapters = this.selectChapters(run, body.chapters);
    const calls = chapters.map((n) => run!.calls!.find((c) => c.chapterNumber === n)!.call as PlannedCall);
    const estimate = this.plan.estimateOf(calls, `Revisar con IA la calidad de ${chapters.length} capítulo(s) (1 llamada por capítulo; un reintento por forma entra en el margen). La IA no corre hasta que lo apruebes.`);
    const cap = this.plan.validateConfirmation(estimate, { confirmEstimateUsd: body.confirmEstimateUsd, capUsd: body.capUsd });
    const approval = await this.plan.openApproval(s, actor, { kind: 'quality', estimate, capUsd: cap });
    const claimId = this.claimOf();
    const ok = await this.dataSource.transaction(async (m) => {
      const [r] = await this.q<RunRow[]>(m, `select chapters, status from public.workshop_quality_runs where id = $1 for update`, [run!.id]);
      const ch = r.chapters ?? {};
      if (r.status !== 'ready' || Object.values(ch).some((c) => IN_FLIGHT.has(c.status)) || chapters.some((n) => !REVIEWABLE.has(ch[String(n)]?.status))) return false;
      for (const n of chapters) ch[String(n)] = { ...ch[String(n)], status: 'queued', approvalId: approval.id, reason: null };
      await this.q(m, `update public.workshop_quality_runs set chapters = $2::jsonb, ai_claim_id = $3, updated_at = now() where id = $1`, [run!.id, JSON.stringify(ch), claimId]);
      return true;
    });
    if (!ok) {
      await this.plan.closeApproval(approval.id, 'failed', 'El alcance cambió mientras se aprobaba.');
      throw new ConflictException({ code: QUALITY_ERRORS.BUSY, message: 'Algún capítulo elegido ya se está revisando: vuelve a intentarlo.' });
    }
    await this.plan.holdApproval(approval.id, claimId);
    this.activeIds.add(`ai:${run.id}`);
    this.enqueue({ kind: 'review', runId: run.id, approvalId: approval.id, chapters }, claimId);
    return { ...(await this.qualityView(s, await this.runOf(s))), approval: this.plan.approvalView(approval as any) };
  }

  /** Alcance pedido → capítulos a revisar (validados contra lo que se puede revisar). */
  private selectChapters(run: RunRow, raw: unknown): number[] {
    const reviewable = (run.calls ?? []).filter((c) => c.call && REVIEWABLE.has(run.chapters?.[String(c.chapterNumber)]?.status)).map((c) => c.chapterNumber);
    if (raw === undefined || raw === null || raw === 'all') {
      if (!reviewable.length) throw new ConflictException({ code: QUALITY_ERRORS.NOTHING_TO_REVIEW, message: 'No queda ningún capítulo por revisar con IA.' });
      return reviewable;
    }
    if (!Array.isArray(raw) || !raw.length || raw.length > 500 || !raw.every((n) => Number.isInteger(n))) throw new BadRequestException({ code: QUALITY_ERRORS.CHAPTERS_INVALID, message: 'Elige «todo el curso» o los números de capítulo a revisar.' });
    const uniq = [...new Set(raw as number[])];
    const invalid = uniq.filter((n) => !reviewable.includes(n));
    if (invalid.length || uniq.length !== raw.length) throw new BadRequestException({ code: QUALITY_ERRORS.CHAPTERS_INVALID, message: `Estos capítulos no se pueden revisar ahora (no existen, no tienen texto o ya se revisaron): ${invalid.join(', ') || 'repetidos'}.`, invalidChapters: invalid });
    return (run.calls ?? []).map((c) => c.chapterNumber).filter((n) => uniq.includes(n));
  }

  async getQuality(actor: WorkshopActor, sessionId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.view');
    await this.expireStale(s.id);
    return this.qualityView(s, await this.runOf(s));
  }

  private async qualityView(s: WorkshopPlanSession, run: RunRow | null) {
    const base = { sessionId: s.id, codeVersion: QUALITY_CODE_VERSION, originalSha1: s.originalSha1 };
    if (!run) return { ...base, status: 'not_started' as const, runId: null, diagnosisId: null, startedAt: null, finishedAt: null, error: null, checks: [], light: null, findings: [], ai: null, approvals: [] };
    const error = run.error && typeof run.error === 'object' ? { code: String(run.error.code), message: String(run.error.message), retryable: run.error.retryable === true } : null;
    if (run.status !== 'ready') return { ...base, status: run.status, runId: run.id, diagnosisId: run.diagnosis_id, startedAt: iso(run.started_at), finishedAt: iso(run.finished_at), error, checks: [], light: null, findings: [], ai: null, approvals: [] };
    const inv = await this.workshop.persistedInventory(s.id);
    const rows = await this.q<any[]>(this.dataSource, `select finding from public.workshop_quality_findings where run_id = $1 order by ordinal`, [run.id]);
    const findings = inv ? sortQuality(rows.map((r) => r.finding as QualityFinding), inv) : rows.map((r) => r.finding as QualityFinding);
    const chapters = (run.calls ?? []).map((c) => {
      const st = run.chapters?.[String(c.chapterNumber)] ?? null;
      const p = (run.packets ?? []).find((x) => x.chapterNumber === c.chapterNumber);
      return {
        number: c.chapterNumber, title: p?.chapterTitle ?? inv?.chapters.find((x) => x.number === c.chapterNumber)?.title ?? null,
        status: st?.status ?? 'not_applicable', reason: st?.reason ?? c.reason,
        estimate: c.call ? { expectedUsd: c.call.expectedUsd, boundUsd: c.call.boundUsd, promptChars: c.promptChars, maxTokens: c.call.maxTokens, model: c.call.model } : null,
        evidence: p ? { blocks: p.docs.length, truncated: p.truncated, omittedBlocks: p.omittedDocs } : null,
        approvalId: st?.approvalId ?? null, spentUsd: st?.spentUsd ?? '0', aiCalls: st?.aiCalls ?? 0, accepted: st?.accepted ?? 0, rejected: st?.rejected ?? 0, reviewedAt: st?.reviewedAt ?? null,
      };
    });
    const reviewableCalls = chapters.filter((c) => REVIEWABLE.has(c.status as ChapterAiStatus) && c.estimate).map((c) => (run.calls ?? []).find((x) => x.chapterNumber === c.number)!.call as PlannedCall);
    const all = reviewableCalls.length ? { chapters: chapters.filter((c) => REVIEWABLE.has(c.status as ChapterAiStatus) && c.estimate).map((c) => c.number), ...this.plan.estimateOf(reviewableCalls, `Revisar con IA los ${reviewableCalls.length} capítulo(s) que faltan (1 llamada por capítulo). La IA no corre hasta que lo apruebes.`) } : null;
    const aiDone = (ok: (x: (typeof chapters)[number]) => boolean) => chapters.filter((c) => c.status !== 'not_applicable').every(ok);
    const aiStatus = chapters.every((c) => c.status === 'not_applicable') ? 'not_applicable' : aiDone((c) => c.status === 'reviewed') ? 'done' : chapters.some((c) => c.status === 'reviewed') ? 'partial' : 'pending';
    const approvals = await this.q<any[]>(this.dataSource, `select * from public.workshop_ai_approvals where session_id = $1 and kind = 'quality' order by created_at`, [s.id]);
    const detChecks: Array<{ check: QualityCheckId; status: string; reason: string | null }> = run.report?.checks ?? [];
    return {
      ...base, status: 'ready' as const, runId: run.id, diagnosisId: run.diagnosis_id, startedAt: iso(run.started_at), finishedAt: iso(run.finished_at), error: null,
      checks: QUALITY_CHECK_IDS.map((id) => {
        const d = detChecks.find((x) => x.check === id);
        return { check: id, title: QUALITY_CHECK_TITLES[id], deterministic: d?.status ?? 'ran', reason: d?.reason ?? null, ai: id === 'Q04' ? 'not_applicable' : aiStatus };
      }),
      light: inv ? qualityLights(findings, inv) : null,
      findings,
      ai: { status: aiStatus, chapters, all, reviewing: chapters.some((c) => IN_FLIGHT.has(c.status as ChapterAiStatus)), note: 'La revisión con IA es por capítulo: elige todo el curso o capítulos sueltos; el estimado es la suma de sus llamadas. Q04 (datos que se contradicen entre capítulos) lo revisan las reglas deterministas, gratis.' },
      approvals: approvals.map((a) => this.plan.approvalView(a)),
    };
  }

  // ── API: preguntas puntuales ──

  /**
   * POST …/questions. `{ text }` → la pregunta queda registrada y su evidencia se recupera SIN IA (sin evidencia → se
   * responde «No encontré evidencia suficiente…» sin gastar). `{ questionId, confirmEstimateUsd, capUsd }` → se aprueba
   * responderla con IA dentro del tope.
   */
  async ask(actor: WorkshopActor, sessionId: string, body: { text?: unknown; questionId?: unknown; confirmEstimateUsd?: unknown; capUsd?: unknown } = {}) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.expireStale(s.id);
    if (body.questionId !== undefined) {
      if (body.text !== undefined) throw new BadRequestException({ code: QUALITY_ERRORS.REQUEST_INVALID, message: 'Envía la pregunta nueva o la confirmación de una pregunta, no las dos cosas.' });
      return this.confirmQuestion(actor, s, String(body.questionId), body);
    }
    if (body.confirmEstimateUsd !== undefined || body.capUsd !== undefined) throw new BadRequestException({ code: QUALITY_ERRORS.REQUEST_INVALID, message: 'Para aprobar el costo indica qué pregunta (questionId).' });
    const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw new BadRequestException({ code: QUALITY_ERRORS.QUESTION_EMPTY, message: 'Escribe tu pregunta sobre el curso.' });
    if (text.length > QUALITY_LIMITS.questionMaxChars) throw new BadRequestException({ code: QUALITY_ERRORS.QUESTION_TOO_LONG, message: `La pregunta es demasiado larga (máximo ${QUALITY_LIMITS.questionMaxChars} caracteres).` });
    const [n] = await this.q<any[]>(this.dataSource, `select count(*)::int n from public.workshop_questions where session_id = $1`, [s.id]);
    if (Number(n?.n ?? 0) >= QUALITY_LIMITS.questionsPerSession) throw new ConflictException({ code: QUALITY_ERRORS.QUESTIONS_LIMIT, message: `Esta sesión ya tiene ${QUALITY_LIMITS.questionsPerSession} preguntas: abre una sesión nueva para seguir preguntando.` });
    const claimId = this.claimOf();
    const [row] = await this.q<QuestionRow[]>(this.dataSource,
      `insert into public.workshop_questions (session_id, original_sha1, code_version, created_by, question, status, claim_id) values ($1, $2, $3, $4, $5, 'retrieving', $6) returning *`,
      [s.id, s.originalSha1, QUALITY_CODE_VERSION, actor.id, text, claimId]);
    this.enqueue({ kind: 'retrieve', questionId: row.id }, claimId);
    return this.questionView(row);
  }

  private async confirmQuestion(actor: WorkshopActor, s: WorkshopPlanSession, questionId: string, body: { confirmEstimateUsd?: unknown; capUsd?: unknown }) {
    const row = await this.questionOf(s, questionId);
    if (row.status !== 'awaiting_confirmation' || !row.estimate || !row.evidence?.passages?.length) throw new ConflictException({ code: QUALITY_ERRORS.QUESTION_NOT_AWAITING, message: 'Esta pregunta no está esperando que apruebes su costo.', status: row.status });
    const cap = this.plan.validateConfirmation(row.estimate, { confirmEstimateUsd: body.confirmEstimateUsd, capUsd: body.capUsd });
    const approval = await this.plan.openApproval(s, actor, { kind: 'question', estimate: row.estimate, capUsd: cap });
    const claimId = this.claimOf();
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_questions set status = 'answering', approval_id = $2, claim_id = $3, error = null, updated_at = now() where id = $1 and status = 'awaiting_confirmation' returning *`, [row.id, approval.id, claimId])) as QuestionRow[];
    if (!r) {
      await this.plan.closeApproval(approval.id, 'failed', 'La pregunta cambió mientras se aprobaba.');
      throw new ConflictException({ code: QUALITY_ERRORS.QUESTION_NOT_AWAITING, message: 'Esta pregunta ya no espera aprobación.' });
    }
    await this.plan.holdApproval(approval.id, claimId);
    this.enqueue({ kind: 'answer', questionId: row.id, approvalId: approval.id }, claimId);
    return { question: this.questionView(r), approval: this.plan.approvalView(approval as any) };
  }

  async listQuestions(actor: WorkshopActor, sessionId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.view');
    await this.expireStale(s.id);
    const rows = await this.q<QuestionRow[]>(this.dataSource, `select * from public.workshop_questions where session_id = $1 order by created_at, id`, [s.id]);
    return { sessionId: s.id, originalSha1: s.originalSha1, questions: rows.map((r) => this.questionView(r)) };
  }

  private async questionOf(s: WorkshopPlanSession, id: string): Promise<QuestionRow> {
    if (!isUuid(id)) throw new NotFoundException({ code: QUALITY_ERRORS.QUESTION_NOT_FOUND, message: 'Pregunta no encontrada.' });
    const [row] = await this.q<QuestionRow[]>(this.dataSource, `select * from public.workshop_questions where id = $1 and session_id = $2`, [id.toLowerCase(), s.id]);
    if (!row) throw new NotFoundException({ code: QUALITY_ERRORS.QUESTION_NOT_FOUND, message: 'Pregunta no encontrada.' });
    return row;
  }

  questionView(r: QuestionRow) {
    const ev = r.evidence;
    return {
      id: r.id, question: r.question, status: r.status, originalSha1: r.original_sha1,
      evidence: ev ? {
        scope: ev.scope, truncated: ev.truncated,
        passages: ev.passages.map((p) => ({ id: p.id, moduleId: p.moduleId, questionId: p.questionId, chapterNumber: p.chapterNumber, what: p.what, activityTitle: p.activityTitle, excerpt: p.text.length > 280 ? `${p.text.slice(0, 279)}…` : p.text })),
      } : null,
      estimate: r.estimate ?? null, approvalId: r.approval_id, spentUsd: usd(r.spent_usd), aiCalls: Number(r.ai_calls ?? 0),
      answer: r.answer ?? null,
      error: r.error && typeof r.error === 'object' ? { code: String(r.error.code), message: String(r.error.message), retryable: r.error.retryable === true } : null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  // ── trabajos ──

  private async runJob(job: Job, claimId: string): Promise<void> {
    if (job.kind === 'prepare') return this.runPrepare(job.runId, claimId);
    if (job.kind === 'review') return this.runReview(job, claimId);
    if (job.kind === 'retrieve') return this.runRetrieve(job.questionId, claimId);
    return this.runAnswer(job, claimId);
  }

  private memoryFor(s: WorkshopPlanSession): number {
    return Number(s.originalSize ?? 0) * diagnosisMemoryFactor(s.container);
  }

  /** Abre el original VERIFICADO de la sesión y arma el contexto del diagnóstico (el mismo lector que B3). */
  private async contextOf(s: WorkshopPlanSession) {
    const original = await this.workshop.loadVerifiedOriginal(s.id);
    const { ctx, pkg } = await this.contextBuilder(original.buffer);
    return { ctx, pkg, buffer: original.buffer };
  }

  private errorOf(err: unknown): { code: string; message: string; retryable: boolean } {
    if (err instanceof MemoryWaitTimeoutError) return { code: err.code, message: err.message, retryable: true };
    const body = (err as { getResponse?: () => any })?.getResponse?.();
    if (body?.code) return { code: String(body.code), message: String(body.message ?? 'No se pudo abrir el original de la sesión.'), retryable: body.code !== WORKSHOP_ERRORS.ORIGINAL_CHANGED && body.code !== WORKSHOP_ERRORS.ORIGINAL_MISSING };
    this.logger.error(`taller calidad: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return { code: QUALITY_ERRORS.PREPARE_FAILED, message: 'No se pudo revisar la calidad del curso; vuelve a intentarlo. Si se repite, avísanos.', retryable: true };
  }

  private async pricingOrNull(): Promise<{ pricing: WorkshopPricing | null; reason: string | null }> {
    try { return { pricing: await this.plan.pricing(), reason: null }; } catch (err) {
      const body = (err as { getResponse?: () => any })?.getResponse?.();
      return { pricing: null, reason: String(body?.message ?? 'No hay precio para el modelo de IA del Taller: la revisión con IA no está disponible.') };
    }
  }

  private async runPrepare(runId: string, claimId: string): Promise<void> {
    const CLAIMED = `id = $1 and claim_id = $2 and status in ('queued', 'running')`;
    const [run] = await this.q<RunRow[]>(this.dataSource, `update public.workshop_quality_runs set status = 'running', started_at = now(), updated_at = now() where ${CLAIMED} returning *`, [runId, claimId]).then((x) => returningRows(x));
    if (!run) return;
    const fail = (e: { code: string; message: string; retryable: boolean }) => this.q(this.dataSource, `update public.workshop_quality_runs set status = 'failed', error = $3::jsonb, finished_at = now(), updated_at = now() where ${CLAIMED}`, [runId, claimId, JSON.stringify(e)]);
    const s = await this.workshop.planSessionById(run.session_id);
    if (!s || s.status !== 'identified' || s.originalSha1 !== run.original_sha1) { await fail({ code: WORKSHOP_ERRORS.ORIGINAL_CHANGED, message: 'El original de la sesión cambió: vuelve a diagnosticarlo.', retryable: false }); return; }
    try {
      await this.workshop.withMemory(`quality:${runId}`, this.memoryFor(s), async () => {
        const { ctx, pkg, buffer } = await this.contextOf(s);
        const { pricing, reason } = await this.pricingOrNull();
        const p = await prepareQuality(ctx, pkg, buffer, pricing, reason);
        const calls = p.calls;
        const chapters: Record<string, ChapterState> = {};
        for (const c of calls) chapters[String(c.chapterNumber)] = { status: c.call ? 'not_reviewed' : 'not_applicable', approvalId: null, spentUsd: '0', aiCalls: 0, accepted: 0, rejected: 0, reason: c.reason, reviewedAt: null };
        const report = { schema: QUALITY_SCHEMA, codeVersion: QUALITY_CODE_VERSION, checks: p.checks, docs: p.docs.length, light: qualityLights(p.findings, ctx.course) };
        await this.dataSource.transaction(async (m) => {
          const [still] = await this.q<any[]>(m, `select 1 as ok from public.workshop_quality_runs where ${CLAIMED} for update`, [runId, claimId]);
          if (!still) return;
          await this.q(m, `delete from public.workshop_quality_findings where run_id = $1`, [runId]);
          await this.insertFindings(m, runId, p.findings, 0);
          await this.q(m, `update public.workshop_quality_runs set status = 'ready', report = $3::jsonb, packets = $4::jsonb, calls = $5::jsonb, chapters = $6::jsonb, error = null, finished_at = now(), updated_at = now() where ${CLAIMED}`,
            [runId, claimId, JSON.stringify(report), JSON.stringify(p.packets), JSON.stringify(calls), JSON.stringify(chapters)]);
        });
      }, () => this.heartbeat());
    } catch (err) {
      await fail(this.errorOf(err));
    }
  }

  private async insertFindings(m: Q, runId: string, fs: QualityFinding[], from: number): Promise<void> {
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      await this.q(m, `insert into public.workshop_quality_findings (run_id, finding_id, check_id, code, severity, source, scope_level, chapter_number, activity_module_id, activity_dir, ordinal, finding)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) on conflict (run_id, finding_id) do nothing`,
        [runId, f.id, f.check, f.code, f.severity, f.source, f.scope.level, f.scope.chapterNumber, f.scope.activity?.moduleId ?? null, f.scope.activity?.dir ?? null, from + i, JSON.stringify(f)]);
    }
  }

  /**
   * Revisión APROBADA: capítulo por capítulo, en orden. Antes de cada llamada, la guarda del tope de B5 (invokerFor); si
   * no entra, se corta limpio: lo revisado queda, lo que faltó vuelve a «sin revisar» con el motivo.
   */
  /**
   * b8-r2 (revisión P2-1): pase lo que pase dentro (también un error de base ANTES del try interno), la aprobación nunca
   * queda retenida y latiendo: se cierra por el camino de B5 (`closeApproval`: ambigua solo si una llamada se envió; no
   * hace nada si ya estaba cerrada), se suelta el reclamo y los capítulos en curso quedan `failed` con el motivo.
   */
  private async runReview(job: Extract<Job, { kind: 'review' }>, claimId: string): Promise<void> {
    try {
      await this.runReviewInner(job, claimId);
    } catch (err) {
      this.logger.error(`taller calidad: revisión ${job.runId} falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      const msg = 'La revisión se interrumpió por un error interno; vuelve a aprobarla.';
      await this.updateChapters(job.runId, claimId, (ch) => { let n = 0; for (const c of job.chapters) if (IN_FLIGHT.has(ch[String(c)]?.status)) { ch[String(c)] = { ...ch[String(c)], status: 'failed', reason: msg }; n++; } return n > 0; }, true)
        .catch((e) => this.logger.warn(`taller calidad: no se pudo marcar los capítulos: ${e instanceof Error ? e.message : String(e)}`));
      await this.plan.closeApproval(job.approvalId, 'failed', msg).catch((e) => this.logger.error(`FINOPS_RESERVATION_NOT_SETTLED: aprobación ${job.approvalId}: ${e instanceof Error ? e.message : String(e)}`));
      this.plan.releaseApproval(job.approvalId, claimId);
      this.activeIds.delete(`ai:${job.runId}`);
    }
  }

  private async runReviewInner(job: Extract<Job, { kind: 'review' }>, claimId: string): Promise<void> {
    const [run] = await this.q<RunRow[]>(this.dataSource, `select * from public.workshop_quality_runs where id = $1`, [job.runId]);
    const done = async (status: 'done' | 'stopped' | 'failed', reason: string | null) => {
      await this.plan.closeApproval(job.approvalId, status, reason);
      await this.q(this.dataSource, `update public.workshop_quality_runs set ai_claim_id = null, updated_at = now() where id = $1 and ai_claim_id = $2`, [job.runId, claimId]);
      this.plan.releaseApproval(job.approvalId, claimId);
      this.activeIds.delete(`ai:${job.runId}`);
    };
    const markRest = async (from: number, status: ChapterAiStatus, reason: string) => {
      await this.updateChapters(job.runId, claimId, (ch) => { for (const n of job.chapters.slice(from)) if (IN_FLIGHT.has(ch[String(n)]?.status)) ch[String(n)] = { ...ch[String(n)], status, reason }; return true; });
    };
    if (!run || run.ai_claim_id !== claimId) { await done('failed', 'La revisión ya no estaba en cola.'); return; }
    const s = await this.workshop.planSessionById(run.session_id);
    if (!s || s.originalSha1 !== run.original_sha1) { await markRest(0, 'failed', 'El original de la sesión cambió.'); await done('failed', 'El original de la sesión cambió.'); return; }
    await this.plan.startApproval(job.approvalId);
    let stop: AiUnavailableError | null = null;
    try {
      await this.workshop.withMemory(`quality-ai:${job.runId}`, this.memoryFor(s), async () => {
        const { ctx, pkg, buffer } = await this.contextOf(s);
        const docs = qualityDocs(ctx);
        const pricing = await this.plan.pricing();
        const approval = await this.plan.approvalOf(job.approvalId);
        if (!approval) throw new AiUnavailableError(PLAN_ERRORS.CAP_REACHED, 'La aprobación ya no está vigente.');
        for (let i = 0; i < job.chapters.length; i++) {
          const n = job.chapters[i];
          if (stop) break;
          const stored = (run.packets ?? []).find((p) => p.chapterNumber === n);
          const packet = chapterPacket(ctx, docs, n);
          // La evidencia que se manda es EXACTAMENTE la que se estimó (determinista; si no coincide, no se llama).
          if (!stored || stored.sha256 !== packet.sha256) {
            await this.updateChapters(job.runId, claimId, (ch) => { ch[String(n)] = { ...ch[String(n)], status: 'failed', reason: 'La evidencia del capítulo no coincide con la estimada: vuelve a pedir el diagnóstico de calidad.' }; return true; });
            continue;
          }
          await this.updateChapters(job.runId, claimId, (ch) => { ch[String(n)] = { ...ch[String(n)], status: 'reviewing' }; return true; });
          const ai = this.plan.invokerFor(s, approval, pricing, { purpose: 'quality', runId: job.runId, chapterNumber: n, qualityCodeVersion: QUALITY_CODE_VERSION });
          let r;
          try {
            r = await reviewChapter(ctx, docs, stored, ai);
          } catch (err) {
            if (!(err instanceof AiUnavailableError)) throw err;
            stop = err;
            await this.updateChapters(job.runId, claimId, (ch) => { ch[String(n)] = { ...ch[String(n)], status: err.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed', reason: `No se revisó: ${err.message}` }; return true; });
            await markRest(i + 1, 'not_reviewed', `No se revisó: ${err.message}`);
            break;
          }
          if (r.outcome.ok) await precheckFindings(ctx, pkg, buffer, r.outcome.accepted);
          await this.dataSource.transaction(async (m) => {
            const [cur] = await this.q<RunRow[]>(m, `select chapters, ai_claim_id from public.workshop_quality_runs where id = $1 for update`, [job.runId]);
            if (!cur || cur.ai_claim_id !== claimId) return;
            const ch = cur.chapters ?? {};
            if (r.outcome.ok) {
              await this.q(m, `delete from public.workshop_quality_findings where run_id = $1 and source = 'ai' and chapter_number = $2`, [job.runId, n]);
              const [mx] = await this.q<any[]>(m, `select coalesce(max(ordinal), -1)::int m from public.workshop_quality_findings where run_id = $1`, [job.runId]);
              await this.insertFindings(m, job.runId, r.outcome.accepted, Number(mx.m) + 1);
            }
            ch[String(n)] = {
              ...ch[String(n)], status: r.outcome.ok ? 'reviewed' : 'failed', spentUsd: r.spentUsd, aiCalls: r.calls, accepted: r.outcome.accepted.length, rejected: r.outcome.rejected.length,
              reason: r.outcome.ok ? (r.outcome.rejected.length ? `${r.outcome.rejected.length} hallazgo(s) de la IA descartado(s): no citaban la evidencia literalmente.` : null) : `La respuesta de la IA no sirvió: ${r.outcome.problems.join('; ')}`,
              reviewedAt: new Date().toISOString(),
            };
            await this.q(m, `update public.workshop_quality_runs set chapters = $2::jsonb, updated_at = now() where id = $1`, [job.runId, JSON.stringify(ch)]);
          });
        }
        await this.refreshReport(job.runId, ctx.course);
      }, () => this.heartbeat());
    } catch (err) {
      const e = this.errorOf(err);
      await markRest(0, 'failed', `No se revisó: ${e.message}`);
      await done('failed', e.message);
      return;
    }
    await done(stop ? (stop.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed') : 'done', stop ? stop.message : null);
  }

  private async refreshReport(runId: string, course: Parameters<typeof qualityLights>[1]): Promise<void> {
    const rows = await this.q<any[]>(this.dataSource, `select finding from public.workshop_quality_findings where run_id = $1`, [runId]);
    await this.q(this.dataSource, `update public.workshop_quality_runs set report = jsonb_set(coalesce(report, '{}'::jsonb), '{light}', $2::jsonb), updated_at = now() where id = $1`,
      [runId, JSON.stringify(qualityLights(rows.map((r) => r.finding as QualityFinding), course))]);
  }

  private async runRetrieve(questionId: string, claimId: string): Promise<void> {
    const [row] = await this.q<QuestionRow[]>(this.dataSource, `select * from public.workshop_questions where id = $1 and claim_id = $2 and status = 'retrieving'`, [questionId, claimId]);
    if (!row) return;
    const CLAIMED = `id = $1 and claim_id = $2 and status = 'retrieving'`;
    const s = await this.workshop.planSessionById(row.session_id);
    if (!s || s.originalSha1 !== row.original_sha1) {
      await this.q(this.dataSource, `update public.workshop_questions set status = 'failed', error = $3::jsonb, updated_at = now() where ${CLAIMED}`, [questionId, claimId, JSON.stringify({ code: WORKSHOP_ERRORS.ORIGINAL_CHANGED, message: 'El original de la sesión cambió.', retryable: false })]);
      return;
    }
    try {
      await this.workshop.withMemory(`question:${questionId}`, this.memoryFor(s), async () => {
        const { ctx } = await this.contextOf(s);
        const docs = qualityDocs(ctx);
        const ev = retrieveEvidence(ctx.course, docs, row.question);
        const evidence = { ...ev, courseTitle: ctx.course.course.title };
        if (!ev.passages.length) {
          // Sin evidencia: se responde sin llamar a la IA (USD 0), nunca se inventa.
          await this.q(this.dataSource, `update public.workshop_questions set status = 'answered', evidence = $3::jsonb, answer = $4::jsonb, updated_at = now() where ${CLAIMED}`,
            [questionId, claimId, JSON.stringify(evidence), JSON.stringify(noEvidenceAnswer({ reason: 'no se encontró ningún texto del curso relacionado con la pregunta', invalidCitations: 0 }))]);
          return;
        }
        const pricing = await this.plan.pricing();
        const call = askCall(evidence.courseTitle, row.question, ev.passages);
        const estimate = this.plan.estimateOf([plannedCallOf(call, pricing)], `Responder la pregunta con ${ev.passages.length} fragmento(s) del curso como evidencia (1 llamada; un reintento por forma entra en el margen). La IA no corre hasta que lo apruebes.`);
        await this.q(this.dataSource, `update public.workshop_questions set status = 'awaiting_confirmation', evidence = $3::jsonb, estimate = $4::jsonb, updated_at = now() where ${CLAIMED}`,
          [questionId, claimId, JSON.stringify(evidence), JSON.stringify(estimate)]);
      }, () => this.heartbeat());
    } catch (err) {
      await this.q(this.dataSource, `update public.workshop_questions set status = 'failed', error = $3::jsonb, updated_at = now() where ${CLAIMED}`, [questionId, claimId, JSON.stringify(this.errorOf(err))]);
    }
  }

  /** b8-r2 (revisión P2-1): igual que la revisión — la aprobación siempre se cierra y se suelta, la pregunta nunca queda colgada. */
  private async runAnswer(job: Extract<Job, { kind: 'answer' }>, claimId: string): Promise<void> {
    try {
      await this.runAnswerInner(job, claimId);
    } catch (err) {
      this.logger.error(`taller calidad: pregunta ${job.questionId} falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      const msg = 'La pregunta se interrumpió por un error interno; vuelve a hacerla.';
      await this.q(this.dataSource, `update public.workshop_questions set status = 'failed', error = $3::jsonb, updated_at = now() where id = $1 and claim_id = $2 and status = 'answering'`,
        [job.questionId, claimId, JSON.stringify({ code: QUALITY_ERRORS.QUESTION_FAILED, message: msg, retryable: true })]).catch(() => undefined);
      await this.plan.closeApproval(job.approvalId, 'failed', msg).catch((e) => this.logger.error(`FINOPS_RESERVATION_NOT_SETTLED: aprobación ${job.approvalId}: ${e instanceof Error ? e.message : String(e)}`));
      this.plan.releaseApproval(job.approvalId, claimId);
    }
  }

  private async runAnswerInner(job: Extract<Job, { kind: 'answer' }>, claimId: string): Promise<void> {
    const CLAIMED = `id = $1 and claim_id = $2 and status = 'answering'`;
    const [row] = await this.q<QuestionRow[]>(this.dataSource, `select * from public.workshop_questions where ${CLAIMED}`, [job.questionId, claimId]);
    const release = () => this.plan.releaseApproval(job.approvalId, claimId);
    if (!row || !row.evidence) { await this.plan.closeApproval(job.approvalId, 'failed', 'La pregunta ya no estaba esperando.'); release(); return; }
    const s = await this.workshop.planSessionById(row.session_id);
    if (!s) { await this.plan.closeApproval(job.approvalId, 'failed', 'La sesión ya no existe.'); release(); return; }
    await this.plan.startApproval(job.approvalId);
    let status: 'done' | 'stopped' | 'failed' = 'done';
    let reason: string | null = null;
    try {
      // Solo la evidencia GUARDADA va al modelo (no hace falta abrir el paquete): reserva chica en la memoria compartida.
      const bytes = Buffer.byteLength(JSON.stringify(row.evidence)) * 4 + 1024 * 1024;
      await this.workshop.withMemory(`answer:${job.questionId}`, bytes, async () => {
        const approval = await this.plan.approvalOf(job.approvalId);
        if (!approval) throw new AiUnavailableError(PLAN_ERRORS.CAP_REACHED, 'La aprobación ya no está vigente.');
        const pricing = await this.plan.pricing();
        const ai = this.plan.invokerFor(s, approval, pricing, { purpose: 'question', questionId: row.id, qualityCodeVersion: QUALITY_CODE_VERSION });
        try {
          const out = await answerQuestion(row.evidence!.courseTitle, row.question, row.evidence!.passages, ai);
          await this.q(this.dataSource, `update public.workshop_questions set status = 'answered', answer = $3::jsonb, spent_usd = spent_usd + $4, ai_calls = ai_calls + $5, error = null, updated_at = now() where ${CLAIMED}`,
            [job.questionId, claimId, JSON.stringify(out.answer), out.spentUsd, out.calls]);
        } catch (err) {
          if (!(err instanceof AiUnavailableError)) throw err;
          status = err.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed';
          reason = err.message;
          // Una llamada AMBIGUA no se reintenta a ciegas (la reserva queda pendiente); las demás vuelven a esperar aprobación.
          const back = err.code !== PLAN_ERRORS.CALL_AMBIGUOUS;
          await this.q(this.dataSource, `update public.workshop_questions set status = $3, error = $4::jsonb, updated_at = now() where ${CLAIMED}`,
            [job.questionId, claimId, back ? 'awaiting_confirmation' : 'failed', JSON.stringify({ code: err.code, message: err.message, retryable: back })]);
        }
      }, () => this.heartbeat());
    } catch (err) {
      const e = this.errorOf(err);
      status = 'failed';
      reason = e.message;
      await this.q(this.dataSource, `update public.workshop_questions set status = 'failed', error = $3::jsonb, updated_at = now() where ${CLAIMED}`, [job.questionId, claimId, JSON.stringify(e)]);
    }
    await this.plan.closeApproval(job.approvalId, status, reason);
    release();
  }
}

export { NO_EVIDENCE_MESSAGE };
