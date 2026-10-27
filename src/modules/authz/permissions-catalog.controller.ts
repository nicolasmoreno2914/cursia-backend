import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { permissionCatalogView } from './permissions';
import { AuthenticatedOnly } from './require-permission.decorator';

/** r75 · `GET /api/v1/permissions/catalog` (02 §A): roles, permisos (etiqueta, sensible, otorgable) y la matriz. */
@Controller('permissions')
@UseGuards(SupabaseJwtGuard)
export class PermissionsCatalogController {
  @Get('catalog')
  @AuthenticatedOnly('catálogo estático de permisos (sin datos de terceros)')
  catalog() {
    return permissionCatalogView();
  }
}
