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

  async create(courseId: number, dto: CreateCourseVersionDto): Promise<CourseVersion> {
    // 404 if course doesn't exist
    await this.coursesService.findOne(courseId);

    // Auto-increment version_number per course
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

  async findAllForCourse(courseId: number): Promise<CourseVersion[]> {
    // 404 if course doesn't exist
    await this.coursesService.findOne(courseId);

    return this.versionRepo.find({
      where: { courseId },
      order: { versionNumber: 'DESC' },
    });
  }

  async findOne(courseId: number, versionId: number): Promise<CourseVersion> {
    // 404 if course doesn't exist
    await this.coursesService.findOne(courseId);

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
