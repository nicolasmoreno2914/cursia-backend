import {
  BadRequestException,
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { AccessContext } from './access-context';
import { REQUEST_ACCESS_KEY } from './access.decorator';
import { AuthzMode, rbacMode } from './authz-flags';
import { normalizePath } from './account-access.guard';
import { Actor, PermissionDecision, PermissionService } from './permission.service';
import { AUTHZ_ERRORS, Permission } from './permissions';
import { AUTHZ_REQUIRE_PERMISSION_KEY, PermissionRequirement, PermissionScope, ResourceRef } from './require-permission.decorator';
import { resolveArtifact, resolveCourse, resolveRun } from './resource-resolver';
import { isUuid } from './schema-probe';

/** Header de institución activa (01 §3.1). No es secreto; nunca otorga nada sin verificar la membresía. */
export const INSTITUTION_HEADER = 'x-cursia-institution';

export function readRef(req: any, ref: ResourceRef): unknown {
  const [src, ...rest] = ref.split(':');
  const key = rest.join(':');
  if (src === 'param') return req?.params?.[key];
  if (src === 'body') return req?.body?.[key];
  if (src === 'query') return req?.query?.[key];
  return undefined;
}

/** Recurso resuelto para una ruta: institución, dueño técnico y el «legacy allowed» (dueño único de hoy). */
export interface ScopeResolution {
  kind: 'course' | 'run' | 'artifact' | 'institution' | 'collection' | 'global';
  concrete: boolean;
  /** El recurso no existe (o la referencia es inválida) → 404 en enforce (igual que hoy). */
  missing: boolean;
  institutionId: string | null;
  courseId: number | null;
  runId: string | null;
  /** owner_id técnico del recurso (courses.owner_id / production_jobs.owner_id / artifacts.owner_id). */
  ownerId: string | null;
  /** 400 institution_required / 403 not_a_member en rutas de colección (antes de decidir el permiso). */
  collectionProblem?: { code: string; httpStatus: 400 | 403 };
}

export function denialException(d: Extract<PermissionDecision, { allowed: false }>): Error {
  if (d.httpStatus === 404) return new NotFoundException('Not found');
  if (d.httpStatus === 400) return new BadRequestException({ code: d.code, message: 'Elige una institución.' });
  const messages: Record<string, string> = {
    [AUTHZ_ERRORS.NOT_A_MEMBER]: 'No perteneces a esta institución.',
    [AUTHZ_ERRORS.INSTITUTION_INACTIVE]: 'La institución está suspendida o archivada.',
    [AUTHZ_ERRORS.PERMISSION_DENIED]: `No tienes permiso para esta acción (${d.permission}).`,
  };
  return new ForbiddenException({ code: d.code, permission: d.permission, message: messages[d.code] ?? 'Acceso denegado.' });
}

/**
 * r75 B2 · PermissionGuard (APP_GUARD, después de AccountAccessGuard). Solo actúa en handlers con
 * `@RequirePermission`. Según `CURSIA_RBAC_MODE`:
 *   - `off` (default): no hace nada (ni lee la base). `@Access()` arma el contexto legacy (effectiveOwnerId = actor).
 *   - `shadow`: calcula la decisión RBAC y la legacy (dueño único / SA); si difieren, `rbac.shadow_deny` en la
 *     auditoría; aplica SIEMPRE la legacy (contexto legacy: los servicios filtran por el actor, como hoy).
 *   - `enforce`: aplica RBAC. Rutas sobre un curso: manda la institución del curso (D-13; header distinto → 409
 *     `institution_mismatch`); el contexto lleva `effectiveOwnerId = courses.owner_id` para que los servicios
 *     existentes (que filtran por owner) sirvan a un miembro autorizado.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger('PermissionGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtGuard: SupabaseJwtGuard,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const requirement = this.reflector.get<PermissionRequirement | undefined>(AUTHZ_REQUIRE_PERMISSION_KEY, context.getHandler());
    if (!requirement) return true;
    const mode = rbacMode(process.env, (m) => this.logger.warn(m));
    if (mode === 'off') return true;
    const req = context.switchToHttp().getRequest();
    if (!req.user) await this.jwtGuard.canActivate(context);
    const user = req.user as { id: string; email?: string };
    const actor: Actor = { id: user.id, email: user.email ?? null };
    const route = `${req.method} ${normalizePath(req.route?.path ?? req.originalUrl ?? req.url)}`;
    const { ctx, decision, legacyAllowed, problem } = await this.evaluate(actor, requirement, req, mode);

    if (mode === 'shadow') {
      if (legacyAllowed !== decision.allowed || problem) {
        await this.permissions.recordShadowDeny(actor, { route, permission: requirement.permission, institutionId: ctx.institutionId, legacyAllowed, rbac: decision });
      }
      req[REQUEST_ACCESS_KEY] = { ...ctx, legacy: true, mode, effectiveOwnerId: actor.id, institutionId: null, courseId: null, runId: null };
      return true;
    }
    if (problem) throw problem;
    if (!decision.allowed) throw denialException(decision as Extract<PermissionDecision, { allowed: false }>);
    req[REQUEST_ACCESS_KEY] = ctx;
    return true;
  }

  /** Resolución + decisión (sin efectos). Pública para las pruebas de matriz. */
  async evaluate(actor: Actor, requirement: PermissionRequirement, req: any, mode: AuthzMode): Promise<{
    ctx: AccessContext;
    decision: PermissionDecision;
    legacyAllowed: boolean;
    problem: Error | null;
  }> {
    const superAdmin = this.permissions.isSuperAdmin(actor);
    const res = await this.resolveScope(actor, requirement.scope, req);
    const headerRaw = req?.headers?.[INSTITUTION_HEADER];
    const header = typeof headerRaw === 'string' && headerRaw.trim() ? headerRaw.trim().toLowerCase() : null;
    let problem: Error | null = null;
    let decision: PermissionDecision;
    const permission: Permission = requirement.permission;

    if (res.missing) {
      decision = { allowed: false, code: 'resource_not_found', httpStatus: 404, permission, institutionId: null, reason: 'recurso inexistente' };
    } else if (res.collectionProblem && !superAdmin) {
      decision = { allowed: false, code: res.collectionProblem.code as any, httpStatus: res.collectionProblem.httpStatus, permission, institutionId: null, reason: 'institución activa' };
    } else if (res.kind === 'artifact' && !res.institutionId && res.ownerId && res.ownerId.toLowerCase() === actor.id.toLowerCase()) {
      // 02 §E.3: un artifact SIN curso (sin institución) solo lo ve / descarga su dueño.
      decision = { allowed: true, via: 'role', permission, institutionId: null, role: null };
    } else {
      decision = await this.permissions.can(actor, permission, res.institutionId, { concreteResource: res.concrete });
      // D-13: en rutas de curso manda la institución del curso; un header distinto → 409 (evita errores de UI).
      if (decision.allowed && res.concrete && header && res.institutionId && header !== res.institutionId) {
        problem = new ConflictException({ code: AUTHZ_ERRORS.INSTITUTION_MISMATCH, message: 'Este curso pertenece a otra institución; cámbiala arriba.' });
      }
    }
    // Decisión legacy (lo que hace hoy el sistema): dueño único del recurso; colecciones abiertas; global solo SA.
    const legacyAllowed = res.missing
      ? false
      : res.kind === 'global'
        ? superAdmin
        : res.concrete
          ? superAdmin || (!!res.ownerId && res.ownerId.toLowerCase() === actor.id.toLowerCase())
          : res.kind === 'institution'
            ? superAdmin || (!!res.ownerId && res.ownerId.toLowerCase() === actor.id.toLowerCase())
            : true;
    const perms = decision.allowed ? await this.permissions.permissionsIn(actor, res.institutionId) : new Set<Permission>();
    const effectiveOwnerId = res.ownerId && (res.concrete || res.kind === 'institution') ? res.ownerId : actor.id;
    const ctx: AccessContext = {
      actorId: actor.id,
      actorEmail: String(actor.email ?? ''),
      superAdmin,
      mode,
      legacy: false,
      institutionId: res.institutionId,
      courseId: res.courseId,
      runId: res.runId,
      effectiveOwnerId,
      permissions: perms,
    };
    return { ctx, decision, legacyAllowed, problem };
  }

  async resolveScope(actor: Actor, scope: PermissionScope, req: any): Promise<ScopeResolution> {
    const q = this.permissions.query;
    const base = { institutionId: null, courseId: null, runId: null, ownerId: null } as Pick<ScopeResolution, 'institutionId' | 'courseId' | 'runId' | 'ownerId'>;
    if (!q) return { kind: 'global', concrete: false, missing: true, ...base };
    if ('course' in scope) {
      const c = await resolveCourse(q, readRef(req, scope.course));
      if (!c) return { kind: 'course', concrete: true, missing: true, ...base };
      return { kind: 'course', concrete: true, missing: false, institutionId: c.institutionId, courseId: c.courseId, runId: null, ownerId: c.ownerId };
    }
    if ('run' in scope) {
      const r = await resolveRun(q, readRef(req, scope.run));
      if (!r) return { kind: 'run', concrete: true, missing: true, ...base };
      return { kind: 'run', concrete: true, missing: false, institutionId: r.course?.institutionId ?? null, courseId: r.course?.courseId ?? null, runId: r.runId, ownerId: r.course?.ownerId ?? r.runOwnerId };
    }
    if ('artifact' in scope) {
      const a = await resolveArtifact(q, readRef(req, scope.artifact));
      if (!a) return { kind: 'artifact', concrete: true, missing: true, ...base };
      // Artifact sin curso: solo su dueño (02 §E.3). Se modela como recurso sin institución → SA, y legacy = dueño.
      return { kind: 'artifact', concrete: true, missing: false, institutionId: a.course?.institutionId ?? null, courseId: a.course?.courseId ?? null, runId: a.jobId, ownerId: a.ownerId };
    }
    if ('institution' in scope || 'brandProfile' in scope) {
      let raw: unknown;
      if ('brandProfile' in scope) {
        const bp = readRef(req, scope.brandProfile);
        if (!isUuid(bp)) return { kind: 'institution', concrete: true, missing: true, ...base };
        const [row] = await q(`select institution_id::text as institution_id from public.brand_profiles where id::text = $1`, [String(bp).toLowerCase()]);
        if (!row) return { kind: 'institution', concrete: true, missing: true, ...base };
        raw = row.institution_id;
      } else {
        raw = scope.institution === 'header' ? req?.headers?.[INSTITUTION_HEADER] : readRef(req, scope.institution);
      }
      if (!isUuid(raw)) return { kind: 'institution', concrete: false, missing: true, ...base };
      const id = String(raw).trim().toLowerCase();
      // owner_id legacy de la institución = dueño efectivo de sus recursos (brand profiles, …): los servicios existentes
      // filtran por él (institutionsService.findOne(id, ownerId)).
      const [inst] = await q(`select owner_id::text as owner_id from public.institutions where id::text = $1`, [id]);
      if (!inst) return { kind: 'institution', concrete: 'brandProfile' in scope, missing: true, ...base };
      return { kind: 'institution', concrete: 'brandProfile' in scope, missing: false, ...base, institutionId: id, ownerId: inst.owner_id ?? null };
    }
    if ('collection' in scope) {
      return { kind: 'collection', concrete: false, missing: false, ...base, ...(await this.activeInstitution(actor, req)) };
    }
    return { kind: 'global', concrete: false, missing: false, ...base };
  }

  /** Institución activa en rutas de colección (01 §3.1): header verificado → esa; sin header y 1 membresía → esa. */
  async activeInstitution(actor: Actor, req: any): Promise<{ institutionId: string | null; collectionProblem?: { code: string; httpStatus: 400 | 403 } }> {
    const raw = req?.headers?.[INSTITUTION_HEADER];
    if (typeof raw === 'string' && raw.trim()) {
      if (!isUuid(raw)) return { institutionId: null, collectionProblem: { code: AUTHZ_ERRORS.INSTITUTION_REQUIRED, httpStatus: 400 } };
      return { institutionId: raw.trim().toLowerCase() }; // la membresía se verifica en can()
    }
    const active = (await this.permissions.membershipsOf(actor.id)).filter((m) => m.status === 'active');
    if (active.length === 1) return { institutionId: active[0].institutionId };
    if (active.length === 0) return { institutionId: null, collectionProblem: { code: AUTHZ_ERRORS.NOT_A_MEMBER, httpStatus: 403 } };
    return { institutionId: null, collectionProblem: { code: AUTHZ_ERRORS.INSTITUTION_REQUIRED, httpStatus: 400 } };
  }
}
