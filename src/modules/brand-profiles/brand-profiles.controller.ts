import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { BrandProfilesService } from './brand-profiles.service';
import { CreateBrandProfileDto } from './dto/create-brand-profile.dto';
import { ConfirmBrandProfileDto } from './dto/confirm-brand-profile.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

@Controller()
@UseGuards(SupabaseJwtGuard)
export class BrandProfilesController {
  constructor(private readonly brandProfilesService: BrandProfilesService) {}

  /**
   * POST /api/v1/institutions/:institutionId/brand-profiles
   * Fase 1: carga manual de colores/logo. Queda active de inmediato.
   */
  @Post('institutions/:institutionId/brand-profiles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.edit', { institution: 'param:institutionId' })
  async createManual(
    @Param('institutionId', new ParseUUIDPipe()) institutionId: string,
    @Body() dto: CreateBrandProfileDto,
    @CurrentUser() user: AuthUser, @Access() access: AccessContext,
  ) {
    const profile = await this.brandProfilesService.createManual(
      institutionId,
      access.effectiveOwnerId,
      dto,
    );
    return { ok: true, data: profile };
  }

  /**
   * POST /api/v1/institutions/:institutionId/brand-profiles/upload
   * Fase 2: el PDF ya fue subido a Storage y registrado como artifact;
   * aquí se crea el perfil draft y se encola la extracción por IA.
   */
  @Post('institutions/:institutionId/brand-profiles/upload')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.edit', { institution: 'param:institutionId' })
  async upload(
    @Param('institutionId', new ParseUUIDPipe()) institutionId: string,
    @Body() body: { sourceArtifactId: string; name?: string },
    @CurrentUser() user: AuthUser, @Access() access: AccessContext,
  ) {
    const result = await this.brandProfilesService.startExtraction(
      institutionId,
      access.effectiveOwnerId,
      body,
    );
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/institutions/:institutionId/brand-profiles/active
   * Paleta activa en forma PALETTES[] para el theme-picker del frontend.
   */
  @Get('institutions/:institutionId/brand-profiles/active')
  @RequirePermission('courses.view', { institution: 'param:institutionId' })
  async findActive(
    @Param('institutionId', new ParseUUIDPipe()) institutionId: string,
    @CurrentUser() user: AuthUser, @Access() access: AccessContext,
  ) {
    const profile = await this.brandProfilesService.findActive(
      institutionId,
      access.effectiveOwnerId,
    );
    return { ok: true, data: profile };
  }

  /**
   * GET /api/v1/institutions/:institutionId/brand-profiles
   * Historial de versiones.
   */
  @Get('institutions/:institutionId/brand-profiles')
  @RequirePermission('courses.view', { institution: 'param:institutionId' })
  async findAllVersions(
    @Param('institutionId', new ParseUUIDPipe()) institutionId: string,
    @CurrentUser() user: AuthUser, @Access() access: AccessContext,
  ) {
    const profiles = await this.brandProfilesService.findAllVersions(
      institutionId,
      access.effectiveOwnerId,
    );
    return { ok: true, data: profiles };
  }

  @Get('brand-profiles/:id')
  @RequirePermission('courses.view', { brandProfile: 'param:id' })
  async findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const profile = await this.brandProfilesService.findOne(id, access.effectiveOwnerId);
    return { ok: true, data: profile };
  }

  /** POST /api/v1/brand-profiles/:id/confirm — confirmación humana (Fase 2). */
  @Post('brand-profiles/:id/confirm')
  @RequirePermission('courses.edit', { brandProfile: 'param:id' })
  async confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmBrandProfileDto,
    @CurrentUser() user: AuthUser, @Access() access: AccessContext,
  ) {
    const profile = await this.brandProfilesService.confirm(id, access.effectiveOwnerId, dto, access.actorId);
    return { ok: true, data: profile };
  }

  @Post('brand-profiles/:id/reject')
  @RequirePermission('courses.edit', { brandProfile: 'param:id' })
  async reject(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const profile = await this.brandProfilesService.reject(id, access.effectiveOwnerId);
    return { ok: true, data: profile };
  }
}
