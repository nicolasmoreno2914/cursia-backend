import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { networkReasonOf, parseGoogleErrorBody, YoutubeApiError, youtubeErrorInfo, youtubeErrorLogLine } from './youtube-api-error';

/** r67 (B2): tope del refresh del token (antes sin timeout: un endpoint colgado colgaba la subida). */
export const YOUTUBE_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * YoutubeTokenService — cifrado y gestión de tokens OAuth de YouTube.
 *
 * Algoritmo: AES-256-GCM (autenticado, resistente a manipulación).
 * La clave se deriva de YOUTUBE_TOKEN_SECRET vía SHA-256 → 32 bytes.
 *
 * SEGURIDAD:
 * - Nunca imprime tokens en logs.
 * - El access_token nunca se guarda en base de datos.
 * - El refresh_token solo existe cifrado en base de datos.
 * - La clave de cifrado solo existe en variables de entorno.
 */
@Injectable()
export class YoutubeTokenService implements OnModuleInit {
  private readonly logger = new Logger(YoutubeTokenService.name);
  private key!: Buffer;
  /** r67 (B2): tope del refresh (configurable solo para las pruebas offline). */
  refreshTimeoutMs = YOUTUBE_TOKEN_REFRESH_TIMEOUT_MS;

  onModuleInit(): void {
    const secret = process.env.YOUTUBE_TOKEN_SECRET;

    // Si no hay credenciales de YouTube configuradas, el servicio simplemente
    // no estará disponible — no bloqueamos el arranque del servidor.
    if (!secret) {
      this.logger.warn(
        'YOUTUBE_TOKEN_SECRET no está configurado. ' +
        'Los endpoints de YouTube no estarán disponibles. ' +
        'Configura esta variable para habilitar la integración.',
      );
      return;
    }

    if (secret.length < 16) {
      throw new Error(
        'YOUTUBE_TOKEN_SECRET debe tener mínimo 16 caracteres. ' +
        'Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }

    // Derivar clave de 32 bytes (256 bits) desde el secret
    this.key = crypto.createHash('sha256').update(secret).digest();
    this.logger.log('YoutubeTokenService inicializado ✓');
  }

  private assertKey(): void {
    if (!this.key) {
      throw new Error(
        'YOUTUBE_TOKEN_SECRET no está configurado. ' +
        'No se pueden cifrar/descifrar tokens de YouTube.',
      );
    }
  }

  // ── Cifrado ────────────────────────────────────────────────────────

  /**
   * Cifra un refresh_token con AES-256-GCM.
   * @returns { encrypted: base64(ciphertext + authTag), iv: base64(12-byte IV) }
   */
  encryptRefreshToken(refreshToken: string): { encrypted: string; iv: string } {
    this.assertKey();

    const iv = crypto.randomBytes(12); // 96-bit IV recomendado para GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(refreshToken, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag(); // 16 bytes — integridad y autenticidad

    // Concatenar ciphertext + authTag para almacenarlos juntos
    return {
      encrypted: Buffer.concat([ciphertext, authTag]).toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  /**
   * Descifra un refresh_token previamente cifrado con encryptRefreshToken.
   * Lanza si el ciphertext fue manipulado (authTag inválido).
   */
  decryptRefreshToken(encrypted: string, iv: string): string {
    this.assertKey();

    const data = Buffer.from(encrypted, 'base64');
    const ivBuffer = Buffer.from(iv, 'base64');

    // Los últimos 16 bytes son el authTag de GCM
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, ivBuffer);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * r67 (B3): cifra un secreto de corta vida (la URL de una sesión resumable de YouTube, que es una capacidad) con
   * el MISMO mecanismo AES-256-GCM de los refresh tokens. Nunca se loguea ni sale en DTOs.
   */
  encryptSecret(secret: string): { encrypted: string; iv: string } {
    return this.encryptRefreshToken(secret);
  }

  decryptSecret(encrypted: string, iv: string): string {
    return this.decryptRefreshToken(encrypted, iv);
  }

  // ── Access token (solo en memoria) ────────────────────────────────

  /**
   * Obtiene un access_token fresco desde Google usando el refresh_token cifrado.
   * El access_token NUNCA se guarda en base de datos ni en logs.
   * TTL del access_token: ~1 hora (estándar de Google).
   *
   * r67 (B1/B2): todo fallo lanza `YoutubeApiError` con phase='refresh' y SOLO campos estructurados:
   * - respuesta JSON de error → reason = campo `error` de OAuth (`invalid_grant`, `invalid_client`, …), httpStatus;
   * - red / timeout (nuevo: 15 s) → reason `network` | `timeout`, httpStatus null;
   * - cuerpo no JSON → reason `non_json`; 2xx sin access_token → reason `no_access_token`.
   * La decisión (definitivo vs transitorio) la toma `classifyYoutubeFailure` (dynamic-youtube.ts), no este servicio.
   */
  async getAccessToken(encryptedRefreshToken: string, tokenIv: string): Promise<string> {
    const refreshToken = this.decryptRefreshToken(encryptedRefreshToken, tokenIv);

    let resp: Response;
    try {
      resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     process.env.YOUTUBE_CLIENT_ID     ?? '',
          client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
          refresh_token: refreshToken,
          grant_type:    'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(this.refreshTimeoutMs),
      });
    } catch (err) {
      const info = youtubeErrorInfo('refresh', { reason: networkReasonOf(err) });
      this.logger.error(`Fallo al renovar access_token de YouTube (${youtubeErrorLogLine(info)})`);
      throw new YoutubeApiError(info, `No se pudo renovar el token de YouTube: ${info.reason}`);
    }

    let text = '';
    try {
      text = await resp.text();
    } catch (err) {
      const info = youtubeErrorInfo('refresh', { httpStatus: resp.status, reason: networkReasonOf(err) });
      this.logger.error(`Fallo al renovar access_token de YouTube (${youtubeErrorLogLine(info)})`);
      throw new YoutubeApiError(info, `No se pudo renovar el token de YouTube: ${info.reason}`);
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = null;
    }

    if (!data || typeof data !== 'object' || !data['access_token']) {
      const parsed = data ? parseGoogleErrorBody(text) : { reason: null, domain: null, message: null, nonJson: true };
      const reason = !data ? 'non_json' : parsed.reason ?? (resp.ok ? 'no_access_token' : null);
      const info = youtubeErrorInfo('refresh', { httpStatus: resp.status, reason, domain: parsed.domain, message: parsed.message });
      // Log del error sin incluir tokens (solo campos estructurados)
      this.logger.error(`Fallo al renovar access_token de YouTube. HTTP ${resp.status}. Error: ${reason ?? 'unknown'} (${youtubeErrorLogLine(info)})`);
      throw new YoutubeApiError(info, `No se pudo renovar el token de YouTube: ${reason ?? 'error desconocido'}`);
    }

    return data['access_token'] as string;
  }
}
