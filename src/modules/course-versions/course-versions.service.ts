import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CourseVersion } from './entities/course-version.entity';
import { CoursesService } from '../courses/courses.service';
import { CreateCourseVersionDto } from './dto/create-course-version.dto';

@Injectable()
export class CourseVersionsService {
  constructor(
    @InjectRepository(CourseVersion)
    private readonly versionRepo: Repository<CourseVersion>,
    private readonly coursesService: CoursesService,
  ) {}

  /**
   * Crea una versión del curso validando que el curso pertenece al usuario.
   * Si el curso no existe o pertenece a otro usuario → 404.
   */
  async create(
    courseId: number,
    dto: CreateCourseVersionDto,
    ownerId: string,
  ): Promise<CourseVersion> {
    // Valida existencia + ownership en un solo paso
    await this.coursesService.findOne(courseId, ownerId);

    // Auto-incrementar version_number por curso
    const lastVersion = await this.versionRepo.findOne({
      where: { courseId },
      order: { versionNumber: 'DESC' },
    });
    const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

    const version = this.versionRepo.create({
      courseId,
      versionNumber:     nextVersionNumber,
      status:            dto.status           ?? 'draft',
      notes:             dto.notes,
      snapshotJson:      dto.snapshotJson,
      // Storage fields (Fase 5 — Drive unificado)
      storageProvider:   dto.storageProvider,
      storageFileId:     dto.storageFileId,
      storageFileUrl:    dto.storageFileUrl,
      storageFolderId:   dto.storageFolderId,
      storagePath:       dto.storagePath,
      snapshotStrategy:  dto.snapshotStrategy,
      snapshotSizeBytes: dto.snapshotSizeBytes,
      snapshotSizeHuman: dto.snapshotSizeHuman,
      manifestJson:      dto.manifestJson,
    });

    return this.versionRepo.save(version);
  }

  /**
   * Lista todas las versiones de un curso validando ownership.
   * Si el curso no existe o no pertenece al usuario → 404.
   */
  async findAllForCourse(
    courseId: number,
    ownerId: string,
  ): Promise<CourseVersion[]> {
    // Valida existencia + ownership
    await this.coursesService.findOne(courseId, ownerId);

    return this.versionRepo.find({
      where: { courseId },
      order: { versionNumber: 'DESC' },
    });
  }

  /**
   * Obtiene una versión específica validando que el curso pertenece al usuario
   * y que la versión pertenece al curso.
   * Si cualquiera falla → 404 (no revela existencia de recursos ajenos).
   */
  async findOne(
    courseId: number,
    versionId: number,
    ownerId: string,
  ): Promise<CourseVersion> {
    // Valida existencia + ownership del curso
    await this.coursesService.findOne(courseId, ownerId);

    const version = await this.versionRepo.findOne({
      where: { id: versionId, courseId },
    });
    if (!version) {
      throw new NotFoundException(
        `Version #${versionId} not found for course #${courseId}`,
      );
    }
    return version;
  }
}
