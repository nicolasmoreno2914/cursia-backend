import { returningRows } from '../../common/db/returning-rows';
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { CourseDesignService } from '../course-design/course-design.service';
import { CourseBlueprintsService } from '../course-blueprints/course-blueprints.service';
import { CourseProfilesService } from '../course-profiles/course-profiles.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { loadCourseFacts } from '../course-facts/course-facts-db';
import { BRIEF_KEY, alignCourseContextWithSnapshot, parseBrief } from '../course-facts/course-facts';
import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { emptyPedagogicalProfile } from '../pedagogy/pedagogy-profile';
import { defaultApproachRegistry } from '../pedagogy/builtin-approaches';
import { readStructureOrigin } from '../course-structure/structure-authority';
import { contentCoverage, readContentMap } from '../academic-context/content-coverage';
import { actualText, requirementText, structureEditedByTeacher } from '../academic-context/requirements/requirement-authority';
import { lqaFindings, lqaHitLabel } from '../language-qa/language-qa';
import { COURSE_FORMATS, COURSE_FORMAT_CODES, COURSE_FORMAT_CATALOG_VERSION, CourseFormatCode, formatDef, isCourseFormatCode, readCourseFormat, writeCourseFormat } from './course-formats';
import { PrebriefModel, StoredExceptionReason, buildPrebriefModel, diffModels, documentVerbatimTexts, isDocumentVerbatim, prebriefModelSha } from './prebrief-model';
import { PrebriefDocument, PrebriefDocumentMeta, PrebriefStatus, approvalStateTexts, buildPrebriefDocument, documentSha, documentTexts } from './prebrief-document';
import { PrebriefReadiness, prebriefReadiness } from './prebrief-readiness';
import { DoubtfulItem, doubtfulItems } from './plausibility';
import { renderPrebriefPdf } from './prebrief-pdf';
import { unmappedCharCount } from '../../package/v3/libro-v3';
import { paletteIdFromCourseMetadata } from '../course-profiles/course-profiles.service';

/**
 * Prebrief pedagógico · servicio. Toda la autoridad está aquí (la interfaz solo muestra):
 *   - borrador = el modelo armado AHORA con los datos vigentes (nunca se guarda);
 *   - preparar = congelar el Blueprint, guardar la versión N (modelo + documento + huellas) y su PDF «para aprobación»;
 *   - aprobar = registrar quién (usuario de la sesión + nombre + cargo), cuándo, qué versión y qué huella; PDF «aprobado»;
 *   - cualquier cambio posterior de lo que la huella cubre deja la versión INVALIDADA (con las diferencias);
 *   - la generación (R68) exige la última versión aprobada y vigente, y el contexto del run sale de ella.
 */

export const PREBRIEF_NOT_READY = 'PREBRIEF_NOT_READY';
export const PREBRIEF_CHANGED = 'PREBRIEF_CHANGED';
export const PREBRIEF_NOT_APPROVABLE = 'PREBRIEF_NOT_APPROVABLE';
export { APPROVAL_FLOW_KEY, EXCEPTION_REASONS_KEY, CONFIRMATIONS_KEY } from './prebrief-keys';
import { APPROVAL_FLOW_KEY, CONFIRMATIONS_KEY, EXCEPTION_REASONS_KEY } from './prebrief-keys';
export const PREBRIEF_REQUIRED_SINCE_ENV = 'DYNAMIC_PREBRIEF_REQUIRED_SINCE';
export const REASON_MIN = 10;
export const REASON_MAX = 500;

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

export interface PrebriefDraft {
  model: PrebriefModel;
  modelSha256: string;
  document: PrebriefDocument;
  documentSha256: string;
  readiness: PrebriefReadiness;
  doubts: DoubtfulItem[];
  verification: { criticals: number; warnings: number };
  card: any;
}

export interface PrebriefVersionRow {
  id: string;
  course_id: number;
  version: number;
  status: 'ready' | 'changes_requested' | 'approved' | 'invalidated';
  model_json: PrebriefModel;
  model_sha256: string;
  document_json: PrebriefDocument;
  document_sha256: string;
  blueprint_id: number;
  blueprint_number: number;
  blueprint_sha256: string;
  verification_summary: any;
  prepared_by: string;
  prepared_by_email: string | null;
  prepared_at: string | Date;
  approval: any;
  changes_request: any;
  invalidated_at: string | Date | null;
  invalidation_reason: string | null;
  invalidation_diff: string[] | null;
}

const iso = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

@Injectable()
export class PrebriefService {
  private readonly logger = new Logger(PrebriefService.name);
  constructor(
    private readonly dataSource: DataSource,
    private readonly courses: CoursesService,
    private readonly design: CourseDesignService,
    private readonly blueprints: CourseBlueprintsService,
    private readonly profiles: CourseProfilesService,
  ) {}

  private async loadCourse(courseId: number, ownerId: string) {
    assertDynamicOwnerAllowed(ownerId); // allow-list V2 en toda ruta del Prebrief (lectura y escritura)
    const course = await this.courses.findOne(courseId, ownerId); // 404 si no es suyo
    if (course.structureVersion !== 'dynamic') throw new BadRequestException(`El curso #${courseId} no es de estructura dinámica: no tiene Prebrief.`);
    return course;
  }

  private async metadata(q: Q, courseId: number): Promise<Record<string, any>> {
    // El instante se calcula en Postgres: courses.created_at es `timestamp` sin zona (lo escribe now() en la zona de la
    // sesión de la base) y el driver lo leería en la zona horaria del proceso Node (en staging corría 2 h y un curso
    // nuevo parecía anterior al corte). ::timestamptz lo interpreta con la MISMA zona de sesión que lo escribió.
    const [row] = await q.query(`select metadata, (extract(epoch from created_at::timestamptz) * 1000)::float8 as created_ms from public.courses where id = $1`, [courseId]);
    return { ...(row && row.metadata ? parse(row.metadata) : {}), __createdAtMs: row && row.created_ms !== null ? Number(row.created_ms) : null };
  }

  /** Fase 3: cobertura de los contenidos del documento contra la estructura viva (null sin mapa o de otra versión). */
  private async contentCoverageOf(q: Q, courseId: number, academic: { version: number; context: any } | null): Promise<{ total: number; covered: number } | null> {
    if (!academic) return null;
    const map = await readContentMap(q as any, courseId);
    if (!map) return null;
    const live = await q.query(`select id from public.course_chapters where course_id = $1`, [courseId]);
    const cov = contentCoverage(academic.context, academic.version, map, live.map((r: any) => String(r.id)));
    return cov.available && !cov.stale ? { total: cov.total, covered: cov.covered } : null;
  }

  // ── Borrador ────────────────────────────────────────────────────────────────────────────────────────────────

  /** El Prebrief que se prepararía AHORA (mismos datos que ven Entendimos y Diseño). Solo lectura, USD 0. */
  async draft(courseId: number, ownerId: string): Promise<PrebriefDraft> {
    const course = await this.loadCourse(courseId, ownerId);
    const card = await this.design.recommend(courseId, ownerId, {} as any);
    return this.draftFrom(courseId, course, card);
  }

  private async draftFrom(courseId: number, course: any, card: any): Promise<PrebriefDraft> {
    const q = this.dataSource;
    const meta = await this.metadata(q, courseId);
    const facts = await loadCourseFacts(q, courseId);
    // Review BE-1 I3: un error de lectura NO se traga (un modelo distinto invalidaría para siempre una aprobación); solo una
    // base sin las tablas de perfiles (entornos viejos) cuenta como «sin datos».
    const missingTable = (err: any) => { if (err && err.code === '42P01') return null; throw err; };
    const academic = await loadCurrentAcademicContext(q, courseId).catch(missingTable);
    const pedagogy = await loadCurrentPedagogicalProfile(q, courseId).catch(missingTable);
    const format = await readCourseFormat(q, courseId);
    const origin = await readStructureOrigin(q as any, courseId);
    const byTeacher = await structureEditedByTeacher(q, courseId);
    const [inst] = course.institutionId ? await q.query(`select name from public.institutions where id = $1`, [course.institutionId]) : [];
    const registry = defaultApproachRegistry();
    const ap = card && card.approach && registry.has(card.approach.id) ? registry.get(card.approach.id) : null;
    const cycle = ap ? (['module.opening', 'content.type', 'activity.intent', 'assessment.strategy', 'feedback.mode'] as const)
      .map((k) => (ap.votes as any)[k]).filter((x: any) => x && x.rationale).map((x: any) => String(x.rationale)) : [];
    const learner = pedagogy && (pedagogy.profile as any).learner ? (pedagogy.profile as any).learner : null;
    const brief = parseBrief(meta[BRIEF_KEY]);
    // Perfiles de evaluación y presentación vigentes (sin perfil guardado = valores por defecto: null en la huella).
    const profRows = await q.query(
      `select distinct on (kind) kind, sha256, data from public.course_profiles where course_id = $1 and kind in ('assessment', 'presentation') order by kind, version desc`,
      [courseId],
    ).catch((err: any) => { if (err && err.code === '42P01') return []; throw err; });
    const prof = (k: string) => { const r = profRows.find((x: any) => x.kind === k); return r ? { sha256: String(r.sha256), data: parse(r.data) } : null; };
    const paletteId = paletteIdFromCourseMetadata(meta);
    const model = buildPrebriefModel({
      course: { id: courseId, title: course.title, institutionName: inst ? inst.name : null },
      brief: brief ? (brief.fields as Record<string, string>) : {},
      facts,
      academic: academic ? academic.context : null,
      card,
      format,
      structureSource: byTeacher ? 'teacher' : origin && origin.source === 'academic_context' ? 'document' : 'cursia',
      structureChoice: origin && origin.choice ? origin.choice : null,
      contentCoverage: await this.contentCoverageOf(q, courseId, academic),
      exceptionReasons: (meta[EXCEPTION_REASONS_KEY] && typeof meta[EXCEPTION_REASONS_KEY] === 'object' ? meta[EXCEPTION_REASONS_KEY] : {}) as Record<string, StoredExceptionReason>,
      approachInfo: ap ? { summary: ap.summary || null, cycle } : null,
      alignContext: (ctx) => alignCourseContextWithSnapshot(ctx, learner).context,
      profiles: { assessment: prof('assessment'), presentation: prof('presentation'), paletteId },
    }, actualText as any, requirementText as any);
    const confirmed = new Set<string>(Object.keys(meta[CONFIRMATIONS_KEY] && typeof meta[CONFIRMATIONS_KEY] === 'object' ? meta[CONFIRMATIONS_KEY] : {}));
    const outOrigin = new Map(((facts.outcomes.value || []) as any[]).map((o) => [String(o.id || ''), o.origin]));
    const doubts = doubtfulItems({
      outcomes: model.goals.outcomes.map((o) => ({ id: o.id, text: o.text, fromDocument: (outOrigin.get(o.id) || o.origin) === 'document' })),
      competencies: model.goals.competencies.map((c) => ({ id: c.id, text: c.text, fromDocument: c.origin === 'document' })),
      evaluations: model.evaluation.fromDocument.map((e, i) => ({ id: `EV${i + 1}`, text: e.text, fromDocument: e.origin === 'document' })),
      objective: model.goals.generalObjective ? { text: model.goals.generalObjective.value, fromDocument: model.goals.generalObjective.origin === 'document' } : null,
      learner: model.learner.description ? { text: model.learner.description.value, fromDocument: model.learner.description.origin === 'document' } : null,
    }, confirmed);
    const document = buildPrebriefDocument(model);
    const language: string[] = [];
    const verbatim = documentVerbatimTexts(model);
    for (const t of documentTexts(document)) if (!isDocumentVerbatim(t, verbatim)) for (const h of lqaFindings(t, 3)) language.push(`${lqaHitLabel(h)} en «${t.slice(0, 80)}»`);
    const readiness = prebriefReadiness(model, card, doubts, language);
    const checks: any[] = (card && card.verification && card.verification.checks) || [];
    return {
      model, modelSha256: prebriefModelSha(model), document, documentSha256: documentSha(document), readiness, doubts,
      verification: { criticals: checks.filter((c) => c.severity === 'critical' && !c.summary).length, warnings: checks.filter((c) => c.severity === 'warning' && !c.summary).length },
      card,
    };
  }

  // ── Versiones ───────────────────────────────────────────────────────────────────────────────────────────────

  private async versions(q: Q, courseId: number): Promise<PrebriefVersionRow[]> {
    const rows = await q.query(`select * from public.course_prebrief_versions where course_id = $1 order by version desc`, [courseId]);
    return rows.map((r: any) => ({ ...r, model_json: parse(r.model_json), document_json: parse(r.document_json), approval: parse(r.approval), changes_request: parse(r.changes_request), verification_summary: parse(r.verification_summary), invalidation_diff: parse(r.invalidation_diff) }));
  }

  private async event(q: Q, courseId: number, versionId: string | null, type: string, actor: string | null, payload: Record<string, unknown> = {}): Promise<void> {
    await q.query(`insert into public.course_prebrief_events (course_id, version_id, type, actor, payload) values ($1, $2, $3, $4, $5::jsonb)`, [courseId, versionId, type, actor, JSON.stringify(payload)]);
  }

  /**
   * Una versión «lista» o «aprobada» cuya huella ya no es la del borrador queda INVALIDADA (con las diferencias). Se
   * persiste la primera vez que se detecta (lectura del Prebrief o intento de generar); idempotente.
   */
  private async invalidateIfStale(courseId: number, draft: PrebriefDraft, actor: string | null): Promise<void> {
    const vs = await this.versions(this.dataSource, courseId);
    for (const v of vs) {
      if ((v.status === 'ready' || v.status === 'approved' || v.status === 'changes_requested') && v.model_sha256 !== draft.modelSha256) {
        const diff = diffModels(v.model_json, draft.model);
        const res = returningRows(await this.dataSource.query(
          `update public.course_prebrief_versions set status = 'invalidated', invalidated_at = now(), invalidation_reason = $2, invalidation_diff = $3::jsonb
            where id = $1 and status in ('ready', 'approved', 'changes_requested') returning id`,
          [v.id, 'design_changed', JSON.stringify(diff)],
        ));
        if (res.length) await this.event(this.dataSource, courseId, v.id, 'invalidated', actor, { reason: 'design_changed', diff, fromStatus: v.status });
      }
    }
  }

  /** GET: estado completo (borrador + versiones + flujo). */
  async state(courseId: number, ownerId: string, card?: any) {
    await this.assertTablesReady();
    // `card`: «Cursia recomienda» ya calculado en este mismo pedido (motivos y confirmaciones no lo cambian; es lo
    // más caro del borrador). Sin él se calcula.
    const draft = card ? await this.draftFrom(courseId, await this.loadCourse(courseId, ownerId), card) : await this.draft(courseId, ownerId);
    await this.invalidateIfStale(courseId, draft, ownerId);
    const vs = await this.versions(this.dataSource, courseId);
    const meta = await this.metadata(this.dataSource, courseId);
    const latest = vs[0] || null;
    const active = latest && (latest.status === 'ready' || latest.status === 'approved' || latest.status === 'changes_requested') ? latest : null;
    const runs = await this.dataSource.query(
      `select payload->>'runId' as run_id, version_id, type, at from public.course_prebrief_events where course_id = $1 and type in ('generation_started') order by id`, [courseId]);
    return {
      prebriefVersion: 1,
      approvalFlow: await this.requiresPrebrief(this.dataSource, courseId, meta),
      status: (active ? active.status : 'draft') as PrebriefStatus,
      draft: {
        model: draft.model, modelSha256: draft.modelSha256, document: draft.document, documentSha256: draft.documentSha256,
        readiness: draft.readiness, verification: draft.verification,
        stateTexts: approvalStateTexts({ status: 'draft', version: null, date: null, fingerprint: draft.modelSha256, approval: null }),
        matchesLatest: !!latest && latest.model_sha256 === draft.modelSha256,
        diffFromLatest: latest && latest.model_sha256 !== draft.modelSha256 ? diffModels(latest.model_json, draft.model) : [],
      },
      current: active ? this.versionDto(active, runs) : null,
      versions: vs.map((v) => this.versionSummary(v, runs)),
      format: await readCourseFormat(this.dataSource, courseId),
    };
  }

  private versionSummary(v: PrebriefVersionRow, runs: any[] = []) {
    return {
      version: v.version, status: v.status, modelSha256: v.model_sha256, preparedAt: iso(v.prepared_at), preparedByEmail: v.prepared_by_email,
      approval: v.approval ? { name: v.approval.name, role: v.approval.role, at: v.approval.at, email: v.approval.email || null } : null,
      changesRequest: v.changes_request ? { note: v.changes_request.note, at: v.changes_request.at } : null,
      invalidatedAt: iso(v.invalidated_at), invalidationReason: v.invalidation_reason, invalidationDiff: v.invalidation_diff || [],
      blueprintNumber: v.blueprint_number,
      runs: runs.filter((r) => r.version_id === v.id).map((r) => r.run_id),
    };
  }

  private versionDto(v: PrebriefVersionRow, runs: any[] = []) {
    // stateTexts: el bloque de estado/aprobación con los MISMOS textos que dibuja el PDF de esta versión.
    return { ...this.versionSummary(v, runs), model: v.model_json, document: v.document_json, documentSha256: v.document_sha256, stateTexts: approvalStateTexts(this.metaOf(v, v.status)) };
  }

  async getVersion(courseId: number, ownerId: string, n: number) {
    await this.loadCourse(courseId, ownerId);
    const v = (await this.versions(this.dataSource, courseId)).find((x) => x.version === n);
    if (!v) throw new NotFoundException(`El curso #${courseId} no tiene la versión ${n} del Prebrief.`);
    return this.versionDto(v);
  }

  /**
   * Preparar para aprobación: exige la preparación completa (verificación sin críticos, sin cambios pendientes, datos
   * confirmados, excepciones con motivo, español neutro) y la MISMA huella que vio el usuario. Congela el Blueprint
   * (idempotente) y guarda la versión con su PDF. Idempotente: la misma huella devuelve la versión vigente.
   */
  async prepare(courseId: number, ownerId: string, user: { id: string; email?: string | null }, expectedModelSha: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    await this.assertTablesReady(); // sin las tablas (entorno sin la migración) → 503 ANTES de congelar nada
    let draft = await this.draft(courseId, ownerId);
    if (!draft.readiness.ready) throw new ConflictException({ code: PREBRIEF_NOT_READY, message: `${PREBRIEF_NOT_READY}: la propuesta todavía no se puede preparar para aprobación.`, blockers: draft.readiness.blockers });
    if (draft.modelSha256 !== expectedModelSha) throw new ConflictException({ code: PREBRIEF_CHANGED, message: `${PREBRIEF_CHANGED}: la propuesta cambió desde que la revisaste; revisa la versión actualizada.`, modelSha256: draft.modelSha256 });
    await this.invalidateIfStale(courseId, draft, user.id);
    const existing = (await this.versions(this.dataSource, courseId)).find((v) => v.model_sha256 === draft.modelSha256 && (v.status === 'ready' || v.status === 'approved'));
    if (existing) return { created: false, version: this.versionDto(existing) };
    // Congela el Blueprint de la estructura vigente (idempotente por huella).
    const [c] = await this.dataSource.query(`select structure_version_counter from public.courses where id = $1`, [courseId]);
    const locked = await this.blueprints.lock(courseId, ownerId, Number(c.structure_version_counter));
    const bp: any = locked.blueprint;
    // El Blueprint congelado debe ser el que muestra la propuesta (si no, algo cambió en el medio: se recalcula y se exige de nuevo).
    draft = await this.draft(courseId, ownerId);
    if (draft.modelSha256 !== expectedModelSha || !draft.readiness.ready || (draft.model.blueprintSha256 && draft.model.blueprintSha256 !== String(bp.sha256))) {
      throw new ConflictException({ code: PREBRIEF_CHANGED, message: `${PREBRIEF_CHANGED}: el diseño cambió mientras se preparaba la propuesta; revisa la versión actualizada.`, modelSha256: draft.modelSha256 });
    }
    const qr = this.dataSource.createQueryRunner();
    let row: PrebriefVersionRow;
    try {
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`select id from public.courses where id = $1 for update`, [courseId]);
      // Review BE-1 m: idempotencia BAJO el lock (dos «Preparar» simultáneos no crean dos versiones).
      const [dup] = await qr.query(`select * from public.course_prebrief_versions where course_id = $1 and model_sha256 = $2 and status in ('ready', 'approved') limit 1`, [courseId, draft.modelSha256]);
      if (dup) {
        await qr.commitTransaction();
        const vs = await this.versions(this.dataSource, courseId);
        return { created: false, version: this.versionDto(vs.find((v) => v.id === dup.id)!) };
      }
      const [mx] = await qr.query(`select coalesce(max(version), 0) as v from public.course_prebrief_versions where course_id = $1`, [courseId]);
      const n = Number(mx.v) + 1;
      // Versiones anteriores sin aprobar (lista o con cambios solicitados): reemplazadas.
      const sup = returningRows(await qr.query(`update public.course_prebrief_versions set status = 'invalidated', invalidated_at = now(), invalidation_reason = 'superseded'
        where course_id = $1 and status in ('ready', 'changes_requested') returning id, version`, [courseId]));
      for (const s of sup) await this.event(qr, courseId, s.id, 'superseded', user.id, { byVersion: n });
      const [ins] = await qr.query(
        `insert into public.course_prebrief_versions (course_id, version, status, model_version, model_json, model_sha256, document_json, document_sha256,
           blueprint_id, blueprint_number, blueprint_sha256, verification_summary, prepared_by, prepared_by_email)
         values ($1, $2, 'ready', $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12, $13) returning *`,
        [courseId, n, draft.model.prebriefModelVersion, JSON.stringify(draft.model), draft.modelSha256, JSON.stringify(draft.document), draft.documentSha256,
          Number(bp.id), Number(bp.blueprintNumber), String(bp.sha256), JSON.stringify(draft.verification), user.id, user.email || null],
      );
      await qr.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${APPROVAL_FLOW_KEY}}', '"prebrief"'::jsonb, true) where id = $1`, [courseId]);
      await this.event(qr, courseId, ins.id, 'prepared', user.id, { version: n, modelSha256: draft.modelSha256, blueprintNumber: Number(bp.blueprintNumber) });
      await qr.commitTransaction();
      row = { ...ins, model_json: draft.model, document_json: draft.document };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
    await this.storePdfSafe(row, 'ready');
    return { created: true, version: this.versionDto(row) };
  }

  /** Aprobar: la última versión, lista, con la huella vigente, sin críticos; quién = el usuario de la sesión. */
  async approve(courseId: number, ownerId: string, user: { id: string; email?: string | null }, n: number, body: { expectedModelSha: string; name: string; role: string; confirm: boolean }) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const name = String(body.name || '').replace(/\s+/g, ' ').trim();
    const role = String(body.role || '').replace(/\s+/g, ' ').trim();
    if (body.confirm !== true) throw new BadRequestException('Para aprobar hay que confirmar: «Apruebo este diseño pedagógico para producción».');
    if (name.length < 3 || name.length > 120) throw new BadRequestException('Escribe el nombre de quien aprueba (3 a 120 caracteres).');
    if (role.length < 2 || role.length > 120) throw new BadRequestException('Escribe el cargo o rol de quien aprueba (2 a 120 caracteres).');
    // Lo que se aprueba se imprime igual en el PDF: un carácter que el PDF no puede dibujar no se acepta en silencio.
    if (unmappedCharCount(name) > 0 || unmappedCharCount(role) > 0) throw new BadRequestException('El nombre o el cargo tiene caracteres que no se pueden imprimir en el PDF de la propuesta; escríbelos sin símbolos especiales.');
    const draft = await this.draft(courseId, ownerId);
    await this.invalidateIfStale(courseId, draft, user.id);
    const vs = await this.versions(this.dataSource, courseId);
    const v = vs.find((x) => x.version === n);
    if (!v) throw new NotFoundException(`El curso #${courseId} no tiene la versión ${n} del Prebrief.`);
    if (vs[0].version !== n) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'not_latest', message: `${PREBRIEF_NOT_APPROVABLE}: la versión ${n} no es la más reciente (v${vs[0].version}).` });
    if (v.status !== 'ready') throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: v.status, message: `${PREBRIEF_NOT_APPROVABLE}: la versión ${n} está «${v.status === 'approved' ? 'aprobada' : v.status === 'invalidated' ? 'invalidada' : 'con cambios solicitados'}».`, diff: v.invalidation_diff || [] });
    if (body.expectedModelSha !== v.model_sha256 || draft.modelSha256 !== v.model_sha256) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'changed', message: `${PREBRIEF_NOT_APPROVABLE}: el diseño cambió; revisa la versión actualizada.` });
    if (draft.verification.criticals > 0) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'critical', message: `${PREBRIEF_NOT_APPROVABLE}: la verificación tiene problemas críticos.` });
    if (!draft.readiness.ready) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'not_ready', message: `${PREBRIEF_NOT_APPROVABLE}: la propuesta ya no cumple las condiciones para aprobarse.`, blockers: draft.readiness.blockers });
    const approval = { userId: user.id, email: user.email || null, name, role, at: new Date().toISOString(), modelSha256: v.model_sha256, documentSha256: v.document_sha256, blueprintNumber: v.blueprint_number, channel: 'in_app' };
    const res = returningRows(await this.dataSource.query(
      `update public.course_prebrief_versions set status = 'approved', approval = $2::jsonb where id = $1 and status = 'ready' and model_sha256 = $3 returning *`,
      [v.id, JSON.stringify(approval), body.expectedModelSha],
        ));
    if (!res.length) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'race', message: `${PREBRIEF_NOT_APPROVABLE}: la versión cambió de estado mientras se aprobaba.` });
    await this.event(this.dataSource, courseId, v.id, 'approved', user.id, { name, role, modelSha256: v.model_sha256 });
    const row = { ...v, status: 'approved' as const, approval };
    await this.storePdfSafe(row, 'approved');
    return { version: this.versionDto(row) };
  }

  async requestChanges(courseId: number, ownerId: string, user: { id: string; email?: string | null }, n: number, note: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const text = String(note || '').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 1500) throw new BadRequestException('Describe los ajustes que solicitas (3 a 1500 caracteres).');
    const res = returningRows(await this.dataSource.query(
      `update public.course_prebrief_versions set status = 'changes_requested', changes_request = $3::jsonb
        where course_id = $1 and version = $2 and status = 'ready' returning id`,
      [courseId, n, JSON.stringify({ userId: user.id, email: user.email || null, note: text, at: new Date().toISOString() })],
        ));
    if (!res.length) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'not_ready', message: `${PREBRIEF_NOT_APPROVABLE}: solo se pueden solicitar ajustes sobre una versión lista para aprobación.` });
    await this.event(this.dataSource, courseId, res[0].id, 'changes_requested', user.id, { note: text });
    return this.state(courseId, ownerId);
  }

  async withdraw(courseId: number, ownerId: string, user: { id: string }, n: number) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const res = returningRows(await this.dataSource.query(
      `update public.course_prebrief_versions set status = 'invalidated', invalidated_at = now(), invalidation_reason = 'withdrawn'
        where course_id = $1 and version = $2 and status in ('ready', 'changes_requested') returning id`,
      [courseId, n],
        ));
    if (!res.length) throw new ConflictException({ code: PREBRIEF_NOT_APPROVABLE, reason: 'not_withdrawable', message: `${PREBRIEF_NOT_APPROVABLE}: solo se retira una versión lista o con cambios solicitados (una aprobada se reemplaza preparando otra).` });
    await this.event(this.dataSource, courseId, res[0].id, 'withdrawn', user.id);
    return this.state(courseId, ownerId);
  }

  // ── PDF ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private metaOf(v: PrebriefVersionRow, status: PrebriefStatus): PrebriefDocumentMeta {
    return {
      status, version: v.version, date: iso(v.prepared_at), fingerprint: v.model_sha256,
      approval: (status === 'approved' || status === 'invalidated') && v.approval ? { name: v.approval.name, role: v.approval.role, at: v.approval.at, email: v.approval.email || null } : null,
      invalidationReason: status === 'invalidated' ? ((v.invalidation_reason as any) || 'design_changed') : null,
    };
  }

  /** La versión/aprobación ya quedó guardada: un PDF que falla se vuelve a generar al descargarlo (determinista), nunca un 500. */
  private async storePdfSafe(v: PrebriefVersionRow, variant: 'ready' | 'approved'): Promise<void> {
    try { await this.storePdf(v, variant); } catch (err) { this.logger.warn(`PDF ${variant} de la versión ${v.version} del curso #${v.course_id} no se guardó: ${(err as Error).message}`); }
  }

  private async assertTablesReady(): Promise<void> {
    try { await this.dataSource.query(`select 1 from public.course_prebrief_versions limit 1`); } catch (err: any) {
      if (err && err.code === '42P01') throw new ServiceUnavailableException({ code: 'PREBRIEF_UNAVAILABLE', message: 'PREBRIEF_UNAVAILABLE: la propuesta pedagógica no está disponible en este entorno.' });
      throw err;
    }
  }

  private async storePdf(v: PrebriefVersionRow, variant: 'ready' | 'approved'): Promise<void> {
    const r = await renderPrebriefPdf(v.document_json, this.metaOf(v, variant === 'approved' ? 'approved' : 'ready'));
    const sha = createHash('sha256').update(r.pdf).digest('hex');
    await this.dataSource.query(
      `insert into public.course_prebrief_pdfs (version_id, variant, sha256, pages, bytes) values ($1, $2, $3, $4, $5) on conflict (version_id, variant) do nothing`,
      [v.id, variant, sha, r.pages, r.pdf],
    );
    await this.event(this.dataSource, v.course_id, v.id, 'pdf_generated', null, { variant, sha256: sha, pages: r.pages });
  }

  /** PDF de una versión (guardado; «invalidated» se re-renderiza del documento archivado con su franja). */
  async versionPdf(courseId: number, ownerId: string, n: number, variant: string): Promise<{ pdf: Buffer; filename: string }> {
    await this.loadCourse(courseId, ownerId);
    const v = (await this.versions(this.dataSource, courseId)).find((x) => x.version === n);
    if (!v) throw new NotFoundException(`El curso #${courseId} no tiene la versión ${n} del Prebrief.`);
    const want = variant === 'approved' || variant === 'ready' || variant === 'invalidated' ? variant : v.status === 'approved' ? 'approved' : v.status === 'invalidated' ? 'invalidated' : 'ready';
    const slug = (v.model_json.course.title || 'curso').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'curso';
    const filename = `Cursia_Propuesta_pedagogica_${slug}_v${n}_${want === 'approved' ? 'aprobado' : want === 'invalidated' ? 'invalidada' : 'para-aprobacion'}.pdf`;
    if (want === 'invalidated') {
      if (v.status !== 'invalidated') throw new BadRequestException(`La versión ${n} no está invalidada.`);
      return { pdf: (await renderPrebriefPdf(v.document_json, this.metaOf(v, 'invalidated'))).pdf, filename };
    }
    if (want === 'approved' && !v.approval) throw new BadRequestException(`La versión ${n} no fue aprobada.`);
    const [row] = await this.dataSource.query(`select bytes from public.course_prebrief_pdfs where version_id = $1 and variant = $2`, [v.id, want]);
    if (row) return { pdf: Buffer.from(row.bytes), filename };
    // PDF faltante (p. ej. falló al prepararse): se genera ahora y se guarda (mismos bytes: es determinista).
    await this.storePdf(v, want as 'ready' | 'approved');
    const [again] = await this.dataSource.query(`select bytes from public.course_prebrief_pdfs where version_id = $1 and variant = $2`, [v.id, want]);
    return { pdf: Buffer.from(again.bytes), filename };
  }

  async draftPdf(courseId: number, ownerId: string): Promise<{ pdf: Buffer; filename: string }> {
    const d = await this.draft(courseId, ownerId);
    const r = await renderPrebriefPdf(d.document, { status: 'draft', version: null, date: null, fingerprint: d.modelSha256, approval: null });
    const slug = (d.model.course.title || 'curso').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'curso';
    return { pdf: r.pdf, filename: `Cursia_Propuesta_pedagogica_${slug}_borrador.pdf` };
  }

  // ── Formato, motivos de excepción y confirmaciones ──────────────────────────────────────────────────────────

  /** Elegir (o quitar) el formato S/M/L. La meta de horas pasa a ser el punto medio del formato (decisión de la institución). */
  async setFormat(courseId: number, ownerId: string, user: { id: string; email?: string | null }, code: CourseFormatCode | null) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    if (code !== null && !isCourseFormatCode(code)) throw new BadRequestException('El formato debe ser S, M, L o null.');
    const prev = await readCourseFormat(this.dataSource, courseId);
    const def = formatDef(code);
    // Cierre (review final I1/I2): primero las horas, después el formato (si las horas fallan, nada cambió). Elegir un
    // formato guarda qué horas puso y cuáles había; quitarlo (o cambiarlo) restaura las de antes si nadie las tocó, para
    // que unas horas que la institución no eligió no queden como suyas («elegiste 42 h»).
    const cur = await this.profiles.getCurrent(courseId, ownerId, 'pedagogy');
    // Sin perfil guardado: el perfil vacío VÁLIDO, nunca un objeto incompleto.
    const data: any = cur && !cur.isDefault && cur.profile ? JSON.parse(JSON.stringify(cur.profile)) : emptyPedagogicalProfile();
    delete data.designRules;
    const curHours: number | null = typeof data.targetHours === 'number' ? data.targetHours : null;
    const prevSet = prev ? (prev.hoursSet !== undefined ? prev.hoursSet : (formatDef(prev.code) || { targetHours: null }).targetHours) : undefined;
    const untouched = prev && prevSet !== undefined && prevSet !== null && curHours === prevSet;
    const before: number | null = untouched ? (prev!.hoursBefore !== undefined ? prev!.hoursBefore : null) : curHours;
    const wantHours: number | null = def ? def.targetHours : before;
    const oldProfile = cur && !cur.isDefault && cur.profile ? JSON.parse(JSON.stringify(cur.profile)) : null;
    let appended: number | null = null;
    if (curHours !== wantHours) {
      if (wantHours === null) delete data.targetHours; else data.targetHours = wantHours;
      if (wantHours === null) delete data.targetHoursText;
      const r = await this.profiles.append(courseId, ownerId, 'pedagogy', data, cur && !cur.isDefault ? Number(cur.version) : 0);
      appended = Number(r.profile.version);
    }
    try {
      await writeCourseFormat(this.dataSource, courseId, code
        ? { code, catalogVersion: COURSE_FORMAT_CATALOG_VERSION, at: new Date().toISOString(), by: user.email || user.id, hoursSet: def!.targetHours, hoursBefore: before }
        : null);
    } catch (err) {
      // Las horas se devuelven a como estaban: el formato no se guardó (nunca «no cambió nada» con las horas cambiadas).
      if (appended !== null && oldProfile) { delete oldProfile.designRules; await this.profiles.append(courseId, ownerId, 'pedagogy', oldProfile, appended).catch(() => undefined); }
      throw err;
    }
    await this.event(this.dataSource, courseId, null, 'format_selected', user.id, { from: prev ? prev.code : null, to: code });
    return { format: await readCourseFormat(this.dataSource, courseId) };
  }

  async getFormat(courseId: number, ownerId: string) {
    await this.loadCourse(courseId, ownerId);
    return { format: await readCourseFormat(this.dataSource, courseId), catalog: COURSE_FORMAT_CODES.map((c) => COURSE_FORMATS[c]) };
  }

  /** Motivo de una excepción (obligatorio para preparar la propuesta). Vale mientras el requisito no cambie. */
  async setExceptionReason(courseId: number, ownerId: string, user: { id: string; email?: string | null }, requirementKey: string, reason: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const text = String(reason || '').replace(/\s+/g, ' ').trim();
    if (text.length < REASON_MIN || text.length > REASON_MAX) throw new BadRequestException(`El motivo debe tener entre ${REASON_MIN} y ${REASON_MAX} caracteres.`);
    const d = await this.draft(courseId, ownerId);
    const asked = d.model.exceptions.find((e) => e.requirementKey === requirementKey);
    if (!asked) throw new BadRequestException('Ese requisito no tiene una excepción en el diseño actual.');
    // LOOP 9.2: una excepción cubierta por otra (misma limitación, misma frase) guarda el motivo en la que la cubre.
    const ex = (asked.coveredBy && d.model.exceptions.find((e) => e.requirementKey === asked.coveredBy)) || asked;
    requirementKey = ex.requirementKey;
    const entry: StoredExceptionReason = { reason: text, requirementText: ex.requirementText, by: user.email || user.id, at: new Date().toISOString() };
    await this.dataSource.query(
      `update public.courses set metadata = jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb), '{${EXCEPTION_REASONS_KEY}}', coalesce(metadata -> '${EXCEPTION_REASONS_KEY}', '{}'::jsonb), true),
         array['${EXCEPTION_REASONS_KEY}', $2::text], $3::jsonb, true) where id = $1`,
      [courseId, requirementKey, JSON.stringify(entry)],
    );
    await this.event(this.dataSource, courseId, null, 'exception_reason', user.id, { requirementKey, reason: text });
    return this.state(courseId, ownerId, d.card); // el motivo no cambia «Cursia recomienda»: no se recalcula
  }

  /** Confirmar un dato del documento marcado como dudoso (queda registrado quién y cuándo; si el texto cambia, vuelve a pedirse). */
  async confirm(courseId: number, ownerId: string, user: { id: string; email?: string | null }, confirmKey: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const d = await this.draft(courseId, ownerId);
    const item = d.doubts.find((x) => x.confirmKey === confirmKey);
    if (!item) throw new BadRequestException('Ese dato no está pendiente de confirmación.');
    await this.dataSource.query(
      `update public.courses set metadata = jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb), '{${CONFIRMATIONS_KEY}}', coalesce(metadata -> '${CONFIRMATIONS_KEY}', '{}'::jsonb), true),
         array['${CONFIRMATIONS_KEY}', $2::text], $3::jsonb, true) where id = $1`,
      [courseId, confirmKey, JSON.stringify({ by: user.email || user.id, at: new Date().toISOString(), kind: item.kind, text: item.text })],
    );
    await this.event(this.dataSource, courseId, null, 'data_confirmed', user.id, { kind: item.kind, id: item.id, text: item.text });
    return this.state(courseId, ownerId, d.card); // la confirmación no cambia «Cursia recomienda»: no se recalcula
  }

  // ── Barrera de generación (R68 + Prebrief) ──────────────────────────────────────────────────────────────────

  /**
   * ¿Este curso exige un Prebrief aprobado para generar? Sí si ya entró al flujo (preparó alguna versión) o si se creó
   * desde DYNAMIC_PREBRIEF_REQUIRED_SINCE (cursos nuevos en el entorno que lo activa). Los cursos existentes no cambian.
   */
  async requiresPrebrief(q: Q, courseId: number, meta?: Record<string, any>): Promise<boolean> {
    const m = meta || (await this.metadata(q, courseId));
    if (m[APPROVAL_FLOW_KEY] === 'prebrief') return true;
    // Review BE-1 C1: una versión preparada prueba que el curso entró al flujo (aunque alguien tocara el metadata).
    const [hasV] = await q.query(`select 1 as x from public.course_prebrief_versions where course_id = $1 limit 1`, [courseId]).catch((err: any) => {
      if (err && err.code === '42P01') return [];
      throw err;
    });
    if (hasV) return true;
    const since = String(process.env[PREBRIEF_REQUIRED_SINCE_ENV] || '').trim();
    if (!since) return false;
    const t = Date.parse(since);
    if (isNaN(t)) throw new ServiceUnavailableException({ code: 'PREBRIEF_CONFIG_INVALID', message: `${PREBRIEF_REQUIRED_SINCE_ENV} no es una fecha válida.` });
    return typeof m.__createdAtMs === 'number' && Number.isFinite(m.__createdAtMs) && m.__createdAtMs >= t;
  }

  /**
   * Para una generación NUEVA: null si el curso no exige Prebrief; si lo exige, la versión aprobada y vigente (o 409).
   * `card`: la recomendación que ya calculó el gate de diseño (se reutiliza: misma verificación, sin recalcular).
   */
  async assertApprovedForGeneration(courseId: number, ownerId: string, blueprintNumber: number, card?: any): Promise<{ versionId: string; version: number; generationContext: Record<string, string>; modelSha256: string; productionProfiles: any } | null> {
    try {
      return await this.approvedForGeneration(courseId, ownerId, blueprintNumber, card);
    } catch (err) {
      // Review BE-1 I3: un error transitorio no es «obsoleta»: 503 (reintentar), nunca una invalidación.
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException({ code: 'GENERATION_VERIFICATION_UNAVAILABLE', message: 'GENERATION_VERIFICATION_UNAVAILABLE: no se pudo verificar la propuesta aprobada; vuelve a intentarlo. No se generó nada.' });
    }
  }

  private async approvedForGeneration(courseId: number, ownerId: string, blueprintNumber: number, card?: any): Promise<{ versionId: string; version: number; generationContext: Record<string, string>; modelSha256: string; productionProfiles: any } | null> {
    if (!(await this.requiresPrebrief(this.dataSource, courseId))) return null;
    const reject = (reason: string, extra: Record<string, unknown> = {}): never => {
      const msg: Record<string, string> = {
        prebrief_not_approved: 'el curso no tiene una propuesta de diseño pedagógico aprobada: prepárala y apruébala antes de producir.',
        prebrief_stale: 'la propuesta aprobada ya no corresponde al diseño actual: prepara y aprueba una nueva versión.',
      };
      throw new ConflictException({ code: 'GENERATION_NOT_VERIFIED', reason, message: `GENERATION_NOT_VERIFIED: ${msg[reason]} No se generó nada.`, ...extra });
    };
    let vs: PrebriefVersionRow[];
    try { vs = await this.versions(this.dataSource, courseId); } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException({ code: 'GENERATION_VERIFICATION_UNAVAILABLE', message: 'GENERATION_VERIFICATION_UNAVAILABLE: no se pudo leer la propuesta aprobada; vuelve a intentarlo. No se generó nada.' });
    }
    const latest = vs[0];
    if (!latest || latest.status !== 'approved' || !latest.approval) return reject(vs.some((v) => v.approval) ? 'prebrief_stale' : 'prebrief_not_approved');
    if (Number(latest.blueprint_number) !== Number(blueprintNumber)) return reject('prebrief_stale', { approvedBlueprint: latest.blueprint_number });
    const [course] = await this.dataSource.query(`select current_blueprint_id from public.courses where id = $1`, [courseId]);
    if (!course || Number(course.current_blueprint_id) !== Number(latest.blueprint_id)) return reject('prebrief_stale');
    const c = await this.loadCourse(courseId, ownerId);
    const draft = await this.draftFrom(courseId, c, card || (await this.design.recommend(courseId, ownerId, {} as any)));
    if (draft.modelSha256 !== latest.model_sha256) {
      await this.invalidateIfStale(courseId, draft, ownerId);
      return reject('prebrief_stale', { diff: diffModels(latest.model_json, draft.model) });
    }
    return { versionId: latest.id, version: latest.version, generationContext: latest.model_json.generationContext, modelSha256: latest.model_sha256, productionProfiles: latest.model_json.productionProfiles || null };
  }

  /**
   * Review BE-1 I1: el empaque lee en vivo los perfiles de evaluación y presentación. Si el run nació de una versión
   * aprobada, esos perfiles deben seguir siendo los aprobados (si no, 409: se empaquetaría algo que nadie aprobó).
   * Runs sin versión registrada (anteriores al flujo): sin cambios.
   */
  async assertPackagingMatchesApproval(courseId: number, runId: string): Promise<void> {
    const ok42 = (err: any) => { if (err && err.code === '42P01') return []; throw err; };
    let [ev] = await this.dataSource.query(
      `select v.model_json -> 'productionProfiles' as pp from public.course_prebrief_events e join public.course_prebrief_versions v on v.id = e.version_id
        where e.course_id = $1 and e.type = 'generation_started' and e.payload ->> 'runId' = $2 order by e.id desc limit 1`, [courseId, runId],
    ).catch(ok42);
    if (!ev && (await this.requiresPrebrief(this.dataSource, courseId))) {
      // Review BE-2 m: sin el evento (falló al escribirse), la versión aprobada de ESE Blueprint (la última con aprobación).
      [ev] = await this.dataSource.query(
        `select v.model_json -> 'productionProfiles' as pp from public.course_prebrief_versions v
           join public.course_generation_manifests m on m.blueprint_id = v.blueprint_id
           join public.production_jobs j on (j.input_payload ->> 'manifestId')::int = m.id
          where v.course_id = $1 and j.id::text = $2 and v.approval is not null order by v.version desc limit 1`, [courseId, runId],
      ).catch(ok42);
    }
    if (!ev || !ev.pp) return;
    const pp = parse(ev.pp) as { assessmentSha256: string | null; presentationSha256: string | null; paletteId?: string | null };
    const live = await this.liveProductionProfiles(courseId);
    if (live.assessmentSha256 !== pp.assessmentSha256 || live.presentationSha256 !== pp.presentationSha256 || (pp.paletteId !== undefined && live.paletteId !== pp.paletteId)) {
      throw new ConflictException({ code: 'PREBRIEF_PROFILES_CHANGED', reason: 'prebrief_stale',
        message: 'PREBRIEF_PROFILES_CHANGED: la configuración de evaluación o de presentación cambió después de aprobar la propuesta con la que se produjo este curso; vuelve a esa configuración para empaquetarlo (o produce el curso de nuevo sobre una versión aprobada nueva).' });
    }
  }

  /** Huellas vigentes de lo que el empaque y Gamma leen en vivo: perfiles de evaluación y presentación, y la paleta. */
  async liveProductionProfiles(courseId: number): Promise<{ assessmentSha256: string | null; presentationSha256: string | null; paletteId: string | null }> {
    const rows = await this.dataSource.query(
      `select distinct on (kind) kind, sha256 from public.course_profiles where course_id = $1 and kind in ('assessment', 'presentation') order by kind, version desc`, [courseId],
    ).catch((err: any) => { if (err && err.code === '42P01') return []; throw err; });
    const [c] = await this.dataSource.query(`select metadata from public.courses where id = $1`, [courseId]);
    const now = (k: string) => { const r = rows.find((x: any) => x.kind === k); return r ? String(r.sha256) : null; };
    return { assessmentSha256: now('assessment'), presentationSha256: now('presentation'), paletteId: paletteIdFromCourseMetadata(c ? parse(c.metadata) : null) };
  }

  /** ¿El run nació de una versión aprobada (evento registrado)? */
  async runStartedFromVersion(courseId: number, runId: string): Promise<boolean> {
    const [ev] = await this.dataSource.query(
      `select 1 as x from public.course_prebrief_events where course_id = $1 and type = 'generation_started' and payload ->> 'runId' = $2 limit 1`, [courseId, runId],
    ).catch((err: any) => { if (err && err.code === '42P01') return []; throw err; });
    return !!ev;
  }

  /** Historial: run iniciado con esta versión (auditoría «qué se aprobó y qué se generó»). */
  async recordGenerationStarted(courseId: number, versionId: string, runId: string, actor: string, contextHash: string): Promise<void> {
    // El run ya existe: un fallo al registrar el evento no puede devolver error (el empaque tiene un respaldo por Blueprint).
    try { await this.event(this.dataSource, courseId, versionId, 'generation_started', actor, { runId, contextHash }); } catch (err) {
      this.logger.warn(`evento generation_started del run ${runId} (curso #${courseId}) no se registró: ${(err as Error).message}`);
    }
  }

  async diff(courseId: number, ownerId: string, n: number) {
    const draft = await this.draft(courseId, ownerId);
    const v = (await this.versions(this.dataSource, courseId)).find((x) => x.version === n);
    if (!v) throw new NotFoundException(`El curso #${courseId} no tiene la versión ${n} del Prebrief.`);
    return { version: n, changes: diffModels(v.model_json, draft.model), matches: v.model_sha256 === draft.modelSha256 };
  }

  async events(courseId: number, ownerId: string) {
    await this.loadCourse(courseId, ownerId);
    const rows = await this.dataSource.query(
      `select e.id, e.type, e.actor, e.payload, e.at, v.version from public.course_prebrief_events e left join public.course_prebrief_versions v on v.id = e.version_id
        where e.course_id = $1 order by e.id`, [courseId]);
    return rows.map((r: any) => ({ id: Number(r.id), type: r.type, version: r.version, payload: parse(r.payload), at: iso(r.at) }));
  }
}
