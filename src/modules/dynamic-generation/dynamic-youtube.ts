import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { YoutubeService } from '../../youtube/youtube.service';
import { YoutubeTokenService } from '../../youtube/youtube-token.service';
import {
  isTransientRefreshFailure,
  YoutubeQuotaException,
  YoutubeSessionExpiredError,
  YoutubeSessionMismatchError,
  YoutubeSessionPersistError,
  YoutubeUploadTransportError,
} from '../../youtube/youtube-upload.service';
import {
  networkReasonOf,
  parseGoogleErrorBody,
  YoutubeApiErrorInfo,
  youtubeErrorInfo,
  youtubeErrorInfoOf,
} from '../../youtube/youtube-api-error';
import type { YoutubeConnection } from '../../youtube/entities/youtube-connection.entity';
import {
  YOUTUBE_UPLOAD_PRIVACY,
  YoutubePreflightChannel,
  YoutubePreflightCheckKey,
  YoutubePreflightReason,
  YoutubePreflightResult,
  YoutubeVideoVerifyResult,
  buildYoutubePreflightResult,
  evaluateVideoOwnership,
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

export type LightYoutubePreflightResult =
  | { ok: true; connection: YoutubeConnection }
  /** r67: `error` = la excepción del refresh (solo en token_refresh_failed) para decidir definitivo vs transitorio. */
  | { ok: false; reason: YoutubePreflightReason; error?: unknown };

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
    } catch (err) {
      return { ok: false, reason: 'token_refresh_failed', error: err };
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
 * r67 (B4): sonda liviana del canal con error ESTRUCTURADO (channels.list mine=true, 1 unidad): `ok` con el id del
 * canal, o el `reason` real de Google (quotaExceeded, insufficientPermissions, forbidden…). Nunca loguea el token.
 */
export async function probeYoutubeChannel(accessToken: string): Promise<{ ok: true; channelId: string } | { ok: false; youtube: YoutubeApiErrorInfo }> {
  let res: Response;
  try {
    res = await fetch(YOUTUBE_CHANNELS_MINE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, youtube: youtubeErrorInfo('channel', { reason: networkReasonOf(err) }) };
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  if (!res.ok) {
    const p = parseGoogleErrorBody(text);
    return { ok: false, youtube: youtubeErrorInfo('channel', { httpStatus: res.status, reason: p.reason ?? (p.nonJson ? 'non_json' : null), domain: p.domain, message: p.message }) };
  }
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item || typeof item.id !== 'string' || !item.id) return { ok: false, youtube: youtubeErrorInfo('channel', { httpStatus: res.status, reason: 'channel_not_found' }) };
  return { ok: true, channelId: item.id };
}

export const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

/**
 * DN-1 (ruling A): verifica un video EXISTENTE antes de aceptarlo en
 * `confirm_existing`: credenciales del owner refrescadas → videos.list
 * (part=snippet,status&id=<id>) → existe, `snippet.channelId` = canal conectado
 * (`youtube_connections.channel_id`) y `privacyStatus` = unlisted. Solo lectura.
 */
export async function verifyExistingYoutubeVideo(
  deps: Pick<YoutubePreflightDeps, 'getConnection' | 'getAccessToken' | 'logger'>,
  ownerId: string,
  videoId: string,
  opts: ResolveYoutubeConnectionOptions = {},
): Promise<YoutubeVideoVerifyResult> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId ?? ''))) return { ok: false, reason: 'video_id_invalid' };
  const conn = await deps.getConnection(ownerId, opts);
  if (!conn || conn.status === 'revoked') return { ok: false, reason: 'no_connection' };
  if (conn.status !== 'active') return { ok: false, reason: 'reauth_required' };
  let token: string;
  try {
    token = await deps.getAccessToken(conn);
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'token_refresh_failed' };
  } catch {
    return { ok: false, reason: 'token_refresh_failed' };
  }
  let item: any = null;
  try {
    const url = `${YOUTUBE_VIDEOS_URL}?part=snippet,status&id=${encodeURIComponent(videoId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      deps.logger?.warn(`[YTVerify] videos.list HTTP ${res.status}`);
      return { ok: false, reason: res.status === 401 || res.status === 403 ? 'reauth_required' : 'video_lookup_failed' };
    }
    const data = (await res.json()) as Record<string, any>;
    item = Array.isArray(data?.items) ? data.items.find((x: any) => x && x.id === videoId) ?? null : null;
  } catch {
    return { ok: false, reason: 'video_lookup_failed' };
  }
  return evaluateVideoOwnership(videoId, conn.channelId, item);
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

  /** DN-1: verificación de un video existente para confirm_existing (ver verifyExistingYoutubeVideo). */
  verifyExistingVideo(ownerId: string, videoId: string, opts: ResolveYoutubeConnectionOptions = {}): Promise<YoutubeVideoVerifyResult> {
    return verifyExistingYoutubeVideo(
      {
        getConnection: (id, o) => this.getConnection(id, o),
        getAccessToken: (c) => this.tokens.getAccessToken(c.encryptedRefreshToken, c.tokenIv),
        logger: this.logger,
      },
      ownerId,
      videoId,
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
    // r67: el refresh transitorio (red/5xx/no-JSON) no creó nada → transitorio; la consulta de estado → ambigua.
    if (err.phase === 'init' || err.phase === 'refresh') return 'transient';
    if (err.phase === 'status') return 'ambiguous';
    if (typeof err.httpStatus === 'number' && err.httpStatus >= 500 && err.httpStatus <= 599) return 'transient';
    return 'ambiguous';
  }
  return 'ambiguous';
}

// ─── r67 (B2): clasificación FINA por el reason real del proveedor ──────────

/**
 * r67 (B2) — decisión por el `reason`/`domain` documentados (videos.insert y errores generales de la Data API; campo
 * `error` del endpoint OAuth), NUNCA solo por el status HTTP:
 *
 * | reason / caso                                                      | kind              | quién           |
 * |--------------------------------------------------------------------|-------------------|-----------------|
 * | quotaExceeded (403)                                                 | quota_project     | espera (auto)   |
 * | uploadLimitExceeded (400 doc; también 403)                          | quota_channel     | espera (auto)   |
 * | rateLimitExceeded / userRateLimitExceeded                           | rate_limited      | backoff (auto)  |
 * | refresh: invalid_grant / invalid_client / 401 / 4xx desconocido     | auth_definitive   | humano          |
 * | refresh: red / timeout / 5xx / 429 / sin JSON / temporarily_unavail.| transient         | backoff (auto)  |
 * | insufficientPermissions, youtubeSignupRequired, channel*, authent.* | permission        | humano          |
 * |   forbiddenPrivacySetting, … o 403 con reason DESCONOCIDO           |                   |                 |
 * | forbidden (403) o 401/403 SIN reason                                | auth_uncertain    | sonda 5m/30m/2h |
 * | init: 5xx / 429 / red / sin Location                                | transient         | backoff (auto)  |
 * | init: otro 4xx (invalidTitle, mediaBodyRequired, desconocido…)      | rejected          | humano          |
 * | upload: 5xx explícito                                               | transient         | (status query)  |
 * | upload/status: corte, timeout, 2xx sin id, otro 4xx                 | ambiguous         | status query o humano |
 * | status: 404/410                                                     | session_expired   | worker decide   |
 * Sin error estructurado (fakes viejos / errores locales) → la clasificación gruesa de siempre, con auth = humano.
 */
export type YoutubeFailureKind =
  | 'quota_project'
  | 'quota_channel'
  | 'rate_limited'
  | 'transient'
  | 'auth_definitive'
  | 'auth_uncertain'
  | 'permission'
  | 'rejected'
  | 'session_expired'
  | 'session_mismatch'
  | 'session_persist'
  | 'ambiguous'
  | 'download';

export interface YoutubeFailureDecision {
  kind: YoutubeFailureKind;
  /** Error estructurado (null si la excepción no lo trae). */
  info: YoutubeApiErrorInfo | null;
  /** ¿Necesita a un humano (no hay estrategia automática segura)? */
  human: boolean;
}

export const YOUTUBE_PERMISSION_REASONS: readonly string[] = Object.freeze([
  'insufficientPermissions', 'youtubeSignupRequired', 'channelClosed', 'channelNotFound', 'channelSuspended',
  'authenticatedUserNotChannel', 'authenticatedUserAccountClosed', 'authenticatedUserAccountSuspended',
  'accountDelegationForbidden', 'insufficientCapabilities', 'cmsUserAccountNotFound', 'forbiddenPrivacySetting',
  'forbiddenLicenseSetting',
]);
const RATE_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];
const HUMAN_KINDS: readonly YoutubeFailureKind[] = ['auth_definitive', 'permission', 'rejected', 'session_mismatch'];

function decision(kind: YoutubeFailureKind, info: YoutubeApiErrorInfo | null): YoutubeFailureDecision {
  return { kind, info, human: HUMAN_KINDS.includes(kind) };
}

/** r67 (B2): decisión por reason para un error estructurado (pura). */
export function classifyYoutubeErrorInfo(info: YoutubeApiErrorInfo): YoutubeFailureKind {
  const reason = info.reason ?? '';
  const st = info.httpStatus;
  if (reason === 'quotaExceeded') return 'quota_project';
  if (reason === 'uploadLimitExceeded') return 'quota_channel';
  if (RATE_REASONS.includes(reason)) return 'rate_limited';
  if (info.phase === 'refresh') return isTransientRefreshFailure(info) ? 'transient' : 'auth_definitive';
  if (YOUTUBE_PERMISSION_REASONS.includes(reason)) return 'permission';
  if (st === 401 || st === 403) {
    if (reason === 'forbidden' || reason === '' || reason === 'authError' || reason === 'authorizationRequired') return 'auth_uncertain';
    return 'permission';
  }
  if (info.phase === 'channel') {
    if (reason === 'network' || reason === 'timeout' || reason === 'non_json' || (typeof st === 'number' && st >= 500)) return 'transient';
    return 'auth_uncertain';
  }
  if (info.phase === 'status' && (st === 404 || st === 410)) return 'session_expired';
  if (info.phase === 'init') {
    if (st === null || st >= 500 || st === 429 || reason === 'no_location') return 'transient';
    return 'rejected';
  }
  if (info.phase === 'upload' && typeof st === 'number' && st >= 500) return 'transient';
  return 'ambiguous';
}

/**
 * r67 (B2): clasificación fina de una excepción de `uploadFromUrl` (o del preflight). `contactedYoutube=false` = antes
 * del primer contacto con YouTube (refresh / descarga): nunca es ambiguo.
 */
export function classifyYoutubeFailure(err: unknown, opts: { contactedYoutube: boolean }): YoutubeFailureDecision {
  if (err instanceof YoutubeSessionPersistError) return decision('session_persist', null);
  if (err instanceof YoutubeSessionMismatchError) return decision('session_mismatch', err.youtube);
  if (err instanceof YoutubeSessionExpiredError) return decision('session_expired', err.youtube ?? null);
  const info = youtubeErrorInfoOf(err);
  if (info) {
    const kind = classifyYoutubeErrorInfo(info);
    if (!opts.contactedYoutube && kind === 'ambiguous') return decision('download', info);
    return decision(kind, info);
  }
  const coarse = classifyYoutubeUploadError(err);
  if (!opts.contactedYoutube) {
    if (coarse === 'auth') return decision('auth_definitive', null);
    if (coarse === 'quota') return decision('quota_project', null);
    return decision(coarse === 'transient' ? 'transient' : 'download', null);
  }
  switch (coarse) {
    case 'quota': return decision('quota_project', null);
    case 'auth': return decision('auth_definitive', null);
    case 'download': return decision('download', null);
    case 'transient': return decision('transient', null);
    default: return decision('ambiguous', null);
  }
}
