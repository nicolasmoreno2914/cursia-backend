import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { DynamicFeatures, resolveDynamicFeatures, toHttpConfigError } from './dynamic-features';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { isBudgetFitEnabled } from '../course-design/budget-fit';
import { AllowInactiveAccount } from '../authz/public.decorator';
import { AuthenticatedOnly } from '../authz/require-permission.decorator';

/**
 * EV6 DoD BE-B: además de los flags por usuario, el contrato que el frontend necesita conocer:
 * - `dodContract: true` — este backend crea los runs con video REAL por defecto y devuelve
 *   `RunDto.completion` (el frontend no adivina el estado del curso);
 * - `superAdmin` — si ESTE usuario es SUPER_ADMIN, con el MISMO chequeo que aplica el servidor
 *   (`isSuperAdminEmail`, SUPER_ADMIN_EMAILS). Nunca se expone la lista de admins.
 */
export type FeaturesResponse = DynamicFeatures & { dodContract: true; superAdmin: boolean; budgetFit?: true };

@AuthenticatedOnly('flags del propio usuario')
@Controller('features')
@UseGuards(SupabaseJwtGuard)
export class FeaturesController {
  // GET /api/v1/features → { dynamicCourseStructure, realVideo, coherenceLlm, dodContract, superAdmin }
  // para el usuario autenticado. Nunca gateado por el flag (con el flag OFF
  // responde todo false). Lista de owners inválida con el flag ON → 500 ruidoso.
  @Get()
  @AllowInactiveAccount() // r75: el FE lo lee al cargar, también con la cuenta sin acceso
  get(@CurrentUser() user: AuthUser): FeaturesResponse {
    try {
      const f = resolveDynamicFeatures(user.id);
      // r79: «Ajustar al presupuesto» (DYNAMIC_BUDGET_FIT === 'true', solo con V2 habilitada para el usuario).
      return { ...f, dodContract: true, superAdmin: isSuperAdminEmail(user.email), ...(f.dynamicCourseStructure && isBudgetFitEnabled() ? { budgetFit: true as const } : {}) };
    } catch (err) {
      toHttpConfigError(err);
    }
  }
}
