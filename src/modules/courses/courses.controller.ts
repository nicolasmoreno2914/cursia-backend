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
} from '@nestjs/common';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('courses')
@UseGuards(SupabaseJwtGuard)   // todos los endpoints requieren JWT
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  // POST /api/v1/courses
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateCourseDto,
    @CurrentUser() user: AuthUser,
  ) {
    // owner_id y owner_email vienen del JWT — el body no puede sobreescribirlos
    return this.coursesService.create(dto, user.id, user.email);
  }

  // GET /api/v1/courses
  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.coursesService.findAll(user.id);
  }

  // GET /api/v1/courses/:id
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.coursesService.findOne(id, user.id);
  }

  // GET /api/v1/courses/:id/cost
  // Costo real+estimado del curso (misma fuente que el panel Admin).
  @Get(':id/cost')
  getCost(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.coursesService.getCourseCost(id, user.id);
  }

  // PATCH /api/v1/courses/:id
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCourseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.coursesService.update(id, dto, user.id);
  }

  // DELETE /api/v1/courses/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.coursesService.remove(id, user.id);
  }
}
