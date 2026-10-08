import { ACTIVE_RUN_WORKER_STATUSES } from '../dynamic-generation/item-transitions';
import { parseProposedHours } from '../course-design/design-pins';
import { returningRows } from '../../common/db/returning-rows';
import { DERIVED_FIELDS, DerivedField, FieldOwner, PEDAGOGY_DERIVATION_KEY, mergeDerivedProfile, parsePedagogyDerivation, pedagogyFieldOwners } from '../course-facts/course-facts';
import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { suggestProfileFromContext } from '../academic-context/context-design';
import type { PedagogicalProfile } from '../pedagogy/pedagogy-profile';
import { advanceStructureOriginIfUntouched } from '../course-structure/structure-authority';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import {
  AnyCourseProfile,
  ProfileKind,
  ProfileValidationError,
  defaultAssessmentProfile,
  PresentationDefaultSource,
  defaultPresentationProfileFor,
  isLightDefaultCourse,
  isProfileKind,
  normalizeProfile,
  profileSha256,
  validateAssessmentProfile,
  validateProfile,
} from './course-profiles';
import { DesignRules, deriveDesignRulesOrNull, designRulesRecord } from '../pedagogy/design-rules';
import { emptyPedagogicalProfile } from '../pedagogy/pedagogy-profile';
import { AcademicContextV1, emptyAcademicContext } from '../academic-context/academic-context';
import { AcademicValidation, validateAcademicContext } from '../academic-context/validate';

export interface PedagogyDerivationResult {
  applied: boolean;
  reason: 'derived' | 'no_changes' | 'invalid';
  version?: number;
  /** Datos del perfil que se actualizaron con el documento. */
  changes?: DerivedField[];
  /** Datos que decidió el docente, distintos del documento: se respetaron. */
  kept?: DerivedField[];
}

export interface CourseProfileDto {
  courseId: number;
  kind: ProfileKind;
  /** 0 = no hay versión guardada (default). */
  version: number;
  profile: AnyCourseProfile;
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
  /**
   * F1 (I4): solo en un default de presentación — `palette` si se derivó de la
   * paleta del usuario (query `paletteId` o `courses.metadata`), `fallback` si
   * es aula-clara/light. `null` en un perfil guardado o de evaluación.
   */
  defaultSource: PresentationDefaultSource | null;
  /** LOOP 8.1 — solo `pedagogy`: de qué versión del contexto salieron estudiante/resultados/horas y si siguen intactos. */
  derivedFromAcademic?: { academicVersion: number; untouched: boolean; owners: Record<DerivedField, FieldOwner> };
  /**
   * Motor pedagógico V1 — solo `pedagogy`: reglas de diseño derivadas del perfil (recalculadas en
   * cada lectura con el motor vigente; null si el perfil está vacío). `rulesStale` = la versión
   * guardada se calculó con otro motor (informativo: el lock siempre usa el motor vigente).
   */
  designRules?: ReturnType<typeof designRulesRecord> | null;
  rulesStale?: boolean;
  /**
   * Fase 3 — solo `academic`: validación semántica del contexto (errores / advertencias / faltantes), recalculada
   * en cada lectura. `canProceed: false` impide usarlo en el diseño, nunca guardarlo.
   */
  academicValidation?: AcademicValidation;
}

/** Migración que habilita cada kind nuevo (mensaje 503 claro si el entorno no la tiene). */
const KIND_MIGRATION: Record<string, string> = {
  pedagogy: 'supabase-migration-pedagogy-profiles.sql',
  academic: 'supabase-migration-academic-context.sql',
};

function pedagogyRulesRecord(profile: AnyCourseProfile): ReturnType<typeof designRulesRecord> | null {
  const rules: DesignRules | null = deriveDesignRulesOrNull(profile);
  return rules ? designRulesRecord(rules) : null;
}

/** F1 (I4): id de paleta guardado en `courses.metadata` (`paletteId` o `pal.id`), si lo hay. */
export function paletteIdFromCourseMetadata(metadata: unknown): string | null {
  let m: any = metadata;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return null; }
  }
  const id = m?.paletteId ?? m?.pal?.id ?? null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

const PROFILE_VERSION_UNIQUE = 'course_profiles_course_kind_version_key';

function toIso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function isKindCheckViolation(err: any): boolean {
  const e = err?.driverError ?? err;
  return (err?.code === '23514' || e?.code === '23514') &&
    (err?.constraint === 'course_profiles_kind_check' || e?.constraint === 'course_profiles_kind_check');
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
      throw new BadRequestException(`Tipo de perfil inválido: "${kind}" (permitidos: presentation, assessment, pedagogy, academic)`);
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

  /**
   * `paletteId` (F1/I4, opcional, solo presentación): la paleta elegida en el
   * frontend; sin perfil guardado, el default se deriva de ella. Nunca
   * persiste: guardar es un POST explícito (el frontend lo hace a la vista).
   */
  async getCurrent(courseId: number, ownerId: string, kind: string, paletteId?: string | null): Promise<CourseProfileDto> {
    this.assertKind(kind);
    await this.loadCourse(courseId, ownerId);
    const finalExam = await this.readFinalExam(this.dataSource, courseId);
    const [row] = await this.dataSource.query(
      `select * from public.course_profiles where course_id = $1 and kind = $2 order by version desc limit 1`,
      [courseId, kind],
    );
    if (!row) {
      if (kind === 'presentation') {
        let pid = typeof paletteId === 'string' && paletteId.trim() ? paletteId.trim() : null;
        const [c] = await this.dataSource.query(`select metadata, created_at from public.courses where id = $1`, [courseId]);
        if (!pid) pid = paletteIdFromCourseMetadata(c?.metadata);
        // V542 (G2): curso nuevo → Aula Clara (claro) con los colores de la paleta; los anteriores, como siempre.
        const d = defaultPresentationProfileFor(pid, { lightDefault: isLightDefaultCourse(c?.created_at) });
        return {
          courseId, kind, version: 0, profile: d.profile, sha256: profileSha256(d.profile), isDefault: true,
          createdAt: null, createdBy: null, warnings: d.warnings, defaultSource: d.source,
        };
      }
      if (kind === 'pedagogy') {
        // Motor pedagógico V1: sin perfil guardado = sin enfoque (el comportamiento de siempre).
        const empty = emptyPedagogicalProfile();
        return {
          courseId, kind, version: 0, profile: empty, sha256: profileSha256(empty), isDefault: true,
          createdAt: null, createdBy: null, warnings: [], defaultSource: null, designRules: null, rulesStale: false,
        };
      }
      if (kind === 'academic') {
        // Fase 3: sin contexto guardado = el comportamiento de siempre (el diseño no usa ningún contexto).
        const empty = emptyAcademicContext();
        return {
          courseId, kind, version: 0, profile: empty, sha256: profileSha256(empty), isDefault: true,
          createdAt: null, createdBy: null, warnings: [], defaultSource: null, academicValidation: validateAcademicContext(empty),
        };
      }
      const profile = defaultAssessmentProfile({ finalExam });
      return {
        courseId, kind, version: 0, profile, sha256: profileSha256(profile), isDefault: true,
        createdAt: null, createdBy: null, warnings: [], defaultSource: null,
      };
    }
    const dto = this.toDto(row, finalExam);
    if (kind === 'pedagogy') {
      // LOOP 8.1: ¿los campos del documento (estudiante, resultados, horas) siguen como Cursia los derivó?
      const [c] = await this.dataSource.query(`select metadata -> 'pedagogyDerivation' as d, metadata -> 'designHours' as h from public.courses where id = $1`, [courseId]);
      const record = parsePedagogyDerivation(c ? (typeof c.d === 'string' ? JSON.parse(c.d) : c.d) : null);
      const proposedHours = parseProposedHours(c ? (typeof c.h === 'string' ? JSON.parse(c.h) : c.h) : null);
      const academic = record ? await loadCurrentAcademicContext(this.dataSource, courseId).catch(() => null) : null;
      if (record && academic) {
        const suggested = suggestProfileFromContext(academic.context, null).profile;
        const owners = pedagogyFieldOwners(dto.profile as PedagogicalProfile, record, suggested, proposedHours);
        return { ...dto, derivedFromAcademic: { academicVersion: record.academicVersion, untouched: !DERIVED_FIELDS.some((f) => owners[f] === 'user'), owners } };
      }
    }
    return dto;
  }

  async append(
    courseId: number,
    ownerId: string,
    kind: string,
    data: unknown,
    expectedVersion?: number,
  ): Promise<{ created: boolean; profile: CourseProfileDto; prunedOutcomeLinks?: { chapterId: string; removed: string[] }[]; derivedPedagogy?: PedagogyDerivationResult }> {
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
      // Prebrief (review BE-2 I1): mientras se produce un curso desde una propuesta aprobada, la evaluación y el tema no
      // cambian (Gamma y el empaque los leen en vivo: un cambio a mitad mezclaría lo aprobado con lo no aprobado).
      // to_regclass nunca falla: sin las tablas del Prebrief (producción) no se consulta nada y la transacción sigue sana
      // (un 42P01 dentro de la transacción la abortaría y la siguiente consulta respondería 25P02).
      const [prebriefTables] = kind === 'assessment' || kind === 'presentation'
        ? await qr.query(`select to_regclass('public.course_prebrief_events') is not null as present`)
        : [{ present: false }];
      if (prebriefTables?.present) {
        const [busy] = await qr.query(
          `select 1 as x from public.production_jobs j
             join public.course_prebrief_events e on e.course_id = j.course_id and e.type = 'generation_started' and e.payload ->> 'runId' = j.id::text
            where j.course_id = $1 and j.execution_mode = 'dynamic_generation' and j.worker_status = any($2::text[]) limit 1`,
          [courseId, ACTIVE_RUN_WORKER_STATUSES],
        );
        if (busy) {
          await qr.rollbackTransaction();
          throw new ConflictException({ code: 'PROFILE_LOCKED_DURING_PRODUCTION', message: 'PROFILE_LOCKED_DURING_PRODUCTION: el curso se está produciendo sobre la propuesta aprobada; la evaluación y el tema se pueden cambiar cuando termine.' });
        }
      }
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
      // Motor pedagógico V1: se guardan junto al perfil las reglas que derivó el servidor (nunca las del cliente).
      const stored = kind === 'pedagogy' ? { ...profile, designRules: pedagogyRulesRecord(profile) } : profile;

      const [latest] = await qr.query(
        `select * from public.course_profiles where course_id = $1 and kind = $2 order by version desc limit 1`,
        [courseId, kind],
      );
      const currentVersion = latest ? Number(latest.version) : 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        await qr.rollbackTransaction();
        throw new ConflictException(
          `El perfil "${kind}" del curso #${courseId} cambió: expectedVersion=${expectedVersion}, actual=${currentVersion}. ` +
            'Vuelve a leerlo (GET) antes de guardar.',
        );
      }
      if (latest && latest.sha256 === sha) {
        // Review N6: re-guardar el mismo contexto también limpia vínculos rotos (p. ej. anteriores a la poda).
        const prunedSame = kind === 'academic' ? await this.pruneStaleOutcomeLinks(qr, courseId, profile as AcademicContextV1) : [];
        // El DTO se arma ANTES de confirmar (review N-M1): un fallo de integridad no deja la poda confirmada con un 500.
        const dto = this.toDto(latest, finalExam);
        if (prunedSame.length) await qr.commitTransaction();
        else await qr.rollbackTransaction();
        return { created: false, profile: dto, ...(prunedSame.length ? { prunedOutcomeLinks: prunedSame } : {}) };
      }

      const [row] = await qr.query(
        `insert into public.course_profiles (course_id, kind, version, data, sha256, created_by)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning *`,
        [courseId, kind, currentVersion + 1, JSON.stringify(stored), sha, ownerId],
      );
      // Fase 3 (review I1): una versión nueva del contexto que ya no define un resultado vinculado deja ese vínculo
      // roto (y el lock fallaría). En la MISMA transacción se quitan de los capítulos los ids que la versión nueva no
      // define; si cambió alguno, sube el counter de la estructura (las pestañas abiertas releen).
      const pruned = kind === 'academic' ? await this.pruneStaleOutcomeLinks(qr, courseId, profile as AcademicContextV1) : [];
      // LOOP 8.1: el documento es dueño del estudiante, los resultados y las horas del perfil pedagógico. Se derivan
      // EN LA MISMA transacción (sin botón «Usar en el perfil»), salvo que el docente los haya cambiado a mano.
      // Review L81 I1c: un dato igual a lo que proponía la versión ANTERIOR del documento también es del documento
      // (perfiles anteriores a 8.1 que usaron «Usar en el perfil»).
      const previousContext = kind === 'academic' && latest
        ? (normalizeProfile('academic', typeof latest.data === 'string' ? JSON.parse(latest.data) : latest.data) as AcademicContextV1)
        : null;
      const derivedPedagogy = kind === 'academic'
        ? await this.derivePedagogyFromAcademic(qr, courseId, ownerId, profile as AcademicContextV1, currentVersion + 1, finalExam, [], previousContext)
        : undefined;
      await qr.commitTransaction();
      return {
        created: true,
        profile: this.toDto(row, finalExam),
        ...(pruned.length ? { prunedOutcomeLinks: pruned } : {}),
        ...(derivedPedagogy ? { derivedPedagogy } : {}),
      };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      if (isVersionConflict(err)) {
        throw new ConflictException('Otro guardado del perfil en curso, vuelve a leerlo y reintenta');
      }
      // Motor pedagógico V1 (review M6): base sin la migración pedagogy → mensaje claro, no un 500.
      if (isKindCheckViolation(err)) {
        throw new ServiceUnavailableException(
          `Este entorno todavía no admite perfiles "${kind}" (falta la migración ${KIND_MIGRATION[kind] ?? 'de perfiles'}).`,
        );
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * LOOP 8.1 · Perfil pedagógico derivado del contexto académico (antes: botón «Usar en el perfil»). Conserva enfoque,
   * preferencias y todo lo que no viene del documento. Solo reescribe los campos del documento si siguen como Cursia
   * los dejó (o vacíos); si el docente los cambió a mano, no se tocan y «Lo que sabemos del curso» informa el conflicto.
   */
  private async derivePedagogyFromAcademic(
    qr: QueryRunner,
    courseId: number,
    ownerId: string,
    ctx: AcademicContextV1,
    academicVersion: number,
    finalExam: boolean,
    force: readonly DerivedField[] = [],
    previousContext: AcademicContextV1 | null = null,
  ): Promise<PedagogyDerivationResult> {
    const [latest] = await qr.query(
      `select * from public.course_profiles where course_id = $1 and kind = 'pedagogy' order by version desc limit 1`,
      [courseId],
    );
    const current = latest
      ? (normalizeProfile('pedagogy', typeof latest.data === 'string' ? JSON.parse(latest.data) : latest.data) as PedagogicalProfile)
      : (normalizeProfile('pedagogy', emptyPedagogicalProfile()) as PedagogicalProfile);
    const [c] = await qr.query(`select metadata -> 'pedagogyDerivation' as d, metadata -> 'designHours' as h from public.courses where id = $1`, [courseId]);
    const record = parsePedagogyDerivation(c ? (typeof c.d === 'string' ? JSON.parse(c.d) : c.d) : null);
    // LOOP 8.3 (review L83 I-3): horas que propuso Cursia: el documento las reemplaza (no son una decisión del docente).
    const proposedHours = parseProposedHours(c ? (typeof c.h === 'string' ? JSON.parse(c.h) : c.h) : null);
    // Review L81 I1: dueño POR CAMPO. Los vacíos y los que siguen como Cursia los dejó toman el valor del documento; los
    // que decidió el docente se respetan (salvo que pida explícitamente usar los del documento: `force`).
    const suggested = suggestProfileFromContext(ctx, null).profile;
    const previousSuggested = previousContext ? suggestProfileFromContext(previousContext, null).profile : null;
    const owners = pedagogyFieldOwners(latest ? current : null, record, [suggested, previousSuggested], proposedHours);
    const merged = mergeDerivedProfile(current, suggested, owners, academicVersion, force);
    const writeRecord = () =>
      qr.query(
        `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
        [courseId, [PEDAGOGY_DERIVATION_KEY], JSON.stringify(merged.record)],
      );
    if (!merged.changed.length) {
      await writeRecord();
      return { applied: false, reason: 'no_changes', kept: merged.kept };
    }
    if (validateProfile('pedagogy', merged.profile, { finalExam }).length) return { applied: false, reason: 'invalid', kept: merged.kept };
    const next = normalizeProfile('pedagogy', merged.profile) as PedagogicalProfile;
    const version = latest ? Number(latest.version) + 1 : 1;
    await qr.query(
      `insert into public.course_profiles (course_id, kind, version, data, sha256, created_by)
       values ($1, 'pedagogy', $2, $3::jsonb, $4, $5)`,
      [courseId, version, JSON.stringify({ ...next, designRules: pedagogyRulesRecord(next) }), profileSha256(next), ownerId],
    );
    await writeRecord();
    return { applied: true, reason: 'derived', version, changes: merged.changed, kept: merged.kept };
  }

  /**
   * LOOP 8.1 (review L81 I1e) · «Usar los datos del documento»: decisión explícita del docente de reemplazar en el perfil
   * los datos que había cambiado (`fields`, o todos los que difieren) por los del contexto académico vigente.
   */
  async useDocumentInPedagogy(courseId: number, ownerId: string, fields?: string[], expectedVersion?: number): Promise<PedagogyDerivationResult> {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const force = (fields && fields.length ? fields : DERIVED_FIELDS).filter((f): f is DerivedField => (DERIVED_FIELDS as readonly string[]).includes(f));
    if (!force.length) throw new BadRequestException({ code: 'INVALID_FIELDS', message: 'INVALID_FIELDS: indica qué datos del perfil reemplazar con el documento.' });
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`select id from public.courses where id = $1 for update`, [courseId]);
      const academic = await loadCurrentAcademicContext(qr, courseId);
      if (!academic) {
        await qr.rollbackTransaction();
        throw new BadRequestException({ code: 'NO_ACADEMIC_CONTEXT', message: 'NO_ACADEMIC_CONTEXT: el curso no tiene contexto académico guardado.' });
      }
      if (expectedVersion !== undefined) {
        const [p] = await qr.query(`select version from public.course_profiles where course_id = $1 and kind = 'pedagogy' order by version desc limit 1`, [courseId]);
        const current = p ? Number(p.version) : 0;
        if (current !== expectedVersion) {
          await qr.rollbackTransaction();
          throw new ConflictException(`El perfil "pedagogy" del curso #${courseId} cambió: expectedVersion=${expectedVersion}, actual=${current}. Vuelve a leerlo (GET) antes de usar los datos del documento.`);
        }
      }
      const finalExam = await this.readFinalExam(qr, courseId);
      const r = await this.derivePedagogyFromAcademic(qr, courseId, ownerId, academic.context, academic.version, finalExam, force);
      await qr.commitTransaction();
      return r;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /** Fase 3 (I1): quita de course_chapters.outcome_ids los ids que el contexto `ctx` no define. */
  private async pruneStaleOutcomeLinks(qr: QueryRunner, courseId: number, ctx: AcademicContextV1): Promise<{ chapterId: string; removed: string[] }[]> {
    const rows: { id: string; ids: unknown }[] = await qr.query(
      `select id, to_jsonb(ch) -> 'outcome_ids' as ids from public.course_chapters ch
        where ch.course_id = $1 and jsonb_typeof(to_jsonb(ch) -> 'outcome_ids') = 'array'`,
      [courseId],
    );
    const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
    const out: { chapterId: string; removed: string[] }[] = [];
    for (const r of rows) {
      const ids = Array.isArray(r.ids) ? (r.ids as string[]) : [];
      const keep = ids.filter((x) => known.has(x));
      if (keep.length === ids.length) continue;
      await qr.query(`update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3`, [keep.length ? JSON.stringify(keep) : null, r.id, courseId]);
      out.push({ chapterId: r.id, removed: ids.filter((x) => !known.has(x)) });
    }
    if (out.length) {
      // Review L80 R2-M1: el contador nuevo sale del mismo UPDATE (append ya tiene la fila del curso FOR UPDATE).
      const res = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
      const before = Number(returningRows(res)[0].c) - 1;
      // LOOP 8.0 (review L80 I2): quitar vínculos que el contexto nuevo ya no define es trabajo de Cursia, no del
      // docente: una estructura de Cursia intacta lo sigue siendo (el documento nuevo la puede reemplazar sin preguntar).
      await advanceStructureOriginIfUntouched(qr, courseId, before, before + 1);
    }
    return out;
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
    const base: CourseProfileDto = {
      courseId: row.course_id,
      kind,
      version: Number(row.version),
      profile,
      sha256: row.sha256,
      isDefault: false,
      createdAt: toIso(row.created_at),
      createdBy: row.created_by ?? null,
      warnings: kind === 'assessment' ? validateAssessmentProfile(profile as any, { finalExam }) : [],
      defaultSource: null,
    };
    if (kind === 'academic') return { ...base, academicValidation: validateAcademicContext(profile as AcademicContextV1) };
    if (kind !== 'pedagogy') return base;
    const designRules = pedagogyRulesRecord(profile);
    const storedEngine = stored?.designRules?.engineVersion ?? null;
    return { ...base, designRules, rulesStale: designRules !== null && storedEngine !== designRules.engineVersion };
  }
}
