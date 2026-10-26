import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Institution } from './entities/institution.entity';
import { AuthUser } from '../../auth/auth.types';
import { AccessActor, actorFromUser, auditActor } from '../access/access-actor';
import { E } from '../access/access-errors';
import { rbacMode } from '../access/access-mode';
import { r75AccessSchemaPresent, UUID_RE } from '../access/access-schema';
import { AuditLogService } from '../access/audit-log.service';
import { INSTITUTION_COLUMNS, InstitutionDto, toInstitutionDto } from '../access/institution-dto';
import { InstitutionsAdminService } from '../access/institutions-admin.service';
import { MembershipsService } from '../access/memberships.service';
import { Permission } from '../access/role-matrix';

/**
 * Instituciones.
 *   - CURSIA_RBAC_MODE off (default, producción): EXACTAMENTE como antes (dueño único por owner_id), sin tocar tablas ni
 *     columnas r75.
 *   - shadow: como antes, y además al crear una institución el creador queda ADMIN_INSTITUCIONAL (membresía) para que
 *     el modelo nuevo no se desfase hasta el enforce.
 *   - enforce: listado y acceso por MEMBRESÍA (owner_id ya no otorga nada, 01 §1.1); crear `POST /institutions` solo el
 *     SuperAdmin (D-23 → 403 institution_create_forbidden); borrar solo el SA y solo si no tiene miembros ni cursos.
 * `findOne(id, ownerId)` legacy se conserva sin cambios (brand-profiles y otros lo usan con el dueño).
 */
@Injectable()
export class InstitutionsService {
  constructor(
    @InjectRepository(Institution)
    private readonly institutionsRepo: Repository<Institution>,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── API legacy (sin cambios) ───────────────────────────────────────────────

  async create(name: string, ownerId: string): Promise<Institution> {
    const slug = this.slugify(name);
    const existing = await this.institutionsRepo.findOne({ where: { slug } });
    if (existing) {
      throw new ConflictException(`Ya existe una institución con slug "${slug}"`);
    }
    const institution = this.institutionsRepo.create({ name, slug, ownerId });
    return this.institutionsRepo.save(institution);
  }

  async findAll(ownerId: string): Promise<Institution[]> {
    return this.institutionsRepo.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, ownerId: string): Promise<Institution> {
    const institution = await this.institutionsRepo.findOne({
      where: { id, ownerId },
    });
    if (!institution) {
      throw new NotFoundException(`Institución ${id} no encontrada`);
    }
    return institution;
  }

  async update(
    id: string,
    ownerId: string,
    changes: { name?: string },
  ): Promise<Institution> {
    const institution = await this.findOne(id, ownerId);
    if (changes.name) {
      institution.name = changes.name;
    }
    return this.institutionsRepo.save(institution);
  }

  async remove(id: string, ownerId: string): Promise<void> {
    const institution = await this.findOne(id, ownerId);
    await this.institutionsRepo.remove(institution);
  }

  // ── r75: según CURSIA_RBAC_MODE ────────────────────────────────────────────

  private optional<T>(token: any): T | null {
    try { return this.moduleRef.get<T>(token, { strict: false }) ?? null; } catch { return null; }
  }

  /** En enforce los servicios de AccessModule son obligatorios (falla cerrado si el lead no lo registró). */
  private required<T>(token: any): T {
    const svc = this.optional<T>(token);
    if (!svc) throw E.schemaMissing();
    return svc;
  }

  private async schemaPresent(): Promise<boolean> {
    return r75AccessSchemaPresent(this.institutionsRepo.manager);
  }

  private async permissionsIn(user: AuthUser, id: string): Promise<{ member: boolean; perms: Set<Permission> }> {
    const memberships = this.required<MembershipsService>(MembershipsService);
    const list = await memberships.listForUser(user.id);
    const m = list.find((x) => x.institutionId === id);
    return { member: !!m && m.status !== 'removed', perms: new Set(m ? m.permissions : []) };
  }

  private async dtoById(id: string): Promise<InstitutionDto | null> {
    const rows: any[] = await this.institutionsRepo.query(`select ${INSTITUTION_COLUMNS} from public.institutions i where i.id = $1`, [id]);
    return rows[0] ? toInstitutionDto(rows[0]) : null;
  }

  async createForActor(name: string, user: AuthUser): Promise<Institution | InstitutionDto> {
    const mode = rbacMode();
    const actor = actorFromUser(user);
    if (mode === 'enforce') {
      if (!actor.superAdmin) throw E.institutionCreateForbidden();
      return this.required<InstitutionsAdminService>(InstitutionsAdminService).create(actor, { name });
    }
    const inst = await this.create(name, user.id);
    if (mode === 'shadow' && (await this.schemaPresent())) await this.ensureCreatorMembership(inst.id, actor);
    return inst;
  }

  /** shadow: el creador queda ADMIN_INSTITUCIONAL de lo que crea (como hará el backfill con lo existente). */
  private async ensureCreatorMembership(instId: string, actor: AccessActor): Promise<void> {
    if (!UUID_RE.test(actor.userId)) return;
    const rows: any[] = await this.institutionsRepo.query(
      `insert into public.institution_memberships (institution_id, user_id, role, status, created_by, updated_by)
       values ($1, $2, 'ADMIN_INSTITUCIONAL', 'active', $2, $2)
       on conflict (institution_id, user_id) do nothing returning id`, [instId, actor.userId]);
    if (Array.isArray(rows) && rows.length) {
      const audit = this.optional<AuditLogService>(AuditLogService);
      await audit?.recordSafe({
        ...auditActor(actor), action: 'membership.add', targetType: 'membership', targetId: actor.userId, institutionId: instId,
        after: { userId: actor.userId, role: 'ADMIN_INSTITUCIONAL', status: 'active', source: 'institution.create(shadow)' },
      });
    }
  }

  async findAllForActor(user: AuthUser, all: boolean): Promise<Array<Institution | InstitutionDto>> {
    const mode = rbacMode();
    const actor = actorFromUser(user);
    if (all && actor.superAdmin && (await this.schemaPresent())) {
      return this.required<InstitutionsAdminService>(InstitutionsAdminService).listAll();
    }
    if (mode !== 'enforce') return this.findAll(user.id);
    if (!(await this.schemaPresent())) throw E.schemaMissing();
    const rows: any[] = await this.institutionsRepo.query(
      `select ${INSTITUTION_COLUMNS} from public.institutions i
         join public.institution_memberships m on m.institution_id = i.id and m.user_id = $1::uuid and m.status = 'active'
        order by i.created_at desc, i.id`, [user.id]);
    return rows.map(toInstitutionDto);
  }

  async findOneForActor(id: string, user: AuthUser): Promise<Institution | InstitutionDto> {
    if (rbacMode() !== 'enforce') return this.findOne(id, user.id);
    if (!UUID_RE.test(String(id || ''))) throw new NotFoundException(`Institución ${id} no encontrada`);
    const dto = await this.dtoById(id);
    if (!dto) throw new NotFoundException(`Institución ${id} no encontrada`);
    if (actorFromUser(user).superAdmin) return dto;
    const { member, perms } = await this.permissionsIn(user, id);
    if (!member) throw new NotFoundException(`Institución ${id} no encontrada`); // no revela que existe
    if (dto.status !== 'active') throw E.institutionInactive();
    if (!perms.has('courses.view')) throw E.permissionDenied('courses.view');
    return dto;
  }

  async updateForActor(id: string, user: AuthUser, changes: { name?: string }): Promise<Institution | InstitutionDto> {
    if (rbacMode() !== 'enforce') return this.update(id, user.id, changes);
    const actor = actorFromUser(user);
    if (!UUID_RE.test(String(id || ''))) throw new NotFoundException(`Institución ${id} no encontrada`);
    if (!actor.superAdmin) {
      const dto = await this.dtoById(id);
      if (!dto) throw new NotFoundException(`Institución ${id} no encontrada`);
      const { member, perms } = await this.permissionsIn(user, id);
      if (!member) throw new NotFoundException(`Institución ${id} no encontrada`);
      if (dto.status !== 'active') throw E.institutionInactive();
      if (!perms.has('roles.manage')) throw E.permissionDenied('roles.manage');
    }
    // Solo el nombre (el estado lo cambia el SA por PATCH /admin/institutions/:id). Auditado.
    return this.required<InstitutionsAdminService>(InstitutionsAdminService).update(actor, id, { name: changes?.name });
  }

  async removeForActor(id: string, user: AuthUser): Promise<void> {
    if (rbacMode() !== 'enforce') return this.remove(id, user.id);
    const actor = actorFromUser(user);
    if (!actor.superAdmin) throw E.permissionDenied('roles.manage');
    if (!UUID_RE.test(String(id || ''))) throw new NotFoundException(`Institución ${id} no encontrada`);
    const refs: any[] = await this.institutionsRepo.query(
      `select (select count(*) from public.institution_memberships where institution_id = $1)::int
            + (select count(*) from public.courses where institution_id = $1)::int as n`, [id]);
    if (Number(refs[0]?.n ?? 0) > 0) throw E.institutionHasMembers();
    const inst = await this.institutionsRepo.findOne({ where: { id } });
    if (!inst) throw new NotFoundException(`Institución ${id} no encontrada`);
    const audit = this.required<AuditLogService>(AuditLogService);
    await this.institutionsRepo.manager.transaction(async (m) => {
      await m.query(`delete from public.institutions where id = $1`, [id]);
      await audit.record({ ...auditActor(actor), action: 'institution.delete', targetType: 'institution', targetId: id, before: { name: inst.name, slug: inst.slug } }, m);
    });
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }
}
