import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { effectiveOutputRowsSql } from '../dynamic-generation/item-generations';
import { CourseBlueprintsService } from '../course-blueprints/course-blueprints.service';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { loadArtifactText } from '../dynamic-packaging/artifact-resolver';
import type { ResolvedArtifact } from '../dynamic-packaging/packaging-types';
import { assertCoherenceLlmAllowed, assertDynamicOwnerAllowed } from '../features/dynamic-features';
import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { sha256Canonical } from './canonical-json';
import { COHERENCE_RULESET, COHERENCE_VERSION, ContextSummaryInput, CoursePlanInput } from './coherence-types';
import { CoherenceReport, buildCoherenceReport, deterministicReportSha256 } from './report';
import {
  CompactLlmInput,
  LLM_INPUT_CONCEPT_CHARS,
  LLM_INPUT_COURSE_TITLE_CHARS,
  LLM_INPUT_LEVELS,
  LLM_INPUT_MAX_CHARS,
  buildCompactLlmInput,
  mergeLlmFindings,
} from './llm-merge';
import { LlmFindingsDto, StructureCoherenceDto } from './dto/coherence.dto';

export const COHERENCE_REPORT_ARTIFACT_TYPE = 'dynamic_coherence_report_json';

/** Fix wave I1: tope de reportes LLM distintos por run y por hora (env COHERENCE_LLM_REPORTS_PER_HOUR, default 10). */
export function llmReportsPerHour(): number {
  const raw = Number(process.env.COHERENCE_LLM_REPORTS_PER_HOUR);
  return Number.isInteger(raw) && raw > 0 ? raw : 10;
}

export interface StructureCoherenceResponse {
  source: 'live' | 'blueprint';
  blueprintNumber: number | null;
  ruleset: string;
  reportSha256: string;
  blueprintSha256: string;
  findings: CoherenceReport['findings'];
}

interface RunCoherenceInputs {
  blueprint: BlueprintSnapshotV1;
  coursePlan: CoursePlanInput | null;
  coursePlanArtifactId: string | null;
  contextSummaries: Record<string, ContextSummaryInput> | null;
  contextSummaryArtifactIds: string[];
  declaredPriorConcepts: string[] | null;
}

/** F78-BE2: respuesta de GET …/runs/:runId/coherence/llm-input (contrato para el FE). */
export interface LlmInputResponse {
  runId: string;
  blueprintNumber: number;
  llmInputVersion: number;
  /** Tope total del JSON (caracteres). */
  maxChars: number;
  /** Largo real de `json` (≤ maxChars). */
  chars: number;
  /** 0 = sin recortes; >0 = nivel de `caps.levels` aplicado. */
  compactionLevel: number;
  /** sha256 hex de `json` (el FE puede usarlo para su promptSha256). */
  promptInputSha256: string;
  caps: {
    summaryChars: number;
    maxConceptsPerList: number;
    conceptChars: number;
    textChars: number;
    courseTitleChars: number;
    levels: Array<{ summaryChars: number; maxConcepts: number; textChars: number }>;
  };
  sources: {
    coursePlanArtifactId: string | null;
    contextSummaryArtifactIds: string[];
    /** Capítulos (UUID) sin sidecar real (p.ej. contextSummary='missing'). */
    chaptersWithoutRealSummary: string[];
  };
  /** Documento compacto ya parseado (= JSON.parse(json)). */
  input: any;
  /** El mismo documento serializado (lo que se manda al LLM; mide `chars`). */
  json: string;
}

export interface RunCoherenceResponse {
  created: boolean;
  artifactId: string;
  source: 'deterministic' | 'llm';
  report: CoherenceReport;
}

/**
 * Fase 7 (F7-BE): Coherence Engine sobre la DB. Solo EVALÚA: nunca modifica
 * contenido, Blueprints, Manifests ni runs. Las reglas son las funciones
 * puras de este módulo (`structural.ts`, `content.ts`, `report.ts`).
 *
 * - Estructural: sobre la estructura viva o un Blueprint; no persiste.
 * - Contenido (por run): Blueprint + `course_plan` (v2) + sidecars
 *   `dynamic_context_summary_json`, todo enlazado por `item_run_id` al run.
 *   Persiste un artifact inmutable `dynamic_coherence_report_json` (ruta nueva
 *   por cálculo, con el hash en el path) y es idempotente por `reportSha256`.
 * - LLM: merge de findings subidos por el navegador; los UUIDs inventados se
 *   descartan y se cuentan; se guarda un reporte nuevo `source:'llm'`.
 */
@Injectable()
export class CoherenceService {
  private readonly logger = new Logger(CoherenceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly blueprints: CourseBlueprintsService,
    private readonly manifests: GenerationManifestsService,
    private readonly artifacts: ArtifactsService,
  ) {}

  async structure(courseId: number, ownerId: string, dto: StructureCoherenceDto): Promise<StructureCoherenceResponse> {
    assertDynamicOwnerAllowed(ownerId);
    const n = dto?.blueprintNumber;
    const snapshot = n ? (await this.blueprints.getByNumber(courseId, ownerId, n)).snapshot : await this.blueprints.liveSnapshot(courseId, ownerId);
    const report = buildCoherenceReport({ blueprint: snapshot, layers: { structural: true, content: false } });
    return {
      source: n ? 'blueprint' : 'live',
      blueprintNumber: n ?? null,
      ruleset: report.ruleset,
      reportSha256: report.reportSha256,
      blueprintSha256: report.inputs.blueprintSha256,
      findings: report.findings,
    };
  }

  /** POST …/runs/:runId/coherence — calcula, persiste (idempotente por reportSha256) y responde. */
  async computeRunReport(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RunCoherenceResponse> {
    assertDynamicOwnerAllowed(ownerId);
    const { job, manifest } = await this.runOf(courseId, ownerId, blueprintNumber, runId);
    const report = await this.buildDeterministicReport(job, manifest, ownerId, blueprintNumber);
    return this.persist(job, manifest, report, 'deterministic', report.reportSha256, {});
  }

  /** GET …/runs/:runId/coherence — último reporte guardado del run (determinístico o LLM). */
  async latest(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RunCoherenceResponse> {
    assertDynamicOwnerAllowed(ownerId);
    const { job } = await this.runOf(courseId, ownerId, blueprintNumber, runId);
    const [row] = await this.dataSource.query(
      `select id, metadata from public.artifacts
        where type = $1 and job_id = $2 and owner_id = $3
        order by created_at desc, id desc limit 1`,
      [COHERENCE_REPORT_ARTIFACT_TYPE, job.id, ownerId],
    );
    if (!row) throw new NotFoundException(`La ejecución ${runId} todavía no tiene reporte de coherencia (calculalo con POST)`);
    const report = await this.readReport(row.id, ownerId, runId);
    if (report.reportSha256 !== row.metadata?.reportSha256) {
      throw new InternalServerErrorException(`Reporte de coherencia ${row.id}: el hash guardado no coincide con su metadata (integridad rota)`);
    }
    return { created: false, artifactId: row.id, source: row.metadata?.source === 'llm' ? 'llm' : 'deterministic', report };
  }

  /** POST …/runs/:runId/coherence/llm-findings — merge LLM sobre el reporte determinístico del run. */
  async mergeLlm(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    dto: LlmFindingsDto,
  ): Promise<RunCoherenceResponse> {
    assertDynamicOwnerAllowed(ownerId);
    // F78-BE2 (ruling controller): el merge LLM también exige coherenceLlm
    // (DYNAMIC_COHERENCE_LLM === 'true'), 403 fail closed antes de tocar la DB.
    assertCoherenceLlmAllowed(ownerId);
    const { job, manifest } = await this.runOf(courseId, ownerId, blueprintNumber, runId);
    const base = await this.buildDeterministicReport(job, manifest, ownerId, blueprintNumber);
    const baseSaved = await this.persist(job, manifest, base, 'deterministic', base.reportSha256, {});
    const bp = await this.blueprints.getByNumber(courseId, ownerId, blueprintNumber);
    const merged = mergeLlmFindings(base, bp.snapshot, {
      model: dto.model,
      promptSha256: dto.promptSha256,
      findings: dto.findings as any[],
    });
    const llmSha = sha256Canonical(merged);
    return this.persist(job, manifest, merged, 'llm', llmSha, {
      baseArtifactId: baseSaved.artifactId,
      model: merged.llm.model,
      promptSha256: merged.llm.promptSha256,
      accepted: merged.llm.accepted,
      droppedInvalidIds: merged.llm.droppedInvalidIds,
      droppedMalformed: merged.llm.droppedMalformed,
    });
  }

  /**
   * F78-BE2: GET …/runs/:runId/coherence/llm-input — entrada COMPACTA para
   * la revisión de coherencia con IA que corre en el navegador. Contiene
   * solo: outline por UUID (módulos/capítulos en orden, títulos, objetivos),
   * resúmenes y conceptos PLANEADOS del course_plan y los sidecars REALES
   * `context_summary` por capítulo (generación vigente). Nunca el contenido
   * completo de capítulos, SCORM ni exámenes.
   *
   * Topes (buildCompactLlmInput): total ≤ LLM_INPUT_MAX_CHARS (24 000) de
   * JSON; por capítulo, en el nivel 0: resumen ≤ 400, ≤ 20 conceptos por lista
   * de ≤ 80, títulos/objetivos ≤ 300 — si no entra, se compacta por niveles
   * (`caps.levels`) sin perder ningún módulo ni capítulo. Si ni el outline
   * mínimo entra → 422.
   *
   * Gates: allow-list V2 + DYNAMIC_COHERENCE_LLM (403, fail closed),
   * ownership (404), run completed (409). Solo lectura: no persiste nada.
   */
  async llmInput(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<LlmInputResponse> {
    assertDynamicOwnerAllowed(ownerId);
    assertCoherenceLlmAllowed(ownerId);
    const { job, manifest } = await this.runOf(courseId, ownerId, blueprintNumber, runId);
    const inputs = await this.loadRunInputs(job, manifest, ownerId, blueprintNumber);
    let compact: CompactLlmInput;
    try {
      compact = buildCompactLlmInput({
        blueprint: inputs.blueprint,
        coursePlan: inputs.coursePlan,
        contextSummaries: inputs.contextSummaries,
        maxChars: LLM_INPUT_MAX_CHARS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('COHERENCE_LLM_INPUT_TOO_LARGE')) throw new UnprocessableEntityException(msg);
      throw err;
    }
    const chapterIds = inputs.blueprint.modules.flatMap((m) => m.chapters.map((c) => c.id));
    const withReal = new Set(Object.keys(inputs.contextSummaries ?? {}));
    const level0 = LLM_INPUT_LEVELS[0];
    return {
      runId: job.id,
      blueprintNumber,
      llmInputVersion: compact.llmInputVersion,
      maxChars: LLM_INPUT_MAX_CHARS,
      chars: compact.chars,
      compactionLevel: compact.compactionLevel,
      promptInputSha256: compact.promptInputSha256,
      caps: {
        summaryChars: level0.summaryChars,
        maxConceptsPerList: level0.maxConcepts,
        conceptChars: LLM_INPUT_CONCEPT_CHARS,
        textChars: level0.textChars,
        courseTitleChars: LLM_INPUT_COURSE_TITLE_CHARS,
        levels: LLM_INPUT_LEVELS.map((l) => ({ ...l })),
      },
      sources: {
        coursePlanArtifactId: inputs.coursePlanArtifactId,
        contextSummaryArtifactIds: [...inputs.contextSummaryArtifactIds].sort(),
        chaptersWithoutRealSummary: chapterIds.filter((id) => !withReal.has(id)),
      },
      input: JSON.parse(compact.json),
      json: compact.json,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Run de este curso con su Manifest congelado (verifica dueño, `dynamic` y pertenencia al Blueprint `n`). */
  private async runOf(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<{ job: any; manifest: ManifestDto }> {
    const [job] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2`,
      [runId, courseId],
    );
    const manifestId = Number(job?.input_payload?.manifestId);
    if (!job || !Number.isInteger(manifestId)) {
      await this.manifests.assertBlueprintAccessible(courseId, ownerId, blueprintNumber);
      throw new NotFoundException(`La ejecución ${runId} no existe para el Blueprint v${blueprintNumber} del curso #${courseId}`);
    }
    const manifest = await this.manifests.getById(courseId, ownerId, blueprintNumber, manifestId);
    if (job.owner_id !== ownerId) throw new NotFoundException(`La ejecución ${runId} no existe para el Blueprint v${blueprintNumber} del curso #${courseId}`);
    return { job, manifest };
  }

  private async buildDeterministicReport(job: any, manifest: ManifestDto, ownerId: string, blueprintNumber: number): Promise<CoherenceReport> {
    const inputs = await this.loadRunInputs(job, manifest, ownerId, blueprintNumber);
    return buildCoherenceReport({
      blueprint: inputs.blueprint,
      coursePlan: inputs.coursePlan,
      contextSummaries: inputs.contextSummaries,
      declaredPriorConcepts: inputs.declaredPriorConcepts,
      manifest: manifest.manifest,
    });
  }

  /**
   * Inputs de coherencia de un run COMPLETED (nunca salida parcial): Blueprint
   * del run + `course_plan` (v2: exactamente 1) + sidecars
   * `dynamic_context_summary_json` REALES por capítulo, de la generación
   * completed vigente de cada item (F78-BE2: una regeneración reemplaza a la
   * anterior), excluyendo artifacts `disabled`.
   */
  private async loadRunInputs(job: any, manifest: ManifestDto, ownerId: string, blueprintNumber: number): Promise<RunCoherenceInputs> {
    if (job.worker_status !== 'completed') {
      throw new ConflictException(
        `La ejecución ${job.id} no está completada (worker_status=${job.worker_status}); la coherencia de contenido se ` +
          'calcula sobre un run terminado (nunca sobre salida parcial).',
      );
    }
    const bp = await this.blueprints.getByNumber(job.course_id, ownerId, blueprintNumber);
    const rows: Array<{ item_key: string; chapter_id: string | null; artifact_id: string; artifact_type: string; storage_bucket: string; storage_path: string; mime_type: string | null; item_run_id: string }> =
      await this.dataSource.query(
        `select g.item_key, g.chapter_id, g.id as item_run_id, a.id as artifact_id, a.type as artifact_type,
                a.storage_bucket, a.storage_path, a.mime_type
           from ${effectiveOutputRowsSql('$1')} g
           join public.artifacts a on a.item_run_id = g.id and a.status is distinct from 'disabled'
          where g.status = 'completed'
            and a.type in ('dynamic_course_plan_json', 'dynamic_context_summary_json')
          order by g.item_key, a.id`,
        [job.id],
      );
    const asResolved = (r: (typeof rows)[number]): ResolvedArtifact =>
      ({
        itemKey: r.item_key,
        itemRunId: r.item_run_id,
        artifactId: r.artifact_id,
        type: r.artifact_type as any,
        storageBucket: r.storage_bucket,
        storagePath: r.storage_path,
        mimeType: r.mime_type,
      }) as ResolvedArtifact;

    let coursePlan: CoursePlanInput | null = null;
    const planRows = rows.filter((r) => r.artifact_type === 'dynamic_course_plan_json');
    if (manifest.rulesVersion === 2) {
      if (planRows.length !== 1) {
        throw new ConflictException(
          `La ejecución ${job.id} (rulesVersion 2) debe tener exactamente 1 dynamic_course_plan_json vinculado; tiene ${planRows.length}`,
        );
      }
      coursePlan = this.parseJson(await loadArtifactText(this.artifacts, ownerId, asResolved(planRows[0])), planRows[0]);
      if (!coursePlan || typeof coursePlan !== 'object' || !coursePlan.chapters) {
        throw new ConflictException(`El course_plan ${planRows[0].artifact_id} no tiene la forma esperada (sin "chapters")`);
      }
    }

    let contextSummaries: Record<string, ContextSummaryInput> | null = null;
    const contextSummaryArtifactIds: string[] = [];
    for (const r of rows.filter((x) => x.artifact_type === 'dynamic_context_summary_json')) {
      if (!r.chapter_id || !r.item_key.startsWith('content:')) {
        throw new ConflictException(`El sidecar ${r.artifact_id} está vinculado a ${r.item_key}, que no es un content de capítulo`);
      }
      const s = this.parseJson(await loadArtifactText(this.artifacts, ownerId, asResolved(r)), r);
      if (s?.chapterId && s.chapterId !== r.chapter_id) {
        throw new ConflictException(
          `El sidecar ${r.artifact_id} declara chapterId=${s.chapterId} pero su item es del capítulo ${r.chapter_id} (identidad por UUID rota)`,
        );
      }
      contextSummaries = contextSummaries ?? {};
      contextSummaryArtifactIds.push(r.artifact_id);
      contextSummaries[r.chapter_id] = {
        summary: s?.summary ?? null,
        concepts_introduced: Array.isArray(s?.concepts_introduced) ? s.concepts_introduced : null,
        concepts_assumed: Array.isArray(s?.concepts_assumed) ? s.concepts_assumed : null,
        key_terms: Array.isArray(s?.key_terms) ? s.key_terms : null,
      };
    }

    const [ctx] = await this.dataSource.query(`select context from public.generation_run_contexts where job_id = $1`, [job.id]);
    const caps = ctx?.context?.prevCourse?.caps;
    const declaredPriorConcepts = Array.isArray(caps) && caps.length > 0 ? caps.map(String) : null;

    return {
      blueprint: bp.snapshot,
      coursePlan,
      coursePlanArtifactId: coursePlan ? planRows[0].artifact_id : null,
      contextSummaries,
      contextSummaryArtifactIds,
      declaredPriorConcepts,
    };
  }

  private parseJson(text: string, r: { artifact_id: string; item_key: string }): any {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ConflictException(`El artifact ${r.artifact_id} (${r.item_key}) no es JSON válido: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Guarda el reporte como artifact inmutable (ruta con el hash) salvo que ya
   * exista uno con la misma clave (idempotencia).
   *
   * Fix wave M4: el advisory lock es de TRANSACCIÓN y solo envuelve el chequeo
   * y el INSERT de la fila (nunca la subida HTTP a Storage):
   *   1. tx corta + lock: ¿ya existe? → se devuelve (y, si es LLM, tope por hora);
   *   2. subida del objeto SIN lock (ruta direccionada por contenido,
   *      upsert:false; un "already exists" de otra subida concurrente se adopta);
   *   3. tx corta + lock: re-chequeo (otra request pudo insertar) y INSERT.
   * Fix wave I1: más de COHERENCE_LLM_REPORTS_PER_HOUR (default 10) reportes
   * LLM distintos por run en la última hora → 429; repetir uno ya guardado
   * sigue siendo idempotente (200).
   */
  private async persist(
    job: any,
    manifest: ManifestDto,
    report: CoherenceReport,
    source: 'deterministic' | 'llm',
    key: string,
    extraMeta: Record<string, any>,
  ): Promise<RunCoherenceResponse> {
    const first = await this.lockedStep(job, source, key, null);
    if (first) return { created: false, artifactId: first, source, report };

    const artifactCourseId = job.frontend_course_id ?? String(job.course_id);
    const file = source === 'llm' ? `llm-${key}.json` : `${key}.json`;
    const storagePath = `${job.owner_id}/dynamic/${artifactCourseId}/${manifest.id}/coherence/${job.id}/${file}`;
    const buffer = Buffer.from(JSON.stringify(report, null, 2));
    const put = await this.artifacts.putStorageObject({
      storagePath,
      buffer,
      mimeType: 'application/json',
      // Ruta direccionada por contenido → inmutable: nunca se sobrescribe.
      upsert: false,
      adoptExistingOnConflict: true,
    });
    const metadata = {
      runId: job.id,
      manifestId: manifest.id,
      source,
      reportSha256: report.reportSha256,
      ...(source === 'llm' ? { llmReportSha256: key } : {}),
      coherenceVersion: COHERENCE_VERSION,
      ruleset: COHERENCE_RULESET,
      findingCount: report.findings.length,
      ...(put.adopted ? { adoptedExistingObject: true } : {}),
      ...extraMeta,
    };
    let createdId: string | null = null;
    const existing = await this.lockedStep(job, source, key, async (qr) => {
      const [row] = await qr.query(
        `insert into public.artifacts
           (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, size_bytes, metadata)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, $6, 'application/json', $7, $8::jsonb)
         returning id`,
        [job.owner_id, artifactCourseId, job.id, COHERENCE_REPORT_ARTIFACT_TYPE, storagePath, file, put.sizeBytes, JSON.stringify(metadata)],
      );
      createdId = row.id;
    });
    if (existing) return { created: false, artifactId: existing, source, report };
    this.logger.log(`coherence: reporte ${source} ${key.slice(0, 12)}… guardado para el run ${job.id} (artifact ${createdId})`);
    return { created: true, artifactId: createdId!, source, report };
  }

  /**
   * Transacción corta con `pg_advisory_xact_lock` por run: devuelve el id de
   * un reporte ya guardado con la misma clave; si no hay y es LLM, aplica el
   * tope por hora (429); si no hay y `insert` viene, lo ejecuta dentro del lock.
   */
  private async lockedStep(
    job: any,
    source: 'deterministic' | 'llm',
    key: string,
    insert: ((qr: { query: (sql: string, params?: any[]) => Promise<any> }) => Promise<void>) | null,
  ): Promise<string | null> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`coherence:${job.id}`]);
      const keyField = source === 'llm' ? 'llmReportSha256' : 'reportSha256';
      const [existing] = await qr.query(
        `select id from public.artifacts
          where type = $1 and job_id = $2 and owner_id = $3 and metadata->>'source' = $4 and metadata->>$5 = $6
          order by created_at asc, id asc limit 1`,
        [COHERENCE_REPORT_ARTIFACT_TYPE, job.id, job.owner_id, source, keyField, key],
      );
      if (existing) {
        await qr.commitTransaction();
        return existing.id;
      }
      if (source === 'llm') {
        const limit = llmReportsPerHour();
        const [{ n }] = await qr.query(
          `select count(*)::int as n from public.artifacts
            where type = $1 and job_id = $2 and metadata->>'source' = 'llm' and created_at > now() - interval '1 hour'`,
          [COHERENCE_REPORT_ARTIFACT_TYPE, job.id],
        );
        if (n >= limit) {
          throw new HttpException(
            `Demasiados reportes de coherencia LLM para la ejecución ${job.id} (${n} en la última hora, tope ${limit}); ` +
              'probá más tarde.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
      if (insert) await insert(qr);
      await qr.commitTransaction();
      return null;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  private async readReport(artifactId: string, ownerId: string, runId: string): Promise<CoherenceReport> {
    const text = await loadArtifactText(this.artifacts, ownerId, {
      itemKey: `coherence:${runId}`,
      itemRunId: '',
      artifactId,
      type: COHERENCE_REPORT_ARTIFACT_TYPE as any,
      storageBucket: '',
      storagePath: '',
      mimeType: 'application/json',
    });
    const report = JSON.parse(text) as CoherenceReport;
    const det = deterministicReportSha256({ ...report, findings: (report.findings ?? []).filter((f) => f.source === 'deterministic') });
    if (det !== report.reportSha256) {
      throw new InternalServerErrorException(`Reporte de coherencia ${artifactId}: la parte determinística no coincide con reportSha256 (integridad rota)`);
    }
    return report;
  }
}
