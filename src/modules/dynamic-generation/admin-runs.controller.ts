import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { AdminRecoveryService, NeedsAttentionListing } from './admin-recovery.service';

/**
 * EV6 DoD BE-B — cola de recuperación de admin de la generación dinámica (SOLO LECTURA).
 * SupabaseJwtGuard + SuperAdminGuard (mismo patrón que AdminDashboardController / FinopsAdminController):
 * cualquier otro usuario (dueño incluido) → 403. Las acciones se ejecutan con los endpoints EXISTENTES
 * que cada entrada indica (todos aceptan a un SUPER_ADMIN sobre el curso de cualquier dueño).
 */
@Controller('admin/dynamic-runs')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminDynamicRunsController {
  constructor(private readonly recovery: AdminRecoveryService) {}

  // GET /api/v1/admin/dynamic-runs/needs-attention?limit=100
  @Get('needs-attention')
  needsAttention(@Query('limit') limit?: string): Promise<NeedsAttentionListing> {
    return this.recovery.listNeedsAttention({ limit: limit === undefined ? undefined : Number(limit) });
  }
}
