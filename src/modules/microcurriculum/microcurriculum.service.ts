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
import { answersTitle, identificationFromAnswers, missingRequired, normalizeAnswers, resolveTotalHours } from './answers';
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
 * Generación ASÍNCRONA (el proxy de producción corta a los 60 s): POST …/generate|regenerate valida, reserva ATÓMICAMENTE
 * el cupo (lock por dueño + conteo del mes UTC + fila `reserved`), deja el status `generating` y responde 202 al
 * instante; la generación corre en este proceso (sin await): herramienta forzada → reparación aritmética registrada →
 * V1–V8 → si quedan errores no aritméticos, UN reintento con la lista → se guarda con sus `issues` visibles (nunca éxito
 * silencioso). Proveedor caído o salida inservible tras el reintento → `failed` (o vuelve a `generated` si ya había
 * documento), `lastError` y el cupo se LIBERA («no se descontó de tu cupo»). El cliente sondea GET /:id. Si el proceso
 * se reinicia a mitad, una generación `generating` de más de 6 min se da por interrumpida al leer (GET/lista/cupo) y se
 * libera igual. Cada llamada se registra en el ledger de FinOps (operation `llm.microcurriculo`, sin atribuir a curso).
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
  GENERATION_INTERRUPTED: 'GENERATION_INTERRUPTED',
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
/** Una generación `generating` más vieja que esto se considera interrumpida (proceso reiniciado) y se libera. Holgura
 *  amplia sobre el peor caso real (2 llamadas acotadas por MC_DEADLINE_MS). */
export const MC_STALE_GENERATING_MS = 6 * 60_000;
export const INTERRUPTED_MESSAGE = 'La generación se interrumpió; no se descontó de tu cupo.';

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
  /** Sección que se está regenerando (status `generating`); null si es una generación completa o no hay nada en curso. */
  pendingSection: RegenSection | null;
  /** Por qué falló la última generación en segundo plano (se limpia al reservar una nueva). */
  lastError: { code: string; message: string } | null;
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
  pending_section: RegenSection | null; last_error: { code: string; message: string } | null;
  created_at: Date | string; updated_at: Date | string;
}

type Q = Pick<EntityManager, 'query'> | Pick<DataSource, 'query'>;
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const UNTITLED = 'Microcurrículo sin título';
const FAILED_MESSAGE = 'No se pudo generar el microcurrículo; no se descontó de tu cupo. Intenta de nuevo en unos minutos.';
/** Texto para el docente cuando falla el proveedor o un control de gasto: sin nombres de variables ni detalles internos. */
export const AI_UNAVAILABLE_MESSAGE = 'El servicio de IA no está disponible en este momento; no se descontó de tu cupo. Intenta de nuevo en unos minutos.';

/** ¿Este issue lo puede arreglar regenerar `section`? (review P2-1: el reintento no se gasta en lo que quedó fijo). */
export function issueInSection(i: MicrocurriculumIssue, section: RegenSection): boolean {
  const p = i.path || '';
  if (p === section || p.startsWith(`${section}[`) || p.startsWith(`${section}.`)) return true;
  if (section === 'units') return i.code === 'V1' || i.code === 'V4' || p === 'totalHours';
  if (section === 'evaluation') return i.code === 'V2';
  return false;
}

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
      pendingSection: r.status === 'generating' ? r.pending_section ?? null : null,
      lastError: r.last_error ?? null,
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
    const since = r.generating_since || r.updated_at;
    return r.status === 'generating' && (!since || this.now().getTime() - new Date(since).getTime() > MC_STALE_GENERATING_MS);
  }

  /**
   * Generaciones interrumpidas (status `generating` > 6 min: el proceso se reinició a mitad de la llamada) → se liberan
   * sus reservas (la regeneración devuelve su contador), status `failed` (o `generated` si hay documento) y `lastError`.
   */
  private async recoverStale(ownerId: string, id?: string): Promise<void> {
    const cutoff = new Date(this.now().getTime() - MC_STALE_GENERATING_MS).toISOString();
    const cand = await this.q<{ id: string }[]>(this.dataSource,
      `select id from public.microcurricula where owner_id = $1 and status = 'generating' and coalesce(generating_since, updated_at) < $2::timestamptz${id && isUuid(id) ? ' and id = $3' : ''}`,
      id && isUuid(id) ? [ownerId, cutoff, id] : [ownerId, cutoff]);
    for (const c of cand) {
      await this.dataSource.transaction(async (m) => {
        await this.q(m, `select pg_advisory_xact_lock(hashtext($1))`, [`r81:microcurriculum:${ownerId}`]);
        const [row] = await this.q<Row[]>(m, `select * from public.microcurricula where id = $1 and owner_id = $2 for update`, [c.id, ownerId]);
        if (!row || !this.stale(row)) return;
        const gens = returningRows(await this.q(m,
          `update public.microcurriculum_generations set status = 'released', finished_at = now() where microcurriculum_id = $1 and status = 'reserved' returning kind`, [c.id]));
        const regen = gens.filter((g: { kind: string }) => g.kind === 'regenerate').length;
        await this.q(m,
          `update public.microcurricula
              set status = case when document is null then 'failed' else 'generated' end, generating_since = null, pending_section = null,
                  regen_count = greatest(0, regen_count - $3), last_error = $4::jsonb, updated_at = now()
            where id = $1 and owner_id = $2`,
          [c.id, ownerId, regen, JSON.stringify({ code: MC_ERRORS.GENERATION_INTERRUPTED, message: INTERRUPTED_MESSAGE })]);
        this.logger.warn(`microcurrículo ${c.id}: generación interrumpida (> ${MC_STALE_GENERATING_MS / 60000} min) → liberada`);
      });
    }
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
    await this.recoverStale(actor.id);
    const limit = microcurriculumMonthlyLimit();
    const used = await this.usedThisMonth(this.dataSource, actor.id);
    return {
      enabled: true, unlimited: this.unlimited(actor), limit, used, remaining: Math.max(0, limit - used),
      resetsAt: quotaWindow(this.now()).resetsAt.toISOString(), regenLimit: microcurriculumRegenLimit(),
    };
  }

  async list(actor: McActor): Promise<{ items: MicrocurriculumRecord[] }> {
    this.assertEnabled();
    await this.recoverStale(actor.id);
    const rows = await this.q<Row[]>(this.dataSource,
      `select id, owner_id, title, status, null::jsonb as answers, null::jsonb as document, null::jsonb as issues, regen_count, cost_usd, course_id,
              generating_since, pending_section, last_error, created_at, updated_at
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

  /** También es el endpoint de sondeo de la generación en segundo plano. */
  async get(actor: McActor, id: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    await this.recoverStale(actor.id, id);
    return this.toRecord(await this.load(this.dataSource, actor, id));
  }

  async remove(actor: McActor, id: string): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.recoverStale(actor.id, id);
    const row = await this.load(this.dataSource, actor, id);
    // Borrar a mitad de una generación dejaría su reserva huérfana (sin borrador que la libere): 409 (review P2-4).
    if (row.status === 'generating') throw new ConflictException({ code: MC_ERRORS.GENERATION_IN_PROGRESS, message: 'El microcurrículo se está generando; espera a que termine para borrarlo.' });
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
    await this.recoverStale(actor.id, id);
    return this.dataSource.transaction(async (m) => {
      const row = await this.load(m, actor, id, true);
      if (row.status === 'generating') {
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
      }
      if (doc) {
        // Identificación: una sola verdad entre respuestas y documento (review FE P1-1/P2-8). Lo que el docente CAMBIÓ en
        // el documento (comparado con el guardado) vuelve a las respuestas; todo lo demás sale de las respuestas, así una
        // corrección en el asistente llega a la revisión, al PDF y al puente. Sin `identification` en el cuerpo = sin cambios.
        const prev = (row.document as MicrocurriculumV1).identification;
        const fromAnswers = identificationFromAnswers(answers);
        const idn = { ...doc.identification } as Record<string, unknown>;
        const ans = { ...(answers.identification || {}) } as Record<string, unknown>;
        // r101 · `institutionTypeOther` es opcional (solo con `otro`): se recorre siempre, aunque falte en un lado.
        const keys = [...new Set([...Object.keys(fromAnswers), 'institutionTypeOther'])] as (keyof typeof fromAnswers)[];
        for (const k of keys) {
          if ((idn[k] ?? null) !== ((prev as unknown as Record<string, unknown>)[k] ?? null)) ans[k] = idn[k] ?? '';
          else idn[k] = fromAnswers[k];
        }
        answers = normalizeAnswers({ ...answers, identification: ans });
        const total = resolveTotalHours(answers.time);
        doc = { ...doc, identification: identificationFromAnswers(answers), totalHours: total ?? doc.totalHours };
      }
      const issues = doc ? validateMicrocurriculum(answers, doc) : [];
      const status = row.status;
      const rows = returningRows(await this.q(m,
        `update public.microcurricula set answers = $3::jsonb, document = $4::jsonb, issues = $5::jsonb, title = $6, status = $7,
                generating_since = null, last_error = null, updated_at = now()
          where id = $1 and owner_id = $2 returning *`,
        [id, actor.id, JSON.stringify(answers), doc ? JSON.stringify(doc) : null, JSON.stringify(issues), answersTitle(answers) || row.title, status]));
      return this.toRecord(rows[0]);
    });
  }

  // ── generación ──

  /**
   * Reserva atómica (spec §4.2): lock por dueño → fila del microcurrículo FOR UPDATE → (generar) conteo del mes UTC /
   * (regenerar) contador del borrador → fila `reserved` → status `generating` (+ `pending_section`). Las interrumpidas ya
   * se liberaron antes (recoverStale).
   */
  private async reserve(
    actor: McActor, id: string, kind: 'generate' | 'regenerate', section: RegenSection | null, precheck: (row: Row) => void = () => {},
  ): Promise<{ generationId: string; row: Row }> {
    return this.dataSource.transaction(async (m) => {
      await this.q(m, `select pg_advisory_xact_lock(hashtext($1))`, [`r81:microcurriculum:${actor.id}`]);
      // Respuestas y documento se leen AQUÍ, bajo el lock y FOR UPDATE: la generación trabaja sobre esta instantánea
      // (un PATCH concurrente espera y luego ve status generating → 409). Review P2-3.
      const row = await this.load(m, actor, id, true);
      if (row.status === 'generating') throw new ConflictException({ code: MC_ERRORS.GENERATION_IN_PROGRESS, message: 'Ya hay una generación en curso para este microcurrículo.' });
      precheck(row);
      const unlimited = this.unlimited(actor);
      if (kind === 'generate') {
        const limit = microcurriculumMonthlyLimit();
        if (!unlimited && (await this.usedThisMonth(m, actor.id)) >= limit) {
          const resetsAt = quotaWindow(this.now()).resetsAt.toISOString();
          throw new HttpException({ code: MC_ERRORS.QUOTA_EXHAUSTED, message: `Usaste los ${limit} microcurrículos de este mes. Tu cupo se renueva el ${resetsAt.slice(0, 10)}.`, resetsAt }, HttpStatus.TOO_MANY_REQUESTS);
        }
      } else {
        if (!row.document || row.status !== 'generated') {
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
        `update public.microcurricula set status = 'generating', generating_since = now(), pending_section = $4, last_error = null,
                regen_count = regen_count + $3, updated_at = now() where id = $1 and owner_id = $2`,
        [id, actor.id, kind === 'regenerate' ? 1 : 0, section]);
      return { generationId: g.id, row };
    });
  }

  /**
   * Falla: el cupo se libera (fila `released`; la regeneración devuelve su contador), `lastError` y el borrador queda
   * usable (`failed`, o `generated` con el documento anterior). Si la reserva ya no está `reserved` (se dio por
   * interrumpida) solo se suma el costo.
   */
  private async release(actor: McActor, id: string, generationId: string, kind: 'generate' | 'regenerate', costUsd: number, error: { code: string; message: string }): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const own = returningRows(await this.q(m,
        `update public.microcurriculum_generations set status = 'released', cost_usd = $2, finished_at = now() where id = $1 and status = 'reserved' returning id`, [generationId, costUsd]));
      if (!own.length) {
        await this.q(m, `update public.microcurricula set cost_usd = cost_usd + $3 where id = $1 and owner_id = $2`, [id, actor.id, costUsd]);
        return;
      }
      await this.q(m,
        `update public.microcurricula
            set status = case when document is null then 'failed' else 'generated' end, generating_since = null, pending_section = null,
                regen_count = greatest(0, regen_count - $3), cost_usd = cost_usd + $4, last_error = $5::jsonb, updated_at = now()
          where id = $1 and owner_id = $2`,
        [id, actor.id, kind === 'regenerate' ? 1 : 0, costUsd, JSON.stringify(error)]);
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
      let res: McGenerationResult;
      try {
        res = await this.generator.generate({ model, system, user, tool, maxTokens: MICROCURRICULUM_MAX_TOKENS, timeoutMs: Math.min(MICROCURRICULUM_CALL_TIMEOUT_MS, remaining) });
      } catch (err) {
        // Review P1-1: si el reintento falla (529, timeout, kill switch) y ya hay un documento usable, se entrega ESE con
        // sus issues visibles; solo sin ningún documento la falla sube (→ failed, cupo liberado).
        if (!best) throw err;
        this.logger.warn(`microcurrículo ${id}: el reintento falló (${err instanceof Error ? err.message : String(err)}); se guarda el intento anterior con sus issues`);
        break;
      }
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
      // Al regenerar, solo se repara lo aritmético DE ESA sección (horas → units, % → evaluation): lo fijo, quizá editado por
      // el docente, no se toca y si no cuadra queda visible (review P2-1).
      const scope = target.kind === 'generate' ? {} : { hours: target.section === 'units', percents: target.section === 'evaluation' };
      const repaired = repairArithmetic(answers, candidate, scope);
      const issues = validateMicrocurriculum(answers, repaired.mc);
      // Errores que ESTA llamada puede arreglar: todos en la generación completa; los de la sección al regenerar.
      const fixable = errorsOf(issues).filter((i) => target.kind === 'generate' || issueInSection(i, target.section));
      const score = (xs: MicrocurriculumIssue[]) => errorsOf(xs).filter((i) => target.kind === 'generate' || issueInSection(i, target.section)).length;
      if (!best || fixable.length <= score(best.issues)) best = { doc: repaired.mc, issues };
      if (!fixable.length) break;
      retry = fixable;
    }
    if (!best) throw new MicrocurriculumOutputError(problems.length ? problems : ['sin salida usable']);
    return best;
  }

  /** Motivo visible de una falla en segundo plano (kill switch u otro error con código propio: se respeta). */
  private failure(err: unknown): { code: string; message: string } {
    // Review P2-8: el docente ve un texto genérico; el código/mensaje interno (kill switch, allow-list, proveedor) va al log.
    if (err instanceof MicrocurriculumOutputError) return { code: MC_ERRORS.GENERATION_FAILED, message: FAILED_MESSAGE };
    const body = err instanceof HttpException ? (err.getResponse() as { code?: string }) : null;
    this.logger.error(`microcurrículo: falla del proveedor o control de gasto${body && typeof body === 'object' && body.code ? ` [${body.code}]` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    return { code: MC_ERRORS.GENERATION_FAILED, message: AI_UNAVAILABLE_MESSAGE };
  }

  /** Generaciones en curso en ESTE proceso (las pruebas esperan a que terminen con whenIdle). */
  private readonly inflight = new Set<Promise<void>>();
  whenIdle(): Promise<void> {
    return Promise.all([...this.inflight]).then(() => undefined);
  }
  private launch(label: string, job: () => Promise<void>): void {
    const p: Promise<void> = job()
      .catch((err) => { this.logger.error(`microcurrículo ${label}: error en segundo plano — ${err instanceof Error ? err.message : String(err)}`); })
      .finally(() => { this.inflight.delete(p); });
    this.inflight.add(p);
  }

  /** Corre la generación sin bloquear la petición; al terminar escribe generated (con issues) o libera y deja lastError. */
  private background(actor: McActor, id: string, generationId: string, answers: MicrocurriculumAnswers, target: { kind: 'generate' } | { kind: 'regenerate'; section: RegenSection; doc: MicrocurriculumV1 }): void {
    this.launch(id, async () => {
      const acc = { costUsd: 0 };
      let out: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] };
      try {
        out = await this.runGeneration(actor, id, answers, target, acc);
      } catch (err) {
        this.logger.error(`microcurrículo ${id}: ${target.kind === 'generate' ? 'generación' : `regeneración de ${target.section}`} fallida — ${err instanceof Error ? err.message : String(err)}`);
        await this.release(actor, id, generationId, target.kind, acc.costUsd, this.failure(err));
        return;
      }
      await this.commit(actor, id, generationId, target.kind, answers, out, acc.costUsd);
    });
  }

  async generate(actor: McActor, id: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    await this.load(this.dataSource, actor, id); // 404 temprano
    assertDirectCallAllowed('anthropic'); // tope / kill switch ANTES de reservar: error claro, sin llamada
    await this.recoverStale(actor.id); // TODOS los borradores del dueño: una reserva huérfana no debe dar un 429 falso (P2-5)
    const { generationId, row } = await this.reserve(actor, id, 'generate', null, (r) => {
      const missing = missingRequired(normalizeAnswers(r.answers));
      if (missing.length) throw new BadRequestException({ code: MC_ERRORS.ANSWERS_INCOMPLETE, message: 'Faltan respuestas obligatorias para crear el microcurrículo.', missing });
    });
    this.background(actor, id, generationId, normalizeAnswers(row.answers), { kind: 'generate' });
    return this.toRecord(await this.load(this.dataSource, actor, id)); // 202: status generating; el cliente sondea GET /:id
  }

  async regenerate(actor: McActor, id: string, section: string): Promise<MicrocurriculumRecord> {
    this.assertEnabled();
    if (!(REGEN_SECTIONS as readonly string[]).includes(section)) throw new BadRequestException(`section debe ser una de: ${REGEN_SECTIONS.join(', ')}`);
    await this.load(this.dataSource, actor, id); // 404 temprano
    assertDirectCallAllowed('anthropic');
    await this.recoverStale(actor.id);
    const { generationId, row } = await this.reserve(actor, id, 'regenerate', section as RegenSection);
    // El documento vigente queda visible mientras se regenera (status generating + pendingSection); se regenera sobre la
    // instantánea leída bajo el lock.
    this.background(actor, id, generationId, normalizeAnswers(row.answers), { kind: 'regenerate', section: section as RegenSection, doc: row.document as MicrocurriculumV1 });
    return this.toRecord(await this.load(this.dataSource, actor, id));
  }

  /** Éxito: solo si la reserva sigue `reserved` (si se dio por interrumpida o se borró el borrador, se descarta). */
  private async commit(actor: McActor, id: string, generationId: string, kind: 'generate' | 'regenerate', answers: MicrocurriculumAnswers, out: { doc: MicrocurriculumV1; issues: MicrocurriculumIssue[] }, costUsd: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const own = returningRows(await this.q(m,
        `update public.microcurriculum_generations set status = 'succeeded', cost_usd = $2, finished_at = now() where id = $1 and status = 'reserved' returning id`, [generationId, costUsd]));
      if (!own.length) {
        this.logger.warn(`microcurrículo ${id}: resultado descartado (la reserva ya no estaba vigente)`);
        await this.q(m, `update public.microcurricula set cost_usd = cost_usd + $3 where id = $1 and owner_id = $2`, [id, actor.id, costUsd]);
        return;
      }
      await this.q(m,
        `update public.microcurricula set status = 'generated', document = $3::jsonb, issues = $4::jsonb, title = $5, cost_usd = cost_usd + $6,
                generating_since = null, pending_section = null, last_error = null, updated_at = now(),
                regen_count = case when $7 then 0 else regen_count end
          where id = $1 and owner_id = $2 and status = 'generating'`,
        // Decisión de producto (review P2-13): una generación COMPLETA exitosa (que gasta cupo) reinicia las regeneraciones.
        [id, actor.id, JSON.stringify(out.doc), JSON.stringify(out.issues), answersTitle(answers) || UNTITLED, costUsd, kind === 'generate']);
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
      // r86: copia exacta adjunta → «Importar microcurrículo» la lee sin interpretar el texto del PDF.
      embed: { microcurriculumId: row.id, answers },
    });
    return { pdf: r.pdf, filename: `microcurriculo-${slug(row.document.identification.courseName || row.title)}.pdf` };
  }

  async academicContext(actor: McActor, id: string): Promise<{ context: AcademicContextV1 }> {
    this.assertEnabled();
    const row = await this.load(this.dataSource, actor, id);
    if (!row.document) throw new ConflictException({ code: MC_ERRORS.DOCUMENT_REQUIRED, message: 'Todavía no hay un microcurrículo generado.' });
    const answers = normalizeAnswers(row.answers);
    try {
      return { context: toAcademicContext(row.document, answers) };
    } catch (err) {
      // Review P1-3: un documento con errores de forma (ids repetidos o vacíos, títulos vacíos, horas fuera de rango…) no
      // produce un contexto válido → 409 con las comprobaciones a corregir, nunca un 500 opaco.
      if (!(err instanceof Error) || !err.message.startsWith('ACADEMIC_CONTEXT_INVALID')) throw err;
      this.logger.warn(`microcurrículo ${id}: contexto académico inválido — ${err.message.slice(0, 300)}`);
      const issues = errorsOf(validateMicrocurriculum(answers, row.document));
      throw new ConflictException({
        code: MC_ERRORS.DOCUMENT_INVALID,
        message: 'Corrige las comprobaciones del microcurrículo antes de crear el curso con él.',
        issues: issues.length ? issues : [{ code: 'V8', severity: 'error', message: 'El microcurrículo tiene datos fuera de rango (revisa ids, títulos y horas).' }],
      });
    }
  }
}

export function slug(s: string): string {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return t || 'documento';
}
