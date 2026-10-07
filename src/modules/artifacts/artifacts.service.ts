import { ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Artifact } from './entities/artifact.entity';
import { CreateArtifactDto } from './dto/create-artifact.dto';

export interface UploadJsonArtifactInput {
  ownerId: string;
  courseId?: string | null;
  jobId?: string | null;
  type: string;
  filename: string;
  storagePath: string;
  payload: unknown;
  mimeType?: string;
  metadata?: Record<string, any>;
  storageBucket?: string;
  storageProvider?: string;
}

export interface UploadBufferArtifactInput {
  ownerId: string;
  courseId?: string | null;
  jobId?: string | null;
  type: string;
  filename: string;
  storagePath: string;
  buffer: Buffer;
  mimeType: string;
  metadata?: Record<string, any>;
  storageBucket?: string;
  storageProvider?: string;
}

/** Único bucket de artifacts (Storage de Supabase). */
export const ARTIFACT_BUCKETS: readonly string[] = ['cursia-artifacts'];

/**
 * Seguridad (hotfix): ¿el objeto `bucket/storagePath` pertenece a `ownerId`?
 *
 * Convención de TODOS los que escriben en Storage (frontend con RLS `auth.uid()` y workers del backend):
 * `<ownerId>/<courseId>/<carpeta>/<archivo>`. El primer segmento debe ser EXACTAMENTE el dueño y la ruta no puede
 * escapar de su carpeta por ninguna variante: absoluta, `\`, segmentos vacíos, `.`/`..`, codificación `%`, `?`/`#`
 * (cortan la URL de Storage) ni caracteres de control. No se limita el resto de los caracteres (los nombres de
 * archivo legítimos pueden llevar espacios o tildes).
 *
 * Sin este control, `POST /artifacts` registraba la ruta de OTRO usuario y luego `download-url` la firmaba y
 * `DELETE` la borraba con la service role (que ignora RLS): lectura y borrado entre cuentas.
 */
export function storagePathOwnedBy(ownerId: string, bucket: unknown, storagePath: unknown): boolean {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return false;
  if (typeof bucket !== 'string' || !ARTIFACT_BUCKETS.includes(bucket)) return false;
  if (typeof storagePath !== 'string' || storagePath.length === 0 || storagePath.length > 1024) return false;
  if (storagePath.startsWith('/') || /[\\%?#\u0000-\u001f\u007f]/.test(storagePath)) return false;
  const segments = storagePath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return segments.length > 1 && segments[0] === ownerId;
}

/** Vida de una URL firmada: entre 1 minuto y 7 días (antes se aceptaba cualquier valor, p. ej. 10 años). */
export function clampSignedUrlSeconds(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 60), 7 * 24 * 3600) : 3600;
}

function notOwned(): ForbiddenException {
  return new ForbiddenException({
    code: 'storage_path_not_owned',
    message: 'storage_path_not_owned: el archivo debe estar en tu carpeta del bucket de artifacts.',
  });
}

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    @InjectRepository(Artifact)
    private readonly artifactRepo: Repository<Artifact>,
    private readonly config: ConfigService,
  ) {}

  // ── CREATE ──────────────────────────────────────────────────────────────────

  async create(dto: CreateArtifactDto, ownerId: string): Promise<Artifact> {
    // Seguridad: solo se registran objetos de la carpeta del propio usuario (también los que suben los workers).
    if (!storagePathOwnedBy(ownerId, dto.storage_bucket ?? 'cursia-artifacts', dto.storage_path)) throw notOwned();
    const artifact = this.artifactRepo.create({
      ownerId,
      courseId:        dto.course_id ?? null,
      jobId:          dto.job_id ?? null,
      type:           dto.type,
      storagePath:    dto.storage_path,
      storageProvider: dto.storage_provider ?? 'supabase',
      storageBucket:  dto.storage_bucket ?? 'cursia-artifacts',
      filename:       dto.filename ?? null,
      mimeType:       dto.mime_type ?? 'application/octet-stream',
      sizeBytes:      dto.size_bytes ?? null,
      checksumSha256: dto.checksum_sha256 ?? null,
      metadata:       dto.metadata ?? {},
    });

    return this.artifactRepo.save(artifact);
  }

  async uploadJsonArtifact(input: UploadJsonArtifactInput): Promise<Artifact> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = input.storageBucket ?? 'cursia-artifacts';
    const provider = input.storageProvider ?? 'supabase';

    if (!supabaseUrl || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side artifact upload');
    }
    // Seguridad: la ruta se valida ANTES de escribir en Storage con la service role (un courseId con `..` no puede
    // plantar un archivo fuera de la carpeta del dueño ni en otro bucket).
    if (!storagePathOwnedBy(input.ownerId, bucket, input.storagePath)) throw notOwned();

    const body = JSON.stringify(input.payload, null, 2);
    const sizeBytes = Buffer.byteLength(body);
    const encodedPath = input.storagePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const uploadUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodedPath}`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': input.mimeType ?? 'application/json',
        'x-upsert': 'true',
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase Storage upload failed: ${response.status} ${errorText}`);
    }

    return this.create(
      {
        course_id: input.courseId ?? null,
        job_id: input.jobId ?? null,
        type: input.type,
        storage_path: input.storagePath,
        storage_provider: provider,
        storage_bucket: bucket,
        filename: input.filename,
        mime_type: input.mimeType ?? 'application/json',
        size_bytes: sizeBytes,
        metadata: input.metadata ?? {},
      },
      input.ownerId,
    );
  }

  async uploadBufferArtifact(input: UploadBufferArtifactInput): Promise<Artifact> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = input.storageBucket ?? 'cursia-artifacts';
    const provider = input.storageProvider ?? 'supabase';

    if (!supabaseUrl || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side artifact upload');
    }
    // Seguridad: la ruta se valida ANTES de escribir en Storage con la service role (un courseId con `..` no puede
    // plantar un archivo fuera de la carpeta del dueño ni en otro bucket).
    if (!storagePathOwnedBy(input.ownerId, bucket, input.storagePath)) throw notOwned();

    const encodedPath = input.storagePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const uploadUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodedPath}`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': input.mimeType,
        'x-upsert': 'true',
      },
      body: input.buffer as unknown as BodyInit,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase Storage upload failed: ${response.status} ${errorText}`);
    }

    return this.create(
      {
        course_id: input.courseId ?? null,
        job_id: input.jobId ?? null,
        type: input.type,
        storage_path: input.storagePath,
        storage_provider: provider,
        storage_bucket: bucket,
        filename: input.filename,
        mime_type: input.mimeType,
        size_bytes: input.buffer.length,
        metadata: input.metadata ?? {},
      },
      input.ownerId,
    );
  }

  // ── FIND ALL ────────────────────────────────────────────────────────────────

  async findAll(
    ownerId: string,
    filters?: { courseId?: string; type?: string; jobId?: string },
  ): Promise<Artifact[]> {
    const qb = this.artifactRepo
      .createQueryBuilder('a')
      .where('a.owner_id = :ownerId', { ownerId })
      .orderBy('a.created_at', 'DESC');

    if (filters?.courseId) {
      qb.andWhere('a.course_id = :courseId', { courseId: filters.courseId });
    }
    if (filters?.type) {
      qb.andWhere('a.type = :type', { type: filters.type });
    }
    if (filters?.jobId) {
      qb.andWhere('a.job_id = :jobId', { jobId: filters.jobId });
    }

    return qb.getMany();
  }

  // ── FIND ONE ────────────────────────────────────────────────────────────────

  async findOne(id: string, ownerId: string): Promise<Artifact> {
    const artifact = await this.artifactRepo.findOne({
      where: { id, ownerId },
    });
    if (!artifact) {
      throw new NotFoundException(`Artifact ${id} not found`);
    }
    return artifact;
  }

  // ── DOWNLOAD URL ────────────────────────────────────────────────────────────

  /**
   * Genera una signed download URL via Supabase Storage REST API.
   * Requiere SUPABASE_SERVICE_ROLE_KEY en el entorno.
   *
   * Si no hay service role key, devuelve la info de storage_path
   * para que el frontend genere la URL con su propio SDK.
   */
  async getDownloadUrl(
    id: string,
    ownerId: string,
    expiresInSeconds = 3600,
  ): Promise<{ url?: string; storagePath: string; bucket: string; method: string }> {
    const artifact = await this.findOne(id, ownerId);
    // Seguridad: se firma SOLO un objeto de la carpeta del dueño de la fila (también filas registradas antes de este
    // control). La service role ignora RLS: este es el único control.
    if (!storagePathOwnedBy(artifact.ownerId, artifact.storageBucket, artifact.storagePath)) {
      this.logger.warn(`getDownloadUrl(${artifact.id}): ruta fuera de la carpeta del dueño; no se firma`);
      throw notOwned();
    }
    expiresInSeconds = clampSignedUrlSeconds(expiresInSeconds);

    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey  = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceKey) {
      // Fallback: frontend will use its own SDK to create signed URL
      this.logger.warn('SUPABASE_SERVICE_ROLE_KEY not configured — returning storage path for frontend-side signing');
      return {
        storagePath: artifact.storagePath,
        bucket:      artifact.storageBucket,
        method:      'frontend',
      };
    }

    // Call Supabase Storage REST API to create signed URL
    const signUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/sign/${artifact.storageBucket}/${artifact.storagePath}`;

    try {
      const response = await fetch(signUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });

      if (!response.ok) {
        const err = await response.text();
        this.logger.error(`Supabase Storage sign failed: ${response.status} ${err}`);
        return {
          storagePath: artifact.storagePath,
          bucket:      artifact.storageBucket,
          method:      'frontend',
        };
      }

      const data = await response.json() as { signedURL?: string };
      const signedPath = data.signedURL;

      if (!signedPath) {
        return {
          storagePath: artifact.storagePath,
          bucket:      artifact.storageBucket,
          method:      'frontend',
        };
      }

      // signedURL is a relative path — prepend Supabase URL
      const fullUrl = signedPath.startsWith('http')
        ? signedPath
        : `${supabaseUrl.replace(/\/$/, '')}/storage/v1${signedPath}`;

      return {
        url:         fullUrl,
        storagePath: artifact.storagePath,
        bucket:      artifact.storageBucket,
        method:      'backend',
      };
    } catch (err) {
      this.logger.error(`Supabase Storage sign error: ${err}`);
      return {
        storagePath: artifact.storagePath,
        bucket:      artifact.storageBucket,
        method:      'frontend',
      };
    }
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────

  /**
   * Elimina el registro de metadata.
   * Opcionalmente intenta borrar el archivo de Supabase Storage
   * (requiere SUPABASE_SERVICE_ROLE_KEY).
   */
  async remove(id: string, ownerId: string): Promise<void> {
    const artifact = await this.findOne(id, ownerId);

    // Try to delete from storage
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey  = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    // Seguridad: el objeto se borra SOLO si está en la carpeta del dueño de la fila; la fila se borra igual.
    const ownedObject = storagePathOwnedBy(artifact.ownerId, artifact.storageBucket, artifact.storagePath);
    if (!ownedObject) this.logger.warn(`remove(${artifact.id}): ruta fuera de la carpeta del dueño; se borra la fila, no el objeto`);
    if (ownedObject && supabaseUrl && serviceKey && artifact.storageProvider === 'supabase') {
      try {
        const deleteUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${artifact.storageBucket}/${artifact.storagePath}`;
        const res = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${serviceKey}` },
        });
        if (!res.ok) {
          this.logger.warn(`Storage delete failed for ${artifact.storagePath}: ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`Storage delete error for ${artifact.storagePath}: ${err}`);
      }
    }

    await this.artifactRepo.remove(artifact);
  }
}
