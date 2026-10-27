import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthUser } from '../../auth/auth.types';
import { CostReadService, ScopedGroupRow } from '../finops/cost-read.service';
import { finopsErrorToHttp } from '../finops/finops.controller';
import { BudgetAccessService } from './budget-access.service';
import { emailsOf } from './budget-admin.service';
import { UUID_RE, currentMonth, dec, monthRange } from './budget-common';
import { RequirePermission, SuperAdminOnly } from '../authz/require-permission.decorator';

const MAX_RANGE_MS = 400 * 24 * 3600 * 1000;

/** ?from&to (ISO-8601) → [from, to). Default: el mes actual (UTC). */
export function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  if (!from && !to) return monthRange(currentMonth());
  const f = from ? new Date(from) : null;
  const t = to ? new Date(to) : null;
  if (!f || !t || !Number.isFinite(f.getTime()) || !Number.isFinite(t.getTime())) {
    throw new BadRequestException({ code: 'invalid_input', message: 'from y to: fechas ISO-8601 (ambas)' });
  }
  if (f.getTime() >= t.getTime()) throw new BadRequestException({ code: 'invalid_input', message: 'from debe ser anterior a to' });
  if (t.getTime() - f.getTime() > MAX_RANGE_MS) throw new BadRequestException({ code: 'invalid_input', message: 'el rango máximo es de 400 días' });
  return { from: f, to: t };
}

const money = (r: { actual: string; reserved: string; committed: string }) => ({ actualUsd: dec(r.actual), reservedUsd: dec(r.reserved), committedUsd: dec(r.committed) });

/**
 * r75 (Agente C, regla 8) — gasto por institución. Un ADMIN_INSTITUCIONAL (P(spend.view)) ve SOLO lo atribuido a SU
 * institución (01 §6); lo que no se puede atribuir queda en «sin institución», visible solo para el SuperAdmin. Sin
 * detalle por item para quien no es SA (D-24). Lee el ledger por CostReadService (fuente única de dinero).
 * No depende de CURSIA_USER_BUDGETS (es lectura del ledger); sin PermissionService de B solo el SA la usa.
 */
@Controller()
@UseGuards(SupabaseJwtGuard)
export class InstitutionSpendController {
  constructor(
    private readonly costRead: CostReadService,
    private readonly access: BudgetAccessService,
    private readonly dataSource: DataSource,
  ) {}

  // GET /api/v1/institutions/:id/spend?from=&to=&groupBy=user|course|provider
  @Get('institutions/:id/spend')
  @RequirePermission('spend.view', { institution: 'param:id' })
  async institutionSpend(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('groupBy') groupBy?: string) {
    if (!UUID_RE.test(String(id))) throw new BadRequestException({ code: 'invalid_input', message: 'id de institución debe ser UUID' });
    if (groupBy !== undefined && !['user', 'course', 'provider'].includes(groupBy)) throw new BadRequestException({ code: 'invalid_input', message: 'groupBy: user | course | provider' });
    const actor = this.access.actorOf(user);
    const institutionId = id.toLowerCase();
    if (!(await this.access.canViewInstitutionSpend(actor, institutionId))) {
      throw new ForbiddenException({ code: 'permission_denied', permission: 'spend.view', message: 'No tienes permiso para esta acción (spend.view).' });
    }
    const range = parseRange(from, to);
    try {
      const s = await this.costRead.institutionPeriodSummary(institutionId, range.from, range.to);
      const out: Record<string, unknown> = {
        institutionId, from: range.from.toISOString(), to: range.to.toISOString(), status: s.status,
        actualUsd: dec(s.actual), reservedUsd: dec(s.reserved), committedUsd: dec(s.committed),
      };
      if (!groupBy || groupBy === 'user') {
        const emails = await emailsOf(this.dataSource, s.byUser.map((r) => String(r.key ?? '')));
        out.byUser = s.byUser.map((r) => ({ userId: r.key, email: r.key ? emails.get(r.key) ?? null : null, actualUsd: dec(r.actual), committedUsd: dec(r.committed) }));
      }
      if (!groupBy || groupBy === 'course') {
        const titles = await this.courseTitles(s.byCourse);
        out.byCourse = s.byCourse.map((r) => ({ courseId: r.key === null ? null : Number(r.key), title: r.key ? titles.get(r.key) ?? null : null, actualUsd: dec(r.actual), committedUsd: dec(r.committed) }));
      }
      if (!groupBy || groupBy === 'provider') out.byProvider = s.byProvider.map((r) => ({ provider: r.key, actualUsd: dec(r.actual) }));
      return out;
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  private async courseTitles(rows: ScopedGroupRow[]): Promise<Map<string, string>> {
    const ids = rows.map((r) => Number(r.key)).filter((n) => Number.isInteger(n) && n > 0);
    const out = new Map<string, string>();
    if (!ids.length) return out;
    for (const r of await this.dataSource.query(`select id::text as id, title from public.courses where id = any($1::int[])`, [ids])) out.set(String(r.id), r.title);
    return out;
  }
}

/** r75 (Agente C) — gasto global por institución o por usuario (solo SuperAdmin). */
@SuperAdminOnly() // r75: gasto global = solo SuperAdmin
@Controller('admin')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminSpendController {
  constructor(private readonly costRead: CostReadService, private readonly dataSource: DataSource) {}

  // GET /api/v1/admin/spend?from=&to=&groupBy=institution|user
  @Get('spend')
  async spend(@Query('from') from?: string, @Query('to') to?: string, @Query('groupBy') groupBy?: string) {
    const g = groupBy ?? 'institution';
    if (!['institution', 'user'].includes(g)) throw new BadRequestException({ code: 'invalid_input', message: 'groupBy: institution | user' });
    const range = parseRange(from, to);
    try {
      const rows = (g === 'institution' ? await this.costRead.spendByInstitution(range.from, range.to) : await this.costRead.spendByPayer(range.from, range.to)) ?? [];
      const labels = g === 'institution' ? await this.institutionNames(rows) : await emailsOf(this.dataSource, rows.map((r) => String(r.key ?? '')));
      const unattributed = rows.find((r) => r.key === null);
      return {
        groupBy: g, from: range.from.toISOString(), to: range.to.toISOString(),
        rows: rows.filter((r) => r.key !== null).map((r) => ({ key: r.key, label: labels.get(String(r.key)) ?? null, ...money(r) })),
        unattributedUsd: unattributed ? dec(unattributed.committed) : dec(0),
      };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  private async institutionNames(rows: ScopedGroupRow[]): Promise<Map<string, string>> {
    const ids = rows.map((r) => String(r.key ?? '')).filter((k) => UUID_RE.test(k));
    const out = new Map<string, string>();
    if (!ids.length) return out;
    for (const r of await this.dataSource.query(`select id::text as id, name from public.institutions where id::text = any($1::text[])`, [ids])) out.set(String(r.id), r.name);
    return out;
  }
}
