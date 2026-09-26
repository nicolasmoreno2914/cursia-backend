import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import {
  AssessmentProfile,
  PresentationProfile,
  ProfileKind,
  ProfileValidationError,
  defaultAssessmentProfile,
  defaultPresentationProfile,
  isProfileKind,
  normalizeProfile,
  profileSha256,
  validateAssessmentProfile,
  validateProfile,
} from './course-profiles';

export interface CourseProfileDto {
  courseId: number;
  kind: ProfileKind;
  /** 0 = no hay versión guardada (default). */
  version: number;
  profile: PresentationProfile | AssessmentProfile;
  sha256: string;
  isDefault: boolean;
  createdAt: string | null;
  createdBy: string | null;
  /**
   * Solo assessment: incoherencias del perfil guardado con el curso ACTUAL
   * (p.ej. pesos con examen final y el curso ya no lo tiene). No bloquea la
   * lectura; el empaque (R12) debe revalidar y fallar fuerte.
   */
  warnings: ProfileValidationError[];
}

const PROFILE_VERSION_UNIQUE = 'course_profiles_course_kind_version_key';

function toIso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function isVersionConflict(err: any): boolean {
  const e = err?.driverError ?? err;
  return (err?.code === '23505' || e?.code === '23505') &&
    (err?.constraint === PROFILE_VERSION_UNIQUE || e?.constraint === PROFILE_VERSION_UNIQUE);
}

/**
 * Perfiles de curso versionados (V2.1 R3, audit §M.2). Append-only: cada
 * POST válido agrega una versión nueva (o devuelve la vigente si el
 * contenido es idéntico). Nunca toca Blueprints, Manifests, runs ni la
 * estructura viva.
 */
@Injectable()
export class CourseProfilesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly coursesService: CoursesService,
  ) {}

  private assertKind(kind: string): asserts kind is ProfileKind {
    if (!isProfileKind(kind)) {
      throw new BadRequestException(`Tipo de perfil inválido: "${kind}" (permitidos: presentation, assessment)`);
    }
  }

  /** Ownership (patrón existente: CoursesService.findOne → 404) + curso dynamic (400). */
  private async loadCourse(courseId: number, ownerId: string): Promise<void> {
    const course = await this.coursesService.findOne(courseId, ownerId);
    if (course.structureVersion !== 'dynamic') {
      throw new BadRequestException(
        `El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`,
      );
    }
  }

  private async readFinalExam(runner: DataSource | QueryRunner, courseId: number): Promise<boolean> {
    const [row] = await runner.query(`select final_exam_enabled from public.courses where id = $1`, [courseId]);
    if (!row || typeof row.final_exam_enabled !== 'boolean') {
      throw new Error(`Curso #${courseId}: final_exam_enabled ilegible (${JSON.stringify(row?.final_exam_enabled)})`);
    }
    return row.final_exam_enabled;
  }

  async getCurrent(courseId: number, ownerId: string, kind: string): Promise<CourseProfileDto> {
    this.assertKind(kind);
    await this.loadCourse(courseId, ownerId);
    const finalExam = await this.readFinalExam(this.dataSource, courseId);
    const [row] = await this.dataSource.query(
      `select * from public.course_profiles where course_id = $1 and kind = $2 order by version desc limit 1`,
      [courseId, kind],
    );
    if (!row) {
      const profile = kind === 'presentation' ? defaultPresentationProfile() : defaultAssessmentProfile({ finalExam });
      return {
        courseId, kind, version: 0, profile, sha256: profileSha256(profile), isDefault: true,
        createdAt: null, createdBy: null, warnings: [],
      };
    }
    return this.toDto(row, finalExam);
  }

  async append(
    courseId: number,
    ownerId: string,
    kind: string,
    data: unknown,
    expectedVersion?: number,
  ): Promise<{ created: boolean; profile: CourseProfileDto }> {
    assertDynamicOwnerAllowed(ownerId); // allow-list V2 en toda escritura
    this.assertKind(kind);
    await this.loadCourse(courseId, ownerId);

    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      // Serializa las escrituras de perfiles del curso (y congela finalExam
      // mientras se valida contra él).
      await qr.query(`select id from public.courses where id = $1 for update`, [courseId]);
      const finalExam = await this.readFinalExam(qr, courseId);

      const errors = validateProfile(kind, data, { finalExam });
      if (errors.length > 0) {
        await qr.rollbackTransaction();
        const codes = [...new Set(errors.map((e) => e.code))].join(', ');
        throw new BadRequestException({
          message: `Perfil "${kind}" inválido [${codes}]: ${errors.map((e) => `${e.path || '(raíz)'}: ${e.message}`).join('; ')}`,
          errors,
        });
      }
      const profile = normalizeProfile(kind, data);
      const sha = profileSha256(profile);

      const [latest] = await qr.query(
        `select * from public.course_profiles where course_id = $1 and kind = $2 order by version desc limit 1`,
        [courseId, kind],
      );
      const currentVersion = latest ? Number(latest.version) : 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        await qr.rollbackTransaction();
        throw new ConflictException(
          `El perfil "${kind}" del curso #${courseId} cambió: expectedVersion=${expectedVersion}, actual=${currentVersion}. ` +
            'Volvé a leerlo (GET) antes de guardar.',
        );
      }
      if (latest && latest.sha256 === sha) {
        await qr.rollbackTransaction();
        return { created: false, profile: this.toDto(latest, finalExam) };
      }

      const [row] = await qr.query(
        `insert into public.course_profiles (course_id, kind, version, data, sha256, created_by)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning *`,
        [courseId, kind, currentVersion + 1, JSON.stringify(profile), sha, ownerId],
      );
      await qr.commitTransaction();
      return { created: true, profile: this.toDto(row, finalExam) };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      if (isVersionConflict(err)) {
        throw new ConflictException('Otro guardado del perfil en curso, volvé a leerlo y reintentá');
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * Lectura verificada: el sha es sobre JSON canónico con claves ordenadas,
   * así que el reordenamiento de jsonb no lo afecta; si no coincide se falla
   * fuerte (integridad rota) en vez de devolver otro perfil.
   */
  private toDto(row: any, finalExam: boolean): CourseProfileDto {
    const kind = row.kind as ProfileKind;
    const stored = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const profile = normalizeProfile(kind, stored);
    if (profileSha256(profile) !== row.sha256) {
      throw new Error(`Perfil #${row.id} (${kind} v${row.version}): el contenido no coincide con su sha256 (integridad rota)`);
    }
    return {
      courseId: row.course_id,
      kind,
      version: Number(row.version),
      profile,
      sha256: row.sha256,
      isDefault: false,
      createdAt: toIso(row.created_at),
      createdBy: row.created_by ?? null,
      warnings: kind === 'assessment' ? validateAssessmentProfile(profile, { finalExam }) : [],
    };
  }
}
