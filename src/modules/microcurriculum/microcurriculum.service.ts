import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { isUuid } from '../authz/schema-probe';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { assertDirectCallAllowed, recordDirectAnthropicCall } from '../finops/direct-call-ledger';
import { resolveLibroLogo } from '../../package/v3/libro-logo';
import { answersTitle, missingRequired, normalizeAnswers } from './answers';
import { MicrocurriculumOutputError, documentFromEdit, documentFromGenerated, withRegeneratedSection } from './document';
import {
  AnthropicMicrocurriculumGenerator, MICROCURRICULUM_CALL_TIMEOUT_MS, MICROCURRICULUM_GENERATOR, MICROCURRICULUM_MAX_TOKENS, McGenerationResult,
  MicrocurriculumGenerator, microcurriculumModel,
} from './microcurriculum-generator';
import { renderMicrocurriculumPdf } from './microcurriculum-pdf';
import {
  MicrocurriculumAnswers, MicrocurriculumIssue, MicrocurriculumV1, REGEN_SECTIONS, RegenSection,
} from './microcurriculum.types';
import { buildRegeneratePrompt, buildSystemPrompt, buildUserPrompt, microcurriculumTool, sectionTool } from './prompt';
import { toAcademicContext } from './to-academic-context';
import { errorsOf, repairArithmetic, validateMicrocurriculum } from './validator';
import type { AcademicContextV1 } from '../academic-context/academic-context';

/**
 * r81 · «Crear microcurrículo» (spec §2, §4). Todo es del usuario autenticado (owner_id = sub del JWT; nunca se ve lo
 * ajeno: 404). Disponible para TODOS los usuarios con MICROCURRICULUM_ENABLED='true' (si no, 404 salvo /quota).
 *
 * Generación síncrona (≤ 150 s): reserva ATÓMICA del cupo (lock por dueño + conteo del mes UTC + fila `reserved`) ANTES
 * de llamar a la IA → herramienta forzada → reparación aritmética registrada → V1–V8 → si quedan errores no aritméticos,
 * UN reintento con la lista → se guarda con sus `issues` visibles (nunca éxito silencioso). Proveedor caído o salida
 * inservible tras el reintento → `failed` y el cupo se LIBERA («no se descontó de tu cupo»). Cada llamada se registra
 * en el ledger de FinOps (operation `llm.microcurriculo`, sin atribuir a curso).
 */

export const MC_ERRORS = Object.freeze({
  ANSWERS_INCOMPLETE: 'ANSWERS_INCOMPLETE',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  REGEN_EXHAUSTED: 'REGEN_EXHAUSTED',
  GENERATION_IN_PROGRESS: 'GENERATION_IN_PROGRESS',
  NOT_GENERATED: 'NOT_GENERATED',
  DOCUMENT_REQUIRED: 'DOCUMENT_REQUIRED',
  DOCUMENT_INVALID: 'DOCUMENT_INVALID',
  GENERATION_FAILED: 'GENERATION_FAILED',
  NOT_MIGRATED: 'MICROCURRICULUM_NOT_MIGRATED',
});

export function microcurriculumEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MICROCURRICULUM_ENABLED === 'true';
}
function intEnv(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : def;
}
export function microcurriculumMonthlyLimit(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.MICROCURRICULUM_MONTHLY_LIMIT, 10);
}
export function microcurriculumRegenLimit(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.MICROCURRICULUM_REGEN_LIMIT, 3);
}
/** 1.º del mes UTC de `now` y del siguiente (renovación del cupo). */
export function quotaWindow(now: Date): { start: Date; resetsAt: Date } {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}
/** Precio de referencia (USD por MTok, Sonnet) para el costo ESTIMADO del borrador; el ledger valora con su catálogo. */
export const MC_REFERENCE_PRICE = Object.freeze({ inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 });
export function estimateCallUsd(usage: McGenerationResult['usage']): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const u = usage || {};
  const usd = (n(u.input_tokens) * MC_REFERENCE_PRICE.inputPerMTok + n(u.output_tokens) * MC_REFERENCE_PRICE.outputPerMTok
    + n(u.cache_creation_input_tokens) * MC_REFERENCE_PRICE.cacheWritePerMTok + n(u.cache_read_input_tokens) * MC_REFERENCE_PRICE.cacheReadPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Plazo total de una generación síncrona (el servidor responde antes de 150 s). */
export const MC_DEADLINE_MS = 145_000;
/** Sin al menos este margen no se intenta el reintento (se entrega lo que hay, con sus issues). */
export const MC_RETRY_MIN_MS = 30_000;
/** Una generación `generating` más vieja que esto se considera abandonada (proceso reiniciado) y se libera. */
export const MC_STALE_GENERATING_MS = 10 * 60_000;

export interface McActor { id: string; email?: string | null }

export interface MicrocurriculumRecord {
  id: string;
  title: string;
  status: 'draft_answers' | 'generating' | 'generated' | 'failed';
  answers: MicrocurriculumAnswers;
  document: MicrocurriculumV1 | null;
  issues: MicrocurriculumIssue[];
  regenCount: number;
  regenLimit: number;
  costUsd: number | null;
  courseId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MicrocurriculumQuota {
  enabled: boolean;
  unlimited?: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  resetsAt?: string;
  regenLimit?: number;
}

interface Row {
  id: string; owner_id: string; title: string; status: MicrocurriculumRecord['status']; answers: unknown; document: MicrocurriculumV1 | null;
  issues: MicrocurriculumIssue[] | null; regen_count: number; cost_usd: string | number; course_id: number | null; generating_since: Date | null;
  created_at: Date | string; updated_at: Date | string;
}

type Q = Pick<EntityManager, 'query'> | Pick<DataSource, 'query'>;
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const UNTITLED = 'Microcurrículo sin título';
const FAILED_MESSAGE = 'No se pudo generar el microcurrículo; no se descontó de tu cupo. Intenta de nuevo en unos minutos.';

@Injectable()
export class MicrocurriculumService {
  private readonly logger = new Logger(MicrocurriculumService.name);
  private readonly generator: MicrocurriculumGenerator;
  /** Reloj inyectable (pruebas de la ventana mensual). */
  now: () => Date = () => new Date();

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly ledger?: FinopsLedgerService,
    @Optional() @Inject(MICROCURRICULUM_GENERATOR) generator?: MicrocurriculumGenerator,
  ) {
    this.generator = generator || new AnthropicMicrocurriculumGenerator();
  }

  // ── utilidades ──

  private assertEnabled(): void {
    if (!microcurriculumEnabled()) throw new NotFoundException('Cannot find this route');
  }
  private unlimited(actor: McActor): boolean {
    return isSuperAdminEmail(actor.email);
  }
  private async q<T = any>(m: Q, sql: string, params: unknown[] = []): Promise<T> {
    try {
      return await m.query(sql, params);
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') {
        throw new ServiceUnavailableException({ code: MC_ERRORS.NOT_MIGRATED, message: 'El microcurrículo todavía no está disponible en este entorno (falta la migración r81).' });
      }
      throw err;
    }
  }
  private toRecord(r: Row, full = true): MicrocurriculumRecord {
    return {
      id: r.id,
      title: r.title || UNTITLED,
      status: r.status,
      answers: full ? normalizeAnswers(r.answers) : {},
      document: full ? r.document ?? null : null,
      issues: full ? r.issues || [] : [],
      regenCount: r.regen_count,
      regenLimit: microcurriculumRegenLimit(),
      costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
      courseId: r.course_id ?? null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }
  private async load(m: Q, actor: McActor, id: string, forUpdate = false): Promise<Row> {
    if (!isUuid(id)) throw new NotFoundException('Microcurrículo no encontrado');
    const rows = await this.q<Row[]>(m, `select * from public.microcurricula where id = $1 and owner_id = $2${forUpdate ? ' for update' : ''}`, [id, actor.id]);
    if (!rows.length) throw new NotFoundException('Microcurrículo no encontrado');
    return rows[0];
  }
  private stale(r: Row): boolean {
    return r.status === 'generating' && (!r.generating_since || this.now().getTime() - new Date(r.generating_since).getTime() > MC_STALE_GENERATING_MS);
  }
  private async usedThisMonth(m: Q, ownerId: string): Promise<number> {
    const { start } = quotaWindow(this.now());
    const [r] = await this.q<{ n: string }[]>(m,
      `select count(*)::int as n from public.microcurriculum_generations
        where owner_id = $1 and kind = 'generate' and status in ('reserved', 'succeeded') and created_at >= $2::timestamptz`, [ownerId, start.toISOString()]);
    return Number(r?.n || 0);
  }

  // ── lectura / CRUD ──

  async quota(actor: McActor): Promise<MicrocurriculumQuota> {
    if (!microcurriculumEnabled()) return { enabled: false };
    const limit = microcurriculumMonthlyLimit();
    const used = await this.usedThisMonth(this.dataSource, actor.id);
    return {
      enabled: true, unlimited: this.unlimited(actor), limit, used, remaining: Math.max(0, limit - used),
      resetsAt: quotaWindow(this.now()).resetsAt.toISOString(), regenLimit: microcurriculumRegenLimit(),
    };
  }

  async list(actor: McActor): Promise<{ items: MicrocurriculumRecord[] }> {
    this.assertEnabled();
    const rows = await this.q<Row[]>(this.dataSource,
      `select id, owner_id, title, status, null::jsonb as answers, null::jsonb as document, null::jsonb as issues, regen_count, cost_usd, course_id,
              generating_since, created_at, updated_at
         from public.microcurricula where owner_id = $1 order by updated_at desc limit 200`, [actor.id]);
    return { items: rows.map((r) => this.toRecord(r, false)) };
  }

  async create(actor: McActor, rawAnswers: unknown): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    const answers = normalizeAnswers(rawAnswers || {});
    const rows = await this.q<Row[]>(this.dataSource,
      `insert into public.microcurricula (owner_id, title, status, answers) values ($1, $2, 'draft_answers', $3::jsonb) returning *`,
      [actor.id, answersTitle(answers), JSON.stringify(answers)]);
    return this.toRecord(rows[0]);
  }

  async get(actor: McActor, id: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    return this.toRecord(await this.load(this.dataSource, actor, id));
  }

  async remove(actor: McActor, id: string): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.load(this.dataSource, actor, id);
    // El registro de generaciones queda (on delete set null): borrar no devuelve cupo.
    await this.q(this.dataSource, `delete from public.microcurricula where id = $1 and owner_id = $2`, [id, actor.id]);
    return { ok: true };
  }

  /**
   * PATCH: `answers` (completas) REEMPLAZAN a las guardadas; `document` (la revisión) se normaliza, lo editado pasa a
   * procedencia `docente` y la identificación editada vuelve a las respuestas (una sola verdad para V7). Las
   * comprobaciones se recalculan SIEMPRE en el servidor (sin IA, USD 0) si hay documento.
   */
  async update(actor: McActor, id: string, body: { answers?: unknown; document?: unknown }): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    return this.dataSource.transaction(async (m) => {
      const row = await this.load(m, actor, id, true);
      if (row.status === 'generating' && !this.stale(row)) {
        throw new ConflictException({ code: MC_ERRORS.GENERATION_IN_PROGRESS, message: 'El microcurrículo se está generando; espera a que termine para editarlo.' });
      }
      let answers = normalizeAnswers(row.answers);
      // Contrato: el frontend envía las respuestas COMPLETAS y reemplazan a las guardadas (sin mezclar).
      if (body.answers !== undefined && body.answers !== null) answers = normalizeAnswers(body.answers);
      let doc = row.document;
      if (body.document !== undefined && body.document !== null) {
        if (!doc) throw new ConflictException({ code: MC_ERRORS.DOCUMENT_REQUIRED, message: 'Todavía no hay un microcurrículo generado para editar.' });
        try {
          doc = documentFromEdit(body.document, doc);
        } catch (err) {
          if (err instanceof MicrocurriculumOutputError) throw new BadRequestException({ code: MC_ERRORS.DOCUMENT_INVALID, message: 'El documento enviado no tiene la forma de un microcurrículo.' });
          throw err;
        }
        const idn = doc.identification;
        answers = normalizeAnswers({
          ...answers,
          identification: { ...(answers.identification || {}), courseName: idn.courseName, institutionType: idn.institutionType, program: idn.program ?? '', term: idn.term ?? '', modality: idn.modality ?? '', code: idn.code ?? '', area: idn.area ?? '' },
        });
      }
      const issues = doc ? validateMicrocurriculum(answers, doc) : [];
      const status = row.status === 'generating' ? (doc ? 'generated' : 'draft_answers') : row.status;
      const rows = returningRows(await this.q(m,
        `update public.microcurricula set answers = $3::jsonb, document = $4::jsonb, issues = $5::jsonb, title = $6, status = $7,
                generating_since = null, updated_at = now()
          where id = $1 and owner_id = $2 returning *`,
        [id, actor.id, JSON.stringify(answers), doc ? JSON.stringify(doc) : null, JSON.stringify(issues), answersTitle(answers) || row.title, status]));
      return this.toRecord(rows[0]);
    });
  }

  // ── generación ──

  /**
   * Reserva atómica (spec §4.2): lock por dueño → fila del microcurrículo FOR UPDATE → (generar) conteo del mes UTC /
   * (regenerar) contador del borrador → fila `reserved` → status `generating`. Una generación abandonada (> 10 min) se
   * libera aquí mismo.
   */
  private async reserve(actor: McActor, id: string, kind: 'generate' | 'regenerate', section: RegenSection | null): Promise<{ generationId: string }> {
    return this.dataSource.transaction(async (m) => {
      await this.q(m, `select pg_advisory_xact_lock(hashtext($1))`, [`r81:microcurriculum:${actor.id}`]);
      const row = await this.load(m, actor, id, true);
      if (row.status === 'generating') {
        if (!this.stale(row)) throw new ConflictException({ code: MC_ERRORS.GENERATION_IN_PROGRESS, message: 'Ya hay una generación en curso para este microcurrículo.' });
        await this.q(m, `update public.microcurriculum_generations set status = 'released', finished_at = now() where microcurriculum_id = $1 and status = 'reserved'`, [id]);
      }
      const unlimited = this.unlimited(actor);
      if (kind === 'generate') {
        const limit = microcurriculumMonthlyLimit();
        if (!unlimited && (await this.usedThisMonth(m, actor.id)) >= limit) {
          const resetsAt = quotaWindow(this.now()).resetsAt.toISOString();
          throw new HttpException({ code: MC_ERRORS.QUOTA_EXHAUSTED, message: `Usaste los ${limit} microcurrículos de este mes. Tu cupo se renueva el ${resetsAt.slice(0, 10)}.`, resetsAt }, HttpStatus.TOO_MANY_REQUESTS);
        }
      } else {
        if (!row.document || (row.status !== 'generated' && !(row.status === 'generating' && this.stale(row)))) {
          throw new ConflictException({ code: MC_ERRORS.NOT_GENERATED, message: 'Solo se puede regenerar una sección de un microcurrículo ya generado.' });
        }
        const limit = microcurriculumRegenLimit();
        if (!unlimited && row.regen_count >= limit) {
          throw new HttpException({ code: MC_ERRORS.REGEN_EXHAUSTED, message: `Ya usaste las ${limit} regeneraciones de sección de este microcurrículo.` }, HttpStatus.TOO_MANY_REQUESTS);
        }
      }
      const [g] = await this.q<{ id: string }[]>(m,
        `insert into public.microcurriculum_generations (owner_id, microcurriculum_id, kind, section, status) values ($1, $2, $3, $4, 'reserved') returning id::text as id`,
        [actor.id, id, kind, section]);
      await this.q(m,
        `update public.microcurricula set status = 'generating', generating_since = now(), regen_count = regen_count + $3, updated_at = now() where id = $1 and owner_id = $2`,
        [id, actor.id, kind === 'regenerate' ? 1 : 0]);
      return { generationId: g.id };
    });
  }

  /** Falla: el cupo se libera (fila `released`; la regeneración devuelve su contador) y el borrador queda usable. */
  private async release(actor: McActor, id: string, generationId: string, kind: 'generate' | 'regenerate', costUsd: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      await this.q(m, `update public.microcurriculum_generations set status = 'released', cost_usd = $2, finished_at = now() where id = $1`, [generationId, costUsd]);
      await this.q(m,
        `update public.microcurricula
            set status = case when document is null then 'failed' else 'generated' end, generating_since = null,
                regen_count = greatest(0, regen_count - $3), cost_usd = cost_usd + $4, updated_at = now()
          where id = $1 and owner_id = $2`,
        [id, actor.id, kind === 'regenerate' ? 1 : 0, costUsd]);
    });
  }

  private async recordCall(actor: McActor, id: string, res: McGenerationResult, meta: Record<string, unknown>): Promise<number> {
    await recordDirectAnthropicCall(this.ledger, this.logger, {
      ownerId: actor.id, model: res.model, messageId: res.messageId, usage: res.usage,
      operation: 'llm.microcurriculo', recordedBy: 'microcurriculo', unattributedReason: 'microcurriculo',
      metadata: { kind: 'microcurriculum', microcurriculumId: id, ...meta },
    });
    return estimateCallUsd(res.usage);
  }

  /**
   * Hasta 2 llamadas (la 2.ª solo si la 1.ª no sirvió o dejó errores no aritméticos, y si queda plazo). Se queda con el
   * documento con MENOS errores (empate → el más reciente). Sin ningún documento usable → MicrocurriculumOutputError.
   */
  private async runGeneration(
    actor: McActor, id: string, answers: MicrocurriculumAnswers, target: { kind: 'generate' } | { kind: 'regenerate'; section: RegenSection; doc: MicrocurriculumV1 },
    acc: { costUsd: number },
  ): Promise<{ doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] }> {
    const started = this.now().getTime();
    const model = microcurriculumModel();
    const system = buildSystemPrompt(answers);
    let retry: MicrocurriculumIssue[] | null = null;
    let best: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] } | null = null;
    const problems: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = MC_DEADLINE_MS - (this.now().getTime() - started);
      if (attempt === 2 && remaining < MC_RETRY_MIN_MS) {
        this.logger.warn(`microcurrículo ${id}: sin plazo para el reintento (${Math.round(remaining / 1000)} s)`);
        break;
      }
      const user = target.kind === 'generate' ? buildUserPrompt(answers, retry ? { issues: retry } : null) : buildRegeneratePrompt(answers, target.doc, target.section, retry ? { issues: retry } : null);
      const tool = target.kind === 'generate' ? microcurriculumTool() : sectionTool(target.section);
      const res = await this.generator.generate({ model, system, user, tool, maxTokens: MICROCURRICULUM_MAX_TOKENS, timeoutMs: Math.min(MICROCURRICULUM_CALL_TIMEOUT_MS, remaining) });
      acc.costUsd += await this.recordCall(actor, id, res, { attempt, target: target.kind, ...(target.kind === 'regenerate' ? { section: target.section } : {}) });
      if (res.stopReason === 'max_tokens' || res.input === null || res.input === undefined) {
        const why = res.stopReason === 'max_tokens' ? 'la respuesta se cortó por longitud' : 'el modelo no usó la herramienta';
        problems.push(`intento ${attempt}: ${why}`);
        retry = [{ code: 'V8', severity: 'error', message: `La respuesta anterior no sirvió (${why}). Entrega el contenido completo con la herramienta, con redacción más concisa.` }];
        continue;
      }
      let candidate: MicrocurriculumV1;
      try {
        candidate = target.kind === 'generate' ? documentFromGenerated(res.input, answers) : withRegeneratedSection(target.doc, target.section, res.input);
      } catch (err) {
        if (!(err instanceof MicrocurriculumOutputError)) throw err;
        problems.push(`intento ${attempt}: ${err.problems.join(', ')}`);
        retry = err.problems.map((p) => ({ code: 'V8' as const, severity: 'error' as const, message: `Salida incompleta: ${p}.` }));
        continue;
      }
      const repaired = repairArithmetic(answers, candidate);
      const issues = validateMicrocurriculum(answers, repaired.mc);
      if (!best || errorsOf(issues).length <= errorsOf(best.issues).length) best = { doc: repaired.mc, issues };
      if (!errorsOf(issues).length) break;
      retry = issues;
    }
    if (!best) throw new MicrocurriculumOutputError(problems.length ? problems : ['sin salida usable']);
    return best;
  }

  private failure(err: unknown): HttpException {
    // Kill switch / allow-list de FinOps u otro error HTTP con código propio: se respeta tal cual.
    if (err instanceof HttpException && (err.getResponse() as { code?: string })?.code) return err;
    return new ServiceUnavailableException({ code: MC_ERRORS.GENERATION_FAILED, message: FAILED_MESSAGE });
  }

  async generate(actor: McActor, id: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    const row = await this.load(this.dataSource, actor, id);
    const answers = normalizeAnswers(row.answers);
    const missing = missingRequired(answers);
    if (missing.length) {
      throw new BadRequestException({ code: MC_ERRORS.ANSWERS_INCOMPLETE, message: 'Faltan respuestas obligatorias para crear el microcurrículo.', missing });
    }
    assertDirectCallAllowed('anthropic'); // tope / kill switch ANTES de reservar: error claro, sin llamada
    const { generationId } = await this.reserve(actor, id, 'generate', null);
    const acc = { costUsd: 0 };
    let out: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] };
    try {
      out = await this.runGeneration(actor, id, answers, { kind: 'generate' }, acc);
    } catch (err) {
      this.logger.error(`microcurrículo ${id}: generación fallida — ${err instanceof Error ? err.message : String(err)}`);
      await this.release(actor, id, generationId, 'generate', acc.costUsd);
      throw this.failure(err);
    }
    return this.commit(actor, id, generationId, answers, out, acc.costUsd);
  }

  async regenerate(actor: McActor, id: string, section: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    if (!(REGEN_SECTIONS as readonly string[]).includes(section)) throw new BadRequestException(`section debe ser una de: ${REGEN_SECTIONS.join(', ')}`);
    const row = await this.load(this.dataSource, actor, id);
    if (!row.document) throw new ConflictException({ code: MC_ERRORS.NOT_GENERATED, message: 'Solo se puede regenerar una sección de un microcurrículo ya generado.' });
    const answers = normalizeAnswers(row.answers);
    assertDirectCallAllowed('anthropic');
    const { generationId } = await this.reserve(actor, id, 'regenerate', section as RegenSection);
    const acc = { costUsd: 0 };
    let out: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] };
    try {
      out = await this.runGeneration(actor, id, answers, { kind: 'regenerate', section: section as RegenSection, doc: row.document }, acc);
    } catch (err) {
      this.logger.error(`microcurrículo ${id}: regeneración de ${section} fallida — ${err instanceof Error ? err.message : String(err)}`);
      await this.release(actor, id, generationId, 'regenerate', acc.costUsd);
      throw this.failure(err);
    }
    return this.commit(actor, id, generationId, answers, out, acc.costUsd);
  }

  private async commit(actor: McActor, id: string, generationId: string, answers: MicrocurriculumAnswers, out: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] }, costUsd: number): Promise<MicrocurriculumRecord> {
    return this.dataSource.transaction(async (m) => {
      await this.q(m, `update public.microcurriculum_generations set status = 'succeeded', cost_usd = $2, finished_at = now() where id = $1`, [generationId, costUsd]);
      const rows = returningRows(await this.q(m,
        `update public.microcurricula set status = 'generated', document = $3::jsonb, issues = $4::jsonb, title = $5, cost_usd = cost_usd + $6,
                generating_since = null, updated_at = now()
          where id = $1 and owner_id = $2 returning *`,
        [id, actor.id, JSON.stringify(out.doc), JSON.stringify(out.issues), answersTitle(answers) || UNTITLED, costUsd]));
      if (!rows.length) throw new NotFoundException('Microcurrículo no encontrado');
      return this.toRecord(rows[0]);
    });
  }

  // ── salidas ──

  private async accountLogo(ownerId: string): Promise<Buffer | null> {
    try {
      const [us] = await this.dataSource.query(`select logo_b64 from public.user_settings where user_id::text = $1`, [ownerId]);
      if (typeof us?.logo_b64 !== 'string' || !us.logo_b64.trim()) return null;
      const logo = resolveLibroLogo([{ source: 'user_settings', dataUri: us.logo_b64 }]);
      return logo.source === 'cursia_default' ? null : logo.bytes;
    } catch {
      return null; // sin logo de la cuenta → Cursia (nunca bloquea el PDF)
    }
  }

  async pdf(actor: McActor, id: string): Promise<{ pdf: Buffer; filename: string }> {
    this.assertEnabled();
    const row = await this.load(this.dataSource, actor, id);
    if (!row.document) throw new ConflictException({ code: MC_ERRORS.DOCUMENT_REQUIRED, message: 'Todavía no hay un microcurrículo generado para descargar.' });
    const answers = normalizeAnswers(row.answers);
    const r = await renderMicrocurriculumPdf(row.document, {
      logo: await this.accountLogo(actor.id), author: answers.references?.author || null, date: new Date(row.updated_at), issues: row.issues || [],
    });
    return { pdf: r.pdf, filename: `microcurriculo-${slug(row.document.identification.courseName || row.title)}.pdf` };
  }

  async academicContext(actor: McActor, id: string): Promise<{ context: AcademicContextV1 }> {
    this.assertEnabled();
    const row = await this.load(this.dataSource, actor, id);
    if (!row.document) throw new ConflictException({ code: MC_ERRORS.DOCUMENT_REQUIRED, message: 'Todavía no hay un microcurrículo generado.' });
    return { context: toAcademicContext(row.document, normalizeAnswers(row.answers)) };
  }
}

export function slug(s: string): string {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return t || 'documento';
}
