import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { ClaimResult, DEFAULT_LEASE_SECONDS, ItemOpResult, SchedulerService } from './scheduler.service';
import { ClaimItemDto, CompleteItemDto, FailItemDto, HeartbeatItemDto, ReleaseRunLeaseDto } from './dto/executor.dto';

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
  // REL lease de ejecución: si otro ejecutor del navegador tiene el lease vigente del run →
  // { item: null, reason: 'run_leased_elsewhere', leaseExpiresAt } (200, nunca un error: el acceso al
  // curso y al run no depende de esto; el ejecutor solo espera a que venza).
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  // Motor pedagógico Fase 2: `?features=pedagogy-brief-1` = el ejecutor aplica el brief pedagógico del claim.
  // Va por query (no en el body ni en un header): el body es whitelist estricta y CORS solo admite
  // Content-Type/Authorization, así un frontend nuevo contra un backend anterior sigue funcionando.
  async claim(@Body() dto: ClaimItemDto, @CurrentUser() user: AuthUser, @Query('features') features?: string): Promise<ClaimResult> {
    return this.scheduler.claimNextItemDetailed({
      runId: dto.runId,
      executorId: dto.executorId,
      types: dto.types,
      leaseSeconds: dto.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      ownerId: user.id,
      executorFeatures: typeof features === 'string' ? features.split(',').map((f) => f.trim()).filter(Boolean).slice(0, 10) : [],
    });
  }

  // POST /api/v1/dynamic-generation/runs/:runId/release-lease → { ok: true, released }
  // REL lease: el titular suelta el lease de ejecución del run (al cerrar la página, best-effort).
  @Post('runs/:runId/release-lease')
  @HttpCode(HttpStatus.OK)
  releaseLease(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: ReleaseRunLeaseDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true; released: boolean }> {
    return this.scheduler.releaseRunExecutionLease(runId, dto.executorId, user.id);
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
    // id = borrador nuevo; null explícito = borrar el anterior (R4); ausente = conservar.
    const opts: { examBankDraftArtifactId?: string | null; errorCode?: string } = {};
    if (dto.examBankDraftArtifactId !== undefined) opts.examBankDraftArtifactId = dto.examBankDraftArtifactId;
    // REL R1: código explícito opcional (solo clasificación).
    if (dto.errorCode !== undefined) opts.errorCode = dto.errorCode;
    return this.scheduler.failItemDetailed(
      id, dto.executorId, dto.error, dto.retryable, user.id, Object.keys(opts).length ? opts : undefined,
    );
  }
}
