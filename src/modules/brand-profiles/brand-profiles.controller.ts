import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { BrandProfilesService } from './brand-profiles.service';
import { CreateBrandProfileDto } from './dto/create-brand-profile.dto';
import { ConfirmBrandProfileDto } from './dto/confirm-brand-profile.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

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
  async createManual(
    @Param('institutionId') institutionId: string,
    @Body() dto: CreateBrandProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    const profile = await this.brandProfilesService.createManual(
      institutionId,
      user.id,
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
  async upload(
    @Param('institutionId') institutionId: string,
    @Body() body: { sourceArtifactId: string; name?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.brandProfilesService.startExtraction(
      institutionId,
      user.id,
      body,
    );
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/institutions/:institutionId/brand-profiles/active
   * Paleta activa en forma PALETTES[] para el theme-picker del frontend.
   */
  @Get('institutions/:institutionId/brand-profiles/active')
  async findActive(
    @Param('institutionId') institutionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const profile = await this.brandProfilesService.findActive(
      institutionId,
      user.id,
    );
    return { ok: true, data: profile };
  }

  /**
   * GET /api/v1/institutions/:institutionId/brand-profiles
   * Historial de versiones.
   */
  @Get('institutions/:institutionId/brand-profiles')
  async findAllVersions(
    @Param('institutionId') institutionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const profiles = await this.brandProfilesService.findAllVersions(
      institutionId,
      user.id,
    );
    return { ok: true, data: profiles };
  }

  @Get('brand-profiles/:id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const profile = await this.brandProfilesService.findOne(id, user.id);
    return { ok: true, data: profile };
  }

  /** POST /api/v1/brand-profiles/:id/confirm — confirmación humana (Fase 2). */
  @Post('brand-profiles/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmBrandProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    const profile = await this.brandProfilesService.confirm(id, user.id, dto);
    return { ok: true, data: profile };
  }

  @Post('brand-profiles/:id/reject')
  async reject(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const profile = await this.brandProfilesService.reject(id, user.id);
    return { ok: true, data: profile };
  }
}
