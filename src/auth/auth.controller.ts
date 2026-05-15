import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from './supabase-jwt.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './auth.types';

@Controller('auth')
export class AuthController {
  /**
   * GET /api/v1/auth/me
   * Verifica el JWT y devuelve los datos básicos del usuario autenticado.
   * Útil para que el frontend confirme que el token funciona con el backend.
   */
  @Get('me')
  @UseGuards(SupabaseJwtGuard)
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
