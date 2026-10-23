import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { isAdminOnlyPackageArtifact } from '../dynamic-packaging/qa-package';
import { ArtifactsService } from './artifacts.service';
import { CreateArtifactDto } from './dto/create-artifact.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('artifacts')
@UseGuards(SupabaseJwtGuard)
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  /**
   * POST /api/v1/artifacts
   * Registra metadata de un artifact después de que el frontend lo sube a Storage.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateArtifactDto,
    @CurrentUser() user: AuthUser,
  ) {
    const artifact = await this.artifactsService.createFromApi(dto, user.id);
    return { ok: true, data: artifact };
  }

  /**
   * GET /api/v1/artifacts
   * Lista artifacts del usuario. Filtros opcionales: course_id, type, job_id.
   */
  @Get()
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query('course_id') courseId?: string,
    @Query('type') type?: string,
    @Query('job_id') jobId?: string,
  ) {
    const artifacts = await this.artifactsService.findAll(user.id, {
      courseId,
      type,
      jobId,
    });
    // EV6 DoD fix round 3 (N2): los .mbz QA / degradados NUEVOS no se listan a un no admin (ni su storagePath).
    const admin = isSuperAdminEmail(user.email);
    return { ok: true, data: admin ? artifacts : artifacts.filter((a) => !isAdminOnlyPackageArtifact(a)) };
  }

  /**
   * GET /api/v1/artifacts/:id
   * Metadata de un artifact.
   */
  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const artifact = await this.artifactsService.findOne(id, user.id);
    // EV6 DoD fix round 3 (N2): un .mbz QA / degradado NUEVO no existe para un no admin.
    if (isAdminOnlyPackageArtifact(artifact) && !isSuperAdminEmail(user.email)) throw new NotFoundException(`Artifact ${id} not found`);
    return { ok: true, data: artifact };
  }

  /**
   * GET /api/v1/artifacts/:id/download-url
   * Genera una signed download URL (1h TTL por defecto).
   * Si SUPABASE_SERVICE_ROLE_KEY no está configurado, retorna storage_path
   * para que el frontend genere la URL con su propio SDK.
   */
  @Get(':id/download-url')
  async getDownloadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
    @Query('expires') expires?: string,
  ) {
    const expiresIn = expires ? parseInt(expires, 10) : 3600;
    // EV6 DoD fix round 2 (M4): un .mbz de QA / degradado NUEVO (metadata.packageKind) es solo de
    // SUPER_ADMIN también por esta ruta genérica. Los .mbz anteriores (sin el campo) no cambian.
    const artifact = await this.artifactsService.findOne(id, user.id);
    if (isAdminOnlyPackageArtifact(artifact) && !isSuperAdminEmail(user.email)) {
      throw new ForbiddenException({
        code: 'admin_recovery_only',
        message: 'admin_recovery_only: este paquete es una copia interna de control de calidad (no entregable); solo un administrador de Cursia puede descargarlo.',
      });
    }
    const result = await this.artifactsService.getDownloadUrl(
      id,
      user.id,
      isNaN(expiresIn) ? 3600 : expiresIn,
    );
    return { ok: true, data: result };
  }

  /**
   * DELETE /api/v1/artifacts/:id
   * Elimina metadata y opcionalmente el archivo de Storage.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    // DoD follow-up (R4): un .mbz QA / degradado NUEVO no existe para un no admin (404, igual que GET).
    await this.artifactsService.remove(id, user.id, { allowAdminOnlyPackage: isSuperAdminEmail(user.email) });
  }
}
