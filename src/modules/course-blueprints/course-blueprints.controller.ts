import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CourseBlueprintsService } from './course-blueprints.service';
import { CreateBlueprintDto } from './dto/create-blueprint.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('courses/:courseId/blueprints')
@UseGuards(SupabaseJwtGuard)
export class CourseBlueprintsController {
  constructor(private readonly blueprintsService: CourseBlueprintsService) {}

  // POST /api/v1/courses/:courseId/blueprints
  // 201 si se creó un Blueprint nuevo, 200 si era idempotente (mismo hash
  // que el vigente) — el body es {created, blueprint} en ambos casos.
  @Post()
  async lock(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateBlueprintDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.blueprintsService.lock(courseId, user.id, dto.expectedCounter);
    res.status(result.created ? 201 : 200);
    return result;
  }

  // GET /api/v1/courses/:courseId/blueprints
  @Get()
  list(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.blueprintsService.list(courseId, user.id);
  }

  // GET /api/v1/courses/:courseId/blueprints/current
  // (declarado ANTES de :number para que Nest no interprete "current" como un número)
  @Get('current')
  getCurrent(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.blueprintsService.getCurrent(courseId, user.id);
  }

  // GET /api/v1/courses/:courseId/blueprints/:number
  @Get(':number')
  getByNumber(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.blueprintsService.getByNumberAnySchema(courseId, user.id, number);
  }
}
