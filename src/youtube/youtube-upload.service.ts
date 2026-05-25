import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { YoutubeTokenService } from './youtube-token.service';
import { YoutubeConnection } from './entities/youtube-connection.entity';

export interface YoutubeUploadOptions {
  downloadUrl:    string;
  title:          string;
  description?:   string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  chapterNumber?: number;
}

export interface YoutubeUploadResult {
  youtubeUrl: string;
  videoId:    string;
}

/**
 * YoutubeUploadService
 *
 * Descarga un MP4 desde una URL (Videogen download_url) y lo sube
 * a la cuenta YouTube del usuario vía YouTube Data API v3 resumable upload.
 *
 * Restricciones de diseño:
 *   - El MP4 se descarga en memoria (Buffer) — no se persiste en disco en Cursia.
 *   - El access_token NUNCA se registra en logs.
 *   - Los tokens de YouTube del usuario NUNCA salen de Cursia hacia Videogen.
 */
@Injectable()
export class YoutubeUploadService {
  private readonly logger = new Logger(YoutubeUploadService.name);

  constructor(private readonly tokenService: YoutubeTokenService) {}

  async uploadFromUrl(
    connection: YoutubeConnection,
    options: YoutubeUploadOptions,
  ): Promise<YoutubeUploadResult> {
    const {
      downloadUrl,
      title,
      description   = '',
      privacyStatus = 'unlisted',
    } = options;

    if (connection.status === 'revoked') {
      throw new UnauthorizedException(
        'La conexión de YouTube fue revocada. Reconecta en la sección Cuenta.',
      );
    }
    if (connection.status === 'reauth_required') {
      throw new UnauthorizedException(
        'La conexión de YouTube expiró. Reconecta en la sección Cuenta.',
      );
    }

    // ── 1. Obtener access token fresco ────────────────────────────────────
    this.logger.log(`[YTUpload] Renovando access token user=${connection.userId}`);
    let accessToken: string;
    try {
      accessToken = await this.tokenService.getAccessToken(
        connection.encryptedRefreshToken,
        connection.tokenIv,
      );
    } catch (err) {
      throw new UnauthorizedException(
        `No se pudo renovar el token de YouTube: ${(err as Error).message}. ` +
        'Reconecta tu cuenta en la sección Cuenta.',
      );
    }

    // ── 2. Descargar MP4 desde Videogen ───────────────────────────────────
    this.logger.log(`[YTUpload] Descargando MP4: ${downloadUrl}`);
    let fileBuffer: Buffer;
    try {
      const dlResp = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(180_000),  // 3 min max download
      });
      if (!dlResp.ok) {
        throw new Error(`HTTP ${dlResp.status}`);
      }
      fileBuffer = Buffer.from(await dlResp.arrayBuffer());
    } catch (err) {
      throw new BadRequestException(
        `No se pudo descargar el video desde Videogen: ${(err as Error).message}`,
      );
    }

    const fileSize = fileBuffer.length;
    this.logger.log(`[YTUpload] MP4 descargado: ${fileSize} bytes (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

    if (fileSize < 1024) {
      throw new BadRequestException('El archivo descargado está vacío o es inválido.');
    }

    // ── 3. Iniciar upload resumable en YouTube ────────────────────────────
    const metadata = {
      snippet: {
        title:      title.slice(0, 100),   // YouTube: máx 100 caracteres
        description,
        categoryId: '27',                  // 27 = Education
        defaultLanguage: 'es',
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    };

    this.logger.log(`[YTUpload] Iniciando upload resumable: "${title}" (${privacyStatus})`);

    let uploadUrl: string;
    try {
      const initResp = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            'Authorization':           `Bearer ${accessToken}`,
            'Content-Type':            'application/json; charset=UTF-8',
            'X-Upload-Content-Type':   'video/mp4',
            'X-Upload-Content-Length': String(fileSize),
          },
          body: JSON.stringify(metadata),
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (initResp.status === 401 || initResp.status === 403) {
        throw new UnauthorizedException(
          'YouTube rechazó el token. Reconecta tu cuenta en la sección Cuenta.',
        );
      }
      if (!initResp.ok) {
        const errText = await initResp.text();
        this.logger.error(`[YTUpload] Init fallido HTTP ${initResp.status}: ${errText.slice(0, 400)}`);
        throw new Error(`HTTP ${initResp.status}`);
      }

      const location = initResp.headers.get('location');
      if (!location) {
        throw new Error('Location header ausente en respuesta de YouTube');
      }
      uploadUrl = location;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new ServiceUnavailableException(
        `No se pudo iniciar la subida a YouTube: ${(err as Error).message}`,
      );
    }

    // ── 4. Subir bytes del video ──────────────────────────────────────────
    this.logger.log(`[YTUpload] Subiendo ${fileSize} bytes a YouTube…`);
    let videoId: string;
    try {
      // Buffer → Uint8Array — necesario para satisfacer BodyInit sin cast
      const uploadResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type':   'video/mp4',
          'Content-Length': String(fileSize),
        },
        body: new Uint8Array(fileBuffer),
        signal: AbortSignal.timeout(600_000),  // 10 min max — videos grandes
      });

      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        this.logger.error(`[YTUpload] Upload fallido HTTP ${uploadResp.status}: ${errText.slice(0, 300)}`);
        throw new Error(`HTTP ${uploadResp.status}`);
      }

      const videoData = (await uploadResp.json()) as Record<string, unknown>;
      const id = videoData['id'] as string | undefined;
      if (!id) {
        throw new Error('YouTube no devolvió ID del video');
      }
      videoId = id;
    } catch (err) {
      throw new ServiceUnavailableException(
        `Fallo al subir video a YouTube: ${(err as Error).message}`,
      );
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    this.logger.log(`[YTUpload] ✅ Video subido: ${youtubeUrl}`);
    return { youtubeUrl, videoId };
  }
}
