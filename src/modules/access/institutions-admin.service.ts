import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccessActor, auditActor } from './access-actor';
import { E } from './access-errors';
import { r75AccessSchemaPresent, rowsOf, UUID_RE } from './access-schema';
import { AuditLogService, Queryable } from './audit-log.service';
import { INSTITUTION_COLUMNS, InstitutionDto, SLUG_RE, slugify, toInstitutionDto } from './institution-dto';

/**
 * r75 · A — administración de instituciones (solo SuperAdmin; D-23: solo el SA crea instituciones `organization`) y
 * movimiento manual y auditado de un curso entre instituciones (01 §1.8.7: el backfill nunca reasigna).
 */
@Injectable()
export class InstitutionsAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  private async assertSchema(): Promise<void> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
  }

  private async getDto(q: Queryable, id: string): Promise<InstitutionDto | null> {
    const rows: any[] = await q.query(
      `select ${INSTITUTION_COLUMNS},
              (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active') as member_count
         from public.institutions i where i.id = $1`, [id]);
    return rows[0] ? toInstitutionDto(rows[0]) : null;
  }

  async listAll(): Promise<InstitutionDto[]> {
    await this.assertSchema();
    const rows: any[] = await this.dataSource.query(
      `select ${INSTITUTION_COLUMNS},
              (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active') as member_count
         from public.institutions i order by i.created_at desc, i.id`);
    return rows.map(toInstitutionDto);
  }

  /** Crea una institución (SA). `q` permite reutilizarlo dentro de otra transacción. */
  async create(actor: AccessActor, body: { name?: unknown; slug?: unknown; kind?: unknown }): Promise<InstitutionDto> {
    await this.assertSchema();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) throw E.invalidInput('name es obligatorio (máx. 255).');
    if (body?.kind !== undefined && body.kind !== null && body.kind !== 'organization') throw E.invalidInput("kind solo admite 'organization'.");
    const slug = body?.slug === undefined || body?.slug === null || body.slug === '' ? slugify(name) : String(body.slug).trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw E.invalidInput('slug inválido (a-z, 0-9 y guiones).');
    let id = '';
    await this.dataSource.transaction(async (m) => {
      const dup: any[] = await m.query(`select 1 from public.institutions where slug = $1`, [slug]);
      if (dup.length) throw E.institutionSlugExists();
      let row: any;
      try {
        [row] = await m.query(
          `insert into public.institutions (owner_id, name, slug, kind, status, created_by)
           values ($1, $2, $3, 'organization', 'active', $1) returning id::text as id`, [actor.userId, name, slug]);
      } catch (err: any) {
        if (err?.code === '23505') throw E.institutionSlugExists();
        throw err;
      }
      id = row.id;
      await this.audit.record({
        ...auditActor(actor), action: 'institution.create', targetType: 'institution', targetId: id, institutionId: id,
        after: { name, slug, kind: 'organization', status: 'active' },
      }, m);
    });
    return (await this.getDto(this.dataSource, id))!;
  }

  async update(actor: AccessActor, id: string, body: { name?: unknown; status?: unknown }): Promise<InstitutionDto> {
    await this.assertSchema();
    if (!UUID_RE.test(String(id || ''))) throw E.institutionNotFound();
    const name = body?.name === undefined || body?.name === null ? null : typeof body.name === 'string' ? body.name.trim() : '';
    if (name !== null && (!name || name.length > 255)) throw E.invalidInput('name inválido (1–255).');
    const status = body?.status === undefined || body?.status === null ? null : String(body.status);
    if (status !== null && !['active', 'suspended', 'archived'].includes(status)) throw E.invalidStatus();
    if (name === null && status === null) throw E.invalidInput('Indica name o status.');
    await this.dataSource.transaction(async (m) => {
      const rows: any[] = await m.query(`select name, status from public.institutions where id = $1 for update`, [id]);
      if (!rows[0]) throw E.institutionNotFound();
      const next = { name: name ?? rows[0].name, status: status ?? rows[0].status };
      await m.query(`update public.institutions set name = $2, status = $3, updated_at = now() where id = $1`, [id, next.name, next.status]);
      await this.audit.record({
        ...auditActor(actor), action: 'institution.update', targetType: 'institution', targetId: id, institutionId: id,
        before: { name: rows[0].name, status: rows[0].status }, after: next,
      }, m);
    });
    return (await this.getDto(this.dataSource, id))!;
  }

  /** PATCH /admin/courses/:courseId/institution — única forma de mover un curso (manual, con motivo, auditada). */
  async moveCourse(actor: AccessActor, courseIdRaw: string, body: { institutionId?: unknown; reason?: unknown }): Promise<{ courseId: number; institutionId: string }> {
    await this.assertSchema();
    if (!/^\d{1,10}$/.test(String(courseIdRaw || ''))) throw E.courseNotFound();
    const courseId = Number(courseIdRaw);
    const instId = typeof body?.institutionId === 'string' ? body.institutionId : '';
    if (!UUID_RE.test(instId)) throw E.invalidInput('institutionId inválido.');
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!reason) throw E.reasonRequired();
    await this.dataSource.transaction(async (m) => {
      const inst: any[] = await m.query(`select status from public.institutions where id = $1`, [instId]);
      if (!inst[0]) throw E.institutionNotFound();
      if (inst[0].status !== 'active') throw E.institutionInactive();
      const cur: any[] = await m.query(
        `select institution_id::text as institution_id, owner_id from public.courses where id = $1 for update`, [courseId]);
      if (!cur[0]) throw E.courseNotFound();
      if (cur[0].institution_id === instId) return;
      rowsOf(await m.query(
        `update public.courses set institution_id = $2, updated_by = $3, updated_at = now() where id = $1`, [courseId, instId, actor.userId]));
      await this.audit.record({
        ...auditActor(actor), action: 'course.move_institution', targetType: 'course', targetId: courseId, institutionId: instId,
        before: { institutionId: cur[0].institution_id }, after: { institutionId: instId, reason },
      }, m);
    });
    return { courseId, institutionId: instId };
  }
}
