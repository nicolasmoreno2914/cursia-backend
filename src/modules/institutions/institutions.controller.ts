import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { InstitutionsService } from './institutions.service';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * r75: el comportamiento depende de CURSIA_RBAC_MODE (ver InstitutionsService). Con `off` (default) es idéntico al
 * anterior. `GET /institutions?all=1` lista todas solo para el SuperAdmin (el resto lo ignora).
 */
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
    const institution = await this.institutionsService.createForActor(body?.name, user);
    return { ok: true, data: institution };
  }

  @Get()
  async findAll(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    const institutions = await this.institutionsService.findAllForActor(user, all === '1' || all === 'true');
    return { ok: true, data: institutions };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const institution = await this.institutionsService.findOneForActor(id, user);
    return { ok: true, data: institution };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const institution = await this.institutionsService.updateForActor(id, user, body ?? {});
    return { ok: true, data: institution };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.institutionsService.removeForActor(id, user);
  }
}
