import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { CourseSetupExtractionService } from './course-setup-extraction.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AuthenticatedOnly } from '../authz/require-permission.decorator';

@Controller('course-setup')
@UseGuards(SupabaseJwtGuard)
export class CourseSetupController {
  constructor(
    private readonly artifactsService: ArtifactsService,
    private readonly extractionService: CourseSetupExtractionService,
  ) {}

  /**
   * POST /api/v1/course-setup/extract-from-pdf
   * Prefill de un solo uso: descarga el PDF ya subido como artifact y
   * devuelve los campos extraídos directamente, sin job ni polling.
   */
  @Post('extract-from-pdf')
  @AuthenticatedOnly("extracción de un PDF propio (artifact del usuario)")
  async extractFromPdf(
    @Body() body: { artifactId: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body?.artifactId) {
      throw new BadRequestException('artifactId es requerido');
    }

    const info = await this.artifactsService.getDownloadUrl(body.artifactId, user.id, 600);
    if (!info.url) {
      throw new BadRequestException('No se pudo obtener el archivo subido');
    }

    const response = await fetch(info.url);
    if (!response.ok) {
      throw new BadRequestException('No se pudo descargar el archivo subido');
    }
    const pdfBuffer = Buffer.from(await response.arrayBuffer());

    const extracted = await this.extractionService.extractFromPdf(pdfBuffer, { ownerId: user.id });
    return { ok: true, data: extracted };
  }
}
