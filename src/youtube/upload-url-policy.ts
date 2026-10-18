import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * r58 (AU3 §J6, SSRF): `POST /youtube/upload-from-url` descargaba CUALQUIER URL http(s) desde el VPS (localhost, otras
 * apps de pm2, metadata, vhosts de nginx) y el error delataba el estado HTTP (oráculo ciego). Ahora la URL del cliente:
 *   - es https, sin usuario/clave, puerto 443 (o implícito);
 *   - su host está en la lista blanca: el host de SUPABASE_URL (Storage del proyecto: URLs firmadas de artifacts), el de
 *     VIDEOGEN_API_URL (download_url de Videogen) y los de YOUTUBE_UPLOAD_ALLOWED_HOSTS (coma; p.ej. el CDN al que
 *     redirige Videogen). Nunca una IP literal;
 *   - TODAS las direcciones a las que resuelve son públicas (ni privadas, loopback, link-local, CGNAT, ULA, multicast…);
 *   - cada redirección se vuelve a validar igual (máx. 3) y los errores de descarga son genéricos (sin estado HTTP).
 * Los workers (URLs del servidor) no pasan por acá.
 */
export const DOWNLOAD_URL_NOT_ALLOWED = 'download_url_not_allowed';
export const UPLOAD_MAX_REDIRECTS = 3;

export type HostResolver = (host: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function hostOf(raw: string | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try { return new URL(s).hostname.toLowerCase(); } catch { return null; }
}

export function allowedUploadHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = String(env.YOUTUBE_UPLOAD_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hosts = [hostOf(env.SUPABASE_URL), hostOf(env.VIDEOGEN_API_URL), ...extra].filter((h): h is string => !!h);
  return [...new Set(hosts)];
}

/** ¿Dirección IP NO pública? (IPv4 / IPv6, incluidas las IPv4 mapeadas en IPv6). Puro. */
export function isNonPublicAddress(addr: string): boolean {
  const a = String(addr || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v = isIP(a);
  if (v === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isNonPublicAddress(mapped[1]);
    if (a === '::' || a === '::1') return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || /^64:ff9b:/.test(a) || /^2001:db8:/.test(a);
  }
  return true; // no es una IP: nunca se considera pública
}

function deny(reason: string): never {
  throw new BadRequestException({ code: DOWNLOAD_URL_NOT_ALLOWED, message: `${DOWNLOAD_URL_NOT_ALLOWED}: ${reason}` });
}

/** Valida UNA URL (la del cliente o una redirección). Lanza 400 `download_url_not_allowed`. */
export async function assertUploadUrlAllowed(raw: string, opts: { env?: NodeJS.ProcessEnv; resolve?: HostResolver } = {}): Promise<URL> {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return deny('URL inválida'); }
  if (u.protocol !== 'https:') deny('solo https');
  if (u.username || u.password) deny('la URL no puede llevar credenciales');
  if (u.port && u.port !== '443') deny('puerto no permitido');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) deny('no se aceptan IPs literales');
  const allowed = allowedUploadHosts(opts.env ?? process.env);
  if (!allowed.includes(host)) deny('el host no es el almacenamiento de Cursia ni Videogen');
  let addrs: string[];
  try { addrs = await (opts.resolve ?? dnsResolver)(host); } catch { return deny('el host no resuelve'); }
  if (!addrs.length || addrs.some(isNonPublicAddress)) deny('el host resuelve a una dirección no pública');
  return u;
}

/**
 * Descarga con redirecciones MANUALES (cada salto validado). → la respuesta final (2xx). Cualquier fallo → 400 genérico
 * (sin estado HTTP ni detalle de red: no hay oráculo).
 */
export async function fetchAllowedDownload(raw: string, opts: { env?: NodeJS.ProcessEnv; resolve?: HostResolver; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  let url = (await assertUploadUrlAllowed(raw, opts)).toString();
  for (let hop = 0; hop <= UPLOAD_MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
    } catch {
      throw new BadRequestException('No se pudo descargar el video desde Videogen.');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === UPLOAD_MAX_REDIRECTS) throw new BadRequestException('No se pudo descargar el video desde Videogen.');
      url = (await assertUploadUrlAllowed(new URL(loc, url).toString(), opts)).toString();
      continue;
    }
    if (!res.ok) throw new BadRequestException('No se pudo descargar el video desde Videogen.');
    return res;
  }
  throw new BadRequestException('No se pudo descargar el video desde Videogen.');
}
