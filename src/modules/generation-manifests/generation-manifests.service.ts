import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { BlueprintDto, CourseBlueprintsService } from '../course-blueprints/course-blueprints.service';
import {
  GenerationManifestV1,
  MANIFEST_SCHEMA_VERSION,
  ManifestRulesVersion,
  ManifestSource,
  ManifestTotals,
  ManifestValidationError,
  buildGenerationManifest,
  canonicalManifestJson,
  manifestSha256,
  validateGenerationManifest,
} from './generation-manifest-builder';
import { readManifestRulesVersionConfig } from './manifest-rules-config';

export interface ManifestDto {
  id: number;
  courseId: number;
  blueprintId: number;
  blueprintNumber: number;
  rulesVersion: number;
  manifestSchemaVersion: number;
  manifest: GenerationManifestV1;
  sha256: string;
  blueprintSha256: string;
  totals: ManifestTotals;
  createdAt: string;
  createdBy: string | null;
}

function toIso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function describeErrors(errors: ManifestValidationError[]): string {
  const codes = [...new Set(errors.map((e) => e.code))].join(', ');
  const detail = errors.slice(0, 5).map((e) => `${e.code}: ${e.message}`).join('; ');
  return `[${codes}] ${detail}${errors.length > 5 ? ` (+${errors.length - 5} más)` : ''}`;
}

function sourceOf(bp: BlueprintDto): ManifestSource {
  return {
    courseId: bp.courseId,
    blueprintId: bp.id,
    blueprintNumber: bp.blueprintNumber,
    blueprintSha256: bp.sha256,
  };
}

/**
 * Generation Manifest (Fase 4): qué trabajos hay que generar para un
 * Blueprint congelado. Solo escribe en `course_generation_manifests`; nunca
 * toca production_jobs/artifacts/courses/course_blueprints/estructura viva.
 *
 * Ownership + `dynamic` + lectura verificada del Blueprint se delegan en
 * `CourseBlueprintsService.getByNumber` (404 ajeno/inexistente, 400 legacy);
 * el builder recibe solo el snapshot del Blueprint.
 */
@Injectable()
export class GenerationManifestsService {
  private readonly logger = new Logger(GenerationManifestsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly blueprints: CourseBlueprintsService,
  ) {
    // I4 (review-rv2, mismo criterio que M6 de It.2 con DYNAMIC_VIDEO_DELIVERY):
    // este servicio vive en AppModule (API + workers legacy) y lo instancia
    // también el dynamic-package-worker — un typo en DYNAMIC_MANIFEST_RULES_VERSION
    // NO puede tumbar el boot de todo eso. La validación ruidosa y sin fallback
    // es lazy: configuredRulesVersion() lanza en cada uso de las rutas dynamic
    // que dependen de la config (crear un Manifest, leer "el Manifest actual").
    // Acá solo se deja el error bien visible en el log de arranque.
    try {
      readManifestRulesVersionConfig();
    } catch (err) {
      this.logger.error(
        `${err instanceof Error ? err.message : String(err)} — las rutas dynamic que crean/leen el Manifest ` +
          'configurado van a fallar hasta corregirlo; el resto del backend arranca normal',
      );
    }
  }

  /** rulesVersion configurado (DYNAMIC_MANIFEST_RULES_VERSION, default 1); lanza si es inválido (fail loud en uso). */
  configuredRulesVersion(): ManifestRulesVersion {
    return readManifestRulesVersionConfig();
  }

  /**
   * Get-or-create idempotente. La idempotencia la garantiza la base con
   * UNIQUE(blueprint_id, rules_version) + ON CONFLICT DO NOTHING: dos POST
   * concurrentes producen una sola fila; el perdedor lee la del ganador.
   */
  async getOrCreate(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
  ): Promise<{ created: boolean; manifest: ManifestDto }> {
    const rulesVersion = this.configuredRulesVersion();
    const bp = await this.blueprints.getByNumber(courseId, ownerId, blueprintNumber);
    const source = sourceOf(bp);
    const m = buildGenerationManifest(bp.snapshot, source, { rulesVersion });

    const errors = validateGenerationManifest(m, bp.snapshot, source);
    if (errors.length > 0) {
      // Bug del builder: nunca se persiste un Manifest inválido.
      throw new InternalServerErrorException(
        `Generation Manifest inválido para el Blueprint v${bp.blueprintNumber} del curso #${courseId} ` +
          `(no se guardó): ${describeErrors(errors)}`,
      );
    }

    const canonical = canonicalManifestJson(m);
    const sha = manifestSha256(m);
    const t = m.totals;

    // v1: exactamente el INSERT de siempre (no depende de la migración v2).
    // v2: además las columnas de conteo v2 (supabase-migration-dynamic-
    // generation-v2.sql); sin esa migración el CHECK cgm_counts_consistent
    // viejo rechaza el total (falla fuerte, nunca un Manifest v2 a medias).
    const inserted = returningRows(
      rulesVersion === 2
        ? await this.dataSource.query(
            `insert into public.course_generation_manifests
               (course_id, blueprint_id, rules_version, manifest_schema_version, manifest_json,
                manifest_sha256, blueprint_sha256, module_count, chapter_count, content_count,
                scorm_count, video_count, exam_count, total_jobs, created_by,
                course_plan_count, course_intro_count, module_intro_count)
             values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             on conflict (blueprint_id, rules_version) do nothing
             returning *`,
            [courseId, bp.id, rulesVersion, MANIFEST_SCHEMA_VERSION, canonical, sha, bp.sha256,
              t.moduleCount, t.chapterCount, t.contentCount, t.scormCount, t.videoCount, t.examCount,
              t.totalJobs, ownerId, t.coursePlanCount, t.courseIntroCount, t.moduleIntroCount],
          )
        : await this.dataSource.query(
            `insert into public.course_generation_manifests
               (course_id, blueprint_id, rules_version, manifest_schema_version, manifest_json,
                manifest_sha256, blueprint_sha256, module_count, chapter_count, content_count,
                scorm_count, video_count, exam_count, total_jobs, created_by)
             values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             on conflict (blueprint_id, rules_version) do nothing
             returning *`,
            [courseId, bp.id, rulesVersion, MANIFEST_SCHEMA_VERSION, canonical, sha, bp.sha256,
              t.moduleCount, t.chapterCount, t.contentCount, t.scormCount, t.videoCount, t.examCount,
              t.totalJobs, ownerId],
          ),
    );
    if (inserted.length === 1) {
      return { created: true, manifest: this.toDto(inserted[0], bp) };
    }

    const existing = await this.findRow(courseId, bp.id, rulesVersion);
    if (!existing) {
      // ON CONFLICT sin fila visible después: no debería ocurrir (el UNIQUE
      // solo choca con filas commiteadas o en curso que luego se commitean).
      throw new InternalServerErrorException(
        `Generation Manifest del Blueprint v${bp.blueprintNumber} (curso #${courseId}): ` +
          'el insert chocó con el UNIQUE pero no se encontró la fila existente',
      );
    }
    if (existing.manifest_sha256 !== sha) {
      throw new InternalServerErrorException(
        `Generation Manifest no determinístico: el guardado #${existing.id} del Blueprint v${bp.blueprintNumber} ` +
          `(curso #${courseId}, rulesVersion ${rulesVersion}) tiene sha256 ${existing.manifest_sha256} ` +
          `pero el recién calculado es ${sha}`,
      );
    }
    return { created: false, manifest: this.toDto(existing, bp) };
  }

  /**
   * Lee el Manifest de un Blueprint para `rulesVersion` (default: el
   * configurado, DYNAMIC_MANIFEST_RULES_VERSION); 404 si no se creó.
   */
  async get(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    rulesVersion: ManifestRulesVersion = this.configuredRulesVersion(),
  ): Promise<ManifestDto> {
    const bp = await this.blueprints.getByNumber(courseId, ownerId, blueprintNumber);
    const row = await this.findRow(courseId, bp.id, rulesVersion);
    if (!row) {
      throw new NotFoundException(
        `El Blueprint v${bp.blueprintNumber} del curso #${courseId} no tiene Generation Manifest ` +
          `(rulesVersion ${rulesVersion}); crealo con POST`,
      );
    }
    return this.toDto(row, bp);
  }

  /**
   * Verifica acceso al Blueprint (404 ajeno/inexistente, 400 legacy) SIN
   * depender de DYNAMIC_MANIFEST_RULES_VERSION. Lo usan los endpoints con
   * runId cuando el run no existe, para responder 404 del run sin leer "el
   * Manifest actual" de la config (fix wave review-rv2).
   */
  async assertBlueprintAccessible(courseId: number, ownerId: string, blueprintNumber: number): Promise<void> {
    await this.blueprints.getByNumber(courseId, ownerId, blueprintNumber);
  }

  /**
   * Lee un Manifest concreto por id (el congelado en un run:
   * input_payload.manifestId), verificando que sea de ESE Blueprint/curso y
   * del dueño (mismas garantías que `get`). Así un run v1 sigue legible
   * aunque la config pase a crear Manifests v2 (y viceversa). 404 si no es de
   * este Blueprint.
   */
  async getById(courseId: number, ownerId: string, blueprintNumber: number, manifestId: number): Promise<ManifestDto> {
    const bp = await this.blueprints.getByNumber(courseId, ownerId, blueprintNumber);
    const id = Number(manifestId);
    const [row] = Number.isInteger(id)
      ? await this.dataSource.query(
          `select * from public.course_generation_manifests
            where id = $1 and blueprint_id = $2 and course_id = $3`,
          [id, bp.id, courseId],
        )
      : [];
    if (!row) {
      throw new NotFoundException(
        `El Generation Manifest #${manifestId} no pertenece al Blueprint v${bp.blueprintNumber} del curso #${courseId}`,
      );
    }
    return this.toDto(row, bp);
  }

  private async findRow(courseId: number, blueprintId: number, rulesVersion: ManifestRulesVersion): Promise<any | undefined> {
    const [row] = await this.dataSource.query(
      `select * from public.course_generation_manifests
        where blueprint_id = $1 and course_id = $2 and rules_version = $3`,
      [blueprintId, courseId, rulesVersion],
    );
    return row;
  }

  /**
   * Lectura verificada (ambos caminos, incluso el recién insertado): el jsonb
   * de Postgres reordena claves, así que se re-canonicaliza y se exige
   * sha256(canonical) = manifest_sha256; además se re-valida contra el
   * snapshot del Blueprint y se comparan las columnas de conteo. Cualquier
   * discrepancia → 500 explícito (nunca se devuelve un Manifest corrupto).
   */
  private toDto(row: any, bp: BlueprintDto): ManifestDto {
    const where = `Generation Manifest #${row.id} (Blueprint v${bp.blueprintNumber}, curso #${bp.courseId})`;
    const stored = typeof row.manifest_json === 'string' ? JSON.parse(row.manifest_json) : row.manifest_json;

    let canonical: string;
    try {
      canonical = canonicalManifestJson(stored as GenerationManifestV1);
    } catch (err) {
      throw new InternalServerErrorException(
        `${where}: manifest_json guardado no tiene la forma esperada (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const manifest: GenerationManifestV1 = JSON.parse(canonical);
    const actualSha = manifestSha256(manifest);
    if (actualSha !== row.manifest_sha256) {
      throw new InternalServerErrorException(
        `${where}: integridad rota — sha256 del manifest_json guardado (${actualSha}) ` +
          `no coincide con manifest_sha256 (${row.manifest_sha256})`,
      );
    }

    if (row.blueprint_id !== bp.id || row.blueprint_sha256 !== bp.sha256) {
      throw new InternalServerErrorException(
        `${where}: blueprint_id/blueprint_sha256 guardados no coinciden con el Blueprint leído`,
      );
    }

    // FIX M1: las columnas rules_version/manifest_schema_version deben
    // coincidir con lo que dice el propio manifest_json (ahora que
    // canonicalManifestJson ya no las hardcodea a 1) — una discrepancia acá
    // es integridad rota, igual que el sha256.
    if (
      row.rules_version !== manifest.rulesVersion ||
      row.manifest_schema_version !== manifest.manifestSchemaVersion
    ) {
      throw new InternalServerErrorException(
        `${where}: columnas rules_version/manifest_schema_version (${row.rules_version}/${row.manifest_schema_version}) ` +
          `no coinciden con manifest_json (${manifest.rulesVersion}/${manifest.manifestSchemaVersion})`,
      );
    }

    const errors = validateGenerationManifest(manifest, bp.snapshot, sourceOf(bp));
    if (errors.length > 0) {
      throw new InternalServerErrorException(
        `${where}: el Manifest guardado no es válido contra el snapshot del Blueprint: ${describeErrors(errors)}`,
      );
    }

    const t = manifest.totals;
    const cols = [row.module_count, row.chapter_count, row.content_count, row.scorm_count,
      row.video_count, row.exam_count, row.total_jobs];
    const fromJson = [t.moduleCount, t.chapterCount, t.contentCount, t.scormCount,
      t.videoCount, t.examCount, t.totalJobs];
    // v2: columnas de conteo nuevas (ausentes antes de la migración v2 → 0,
    // que es lo que declara un Manifest v1).
    cols.push(row.course_plan_count ?? 0, row.course_intro_count ?? 0, row.module_intro_count ?? 0);
    fromJson.push(t.coursePlanCount ?? 0, t.courseIntroCount ?? 0, t.moduleIntroCount ?? 0);
    if (cols.some((v, i) => v !== fromJson[i])) {
      throw new InternalServerErrorException(
        `${where}: columnas de conteo [${cols.join(',')}] no coinciden con totals del manifest [${fromJson.join(',')}]`,
      );
    }

    return {
      id: row.id,
      courseId: row.course_id,
      blueprintId: row.blueprint_id,
      blueprintNumber: bp.blueprintNumber,
      rulesVersion: row.rules_version,
      manifestSchemaVersion: row.manifest_schema_version,
      manifest,
      sha256: row.manifest_sha256,
      blueprintSha256: row.blueprint_sha256,
      totals: { ...t },
      createdAt: toIso(row.created_at),
      createdBy: row.created_by ?? null,
    };
  }
}
