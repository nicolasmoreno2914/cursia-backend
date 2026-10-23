import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { YoutubeTokenService } from './youtube-token.service';
import { fetchAllowedDownload } from './upload-url-policy';
import { YoutubeConnection } from './entities/youtube-connection.entity';
import { createHash } from 'crypto';
import {
  networkReasonOf,
  parseGoogleErrorBody,
  safeRequestIdOf,
  YoutubeApiErrorInfo,
  youtubeErrorInfo,
  youtubeErrorInfoOf,
  youtubeErrorLogLine,
} from './youtube-api-error';

/**
 * Thrown when YouTube rejects upload due to daily quota or rate limit.
 * Extends ServiceUnavailableException so NestJS HTTP layer returns 503.
 * The worker catches this with instanceof to block the job (quota_blocked).
 *
 * r67 (B1/B2): lleva el error estructurado (`youtube`) y el alcance: `project` (quotaExceeded: cuota del proyecto de
 * GCP) o `channel` (uploadLimitExceeded: límite diario de subidas del CANAL, distinto de la cuota según la doc).
 * `rateLimitExceeded` sigue lanzando esta clase por compatibilidad con el legacy (video-worker), pero el worker dynamic
 * decide por `youtube.reason` (transitorio con backoff), nunca solo por la clase.
 */
export class YoutubeQuotaException extends ServiceUnavailableException {
  constructor(
    public readonly youtube?: YoutubeApiErrorInfo,
    public readonly scope: 'project' | 'channel' = 'project',
  ) {
    super('YouTube no permitió subir más videos por ahora. La cuota diaria se restablece en 24 h.');
    this.name = 'YoutubeQuotaException';
  }
}

/**
 * r67 (B1): rechazo de autorización/permisos de YouTube o del refresh del token (401/403 no-cuota, invalid_grant…).
 * Sigue siendo UnauthorizedException (legacy intacto: 401, `instanceof`); agrega el error estructurado.
 */
export class YoutubeAuthError extends UnauthorizedException {
  constructor(message: string, public readonly youtube: YoutubeApiErrorInfo) {
    super(message);
  }
}

/**
 * DN-1: error de transporte de la subida (5xx, red, timeout, respuesta sin
 * id). Extiende ServiceUnavailableException con el MISMO mensaje de siempre
 * (el legacy lo sigue viendo igual, instanceof incluido); solo agrega en qué
 * fase ocurrió para que el worker dynamic distinga un fallo SIN video creado
 * (`init`, o `upload` con respuesta HTTP 5xx explícita) de uno ambiguo
 * (`upload` sin respuesta, timeout o 2xx sin id: el video puede existir).
 * r67: fases nuevas `refresh` (red/5xx/no-JSON del endpoint OAuth: transitorio, NO auth) y `status` (consulta del
 * estado de una sesión resumable guardada), más el error estructurado `youtube`.
 */
export class YoutubeUploadTransportError extends ServiceUnavailableException {
  constructor(
    message: string,
    public readonly phase: 'init' | 'upload' | 'refresh' | 'status',
    /** Status HTTP de una respuesta de error explícita de YouTube; ausente = sin respuesta (red/timeout) o 2xx sin id. */
    public readonly httpStatus?: number,
    public readonly youtube?: YoutubeApiErrorInfo,
  ) {
    super(message);
    // Nota: Nest (initName) fija `name = 'YoutubeUploadTransportError'`. Nada del
    // legacy depende de `name`: status HTTP, respuesta e `instanceof
    // ServiceUnavailableException` son los mismos de antes.
  }
}

/**
 * r67 (B3): la sesión resumable guardada ya no existe (404/410 al consultar su estado: vencida). La decisión de abrir
 * una sesión NUEVA es del worker (solo sin videoId confirmado y si el estado previo no era ambiguo sin sesión).
 */
export class YoutubeSessionExpiredError extends YoutubeUploadTransportError {
  constructor(youtube: YoutubeApiErrorInfo) {
    super('La sesión de subida a YouTube venció', 'status', youtube.httpStatus ?? undefined, youtube);
  }
}

/** r67 (B3): los bytes del MP4 actual no coinciden con los de la sesión guardada (tamaño/sha): nunca se reanuda. */
export class YoutubeSessionMismatchError extends Error {
  constructor(public readonly youtube: YoutubeApiErrorInfo) {
    super('El MP4 a subir no coincide con el de la sesión de YouTube guardada');
  }
}

/** r67 (B3): el callback del worker no pudo persistir la sesión → se aborta ANTES de enviar bytes (no hay video). */
export class YoutubeSessionPersistError extends Error {
  constructor(public readonly cause?: unknown) {
    super('No se pudo guardar la sesión de subida de YouTube (no se enviaron bytes)');
  }
}

/** r67 (B3): sesión resumable (en memoria; el worker la persiste CIFRADA y nunca la loguea). */
export interface YoutubeResumableSession {
  uri: string;
  bytes: number;
  /** sha256 hex del MP4 de la sesión (no es secreto): un MP4 distinto nunca reanuda esta sesión. */
  sha256: string;
}

/** r67: cómo terminó una subida resumable (auditoría; nunca incluye la URL de sesión). */
export type YoutubeUploadOutcome = 'uploaded' | 'confirmed_existing' | 'resumed';

export const YOUTUBE_RESUMABLE_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
/** r67: rondas máximas consulta-de-estado → reanudar dentro de UNA llamada (cortes repetidos → el worker decide). */
export const YOUTUBE_MAX_RESUME_ROUNDS = 3;

export interface YoutubeUploadOptions {
  downloadUrl:    string;
  /**
   * r58 (SSRF): la URL vino del CLIENTE (POST /youtube/upload-from-url) → se descarga con la política de URLs
   * (upload-url-policy.ts: lista blanca de hosts, solo IPs públicas, redirecciones validadas, errores genéricos).
   * Los workers (URLs del servidor) no lo setean: sin cambio.
   */
  untrustedUrl?:  boolean;
  title:          string;
  description?:   string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  chapterNumber?: number;
  /**
   * DN-1 (opcional; el legacy no lo usa): se invoca DESPUÉS de bajar y validar
   * el MP4 y ANTES del primer contacto con YouTube. El worker dynamic escribe
   * ahí el marcador de subida, así un crash durante la descarga no queda como
   * "subida ambigua". Si lanza, la subida se aborta sin tocar YouTube.
   * V2.1 F2 (aditivo): recibe los bytes del MP4 ya descargado (el worker mide
   * la duración desde la caja `mvhd` ANTES de subir); el legacy no lo usa.
   */
  onBeforeUpload?: (mp4?: Buffer) => Promise<void>;
  /**
   * r67 (B3, opcional; el legacy no lo usa → comportamiento idéntico al de siempre): modo resumable PERSISTENTE.
   * - `onSessionCreated` se invoca después del init y ANTES de enviar el primer byte: el worker guarda la sesión
   *   CIFRADA. Si lanza, se aborta sin enviar bytes (YoutubeSessionPersistError: no hay video).
   * - `session`: sesión guardada de un intento anterior → ANTES de cualquier envío se consulta su estado
   *   (`PUT <uri>` con `Content-Range: bytes * /N`): 200/201 → confirma el videoId (cero re-subida); 308 → reanuda
   *   desde `Range`; 404/410 → YoutubeSessionExpiredError (el worker decide). Nunca abre una sesión nueva sola.
   * - Con el modo activo, un corte del PUT (sin respuesta) o un 5xx dispara una consulta de estado inmediata y la
   *   reanudación (hasta YOUTUBE_MAX_RESUME_ROUNDS), en vez de terminar ambiguo.
   */
  resumable?: {
    session?: YoutubeResumableSession | null;
    onSessionCreated: (session: YoutubeResumableSession) => Promise<void>;
    /** r67: se invoca justo antes de cada PUT con bytes (el worker marca `youtubePutStartedAt`). */
    onBytesSending?: (offset: number) => Promise<void>;
  };
}

export interface YoutubeUploadResult {
  youtubeUrl: string;
  videoId:    string;
  /** r67: solo en modo resumable — cómo se obtuvo el id. */
  outcome?: YoutubeUploadOutcome;
  /** r67: bytes enviados en ESTA llamada (0 = se confirmó una subida previa sin re-subir nada). */
  bytesSent?: number;
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
      throw new YoutubeAuthError(
        'La conexión de YouTube fue revocada. Reconecta en la sección Cuenta.',
        youtubeErrorInfo('refresh', { reason: 'connection_revoked' }),
      );
    }
    if (connection.status === 'reauth_required') {
      throw new YoutubeAuthError(
        'La conexión de YouTube expiró. Reconecta en la sección Cuenta.',
        youtubeErrorInfo('refresh', { reason: 'connection_reauth_required' }),
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
      // r67 (B2): solo un rechazo DEFINITIVO del endpoint OAuth es auth; red / timeout / 5xx / sin JSON es
      // transitorio (antes TODO terminaba en "reconecta tu cuenta"). La decisión fina la toma el worker por `reason`.
      const info = youtubeErrorInfoOf(err) ?? youtubeErrorInfo('refresh', { reason: 'unknown' });
      if (isTransientRefreshFailure(info)) {
        throw new YoutubeUploadTransportError(`No se pudo renovar el token de YouTube (temporal: ${info.reason ?? `HTTP ${info.httpStatus}`})`, 'refresh', info.httpStatus ?? undefined, info);
      }
      throw new YoutubeAuthError(
        `No se pudo renovar el token de YouTube: ${info.reason ?? 'error desconocido'}. ` +
        'Reconecta tu cuenta en la sección Cuenta.',
        info,
      );
    }

    // ── 2. Descargar MP4 desde Videogen ───────────────────────────────────
    this.logger.log(`[YTUpload] Descargando MP4: ${downloadUrl}`);
    let fileBuffer: Buffer;
    if (options.untrustedUrl) {
      const dl = await fetchAllowedDownload(downloadUrl);
      try {
        fileBuffer = Buffer.from(await dl.arrayBuffer());
      } catch {
        throw new BadRequestException('No se pudo descargar el video desde Videogen.');
      }
    } else try {
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

    // Warn on large files — 512 MB is the in-memory buffer ceiling for this worker.
    // Videos generated by AI are typically 20–150 MB (2–5 min, 720p).
    const MAX_BYTES = 512 * 1024 * 1024; // 512 MB
    if (fileSize > MAX_BYTES) {
      throw new BadRequestException(
        `El video es demasiado grande para procesar (${(fileSize / 1024 / 1024).toFixed(0)} MB). ` +
        'Máximo: 512 MB.',
      );
    }

    if (options.onBeforeUpload) await options.onBeforeUpload(fileBuffer);

    // r67 (B3): modo resumable persistente (solo el worker dynamic). Sin él, el flujo legacy de siempre.
    if (options.resumable) {
      return this.resumableUpload(accessToken, fileBuffer, title, description, privacyStatus, options.resumable);
    }

    // ── 3. Iniciar upload resumable en YouTube ────────────────────────────
    this.logger.log(`[YTUpload] Iniciando upload resumable: "${title}" (${privacyStatus})`);
    const uploadUrl = await this.initSession(accessToken, fileSize, title, description, privacyStatus);

    // ── 4. Subir bytes del video ──────────────────────────────────────────
    this.logger.log(`[YTUpload] Subiendo ${fileSize} bytes a YouTube…`);
    const done = await this.putBytes(uploadUrl, accessToken, fileBuffer, 0, false);
    if (done.kind === 'incomplete') {
      // Sin modo resumable un 308 no se reanuda (paridad: el legacy lo trataba como un !ok → fallo de transporte).
      throw new YoutubeUploadTransportError('Fallo al subir video a YouTube: HTTP 308', 'upload', 308, youtubeErrorInfo('upload', { httpStatus: 308, reason: 'incomplete' }));
    }
    if (done.kind === 'error') throw done.error;
    const youtubeUrl = `https://www.youtube.com/watch?v=${done.videoId}`;
    this.logger.log(`[YTUpload] ✅ Video subido: ${youtubeUrl}`);
    return { youtubeUrl, videoId: done.videoId };
  }

  // ─── r67: piezas del protocolo resumable ────────────────────────────────

  /** Clasificación por la RESPUESTA (reason/domain del cuerpo), nunca solo por el status. */
  private errorFromResponse(phase: 'init' | 'upload' | 'status', status: number, text: string, headers: Headers): Error {
    const parsed = parseGoogleErrorBody(text);
    const info = youtubeErrorInfo(phase, { httpStatus: status, reason: parsed.reason, domain: parsed.domain, message: parsed.message, requestId: safeRequestIdOf(headers) });
    this.logger.error(`[YTUpload] respuesta de error de YouTube (${youtubeErrorLogLine(info)})`);
    const reason = info.reason ?? '';
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return new YoutubeQuotaException(info, 'project');
    }
    // r67: la doc lo lista como 400 en videos.insert; se acepta también en cualquier status (p.ej. 403).
    if (reason === 'uploadLimitExceeded') return new YoutubeQuotaException(info, 'channel');
    if (status === 401) {
      return new YoutubeAuthError(
        phase === 'init' ? 'YouTube rechazó el token. Reconecta tu cuenta en la sección Cuenta.' : 'Token expirado durante la subida. Reconecta tu cuenta.',
        info,
      );
    }
    if (status === 403) {
      return new YoutubeAuthError(
        phase === 'init' ? 'YouTube rechazó el acceso. Reconecta tu cuenta en la sección Cuenta.' : 'YouTube rechazó el acceso durante la subida. Reconecta tu cuenta.',
        info,
      );
    }
    if (phase === 'status' && (status === 404 || status === 410)) return new YoutubeSessionExpiredError(info);
    if (phase === 'init') {
      return new YoutubeUploadTransportError(`No se pudo iniciar la subida a YouTube: HTTP ${status}`, 'init', status, info);
    }
    return new YoutubeUploadTransportError(
      phase === 'status' ? `No se pudo consultar el estado de la subida a YouTube: HTTP ${status}` : `Fallo al subir video a YouTube: HTTP ${status}`,
      phase,
      status,
      info,
    );
  }

  private async initSession(accessToken: string, fileSize: number, title: string, description: string, privacyStatus: string): Promise<string> {
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
    let initResp: Response;
    try {
      initResp = await fetch(YOUTUBE_RESUMABLE_INIT_URL, {
        method: 'POST',
        headers: {
          'Authorization':           `Bearer ${accessToken}`,
          'Content-Type':            'application/json; charset=UTF-8',
          'X-Upload-Content-Type':   'video/mp4',
          'X-Upload-Content-Length': String(fileSize),
        },
        body: JSON.stringify(metadata),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const info = youtubeErrorInfo('init', { reason: networkReasonOf(err) });
      this.logger.error(`[YTUpload] init sin respuesta (${youtubeErrorLogLine(info)})`);
      throw new YoutubeUploadTransportError(`No se pudo iniciar la subida a YouTube: ${(err as Error).message}`, 'init', undefined, info);
    }
    if (!initResp.ok) {
      let text = '';
      try { text = await initResp.text(); } catch { /* ignore */ }
      throw this.errorFromResponse('init', initResp.status, text, initResp.headers);
    }
    const location = initResp.headers.get('location');
    if (!location) {
      const info = youtubeErrorInfo('init', { httpStatus: initResp.status, reason: 'no_location', requestId: safeRequestIdOf(initResp.headers) });
      throw new YoutubeUploadTransportError('No se pudo iniciar la subida a YouTube: Location header ausente en respuesta de YouTube', 'init', undefined, info);
    }
    return location;
  }

  /** Respuesta 2xx con el recurso del video → id; sin id → error ambiguo (el video PUEDE existir). */
  private async videoIdFrom(resp: Response, phase: 'upload' | 'status'): Promise<{ ok: true; videoId: string } | { ok: false; error: Error }> {
    let data: Record<string, unknown> | null = null;
    try { data = (await resp.json()) as Record<string, unknown>; } catch { data = null; }
    const id = data && typeof data['id'] === 'string' ? (data['id'] as string) : '';
    if (id) return { ok: true, videoId: id };
    const info = youtubeErrorInfo(phase, { httpStatus: resp.status, reason: 'no_video_id', requestId: safeRequestIdOf(resp.headers) });
    return { ok: false, error: new YoutubeUploadTransportError('Fallo al subir video a YouTube: YouTube no devolvió ID del video', phase, undefined, info) };
  }

  /**
   * PUT de bytes desde `offset`. done = id; incomplete = 308 (reanudable); error = respuesta de error o corte.
   * `cut` = sin respuesta (red/timeout): el servidor pudo haber recibido todo o parte.
   */
  private async putBytes(
    uri: string,
    accessToken: string,
    buf: Buffer,
    offset: number,
    withAuth: boolean,
  ): Promise<{ kind: 'done'; videoId: string } | { kind: 'incomplete'; nextOffset: number } | { kind: 'error'; error: Error; cut: boolean }> {
    const total = buf.length;
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Content-Length': String(total - offset) };
    if (withAuth) headers['Authorization'] = `Bearer ${accessToken}`;
    if (offset > 0) headers['Content-Range'] = `bytes ${offset}-${total - 1}/${total}`;
    let resp: Response;
    try {
      resp = await fetch(uri, {
        method: 'PUT',
        headers,
        // Buffer → Uint8Array — necesario para satisfacer BodyInit sin cast
        body: new Uint8Array(offset > 0 ? buf.subarray(offset) : buf),
        signal: AbortSignal.timeout(600_000),  // 10 min max — videos grandes
      });
    } catch (err) {
      const info = youtubeErrorInfo('upload', { reason: networkReasonOf(err) });
      this.logger.error(`[YTUpload] PUT sin respuesta (${youtubeErrorLogLine(info)})`);
      return { kind: 'error', error: new YoutubeUploadTransportError(`Fallo al subir video a YouTube: ${(err as Error).message}`, 'upload', undefined, info), cut: true };
    }
    if (resp.status === 308) return { kind: 'incomplete', nextOffset: rangeNextOffset(resp.headers.get('range')) };
    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch { /* ignore */ }
      return { kind: 'error', error: this.errorFromResponse('upload', resp.status, text, resp.headers), cut: false };
    }
    const v = await this.videoIdFrom(resp, 'upload');
    if (v.ok === true) return { kind: 'done', videoId: v.videoId };
    return { kind: 'error', error: (v as { ok: false; error: Error }).error, cut: false };
  }

  /** Consulta de estado de una sesión (`PUT` vacío con `Content-Range: bytes * /N`). */
  private async statusQuery(
    uri: string,
    accessToken: string,
    total: number,
  ): Promise<{ kind: 'done'; videoId: string } | { kind: 'incomplete'; nextOffset: number }> {
    let resp: Response;
    try {
      resp = await fetch(uri, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const info = youtubeErrorInfo('status', { reason: networkReasonOf(err) });
      this.logger.error(`[YTUpload] consulta de estado sin respuesta (${youtubeErrorLogLine(info)})`);
      throw new YoutubeUploadTransportError('No se pudo consultar el estado de la subida a YouTube', 'status', undefined, info);
    }
    if (resp.status === 308) return { kind: 'incomplete', nextOffset: rangeNextOffset(resp.headers.get('range')) };
    if (resp.status === 200 || resp.status === 201) {
      const v = await this.videoIdFrom(resp, 'status');
      if (v.ok === true) return { kind: 'done', videoId: v.videoId };
      throw (v as { ok: false; error: Error }).error;
    }
    let text = '';
    try { text = await resp.text(); } catch { /* ignore */ }
    throw this.errorFromResponse('status', resp.status, text, resp.headers);
  }

  /**
   * r67 (B3): subida resumable con sesión PERSISTIDA por el worker. Invariantes:
   * - con sesión guardada SIEMPRE se consulta el estado antes de enviar un byte; nunca se abre una sesión nueva acá;
   * - sin sesión: init → `onSessionCreated` (persistida cifrada) → recién ahí el primer PUT;
   * - corte del PUT o 5xx/308 → consulta de estado → reanudar desde `Range` (acotado); 201 → confirmar el id.
   */
  private async resumableUpload(
    accessToken: string,
    buf: Buffer,
    title: string,
    description: string,
    privacyStatus: string,
    r: NonNullable<YoutubeUploadOptions['resumable']>,
  ): Promise<YoutubeUploadResult> {
    const total = buf.length;
    const sha = createHash('sha256').update(buf).digest('hex');
    let uri: string;
    let offset = 0;
    let bytesSent = 0;
    let resumedFromSaved = false;
    if (r.session) {
      if (r.session.bytes !== total || r.session.sha256 !== sha) {
        throw new YoutubeSessionMismatchError(youtubeErrorInfo('status', { reason: 'session_mismatch' }));
      }
      uri = r.session.uri;
      this.logger.log(`[YTUpload] Consultando el estado de la sesión guardada (${total} bytes)`);
      const st = await this.statusQuery(uri, accessToken, total);
      if (st.kind === 'done') {
        this.logger.log('[YTUpload] ✅ La subida anterior ya había terminado: se confirma el video sin volver a subir');
        return { videoId: st.videoId, youtubeUrl: `https://www.youtube.com/watch?v=${st.videoId}`, outcome: 'confirmed_existing', bytesSent: 0 };
      }
      offset = st.nextOffset;
      resumedFromSaved = true;
    } else {
      this.logger.log(`[YTUpload] Iniciando upload resumable: "${title}" (${privacyStatus})`);
      uri = await this.initSession(accessToken, total, title, description, privacyStatus);
      try {
        await r.onSessionCreated({ uri, bytes: total, sha256: sha });
      } catch (err) {
        throw new YoutubeSessionPersistError(err);
      }
    }

    let lastError: Error | null = null;
    for (let round = 0; round <= YOUTUBE_MAX_RESUME_ROUNDS; round++) {
      if (offset >= total) {
        // Todo recibido pero sin recurso: solo la consulta de estado puede devolver el id.
        const st = await this.statusQuery(uri, accessToken, total);
        if (st.kind === 'done') return { videoId: st.videoId, youtubeUrl: `https://www.youtube.com/watch?v=${st.videoId}`, outcome: 'resumed', bytesSent };
        offset = st.nextOffset;
        if (offset >= total) break;
      }
      if (r.onBytesSending) await r.onBytesSending(offset);
      this.logger.log(`[YTUpload] Subiendo ${total - offset} bytes a YouTube (desde ${offset})…`);
      const res = await this.putBytes(uri, accessToken, buf, offset, true);
      bytesSent += total - offset;
      if (res.kind === 'done') {
        const outcome: YoutubeUploadOutcome = resumedFromSaved || round > 0 ? 'resumed' : 'uploaded';
        this.logger.log(`[YTUpload] ✅ Video subido (${outcome})`);
        return { videoId: res.videoId, youtubeUrl: `https://www.youtube.com/watch?v=${res.videoId}`, outcome, bytesSent };
      }
      if (res.kind === 'incomplete') {
        offset = res.nextOffset;
        continue;
      }
      // Error: solo un corte (sin respuesta) o un 5xx explícito justifican consultar el estado y reanudar.
      const st5xx = res.error instanceof YoutubeUploadTransportError && typeof res.error.httpStatus === 'number' && res.error.httpStatus >= 500;
      if (!res.cut && !st5xx) throw res.error;
      lastError = res.error;
      const st = await this.statusQuery(uri, accessToken, total);
      if (st.kind === 'done') {
        this.logger.log('[YTUpload] ✅ La respuesta se perdió pero la subida terminó: se confirma el video sin volver a subir');
        return { videoId: st.videoId, youtubeUrl: `https://www.youtube.com/watch?v=${st.videoId}`, outcome: 'resumed', bytesSent };
      }
      offset = st.nextOffset;
    }
    throw lastError ?? new YoutubeUploadTransportError('Fallo al subir video a YouTube: la sesión no terminó tras reanudar', 'upload', undefined,
      youtubeErrorInfo('upload', { reason: 'resume_rounds_exhausted' }));
  }
}

/**
 * r67 (B2): fallo TRANSITORIO del refresh (no es auth): sin respuesta (red/timeout), 5xx, 429, cuerpo no JSON, 2xx sin
 * access_token, o los `error` de OAuth que indican indisponibilidad (`temporarily_unavailable`, `server_error`).
 * Todo lo demás (invalid_grant, invalid_client, 400/401 con otro `error`, desconocido) → definitivo (conservador).
 */
export function isTransientRefreshFailure(info: YoutubeApiErrorInfo): boolean {
  const r = info.reason ?? '';
  if (['network', 'timeout', 'non_json', 'no_access_token', 'temporarily_unavailable', 'server_error'].includes(r)) return true;
  const st = info.httpStatus;
  if (typeof st === 'number' && (st >= 500 || st === 429)) return r !== 'invalid_grant';
  return false;
}

/** r67: `Range: bytes=0-999` → 1000; sin Range → 0 (no se recibió nada). Valor inválido → 0 (reenvía todo, contiguo). */
export function rangeNextOffset(range: string | null | undefined): number {
  const m = /bytes=(\d+)-(\d+)/.exec(String(range ?? ''));
  if (!m) return 0;
  const end = Number(m[2]);
  return Number.isFinite(end) && end >= 0 ? end + 1 : 0;
}

export { youtubeErrorInfoOf };
