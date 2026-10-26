import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CourseVersionsService } from './course-versions.service';
import { CreateCourseVersionDto } from './dto/create-course-version.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

@Controller('courses/:courseId/versions')
@UseGuards(SupabaseJwtGuard)   // todos los endpoints requieren JWT
export class CourseVersionsController {
  constructor(private readonly versionsService: CourseVersionsService) {}

  // POST /api/v1/courses/:courseId/versions
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateCourseVersionDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.versionsService.create(courseId, dto, access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:courseId/versions
  @Get()
  @RequirePermission('courses.view', { course: 'param:courseId' })
  findAll(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.versionsService.findAllForCourse(courseId, access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:courseId/versions/:id
  @Get(':id')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  findOne(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.versionsService.findOne(courseId, id, access.effectiveOwnerId);
  }
}
