import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
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
import type { QueryRunner } from 'typeorm';

@Injectable()
export class CourseStructureService {
  constructor(
    @InjectRepository(CourseModuleEntity)
    private readonly moduleRepo: Repository<CourseModuleEntity>,
    @InjectRepository(CourseChapter)
    private readonly chapterRepo: Repository<CourseChapter>,
    private readonly coursesService: CoursesService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Verifica ownership + structureVersion==='dynamic', y dentro de la
   * MISMA transacción bloquea la fila de `courses` (FOR UPDATE) y compara
   * expectedCounter. Si todo OK, devuelve el counter actual (para que el
   * caller lo incremente al terminar su mutación). Si algo falla, hace
   * rollback y tira la excepción correspondiente — el caller nunca llega
   * a mutar nada.
   */
  private async lockAndVerify(
    queryRunner: QueryRunner,
    courseId: number,
    ownerId: string,
    expectedCounter: number,
  ): Promise<number> {
    // Ownership fuera de la transacción de escritura (ya usa su propia
    // conexión vía el repo inyectado normal) — 404 si no es del usuario.
    const course = await this.coursesService.findOne(courseId, ownerId);
    if (course.structureVersion !== 'dynamic') {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`,
      );
    }
    const rows = await queryRunner.query(
      `select structure_version_counter from public.courses where id = $1 for update`,
      [courseId],
    );
    if (rows.length === 0) {
      await queryRunner.rollbackTransaction();
      throw new NotFoundException(`Course #${courseId} not found`);
    }
    const actualCounter = rows[0].structure_version_counter;
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
    const rows = await queryRunner.query(
      `update public.courses set structure_version_counter = structure_version_counter + 1
       where id = $1 returning structure_version_counter`,
      [courseId],
    );
    return rows[0].structure_version_counter;
  }

  async getStructure(courseId: number, ownerId: string) {
    const course = await this.coursesService.findOne(courseId, ownerId);
    const modules = await this.moduleRepo.find({
      where: { courseId },
      relations: ['chapters'],
      order: { position: 'ASC' },
    });
    modules.forEach((m) => m.chapters.sort((a, b) => a.position - b.position));
    return {
      structureVersion: course.structureVersion,
      structureVersionCounter: course.structureVersionCounter,
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
        })),
      })),
    };
  }

  async createModule(courseId: number, ownerId: string, dto: CreateModuleDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
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
         returning id, position, title, objective, video_enabled as "videoEnabled"`,
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await this.lockAndVerify(queryRunner, courseId, ownerId, expectedCounter);

      const countRows = await queryRunner.query(
        `select count(*)::int as n from public.course_modules where course_id = $1`,
        [courseId],
      );
      if (countRows[0].n <= 1) {
        await queryRunner.rollbackTransaction();
        throw new BadRequestException('No se puede eliminar el último módulo del curso.');
      }

      const deleted = await queryRunner.query(
        `delete from public.course_modules where id = $1 and course_id = $2 returning id`,
        [moduleId, courseId],
      );
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

}
