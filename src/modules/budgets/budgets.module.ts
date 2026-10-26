import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AccessModule } from '../access/access.module';
import { R75_BUDGET_READ_SERVICE } from '../access/access.tokens';
import { FinopsModule } from '../finops/finops.module';
import { BudgetAccessService } from './budget-access.service';
import { BudgetAdminService } from './budget-admin.service';
import { BudgetReadService } from './budget-read.service';
import { BudgetRequestsService } from './budget-requests.service';
import { BudgetReservationService } from './budget-reservation.service';
import { BudgetsAdminController, BudgetsController } from './budgets.controller';
import { AdminSpendController, InstitutionSpendController } from './spend.controller';

/**
 * r75 (Agente C) — presupuestos mensuales por usuario, reservas transaccionales, solicitudes de autorización y gasto
 * por institución. Detrás de CURSIA_USER_BUDGETS (off | shadow | enforce; default off = comportamiento de hoy).
 *
 * Integración (lead, app.module.ts): importar BudgetsModule. Usa de A (AccessModule): AuditLogService (misma tx),
 * SuspensionsService.getActive y PlatformControlsService.isGenerationFrozen (en cada arranque). Puerto opcional:
 *   - R75_PERMISSION_SERVICE (access.tokens.ts) → PermissionService de B con `can(actor, perm, institutionId)` (sin él:
 *     SA; dueño del curso con CURSIA_RBAC_MODE=off; shadow/enforce sin él → 403).
 * Al iniciar, BudgetReservationService se registra como UserBudgetGate en FinopsBudgetService y FinopsLedgerService.
 * BudgetReadService se exporta para `GET /me/context` (A).
 */
@Module({
  imports: [AuthModule, FinopsModule, AccessModule],
  controllers: [BudgetsController, BudgetsAdminController, InstitutionSpendController, AdminSpendController],
  providers: [
    BudgetReadService, BudgetReservationService, BudgetAdminService, BudgetRequestsService, BudgetAccessService,
    // A (/me/context, GET /admin/users) lo resuelve con ModuleRef.get(token, {strict:false}).
    { provide: R75_BUDGET_READ_SERVICE, useExisting: BudgetReadService },
  ],
  exports: [BudgetReadService, BudgetReservationService],
})
export class BudgetsModule {}
