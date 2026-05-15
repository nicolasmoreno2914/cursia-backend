import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';

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

  // ── Access token (solo en memoria) ────────────────────────────────

  /**
   * Obtiene un access_token fresco desde Google usando el refresh_token cifrado.
   * El access_token NUNCA se guarda en base de datos ni en logs.
   * TTL del access_token: ~1 hora (estándar de Google).
   */
  async getAccessToken(encryptedRefreshToken: string, tokenIv: string): Promise<string> {
    const refreshToken = this.decryptRefreshToken(encryptedRefreshToken, tokenIv);

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.YOUTUBE_CLIENT_ID     ?? '',
        client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }).toString(),
    });

    const data = (await resp.json()) as Record<string, unknown>;

    if (!data['access_token']) {
      // Log del error sin incluir tokens
      this.logger.error(
        `Fallo al renovar access_token de YouTube. HTTP ${resp.status}. ` +
        `Error: ${data['error'] ?? 'unknown'}`,
      );
      throw new Error(
        `No se pudo renovar el token de YouTube: ${data['error_description'] ?? data['error'] ?? 'error desconocido'}`,
      );
    }

    return data['access_token'] as string;
  }
}
