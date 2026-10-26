import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CourseMediaService } from './course-media.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';

/**
 * r74 — dirección DURADERA de un medio del curso (pública, de capacidad): 302 a una URL firmada nueva. Sin JWT a
 * propósito: la pide el reproductor de audio del Moodle del cliente (otro dominio, sin sesión de Cursia).
 */
@Controller('media')
export class CourseMediaController {
  constructor(private readonly media: CourseMediaService) {}

  // GET (y HEAD) /api/v1/media/:artifactId/:mediaKey/:filename
  @Get(':artifactId/:mediaKey/:filename')
  async get(@Param('artifactId') artifactId: string, @Param('mediaKey') mediaKey: string, @Param('filename') filename: string, @Res() res: Response) {
    return this.answer(await this.media.resolve(artifactId, mediaKey, filename), res);
  }

  private answer(r: Awaited<ReturnType<CourseMediaService['resolve']>>, res: Response) {
    // GET responde también HEAD (Express). helmet() pone Cross-Origin-Resource-Policy: same-origin, que haría que el
    // navegador bloquee el audio pedido desde el dominio del Moodle del cliente: este recurso es cross-origin a propósito.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (r.ok === true) {
      // La URL firmada vive `ttlSeconds`; el 302 se puede cachear bastante menos (nunca más que la firma).
      res.setHeader('Cache-Control', `private, max-age=${Math.min(300, Math.floor(r.ttlSeconds / 2))}`);
      return res.redirect(302, r.url);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json({ code: r.code, message: r.status === 410 ? 'Este medio fue retirado por su institución.' : 'Este medio no está disponible.' });
  }
}

/** r74 — monitoreo de direcciones de medios (SOLO LECTURA, SUPER_ADMIN). */
@Controller('admin/media-links')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class CourseMediaAdminController {
  constructor(private readonly media: CourseMediaService) {}

  @Get('health')
  health(@Query('courseId') courseId?: string, @Query('limit') limit?: string) {
    return this.media.health(courseId && courseId.trim() ? courseId.trim() : null, Number(limit) || 200);
  }
}
