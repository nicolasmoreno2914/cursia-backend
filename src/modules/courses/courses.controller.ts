import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateDynamicCourseDto } from './dto/create-dynamic-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { assertDynamicCreationAllowed } from '../features/dynamic-features';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

@Controller('courses')
@UseGuards(SupabaseJwtGuard)   // todos los endpoints requieren JWT
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  // POST /api/v1/courses/dynamic
  @Post('dynamic')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.create', { collection: true })
  async createOrGetDynamic(
    @Body() dto: CreateDynamicCourseDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    // Aditivo: el curso de siempre + `created` (true solo si esta llamada lo creó).
    // r75 (D-29): owner_id = el creador; institución activa y created_by solo con RBAC en enforce.
    const { course, created } = await this.coursesService.findOrCreateDynamicWithStatus(
      user.id,
      user.email,
      dto.frontendCourseId,
      dto.title,
      { actorId: access.actorId, institutionId: access.legacy ? null : access.institutionId },
    );
    return { ...course, created };
  }

  // POST /api/v1/courses
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.create', { collection: true })
  create(
    @Body() dto: CreateCourseDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Access() access: AccessContext,
  ) {
    // Release-fix I4: crear un curso dynamic por esta ruta legacy exige lo
    // mismo que POST /courses/dynamic (flag → 404 como ruta V2; allow-list → 403).
    if (dto?.structureVersion === 'dynamic') {
      assertDynamicCreationAllowed(user.id, `Cannot ${req.method} ${req.originalUrl ?? req.url}`);
    }
    // owner_id y owner_email vienen del JWT — el body no puede sobreescribirlos
    return this.coursesService.create(dto, user.id, user.email, { actorId: access.actorId, institutionId: access.legacy ? null : access.institutionId });
  }

  // GET /api/v1/courses
  // r75 (02 §E.3): con RBAC en enforce, los cursos de la institución activa; si no, los del usuario (como hoy).
  @Get()
  @RequirePermission('courses.view', { collection: true })
  findAll(@Access() access: AccessContext) {
    if (!access.legacy && access.institutionId) return this.coursesService.findAllForInstitution(access.institutionId);
    return this.coursesService.findAll(access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:id
  @Get(':id')
  @RequirePermission('courses.view', { course: 'param:id' })
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Access() access: AccessContext,
  ) {
    return this.coursesService.findOne(id, access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:id/cost
  // FinOps P0: costo del curso desde el ledger V2 (misma fuente que el panel Admin; ver CostReadService).
  @Get(':id/cost')
  @RequirePermission('spend.view', { course: 'param:id' })
  getCost(
    @Param('id', ParseIntPipe) id: number,
    @Access() access: AccessContext,
  ) {
    return this.coursesService.getCourseCost(id, access.effectiveOwnerId);
  }

  // PATCH /api/v1/courses/:id
  @Patch(':id')
  @RequirePermission('courses.edit', { course: 'param:id' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCourseDto,
    @Access() access: AccessContext,
  ) {
    return this.coursesService.update(id, dto, access.effectiveOwnerId, access.actorId);
  }

  // DELETE /api/v1/courses/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('courses.delete', { course: 'param:id' })
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Access() access: AccessContext,
  ) {
    return this.coursesService.remove(id, access.effectiveOwnerId);
  }
}
