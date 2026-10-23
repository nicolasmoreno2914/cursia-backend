import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { DynamicYoutubePreflightService } from './dynamic-youtube';
import type { YoutubePreflightResult } from './dynamic-video-delivery';

/**
 * DN-1 — preflight de YouTube del flujo V2 (paso "YouTube" de la UI, solo si
 * el curso tiene videos). Ruta V2: con DYNAMIC_COURSE_STRUCTURE apagado es un
 * 404 (DynamicFeatureGuard, controller listado en dynamic-routes.ts).
 *
 * GET /api/v1/dynamic/youtube/preflight →
 *   `{ ok, channel: {id,title,thumbnail} | null, checks: [{key, ok}], reason? }`
 * (dentro del `{data}` del ResponseInterceptor). Solo lecturas: nunca tokens
 * ni errores crudos de Google, nunca escribe.
 */
@Controller('dynamic/youtube')
@UseGuards(SupabaseJwtGuard)
export class DynamicYoutubeController {
  constructor(private readonly preflight: DynamicYoutubePreflightService) {}

  @Get('preflight')
  async getPreflight(@CurrentUser() user: AuthUser): Promise<YoutubePreflightResult> {
    // G3: flag V2 + allow-list por owner (403 antes de tocar la DB o Google).
    assertDynamicOwnerAllowed(user.id);
    return this.preflight.check(user.id);
  }
}
