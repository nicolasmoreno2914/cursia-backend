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
  BadRequestException,
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
    // FinOps P0: período [from, to) en UTC (instantes ISO 8601). Default: últimos 30 días.
    const now = new Date();
    const from = fromStr ? new Date(fromStr) : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const to   = toStr   ? new Date(toStr)   : now;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from.getTime() > to.getTime()) {
      throw new BadRequestException('from/to deben ser fechas ISO 8601 válidas y from ≤ to');
    }

    return this.dashboardService.getSummary(from, to);
  }
}
