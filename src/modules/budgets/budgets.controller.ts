import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthUser } from '../../auth/auth.types';
import { finopsErrorToHttp } from '../finops/finops.controller';
import { BudgetAccessService } from './budget-access.service';
import { BudgetAdminService } from './budget-admin.service';
import { BudgetReadService } from './budget-read.service';
import { BudgetRequestsService } from './budget-requests.service';
import { BudgetReservationService } from './budget-reservation.service';
import { assertBudgetsEnabled, assertOnlyKeys, assertUuid, parseMonth } from './budget-common';

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  assertBudgetsEnabled();
  try {
    return await fn();
  } catch (err) {
    throw finopsErrorToHttp(err);
  }
}

/**
 * r75 (Agente C) — rutas del usuario (02 §D). Solo JWT (+ AccountAccessGuard global de B cuando se integre). Ninguna
 * modifica un presupuesto: el usuario solo LEE el suyo y PIDE autorización (una solicitud pendiente, sin dinero).
 */
@Controller()
@UseGuards(SupabaseJwtGuard)
export class BudgetsController {
  constructor(
    private readonly read: BudgetReadService,
    private readonly requests: BudgetRequestsService,
    private readonly access: BudgetAccessService,
  ) {}

  // GET /api/v1/me/budget?month=YYYY-MM — siempre el propio (sin spend.view).
  @Get('me/budget')
  myBudget(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    return guarded(async () => {
      const actor = this.access.actorOf(user);
      const m = parseMonth(month);
      return { ...(await this.read.summary(actor.id, m)), reservations: await this.read.reservations({ userId: actor.id, month: m }) };
    });
  }

  // GET /api/v1/me/budget-requests?status=
  @Get('me/budget-requests')
  myRequests(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return guarded(() => this.requests.listMine(this.access.actorOf(user), status));
  }

  // POST /api/v1/budget-requests {courseId, runId?, estimateId?, amountUsd, reason}
  @Post('budget-requests')
  @HttpCode(HttpStatus.CREATED)
  createRequest(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return guarded(() => this.requests.create(this.access.actorOf(user), body));
  }

  // POST /api/v1/budget-requests/:id/cancel — solo el solicitante.
  @Post('budget-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return guarded(() => this.requests.cancel(this.access.actorOf(user), id));
  }
}

/** r75 (Agente C) — rutas del SuperAdmin (02 §D). Mismo guard que /finops/* y /admin/dashboard. */
@Controller('admin')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class BudgetsAdminController {
  constructor(
    private readonly read: BudgetReadService,
    private readonly admin: BudgetAdminService,
    private readonly requests: BudgetRequestsService,
    private readonly reservations: BudgetReservationService,
    private readonly access: BudgetAccessService,
  ) {}

  // GET /api/v1/admin/budgets?month=&q=&page=
  @Get('budgets')
  list(@Query('month') month?: string, @Query('q') q?: string, @Query('page') page?: string) {
    return guarded(() => this.admin.list({ month, q, page }));
  }

  // GET /api/v1/admin/users/:userId/budget?month=
  @Get('users/:userId/budget')
  userBudget(@Param('userId') userId: string, @Query('month') month?: string) {
    return guarded(() => this.admin.detail(userId, parseMonth(month)));
  }

  // PUT /api/v1/admin/users/:userId/budget {monthlyAmountUsd, effectiveMonth, reason} → versión recurring nueva
  @Put('users/:userId/budget')
  setBudget(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() body: Record<string, unknown>) {
    return guarded(() => this.admin.setRecurring(this.access.actorOf(user), userId, body));
  }

  // POST /api/v1/admin/users/:userId/budget-adjustments {month, amountUsd (±), reason}
  @Post('users/:userId/budget-adjustments')
  @HttpCode(HttpStatus.CREATED)
  adjust(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() body: Record<string, unknown>) {
    return guarded(() => this.admin.adjust(this.access.actorOf(user), userId, body));
  }

  // GET /api/v1/admin/budget-reservations?userId=&status=&month=
  @Get('budget-reservations')
  listReservations(@Query('userId') userId?: string, @Query('status') status?: string, @Query('month') month?: string) {
    return guarded(async () => {
      if (status !== undefined && !['active', 'released', 'settled'].includes(status)) {
        throw new BadRequestException({ code: 'invalid_input', message: 'status: active | released | settled' });
      }
      return this.read.reservations({
        userId: userId ? assertUuid(userId, 'userId') : undefined, status, month: month ? parseMonth(month) : undefined, limit: 500,
      });
    });
  }

  // GET /api/v1/admin/budget-requests?status=pending&institutionId=
  @Get('budget-requests')
  listRequests(@Query('status') status?: string, @Query('institutionId') institutionId?: string) {
    return guarded(() => this.requests.adminList({ status, institutionId }));
  }

  // POST /api/v1/admin/budget-requests/:id/approve {approvedAmountUsd, note?, extendRunAuthorization?}
  @Post('budget-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return guarded(() => this.requests.approve(this.access.actorOf(user), id, body));
  }

  // POST /api/v1/admin/budget-requests/:id/reject {note}
  @Post('budget-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return guarded(() => this.requests.reject(this.access.actorOf(user), id, body));
  }

  // POST /api/v1/admin/budgets/reconcile {month}
  @Post('budgets/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return guarded(async () => {
      const b = assertOnlyKeys(body, ['month']);
      const actor = this.access.actorOf(user);
      return this.reservations.reconcile(parseMonth(b.month), { id: actor.id, email: actor.email });
    });
  }
}
