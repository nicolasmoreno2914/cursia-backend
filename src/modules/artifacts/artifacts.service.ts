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
  /** I1: false para paths inmutables por-intento (nunca sobreescribir). Default true (comportamiento legacy). */
  upsert?: boolean;
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
  /** M9 (fase5b-audit integral-review.md): false para paths inmutables por-contenido
   *  (p.ej. dynamic_mbz, con el hash de sus fuentes en el path). Default true
   *  (comportamiento legacy) — mismo patrón que UploadJsonArtifactInput.upsert. */
  upsert?: boolean;
  /**
   * I2 (review-it2): solo con `upsert:false` sobre un path direccionado por
   * contenido. Si Storage responde "already exists" (un intento previo subió
   * el objeto pero murió antes de insertar el row de `artifacts`), se verifica
   * que el objeto exista (HEAD, tamaño > 0) y se crea el row apuntando a él en
   * vez de fallar para siempre. Si no se puede verificar, se lanza el error
   * original del upload. Default false (comportamiento previo).
   */
  adoptExistingOnConflict?: boolean;
}

/**
 * Supabase Storage responde a un POST con `x-upsert:false` sobre un objeto
 * existente con HTTP 400 y body `{"statusCode":"409","error":"Duplicate",…}`
 * (versiones más nuevas pueden responder 409 directo).
 */
export function isStorageDuplicateResponse(status: number, body: string): boolean {
  if (status === 409) return true;
  if (status !== 400) return false;
  return /"statusCode"\s*:\s*"?409"?/.test(body) || /\bDuplicate\b/i.test(body) || /already exists/i.test(body);
}

/**
 * Headers para llamar a Supabase (Storage REST) con la clave de servicio.
 * Las claves nuevas de Supabase (`sb_secret_…`) no son JWT y el gateway solo
 * las reconoce en el header `apikey`; con solo `Authorization: Bearer` la
 * firma/subida falla (hallazgo de la aceptación real de Fase 5A en staging:
 * getDownloadUrl caía a method='frontend' y el worker de video no podía leer
 * el contenido). Enviar ambos headers es válido también para la clave
 * clásica (JWT service_role), así que el comportamiento con claves JWT no
 * cambia.
 */
export function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
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
        ...supabaseServiceHeaders(serviceKey),
        'Content-Type': input.mimeType ?? 'application/json',
        'x-upsert': input.upsert === false ? 'false' : 'true',
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
    const bucket = input.storageBucket ?? 'cursia-artifacts';
    const provider = input.storageProvider ?? 'supabase';
    const put = await this.putStorageObject(input);
    const metadata = put.adopted ? { ...(input.metadata ?? {}), adoptedExistingObject: true } : input.metadata ?? {};
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
        size_bytes: put.sizeBytes,
        metadata,
      },
      input.ownerId,
    );
  }

  /**
   * Solo la subida a Storage (sin fila en `artifacts`): la usan quienes crean
   * la fila ellos mismos dentro de su propia transacción/lock (p.ej. el
   * reporte de coherencia, fix wave M4). Misma semántica de `upsert` y de
   * adopción de un objeto inmutable preexistente que `uploadBufferArtifact`.
   */
  async putStorageObject(
    input: Pick<UploadBufferArtifactInput, 'storagePath' | 'buffer' | 'mimeType' | 'storageBucket' | 'upsert' | 'adoptExistingOnConflict'>,
  ): Promise<{ sizeBytes: number; adopted: boolean }> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = input.storageBucket ?? 'cursia-artifacts';

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
        ...supabaseServiceHeaders(serviceKey),
        'Content-Type': input.mimeType,
        'x-upsert': input.upsert === false ? 'false' : 'true',
      },
      body: input.buffer as unknown as BodyInit,
    });

    if (response.ok) return { sizeBytes: input.buffer.length, adopted: false };
    const errorText = await response.text();
    const uploadError = new Error(`Supabase Storage upload failed: ${response.status} ${errorText}`);
    if (!(input.adoptExistingOnConflict && input.upsert === false && isStorageDuplicateResponse(response.status, errorText))) {
      throw uploadError;
    }
    // I2: el objeto inmutable ya existe (crash entre Storage y el row) —
    // se adopta solo si se puede verificar que está ahí y no está vacío.
    const existingSize = await this.headStorageObjectSize(supabaseUrl, serviceKey, bucket, encodedPath);
    if (existingSize === null || existingSize <= 0) {
      this.logger.error(
        `uploadBufferArtifact: ${input.storagePath} reporta "already exists" pero no se pudo verificar el objeto (size=${existingSize}) — no se adopta`,
      );
      throw uploadError;
    }
    this.logger.warn(
      `uploadBufferArtifact: ${input.storagePath} ya existía en Storage (${existingSize} bytes) sin row en artifacts — se adopta el objeto existente`,
    );
    return { sizeBytes: existingSize, adopted: true };
  }

  /** Tamaño (content-length) de un objeto de Storage vía HEAD autenticado; null si no existe o no se pudo leer. */
  private async headStorageObjectSize(supabaseUrl: string, serviceKey: string, bucket: string, encodedPath: string): Promise<number | null> {
    const headUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/authenticated/${bucket}/${encodedPath}`;
    try {
      const res = await fetch(headUrl, { method: 'HEAD', headers: supabaseServiceHeaders(serviceKey) });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length'));
      return Number.isFinite(len) ? len : null;
    } catch (err) {
      this.logger.warn(`headStorageObjectSize: HEAD falló para ${bucket}/${encodedPath}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
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
          ...supabaseServiceHeaders(serviceKey),
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
    // Fase 8: una fila "carried" (REUSE) apunta a la MISMA storage_path
    // inmutable que la fila histórica de la que salió. Borrar una fila nunca
    // debe borrar el objeto que otra fila sigue usando.
    //
    // Fix wave I2 (carrera con el apply fromRun): en UNA transacción se
    // bloquea la fila (FOR UPDATE: espera a un apply que la tenga bloqueada
    // mientras inserta su copia), se bloquean y cuentan las demás filas con la
    // misma ruta y se borra la fila. El objeto de Storage se borra recién
    // DESPUÉS del commit y solo si nadie más lo referenciaba. Un apply que
    // llegue después ve la fila borrada y falla con 409 (nunca copia una fila
    // cuyo objeto se va a borrar).
    const qr = this.artifactRepo.manager.connection.createQueryRunner();
    let row: any;
    let sharedWith = 0;
    await qr.connect();
    try {
      await qr.startTransaction();
      [row] = await qr.query(`select * from public.artifacts where id = $1 and owner_id = $2 for update`, [id, ownerId]);
      if (!row) throw new NotFoundException(`Artifact ${id} not found`);
      const sharers = await qr.query(
        `select id from public.artifacts where storage_bucket = $1 and storage_path = $2 and id <> $3 for update`,
        [row.storage_bucket, row.storage_path, row.id],
      );
      sharedWith = sharers.length;
      await qr.query(`delete from public.artifacts where id = $1`, [row.id]);
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }

    if (sharedWith > 0) {
      this.logger.log(`remove(${row.id}): ${sharedWith} fila(s) más usan ${row.storage_path}; se conserva el objeto de Storage`);
      return;
    }
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey  = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && serviceKey && row.storage_provider === 'supabase') {
      try {
        const deleteUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${row.storage_bucket}/${row.storage_path}`;
        const res = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: supabaseServiceHeaders(serviceKey),
        });
        if (!res.ok) {
          this.logger.warn(`Storage delete failed for ${row.storage_path}: ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`Storage delete error for ${row.storage_path}: ${err}`);
      }
    }
  }
}
