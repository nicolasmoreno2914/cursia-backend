import { Controller, Get, Post, Param, ParseIntPipe, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GenerationManifestsService } from './generation-manifests.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('courses/:courseId/blueprints/:number/manifest')
@UseGuards(SupabaseJwtGuard)
export class GenerationManifestsController {
  constructor(private readonly manifestsService: GenerationManifestsService) {}

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest
  // Get-or-create idempotente, sin body: 201 si se creó, 200 si ya existía
  // — el body es {created, manifest} en ambos casos. No crea production_jobs.
  @Post()
  async getOrCreate(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.manifestsService.getOrCreate(courseId, user.id, number);
    res.status(result.created ? 201 : 200);
    return result;
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest (404 si no se creó)
  @Get()
  get(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.manifestsService.get(courseId, user.id, number);
  }
}
