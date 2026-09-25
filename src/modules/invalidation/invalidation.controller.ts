import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { InvalidationService } from './invalidation.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fase 8 (F8-BE): plan de invalidación (dry-run). Controller 100% dynamic
 * (clasificado en features/dynamic-routes.ts). El apply es
 * `POST …/manifest/runs {fromRun}` (RunsController).
 */
@Controller('courses/:courseId/blueprints/:number/manifest')
@UseGuards(SupabaseJwtGuard)
export class InvalidationController {
  constructor(private readonly invalidation: InvalidationService) {}

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/invalidation-plan?fromRun=<runA>
  // (alias `from`, como en la spec §4). Sin escrituras.
  @Get('invalidation-plan')
  plan(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Query('fromRun') fromRun: string | undefined,
    @Query('from') from: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const runId = fromRun ?? from;
    if (typeof runId !== 'string' || !UUID_RE.test(runId)) {
      throw new BadRequestException('fromRun (UUID del run de origen) es obligatorio');
    }
    return this.invalidation.getPlan(courseId, user.id, number, runId);
  }
}
