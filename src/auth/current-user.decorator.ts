import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './auth.types';

/**
 * Extrae el usuario autenticado del request.
 * Solo funciona en endpoints protegidos por SupabaseJwtGuard.
 *
 * Uso:
 *   @Get('me')
 *   @UseGuards(SupabaseJwtGuard)
 *   me(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
