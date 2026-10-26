import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PackagingService } from './packaging.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';
import { MEMBER_SIGNED_URL_DEFAULT_S } from '../authz/artifact-access.service';
import type { PackageActor } from './packaging.service';

/** r75: actor del JWT + vida corta de la URL firmada si descarga alguien que no es el dueño técnico (D-15). */
function packageActor(user: AuthUser, access: AccessContext): PackageActor {
  const nonOwner = !access.legacy && access.actorId.toLowerCase() !== access.effectiveOwnerId.toLowerCase();
  return { id: user.id, email: user.email, ...(nonOwner ? { signedUrlTtlSeconds: MEMBER_SIGNED_URL_DEFAULT_S } : {}) };
}

/**
 * Empaquetado Moodle dinámico de un run 5A (Fase 5B.1, bloque B3).
 * Ownership + `dynamic` + existencia del Manifest vía
 * GenerationManifestsService.get (curso ajeno/inexistente o Manifest no
 * creado -> 404, curso legacy -> 400), igual que RunsController.
 *
 * r75 (02 §E.3): pedir y descargar el paquete exige exports.download en la institución del curso. El servicio filtra
 * por el dueño técnico (`access.effectiveOwnerId`) y firma la URL con el dueño real del artifact.
 */
@Controller('courses/:courseId/blueprints/:number/manifest/runs/:runId/package')
@UseGuards(SupabaseJwtGuard)
export class PackagingController {
  constructor(private readonly packaging: PackagingService) {}

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/package
  // 202 con {jobId, status, packageKind, deliverable}: get-or-create del job dynamic_package. 409 con
  // {missing:[]} si el run no está 31/31 completed. EV6 DoD: run de vista previa → 409
  // preview_not_deliverable salvo SUPER_ADMIN + DYNAMIC_ALLOW_VIDEO_PREVIEW=true (paquete QA).
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('exports.download', { course: 'param:courseId' })
  request(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.packaging.requestPackage(courseId, access.effectiveOwnerId, number, runId, packageActor(user, access));
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/package
  // {status, artifactId?, downloadUrl?, error?}
  @Get()
  @RequirePermission('exports.download', { course: 'param:courseId' })
  status(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.packaging.getPackageStatus(courseId, access.effectiveOwnerId, number, runId, packageActor(user, access));
  }
}
