import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Course } from './entities/course.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course)
    private readonly courseRepo: Repository<Course>,
  ) {}

  // ── Leer flag de compatibilidad desde env ─────────────────────────────────
  private get allowUnowned(): boolean {
    return process.env.ALLOW_UNOWNED_COURSES === 'true';
  }

  // ── CREATE ────────────────────────────────────────────────────────────────
  /**
   * Crea un curso asignando automáticamente el owner desde el JWT.
   * El frontend no puede enviar owner_id — la ValidationPipe lo rechazaría.
   */
  async create(
    dto: CreateCourseDto,
    ownerId: string,
    ownerEmail: string,
  ): Promise<Course> {
    const course = this.courseRepo.create({
      ...dto,
      ownerId,
      ownerEmail,
    });
    return this.courseRepo.save(course);
  }

  // ── FIND ALL ──────────────────────────────────────────────────────────────
  /**
   * Devuelve solo los cursos del usuario autenticado.
   * Si ALLOW_UNOWNED_COURSES=true, incluye también cursos sin owner_id
   * (cursos creados antes de la Fase 6, en entornos de desarrollo).
   */
  async findAll(ownerId: string): Promise<Course[]> {
    const qb = this.courseRepo
      .createQueryBuilder('course')
      .orderBy('course.created_at', 'DESC');

    if (this.allowUnowned) {
      qb.where(
        '(course.owner_id = :ownerId OR course.owner_id IS NULL)',
        { ownerId },
      );
    } else {
      qb.where('course.owner_id = :ownerId', { ownerId });
    }

    return qb.getMany();
  }

  // ── FIND ONE ──────────────────────────────────────────────────────────────
  /**
   * Busca un curso por id con validación de ownership.
   * Devuelve 404 si no existe O si pertenece a otro usuario
   * (evita revelar la existencia del recurso).
   *
   * @param ownerId  UUID del usuario autenticado. Si es undefined, no filtra
   *                 por owner (usado internamente en contextos sin auth).
   */
  async findOne(id: number, ownerId?: string): Promise<Course> {
    const qb = this.courseRepo
      .createQueryBuilder('course')
      .leftJoinAndSelect('course.versions', 'versions')
      .where('course.id = :id', { id });

    if (ownerId) {
      if (this.allowUnowned) {
        qb.andWhere(
          '(course.owner_id = :ownerId OR course.owner_id IS NULL)',
          { ownerId },
        );
      } else {
        qb.andWhere('course.owner_id = :ownerId', { ownerId });
      }
    }

    const course = await qb.getOne();
    if (!course) {
      throw new NotFoundException(`Course #${id} not found`);
    }
    return course;
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  async update(
    id: number,
    dto: UpdateCourseDto,
    ownerId: string,
  ): Promise<Course> {
    // findOne ya valida ownership → 404 si no es del usuario
    const course = await this.findOne(id, ownerId);
    Object.assign(course, dto);
    return this.courseRepo.save(course);
  }

  // ── REMOVE ────────────────────────────────────────────────────────────────
  async remove(id: number, ownerId: string): Promise<void> {
    // findOne ya valida ownership → 404 si no es del usuario
    const course = await this.findOne(id, ownerId);
    await this.courseRepo.remove(course);
  }
}
