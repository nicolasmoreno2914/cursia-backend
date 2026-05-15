import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SupabaseJwtGuard } from '../auth/supabase-jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { YoutubeService } from './youtube.service';

/**
 * Endpoints de YouTube OAuth.
 * Prefijo global: /api/v1/youtube
 *
 * Flujo:
 *   1. Frontend llama POST /oauth/session (con JWT) → recibe { oauthUrl }
 *   2. Frontend hace window.location.href = oauthUrl
 *   3. Usuario autentica con Google
 *   4. Google llama GET /oauth/callback?code=...&state=...
 *   5. Backend guarda conexión y redirige al frontend
 */
@Controller('youtube')
export class YoutubeController {
  private readonly logger = new Logger(YoutubeController.name);

  constructor(private readonly youtubeService: YoutubeService) {}

  // ── POST /api/v1/youtube/oauth/session ────────────────────────────
  /**
   * El frontend llama este endpoint con el JWT de Supabase.
   * Devuelve la URL de OAuth de Google.
   * El frontend luego redirige al usuario a esa URL.
   *
   * Este diseño evita exponer el JWT de Supabase en query params.
   */
  @Post('oauth/session')
  @UseGuards(SupabaseJwtGuard)
  @HttpCode(HttpStatus.OK)
  createOAuthSession(@CurrentUser() user: AuthUser) {
    const oauthUrl = this.youtubeService.generateOAuthUrl(user.id, user.email);
    return { oauthUrl };
  }

  // ── GET /api/v1/youtube/oauth/callback ────────────────────────────
  /**
   * Endpoint público — Google redirige aquí tras el consentimiento del usuario.
   * Valida el state, intercambia el code, guarda la conexión
   * y redirige al frontend con el resultado.
   *
   * NO requiere JWT (es una redirección de Google, no del frontend).
   */
  @Get('oauth/callback')
  async handleCallback(
    @Query('code')  code: string  | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');

    // ── El usuario denegó el acceso o hubo error en Google ──────────
    if (error || !code || !state) {
      const reason = error ?? 'cancelled';
      this.logger.warn(`OAuth callback denegado o incompleto: ${reason}`);
      return res.redirect(
        `${frontendUrl}?youtube_error=${encodeURIComponent(reason)}`,
      );
    }

    // ── Procesar callback válido ─────────────────────────────────────
    try {
      await this.youtubeService.handleCallback(code, state);
      return res.redirect(`${frontendUrl}?youtube_connected=true`);
    } catch (err) {
      const msg = (err as Error).message ?? 'error_desconocido';
      this.logger.error(`OAuth callback fallido: ${msg}`);
      return res.redirect(
        `${frontendUrl}?youtube_error=${encodeURIComponent(msg)}`,
      );
    }
  }

  // ── GET /api/v1/youtube/connection ────────────────────────────────
  /**
   * Devuelve el estado de conexión de YouTube del usuario.
   * El frontend lo usa para mostrar el canal conectado o el botón de conectar.
   * NUNCA devuelve tokens.
   */
  @Get('connection')
  @UseGuards(SupabaseJwtGuard)
  async getConnection(@CurrentUser() user: AuthUser) {
    const connection = await this.youtubeService.getConnection(user.id);

    if (!connection || connection.status === 'revoked') {
      return { connected: false };
    }

    return {
      connected:    true,
      channelId:    connection.channelId,
      channelTitle: connection.channelTitle,
      thumbnail:    connection.channelThumbnailUrl,
      status:       connection.status,     // 'active' | 'reauth_required'
      connectedAt:  connection.connectedAt,
    };
  }

  // ── DELETE /api/v1/youtube/connection ─────────────────────────────
  /**
   * Desconecta YouTube: revoca el token en Google y marca status=revoked.
   * Responde 204 No Content.
   */
  @Delete('connection')
  @UseGuards(SupabaseJwtGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeConnection(@CurrentUser() user: AuthUser) {
    await this.youtubeService.revokeConnection(user.id);
  }
}
