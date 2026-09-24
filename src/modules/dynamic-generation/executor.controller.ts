import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, ItemOpResult, SchedulerService } from './scheduler.service';
import { ClaimItemDto, CompleteItemDto, FailItemDto, HeartbeatItemDto } from './dto/executor.dto';

/**
 * Endpoints del ejecutor del navegador (Fase 5A, Task 3). Siempre con JWT:
 * ownerId = user.id → solo items de runs del usuario. Los rechazos de guard
 * (lease perdido, item no running, run cancelado, artifacts no vinculables,
 * item ajeno/inexistente) responden 200 {ok:false, reason} — el ejecutor
 * debe abortar ese item; nunca 500. El navegador no reclama `video`
 * (solo el worker del backend).
 */
@Controller('dynamic-generation')
@UseGuards(SupabaseJwtGuard)
export class ExecutorController {
  constructor(private readonly scheduler: SchedulerService) {}

  // POST /api/v1/dynamic-generation/claim → { item: ClaimedItem | null }
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(@Body() dto: ClaimItemDto, @CurrentUser() user: AuthUser): Promise<{ item: ClaimedItem | null }> {
    const item = await this.scheduler.claimNextItem({
      runId: dto.runId,
      executorId: dto.executorId,
      types: dto.types,
      leaseSeconds: dto.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      ownerId: user.id,
    });
    return { item };
  }

  // POST /api/v1/dynamic-generation/items/:id/heartbeat
  @Post('items/:id/heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HeartbeatItemDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ItemOpResult> {
    return this.scheduler.heartbeatItemDetailed(id, dto.executorId, dto.leaseSeconds ?? DEFAULT_LEASE_SECONDS, user.id);
  }

  // POST /api/v1/dynamic-generation/items/:id/complete
  @Post('items/:id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteItemDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ItemOpResult> {
    return this.scheduler.completeItemDetailed(
      id,
      dto.executorId,
      { artifactIds: dto.artifactIds, summary: dto.summary ?? {} },
      user.id,
    );
  }

  // POST /api/v1/dynamic-generation/items/:id/fail
  @Post('items/:id/fail')
  @HttpCode(HttpStatus.OK)
  fail(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailItemDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ItemOpResult> {
    return this.scheduler.failItemDetailed(id, dto.executorId, dto.error, dto.retryable, user.id);
  }
}
