import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CourseVersionsService } from './course-versions.service';
import { CreateCourseVersionDto } from './dto/create-course-version.dto';

@Controller('courses/:courseId/versions')
export class CourseVersionsController {
  constructor(private readonly versionsService: CourseVersionsService) {}

  // POST /api/v1/courses/:courseId/versions
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateCourseVersionDto,
  ) {
    return this.versionsService.create(courseId, dto);
  }

  // GET /api/v1/courses/:courseId/versions
  @Get()
  findAll(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.versionsService.findAllForCourse(courseId);
  }

  // GET /api/v1/courses/:courseId/versions/:id
  @Get(':id')
  findOne(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.versionsService.findOne(courseId, id);
  }
}
