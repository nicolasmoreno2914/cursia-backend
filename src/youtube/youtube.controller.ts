import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
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
import { YoutubeTokenService } from './youtube-token.service';
import { YoutubeUploadService } from './youtube-upload.service';

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

  constructor(
    private readonly youtubeService:       YoutubeService,
    private readonly youtubeTokenService:  YoutubeTokenService,
    private readonly youtubeUploadService: YoutubeUploadService,
  ) {}

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

  // ── GET /api/v1/youtube/auth-test ────────────────────────────────
  /**
   * Valida la conexión de YouTube sin subir ni modificar nada.
   * Flujo: JWT → buscar conexión → descifrar refresh_token → obtener
   * access_token → llamar channels.list (read-only, 0 costo) → { ok, channel }.
   *
   * Uso QA: confirmar que tokens y cifrado funcionan antes de gastar créditos.
   * NUNCA devuelve tokens en la respuesta.
   */
  @Get('auth-test')
  @UseGuards(SupabaseJwtGuard)
  async authTest(@CurrentUser() user: AuthUser) {
    const connection = await this.youtubeService.getConnection(user.id);

    if (!connection || connection.status === 'revoked') {
      return {
        ok:      false,
        reason:  'no_connection',
        message: 'YouTube no está conectado para este usuario.',
      };
    }

    if (connection.status === 'reauth_required') {
      return {
        ok:      false,
        reason:  'reauth_required',
        message: 'El token de YouTube expiró. Reconecta el canal.',
      };
    }

    // Obtener access_token fresco — valida que el refresh_token y el cifrado funcionan
    let accessToken: string;
    try {
      accessToken = await this.youtubeTokenService.getAccessToken(
        connection.encryptedRefreshToken,
        connection.tokenIv,
      );
    } catch (err) {
      return {
        ok:      false,
        reason:  'token_refresh_failed',
        message: `No se pudo renovar el token: ${(err as Error).message}`,
      };
    }

    // Llamar channels.list — read-only, no consume cuota de escritura
    let channelVerified = false;
    let channelPart: Record<string, unknown> = {};
    try {
      const ytRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=1',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (ytRes.ok) {
        const ytData = (await ytRes.json()) as Record<string, unknown>;
        const items = ytData['items'] as unknown[] | undefined;
        if (items && items.length > 0) {
          channelVerified = true;
          const snippet = (items[0] as Record<string, unknown>)['snippet'] as Record<string, unknown> | undefined;
          channelPart = {
            channel_id:    (items[0] as Record<string, unknown>)['id'],
            channel_title: snippet?.['title'] ?? connection.channelTitle,
          };
        }
      } else {
        this.logger.warn(`[YTAuthTest] channels.list HTTP ${ytRes.status}`);
      }
    } catch (err) {
      this.logger.warn(`[YTAuthTest] channels.list error: ${(err as Error).message}`);
    }

    this.logger.log(
      `[YTAuthTest] user=${user.id} canal="${connection.channelTitle}" verified=${channelVerified}`,
    );

    return {
      ok:              true,
      token_valid:     true,
      channel_verified: channelVerified,
      channel_id:      channelPart['channel_id']    ?? connection.channelId,
      channel_title:   channelPart['channel_title'] ?? connection.channelTitle,
      connection_status: connection.status,
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

  // ── POST /api/v1/youtube/upload-from-url ──────────────────────────
  /**
   * Descarga un MP4 desde download_url (Videogen) y lo sube a YouTube
   * usando la cuenta conectada del usuario autenticado.
   *
   * El MP4 solo existe en memoria durante la operación (no se persiste en Cursia).
   * Los tokens de YouTube del usuario nunca salen hacia Videogen.
   *
   * Body:
   *   download_url    {string}  URL del MP4 en Videogen (requerido)
   *   title           {string}  Título del video en YouTube (opcional)
   *   description     {string}  Descripción (opcional)
   *   privacy_status  {string}  'unlisted' | 'public' | 'private' (default: unlisted)
   *   chapter_number  {number}  Número de capítulo para contexto (opcional)
   *
   * Devuelve:
   *   { youtube_url, video_id, chapter_number }
   */
  @Post('upload-from-url')
  @UseGuards(SupabaseJwtGuard)
  @HttpCode(HttpStatus.OK)
  async uploadFromUrl(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @Headers('x-cursia-dry-run') dryRunHeader?: string,
  ) {
    const downloadUrl = body['download_url'] as string | undefined;
    if (!downloadUrl || typeof downloadUrl !== 'string' || !downloadUrl.startsWith('http')) {
      throw new BadRequestException('download_url es requerido y debe ser una URL válida.');
    }

    const title         = (body['title']          as string  | undefined) ?? null;
    const description   = (body['description']    as string  | undefined) ?? '';
    const privacyStatus = (body['privacy_status'] as string  | undefined) ?? 'unlisted';
    const chapterNumber = (body['chapter_number'] as number  | undefined) ?? null;

    // dry-run: cuerpo JSON { dryRun: true } o header X-Cursia-Dry-Run: true
    const isDryRun =
      body['dryRun'] === true ||
      body['dry_run'] === true ||
      dryRunHeader === 'true' ||
      dryRunHeader === '1';

    if (!['public', 'unlisted', 'private'].includes(privacyStatus)) {
      throw new BadRequestException('privacy_status debe ser public, unlisted o private.');
    }

    // Verificar conexión YouTube del usuario (también en dry-run — valida auth)
    const connection = await this.youtubeService.getConnection(user.id);
    if (!connection || connection.status === 'revoked') {
      throw new NotFoundException(
        'YouTube no está conectado. Ve a la sección Cuenta → conecta tu canal de YouTube.',
      );
    }

    const videoTitle = title
      ?? (chapterNumber != null ? `Capítulo ${chapterNumber}` : 'Video generado por IA');

    // ── Modo dry-run: validar sin descargar ni subir ─────────────────
    if (isDryRun) {
      this.logger.log(
        `[YTUpload][DRY-RUN] user=${user.id} canal="${connection.channelTitle}" ` +
        `cap=${chapterNumber} title="${videoTitle}" download_url=${downloadUrl.slice(0, 60)}…`,
      );
      return {
        dry_run:        true,
        youtube_url:    'https://www.youtube.com/watch?v=dry_test_ok',
        video_id:       'dry_test_ok',
        chapter_number: chapterNumber,
        channel_id:     connection.channelId,
        channel_title:  connection.channelTitle,
        validated: {
          jwt:           true,
          connection:    true,
          payload:       true,
          download_url:  downloadUrl,
          title:         videoTitle,
          privacy:       privacyStatus,
        },
      };
    }

    // ── Upload real ──────────────────────────────────────────────────
    this.logger.log(
      `[YTUpload] user=${user.id} canal="${connection.channelTitle}" ` +
      `cap=${chapterNumber} title="${videoTitle}"`,
    );

    const result = await this.youtubeUploadService.uploadFromUrl(connection, {
      downloadUrl,
      title:          videoTitle,
      description:    description as string,
      privacyStatus:  privacyStatus as 'public' | 'unlisted' | 'private',
      chapterNumber:  chapterNumber ?? undefined,
    });

    return {
      youtube_url:    result.youtubeUrl,
      video_id:       result.videoId,
      chapter_number: chapterNumber,
    };
  }
}
