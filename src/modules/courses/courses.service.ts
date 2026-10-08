import { DESIGN_HOURS_KEY, DESIGN_PINS_KEY } from '../course-design/design-pins';
import { STRUCTURE_ORIGIN_KEY } from '../course-structure/structure-authority';
import { BRIEF_KEY, PEDAGOGY_DERIVATION_KEY } from '../course-facts/course-facts';
import { DOCUMENT_REQUIREMENTS_KEY, REQUIREMENTS_SELECTION_KEY } from '../academic-context/requirements/document-requirements';
import { REQUIREMENT_EXCEPTIONS_KEY } from '../academic-context/requirements/requirement-authority';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Course } from './entities/course.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { AdminDashboardService } from '../../admin/services/admin-dashboard.service';
import { assertDynamicCreationAllowed, assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { readActivityTypeRulesConfig } from '../generation-manifests/manifest-rules-config';
import { PREBRIEF_METADATA_KEYS } from '../prebrief/prebrief-keys';

/** LOOP 8.0/8.1: claves de courses.metadata que solo escriben sus servicios. */
const PROTECTED_METADATA_KEYS = [STRUCTURE_ORIGIN_KEY, BRIEF_KEY, PEDAGOGY_DERIVATION_KEY, DESIGN_PINS_KEY, DESIGN_HOURS_KEY,
  // LOOP 8.6B (review I1): requisitos leídos del documento y la alternativa elegida (solo los escribe academic-context).
  DOCUMENT_REQUIREMENTS_KEY, REQUIREMENTS_SELECTION_KEY, REQUIREMENT_EXCEPTIONS_KEY,
  // Prebrief (review BE-1 C1): flujo de aprobación, formato S/M/L, motivos de excepción y confirmaciones.
  ...PREBRIEF_METADATA_KEYS];

/**
 * EV6 H5P v2 (H2 fix round 1, I-2): «Repaso» (Dialog Cards) arranca ENCENDIDO solo en cursos
 * NUEVOS creados mientras la generación usa H5P v2 (DYNAMIC_ACTIVITY_TYPE_RULES=2). Con el flag
 * sin definir (o 0/1, o inválido) queda apagado (default false de la columna). Los cursos
 * existentes nunca cambian. El empaque igual exige el marcador activityTypeRules=2 del Manifest.
 */
export function reviewCardsDefaultForNewCourse(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readActivityTypeRulesConfig(env) === 2;
  } catch {
    return false; // config inválida: la creación del curso no falla por esto (el Manifest sí falla fuerte)
  }
}

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course)
    private readonly courseRepo: Repository<Course>,
    private readonly adminDashboardService: AdminDashboardService,
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
    // Release-fix I4 (defensa en profundidad; el controller ya lo chequea con el
    // mensaje 404 exacto de la ruta): un curso dynamic exige flag + allow-list.
    if (dto?.structureVersion === 'dynamic') assertDynamicCreationAllowed(ownerId);
    const course = this.courseRepo.create({
      ...dto,
      ownerId,
      ownerEmail,
    });
    const saved = await this.courseRepo.save(course);
    if (dto?.structureVersion === 'dynamic') await this.applyNewCourseH5pV2Defaults(saved.id);
    return saved;
  }

  /** EV6 H5P v2: «Repaso» encendido en un curso NUEVO solo con H5P v2 (ver reviewCardsDefaultForNewCourse). */
  private async applyNewCourseH5pV2Defaults(courseId: number): Promise<void> {
    if (!reviewCardsDefaultForNewCourse()) return;
    // Sin la migración EV6 la columna no existe: el curso queda sin «Repaso» (nunca falla la creación).
    const [col] = await this.courseRepo.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'courses' and column_name = 'review_cards_enabled'`,
    );
    if (!col) return;
    await this.courseRepo.query(`update public.courses set review_cards_enabled = true where id = $1`, [courseId]);
  }

  // ── FIND OR CREATE DYNAMIC ───────────────────────────────────────────────
  /**
   * Idempotente por (ownerId, frontendCourseId): si ya existe un curso
   * dynamic con ese metadata.courseId para este owner, lo devuelve tal
   * cual. Si no, crea uno nuevo en estado draft. Ventana de carrera
   * teórica conocida y aceptada (spec Fase 2, sección 2.1): dos llamadas
   * simultáneas con el mismo frontendCourseId podrían crear 2 filas — no
   * se cierra en esta fase, no se agrega constraint nueva a `courses`.
   */
  async findOrCreateDynamic(
    ownerId: string,
    ownerEmail: string,
    frontendCourseId: string,
    title?: string,
  ): Promise<Course> {
    return (await this.findOrCreateDynamicWithStatus(ownerId, ownerEmail, frontendCourseId, title)).course;
  }

  /**
   * Aceptación rv3 (staging): igual que findOrCreateDynamic pero informa si el
   * curso se CREÓ en esta llamada. El cliente lo usa para no atribuirle la
   * paleta global a un curso que ya existía (idempotencia del POST).
   */
  async findOrCreateDynamicWithStatus(
    ownerId: string,
    ownerEmail: string,
    frontendCourseId: string,
    title?: string,
  ): Promise<{ course: Course; created: boolean }> {
    // G3: flag V2 + allow-list por owner (403 antes de tocar la DB).
    assertDynamicOwnerAllowed(ownerId);
    const existing = await this.courseRepo
      .createQueryBuilder('course')
      .where('course.owner_id = :ownerId', { ownerId })
      .andWhere(`course.metadata->>'courseId' = :frontendCourseId`, { frontendCourseId })
      .andWhere('course.structure_version = :sv', { sv: 'dynamic' })
      .orderBy('course.id', 'ASC')
      .getOne();
    if (existing) return { course: existing, created: false };

    const course = this.courseRepo.create({
      title: title || 'Curso sin título',
      ownerId,
      ownerEmail,
      structureVersion: 'dynamic',
      status: 'draft',
      metadata: { courseId: frontendCourseId },
    });
    const saved = await this.courseRepo.save(course);
    await this.applyNewCourseH5pV2Defaults(saved.id);
    return { course: saved, created: true };
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

    const rows = await qb.getMany();
    // LOOP 8.6B (review M8): el listado no arrastra las lecturas de requisitos (hasta cientos de KB por curso).
    for (const c of rows) {
      const m = c.metadata as Record<string, unknown> | null;
      if (m && m[DOCUMENT_REQUIREMENTS_KEY] !== undefined) {
        const { [DOCUMENT_REQUIREMENTS_KEY]: _omit, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
        c.metadata = rest as any;
      }
    }
    return rows;
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

  // ── COST ──────────────────────────────────────────────────────────────────
  /**
   * Costo real+estimado del curso (tokens reales de Claude, videos/audio con
   * tarifa configurada en cost_rates) — misma agregación que usa el panel
   * Admin, filtrada a este curso. Verifica ownership antes de calcular.
   */
  async getCourseCost(id: number, ownerId?: string) {
    await this.findOne(id, ownerId); // 404 si no existe o no es del usuario
    return this.adminDashboardService.getCourseCost(String(id));
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  async update(
    id: number,
    dto: UpdateCourseDto,
    ownerId: string,
  ): Promise<Course> {
    // findOne ya valida ownership → 404 si no es del usuario
    const course = await this.findOne(id, ownerId);
    // LOOP 8.0 (review L80 M1) + LOOP 8.1: las claves de la fuente única (origen de la estructura, pedido del curso,
    // derivación del perfil) las escriben solo sus servicios; un PATCH del curso nunca las cambia ni las borra.
    // Review L81 M2: la mezcla se hace en SQL, en una sola sentencia, con las claves protegidas leídas AL ESCRIBIR (un
    // PUT /brief o una derivación que se confirma entre la lectura y la escritura nunca se revierte).
    const { metadata, ...rest } = dto as UpdateCourseDto & { metadata?: Record<string, any> };
    // update() parcial: solo las columnas enviadas (save() reescribiría el metadata leído antes, ya viejo).
    if (Object.keys(rest).length) await this.courseRepo.update({ id: course.id }, rest as any);
    if (metadata !== undefined) {
      const next: Record<string, any> = { ...(metadata || {}) };
      for (const key of PROTECTED_METADATA_KEYS) delete next[key];
      await this.courseRepo.query(
        `update public.courses
            set metadata = $2::jsonb || coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(metadata, '{}'::jsonb)) as e(k, v) where k = any($3::text[])), '{}'::jsonb)
          where id = $1`,
        [id, JSON.stringify(next), PROTECTED_METADATA_KEYS],
      );
    }
    return this.findOne(id, ownerId);
  }

  // ── REMOVE ────────────────────────────────────────────────────────────────
  async remove(id: number, ownerId: string): Promise<void> {
    // findOne ya valida ownership → 404 si no es del usuario
    const course = await this.findOne(id, ownerId);
    await this.courseRepo.remove(course);
  }
}
