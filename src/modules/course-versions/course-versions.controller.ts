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

@Controller('courses/:courseId/versions')
@UseGuards(SupabaseJwtGuard)   // todos los endpoints requieren JWT
export class CourseVersionsController {
  constructor(private readonly versionsService: CourseVersionsService) {}

  // POST /api/v1/courses/:courseId/versions
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateCourseVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.create(courseId, dto, user.id);
  }

  // GET /api/v1/courses/:courseId/versions
  @Get()
  findAll(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.findAllForCourse(courseId, user.id);
  }

  // GET /api/v1/courses/:courseId/versions/:id
  @Get(':id')
  findOne(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.findOne(courseId, id, user.id);
  }
}
