import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { lockPedagogyInput } from '../pedagogy/pedagogical-blueprint';
import { parseStoredPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { profileTargetHours } from '../pedagogy/pedagogy-profile';
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
import { blueprintSchemaVersionForRules, readActivityTypeRulesConfig, readConfiguredRulesVersion } from '../generation-manifests/manifest-rules-config';

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

  async getStructure(courseId: number, ownerId: string) {
    // V2.1 fix round 1 (I5): sin la migración R3 → 503 schema_not_migrated_v21 (nunca un 500 crudo).
    await assertV21StructureSchema(this.dataSource);
    return this.readStructure(this.dataSource, courseId, ownerId, { reviewCardsAvailability: true });
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
    // EV6 H5P v2 (H2 fix round 2): solo el GET calcula `reviewCardsAvailable` (fuera de toda
    // transacción de mutación: su consulta opcional nunca aborta ni suma idas y vueltas a una mutación).
    opts: { reviewCardsAvailability?: boolean } = {},
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
              (to_jsonb(c) ->> 'review_cards_enabled')::boolean as review_cards_enabled,
              (to_jsonb(c) ? 'review_cards_enabled') as review_cards_migrated,
              b.id as bp_id, b.blueprint_number as bp_number, b.locked_at as bp_locked_at,
              b.snapshot_sha256 as bp_sha256, b.schema_version as bp_schema_version,
              -- Motor pedagógico V1 (review I1): perfil pedagógico vigente en la MISMA sentencia (sin ida y vuelta extra).
              (select json_build_object('id', p.id, 'version', p.version, 'data', p.data, 'sha256', p.sha256)
                 from public.course_profiles p
                where p.course_id = c.id and p.kind = 'pedagogy' and b.schema_version = 2
                order by p.version desc limit 1) as ped_row,
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
    const settings: { finalExam: boolean; activityEngine: 'h5p' | 'scorm'; reviewCardsEnabled: boolean } = {
      finalExam: row.final_exam_enabled,
      activityEngine: row.activity_engine,
      // EV6 H5P v2: NULL (curso anterior o columna sin migrar) = apagado.
      reviewCardsEnabled: row.review_cards_enabled === true,
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
    // Motor pedagógico V1 (review I1): el lock v2 congela el diseño del perfil pedagógico vigente; la
    // comparación usa el MISMO perfil (leído en la sentencia de arriba, solo con Blueprint v2 vigente).
    // Un perfil ilegible → la comparación da false (nunca rompe la lectura de la estructura).
    let pedagogyProfile: unknown = null;
    let pedagogyUnreadable = false;
    if (currentBlueprint && currentBlueprint.schemaVersion === 2 && row.ped_row) {
      try {
        const ped = typeof row.ped_row === 'string' ? JSON.parse(row.ped_row) : row.ped_row;
        pedagogyProfile = parseStoredPedagogicalProfile(ped, courseId).profile;
      } catch (err) {
        pedagogyUnreadable = true;
        this.logger.warn(`readStructure: perfil pedagógico ilegible del curso #${courseId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const liveMatchesCurrentBlueprint = !pedagogyUnreadable && this.computeLiveMatchesCurrentBlueprint(
      course,
      modules,
      currentBlueprint,
      settings,
      activityByChapter,
      pedagogyProfile,
    );

    return {
      structureVersion: course.structureVersion,
      structureVersionCounter: counter,
      finalExam: settings.finalExam,
      activityEngine: settings.activityEngine,
      reviewCardsEnabled: settings.reviewCardsEnabled,
      // EV6 H5P v2 (H2 fix round 2): el editor muestra el ajuste «Repaso» solo si tendrá efecto:
      // columna migrada, motor h5p y la generación del curso usa las reglas 2.
      reviewCardsAvailable: opts.reviewCardsAvailability
        ? await this.reviewCardsAvailable(exec, courseId, row.review_cards_migrated === true, settings.activityEngine)
        : false,
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
   * EV6 H5P v2 (H2 fix round 2): ¿el ajuste «Repaso» tendrá efecto en este curso? Columna migrada,
   * motor h5p y reglas de tipo 2 para su próxima generación (el marcador del Manifest v3 más reciente
   * del curso — se hereda — o, sin Manifest v3, DYNAMIC_ACTIVITY_TYPE_RULES). Sin columna o con
   * SCORM responde false SIN consultar la base (el GET de siempre no suma idas y vueltas).
   */
  private async reviewCardsAvailable(
    exec: { query(sql: string, params?: any[]): Promise<any> },
    courseId: number,
    migrated: boolean,
    engine: 'h5p' | 'scorm',
  ): Promise<boolean> {
    if (!migrated || engine !== 'h5p') return false;
    const fromConfig = (): boolean => {
      try {
        return readActivityTypeRulesConfig() === 2;
      } catch {
        return false;
      }
    };
    let rows: any[];
    try {
      rows = await exec.query(
        `select manifest_json->'features'->'activityTypeRules' as activity_type_rules
           from public.course_generation_manifests
          where course_id = $1 and rules_version = 3
          order by created_at desc, id desc
          limit 1`,
        [courseId],
      );
    } catch {
      return fromConfig(); // base sin la tabla de Manifests: decide la config, como un curso sin Manifests
    }
    const r = Array.isArray(rows) ? rows[0] : (rows as any)?.rows?.[0];
    if (!r) return fromConfig();
    return r.activity_type_rules === 2;
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
    settings?: { finalExam: boolean; activityEngine: 'h5p' | 'scorm'; reviewCardsEnabled?: boolean },
    activityByChapter?: Map<string, boolean>,
    pedagogyProfile: unknown = null,
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
        const courseV2 = {
          id: course.id, title: course.title, finalExam: settings.finalExam, activityEngine: settings.activityEngine, reviewCards: settings.reviewCardsEnabled === true,
          // Motor de carga horaria: las horas objetivo del perfil también entran al snapshot del lock.
          targetHours: profileTargetHours(pedagogyProfile),
        };
        const plainV2 = buildBlueprintSnapshotV2(courseV2, rawModulesV2, rawChaptersV2);
        const pedagogy = lockPedagogyInput(plainV2, pedagogyProfile);
        const snapshotV2 = pedagogy ? buildBlueprintSnapshotV2(courseV2, rawModulesV2, rawChaptersV2, pedagogy) : plainV2;
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
   * V2.1 (R3): PATCH de los toggles de curso (`finalExam`, `activityEngine`).
   * Mismo lockAndVerify (ownership + dynamic + expectedCounter → 409) y
   * mismo bump de counter que cualquier otra mutación de estructura: estos
   * toggles entran en el Blueprint v2.
   */
  async updateSettings(courseId: number, ownerId: string, dto: UpdateStructureSettingsDto) {
    assertDynamicOwnerAllowed(ownerId); // release-fix I4: allow-list V2 en toda escritura
    await assertV21StructureSchema(this.dataSource); // V2.1 fix round 1 (I5): 503 si falta la migración R3
    if (dto.finalExam === undefined && dto.activityEngine === undefined && dto.reviewCardsEnabled === undefined) {
      throw new BadRequestException('Nada para actualizar: enviá "finalExam", "activityEngine" y/o "reviewCardsEnabled".');
    }
    if (dto.reviewCardsEnabled !== undefined) {
      // EV6 H5P v2: la columna la agrega supabase-migration-ev6-h5p2.sql; sin ella → 503 explícito.
      const [col] = await this.dataSource.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'courses' and column_name = 'review_cards_enabled'`,
      );
      if (!col) {
        throw new ServiceUnavailableException({
          code: 'schema_not_migrated_ev6_h5p2',
          message: 'schema_not_migrated_ev6_h5p2: falta courses.review_cards_enabled (supabase-migration-ev6-h5p2.sql); correr la migración antes de cambiar «Repaso».',
        });
      }
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
      if (dto.reviewCardsEnabled !== undefined) { sets.push(`review_cards_enabled = $${i++}`); params.push(dto.reviewCardsEnabled); }
      params.push(courseId);
      // R16: toggles + counter + relectura en UNA sentencia (antes UPDATE, bump y select aparte).
      const rows = returningRows(await queryRunner.query(
        `update public.courses
            set ${sets.join(', ')}, structure_version_counter = structure_version_counter + 1
          where id = $${i}
          returning structure_version_counter, final_exam_enabled, activity_engine,
                    (to_jsonb(courses) ->> 'review_cards_enabled')::boolean as review_cards_enabled,
                    (to_jsonb(courses) ? 'review_cards_enabled') as review_cards_migrated`,
        params,
      ));
      const row = rows[0];
      if (!row) throw new NotFoundException(`Course #${courseId} not found`);
      const newCounter = this.counterOrThrow(row.structure_version_counter, courseId);
      if (typeof row.final_exam_enabled !== 'boolean' || !isActivityEngine(row.activity_engine)) {
        throw new Error(
          `Curso #${courseId}: toggles de curso inválidos (final_exam_enabled=${JSON.stringify(row.final_exam_enabled)}, ` +
            `activity_engine=${JSON.stringify(row.activity_engine)})`,
        );
      }
      // H2 fix round 2: misma forma de respuesta que antes de EV6; `reviewCardsEnabled` solo con la
      // columna migrada (se sabe en la MISMA sentencia: sin idas y vueltas extra).
      const settings: { finalExam: boolean; activityEngine: 'h5p' | 'scorm'; reviewCardsEnabled?: boolean } = {
        finalExam: row.final_exam_enabled,
        activityEngine: row.activity_engine,
        ...(row.review_cards_migrated === true ? { reviewCardsEnabled: row.review_cards_enabled === true } : {}),
      };
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

      const nt = normalizeTitleOrThrow('module', dto.title);
      const description = checkedDescription(mergeDescription(cleanDescription(dto.description), nt.description));

      // R16: max(position) + INSERT módulo + INSERT del capítulo default + counter en
      // UNA sentencia (antes 4 idas y vueltas). Ruling R3: createModule también crea
      // el primer capítulo del módulo, en la MISMA transacción — el resto del plan
      // asume que todo módulo tiene ≥1 capítulo (deleteModule/deleteChapter/move
      // rechazan llegar a 0), así que la creación no puede producir un módulo con 0.
      const rows = await queryRunner.query(
        `with nm as (
           insert into public.course_modules (course_id, position, title, objective, exam_enabled, description)
           select $1::int, coalesce(max(position), -1) + 1, $2::text, $3::text, $4::boolean, $5::text
             from public.course_modules where course_id = $1
           returning id, position, title, objective, description, exam_enabled
         ),
         nc as (
           insert into public.course_chapters (course_id, module_id, position, title, video_enabled)
           select $1::int, nm.id, $6::int, $7::text, $8::boolean from nm
           returning id, position, title, objective, description, video_enabled, activity_enabled
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
            where co.id = $1
           returning co.structure_version_counter
         )
         select json_build_object('id', nm.id, 'position', nm.position, 'title', nm.title, 'objective', nm.objective,
                                  'description', nm.description, 'examEnabled', nm.exam_enabled) as module,
                json_build_object('id', nc.id, 'position', nc.position, 'title', nc.title, 'objective', nc.objective,
                                  'description', nc.description, 'videoEnabled', nc.video_enabled,
                                  'activityEnabled', nc.activity_enabled) as chapter,
                c.structure_version_counter as counter
           from nm, nc, c`,
        [courseId, nt.title, dto.objective || null, dto.examEnabled ?? true, description, 0, 'Nuevo capítulo', false],
      );
      const r = rows[0];
      if (!r) throw new Error(`createModule: el INSERT no devolvió filas en el curso #${courseId}`);
      const newCounter = this.counterOrThrow(r.counter, courseId);
      await queryRunner.commitTransaction();
      return {
        module: { ...this.jsonObject(r.module), chapters: [this.jsonObject(r.chapter)] },
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

      // R16: la fila existente solo se lee si hace falta su descripción (título
      // largo separado sin descripción nueva) o para respetar la precedencia de
      // siempre (módulo inexistente → 404 antes que un título inválido → 400).
      const notFound = () => new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      const readExisting = async (): Promise<{ description: string | null }> => {
        const existing = await queryRunner.query(
          `select id, description from public.course_modules where id = $1 and course_id = $2`,
          [moduleId, courseId],
        );
        if (existing.length === 0) {
          await queryRunner.rollbackTransaction();
          throw notFound();
        }
        return existing[0];
      };
      let nt: StructureTitleSplit | null = null;
      try {
        nt = dto.title !== undefined ? normalizeTitleOrThrow('module', dto.title) : null;
      } catch (err) {
        await readExisting();
        throw err;
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (nt) { sets.push(`title = $${i++}`); params.push(nt.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
      if (dto.examEnabled !== undefined) { sets.push(`exam_enabled = $${i++}`); params.push(dto.examEnabled); }
      let description: string | null | undefined;
      if (nt?.description) {
        const base = dto.description !== undefined ? cleanDescription(dto.description) : (await readExisting()).description;
        try {
          description = checkedDescription(mergeDescription(base, nt.description));
        } catch (err) {
          if (dto.description !== undefined) await readExisting();
          throw err;
        }
      } else if (dto.description !== undefined) description = cleanDescription(dto.description);
      if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }

      const found = await this.updateRowAndBump(queryRunner, 'course_modules', sets, params, i, { id: moduleId, course_id: courseId }, courseId);
      if (!found.found) {
        await queryRunner.rollbackTransaction();
        throw notFound();
      }
      const newCounter = found.counter;
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

      // R16: chequeo del módulo + max(position) + INSERT + counter en UNA sentencia
      // (antes 4 idas y vueltas). Precedencia de siempre: módulo inexistente → 404
      // antes que un título/descripción inválidos → 400 (solo en ese caso se consulta
      // el módulo por separado).
      const notFound = () => new NotFoundException(`Module ${moduleId} not found in course #${courseId}`);
      let nt: StructureTitleSplit;
      let description: string | null;
      try {
        nt = normalizeTitleOrThrow('chapter', dto.title);
        description = checkedDescription(mergeDescription(cleanDescription(dto.description), nt.description));
      } catch (err) {
        const moduleRows = await queryRunner.query(
          `select id from public.course_modules where id = $1 and course_id = $2`,
          [moduleId, courseId],
        );
        if (moduleRows.length === 0) {
          await queryRunner.rollbackTransaction();
          throw notFound();
        }
        throw err;
      }
      const rows = await queryRunner.query(
        `with m as (
           select id from public.course_modules where id = $2 and course_id = $1
         ),
         ins as (
           insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled, description)
           select $1::int, m.id,
                  coalesce((select max(position) from public.course_chapters where module_id = m.id), -1) + 1,
                  $3::text, $4::text, $5::boolean, $6::boolean, $7::text
             from m
           returning id, position, title, objective, description, video_enabled, activity_enabled
         ),
         c as (
           update public.courses co
              set structure_version_counter = co.structure_version_counter + 1
            where co.id = $1 and exists (select 1 from ins)
           returning co.structure_version_counter
         )
         select (select count(*)::int from m) as found,
                (select json_build_object('id', ins.id, 'position', ins.position, 'title', ins.title, 'objective', ins.objective,
                                          'description', ins.description, 'videoEnabled', ins.video_enabled,
                                          'activityEnabled', ins.activity_enabled) from ins) as chapter,
                (select structure_version_counter from c) as counter`,
        [courseId, moduleId, nt.title, dto.objective || null, dto.videoEnabled ?? false, dto.activityEnabled ?? true, description],
      );
      const r = rows[0];
      if (!r || Number(r.found) === 0) {
        await queryRunner.rollbackTransaction();
        throw notFound();
      }
      const newCounter = this.counterOrThrow(r.counter, courseId);
      await queryRunner.commitTransaction();
      return { chapter: this.jsonObject(r.chapter), structureVersionCounter: newCounter, titleNormalized: nt.changed };
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

      // R16: igual que updateModule — la fila solo se lee si hace falta su
      // descripción o para respetar la precedencia 404 → 400.
      const notFound = () => new NotFoundException(`Chapter ${chapterId} not found in module ${moduleId}`);
      const readExisting = async (): Promise<{ description: string | null }> => {
        const existing = await queryRunner.query(
          `select id, description from public.course_chapters where id = $1 and module_id = $2 and course_id = $3`,
          [chapterId, moduleId, courseId],
        );
        if (existing.length === 0) {
          await queryRunner.rollbackTransaction();
          throw notFound();
        }
        return existing[0];
      };
      let nt: StructureTitleSplit | null = null;
      try {
        nt = dto.title !== undefined ? normalizeTitleOrThrow('chapter', dto.title) : null;
      } catch (err) {
        await readExisting();
        throw err;
      }

      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (nt) { sets.push(`title = $${i++}`); params.push(nt.title); }
      if (dto.objective !== undefined) { sets.push(`objective = $${i++}`); params.push(dto.objective); }
      let description: string | null | undefined;
      if (nt?.description) {
        const base = dto.description !== undefined ? cleanDescription(dto.description) : (await readExisting()).description;
        try {
          description = checkedDescription(mergeDescription(base, nt.description));
        } catch (err) {
          if (dto.description !== undefined) await readExisting();
          throw err;
        }
      } else if (dto.description !== undefined) description = cleanDescription(dto.description);
      if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }
      if (dto.videoEnabled !== undefined) { sets.push(`video_enabled = $${i++}`); params.push(dto.videoEnabled); }
      if (dto.activityEnabled !== undefined) { sets.push(`activity_enabled = $${i++}`); params.push(dto.activityEnabled); }

      const found = await this.updateRowAndBump(
        queryRunner, 'course_chapters', sets, params, i, { id: chapterId, module_id: moduleId, course_id: courseId }, courseId,
      );
      if (!found.found) {
        await queryRunner.rollbackTransaction();
        throw notFound();
      }
      const newCounter = found.counter;
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
      // UUID sin distinción de mayúsculas (ParseUUIDPipe/IsUUID aceptan mayúsculas): el mismo módulo
      // escrito distinto no debe pasar como «otro» módulo y duplicar filas en el plan.
      const sameModule = String(dto.targetModuleId).toLowerCase() === String(sourceModuleId).toLowerCase();
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

  /**
   * R16: UPDATE de una fila (o, sin campos, solo su existencia) + el +1 del
   * counter en UNA sentencia. `where` usa el mismo filtro que la lectura de
   * existencia de antes (id + módulo + curso), así "0 filas" = 404. Si la fila
   * no existe, el counter NO se toca. Sin campos, igual se sube el counter
   * (como antes).
   */
  private async updateRowAndBump(
    queryRunner: QueryRunner,
    table: 'course_modules' | 'course_chapters',
    sets: string[],
    params: any[],
    nextIdx: number,
    where: Record<'id' | 'course_id', string | number> & { module_id?: string },
    courseId: number,
  ): Promise<{ found: boolean; counter: number }> {
    const p = params.slice();
    let i = nextIdx;
    const conds: string[] = [];
    for (const [col, v] of Object.entries(where)) {
      if (v === undefined) continue;
      conds.push(`t.${col} = $${i++}`);
      p.push(v);
    }
    const courseIdx = i++;
    p.push(courseId);
    const target = sets.length > 0
      ? `update public.${table} t set ${sets.join(', ')}, updated_at = now() where ${conds.join(' and ')} returning t.id`
      : `select t.id from public.${table} t where ${conds.join(' and ')}`;
    const rows = await queryRunner.query(
      `with u as (${target}),
       c as (
         update public.courses co
            set structure_version_counter = co.structure_version_counter + 1
          where co.id = $${courseIdx} and exists (select 1 from u)
         returning co.structure_version_counter
       )
       select (select count(*)::int from u) as n, (select structure_version_counter from c) as counter`,
      p,
    );
    const r = rows[0];
    if (!r || Number(r.n) === 0) return { found: false, counter: NaN };
    return { found: true, counter: this.counterOrThrow(r.counter, courseId) };
  }

  /** json_build_object del driver: objeto ya parseado o string. */
  private jsonObject(v: unknown): Record<string, any> {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fila JSON inválida');
    return parsed as Record<string, any>;
  }

  /** json/json_agg del driver: objeto ya parseado o string (según versión/driver). */
  private jsonRows(v: unknown): any[] {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed : [];
  }
}
