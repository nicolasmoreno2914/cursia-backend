import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CourseModule as CourseModuleEntity } from './entities/course-module.entity';
import { CourseChapter } from './entities/course-chapter.entity';
import { CoursesService } from '../courses/courses.service';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { ReorderDto } from './dto/reorder.dto';
import { MoveChapterDto } from './dto/move-chapter.dto';
import { UpdateStructureSettingsDto } from './dto/update-structure-settings.dto';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { CourseBlueprintsService } from '../course-blueprints/course-blueprints.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import {
  RawChapterRow,
  RawChapterRowV2,
  RawModuleRow,
  buildBlueprintSnapshot,
  buildBlueprintSnapshotV2,
  isActivityEngine,
  snapshotSha256,
  snapshotSha256V2,
} from '../course-blueprints/blueprint-snapshot';
import { assertV21StructureSchema, probeV21StructureSchema } from './v21-schema-guard';
import {
  CHAPTER_TITLE_TOO_LONG,
  MODULE_TITLE_TOO_LONG,
  STRUCTURE_DESCRIPTION_MAX,
  STRUCTURE_DESCRIPTION_TOO_LONG,
  STRUCTURE_TITLE_MAX,
  StructureTitleSplit,
  mergeDescription,
  normalizeStructureTitle,
} from './structure-titles';

/**
 * Title Normalization: título ≤ STRUCTURE_TITLE_MAX. Un título largo se separa
 * en título + descripción (sin truncar); si no hay un corte natural → 400 con
 * código claro (nunca se guarda un título largo).
 */
export function normalizeTitleOrThrow(kind: 'chapter' | 'module', raw: string): StructureTitleSplit {
  const n = normalizeStructureTitle(raw);
  if (n) return n;
  const code = kind === 'chapter' ? CHAPTER_TITLE_TOO_LONG : MODULE_TITLE_TOO_LONG;
  const what = kind === 'chapter' ? 'del capítulo' : 'del módulo';
  throw new BadRequestException({
    code,
    max: STRUCTURE_TITLE_MAX,
    length: String(raw ?? '').trim().length,
    message:
      `${code}: el título ${what} tiene ${String(raw ?? '').trim().length} caracteres (máximo ${STRUCTURE_TITLE_MAX}) y no se ` +
      'pudo separar automáticamente en título y descripción. Escribe un título breve y pon el detalle en la descripción.',
  });
}

/** Descripción final: nunca se trunca; si supera el máximo → 400 (el usuario la acorta). */
export function checkedDescription(v: string | null): string | null {
  if (v !== null && v.length > STRUCTURE_DESCRIPTION_MAX) {
    throw new BadRequestException({
      code: STRUCTURE_DESCRIPTION_TOO_LONG,
      max: STRUCTURE_DESCRIPTION_MAX,
      message: `${STRUCTURE_DESCRIPTION_TOO_LONG}: la descripción quedaría con ${v.length} caracteres (máximo ${STRUCTURE_DESCRIPTION_MAX}). Acórtala.`,
    });
  }
  return v;
}

function cleanDescription(v: string | undefined | null): string | null {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t : null;
}
import { blueprintSchemaVersionForRules, readConfiguredRulesVersion } from '../generation-manifests/manifest-rules-config';

@Injectable()
export class CourseStructureService implements OnModuleInit {
  private readonly logger = new Logger(CourseStructureService.name);

  constructor(
    @InjectRepository(CourseModuleEntity)
    private readonly moduleRepo: Repository<CourseModuleEntity>,
    @InjectRepository(CourseChapter)
    private readonly chapterRepo: Repository<CourseChapter>,
    private readonly coursesService: CoursesService,
    private readonly dataSource: DataSource,
    private readonly blueprintsService: CourseBlueprintsService,
  ) {}

  /** V2.1 fix round 1 (I5): sonda de arranque (solo loguea; las rutas responden 503 si falta la migración). */
  async onModuleInit(): Promise<void> {
    await probeV21StructureSchema(this.dataSource, this.logger);
  }

  /**
   * Verifica ownership + structureVersion==='dynamic', y dentro de la
   * MISMA transacción bloquea la fila de `courses` (FOR UPDATE) y compara
   * expectedCounter. Si todo OK, devuelve el counter actual (para que el
   * caller lo incremente al terminar su mutación). Si algo falla, hace
   * rollback y tira la excepción correspondiente — el caller nunca llega
   * a mutar nada.
   *
   * Ownership + structureVersion + lock + counter salen de UNA sola query
   * FOR UPDATE en la conexión del queryRunner (misma conexión que ya
   * retiene la transacción de escritura) — nunca se pide una segunda
   * conexión del pool acá (antes se llamaba a `CoursesService.findOne`,
   * que usa su propio repo/conexión; con pool `max: 5`, varias escrituras
   * concurrentes se trababan esperando esa segunda conexión). El filtro de
   * ownership replica exactamente `CoursesService.findOne`: coincide con
   * `owner_id`, o el curso no tiene owner y `ALLOW_UNOWNED_COURSES=true`.
   */
  private async lockAndVerify(
    queryRunner: QueryRunner,
    courseId: number,
    ownerId: string,
    expectedCounter: number,
  ): Promise<number> {
    return (await this.lockAndVerifyEx(queryRunner, courseId, ownerId, expectedCounter)).counter;
  }

  /**
   * R16 (rendimiento del editor): igual que lockAndVerify, y además informa si
   * el curso tiene Blueprint vigente (misma sentencia, sin ida y vuelta extra)
   * para que las mutaciones estructurales sepan si hace falta calcular
   * `liveMatchesCurrentBlueprint` antes de responder.
   */
  private async lockAndVerifyEx(
    queryRunner: QueryRunner,
    courseId: number,
    ownerId: string,
    expectedCounter: number,
  ): Promise<{ counter: number; hasBlueprint: boolean }> {
    const allowUnowned = process.env.ALLOW_UNOWNED_COURSES === 'true';
    const rows = await queryRunner.query(
      `select structure_version, structure_version_counter, current_blueprint_id
       from public.courses
       where id = $1 and (owner_id = $2 OR ($3 = true AND owner_id IS NULL))
       for update`,
      [courseId, ownerId, allowUnowned],
    );
    if (rows.length === 0) {
      await queryRunner.rollbackTransaction();
      throw new NotFoundException(`Course #${courseId} not found`);
    }
    const structureVersion = rows[0].structure_version;
    const actualCounter = rows[0].structure_version_counter;
    if (structureVersion !== 'dynamic') {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `El curso #${courseId} es "${structureVersion}" — esta API solo admite cursos "dynamic".`,
      );
    }
    if (actualCounter !== expectedCounter) {
      await queryRunner.rollbackTransaction();
      throw new ConflictException({
        message: 'expectedCounter desactualizado',
        currentCounter: actualCounter,
      });
    }
    return { counter: actualCounter, hasBlueprint: rows[0].current_blueprint_id != null };
  }

  /**
   * R16: `liveMatchesCurrentBlueprint` tras una mutación estructural, leído en
   * la MISMA transacción (ve la mutación antes del COMMIT). Sin Blueprint
   * vigente es `false` sin consultar nada (igual que el GET). Así el editor
   * no necesita un GET completo para saber si la estructura volvió a
   * coincidir con la versión confirmada.
   */
  private async liveMatchesAfterMutation(
    queryRunner: QueryRunner,
    courseId: number,
    ownerId: string,
    hasBlueprint: boolean,
  ): Promise<boolean> {
    if (!hasBlueprint) return false;
    return (await this.readStructure(queryRunner, courseId, ownerId)).liveMatchesCurrentBlueprint;
  }

  private async bumpCounter(queryRunner: QueryRunner, courseId: number): Promise<number> {
    const rows = returningRows(await queryRunner.query(
      `update public.courses set structure_version_counter = structure_version_counter + 1
       where id = $1 returning structure_version_counter`,
      [courseId],
    ));
    const counter = rows[0]?.structure_version_counter;
    if (typeof counter !== 'number') {
      // Nunca responder 200 sin counter: el cliente lo necesita para su
      // próximo expectedCounter (sin él, cada escritura siguiente da 409).
      throw new Error(`bumpCounter: no se pudo leer structure_version_counter del curso #${courseId}`);
    }
    return counter;
  }

  async getStructure(courseId: number, ownerId: string) {
    // V2.1 fix round 1 (I5): sin la migración R3 → 503 schema_not_migrated_v21 (nunca un 500 crudo).
    await assertV21StructureSchema(this.dataSource);
    return this.readStructure(this.dataSource, courseId, ownerId);
  }

  /**
   * Lectura completa de la estructura (la forma del GET). `exec` es el
   * DataSource (GET) o el queryRunner de una mutación (R16: ve la mutación
   * aún sin commit).
   */
  private async readStructure(
    exec: { query(sql: string, params?: any[]): Promise<any> },
    courseId: number,
    ownerId: string,
  ) {
    // Task 4 (rendimiento del editor): ownership + curso + toggles V2.1 + counter + Blueprint
    // vigente + módulos/capítulos en UNA sola sentencia. Antes eran ~9 idas y vueltas a la base
    // (findOne con join a course_versions, BEGIN REPEATABLE READ, counter, módulos, toggles,
    // activity, COMMIT, currentInfo): medido en staging ≈ 2 s por GET. Una sentencia ve un único
    // snapshot, así que se conserva la garantía de review G2 M10 (toggles y counter del mismo
    // estado) sin transacción explícita. Mismo filtro de ownership que CoursesService.findOne.
    const allowUnowned = process.env.ALLOW_UNOWNED_COURSES === 'true';
    const rows = await exec.query(
      `select c.id, c.title, c.structure_version, c.structure_version_counter,
              c.final_exam_enabled, c.activity_engine,
              b.id as bp_id, b.blueprint_number as bp_number, b.locked_at as bp_locked_at,
              b.snapshot_sha256 as bp_sha256, b.schema_version as bp_schema_version,
              coalesce((
                select json_agg(json_build_object(
                         'id', m.id, 'position', m.position, 'title', m.title, 'objective', m.objective,
                         'description', m.description, 'examEnabled', m.exam_enabled,
                         'chapters', coalesce((
                           select json_agg(json_build_object(
                                    'id', ch.id, 'position', ch.position, 'title', ch.title, 'objective', ch.objective,
                                    'description', ch.description, 'videoEnabled', ch.video_enabled,
                                    'activityEnabled', ch.activity_enabled) order by ch.position, ch.id)
                             from public.course_chapters ch where ch.module_id = m.id and ch.course_id = c.id), '[]'::json)
                       ) order by m.position, m.id)
                  from public.course_modules m where m.course_id = c.id), '[]'::json) as modules
         from public.courses c
         left join public.course_blueprints b on b.id = c.current_blueprint_id and b.course_id = c.id
        where c.id = $1 and (c.owner_id = $2 or ($3 = true and c.owner_id is null))`,
      [courseId, ownerId, allowUnowned],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(`Course #${courseId} not found`);
    const course = { id: Number(row.id), title: row.title as string, structureVersion: row.structure_version };
    const counter = Number(row.structure_version_counter);
    if (typeof row.final_exam_enabled !== 'boolean' || !isActivityEngine(row.activity_engine)) {
      throw new Error(
        `Curso #${courseId}: toggles de curso inválidos (final_exam_enabled=${JSON.stringify(row.final_exam_enabled)}, ` +
          `activity_engine=${JSON.stringify(row.activity_engine)})`,
      );
    }
    const settings: { finalExam: boolean; activityEngine: 'h5p' | 'scorm' } = {
      finalExam: row.final_exam_enabled,
      activityEngine: row.activity_engine,
    };
    const rawModules: any[] = typeof row.modules === 'string' ? JSON.parse(row.modules) : row.modules || [];
    const activityByChapter = new Map<string, boolean>();
    const modules = rawModules.map((m) => ({
      id: m.id as string,
      position: Number(m.position),
      title: m.title as string,
      objective: m.objective ?? null,
      description: m.description ?? null,
      examEnabled: m.examEnabled as boolean,
      chapters: (m.chapters || []).map((c: any) => {
        if (typeof c.activityEnabled !== 'boolean') {
          throw new Error(`Capítulo ${c.id}: activity_enabled ilegible (${JSON.stringify(c.activityEnabled)})`);
        }
        activityByChapter.set(c.id, c.activityEnabled);
        return {
          id: c.id as string,
          position: Number(c.position),
          title: c.title as string,
          objective: c.objective ?? null,
          description: c.description ?? null,
          videoEnabled: c.videoEnabled as boolean,
        };
      }),
    })) as unknown as CourseModuleEntity[];

    const currentBlueprint = row.bp_id == null
      ? null
      : {
          id: row.bp_id,
          number: row.bp_number,
          lockedAt: (row.bp_locked_at instanceof Date ? row.bp_locked_at : new Date(row.bp_locked_at)).toISOString(),
          sha256: row.bp_sha256,
          schemaVersion: Number(row.bp_schema_version),
        };
    const liveMatchesCurrentBlueprint = this.computeLiveMatchesCurrentBlueprint(
      course,
      modules,
      currentBlueprint,
      settings,
      activityByChapter,
    );

    return {
      structureVersion: course.structureVersion,
      structureVersionCounter: counter,
      finalExam: settings.finalExam,
      activityEngine: settings.activityEngine,
      modules: modules.map((m) => ({
        id: m.id,
        position: m.position,
        title: m.title,
        objective: m.objective,
        description: m.description ?? null,
        examEnabled: m.examEnabled,
        chapters: m.chapters.map((c) => ({
          id: c.id,
          position: c.position,
          title: c.title,
          objective: c.objective,
          description: c.description ?? null,
          videoEnabled: c.videoEnabled,
          activityEnabled: activityByChapter.get(c.id) as boolean,
        })),
      })),
      currentBlueprint,
      liveMatchesCurrentBlueprint,
    };
  }

  /**
   * Ruling R1: reusa el MISMO snapshot builder que el lock (Task 3) — mapea
   * las entidades de TypeORM a RawModuleRow/RawChapterRow (snake_case) y
   * llama a buildBlueprintSnapshot/snapshotSha256, nunca una segunda
   * canonicalización. El título del curso en el snapshot es `course.title`,
   * igual que usa el lock. Si no hay Blueprint vigente, o si construir el
   * snapshot tirara (no debería pasar con datos de getStructure, pero se
   * cubre por las dudas), el resultado es `false` en vez de propagar el
   * error — este campo es informativo, no debe romper la lectura de la
   * estructura.
   */
  private computeLiveMatchesCurrentBlueprint(
    course: { id: number; title: string },
    modules: CourseModuleEntity[],
    currentBlueprint: { sha256: string; schemaVersion?: number } | null,
    settings?: { finalExam: boolean; activityEngine: 'h5p' | 'scorm' },
    activityByChapter?: Map<string, boolean>,
  ): boolean {
    if (!currentBlueprint) return false;
    try {
      // V2.1 fix round 1 (review G2 M3): un Blueprint de otro schemaVersion que el
      // que produciría el lock con la config actual NUNCA "coincide" (con config 3 y
      // un Blueprint v1 el Manifest v3 da 409 BLUEPRINT_SCHEMA_MISMATCH: hay que
      // re-confirmar). Config inválida → throw → catch de abajo → false.
      if ((currentBlueprint.schemaVersion ?? 1) !== blueprintSchemaVersionForRules(readConfiguredRulesVersion())) return false;
      if (currentBlueprint.schemaVersion === 2) {
        // V2.1: un Blueprint v2 se compara con el builder v2 (incluye los toggles nuevos).
        if (!settings || !activityByChapter) throw new Error('faltan los toggles V2.1 para comparar contra un Blueprint v2');
        const rawModulesV2: RawModuleRow[] = modules.map((m) => ({
          id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled,
          description: m.description ?? null,
        }));
        const rawChaptersV2: RawChapterRowV2[] = modules.flatMap((m) =>
          m.chapters.map((c) => ({
            id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective,
            description: c.description ?? null,
            video_enabled: c.videoEnabled, activity_enabled: activityByChapter.get(c.id) as boolean,
          })),
        );
        const snapshotV2 = buildBlueprintSnapshotV2(
          { id: course.id, title: course.title, finalExam: settings.finalExam, activityEngine: settings.activityEngine },
          rawModulesV2,
          rawChaptersV2,
        );
        return snapshotSha256V2(snapshotV2) === currentBlueprint.sha256;
      }
      const rawModules: RawModuleRow[] = modules.map((m) => ({
        id: m.id,
        position: m.position,
        title: m.title,
        objective: m.objective,
        exam_enabled: m.examEnabled,
      }));
      const rawChapters: RawChapterRow[] = modules.flatMap((m) =>
        m.chapters.map((c) => ({
          id: c.id,
          module_id: m.id,
          position: c.position,
          title: c.title,
          objective: c.objective,
          video_enabled: c.videoEnabled,
        })),
      );
      const snapshot = buildBlueprintSnapshot(
        { id: course.id, title: course.title },
        rawModules,
        rawChapters,
      );
      return snapshotSha256(snapshot) === currentBlueprint.sha256;
    } catch (err) {
      this.logger.warn(
        `computeLiveMatchesCurrentBlueprint: fallo al comparar el hash del curso #${course.id} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * V2.1 (R3): `courses.final_exam_enabled` / `courses.activity_engine`.
   * Fail loud: un valor fuera de contrato (no debería pasar: NOT NULL +
   * CHECK) tira en vez de devolverse "arreglado".
   */
  private async readCourseSettings(
    courseId: number,
    runner?: QueryRunner,
  ): Promise<{ finalExam: boolean; activityEngine: 'h5p' | 'scorm' }> {
    const q = `select final_exam_enabled, activity_engine from public.courses where id = $1`;
    const rows = runner ? await runner.query(q, [courseId]) : await this.dataSource.query(q, [courseId]);
    const row = rows[0];
    if (!row) throw new NotFoundException(`Course #${courseId} not found`);
    if (typeof row.final_exam_enabled !== 'boolean' || !isActivityEngine(row.activity_engine)) {
      throw new Error(
        `Curso #${courseId}: toggles de curso inválidos (final_exam_enabled=${JSON.stringify(row.final_exam_enabled)}, ` +
          `activity_engine=${JSON.stringify(row.activity_engine)})`,
      );
    }
    return { finalExam: row.final_exam_enabled, activityEngine: row.activity_engine };
  }

  /**
   * V2.1 (R3): PATCH de los toggles de curso (`finalExam`, `activityEngine`).
   * Mismo lockAndVerify (ownership + dynamic + expectedCounter → 409) y
   * mismo bump de counter que cualquier otra mutación de estructura: estos
   * toggles entran en el Blueprint v2.
   */
  async updateSettings(courseId: number, ownerId: string, dto: UpdateStructureSettingsDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    await assertV21StructureSchema(this.dataSource); // V2.1 fix round 1 (I5): 503 si falta la migración R3
    if (dto.finalExam === undefined && dto.activityEngine === undefined) {
      throw new BadRequestException('Nada para actualizar: enviá "finalExam" y/o "activityEngine".');
    }
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (dto.finalExam !== undefined) { sets.push(`final_exam_enabled = $${i++}`); params.push(dto.finalExam); }
      if (dto.activityEngine !== undefined) { sets.push(`activity_engine = $${i++}`); params.push(dto.activityEngine); }
      params.push(courseId);
      await queryRunner.query(`update public.courses set ${sets.join(', ')} where id = $${i}`, params);

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      const settings = await this.readCourseSettings(courseId, queryRunner);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter, ...settings };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async createModule(courseId: number, ownerId: string, dto: CreateModuleDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    await assertV21StructureSchema(this.dataSource); // V2.1 fix round 1 (I5): 503 si falta la migración R3
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const maxRows = await queryRunner.query(
        `select coalesce(max(position), -1) as max_pos from public.course_modules where course_id = $1`,
        [courseId],
      );
      const nextPosition = Number(maxRows[0].max_pos) + 1;

      const nt = normalizeTitleOrThrow('module', dto.title);
      const inserted = await queryRunner.query(
        `insert into public.course_modules (course_id, position, title, objective, exam_enabled, description)
         values ($1, $2, $3, $4, $5, $6)
         returning id, position, title, objective, description, exam_enabled as "examEnabled"`,
        [courseId, nextPosition, nt.title, dto.objective || null, dto.examEnabled ?? true,
          checkedDescription(mergeDescription(cleanDescription(dto.description), nt.description))],
      );
      const newModuleId = inserted[0].id;

      // Ruling R3: createModule también crea el primer capítulo del módulo,
      // en la MISMA transacción — el resto del plan asume que todo módulo
      // tiene ≥1 capítulo (deleteModule/deleteChapter/move rechazan llegar
      // a 0), así que la creación no puede producir un módulo con 0.
      const insertedChapter = await queryRunner.query(
        `insert into public.course_chapters (course_id, module_id, position, title, video_enabled)
         values ($1, $2, $3, $4, $5)
         returning id, position, title, objective, description, video_enabled as "videoEnabled", activity_enabled as "activityEnabled"`,
        [courseId, newModuleId, 0, 'Nuevo capítulo', false],
      );

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return {
        module: { ...inserted[0], chapters: [insertedChapter[0]] },
        structureVersionCounter: newCounter,
        titleNormalized: nt.changed,
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateModule(courseId: number, moduleId: string, ownerId: string, dto: UpdateModuleDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const existing = await queryRunner.query(
        `select id, description from public.course_modules where id = $1 and course_id = $2`,
        [moduleId, courseId],
      );
      if (existing.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      const nt = dto.title !== undefined ? normalizeTitleOrThrow('module', dto.title) : null;
      if (nt) { sets.push(`title = $${i++}`); params.push(nt.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
      if (dto.examEnabled !== undefined) { sets.push(`exam_enabled = $${i++}`); params.push(dto.examEnabled); }
      let description: string | null | undefined;
      if (nt?.description) description = checkedDescription(mergeDescription(dto.description !== undefined ? cleanDescription(dto.description) : existing[0].description, nt.description));
      else if (dto.description !== undefined) description = cleanDescription(dto.description);
      if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }
      if (sets.length > 0) {
        params.push(moduleId);
        await queryRunner.query(
          `update public.course_modules set ${sets.join(', ')}, updated_at = now() where id = $${i}`,
          params,
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return {
        structureVersionCounter: newCounter,
        ...(nt ? { title: nt.title, titleNormalized: nt.changed } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteModule(courseId: number, moduleId: string, ownerId: string, expectedCounter: number) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const lock = await this.lockAndVerifyEx(queryRunner, courseId, ownerId, expectedCounter);

      // R16: conteo + DELETE + counter en una sentencia (antes 3 idas y vueltas).
      // Misma precedencia: último módulo → 400 antes que inexistente → 404.
      // Las posiciones del resto NO se resecuencian (igual que antes).
      const rows = await queryRunner.query(
        `with n as (
           select count(*)::int as n from public.course_modules where course_id = $1
         ),
         d as (
           delete from public.course_modules m using n
            where n.n > 1 and m.id = $2 and m.course_id = $1
           returning m.id
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
            where co.id = $1 and exists (select 1 from d)
           returning co.structure_version_counter
         )
         select n.n, (select count(*)::int from d) as deleted, (select structure_version_counter from c) as counter from n`,
        [courseId, moduleId],
      );
      const r = rows[0];
      if (Number(r.n) <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede eliminar el último módulo del curso.');
      }
      if (Number(r.deleted) === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const newCounter = this.counterOrThrow(r.counter, courseId);
      const liveMatchesCurrentBlueprint = await this.liveMatchesAfterMutation(queryRunner, courseId, ownerId, lock.hasBlueprint);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter, deletedModuleId: moduleId, liveMatchesCurrentBlueprint };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async createChapter(courseId: number, moduleId: string, ownerId: string, dto: CreateChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    await assertV21StructureSchema(this.dataSource); // V2.1 fix round 1 (I5): 503 si falta la migración R3
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const moduleRows = await queryRunner.query(
        `select id from public.course_modules where id = $1 and course_id = $2`,
        [moduleId, courseId],
      );
      if (moduleRows.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const maxRows = await queryRunner.query(
        `select coalesce(max(position), -1) as max_pos from public.course_chapters where module_id = $1`,
        [moduleId],
      );
      const nextPosition = Number(maxRows[0].max_pos) + 1;

      const nt = normalizeTitleOrThrow('chapter', dto.title);
      const inserted = await queryRunner.query(
        `insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled, description)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, position, title, objective, description, video_enabled as "videoEnabled", activity_enabled as "activityEnabled"`,
        [courseId, moduleId, nextPosition, nt.title, dto.objective || null, dto.videoEnabled ?? false,
          dto.activityEnabled ?? true, checkedDescription(mergeDescription(cleanDescription(dto.description), nt.description))],
      );
      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { chapter: inserted[0], structureVersionCounter: newCounter, titleNormalized: nt.changed };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateChapter(courseId: number, moduleId: string, chapterId: string, ownerId: string, dto: UpdateChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    await assertV21StructureSchema(this.dataSource); // V2.1 fix round 1 (I5): 503 si falta la migración R3
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const existing = await queryRunner.query(
        `select id, description from public.course_chapters where id = $1 and module_id = $2 and course_id = $3`,
        [chapterId, moduleId, courseId],
      );
      if (existing.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${moduleId}`);
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      const nt = dto.title !== undefined ? normalizeTitleOrThrow('chapter', dto.title) : null;
      if (nt) { sets.push(`title = $${i++}`); params.push(nt.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
      let description: string | null | undefined;
      if (nt?.description) description = checkedDescription(mergeDescription(dto.description !== undefined ? cleanDescription(dto.description) : existing[0].description, nt.description));
      else if (dto.description !== undefined) description = cleanDescription(dto.description);
      if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }
      if (dto.videoEnabled !== undefined) { sets.push(`video_enabled = $${i++}`); params.push(dto.videoEnabled); }
      if (dto.activityEnabled !== undefined) { sets.push(`activity_enabled = $${i++}`); params.push(dto.activityEnabled); }
      if (sets.length > 0) {
        params.push(chapterId);
        await queryRunner.query(
          `update public.course_chapters set ${sets.join(', ')}, updated_at = now() where id = $${i}`,
          params,
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return {
        structureVersionCounter: newCounter,
        ...(nt ? { title: nt.title, titleNormalized: nt.changed } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteChapter(courseId: number, moduleId: string, chapterId: string, ownerId: string, expectedCounter: number) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const lock = await this.lockAndVerifyEx(queryRunner, courseId, ownerId, expectedCounter);

      // R16: conteo + DELETE + counter en una sentencia (ver deleteModule).
      const rows = await queryRunner.query(
        `with n as (
           select count(*)::int as n from public.course_chapters where module_id = $2
         ),
         d as (
           delete from public.course_chapters ch using n
            where n.n > 1 and ch.id = $3 and ch.module_id = $2 and ch.course_id = $1
           returning ch.id
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
            where co.id = $1 and exists (select 1 from d)
           returning co.structure_version_counter
         )
         select n.n, (select count(*)::int from d) as deleted, (select structure_version_counter from c) as counter from n`,
        [courseId, moduleId, chapterId],
      );
      const r = rows[0];
      if (Number(r.n) <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede eliminar el último capítulo del módulo.');
      }
      if (Number(r.deleted) === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${moduleId}`);
      }

      const newCounter = this.counterOrThrow(r.counter, courseId);
      const liveMatchesCurrentBlueprint = await this.liveMatchesAfterMutation(queryRunner, courseId, ownerId, lock.hasBlueprint);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter, deletedChapterId: chapterId, moduleId, liveMatchesCurrentBlueprint };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * R16 (rendimiento del editor): el reorden es UNA sentencia (unnest … with
   * ordinality) con la validación del set de ids y el +1 del counter dentro
   * del mismo statement — antes era un UPDATE por fila en un loop + select +
   * bump (5+N idas y vueltas → 4). Los unique (course_id, position) /
   * (module_id, position) son `deferrable initially deferred`
   * (supabase-migration-dynamic-course-structure.sql), así que los choques
   * intermedios de posiciones no importan. La validación es la misma de
   * antes: el multiconjunto de ids pedido == los ids existentes (comparados
   * como texto, igual que el JSON.stringify de las listas ordenadas).
   *
   * Respuesta: además del counter (lo único que había), las filas cambiadas
   * `modules: [{id, position}]` y `liveMatchesCurrentBlueprint`, para que el
   * editor aplique el cambio sin volver a pedir la estructura.
   */
  async reorderModules(courseId: number, ownerId: string, dto: ReorderDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const lock = await this.lockAndVerifyEx(queryRunner, courseId, ownerId, dto.expectedCounter);

      const order: string[] = Array.isArray(dto.order) ? dto.order.map((x) => String(x)) : [];
      const rows = await queryRunner.query(
        `with req as (
           select r.id, r.ord from unnest($2::text[]) with ordinality as r(id, ord)
         ),
         chk as (
           select (select count(*) from public.course_modules where course_id = $1) = $3::int
              and (select count(distinct id) from req) = $3::int
              and (select count(*) from public.course_modules m join req on m.id::text = req.id where m.course_id = $1) = $3::int
              as ok
         ),
         u as (
           update public.course_modules m
              set position = (req.ord - 1)::int, updated_at = now()
             from req, chk
            where chk.ok and m.id::text = req.id and m.course_id = $1
           returning m.id, m.position
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
             from chk
            where chk.ok and co.id = $1
           returning co.structure_version_counter
         )
         select chk.ok,
                (select structure_version_counter from c) as counter,
                coalesce((select json_agg(json_build_object('id', u.id, 'position', u.position) order by u.position) from u), '[]'::json) as rows
           from chk`,
        [courseId, order, order.length],
      );
      const r = rows[0];
      if (!r || r.ok !== true) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El set de ids en "order" no coincide exactamente con los módulos existentes del curso.',
        );
      }
      const newCounter = this.counterOrThrow(r.counter, courseId);
      const liveMatchesCurrentBlueprint = await this.liveMatchesAfterMutation(queryRunner, courseId, ownerId, lock.hasBlueprint);
      await queryRunner.commitTransaction();
      return {
        structureVersionCounter: newCounter,
        modules: this.jsonRows(r.rows).map((m: any) => ({ id: m.id as string, position: Number(m.position) })),
        liveMatchesCurrentBlueprint,
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async reorderChapters(courseId: number, moduleId: string, ownerId: string, dto: ReorderDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const lock = await this.lockAndVerifyEx(queryRunner, courseId, ownerId, dto.expectedCounter);

      // R16: una sentencia (ver reorderModules). Misma precedencia de errores:
      // módulo inexistente → 404 antes que el 400 del set de ids.
      const order: string[] = Array.isArray(dto.order) ? dto.order.map((x) => String(x)) : [];
      const rows = await queryRunner.query(
        `with req as (
           select r.id, r.ord from unnest($3::text[]) with ordinality as r(id, ord)
         ),
         md as (
           select exists(select 1 from public.course_modules where id = $2 and course_id = $1) as found
         ),
         chk as (
           select md.found,
                  md.found
                  and (select count(*) from public.course_chapters where module_id = $2) = $4::int
                  and (select count(distinct id) from req) = $4::int
                  and (select count(*) from public.course_chapters ch join req on ch.id::text = req.id where ch.module_id = $2) = $4::int
                  as ok
             from md
         ),
         u as (
           update public.course_chapters ch
              set position = (req.ord - 1)::int, updated_at = now()
             from req, chk
            where chk.ok and ch.id::text = req.id and ch.module_id = $2
           returning ch.id, ch.module_id, ch.position
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
             from chk
            where chk.ok and co.id = $1
           returning co.structure_version_counter
         )
         select chk.found, chk.ok,
                (select structure_version_counter from c) as counter,
                coalesce((select json_agg(json_build_object('id', u.id, 'moduleId', u.module_id, 'position', u.position) order by u.position) from u), '[]'::json) as rows
           from chk`,
        [courseId, moduleId, order, order.length],
      );
      const r = rows[0];
      if (!r || r.found !== true) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }
      if (r.ok !== true) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El set de ids en "order" no coincide exactamente con los capítulos existentes del módulo.',
        );
      }
      const newCounter = this.counterOrThrow(r.counter, courseId);
      const liveMatchesCurrentBlueprint = await this.liveMatchesAfterMutation(queryRunner, courseId, ownerId, lock.hasBlueprint);
      await queryRunner.commitTransaction();
      return {
        structureVersionCounter: newCounter,
        chapters: this.jsonRows(r.rows).map((c: any) => ({ id: c.id as string, moduleId: c.moduleId as string, position: Number(c.position) })),
        liveMatchesCurrentBlueprint,
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * R16: el move es UNA sentencia. Calcula el plan completo (módulo origen
   * resecuenciado sin el capítulo, destino con el capítulo insertado en
   * min(targetPosition, T)) con row_number() sobre el orden actual y lo
   * aplica con un solo UPDATE … FROM (el cambio de module_id va en el mismo
   * statement), más el +1 del counter. Antes: 10+S+T idas y vueltas → 4.
   * Mismas validaciones y en el mismo orden: capítulo inexistente en el
   * origen → 404; destino inexistente/de otro curso → 400; destino == origen
   * → 400; último capítulo del origen → 400. Como antes, el move no toca
   * `updated_at`.
   */
  async moveChapter(courseId: number, sourceModuleId: string, chapterId: string, ownerId: string, dto: MoveChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const lock = await this.lockAndVerifyEx(queryRunner, courseId, ownerId, dto.expectedCounter);

      // Mover dentro del mismo módulo no es "move" — usar reorderChapters
      // (la resecuenciación asume origen != destino). Se calcula en JS con la
      // misma comparación de strings de siempre y se chequea en su turno.
      const sameModule = dto.targetModuleId === sourceModuleId;
      const rows = await queryRunner.query(
        `with f as (
           select exists(select 1 from public.course_chapters where id = $3 and module_id = $2 and course_id = $1) as chapter_found,
                  exists(select 1 from public.course_modules where id = $4 and course_id = $1) as target_found,
                  (select count(*)::int from public.course_chapters where module_id = $2) as source_count
         ),
         ok as (
           select (f.chapter_found and f.target_found and not $6::boolean and f.source_count > 1) as ok from f
         ),
         src as (
           select id, (row_number() over (order by position asc) - 1)::int as pos
             from public.course_chapters where module_id = $2 and id <> $3
         ),
         tgt as (
           select id, (row_number() over (order by position asc) - 1)::int as r
             from public.course_chapters where module_id = $4
         ),
         clamp as (
           select least($5::int, (select count(*)::int from tgt)) as p
         ),
         plan as (
           select src.id, src.pos, $2::uuid as module_id from src
           union all
           select tgt.id, case when tgt.r < clamp.p then tgt.r else tgt.r + 1 end, $4::uuid from tgt, clamp
           union all
           select $3::uuid, clamp.p, $4::uuid from clamp
         ),
         u as (
           update public.course_chapters ch
              set position = plan.pos, module_id = plan.module_id
             from plan, ok
            where ok.ok and ch.id = plan.id
           returning ch.id, ch.module_id, ch.position
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
             from ok
            where ok.ok and co.id = $1
           returning co.structure_version_counter
         )
         select f.chapter_found, f.target_found, f.source_count, ok.ok,
                (select structure_version_counter from c) as counter,
                coalesce((select json_agg(json_build_object('id', u.id, 'moduleId', u.module_id, 'position', u.position) order by u.module_id, u.position) from u), '[]'::json) as rows
           from f, ok`,
        [courseId, sourceModuleId, chapterId, dto.targetModuleId, dto.targetPosition, sameModule],
      );
      const r = rows[0];
      if (!r || r.chapter_found !== true) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${sourceModuleId}`);
      }
      if (r.target_found !== true) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('El módulo destino no existe o no pertenece a este curso.');
      }
      if (sameModule) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El módulo destino es igual al origen — usar reorder para mover dentro del mismo módulo.',
        );
      }
      if (Number(r.source_count) <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede mover el último capítulo del módulo origen.');
      }
      if (r.ok !== true) throw new Error(`moveChapter: el plan no se aplicó en el curso #${courseId}`);

      const newCounter = this.counterOrThrow(r.counter, courseId);
      const liveMatchesCurrentBlueprint = await this.liveMatchesAfterMutation(queryRunner, courseId, ownerId, lock.hasBlueprint);
      await queryRunner.commitTransaction();
      return {
        structureVersionCounter: newCounter,
        chapters: this.jsonRows(r.rows).map((c: any) => ({ id: c.id as string, moduleId: c.moduleId as string, position: Number(c.position) })),
        liveMatchesCurrentBlueprint,
      };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /** Counter devuelto por un UPDATE plegado en una sentencia; nunca un 200 sin counter (ver bumpCounter). */
  private counterOrThrow(v: unknown, courseId: number): number {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      throw new Error(`bumpCounter: no se pudo leer structure_version_counter del curso #${courseId}`);
    }
    return n;
  }

  /** json/json_agg del driver: objeto ya parseado o string (según versión/driver). */
  private jsonRows(v: unknown): any[] {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed : [];
  }
}
