/**
 * r74 — medios del curso servidos por Cursia con DIRECCIÓN DURADERA (audiolibro «en línea» de los cursos grandes).
 *
 * Moodle nunca recibe una URL firmada temporal: el label lleva
 *   `${PUBLIC_MEDIA_BASE_URL}/api/v1/media/<artifactId>/<mediaKey>/<archivo>.mp3`
 * y esta ruta pública responde 302 a una URL firmada NUEVA de Supabase Storage (vida `MEDIA_SIGNED_URL_TTL_SECONDS`,
 * default 6 h; el navegador la pide de nuevo en cada reproducción). Así:
 *   - disponibilidad: la dirección no vence; si el objeto se mueve de ruta o de bucket se actualiza la FILA del artifact
 *     (`storage_bucket`/`storage_path`) y la dirección sigue igual;
 *   - control de acceso: dirección de capacidad (artifactId UUID + mediaKey de 256 bits, comparada en tiempo constante);
 *     revocable (`metadata.mediaRevokedAt` → 410) y rotable (nuevo mediaKey) sin tocar el resto del curso;
 *   - retención: el artifact es `dynamic_media_audio` con `metadata.retention = 'course_media'` (nunca lo borra una
 *     limpieza automática; la política de fin de cuenta está en validation/r74-propuesta-…);
 *   - monitoreo: cada dirección rota se registra (`MEDIA_LINK_BROKEN`, con contador en memoria) y
 *     `GET /api/v1/admin/media-links/health` verifica los objetos de un curso (solo SUPER_ADMIN).
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { timingSafeEqual, randomBytes } from 'crypto';
import { ArtifactsService } from '../artifacts/artifacts.service';

export const DYNAMIC_MEDIA_AUDIO_TYPE = 'dynamic_media_audio';
export const PUBLIC_MEDIA_BASE_URL_ENV = 'PUBLIC_MEDIA_BASE_URL';
export const MEDIA_SIGNED_URL_TTL_ENV = 'MEDIA_SIGNED_URL_TTL_SECONDS';
export const MEDIA_LINK_BROKEN = 'MEDIA_LINK_BROKEN';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^[a-z0-9_.-]{1,120}\.mp3$/;

export function newMediaKey(): string {
  return randomBytes(32).toString('hex');
}

/** Base pública (https, sin barra final) o null si no está configurada (entonces no se ofrece la entrega en línea). */
export function publicMediaBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env[PUBLIC_MEDIA_BASE_URL_ENV] ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw)) throw new Error(`${PUBLIC_MEDIA_BASE_URL_ENV} inválida: "${raw}" (https://host, sin ruta)`);
  return raw;
}

export function mediaLinkUrl(base: string, artifactId: string, mediaKey: string, filename: string): string {
  if (!UUID_RE.test(artifactId) || !KEY_RE.test(mediaKey) || !FILE_RE.test(filename)) throw new Error('mediaLinkUrl: datos inválidos');
  return `${base}/api/v1/media/${artifactId}/${mediaKey}/${filename}`;
}

export type MediaResolution =
  | { ok: true; url: string; ttlSeconds: number }
  | { ok: false; status: 404 | 410 | 503; code: string };

@Injectable()
export class CourseMediaService {
  private readonly logger = new Logger('CourseMedia');
  /** Direcciones rotas vistas desde el arranque (monitoreo simple; el log lleva el detalle). */
  readonly brokenCounts = new Map<string, number>();

  constructor(private readonly dataSource: DataSource, private readonly artifacts: ArtifactsService) {}

  private broken(artifactId: string, why: string): void {
    const k = `${artifactId}:${why}`;
    this.brokenCounts.set(k, (this.brokenCounts.get(k) ?? 0) + 1);
    this.logger.warn(`${MEDIA_LINK_BROKEN}: ${artifactId} ${why}`);
  }

  async resolve(artifactId: string, mediaKey: string, filename: string): Promise<MediaResolution> {
    if (!UUID_RE.test(artifactId) || !KEY_RE.test(mediaKey) || !FILE_RE.test(filename)) return { ok: false, status: 404, code: 'MEDIA_LINK_NOT_FOUND' };
    const [row] = await this.dataSource.query(
      `select id, owner_id, filename, metadata from public.artifacts where id = $1 and type = $2`,
      [artifactId, DYNAMIC_MEDIA_AUDIO_TYPE],
    );
    const meta = row?.metadata ?? {};
    const stored = typeof meta.mediaKey === 'string' && KEY_RE.test(meta.mediaKey) ? Buffer.from(meta.mediaKey, 'hex') : null;
    const given = Buffer.from(mediaKey, 'hex');
    if (!row || !stored || stored.length !== given.length || !timingSafeEqual(stored, given) || row.filename !== filename) {
      this.broken(artifactId, 'not_found');
      return { ok: false, status: 404, code: 'MEDIA_LINK_NOT_FOUND' };
    }
    if (meta.mediaRevokedAt) {
      this.broken(artifactId, 'revoked');
      return { ok: false, status: 410, code: 'MEDIA_LINK_REVOKED' };
    }
    const ttl = Math.min(Math.max(Number(process.env[MEDIA_SIGNED_URL_TTL_ENV]) || 21600, 300), 86400);
    try {
      const { url } = await this.artifacts.getDownloadUrl(row.id, String(row.owner_id), ttl);
      if (!url) {
        this.broken(artifactId, 'sign_empty');
        return { ok: false, status: 503, code: 'MEDIA_LINK_UNAVAILABLE' };
      }
      return { ok: true, url, ttlSeconds: ttl };
    } catch (err) {
      this.broken(artifactId, `sign_failed:${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      return { ok: false, status: 503, code: 'MEDIA_LINK_UNAVAILABLE' };
    }
  }

  /** SUPER_ADMIN: verifica que cada medio de un curso (o de todos, con límite) siga existiendo en Storage. */
  async health(courseId: string | null, limit = 200): Promise<{ checked: number; ok: number; broken: Array<{ artifactId: string; courseId: string; reason: string }>; seenBroken: Record<string, number> }> {
    const rows: Array<{ id: string; course_id: string; storage_bucket: string; storage_path: string; metadata: any }> = await this.dataSource.query(
      `select id, course_id, storage_bucket, storage_path, metadata from public.artifacts
        where type = $1 and ($2::text is null or course_id::text = $2::text) order by created_at desc limit $3`,
      [DYNAMIC_MEDIA_AUDIO_TYPE, courseId, Math.min(Math.max(limit, 1), 1000)],
    );
    const broken: Array<{ artifactId: string; courseId: string; reason: string }> = [];
    for (const r of rows) {
      if (r.metadata?.mediaRevokedAt) continue;
      const size = await this.artifacts.headStorageObjectBytes(r.storage_bucket, r.storage_path).catch(() => null);
      if (size === null || size <= 0) broken.push({ artifactId: r.id, courseId: String(r.course_id), reason: size === null ? 'missing_object' : 'empty_object' });
      else if (Number(r.metadata?.bytes) > 0 && Number(r.metadata.bytes) !== size) broken.push({ artifactId: r.id, courseId: String(r.course_id), reason: `size_mismatch:${size}` });
    }
    for (const b of broken) this.logger.warn(`${MEDIA_LINK_BROKEN}: health ${b.artifactId} ${b.reason}`);
    return { checked: rows.length, ok: rows.length - broken.length, broken, seenBroken: Object.fromEntries(this.brokenCounts) };
  }
}
