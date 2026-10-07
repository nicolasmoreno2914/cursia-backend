import { loadDesignPins } from '../course-design/design-pins';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { academicOutcomeIds } from './academic-context';
import { loadCurrentAcademicContext } from './academic-db';
import { proposeStructureFromContext, suggestOutcomeLinks, suggestProfileFromContext } from './context-design';
import { DocumentReadError } from './extract/text-sources';
import { extractAcademicContext } from './extract/extractor';
import { validateAcademicContext } from './validate';
import { ExtractAcademicContextDto, ExtractAdvancedDto, OutcomesDto, ProposalDto } from './dto/extract.dto';
import { ProposedContextError, buildProposedContext, rewriteOutcomes } from './proposed-context';
import { CourseProfilesService } from '../course-profiles/course-profiles.service';
import { extractionQuality } from './extraction-quality';
import { readPdf } from './extract/text-sources';
import {
  ADVANCED_EXTRACTION_OPERATION,
  ADVANCED_MAX_PAGES,
  AnthropicTranscriber,
  DocumentTranscriber,
  advancedExtractionEnabled,
  advancedExtractionModel,
  estimateAdvancedExtraction,
} from './advanced-extraction';
import { FinopsLedgerService } from '../finops/finops-ledger.service';

/** Token de inyección del transcriptor (las pruebas inyectan uno falso). */
export const DOCUMENT_TRANSCRIBER = 'DOCUMENT_TRANSCRIBER';

/**
 * Fase 3 — Contexto académico: extracción (sin guardar) y diseño desde el contexto guardado. Sin proveedores
 * (USD 0), sin escrituras: guardar el contexto es POST /courses/:id/profiles/academic (versionado); aplicar las
 * sugerencias usa las APIs de siempre (perfil pedagógico, estructura).
 */
@Injectable()
export class AcademicContextService {
  private readonly logger = new Logger(AcademicContextService.name);
  /** Cursos con una lectura avanzada en curso (por proceso; la API de staging corre en una sola instancia). */
  private static readonly advancedInFlight = new Set<number>();
  private readonly transcriber: DocumentTranscriber;

  constructor(
    private readonly dataSource: DataSource,
    private readonly coursesService: CoursesService,
    @Optional() private readonly ledger?: FinopsLedgerService,
    @Optional() @Inject(DOCUMENT_TRANSCRIBER) transcriber?: DocumentTranscriber,
    @Optional() private readonly profiles?: CourseProfilesService,
  ) {
    this.transcriber = transcriber || new AnthropicTranscriber();
  }

  private async loadCourse(courseId: number, ownerId: string): Promise<void> {
    const course = await this.coursesService.findOne(courseId, ownerId); // 404 si no es suyo
    if (course.structureVersion !== 'dynamic') {
      throw new BadRequestException(`El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`);
    }
  }

  async extract(courseId: number, ownerId: string, dto: ExtractAcademicContextDto) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const inputs = dto.files.map((f) => ({ name: f.name, data: Buffer.from(f.dataBase64, 'base64') }));
    try {
      const r = await extractAcademicContext(inputs);
      // LOOP 8.1: cargador único — se informa si la lectura gratuita alcanzó y si la avanzada puede ayudar.
      const quality = extractionQuality(r.context);
      return {
        draft: r.context, validation: validateAcademicContext(r.context), notes: r.notes, stats: r.stats, saved: false,
        quality: { ...quality, advancedAvailable: quality.advancedMayHelp && advancedExtractionEnabled() },
      };
    } catch (err) {
      if (err instanceof DocumentReadError) throw new BadRequestException({ code: err.code, message: `${err.code}: ${err.message}` });
      if (err instanceof Error && /^ACADEMIC_/.test(err.message)) throw new BadRequestException(err.message.slice(0, 500));
      throw err;
    }
  }

  /**
   * LOOP 8.1 · Lectura avanzada (respaldo del cargador único). 'estimate' no llama a ningún proveedor; 'run' exige
   * haber aceptado el costo máximo estimado, transcribe el PDF con IA y lo pasa por el MISMO extractor determinista.
   * El gasto se registra en FinOps aunque la lectura falle después. Nada se guarda: igual que /extract.
   */
  async extractAdvanced(courseId: number, ownerId: string, dto: ExtractAdvancedDto) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const f = dto.files[0];
    const pdf = Buffer.from(f.dataBase64, 'base64');
    if (!/\.pdf$/i.test(f.name) && pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException({ code: 'ADVANCED_ONLY_PDF', message: 'ADVANCED_ONLY_PDF: la lectura avanzada es para PDF (escaneados o difíciles de leer); los Word se leen sin costo.' });
    }
    let pages: number;
    try {
      pages = (await readPdf(pdf)).pages || 1;
    } catch (err) {
      if (err instanceof DocumentReadError) throw new BadRequestException({ code: err.code, message: `${err.code}: ${err.message}` });
      throw err;
    }
    if (pages > ADVANCED_MAX_PAGES) {
      throw new BadRequestException({ code: 'ADVANCED_TOO_MANY_PAGES', message: `ADVANCED_TOO_MANY_PAGES: el documento tiene ${pages} páginas; la lectura avanzada admite hasta ${ADVANCED_MAX_PAGES}.` });
    }
    const estimate = estimateAdvancedExtraction(pages);
    if (dto.mode === 'estimate') return { available: advancedExtractionEnabled(), ...estimate, providersCalled: 0 };
    if (!advancedExtractionEnabled()) {
      throw new ConflictException({ code: 'ADVANCED_DISABLED', message: 'ADVANCED_DISABLED: la lectura avanzada no está activada en este entorno.' });
    }
    if (typeof dto.acceptedMaxUsd !== 'number' || dto.acceptedMaxUsd < estimate.estimateUsd.max) {
      throw new ConflictException({ code: 'ESTIMATE_NOT_ACCEPTED', estimate, message: 'ESTIMATE_NOT_ACCEPTED: acepta el costo estimado antes de leer el documento.' });
    }
    // Review L81 M3: una lectura avanzada a la vez por curso (dos pestañas no pagan dos veces).
    if (AcademicContextService.advancedInFlight.has(courseId)) {
      throw new ConflictException({ code: 'ADVANCED_IN_PROGRESS', message: 'ADVANCED_IN_PROGRESS: ya hay una lectura avanzada en curso para este curso.' });
    }
    AcademicContextService.advancedInFlight.add(courseId);
    let t;
    try {
      t = await this.transcriber.transcribe({ name: f.name, pdf, model: advancedExtractionModel() });
      await this.recordAdvancedCharge(courseId, ownerId, pages, t);
    } finally {
      AcademicContextService.advancedInFlight.delete(courseId);
    }
    if (t.truncated) {
      throw new BadRequestException({ code: 'ADVANCED_TRUNCATED', message: 'ADVANCED_TRUNCATED: el documento es demasiado largo para leerlo completo; divide el PDF y vuelve a intentarlo.' });
    }
    if (!t.text || t.text.replace(/\[ilegible\]/g, '').trim().length < 40) {
      throw new BadRequestException({ code: 'ADVANCED_UNREADABLE', message: 'ADVANCED_UNREADABLE: tampoco la lectura avanzada pudo leer el documento.' });
    }
    const base = f.name.replace(/\.pdf$/i, '');
    const r = await extractAcademicContext([{ name: `${base} (lectura avanzada).md`, data: Buffer.from(t.text, 'utf8') }]);
    const quality = extractionQuality(r.context);
    return {
      draft: r.context, validation: validateAcademicContext(r.context), notes: r.notes, stats: r.stats, saved: false,
      quality: { ...quality, advancedAvailable: false },
      advanced: { pages, model: t.model, usage: t.usage, estimateUsd: estimate.estimateUsd },
    };
  }

  private async recordAdvancedCharge(courseId: number, ownerId: string, pages: number, t: { model: string; messageId: string; usage: { input_tokens: number; output_tokens: number } }) {
    if (!this.ledger) {
      this.logger.error(`Lectura avanzada del curso #${courseId}: sin FinOps, el gasto NO quedó registrado (${t.messageId}).`);
      return;
    }
    try {
      await this.ledger.recordCharge({
        ownerIdFromAuth: ownerId,
        provider: 'anthropic',
        service: 'messages',
        modelOrProduct: t.model,
        operation: ADVANCED_EXTRACTION_OPERATION,
        usage: { input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, cache_write_tokens: 0, cache_read_tokens: 0 },
        usageUnit: 'output_tokens',
        externalOperationId: t.messageId,
        idempotency: { kind: 'anthropic', parts: { messageId: t.messageId } },
        callRole: 'main',
        attempt: 1,
        billingAccount: 'cursia',
        mode: 'real',
        recordedBy: 'academic-advanced-extraction',
        pricingFallback: 'pending_zero',
        metadata: { courseId, pages },
      } as any);
    } catch (err) {
      this.logger.error(`Lectura avanzada del curso #${courseId}: no se pudo registrar el gasto (${t.messageId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * LOOP 8.2 · Sin documento: lo que Cursia entendió del pedido queda como contexto académico propuesto (`inferred`).
   * Se guarda por el camino de siempre (perfil versionado: deriva el perfil pedagógico, poda vínculos). 409
   * DOCUMENT_CONTEXT si el contexto vigente viene de un documento (el documento manda).
   */
  async saveProposal(courseId: number, ownerId: string, dto: ProposalDto) {
    return this.saveBuilt(courseId, ownerId, dto.expectedVersion, (current) => buildProposedContext(current, dto));
  }

  /** LOOP 8.2 · «Editar» / «Sí, usar estos» de los resultados en «Lo que entendimos» (ids y orígenes conservados). */
  async saveOutcomes(courseId: number, ownerId: string, dto: OutcomesDto) {
    return this.saveBuilt(courseId, ownerId, dto.expectedVersion, (current) => rewriteOutcomes(current, dto.outcomes, dto.accept === true));
  }

  private async saveBuilt(courseId: number, ownerId: string, expectedVersion: number, build: (current: any) => any) {
    assertDynamicOwnerAllowed(ownerId);
    if (!this.profiles) throw new Error('CourseProfilesService no disponible');
    await this.loadCourse(courseId, ownerId);
    const current = await loadCurrentAcademicContext(this.dataSource, courseId);
    // La versión leída debe ser la que el cliente vio (el guardado vuelve a comprobarla dentro de su transacción).
    if ((current ? current.version : 0) !== expectedVersion) {
      throw new ConflictException(`ACADEMIC_CHANGED: el contexto académico cambió (versión ${current ? current.version : 0}); vuelve a leerlo antes de guardar.`);
    }
    let ctx;
    try {
      ctx = build(current ? current.context : null);
    } catch (err) {
      if (err instanceof ProposedContextError) {
        if (err.code === 'DOCUMENT_CONTEXT' || err.code === 'USER_CONTEXT') throw new ConflictException(err.message);
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    return this.profiles.append(courseId, ownerId, 'academic', ctx, expectedVersion);
  }

  /**
   * Lo que el contexto GUARDADO propone para el diseño: sugerencias al perfil pedagógico (sobre el perfil vigente),
   * estructura desde el microcurrículo y vínculos para la estructura actual. Solo lectura.
   */
  async design(courseId: number, ownerId: string) {
    await this.loadCourse(courseId, ownerId);
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId);
    if (!academic) {
      return { available: false, reason: 'NO_ACADEMIC_CONTEXT', contextVersion: 0, validation: null, profileSuggestion: null, structureProposal: null, outcomeLinks: [] };
    }
    const validation = validateAcademicContext(academic.context);
    if (!validation.canProceed) {
      return { available: false, reason: 'CONTEXT_HAS_ERRORS', contextVersion: academic.version, validation, profileSuggestion: null, structureProposal: null, outcomeLinks: [] };
    }
    const ped = await loadCurrentPedagogicalProfile(this.dataSource, courseId);
    const chapters: { id: string; module_id: string; title: string; objective: string | null; description: string | null; outcome_ids: unknown; kind: string | null }[] = await this.dataSource.query(
      `select ch.id, ch.module_id, ch.title, ch.objective, ch.description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids, to_jsonb(ch) ->> 'chapter_kind' as kind
         from public.course_chapters ch join public.course_modules m on m.id = ch.module_id
        where ch.course_id = $1 order by m.position, ch.position, ch.id`,
      [courseId],
    );
    const known = academicOutcomeIds(academic.context);
    // Review L84-2 N5: lo mismo que la vinculación automática de la verificación — nunca se sugiere vincular un capítulo de
    // práctica ni uno que el docente desvinculó a propósito.
    const pins = await loadDesignPins(this.dataSource, courseId);
    const noSuggest = new Set(chapters.filter((c) => c.kind === 'practice' || (pins[c.id] && pins[c.id].noLinks)).map((c) => c.id));
    return {
      available: true,
      reason: null,
      contextVersion: academic.version,
      contextSha256: academic.sha256,
      // Review I2: versión del perfil pedagógico sobre la que se calculó la sugerencia (expectedVersion al aplicarla:
      // si el docente guardó otra versión mientras tanto, 409 y se recalcula — nunca se pisan sus cambios).
      pedagogyVersion: ped ? ped.version : 0,
      validation,
      profileSuggestion: suggestProfileFromContext(academic.context, ped ? ped.profile : null),
      structureProposal: proposeStructureFromContext(academic.context),
      outcomeLinks: suggestOutcomeLinks(
        academic.context,
        chapters.map((c) => ({
          id: c.id, moduleId: c.module_id, title: c.title, objective: c.objective, description: c.description,
          // Un vínculo a un resultado que ya no existe en el contexto no cuenta como «decisión del docente».
          outcomeIds: Array.isArray(c.outcome_ids) ? (c.outcome_ids as string[]).filter((x) => known.has(x)) : null,
        })),
      ).map((s) => (s.status === 'inferred' && noSuggest.has(s.chapterId) ? { ...s, suggested: s.current, status: 'none' as const } : s)),
      providersCalled: 0,
    };
  }
}
