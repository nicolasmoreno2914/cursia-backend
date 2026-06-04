import { Injectable, NotFoundException, Logger } from '@nestjs/common';
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

    if (supabaseUrl && serviceKey && artifact.storageProvider === 'supabase') {
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
