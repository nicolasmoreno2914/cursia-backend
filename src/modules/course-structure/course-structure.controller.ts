import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CourseStructureService } from './course-structure.service';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { ReorderDto } from './dto/reorder.dto';
import { MoveChapterDto } from './dto/move-chapter.dto';
import { ExpectedCounterDto } from './dto/expected-counter.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('courses/:courseId/modules')
@UseGuards(SupabaseJwtGuard)
export class CourseStructureController {
  constructor(private readonly structureService: CourseStructureService) {}

  // GET /api/v1/courses/:courseId/modules
  @Get()
  getStructure(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.getStructure(courseId, user.id);
  }

  // POST /api/v1/courses/:courseId/modules
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateModuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.createModule(courseId, user.id, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/reorder
  // (declarado ANTES de :moduleId para que Nest no interprete "reorder" como un id)
  @Patch('reorder')
  reorderModules(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.reorderModules(courseId, user.id, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId
  @Patch(':moduleId')
  updateModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: UpdateModuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.updateModule(courseId, moduleId, user.id, dto);
  }

  // DELETE /api/v1/courses/:courseId/modules/:moduleId
  @Delete(':moduleId')
  deleteModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: ExpectedCounterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.deleteModule(courseId, moduleId, user.id, dto.expectedCounter);
  }

  // POST /api/v1/courses/:courseId/modules/:moduleId/chapters
  @Post(':moduleId/chapters')
  @HttpCode(HttpStatus.CREATED)
  createChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: CreateChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.createChapter(courseId, moduleId, user.id, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/reorder
  @Patch(':moduleId/chapters/reorder')
  reorderChapters(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.reorderChapters(courseId, moduleId, user.id, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId
  @Patch(':moduleId/chapters/:chapterId')
  updateChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: UpdateChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.updateChapter(courseId, moduleId, chapterId, user.id, dto);
  }

  // DELETE /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId
  @Delete(':moduleId/chapters/:chapterId')
  deleteChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: ExpectedCounterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.deleteChapter(courseId, moduleId, chapterId, user.id, dto.expectedCounter);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId/move
  @Patch(':moduleId/chapters/:chapterId/move')
  moveChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: MoveChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.moveChapter(courseId, moduleId, chapterId, user.id, dto);
  }
}
