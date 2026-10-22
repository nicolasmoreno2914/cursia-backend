import { createHash } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// r67 (B1) — error ESTRUCTURADO de la YouTube Data API / OAuth de Google.
//
// Toda rama de error del refresh, del init resumable, del PUT de bytes, de la consulta de estado de la sesión y del
// channels.list lleva un `YoutubeApiErrorInfo` con SOLO campos estructurados y saneados:
//   phase      refresh | init | upload | status | channel
//   httpStatus status HTTP de la respuesta (null = sin respuesta: red / timeout)
//   reason     `error.errors[0].reason` (Data API) o `error` (endpoint OAuth), o un motivo local
//              (`network`, `timeout`, `non_json`, `no_access_token`, `no_location`, `no_video_id`…)
//   domain     `error.errors[0].domain` (Data API) o null
//   message    texto del proveedor TRUNCADO y SANEADO (sin tokens, sin URLs, sin cadenas largas tipo token)
//   requestId  hash corto (sha256, 16 hex) de `x-guploader-uploadid` si vino: el valor crudo puede coincidir con el
//              `upload_id` de la URL de sesión (una capacidad), así que NUNCA se guarda en claro.
// Nunca contiene el access/refresh token, la URL de sesión ni cabeceras de autorización.
// ─────────────────────────────────────────────────────────────────────────────

export type YoutubeApiPhase = 'refresh' | 'init' | 'upload' | 'status' | 'channel';

export interface YoutubeApiErrorInfo {
  phase: YoutubeApiPhase;
  httpStatus: number | null;
  reason: string | null;
  domain: string | null;
  message: string | null;
  requestId: string | null;
}

/** r67: portador genérico del error estructurado (lo lanza el refresh del token; el upload usa sus propias clases). */
export class YoutubeApiError extends Error {
  constructor(public readonly youtube: YoutubeApiErrorInfo, message?: string) {
    super(message ?? `YouTube ${youtube.phase}: ${youtube.reason ?? (youtube.httpStatus ? `HTTP ${youtube.httpStatus}` : 'error')}`);
    this.name = 'YoutubeApiError';
  }
}

const MAX_MESSAGE = 200;

/**
 * r67: sanea texto del proveedor para persistirlo o loguearlo. Quita: cabeceras/valores `Bearer …`, access tokens de
 * Google (`ya29.…`), refresh tokens (`1//…`), cualquier URL (la de sesión trae `upload_id`), parámetros
 * `upload_id=`/`access_token=`/`refresh_token=`/`client_secret=` y cualquier cadena larga sin espacios con pinta de token.
 */
export function sanitizeProviderText(raw: unknown, max = MAX_MESSAGE): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw);
  s = s.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]');
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
  s = s.replace(/\b(upload_id|access_token|refresh_token|client_secret|code|token)=([^&\s"']+)/gi, '$1=[redacted]');
  s = s.replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]');
  s = s.replace(/1\/\/[A-Za-z0-9._-]+/g, '[redacted]');
  s = s.replace(/[A-Za-z0-9_\-+/=.]{40,}/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** r67: id de petición seguro (hash corto) a partir de `x-guploader-uploadid`; null si no vino. */
export function safeRequestIdOf(headers: { get(name: string): string | null } | null | undefined): string | null {
  const raw = headers?.get?.('x-guploader-uploadid') ?? null;
  if (!raw) return null;
  return createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
}

/**
 * r67: extrae `reason`/`domain`/`message` del cuerpo de error de Google. Data API: `{error:{code,message,errors:[{reason,
 * domain,message}]}}`; endpoint OAuth: `{error:'invalid_grant', error_description:'…'}`. Cuerpo no JSON → todo null
 * salvo `nonJson=true`.
 */
export function parseGoogleErrorBody(text: string | null | undefined): { reason: string | null; domain: string | null; message: string | null; nonJson: boolean } {
  const t = String(text ?? '');
  if (!t.trim()) return { reason: null, domain: null, message: null, nonJson: false };
  let body: any;
  try {
    body = JSON.parse(t);
  } catch {
    return { reason: null, domain: null, message: sanitizeProviderText(t), nonJson: true };
  }
  if (body && typeof body.error === 'string') {
    return { reason: body.error.slice(0, 64), domain: 'oauth2', message: sanitizeProviderText(body.error_description ?? null), nonJson: false };
  }
  const e = body?.error;
  const first = Array.isArray(e?.errors) ? e.errors[0] : null;
  const reason = typeof first?.reason === 'string' ? first.reason.slice(0, 64) : null;
  const domain = typeof first?.domain === 'string' ? first.domain.slice(0, 64) : null;
  const message = sanitizeProviderText(first?.message ?? e?.message ?? null);
  return { reason, domain, message, nonJson: false };
}

export function youtubeErrorInfo(
  phase: YoutubeApiPhase,
  o: { httpStatus?: number | null; reason?: string | null; domain?: string | null; message?: unknown; requestId?: string | null } = {},
): YoutubeApiErrorInfo {
  return {
    phase,
    httpStatus: typeof o.httpStatus === 'number' ? o.httpStatus : null,
    reason: o.reason ?? null,
    domain: o.domain ?? null,
    message: sanitizeProviderText(o.message ?? null),
    requestId: o.requestId ?? null,
  };
}

/** r67: motivo local de un error de red (`timeout` si fue el AbortSignal.timeout; si no, `network`). */
export function networkReasonOf(err: unknown): 'timeout' | 'network' {
  const name = (err as any)?.name ?? '';
  const cause = (err as any)?.cause?.name ?? '';
  return name === 'TimeoutError' || cause === 'TimeoutError' || /timeout|aborted/i.test(String((err as any)?.message ?? '')) ? 'timeout' : 'network';
}

/** r67: el error estructurado de cualquier excepción de YouTube (o null si no lo trae). */
export function youtubeErrorInfoOf(err: unknown): YoutubeApiErrorInfo | null {
  const y = (err as any)?.youtube;
  if (y && typeof y === 'object' && typeof y.phase === 'string') return y as YoutubeApiErrorInfo;
  return null;
}

/** r67: línea de log estructurada (nunca token, URL de sesión ni cabeceras). */
export function youtubeErrorLogLine(info: YoutubeApiErrorInfo): string {
  return (
    `phase=${info.phase} http=${info.httpStatus ?? 'none'} reason=${info.reason ?? 'none'} domain=${info.domain ?? 'none'}` +
    `${info.requestId ? ` requestId=${info.requestId}` : ''}${info.message ? ` message="${info.message.replace(/"/g, "'")}"` : ''}`
  );
}
