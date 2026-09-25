import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { DynamicFeatures, resolveDynamicFeatures, toHttpConfigError } from './dynamic-features';

@Controller('features')
@UseGuards(SupabaseJwtGuard)
export class FeaturesController {
  // GET /api/v1/features → { dynamicCourseStructure, realVideo } para el
  // usuario autenticado. Nunca gateado por el flag (con el flag OFF responde
  // false/false). Lista de owners inválida con el flag ON → 500 ruidoso.
  @Get()
  get(@CurrentUser() user: AuthUser): DynamicFeatures {
    try {
      return resolveDynamicFeatures(user.id);
    } catch (err) {
      toHttpConfigError(err);
    }
  }
}
