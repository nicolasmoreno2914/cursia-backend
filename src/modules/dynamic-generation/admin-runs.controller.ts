import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { AdminRecoveryService, NeedsAttentionListing } from './admin-recovery.service';
import { VideogenReconciliationService } from './videogen-reconciliation.service';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { PilotMetricsService } from './pilot-metrics.service';
import { LlmDiagnosticsService, LlmItemDiagnostics } from './llm-diagnostics.service';
import { SuperAdminOnly } from '../authz/require-permission.decorator';

/**
 * EV6 DoD BE-B — cola de recuperación de admin de la generación dinámica (SOLO LECTURA).
 * SupabaseJwtGuard + SuperAdminGuard (mismo patrón que AdminDashboardController / FinopsAdminController):
 * cualquier otro usuario (dueño incluido) → 403. Las acciones se ejecutan con los endpoints EXISTENTES
 * que cada entrada indica (todos aceptan a un SUPER_ADMIN sobre el curso de cualquier dueño).
 */
@SuperAdminOnly()
@Controller('admin/dynamic-runs')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminDynamicRunsController {
  constructor(
    private readonly recovery: AdminRecoveryService,
    private readonly videogen: VideogenReconciliationService,
    private readonly pilotMetrics: PilotMetricsService,
    private readonly llmDiagnostics: LlmDiagnosticsService,
  ) {}

  // Loop 10 C2 — GET /api/v1/admin/dynamic-runs/:runId/pilot-metrics
  // Métricas del piloto del run (tiempos, costo, reintentos, recuperaciones, intervenciones manuales, uso del navegador,
  // calidad). SOLO LECTURA (transacción READ ONLY), sin proveedores. Campos: docs/v21/pilot-metrics.md.
  @Get(':runId/pilot-metrics')
  pilotMetricsOf(@Param('runId', ParseUUIDPipe) runId: string) {
    return this.pilotMetrics.forRun(runId);
  }

  // GET /api/v1/admin/dynamic-runs/:runId/items/:itemKey/llm-diagnostics — SOLO LECTURA (2026-10-14): payload exacto del
  // claim (transacción READ ONLY) + respuestas pagadas de sus puntos de guardado, para reproducir la parte a USD 0.
  @Get(':runId/items/:itemKey/llm-diagnostics')
  // ?hash=<sha> (uno) · ?limit=N (primeros N). `truncated` = hay más (tope de cantidad o de bytes).
  llmDiagnosticsOf(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemKey') itemKey: string,
    @Query('hash') hash?: string,
    @Query('limit') limit?: string,
  ): Promise<LlmItemDiagnostics> {
    return this.llmDiagnostics.forItem(runId, itemKey, { hash: typeof hash === 'string' && hash ? hash : null, limit: limit === undefined ? null : Number(limit) });
  }

  // GET /api/v1/admin/dynamic-runs/needs-attention?limit=100
  @Get('needs-attention')
  // V542 fix round 1 (I2): &reservationRuns=N (default 200, tope 2000) — runs con reservas de Videogen pendientes
  // de TODO el ledger; el total siempre viene en pendingReservationsTotals.
  needsAttention(@Query('limit') limit?: string, @Query('reservationRuns') reservationRuns?: string): Promise<NeedsAttentionListing> {
    return this.recovery.listNeedsAttention({ limit: limit === undefined ? undefined : Number(limit), reservationRuns: reservationRuns === undefined ? undefined : Number(reservationRuns) });
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
