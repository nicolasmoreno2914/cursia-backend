import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PackagingService } from './packaging.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * Empaquetado Moodle dinámico de un run 5A (Fase 5B.1, bloque B3).
 * Ownership + `dynamic` + existencia del Manifest vía
 * GenerationManifestsService.get (curso ajeno/inexistente o Manifest no
 * creado -> 404, curso legacy -> 400), igual que RunsController.
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
  request(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.packaging.requestPackage(courseId, user.id, number, runId, { email: user.email });
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/package
  // {status, artifactId?, downloadUrl?, error?}
  @Get()
  status(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.packaging.getPackageStatus(courseId, user.id, number, runId);
  }
}
