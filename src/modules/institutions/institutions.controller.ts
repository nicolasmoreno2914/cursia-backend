import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { InstitutionsService } from './institutions.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('institutions')
@UseGuards(SupabaseJwtGuard)
export class InstitutionsController {
  constructor(private readonly institutionsService: InstitutionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: { name: string },
    @CurrentUser() user: AuthUser,
  ) {
    const institution = await this.institutionsService.create(body.name, user.id);
    return { ok: true, data: institution };
  }

  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    const institutions = await this.institutionsService.findAll(user.id);
    return { ok: true, data: institutions };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const institution = await this.institutionsService.findOne(id, user.id);
    return { ok: true, data: institution };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const institution = await this.institutionsService.update(id, user.id, body);
    return { ok: true, data: institution };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.institutionsService.remove(id, user.id);
  }
}
