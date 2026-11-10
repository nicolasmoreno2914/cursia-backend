import { createHash } from 'crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Artifact } from './entities/artifact.entity';
import { CreateArtifactDto } from './dto/create-artifact.dto';
import { isAdminOnlyPackageArtifact } from '../dynamic-packaging/qa-package';
import { ARTIFACT_TYPE_SERVER_ONLY, LLM_MODES, LLM_MODE_INVALID, isLlmMode, isServerOnlyArtifactType } from './artifact-type-policy';
import {
  StorageOp, isStorageUnavailableError, sanitizeStorageErrorText, storageRequestWithRetry, storageRetryPolicyFromEnv,
} from './storage-resilience';
import { recordStorageFailure, storageBreakerDbOf } from '../reliability/storage-breaker';
// r83: el error tipado de Storage caído (lo usan los workers: TTS, IA, video, empaque).
export { STORAGE_UNAVAILABLE_CODE, StorageUnavailableError, isStorageUnavailableError, isStorageUnavailableMessage } from './storage-resilience';
import { PRACTICE_FILE_INVALID_CODE, PRACTICE_FILE_TYPE, PRACTICE_FILE_UNVERIFIABLE_CODE, practiceFileBytesErrors, practiceFileDeclarationErrors } from './practice-file-attach';

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
  /**
   * r58 (AU1 R1): con `adoptExistingOnConflict`, el objeto existente solo se adopta si sus BYTES son los que
   * se acaban de construir (sha256 igual); si no (un objeto puesto por el dueño en su carpeta, o uno de un
   * build anterior que ya no se verifica) se REEMPLAZA con los bytes construidos y validados — review r1 (I-1): SOLO si
   * ningún row de `artifacts` referencia esa ruta; si alguno la referencia (bytes entregados) → PACKAGE_OBJECT_CONFLICT,
   * nunca se sobrescribe. Lo usa el worker de empaque (`dynamic_mbz`). Default false (adopción de siempre).
   */
  replaceUnverifiedOnConflict?: boolean;
}

/**
 * Review r1 (I-1): el objeto de Storage de una ruta ya referenciada por un artifact tiene otros bytes. Nunca se
 * sobrescribe (bytes entregados); el job falla y se reintenta (el reintento elige una ruta nueva). Clase A.
 */
export const PACKAGE_OBJECT_CONFLICT = 'PACKAGE_OBJECT_CONFLICT';

/** sha256 hex de un buffer (checksum_sha256 de los artifacts que sube el servidor). */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Supabase Storage responde a un POST con `x-upsert:false` sobre un objeto
 * existente con HTTP 400 y body `{"statusCode":"409","error":"Duplicate",…}`
 * (versiones más nuevas pueden responder 409 directo).
 */
/**
 * V2.1 R12 fix round 1 (review G6 I2): valida un storage path ANTES de usarlo
 * para una descarga con service role. Rechaza: vacío, absoluto (`/…`),
 * backslashes, cualquier `%` (encoding: `%2e%2e`, `%2f`…), segmentos vacíos,
 * `.` o `..`, caracteres de control y cualquier carácter fuera de
 * `[A-Za-z0-9._@:+=-]` por segmento. Devuelve los segmentos validados (la URL
 * se arma con encodeURIComponent por segmento).
 */
export function assertSafeStoragePath(storagePath: unknown): string[] {
  const fail = (why: string): never => {
    throw new Error(`STORAGE_PATH_INVALID: ${why} (${JSON.stringify(storagePath)})`);
  };
  if (typeof storagePath !== 'string' || storagePath.length === 0) fail('vacío');
  const p = storagePath as string;
  if (p.length > 1024) fail('demasiado largo');
  if (p.startsWith('/')) fail('absoluto');
  if (p.includes('\\')) fail('backslash');
  if (p.includes('%')) fail('percent-encoding');
  if (/[\u0000-\u001f\u007f]/.test(p)) fail('caracteres de control');
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '') fail('segmento vacío');
    if (s === '.' || s === '..') fail('dot-segment');
    if (!/^[A-Za-z0-9._@:+=-]+$/.test(s)) fail(`segmento con caracteres no permitidos "${s}"`);
  }
  return segments;
}

/** Único bucket de artifacts (LOOP 7 C1: nunca otro bucket desde la API). */
export const ARTIFACT_BUCKETS: readonly string[] = ['cursia-artifacts'];
/** Prefijo de los .mbz de QA internos (`qa-internal/<ownerId>/…`, ver dynamic-packaging/qa-package.ts). */
const QA_PREFIX = 'qa-internal';

/**
 * LOOP 7 (A4 C1): ¿el objeto `bucket/storagePath` pertenece a `ownerId`? Convención de TODOS los writers
 * (frontend con RLS `auth.uid()` y workers): primer segmento = dueño; los .mbz de QA, `qa-internal/<dueño>/…`.
 * `allowMockFixtures`: rutas `mock/…` de fixtures compartidos (solo lectura, nunca borrado).
 */
export function storagePathOwnedBy(ownerId: string, bucket: string, storagePath: unknown, opts: { allowMockFixtures?: boolean } = {}): boolean {
  if (!ownerId || !ARTIFACT_BUCKETS.includes(bucket)) return false;
  let seg: string[];
  try {
    seg = assertSafeStoragePath(storagePath);
  } catch {
    return false;
  }
  if (seg[0] === ownerId && seg.length > 1) return true;
  if (seg[0] === QA_PREFIX && seg[1] === ownerId && seg.length > 2) return true;
  return opts.allowMockFixtures === true && seg[0] === 'mock' && seg.length > 1;
}

/** Tope de vida de una URL firmada (LOOP 7 A4 M1): 1 min – 7 días. */
export function clampSignedUrlSeconds(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 60), 7 * 24 * 3600) : 3600;
}

function storagePathNotOwned(): ForbiddenException {
  return new ForbiddenException({ code: 'storage_path_not_owned', message: 'storage_path_not_owned: el archivo debe estar en tu carpeta del bucket de artifacts.' });
}

/**
 * B2 (hotfix de producción #93 portado a V2): la ruta se valida ANTES de escribir en Storage con la service role,
 * que ignora RLS. Sin esto, `create()` rechazaba la fila pero el objeto ya había quedado escrito: un `courseId` o un
 * nombre con `..`, `%2e`, `\`, otro bucket o la carpeta de otro usuario plantaban un archivo fuera de la carpeta del
 * dueño. Mismo criterio que `create()` (`storagePathOwnedBy`, sin fixtures `mock/…`: nunca se escriben).
 */
export function assertWritableStoragePath(ownerId: string, bucket: string, storagePath: unknown): void {
  if (!storagePathOwnedBy(ownerId, bucket, storagePath)) throw storagePathNotOwned();
}

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

/**
 * Artifact del flujo dynamic (V2): tipo `dynamic_*` (dynamic_content_md,
 * dynamic_video, dynamic_mbz, dynamic_coherence_report_json, …) o vinculado a
 * un item/Manifest. Esos paths son inmutables y pueden estar compartidos por
 * filas "carried" (Fase 8). `null`/ausente en filas legacy.
 */
export function isDynamicArtifactRow(row: { type?: string | null; item_run_id?: string | null; manifest_id?: number | null }): boolean {
  return String(row?.type ?? '').startsWith('dynamic_') || row?.item_run_id != null || row?.manifest_id != null;
}

/**
 * r107 B2 (fix round 3, N2): respuesta HTTP no 2xx de Storage en una descarga con tope, con el STATUS estructurado (y el
 * código de error de Supabase si vino en el cuerpo), para decidir por el número y no por el texto del mensaje (la ruta
 * lleva UUID con dígitos). `notFound`: 404, o 400 con `not_found` / «Object not found» (forma de Supabase Storage).
 */
export const STORAGE_HTTP_ERROR = 'storage_http_error';
export class StorageHttpError extends Error {
  readonly code = STORAGE_HTTP_ERROR;
  constructor(readonly status: number, readonly storageError: string | null, where: string) {
    super(`Supabase Storage download failed: ${status} ${where}`);
    this.name = 'StorageHttpError';
  }
  get notFound(): boolean {
    return this.status === 404 || (this.status === 400 && /not[_ ]?found/i.test(this.storageError ?? ''));
  }
}

/** r107 B2: el .mbz original del Taller (lo registra course-workshop.service) no se borra por DELETE /artifacts/:id. */
export const WORKSHOP_ORIGINAL_ARTIFACT_TYPE = 'workshop_original';
export const ARTIFACT_WORKSHOP_ORIGINAL_IMMUTABLE = 'artifact_workshop_original_immutable';
/** r107 B6: cada versión del Taller tampoco se borra por DELETE /artifacts/:id (D10: el historial es la forma de deshacer). */
export const WORKSHOP_VERSION_ARTIFACT_TYPE = 'workshop_version';
export const ARTIFACT_WORKSHOP_VERSION_IMMUTABLE = 'artifact_workshop_version_immutable';
/** r107 B10: resultado de una regeneración del Taller (pagado y validado): inmutable y solo por las rutas del Taller. */
export const WORKSHOP_REGEN_RESULT_ARTIFACT_TYPE = 'workshop_regen_result';
const WORKSHOP_IMMUTABLE_TYPES: readonly string[] = [WORKSHOP_ORIGINAL_ARTIFACT_TYPE, WORKSHOP_VERSION_ARTIFACT_TYPE, WORKSHOP_REGEN_RESULT_ARTIFACT_TYPE];
/** r107 B6 fix round 1 (P2-5): descarga de archivos del Taller solo por su endpoint, con URL de a lo sumo 5 min. */
export const ARTIFACT_WORKSHOP_DOWNLOAD_VIA_WORKSHOP = 'artifact_workshop_download_via_workshop';
export const WORKSHOP_DOWNLOAD_MAX_SECONDS = 300;

/** r107 (fix P1-1): el objeto de Storage pesa más que el tope de la lectura (nunca se materializa entero). */
export const STORAGE_OBJECT_TOO_LARGE = 'storage_object_too_large';
export class StorageObjectTooLargeError extends Error {
  readonly code = STORAGE_OBJECT_TOO_LARGE;
  constructor(readonly maxBytes: number, readonly seenBytes: number) {
    super(`${STORAGE_OBJECT_TOO_LARGE}: el objeto supera ${maxBytes} bytes (visto: ${seenBytes})`);
    this.name = 'StorageObjectTooLargeError';
  }
}

/**
 * r107 B2 (N2): la descarga del cuerpo superó su plazo (proporcional al tamaño, ver `cappedBodyTimeoutMs`). Distinto de
 * «Storage caído» (StorageUnavailableError, encabezados que no llegan): acá la conexión andaba pero lenta.
 */
export const STORAGE_DOWNLOAD_TIMEOUT = 'storage_download_timeout';
export class StorageDownloadTimeoutError extends Error {
  readonly code = STORAGE_DOWNLOAD_TIMEOUT;
  constructor(readonly timeoutMs: number, readonly receivedBytes: number, readonly expectedBytes: number | null) {
    super(`${STORAGE_DOWNLOAD_TIMEOUT}: el cuerpo no terminó de llegar en ${Math.round(timeoutMs / 1000)} s (recibidos ${receivedBytes}${expectedBytes !== null ? ` de ${expectedBytes}` : ''} bytes)`);
    this.name = 'StorageDownloadTimeoutError';
  }
}

/**
 * r107 B2 (N2): plazo del CUERPO de una descarga con tope: el pedido (timeoutMs, mínimo) o 60 s + 1 s por cada 512 KiB
 * esperados (≥ 4 Mbit/s sostenidos), lo que sea mayor. 300 MB → 11 min, por debajo de los 15 min en que el Taller da por
 * interrumpida una identificación. Antes el cuerpo quedaba atado al presupuesto de reintentos de Storage (100 s).
 */
export function cappedBodyTimeoutMs(expectedBytes: number | null, minMs = 60_000): number {
  const bytes = expectedBytes !== null && Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : 0;
  return Math.max(minMs, 60_000 + Math.ceil(bytes / (512 * 1024)) * 1000);
}

const declaredLength = (res: Response): number | null => {
  const h = res.headers.get('content-length');
  return h !== null && /^\s*\d{1,15}\s*$/.test(h) ? Number(h) : null;
};

/**
 * r107 (fix P1-1): lee el cuerpo de una respuesta en flujo con tope duro sobre los bytes RECIBIDOS. `content-length`
 * mayor que el tope → rechazo sin leer; el flujo que lo pasa → `abort()` + rechazo. Pura sobre `Response` (testeable).
 * r107 B2 (N1): un solo buffer RESERVADO por `content-length` (o por `sizeHint`, p. ej. el tamaño del HEAD) y cada trozo
 * se copia en su lugar: el pico de memoria es ~1× el objeto (antes `Buffer.concat` copiaba con los trozos vivos: 2×).
 * Sin tamaño conocido, o si llegan más bytes que los reservados (el objeto cambió), cae a la lista de trozos. Nada a disco.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  abort: () => void,
  onChunk?: (chunk: Buffer) => void,
  opts: { sizeHint?: number | null } = {},
): Promise<Buffer> {
  const declared = declaredLength(res);
  if (declared !== null && declared > maxBytes) {
    abort();
    try { await res.body?.cancel(); } catch { /* ya abortado */ }
    throw new StorageObjectTooLargeError(maxBytes, declared);
  }
  if (!res.body) return Buffer.alloc(0);
  const hint = declared ?? (typeof opts.sizeHint === 'number' && Number.isSafeInteger(opts.sizeHint) && opts.sizeHint >= 0 && opts.sizeHint <= maxBytes ? opts.sizeHint : null);
  let out: Buffer | null = hint !== null ? Buffer.allocUnsafe(hint) : null;
  let chunks: Buffer[] | null = out ? null : [];
  let seen = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const at = seen;
    seen += chunk.length;
    if (seen > maxBytes) {
      abort();
      try { await reader.cancel(); } catch { /* ya abortado */ }
      throw new StorageObjectTooLargeError(maxBytes, seen);
    }
    if (onChunk) onChunk(chunk);
    if (out) {
      if (seen <= out.length) chunk.copy(out, at);
      else { chunks = [out.subarray(0, at), Buffer.from(chunk)]; out = null; }
    } else {
      chunks!.push(chunk);
    }
  }
  if (out) return seen === out.length ? out : out.subarray(0, seen);
  return Buffer.concat(chunks!, seen);
}

/** Re-review N3: tope del DELETE HTTP a Storage en remove() (ms). */
function storageDeleteTimeoutMs(): number {
  const n = Number(process.env.ARTIFACT_STORAGE_DELETE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
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

  /**
   * `POST /artifacts` (cliente). REVIEW-L7 I4: por la API, SOLO la carpeta propia (`<uid>/…`): nunca `qa-internal/…`
   * (copias de QA, solo SUPER_ADMIN, las registra el backend) ni fixtures compartidos.
   */
  async createFromApi(dto: CreateArtifactDto, ownerId: string): Promise<Artifact> {
    if (String(dto.storage_path ?? '').split('/')[0] !== ownerId) {
      throw new ForbiddenException({ code: 'storage_path_not_owned', message: 'storage_path_not_owned: el archivo debe estar en tu carpeta del bucket de artifacts.' });
    }
    // r58 (AU1 R1): los tipos que solo crea el servidor (paquete .mbz, Gamma, TTS, video, reporte de coherencia)
    // nunca se registran desde el cliente: un `dynamic_mbz` con metadata arbitraria se podía reutilizar como el
    // paquete final del run sin construirlo ni validarlo.
    if (isServerOnlyArtifactType(dto.type)) {
      throw new ForbiddenException({
        code: ARTIFACT_TYPE_SERVER_ONLY,
        message: `${ARTIFACT_TYPE_SERVER_ONLY}: el tipo de artifact ${JSON.stringify(String(dto.type))} lo crea solo el servidor.`,
      });
    }
    // r58 (AU1 R2): procedencia del LLM declarada por el ejecutor / driver (solo real | mock | replay).
    const llmMode = (dto.metadata as Record<string, unknown> | undefined)?.llmMode;
    if (llmMode !== undefined && llmMode !== null && !isLlmMode(llmMode)) {
      throw new BadRequestException({
        code: LLM_MODE_INVALID,
        message: `${LLM_MODE_INVALID}: metadata.llmMode=${JSON.stringify(llmMode).slice(0, 40)} (permitidos: ${LLM_MODES.join(', ')}).`,
      });
    }
    if (String(dto.type ?? '').trim() === PRACTICE_FILE_TYPE) return this.create(await this.verifiedPracticeFileDto(dto), ownerId);
    return this.create(dto, ownerId);
  }

  /**
   * r58 (I4-2): un archivo de trabajo se valida AL ADJUNTARLO (declaración + bytes en Storage: tamaño, sha256 y firma del
   * formato). Antes un archivo dañado o con otra extensión recién fallaba al empaquetar (PRACTICE_FILE_INVALID).
   */
  private async verifiedPracticeFileDto(dto: CreateArtifactDto): Promise<CreateArtifactDto> {
    const decl = practiceFileDeclarationErrors(dto);
    const reject = (errors: string[]) => new BadRequestException({ code: PRACTICE_FILE_INVALID_CODE, message: `${PRACTICE_FILE_INVALID_CODE}: ${errors.join('; ')}`, errors });
    if (decl.length) throw reject(decl);
    let bytes: Buffer;
    try {
      bytes = await this.downloadStorageObject(dto.storage_bucket ?? 'cursia-artifacts', dto.storage_path);
    } catch (err) {
      throw new ServiceUnavailableException({
        code: PRACTICE_FILE_UNVERIFIABLE_CODE,
        message: `${PRACTICE_FILE_UNVERIFIABLE_CODE}: no se pudo leer el archivo subido para verificarlo (${err instanceof Error ? err.message.slice(0, 160) : String(err)}); vuelve a adjuntarlo.`,
      });
    }
    const v = await practiceFileBytesErrors(dto, bytes);
    if (v.errors.length) throw reject(v.errors);
    return { ...dto, checksum_sha256: v.sha256, size_bytes: v.size, metadata: { ...(dto.metadata ?? {}), practiceFileVerified: { sha256: v.sha256, bytes: v.size, rules: 1 } } };
  }

  async create(dto: CreateArtifactDto, ownerId: string): Promise<Artifact> {
    // LOOP 7 (A4 C1): solo se registran objetos DEL dueño en el bucket de artifacts (su carpeta, o la de QA interna
    // `qa-internal/<dueño>/…` que escribe el backend). Antes cualquier ruta ajena quedaba registrada y después se
    // firmaba / borraba con la service role (lectura y borrado entre cuentas).
    const bucket = dto.storage_bucket ?? 'cursia-artifacts';
    assertWritableStoragePath(ownerId, bucket, dto.storage_path);
    const artifact = this.artifactRepo.create({
      ownerId,
      courseId:        dto.course_id ?? null,
      jobId:          dto.job_id ?? null,
      type:           dto.type,
      storagePath:    dto.storage_path,
      storageProvider: dto.storage_provider ?? 'supabase',
      storageBucket:  bucket,
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
    // B2 (#93): validar ANTES de escribir con la service role.
    assertWritableStoragePath(input.ownerId, bucket, input.storagePath);

    const body = JSON.stringify(input.payload, null, 2);
    const sizeBytes = Buffer.byteLength(body);
    const encodedPath = input.storagePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const uploadUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodedPath}`;

    // r83: timeout por intento + reintentos ante 5xx/429/red; agotados → StorageUnavailableError (sin HTML).
    const { response, ambiguousBefore } = await this.storageRequest('upload', Buffer.byteLength(body), (signal) => fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...supabaseServiceHeaders(serviceKey),
        'Content-Type': input.mimeType ?? 'application/json',
        'x-upsert': input.upsert === false ? 'false' : 'true',
      },
      body,
      signal,
    }));

    if (!response.ok) {
      const errorText = await response.text();
      // r83: un 5xx ambiguo pudo haber escrito el objeto; con upsert:false el reintento ve «already exists». Se adopta
      // SOLO si los bytes guardados son exactamente los que se querían subir (sha256).
      const adopted = ambiguousBefore && input.upsert === false && isStorageDuplicateResponse(response.status, errorText)
        && (await this.existingObjectMatches(bucket, input.storagePath, Buffer.from(body, 'utf8')));
      if (!adopted) throw new Error(`Supabase Storage upload failed: ${response.status} ${sanitizeStorageErrorText(errorText)}`);
      this.logger.warn(`uploadJsonArtifact: ${input.storagePath} quedó escrito por un intento ambiguo (5xx/timeout) con los mismos bytes — se adopta`);
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
    // r58 (AU1 R1): el servidor registra el checksum de los bytes que quedaron en Storage (los que subió, o los
    // adoptados si se verificó que son idénticos). Un objeto adoptado sin verificar queda sin checksum (nunca se
    // reutiliza como paquete).
    const checksum = put.sha256 ?? null;
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
        checksum_sha256: checksum ?? undefined,
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
    input: Pick<UploadBufferArtifactInput, 'ownerId' | 'storagePath' | 'buffer' | 'mimeType' | 'storageBucket' | 'upsert' | 'adoptExistingOnConflict' | 'replaceUnverifiedOnConflict'>,
  ): Promise<{ sizeBytes: number; adopted: boolean; sha256: string | null }> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = input.storageBucket ?? 'cursia-artifacts';

    if (!supabaseUrl || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side artifact upload');
    }
    // B2 (#93): validar ANTES de escribir con la service role (también la usa uploadBufferArtifact).
    assertWritableStoragePath(input.ownerId, bucket, input.storagePath);

    const encodedPath = input.storagePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const uploadUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodedPath}`;

    // r83: timeout por intento + reintentos ante 5xx/429/red; agotados → StorageUnavailableError (sin HTML).
    const { response, ambiguousBefore } = await this.storageRequest('upload', input.buffer.length, (signal) => fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...supabaseServiceHeaders(serviceKey),
        'Content-Type': input.mimeType,
        'x-upsert': input.upsert === false ? 'false' : 'true',
      },
      body: input.buffer as unknown as BodyInit,
      signal,
    }));

    const builtSha = sha256Hex(input.buffer);
    if (response.ok) return { sizeBytes: input.buffer.length, adopted: false, sha256: builtSha };
    const errorText = await response.text();
    const uploadError = new Error(`Supabase Storage upload failed: ${response.status} ${sanitizeStorageErrorText(errorText)}`);
    // r83: «already exists» DESPUÉS de un intento ambiguo (5xx/timeout) de esta misma llamada: el objeto probablemente lo
    // escribió ese intento. Se adopta solo con los MISMOS bytes (sha256); si no, sigue el camino de siempre.
    if (ambiguousBefore && input.upsert === false && isStorageDuplicateResponse(response.status, errorText)
      && (await this.existingObjectMatches(bucket, input.storagePath, input.buffer))) {
      this.logger.warn(`putStorageObject: ${input.storagePath} quedó escrito por un intento ambiguo (5xx/timeout) con los mismos bytes — se adopta`);
      return { sizeBytes: input.buffer.length, adopted: true, sha256: builtSha };
    }
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
    if (input.replaceUnverifiedOnConflict) {
      // r58 (AU1 R1): solo se adoptan bytes IDÉNTICOS a los construidos; si no, se reemplazan (nunca se adopta
      // un objeto que nadie verificó como el paquete del run).
      let existingSha: string | null = null;
      let readError: string | null = null;
      try {
        existingSha = sha256Hex(await this.downloadStorageObject(bucket, input.storagePath));
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      if (existingSha === builtSha) {
        this.logger.warn(`uploadBufferArtifact: ${input.storagePath} ya existía con los MISMOS bytes (sha256) — se adopta`);
        return { sizeBytes: existingSize, adopted: true, sha256: builtSha };
      }
      // Review r1 (I-1): NUNCA se pisan bytes que un row de `artifacts` referencia (un paquete entregado). Solo se
      // reemplaza un objeto huérfano (crash entre Storage y el insert, o puesto por el dueño en su carpeta).
      if (await this.isStoragePathReferenced(bucket, input.storagePath)) {
        throw new Error(
          `${PACKAGE_OBJECT_CONFLICT}: ${bucket}/${input.storagePath} ya existe con otros bytes${readError ? ` (no se pudo leer: ${readError})` : ''} y un artifact lo referencia — nunca se sobrescribe`,
        );
      }
      if (readError) this.logger.warn(`uploadBufferArtifact: no se pudo leer ${input.storagePath} para verificarlo (${readError}) — sin row que lo referencie, se reemplaza`);
      this.logger.warn(`uploadBufferArtifact: ${input.storagePath} ya existía con OTROS bytes — se reemplaza con los construidos (PACKAGE_OBJECT_REPLACED)`);
      const { response: replace } = await this.storageRequest('upload', input.buffer.length, (signal) => fetch(uploadUrl, {
        method: 'POST',
        headers: { ...supabaseServiceHeaders(serviceKey), 'Content-Type': input.mimeType, 'x-upsert': 'true' },
        body: input.buffer as unknown as BodyInit,
        signal,
      }));
      if (!replace.ok) throw new Error(`Supabase Storage upload failed: ${replace.status} ${sanitizeStorageErrorText(await replace.text())}`);
      return { sizeBytes: input.buffer.length, adopted: false, sha256: builtSha };
    }
    this.logger.warn(
      `uploadBufferArtifact: ${input.storagePath} ya existía en Storage (${existingSize} bytes) sin row en artifacts — se adopta el objeto existente`,
    );
    return { sizeBytes: existingSize, adopted: true, sha256: null };
  }

  /**
   * r83: una petición a Storage con timeout por intento y reintentos (5xx/429/408/red/timeout) dentro del presupuesto
   * (STORAGE_RETRY_* del entorno). Agotado → registra el fallo en el breaker de Storage (public.infra_health; no-op
   * sin tabla) y relanza el StorageUnavailableError.
   */
  private async storageRequest(
    op: StorageOp,
    bytes: number,
    doRequest: (signal: AbortSignal) => Promise<Response>,
    override: { attemptTimeoutMs?: number } = {},
  ) {
    const policy = storageRetryPolicyFromEnv((k) => this.config.get<string>(k) ?? process.env[k]);
    if (override.attemptTimeoutMs) policy.attemptTimeoutMs = override.attemptTimeoutMs;
    try {
      return await storageRequestWithRetry(doRequest, {
        op, bytes, policy,
        onRetry: ({ attempt, status, error, delayMs }) =>
          this.logger.warn(`Storage ${op}: intento ${attempt} falló (${status ?? error ?? 'sin respuesta'}); reintento en ${Math.round(delayMs / 100) / 10} s`),
      });
    } catch (err) {
      if (isStorageUnavailableError(err)) {
        this.logger.error(err.message);
        await recordStorageFailure(this.breakerDb(), err.message, { logger: this.logger });
      }
      throw err;
    }
  }

  /** r83: DataSource del repo para el breaker (null en tests con repos falsos → breaker no-op). */
  private breakerDb() {
    const m = (this.artifactRepo as unknown as { manager?: { connection?: unknown; dataSource?: unknown } } | undefined)?.manager;
    return storageBreakerDbOf((m?.dataSource ?? m?.connection) as Parameters<typeof storageBreakerDbOf>[0]);
  }

  /** r83: ¿el objeto existente tiene EXACTAMENTE estos bytes? (sha256). Cualquier error de lectura → false. */
  private async existingObjectMatches(bucket: string, storagePath: string, expected: Buffer): Promise<boolean> {
    try {
      const existing = await this.downloadStorageObject(bucket, storagePath);
      return existing.length === expected.length && sha256Hex(existing) === sha256Hex(expected);
    } catch (err) {
      this.logger.warn(`existingObjectMatches: no se pudo leer ${bucket}/${storagePath} para verificarlo (${err instanceof Error ? err.message.slice(0, 160) : String(err)})`);
      return false;
    }
  }

  /**
   * Review r1 (I-1): ¿algún row de `artifacts` (de cualquier dueño) referencia este objeto de Storage? Un objeto
   * referenciado es inmutable: el worker de empaque escribe un rebuild a OTRA ruta en vez de sobrescribirlo.
   */
  async isStoragePathReferenced(bucket: string, storagePath: string): Promise<boolean> {
    const n = await this.artifactRepo.count({ where: { storagePath, storageBucket: bucket } });
    return n > 0;
  }

  /**
   * V2.1 R12: descarga (server-side, service role) un objeto de Storage por
   * bucket + path. Lo usa el empaque v3 para los archivos que un artifact
   * `dynamic_presentation` referencia (PDF y portada). Falla fuerte: sin
   * credenciales, HTTP ≠ 2xx o timeout → Error. Aditivo: nada lo usaba antes.
   */
  async downloadStorageObject(bucket: string, storagePath: string, timeoutMs = 60_000): Promise<Buffer> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side storage download');
    }
    // G6 I2: segmentos validados (sin dot-segments ni encoding) y bucket con forma de id.
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)) throw new Error(`STORAGE_PATH_INVALID: bucket ${JSON.stringify(bucket)}`);
    const encodedPath = assertSafeStoragePath(storagePath).map((s) => encodeURIComponent(s)).join('/');
    const url = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/authenticated/${bucket}/${encodedPath}`;
    // r83: reintentos ante 5xx/429/red (timeout por intento = timeoutMs); agotados → StorageUnavailableError.
    const { response: res } = await this.storageRequest('download', 0, (signal) => fetch(url, { headers: supabaseServiceHeaders(serviceKey), signal }), { attemptTimeoutMs: timeoutMs });
    if (!res.ok) throw new Error(`Supabase Storage download failed: ${res.status} ${bucket}/${storagePath}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * r107 B1 (fix P1-1): descarga EN FLUJO con tope duro de bytes REALMENTE recibidos (nunca `arrayBuffer()` sin
   * límite): un `content-length` mayor que `maxBytes` se rechaza sin leer el cuerpo, y si el flujo pasa el tope se aborta
   * la conexión. Cada trozo se pasa a `onChunk` (p. ej. hashes incrementales: nada recorre 300 MB de una vez). Lo usa el
   * Taller para el .mbz del usuario, cuyo objeto el dueño puede reemplazar entre el HEAD y la descarga (TOCTOU).
   */
  async downloadStorageObjectCapped(
    bucket: string,
    storagePath: string,
    opts: { maxBytes: number; timeoutMs?: number; onChunk?: (chunk: Buffer) => void; sizeHint?: number | null; bodyTimeoutMs?: number },
  ): Promise<Buffer> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side storage download');
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)) throw new Error(`STORAGE_PATH_INVALID: bucket ${JSON.stringify(bucket)}`);
    const encodedPath = assertSafeStoragePath(storagePath).map((s) => encodeURIComponent(s)).join('/');
    const url = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/authenticated/${bucket}/${encodedPath}`;
    const cap = new AbortController();
    // r107 B2 (N2): el timeout del intento (y el presupuesto de reintentos de Storage, 100 s) cubre SOLO hasta los
    // encabezados; el cuerpo tiene su propio plazo, proporcional al tamaño (`cappedBodyTimeoutMs`), y si se vence el error
    // lo dice (StorageDownloadTimeoutError) en vez de parecer «Storage caído / no se pudo leer».
    const { response: res } = await this.storageRequest('download', 0, async (signal) => {
      const untilHeaders = new AbortController();
      const onAbort = () => untilHeaders.abort(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await fetch(url, { headers: supabaseServiceHeaders(serviceKey), signal: AbortSignal.any([untilHeaders.signal, cap.signal]) });
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }, { attemptTimeoutMs: Math.min(opts.timeoutMs ?? 60_000, 60_000) });
    if (!res.ok) {
      let storageError: string | null = null;
      try {
        const t = (await res.text()).slice(0, 2000);
        const j = JSON.parse(t);
        storageError = typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : null;
        if (storageError) storageError = sanitizeStorageErrorText(storageError, 120);
      } catch { /* cuerpo vacío o no JSON */ }
      throw new StorageHttpError(res.status, storageError, `${bucket}/${storagePath}`);
    }
    const expected = declaredLength(res) ?? (typeof opts.sizeHint === 'number' ? opts.sizeHint : null);
    const bodyMs = opts.bodyTimeoutMs ?? cappedBodyTimeoutMs(expected, opts.timeoutMs ?? 60_000);
    let received = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cap.abort(); }, bodyMs);
    try {
      return await readBodyCapped(res, opts.maxBytes, () => cap.abort(), (c) => { received += c.length; if (opts.onChunk) opts.onChunk(c); }, { sizeHint: opts.sizeHint });
    } catch (err) {
      if (timedOut) throw new StorageDownloadTimeoutError(bodyMs, received, expected);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tamaño (content-length) de un objeto de Storage vía HEAD autenticado; null si no existe o no se pudo leer. */
  /** r74: tamaño del objeto en Storage (HEAD con la service role) o null si no existe / no se pudo verificar. */
  async headStorageObjectBytes(bucket: string, storagePath: string): Promise<number | null> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return null;
    const encodedPath = storagePath.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
    return this.headStorageObjectSize(supabaseUrl, serviceKey, bucket, encodedPath);
  }

  private async headStorageObjectSize(supabaseUrl: string, serviceKey: string, bucket: string, encodedPath: string): Promise<number | null> {
    const headUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/authenticated/${bucket}/${encodedPath}`;
    try {
      const res = await fetch(headUrl, { method: 'HEAD', headers: supabaseServiceHeaders(serviceKey), signal: AbortSignal.timeout(15_000) });
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
    opts: { workshopRoute?: boolean } = {},
  ): Promise<{ url?: string; storagePath: string; bucket: string; method: string }> {
    const artifact = await this.findOne(id, ownerId);
    // r107 B6 fix round 1 (P2-5): el original y las versiones del Taller se descargan SOLO por su endpoint (compuertas de la
    // sesión, tamaño revalidado, URL de 5 min). Por la ruta genérica → 403 con la ruta correcta; por la del Taller, nunca
    // más de WORKSHOP_DOWNLOAD_MAX_SECONDS ni firmado por el navegador (sin service role → 503).
    if (WORKSHOP_IMMUTABLE_TYPES.includes(artifact.type)) {
      if (!opts.workshopRoute) {
        throw new ForbiddenException({ code: ARTIFACT_WORKSHOP_DOWNLOAD_VIA_WORKSHOP, message: 'Este archivo del Taller de cursos se descarga desde el Taller (Versiones → Descargar), con un enlace de 5 minutos.' });
      }
      expiresInSeconds = Math.min(clampSignedUrlSeconds(expiresInSeconds), WORKSHOP_DOWNLOAD_MAX_SECONDS);
      if (!this.config.get<string>('SUPABASE_URL') || !this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY')) {
        throw new ServiceUnavailableException({ code: 'workshop_download_unavailable', message: 'La descarga de versiones del Taller no está disponible en este entorno (falta la firma del servidor).' });
      }
    }
    // LOOP 7 (A4 C1): se firma SOLO un objeto de la carpeta del dueño de la fila (también para filas registradas antes
    // del control en create()). La service role ignora RLS: este es el único control.
    if (!storagePathOwnedBy(artifact.ownerId, artifact.storageBucket, artifact.storagePath, { allowMockFixtures: true })) {
      this.logger.warn(`getDownloadUrl(${artifact.id}): ruta fuera de la carpeta del dueño (${artifact.storageBucket}/${artifact.storagePath}); no se firma`);
      throw new ForbiddenException({ code: 'storage_path_not_owned', message: 'storage_path_not_owned: este archivo no está en la carpeta del dueño; no se puede descargar.' });
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

  // ── SIGNED UPLOAD URL ───────────────────────────────────────────────────────

  /**
   * r107 B1 (Taller de cursos): URL firmada de SUBIDA para que el navegador mande un archivo grande (hasta 200 MB: WORKSHOP_MAX_UPLOAD_BYTES)
   * directo a Storage, sin pasar por la API ni por nginx. Mismo criterio que `getDownloadUrl`:
   *  - solo una ruta de la carpeta del dueño (`assertWritableStoragePath`: la service role ignora RLS, este es el control);
   *  - `x-upsert: false` (nunca pisa un objeto existente);
   *  - sin service role o si Supabase no firma → `method: 'frontend'`: el navegador sube con su propio SDK a SU carpeta
   *    (políticas own-folder de cursia-artifacts), igual que el resto de los artifacts del cliente.
   * Supabase no limita el tamaño de una subida firmada: quien la pide verifica después el tamaño real (HEAD / bytes).
   * Las URLs firmadas de subida de Supabase valen 2 h (no configurable).
   */
  async createSignedUploadUrl(
    ownerId: string,
    bucket: string,
    storagePath: string,
  ): Promise<{ method: 'backend'; url: string; token: string | null; storagePath: string; bucket: string } | { method: 'frontend'; storagePath: string; bucket: string }> {
    assertWritableStoragePath(ownerId, bucket, storagePath);
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const frontend = { method: 'frontend' as const, storagePath, bucket };
    if (!supabaseUrl || !serviceKey) {
      this.logger.warn('createSignedUploadUrl: sin SUPABASE_SERVICE_ROLE_KEY — el navegador sube con su SDK a su carpeta');
      return frontend;
    }
    const encodedPath = assertSafeStoragePath(storagePath).map((s) => encodeURIComponent(s)).join('/');
    const signUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/upload/sign/${bucket}/${encodedPath}`;
    try {
      const response = await fetch(signUrl, {
        method: 'POST',
        headers: { ...supabaseServiceHeaders(serviceKey), 'Content-Type': 'application/json', 'x-upsert': 'false' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        this.logger.error(`createSignedUploadUrl: Supabase respondió ${response.status} ${sanitizeStorageErrorText(await response.text())}`);
        return frontend;
      }
      const data = (await response.json()) as { url?: string; token?: string };
      if (!data?.url) return frontend;
      const full = data.url.startsWith('http') ? data.url : `${supabaseUrl.replace(/\/$/, '')}/storage/v1${data.url}`;
      let token: string | null = typeof data.token === 'string' ? data.token : null;
      if (!token) {
        try { token = new URL(full).searchParams.get('token'); } catch { token = null; }
      }
      return { method: 'backend', url: full, token, storagePath, bucket };
    } catch (err) {
      this.logger.error(`createSignedUploadUrl: ${err instanceof Error ? err.message : String(err)}`);
      return frontend;
    }
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────

  /**
   * Elimina el registro de metadata y (si corresponde) el objeto de Supabase
   * Storage (requiere SUPABASE_SERVICE_ROLE_KEY).
   *
   * Release-fix (release review Minor 1): dos semánticas según el artifact.
   * - LEGACY (no dynamic): mismo resultado observable que `main` — la fila se
   *   borra y el objeto de Storage también, aunque otra fila legacy comparta
   *   el path (`x-upsert:true`); un fallo de Storage se loguea y nunca impide
   *   borrar la fila. Única excepción: si una fila DYNAMIC usa el mismo path,
   *   el objeto se conserva. (Re-review N3: el DELETE HTTP a Storage corre
   *   DESPUÉS del commit, nunca con la transacción/locks abiertos.)
   * En ambos casos el DELETE a Storage tiene un timeout acotado
   * (ARTIFACT_STORAGE_DELETE_TIMEOUT_MS, default 10000 ms).
   * - DYNAMIC (`type` dynamic_* o vinculado a item_run_id/manifest_id): Fase 8
   *   — una fila "carried" (REUSE) apunta a la MISMA storage_path inmutable
   *   que la fila histórica de la que salió; borrar una fila nunca debe borrar
   *   el objeto que otra fila sigue usando. Fix wave I2 (carrera con el apply
   *   fromRun): en UNA transacción se bloquea la fila (FOR UPDATE), se
   *   bloquean y cuentan las demás filas con la misma ruta y se borra la
   *   fila; el objeto se borra recién DESPUÉS del commit y solo si nadie más
   *   lo referenciaba. Un apply que llegue después ve la fila borrada y falla
   *   con 409.
   */
  async remove(id: string, ownerId: string, opts: { allowAdminOnlyPackage?: boolean } = {}): Promise<void> {
    const qr = this.artifactRepo.manager.connection.createQueryRunner();
    let row: any;
    let sharers: any[] = [];
    let deleteObject = false;
    await qr.connect();
    try {
      await qr.startTransaction();
      // DoD follow-up fix round 1 (m3): un SUPER_ADMIN (allowAdminOnlyPackage) borra un .mbz QA / degradado
      // NUEVO de CUALQUIER dueño (son suyos de administrar); cualquier otro artifact sigue siendo del dueño.
      [row] = opts.allowAdminOnlyPackage
        ? await qr.query(
          `select * from public.artifacts
            where id = $1 and (owner_id = $2 or (type = 'dynamic_mbz' and metadata->>'packageKind' in ('qa_preview', 'degraded')))
            for update`, [id, ownerId])
        : await qr.query(`select * from public.artifacts where id = $1 and owner_id = $2 for update`, [id, ownerId]);
      if (!row) throw new NotFoundException(`Artifact ${id} not found`);
      // r107 B2: el .mbz ORIGINAL de una sesión del Taller es inmutable (diseño §2 regla 3): es la base de todas sus
      // versiones y del inventario. Solo este tipo; los demás siguen igual.
      if (row.type === WORKSHOP_ORIGINAL_ARTIFACT_TYPE) {
        throw new ForbiddenException({ code: ARTIFACT_WORKSHOP_ORIGINAL_IMMUTABLE, message: 'El original de una sesión del Taller de cursos no se puede borrar: es la base de sus versiones.' });
      }
      if (row.type === WORKSHOP_VERSION_ARTIFACT_TYPE) {
        throw new ForbiddenException({ code: ARTIFACT_WORKSHOP_VERSION_IMMUTABLE, message: 'Una versión del Taller de cursos no se puede borrar: es parte del historial del curso (y puede ser la base de otra versión).' });
      }
      // r107 B10: el resultado de una regeneración es lo que el docente aprobó y pagó: el plan y la versión lo usan.
      if (row.type === WORKSHOP_REGEN_RESULT_ARTIFACT_TYPE) {
        throw new ForbiddenException({ code: ARTIFACT_WORKSHOP_VERSION_IMMUTABLE, message: 'El resultado de rehacer una actividad en el Taller no se puede borrar: el plan aprobado lo usa.' });
      }
      // DoD follow-up (R4): un .mbz QA / degradado NUEVO es solo de SUPER_ADMIN; para el dueño no existe
      // (mismo 404 que GET /artifacts/:id) — nunca se borra la fila ni el objeto `qa-internal/`.
      if (!opts.allowAdminOnlyPackage && isAdminOnlyPackageArtifact(row)) throw new NotFoundException(`Artifact ${id} not found`);
      sharers = await qr.query(
        `select * from public.artifacts where storage_bucket = $1 and storage_path = $2 and id <> $3 for update`,
        [row.storage_bucket, row.storage_path, row.id],
      );
      // Qué filas impiden borrar el objeto: para una fila dynamic, cualquier
      // otra; para una legacy, solo las dynamic (entre legacy, semántica de main).
      // r107 B2 (fix round 2, P2-8): una fila `workshop_original` que comparte la ruta SIEMPRE bloquea el borrado del objeto
      // (el original de una sesión del Taller es inmutable aunque se borre otra fila que lo nombre).
      // r107 B6: lo mismo para una `workshop_version` (y una sesión hija registra su original sobre la MISMA ruta).
      const blocking = isDynamicArtifactRow(row) ? sharers : sharers.filter((x) => isDynamicArtifactRow(x) || WORKSHOP_IMMUTABLE_TYPES.includes(x.type));
      deleteObject = blocking.length === 0;
      if (!deleteObject) {
        this.logger.log(`remove(${row.id}): ${blocking.length} fila(s) más usan ${row.storage_path}; se conserva el objeto de Storage`);
      }
      await qr.query(`delete from public.artifacts where id = $1`, [row.id]);
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
    // LOOP 7 (A4 C1): el objeto se borra SOLO si está en la carpeta del dueño de la fila (nunca una ruta ajena ni un
    // fixture compartido); la fila sí se borra.
    if (deleteObject && !storagePathOwnedBy(row.owner_id, row.storage_bucket, row.storage_path)) {
      this.logger.warn(`remove(${row.id}): ruta fuera de la carpeta del dueño (${row.storage_bucket}/${row.storage_path}); se borra la fila, no el objeto`);
      deleteObject = false;
    }
    if (deleteObject) await this.deleteStorageObject(row);
  }

  /**
   * r107 B6: borra un objeto que el SERVIDOR subió y que NINGUNA fila de `artifacts` nombra (p. ej. el paquete de una
   * versión del Taller cuya registración falló después de subirlo: nunca un objeto huérfano). Solo dentro de la carpeta
   * del dueño; si alguna fila usa la ruta, no se toca. Best effort: devuelve si lo intentó.
   */
  async deleteUnreferencedServerObject(ownerId: string, bucket: string, storagePath: string): Promise<boolean> {
    if (!storagePathOwnedBy(ownerId, bucket, storagePath)) return false;
    const [ref] = await this.artifactRepo.manager.query(`select 1 as x from public.artifacts where storage_bucket = $1 and storage_path = $2 limit 1`, [bucket, storagePath]);
    if (ref) return false;
    await this.deleteStorageObject({ storage_provider: 'supabase', storage_bucket: bucket, storage_path: storagePath });
    return true;
  }

  /** Borra el objeto de Storage de una fila (best effort: los fallos se loguean, nunca se propagan). */
  private async deleteStorageObject(row: { storage_provider: string; storage_bucket: string; storage_path: string }): Promise<void> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const serviceKey  = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!(supabaseUrl && serviceKey && row.storage_provider === 'supabase')) return;
    try {
      const deleteUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${row.storage_bucket}/${row.storage_path}`;
      const res = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: supabaseServiceHeaders(serviceKey),
        signal: AbortSignal.timeout(storageDeleteTimeoutMs()),
      });
      if (!res.ok) {
        this.logger.warn(`Storage delete failed for ${row.storage_path}: ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Storage delete error for ${row.storage_path}: ${err}`);
    }
  }
}
