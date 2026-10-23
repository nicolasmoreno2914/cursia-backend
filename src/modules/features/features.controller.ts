import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { DynamicFeatures, resolveDynamicFeatures, toHttpConfigError } from './dynamic-features';
import { isSuperAdminEmail } from '../../auth/super-admin';

/**
 * EV6 DoD BE-B: además de los flags por usuario, el contrato que el frontend necesita conocer:
 * - `dodContract: true` — este backend crea los runs con video REAL por defecto y devuelve
 *   `RunDto.completion` (el frontend no adivina el estado del curso);
 * - `superAdmin` — si ESTE usuario es SUPER_ADMIN, con el MISMO chequeo que aplica el servidor
 *   (`isSuperAdminEmail`, SUPER_ADMIN_EMAILS). Nunca se expone la lista de admins.
 */
export type FeaturesResponse = DynamicFeatures & { dodContract: true; superAdmin: boolean };

@Controller('features')
@UseGuards(SupabaseJwtGuard)
export class FeaturesController {
  // GET /api/v1/features → { dynamicCourseStructure, realVideo, coherenceLlm, dodContract, superAdmin }
  // para el usuario autenticado. Nunca gateado por el flag (con el flag OFF
  // responde todo false). Lista de owners inválida con el flag ON → 500 ruidoso.
  @Get()
  get(@CurrentUser() user: AuthUser): FeaturesResponse {
    try {
      return { ...resolveDynamicFeatures(user.id), dodContract: true, superAdmin: isSuperAdminEmail(user.email) };
    } catch (err) {
      toHttpConfigError(err);
    }
  }
}
