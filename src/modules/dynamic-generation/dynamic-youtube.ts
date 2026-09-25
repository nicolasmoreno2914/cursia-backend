import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { YoutubeService } from '../../youtube/youtube.service';
import { YoutubeTokenService } from '../../youtube/youtube-token.service';
import { YoutubeQuotaException, YoutubeUploadTransportError } from '../../youtube/youtube-upload.service';
import type { YoutubeConnection } from '../../youtube/entities/youtube-connection.entity';
import {
  YOUTUBE_UPLOAD_PRIVACY,
  YoutubePreflightChannel,
  YoutubePreflightCheckKey,
  YoutubePreflightReason,
  YoutubePreflightResult,
  buildYoutubePreflightResult,
  hasYoutubeUploadScope,
} from './dynamic-video-delivery';

/**
 * DN-1 — YouTube Unlisted para la entrega final del video V2.
 *
 * - `resolveYoutubeConnectionFor`: ÚNICO punto por el que V2 obtiene la
 *   conexión de YouTube de un run/owner.
 * - `evaluateYoutubePreflight` / `lightYoutubePreflight`: preflight completo
 *   (endpoint + gate de startRun) y liviano (worker, antes de cada envío nuevo a
 *   Videogen), con dependencias inyectables (tests: siempre fakes).
 * - `DynamicYoutubePreflightService`: implementación Nest sobre los servicios
 *   legacy (YoutubeService, YoutubeTokenService) sin modificarlos.
 * - `classifyYoutubeUploadError`: clasifica un error de
 *   YoutubeUploadService.uploadFromUrl para el worker dynamic.
 *
 * Nunca se devuelven tokens ni errores crudos de Google.
 */

export interface ResolveYoutubeConnectionOptions {
  /**
   * Punto de extensión (DN-1: "preparado para institución"). HOY se ignora:
   * la conexión es SIEMPRE la del owner (`youtube_connections.user_id`), sin
   * cambios de esquema. Cuando exista un canal por institución, este es el
   * único lugar a cambiar (buscar la conexión de la institución y, si no hay,
   * caer a la del owner) — preflight, gate de startRun y worker pasan por acá.
   */
  institutionId?: number | string | null;
}

export interface YoutubeConnectionSource {
  getConnection(userId: string): Promise<YoutubeConnection | null>;
}

/** Conexión de YouTube a usar para un owner (hoy: la del owner; ver ResolveYoutubeConnectionOptions). */
export async function resolveYoutubeConnectionFor(
  source: YoutubeConnectionSource,
  ownerId: string,
  _opts: ResolveYoutubeConnectionOptions = {},
): Promise<YoutubeConnection | null> {
  return source.getConnection(ownerId);
}

export interface YoutubePreflightDeps {
  getConnection(ownerId: string, opts?: ResolveYoutubeConnectionOptions): Promise<YoutubeConnection | null>;
  /** Refresh del access token (en memoria). Lanza si Google lo rechaza. */
  getAccessToken(connection: YoutubeConnection): Promise<string>;
  /** channels.list?mine=true — null si no hay canal o la llamada falla. */
  listMyChannel(accessToken: string): Promise<YoutubePreflightChannel | null>;
  logger?: { warn(msg: string): unknown };
}

/**
 * Preflight completo: connected → oauth_valid (status active) → refresh_usable
 * (refresh del token) → channel_resolved (channels.list mine=true) →
 * upload_permission (scope youtube.upload guardado) → privacy_unlisted
 * (constante: el upload V2 es Unlisted). Solo lecturas: no escribe nada.
 */
export async function evaluateYoutubePreflight(
  deps: YoutubePreflightDeps,
  ownerId: string,
  opts: ResolveYoutubeConnectionOptions = {},
): Promise<YoutubePreflightResult> {
  const checks: Record<YoutubePreflightCheckKey, boolean> = {
    connected: false,
    oauth_valid: false,
    refresh_usable: false,
    channel_resolved: false,
    upload_permission: false,
    privacy_unlisted: YOUTUBE_UPLOAD_PRIVACY === 'unlisted',
  };
  let channel: YoutubePreflightChannel | null = null;
  const conn = await deps.getConnection(ownerId, opts);
  if (conn && conn.status !== 'revoked') {
    checks.connected = true;
    checks.upload_permission = hasYoutubeUploadScope(conn.scopes);
    checks.oauth_valid = conn.status === 'active';
    if (checks.oauth_valid) {
      let accessToken: string | null = null;
      try {
        accessToken = await deps.getAccessToken(conn);
        checks.refresh_usable = typeof accessToken === 'string' && accessToken.length > 0;
      } catch (err) {
        // Sin el detalle de Google (puede traer texto del proveedor): solo el hecho.
        deps.logger?.warn(`[YTPreflight] refresh falló para owner=${ownerId}`);
      }
      if (checks.refresh_usable && accessToken) {
        try {
          channel = await deps.listMyChannel(accessToken);
        } catch {
          channel = null;
        }
        checks.channel_resolved = !!channel && typeof channel.id === 'string' && channel.id.length > 0;
      }
    }
  }
  return buildYoutubePreflightResult(checks, channel);
}

export type LightYoutubePreflightResult = { ok: true; connection: YoutubeConnection } | { ok: false; reason: YoutubePreflightReason };

/**
 * Preflight liviano del worker (inmediatamente antes de un envío NUEVO a
 * Videogen de un run youtube, y antes de cada subida): conexión activa +
 * scope de subida + refresh del token. Sin channels.list.
 */
export async function lightYoutubePreflight(
  deps: Pick<YoutubePreflightDeps, 'getConnection'> & { getAccessToken?: YoutubePreflightDeps['getAccessToken'] },
  ownerId: string,
  opts: ResolveYoutubeConnectionOptions = {},
): Promise<LightYoutubePreflightResult> {
  const conn = await deps.getConnection(ownerId, opts);
  if (!conn || conn.status === 'revoked') return { ok: false, reason: 'no_connection' };
  if (conn.status !== 'active') return { ok: false, reason: 'reauth_required' };
  if (deps.getAccessToken) {
    try {
      const t = await deps.getAccessToken(conn);
      if (typeof t !== 'string' || t.length === 0) return { ok: false, reason: 'token_refresh_failed' };
    } catch {
      return { ok: false, reason: 'token_refresh_failed' };
    }
  }
  if (!hasYoutubeUploadScope(conn.scopes)) return { ok: false, reason: 'missing_upload_scope' };
  return { ok: true, connection: conn };
}

export const YOUTUBE_CHANNELS_MINE_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=1';

/** channels.list mine=true (read-only, 1 unidad de cuota). null si no hay canal o la respuesta no es 2xx. */
export async function fetchMyYoutubeChannel(accessToken: string, logger?: { warn(msg: string): unknown }): Promise<YoutubePreflightChannel | null> {
  const res = await fetch(YOUTUBE_CHANNELS_MINE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    logger?.warn(`[YTPreflight] channels.list HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as Record<string, any>;
  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  return {
    id: item.id,
    title: typeof item.snippet?.title === 'string' ? item.snippet.title : null,
    thumbnail: typeof item.snippet?.thumbnails?.default?.url === 'string' ? item.snippet.thumbnails.default.url : null,
  };
}

/**
 * Preflight de YouTube para V2 sobre los servicios legacy (sin modificarlos).
 * Usado por GET /dynamic/youtube/preflight y por el gate de RunsService.
 */
@Injectable()
export class DynamicYoutubePreflightService {
  private readonly logger = new Logger('DynamicYoutubePreflight');

  constructor(
    private readonly youtube: YoutubeService,
    private readonly tokens: YoutubeTokenService,
  ) {}

  getConnection(ownerId: string, opts: ResolveYoutubeConnectionOptions = {}): Promise<YoutubeConnection | null> {
    return resolveYoutubeConnectionFor(this.youtube, ownerId, opts);
  }

  check(ownerId: string, opts: ResolveYoutubeConnectionOptions = {}): Promise<YoutubePreflightResult> {
    return evaluateYoutubePreflight(
      {
        getConnection: (id, o) => this.getConnection(id, o),
        getAccessToken: (c) => this.tokens.getAccessToken(c.encryptedRefreshToken, c.tokenIv),
        listMyChannel: (t) => fetchMyYoutubeChannel(t, this.logger),
        logger: this.logger,
      },
      ownerId,
      opts,
    );
  }
}

// ─── Clasificación de errores de subida (worker dynamic) ────────────────────

/**
 * - `auth`: 401/403 no-cuota o conexión/refresh inválidos → blocked_auth (sin video creado).
 * - `quota`: quotaExceeded/rateLimitExceeded → blocked_quota (sin video creado).
 * - `download`: no se pudo bajar el MP4 de Videogen (antes de tocar YouTube).
 * - `transient`: 5xx/red al INICIAR la sesión, o respuesta HTTP 5xx explícita
 *   al subir los bytes (paridad legacy: se reintenta) → upload_failed.
 * - `ambiguous`: cualquier otra cosa a mitad de la subida (red, timeout, 2xx
 *   sin id, error desconocido): el video PUEDE existir → nunca se re-sube solo.
 */
export type YoutubeUploadErrorKind = 'auth' | 'quota' | 'download' | 'transient' | 'ambiguous';

export function classifyYoutubeUploadError(err: unknown): YoutubeUploadErrorKind {
  if (err instanceof YoutubeQuotaException) return 'quota';
  if (err instanceof UnauthorizedException) return 'auth';
  if (err instanceof BadRequestException) return 'download';
  if (err instanceof YoutubeUploadTransportError) {
    if (err.phase === 'init') return 'transient';
    if (typeof err.httpStatus === 'number' && err.httpStatus >= 500 && err.httpStatus <= 599) return 'transient';
    return 'ambiguous';
  }
  return 'ambiguous';
}
