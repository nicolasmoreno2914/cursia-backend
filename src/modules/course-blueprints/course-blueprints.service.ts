import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import {
  BlueprintSnapshotV1,
  RawChapterRow,
  RawModuleRow,
  buildBlueprintSnapshot,
  canonicalJson,
  snapshotSha256,
  validateBlueprintInput,
} from './blueprint-snapshot';

export interface BlueprintSummaryDto {
  id: number;
  courseId: number;
  blueprintNumber: number;
  schemaVersion: number;
  sha256: string;
  structureCounterAtLock: number;
  moduleCount: number;
  chapterCount: number;
  lockedAt: string;
  lockedBy: string | null;
  isCurrent: boolean;
}

export interface BlueprintDto {
  id: number;
  courseId: number;
  blueprintNumber: number;
  schemaVersion: number;
  snapshot: BlueprintSnapshotV1;
  sha256: string;
  structureCounterAtLock: number;
  moduleCount: number;
  chapterCount: number;
  lockedAt: string;
  lockedBy: string | null;
}

export interface CurrentBlueprintInfo {
  id: number;
  number: number;
  lockedAt: string;
  sha256: string;
}

const OWNERSHIP_FILTER = `(owner_id = $2 or ($3 = true and owner_id is null))`;
const BLUEPRINT_NUMBER_UNIQUE = 'course_blueprints_course_number_key';

function allowUnownedCourses(): boolean {
  return process.env.ALLOW_UNOWNED_COURSES === 'true';
}

function toIso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function isBlueprintNumberConflict(err: any): boolean {
  const e = err?.driverError ?? err;
  return (err?.code === '23505' || e?.code === '23505') &&
    (err?.constraint === BLUEPRINT_NUMBER_UNIQUE || e?.constraint === BLUEPRINT_NUMBER_UNIQUE);
}

@Injectable()
export class CourseBlueprintsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Confirma ("lockea") la estructura viva como un Blueprint inmutable.
   *
   * Todo en UNA transacción sobre la conexión del queryRunner:
   * `FOR UPDATE` sobre la fila del curso (con el mismo filtro de ownership
   * que Fase 2) serializa locks concurrentes; el segundo ve el `current`
   * recién commiteado con el mismo hash y devuelve `created:false`.
   * `blueprint_number` = max+1 bajo ese lock; el UNIQUE
   * (course_id, blueprint_number) es solo el respaldo → 409.
   * `structure_version_counter` NO se toca (crear un Blueprint no es una
   * edición de estructura).
   */
  async lock(
    courseId: number,
    ownerId: string,
    expectedCounter: number,
  ): Promise<{ created: boolean; blueprint: BlueprintDto }> {
    const qr: QueryRunner = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();

      const [course] = await qr.query(
        `select id, title, structure_version, structure_version_counter, current_blueprint_id
           from public.courses
          where id = $1 and ${OWNERSHIP_FILTER}
          for update`,
        [courseId, ownerId, allowUnownedCourses()],
      );
      if (!course) {
        await qr.rollbackTransaction();
        throw new NotFoundException(`Course #${courseId} not found`);
      }
      if (course.structure_version !== 'dynamic') {
        await qr.rollbackTransaction();
        throw new BadRequestException(
          `El curso #${courseId} es "${course.structure_version}" — esta API solo admite cursos "dynamic".`,
        );
      }

      const modules: RawModuleRow[] = await qr.query(
        `select id, position, title, objective, exam_enabled from public.course_modules where course_id = $1`,
        [courseId],
      );
      const chapters: RawChapterRow[] = await qr.query(
        `select id, module_id, position, title, objective, video_enabled from public.course_chapters where course_id = $1`,
        [courseId],
      );

      if (course.structure_version_counter !== expectedCounter) {
        await qr.rollbackTransaction();
        // El filtro global (AllExceptionsFilter) reduce cualquier body de
        // HttpException a { error: <string> } — currentCounter/structure acá
        // se pierden en el cliente real. El texto del mensaje es la única
        // información que llega, así que tiene que ser autocontenido; el
        // cliente reconcilia con un GET en vez de leer `structure`.
        throw new ConflictException(
          `La estructura del curso #${courseId} cambió desde que se leyó: ` +
            `expectedCounter=${expectedCounter}, actual=${course.structure_version_counter}. ` +
            'Volvé a leer la estructura (GET) antes de reintentar el lock.',
        );
      }

      const courseRef = { id: course.id, title: course.title };
      // validateBlueprintInput ANTES de build: build tira en capítulos
      // huérfanos (guard de último recurso); acá los queremos como 400.
      const errors = validateBlueprintInput(courseRef, modules, chapters);
      if (errors.length > 0) {
        await qr.rollbackTransaction();
        // Igual que el 409: el filtro global colapsa el body de la excepción
        // a { error: <string> } (ver AllExceptionsFilter.catch — usa
        // `message.message` cuando getResponse() es un objeto), así que el
        // `errors` array nunca llega al cliente si no está también dentro
        // del mensaje. Lo embebemos como texto humano-legible y dejamos
        // `errors` en la excepción igual (inofensivo, útil si algo lee
        // getResponse() directamente, p.ej. tests).
        const detail = errors.map((e) => e.message).join('; ');
        throw new BadRequestException({
          message: `La estructura no cumple las validaciones para crear un Blueprint: ${detail}`,
          errors,
        });
      }

      const snapshot = buildBlueprintSnapshot(courseRef, modules, chapters);
      const canonical = canonicalJson(snapshot);
      const sha = snapshotSha256(snapshot);

      if (course.current_blueprint_id != null) {
        const [cur] = await qr.query(
          `select * from public.course_blueprints where id = $1 and course_id = $2`,
          [course.current_blueprint_id, courseId],
        );
        if (cur && cur.snapshot_sha256 === sha) {
          await qr.rollbackTransaction();
          return { created: false, blueprint: this.toDto(cur) };
        }
      }

      const chapterCount = snapshot.modules.reduce((n, m) => n + m.chapters.length, 0);
      const [{ next }] = await qr.query(
        `select coalesce(max(blueprint_number), 0) + 1 as next from public.course_blueprints where course_id = $1`,
        [courseId],
      );
      const [row] = await qr.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256,
            structure_counter_at_lock, module_count, chapter_count, locked_by)
         values ($1, $2, 1, $3::jsonb, $4, $5, $6, $7, $8)
         returning *`,
        [courseId, Number(next), canonical, sha, course.structure_version_counter,
          snapshot.modules.length, chapterCount, ownerId],
      );

      const updated = returningRows(await qr.query(
        `update public.courses set current_blueprint_id = $1 where id = $2 returning id`,
        [row.id, courseId],
      ));
      if (updated.length !== 1) {
        throw new Error(`lock: no se pudo apuntar current_blueprint_id del curso #${courseId}`);
      }

      await qr.commitTransaction();
      // El snapshot devuelto es el canonicalJson persistido, re-parseado (no
      // el objeto en memoria ni el jsonb, que Postgres reordena).
      return { created: true, blueprint: this.toDto(row, canonical) };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      if (isBlueprintNumberConflict(err)) {
        throw new ConflictException({ message: 'Otro lock en curso, reintentá' });
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  async list(courseId: number, ownerId: string): Promise<BlueprintSummaryDto[]> {
    const course = await this.loadReadableCourse(courseId, ownerId);
    const rows = await this.dataSource.query(
      `select id, course_id, blueprint_number, schema_version, snapshot_sha256,
              structure_counter_at_lock, module_count, chapter_count, locked_at, locked_by
         from public.course_blueprints
        where course_id = $1
        order by blueprint_number desc`,
      [courseId],
    );
    return rows.map((r: any) => ({
      id: r.id,
      courseId: r.course_id,
      blueprintNumber: r.blueprint_number,
      schemaVersion: r.schema_version,
      sha256: r.snapshot_sha256,
      structureCounterAtLock: r.structure_counter_at_lock,
      moduleCount: r.module_count,
      chapterCount: r.chapter_count,
      lockedAt: toIso(r.locked_at),
      lockedBy: r.locked_by ?? null,
      isCurrent: course.current_blueprint_id != null && r.id === course.current_blueprint_id,
    }));
  }

  async getCurrent(courseId: number, ownerId: string): Promise<BlueprintDto> {
    const course = await this.loadReadableCourse(courseId, ownerId);
    if (course.current_blueprint_id == null) {
      throw new NotFoundException(`El curso #${courseId} no tiene un Blueprint confirmado`);
    }
    const [row] = await this.dataSource.query(
      `select * from public.course_blueprints where id = $1 and course_id = $2`,
      [course.current_blueprint_id, courseId],
    );
    if (!row) throw new NotFoundException(`El curso #${courseId} no tiene un Blueprint confirmado`);
    return this.toDto(row);
  }

  async getByNumber(courseId: number, ownerId: string, n: number): Promise<BlueprintDto> {
    await this.loadReadableCourse(courseId, ownerId);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException('El número de Blueprint debe ser un entero ≥ 1');
    }
    const [row] = await this.dataSource.query(
      `select * from public.course_blueprints where course_id = $1 and blueprint_number = $2`,
      [courseId, n],
    );
    if (!row) throw new NotFoundException(`Blueprint v${n} no existe en el curso #${courseId}`);
    return this.toDto(row);
  }

  /**
   * Resumen del Blueprint vigente para `GET /courses/:id/modules` (Task 4).
   * NO verifica ownership ni `dynamic`: el caller ya lo hizo con su propio
   * chequeo antes de llamar (no duplicar la query ni el 404/400).
   */
  async currentInfo(courseId: number): Promise<CurrentBlueprintInfo | null> {
    const [row] = await this.dataSource.query(
      `select b.id, b.blueprint_number, b.locked_at, b.snapshot_sha256
         from public.courses c join public.course_blueprints b
           on b.id = c.current_blueprint_id and b.course_id = c.id
        where c.id = $1`,
      [courseId],
    );
    if (!row) return null;
    return { id: row.id, number: row.blueprint_number, lockedAt: toIso(row.locked_at), sha256: row.snapshot_sha256 };
  }

  /**
   * Ownership + `dynamic` para las lecturas, con una query propia (nunca
   * `CoursesService.findOne`, que abre otra conexión y joinea
   * `course_versions`). 404 no revela si el curso existe.
   */
  private async loadReadableCourse(
    courseId: number,
    ownerId: string,
  ): Promise<{ id: number; structure_version: string; current_blueprint_id: number | null }> {
    const [course] = await this.dataSource.query(
      `select id, structure_version, current_blueprint_id
         from public.courses
        where id = $1 and ${OWNERSHIP_FILTER}`,
      [courseId, ownerId, allowUnownedCourses()],
    );
    if (!course) throw new NotFoundException(`Course #${courseId} not found`);
    if (course.structure_version !== 'dynamic') {
      throw new BadRequestException(
        `El curso #${courseId} es "${course.structure_version}" — esta API solo admite cursos "dynamic".`,
      );
    }
    return course;
  }

  /**
   * `canonical` = el string exacto que se insertó (camino de creación).
   * Sin él (lecturas / idempotente) se reconstruye el orden canónico desde
   * el jsonb — Postgres reordena las claves de los objetos jsonb — y se
   * verifica contra `snapshot_sha256`: si no coincide se falla fuerte en vez
   * de devolver un snapshot que no es el que se hasheó.
   */
  private toDto(row: any, canonical?: string): BlueprintDto {
    let snapshot: BlueprintSnapshotV1;
    if (canonical !== undefined) {
      snapshot = JSON.parse(canonical);
    } else {
      snapshot = this.recanonicalize(row.snapshot_json);
      if (snapshotSha256(snapshot) !== row.snapshot_sha256) {
        throw new Error(
          `Blueprint #${row.id}: el snapshot guardado no coincide con su sha256 (integridad rota)`,
        );
      }
      snapshot = JSON.parse(canonicalJson(snapshot));
    }
    return {
      id: row.id,
      courseId: row.course_id,
      blueprintNumber: row.blueprint_number,
      schemaVersion: row.schema_version,
      snapshot,
      sha256: row.snapshot_sha256,
      structureCounterAtLock: row.structure_counter_at_lock,
      moduleCount: row.module_count,
      chapterCount: row.chapter_count,
      lockedAt: toIso(row.locked_at),
      lockedBy: row.locked_by ?? null,
    };
  }

  /**
   * Re-arma un snapshot v1 leído de jsonb con el orden de claves canónico,
   * pasándolo de nuevo por `buildBlueprintSnapshot` (única fuente del orden).
   */
  private recanonicalize(stored: any): BlueprintSnapshotV1 {
    const s = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!s || s.schemaVersion !== 1) {
      throw new Error(`Blueprint con schemaVersion no soportado: ${s?.schemaVersion}`);
    }
    const modules: RawModuleRow[] = [];
    const chapters: RawChapterRow[] = [];
    for (const m of s.modules) {
      modules.push({ id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled });
      for (const c of m.chapters) {
        chapters.push({ id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective, video_enabled: c.videoEnabled });
      }
    }
    return buildBlueprintSnapshot({ id: s.course.id, title: s.course.title }, modules, chapters);
  }
}
