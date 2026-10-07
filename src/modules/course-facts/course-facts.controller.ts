import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseFactsService } from './course-facts.service';
import { PutBriefDto } from './dto/put-brief.dto';

/** LOOP 8.1 · Fuente única del curso (controller V2: listado en features/dynamic-routes.ts). */
@Controller('courses/:courseId')
@UseGuards(SupabaseJwtGuard)
export class CourseFactsController {
  constructor(private readonly service: CourseFactsService) {}

  // GET /api/v1/courses/:courseId/brief → lo que el usuario dijo del curso (o null)
  @Get('brief')
  getBrief(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.getBrief(courseId, user.id);
  }

  // PUT /api/v1/courses/:courseId/brief → reemplaza el pedido (campos de la pantalla Datos)
  @Put('brief')
  putBrief(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: PutBriefDto, @CurrentUser() user: AuthUser) {
    return this.service.putBrief(courseId, user.id, dto);
  }

  // GET /api/v1/courses/:courseId/facts → «Lo que sabemos del curso»: cada dato con su valor, su origen y los conflictos
  @Get('facts')
  getFacts(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.getFacts(courseId, user.id);
  }
}
