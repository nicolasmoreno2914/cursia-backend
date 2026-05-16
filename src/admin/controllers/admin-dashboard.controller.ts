/* ══════════════════════════════════════════════════════════════
   admin-dashboard.controller.ts — GET /api/v1/admin/dashboard/summary
   ══════════════════════════════════════════════════════════════

   Requiere: SupabaseJwtGuard + SuperAdminGuard.
   Acepta query params: from, to (ISO 8601).
   Sin params → últimos 30 días.
   ══════════════════════════════════════════════════════════════ */

import {
  Controller,
  Get,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { AdminDashboardService } from '../services/admin-dashboard.service';

@Controller('admin/dashboard')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminDashboardController {
  constructor(private readonly dashboardService: AdminDashboardService) {}

  /**
   * GET /api/v1/admin/dashboard/summary?from=2025-01-01&to=2025-01-31
   *
   * Devuelve métricas agregadas para el período solicitado.
   */
  @Get('summary')
  @HttpCode(HttpStatus.OK)
  async getSummary(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ) {
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(now.getDate() - 30);

    const from = fromStr ? new Date(fromStr) : defaultFrom;
    const to   = toStr   ? new Date(toStr)   : now;

    return this.dashboardService.getSummary(from, to);
  }
}
