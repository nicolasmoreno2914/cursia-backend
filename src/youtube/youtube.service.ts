import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { YoutubeConnection } from './entities/youtube-connection.entity';
import { YoutubeTokenService } from './youtube-token.service';

interface OAuthStateEntry {
  userId: string;
  email: string;
  createdAt: number;
}

@Injectable()
export class YoutubeService {
  private readonly logger = new Logger(YoutubeService.name);

  /**
   * Estado OAuth en memoria — seguro para v1 (single instance).
   * Cada estado tiene TTL de 10 minutos y es de un solo uso.
   * Para arquitecturas multi-instancia en el futuro: mover a Redis.
   */
  private readonly oauthStates = new Map<string, OAuthStateEntry>();

  constructor(
    @InjectRepository(YoutubeConnection)
    private readonly repo: Repository<YoutubeConnection>,
    private readonly tokenService: YoutubeTokenService,
  ) {
    // Limpieza periódica de estados expirados
    setInterval(() => this.purgeExpiredStates(), 10 * 60 * 1000);
  }

  private purgeExpiredStates(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, entry] of this.oauthStates.entries()) {
      if (entry.createdAt < cutoff) this.oauthStates.delete(key);
    }
  }

  // ── 1. Generar URL de OAuth ──────────────────────────────────────

  /**
   * Genera la URL de Google OAuth con un state anti-CSRF único.
   * El state se asocia al user_id y tiene TTL de 10 minutos.
   */
  generateOAuthUrl(userId: string, email: string): string {
    const clientId    = process.env.YOUTUBE_CLIENT_ID;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new Error(
        'YOUTUBE_CLIENT_ID y YOUTUBE_REDIRECT_URI deben estar configurados ' +
        'para usar la integración de YouTube.',
      );
    }

    // State de 64 hex chars (256 bits de entropía) — imposible de adivinar
    const state = crypto.randomBytes(32).toString('hex');
    this.oauthStates.set(state, { userId, email, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
      ].join(' '),
      access_type: 'offline',  // REQUERIDO para obtener refresh_token
      prompt:      'consent',  // REQUERIDO: fuerza a Google a devolver refresh_token aunque ya esté autorizado
      state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // ── 2. Procesar callback de Google ──────────────────────────────

  async handleCallback(code: string, state: string): Promise<YoutubeConnection> {
    // ── Validar state (anti-CSRF) ──────────────────────────────────
    const stateEntry = this.oauthStates.get(state);
    if (!stateEntry) {
      throw new BadRequestException(
        'Estado OAuth inválido o expirado. Inicia el proceso de conexión de nuevo.',
      );
    }
    if (Date.now() - stateEntry.createdAt > 10 * 60 * 1000) {
      this.oauthStates.delete(state);
      throw new BadRequestException(
        'El estado OAuth expiró (10 minutos). Inicia el proceso de conexión de nuevo.',
      );
    }
    this.oauthStates.delete(state); // one-use: eliminar inmediatamente

    const { userId, email } = stateEntry;

    // ── Intercambiar code por tokens ───────────────────────────────
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.YOUTUBE_CLIENT_ID     ?? '',
        client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
        redirect_uri:  process.env.YOUTUBE_REDIRECT_URI  ?? '',
        grant_type:    'authorization_code',
      }).toString(),
    });

    const tokens = (await tokenResp.json()) as Record<string, unknown>;

    if (!tokens['refresh_token']) {
      // Esto ocurre si el usuario ya autorizó antes y Google no devuelve refresh_token de nuevo.
      // La solución: revocar el acceso en myaccount.google.com/permissions y volver a autorizar.
      this.logger.warn(
        `No se recibió refresh_token para user=${userId}. ` +
        'Puede ser necesario revocar el acceso en Google Account → Seguridad → Permisos.',
      );
      throw new BadRequestException(
        'Google no devolvió un refresh_token. ' +
        'Si ya conectaste YouTube antes, ve a myaccount.google.com/permissions, ' +
        'revoca el acceso a esta app e intenta conectar de nuevo.',
      );
    }

    const accessToken  = tokens['access_token']  as string;
    const refreshToken = tokens['refresh_token'] as string;

    // ── Obtener información del canal ──────────────────────────────
    const channelResp = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const channelData = (await channelResp.json()) as Record<string, any>;
    const channel = channelData['items']?.[0];

    if (!channel) {
      throw new BadRequestException(
        'No se encontró ningún canal de YouTube en esta cuenta de Google. ' +
        'Crea un canal en youtube.com antes de conectar.',
      );
    }

    // ── Cifrar refresh_token ───────────────────────────────────────
    const { encrypted, iv } = this.tokenService.encryptRefreshToken(refreshToken);

    // ── Upsert conexión ────────────────────────────────────────────
    const existing  = await this.repo.findOne({ where: { userId } });
    const connection = existing ?? this.repo.create({ userId });

    connection.userId                = userId;
    connection.userEmail             = email;
    connection.channelId             = channel.id as string;
    connection.channelTitle          = (channel.snippet?.title as string) ?? null;
    connection.channelThumbnailUrl   = (channel.snippet?.thumbnails?.default?.url as string) ?? null;
    connection.encryptedRefreshToken = encrypted;
    connection.tokenIv               = iv;
    connection.scopes                = 'youtube.upload,youtube.readonly';
    connection.status                = 'active';
    connection.connectedAt           = new Date();
    connection.revokedAt             = null;

    const saved = await this.repo.save(connection);
    this.logger.log(
      `YouTube conectado: user=${userId} canal="${channel.snippet?.title}" id=${channel.id}`,
    );
    return saved;
  }

  // ── 3. Obtener estado de conexión ────────────────────────────────

  async getConnection(userId: string): Promise<YoutubeConnection | null> {
    return this.repo.findOne({ where: { userId } });
  }

  // ── 4. Revocar conexión ──────────────────────────────────────────

  async revokeConnection(userId: string): Promise<void> {
    const connection = await this.repo.findOne({ where: { userId } });
    if (!connection) {
      throw new NotFoundException(
        'No hay conexión de YouTube para este usuario.',
      );
    }

    // Intentar revocar en Google (best-effort — no bloqueamos si falla)
    try {
      const refreshToken = this.tokenService.decryptRefreshToken(
        connection.encryptedRefreshToken,
        connection.tokenIv,
      );
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
    } catch (err) {
      this.logger.warn(
        `No se pudo revocar el token en Google para user=${userId}: ${(err as Error).message}`,
      );
    }

    // Marcar como revocado en nuestra base de datos
    connection.status    = 'revoked';
    connection.revokedAt = new Date();
    await this.repo.save(connection);

    this.logger.log(`YouTube desconectado: user=${userId}`);
  }
}
