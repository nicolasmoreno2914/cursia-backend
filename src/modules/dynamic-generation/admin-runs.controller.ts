import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { AdminRecoveryService, NeedsAttentionListing } from './admin-recovery.service';
import { VideogenReconciliationService } from './videogen-reconciliation.service';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * EV6 DoD BE-B — cola de recuperación de admin de la generación dinámica (SOLO LECTURA).
 * SupabaseJwtGuard + SuperAdminGuard (mismo patrón que AdminDashboardController / FinopsAdminController):
 * cualquier otro usuario (dueño incluido) → 403. Las acciones se ejecutan con los endpoints EXISTENTES
 * que cada entrada indica (todos aceptan a un SUPER_ADMIN sobre el curso de cualquier dueño).
 */
@Controller('admin/dynamic-runs')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminDynamicRunsController {
  constructor(
    private readonly recovery: AdminRecoveryService,
    private readonly videogen: VideogenReconciliationService,
  ) {}

  // GET /api/v1/admin/dynamic-runs/needs-attention?limit=100
  @Get('needs-attention')
  needsAttention(@Query('limit') limit?: string): Promise<NeedsAttentionListing> {
    return this.recovery.listNeedsAttention({ limit: limit === undefined ? undefined : Number(limit) });
  }

  // V542 (G6) — GET /api/v1/admin/dynamic-runs/:runId/videogen-reservations
  // Reservas de Videogen del run sin liquidar que ningún worker va a liquidar (resultado incierto).
  @Get(':runId/videogen-reservations')
  videogenReservations(@Param('runId', ParseUUIDPipe) runId: string) {
    return this.videogen.listPending(runId);
  }

  // V542 (G6) — POST /api/v1/admin/dynamic-runs/:runId/videogen-reservations/reconcile
  // Body {reservationKey, outcome: 'not_charged' | 'charged', reason}: decisión explícita del SUPER_ADMIN
  // (append-only en el ledger, con motivo y actor). Nunca automático; repetir la misma decisión = no-op.
  @Post(':runId/videogen-reservations/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcileVideogen(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return this.videogen.reconcile(runId, b, { id: user.id, email: user.email });
  }
}
