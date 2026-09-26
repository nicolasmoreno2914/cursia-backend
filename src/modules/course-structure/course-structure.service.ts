import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
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

@Injectable()
export class CourseStructureService {
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
    const allowUnowned = process.env.ALLOW_UNOWNED_COURSES === 'true';
    const rows = await queryRunner.query(
      `select structure_version, structure_version_counter
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
    return actualCounter;
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
    const course = await this.coursesService.findOne(courseId, ownerId);
    const modules = await this.moduleRepo.find({
      where: { courseId },
      relations: ['chapters'],
      order: { position: 'ASC' },
    });
    modules.forEach((m) => m.chapters.sort((a, b) => a.position - b.position));

    // V2.1 (R3): toggles de curso y `activity_enabled` por query propia (NO
    // mapeados en las entidades Course/CourseChapter: así las lecturas por
    // entidad — y el runner de producción V2, que no incluye esta migración —
    // no dependen de supabase-migration-v21-blueprint-profiles.sql).
    const settings = await this.readCourseSettings(courseId);
    const activityByChapter = await this.readActivityEnabled(courseId);

    // Task 4 / Ruling R1: currentInfo no verifica ownership ni "dynamic" —
    // ya lo hizo coursesService.findOne arriba, así que se llama después.
    const currentBlueprint = await this.blueprintsService.currentInfo(courseId);
    const liveMatchesCurrentBlueprint = this.computeLiveMatchesCurrentBlueprint(
      course,
      modules,
      currentBlueprint,
      settings,
      activityByChapter,
    );

    return {
      structureVersion: course.structureVersion,
      structureVersionCounter: course.structureVersionCounter,
      finalExam: settings.finalExam,
      activityEngine: settings.activityEngine,
      modules: modules.map((m) => ({
        id: m.id,
        position: m.position,
        title: m.title,
        objective: m.objective,
        examEnabled: m.examEnabled,
        chapters: m.chapters.map((c) => ({
          id: c.id,
          position: c.position,
          title: c.title,
          objective: c.objective,
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
      if (currentBlueprint.schemaVersion === 2) {
        // V2.1: un Blueprint v2 se compara con el builder v2 (incluye los toggles nuevos).
        if (!settings || !activityByChapter) throw new Error('faltan los toggles V2.1 para comparar contra un Blueprint v2');
        const rawModulesV2: RawModuleRow[] = modules.map((m) => ({
          id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled,
        }));
        const rawChaptersV2: RawChapterRowV2[] = modules.flatMap((m) =>
          m.chapters.map((c) => ({
            id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective,
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
   * V2.1 (R3): `course_chapters.activity_enabled` por capítulo. Fail loud si
   * a algún capítulo le falta el valor (no debería: NOT NULL DEFAULT true).
   */
  private async readActivityEnabled(courseId: number): Promise<Map<string, boolean>> {
    const rows: { id: string; activity_enabled: unknown }[] = await this.dataSource.query(
      `select id, activity_enabled from public.course_chapters where course_id = $1`,
      [courseId],
    );
    const out = new Map<string, boolean>();
    for (const r of rows) {
      if (typeof r.activity_enabled !== 'boolean') {
        throw new Error(`Capítulo ${r.id}: activity_enabled ilegible (${JSON.stringify(r.activity_enabled)})`);
      }
      out.set(r.id, r.activity_enabled);
    }
    return out;
  }

  /**
   * V2.1 (R3): PATCH de los toggles de curso (`finalExam`, `activityEngine`).
   * Mismo lockAndVerify (ownership + dynamic + expectedCounter → 409) y
   * mismo bump de counter que cualquier otra mutación de estructura: estos
   * toggles entran en el Blueprint v2.
   */
  async updateSettings(courseId: number, ownerId: string, dto: UpdateStructureSettingsDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
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

      const inserted = await queryRunner.query(
        `insert into public.course_modules (course_id, position, title, objective, exam_enabled)
         values ($1, $2, $3, $4, $5)
         returning id, position, title, objective, exam_enabled as "examEnabled"`,
        [courseId, nextPosition, dto.title, dto.objective || null, dto.examEnabled ?? true],
      );
      const newModuleId = inserted[0].id;

      // Ruling R3: createModule también crea el primer capítulo del módulo,
      // en la MISMA transacción — el resto del plan asume que todo módulo
      // tiene ≥1 capítulo (deleteModule/deleteChapter/move rechazan llegar
      // a 0), así que la creación no puede producir un módulo con 0.
      const insertedChapter = await queryRunner.query(
        `insert into public.course_chapters (course_id, module_id, position, title, video_enabled)
         values ($1, $2, $3, $4, $5)
         returning id, position, title, objective, video_enabled as "videoEnabled", activity_enabled as "activityEnabled"`,
        [courseId, newModuleId, 0, 'Nuevo capítulo', false],
      );

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return {
        module: { ...inserted[0], chapters: [insertedChapter[0]] },
        structureVersionCounter: newCounter,
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
        `select id from public.course_modules where id = $1 and course_id = $2`,
        [moduleId, courseId],
      );
      if (existing.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (dto.title !== undefined) { sets.push(`title = $${i++}`); params.push(dto.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
      if (dto.examEnabled !== undefined) { sets.push(`exam_enabled = $${i++}`); params.push(dto.examEnabled); }
      if (sets.length > 0) {
        params.push(moduleId);
        await queryRunner.query(
          `update public.course_modules set ${sets.join(', ')}, updated_at = now() where id = $${i}`,
          params,
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
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
      await this.lockAndVerify(queryRunner, courseId, ownerId, expectedCounter);

      const countRows = await queryRunner.query(
        `select count(*)::int as n from public.course_modules where course_id = $1`,
        [courseId],
      );
      if (countRows[0].n <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede eliminar el último módulo del curso.');
      }

      const deleted = returningRows(await queryRunner.query(
        `delete from public.course_modules where id = $1 and course_id = $2 returning id`,
        [moduleId, courseId],
      ));
      if (deleted.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async createChapter(courseId: number, moduleId: string, ownerId: string, dto: CreateChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
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

      const inserted = await queryRunner.query(
        `insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, position, title, objective, video_enabled as "videoEnabled", activity_enabled as "activityEnabled"`,
        [courseId, moduleId, nextPosition, dto.title, dto.objective || null, dto.videoEnabled ?? false,
          dto.activityEnabled ?? true],
      );
      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { chapter: inserted[0], structureVersionCounter: newCounter };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateChapter(courseId: number, moduleId: string, chapterId: string, ownerId: string, dto: UpdateChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const existing = await queryRunner.query(
        `select id from public.course_chapters where id = $1 and module_id = $2 and course_id = $3`,
        [chapterId, moduleId, courseId],
      );
      if (existing.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${moduleId}`);
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (dto.title !== undefined) { sets.push(`title = $${i++}`); params.push(dto.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
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
      return { structureVersionCounter: newCounter };
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
      await this.lockAndVerify(queryRunner, courseId, ownerId, expectedCounter);

      const countRows = await queryRunner.query(
        `select count(*)::int as n from public.course_chapters where module_id = $1`,
        [moduleId],
      );
      if (countRows[0].n <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede eliminar el último capítulo del módulo.');
      }

      const deleted = returningRows(await queryRunner.query(
        `delete from public.course_chapters where id = $1 and module_id = $2 and course_id = $3 returning id`,
        [chapterId, moduleId, courseId],
      ));
      if (deleted.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${moduleId}`);
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async reorderModules(courseId: number, ownerId: string, dto: ReorderDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const existingRows = await queryRunner.query(
        `select id from public.course_modules where course_id = $1`,
        [courseId],
      );
      const existingIds = existingRows.map((r: any) => r.id).sort();
      const requestedIds = [...dto.order].sort();
      if (JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El set de ids en "order" no coincide exactamente con los módulos existentes del curso.',
        );
      }

      for (let position = 0; position < dto.order.length; position++) {
        await queryRunner.query(
          `update public.course_modules set position = $1, updated_at = now() where id = $2 and course_id = $3`,
          [position, dto.order[position], courseId],
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
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
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      const moduleRows = await queryRunner.query(
        `select id from public.course_modules where id = $1 and course_id = $2`,
        [moduleId, courseId],
      );
      if (moduleRows.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      }

      const existingRows = await queryRunner.query(
        `select id from public.course_chapters where module_id = $1`,
        [moduleId],
      );
      const existingIds = existingRows.map((r: any) => r.id).sort();
      const requestedIds = [...dto.order].sort();
      if (JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El set de ids en "order" no coincide exactamente con los capítulos existentes del módulo.',
        );
      }

      for (let position = 0; position < dto.order.length; position++) {
        await queryRunner.query(
          `update public.course_chapters set position = $1, updated_at = now() where id = $2 and module_id = $3`,
          [position, dto.order[position], moduleId],
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async moveChapter(courseId: number, sourceModuleId: string, chapterId: string, ownerId: string, dto: MoveChapterDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await this.lockAndVerify(queryRunner, courseId, ownerId, dto.expectedCounter);

      // El capítulo debe existir en el módulo origen indicado.
      const chapterRows = await queryRunner.query(
        `select id from public.course_chapters where id = $1 and module_id = $2 and course_id = $3`,
        [chapterId, sourceModuleId, courseId],
      );
      if (chapterRows.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new NotFoundException(`Chapter ${chapterId} not found in module ${sourceModuleId}`);
      }

      // El módulo destino debe ser del MISMO curso.
      const targetModuleRows = await queryRunner.query(
        `select id from public.course_modules where id = $1 and course_id = $2`,
        [dto.targetModuleId, courseId],
      );
      if (targetModuleRows.length === 0) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('El módulo destino no existe o no pertenece a este curso.');
      }

      // Mover dentro del mismo módulo no es "move" — usar reorderChapters,
      // porque la resecuenciación de abajo asume origen != destino (si no,
      // se contaría el capítulo movido dos veces).
      if (dto.targetModuleId === sourceModuleId) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException(
          'El módulo destino es igual al origen — usar reorder para mover dentro del mismo módulo.',
        );
      }

      // Nunca dejar el módulo origen con 0 capítulos.
      const sourceCountRows = await queryRunner.query(
        `select count(*)::int as n from public.course_chapters where module_id = $1`,
        [sourceModuleId],
      );
      if (sourceCountRows[0].n <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede mover el último capítulo del módulo origen.');
      }

      // Resequenciar el módulo origen (sin el capítulo movido), por orden actual.
      const remainingSource = await queryRunner.query(
        `select id from public.course_chapters where module_id = $1 and id != $2 order by position asc`,
        [sourceModuleId, chapterId],
      );
      for (let i = 0; i < remainingSource.length; i++) {
        await queryRunner.query(
          `update public.course_chapters set position = $1 where id = $2`,
          [i, remainingSource[i].id],
        );
      }

      // Insertar el capítulo movido en targetPosition dentro del destino,
      // desplazando lo que ya estaba desde esa posición en adelante.
      const targetExisting = await queryRunner.query(
        `select id from public.course_chapters where module_id = $1 order by position asc`,
        [dto.targetModuleId],
      );
      const clampedPosition = Math.min(dto.targetPosition, targetExisting.length);
      const finalOrder = [...targetExisting.map((r: any) => r.id)];
      finalOrder.splice(clampedPosition, 0, chapterId);

      // Mover el capítulo de módulo primero (fuera del rango de la unique
      // constraint del módulo origen, ya resequenciado arriba).
      await queryRunner.query(
        `update public.course_chapters set module_id = $1 where id = $2`,
        [dto.targetModuleId, chapterId],
      );
      for (let i = 0; i < finalOrder.length; i++) {
        await queryRunner.query(
          `update public.course_chapters set position = $1 where id = $2`,
          [i, finalOrder[i]],
        );
      }

      const newCounter = await this.bumpCounter(queryRunner, courseId);
      await queryRunner.commitTransaction();
      return { structureVersionCounter: newCounter };
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
