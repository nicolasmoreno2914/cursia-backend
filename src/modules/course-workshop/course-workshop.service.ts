import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { isStorageUnavailableError } from '../artifacts/storage-resilience';
import { rbacMode } from '../authz/authz-flags';
import { PermissionService } from '../authz/permission.service';
import type { Permission } from '../authz/permissions';
import { isUuid } from '../authz/schema-probe';
import { MBZ_READER_LIMITS, isMbzReaderError, openMbz } from './mbz-reader';
import {
  CatalogCourse, IdentificationResult, IdentifyScope, PackageFactsError, WorkshopFamily, builderVersionColumn, identifyPackage, readPackageFacts,
} from './identify';

/**
 * r107 B1 · Taller de cursos — ingesta + identificación (diseño §4 «ingest» / «identify»).
 *
 *  1. `POST /course-workshop/sessions` crea la sesión (status `uploaded`, subida pendiente) y una URL firmada de subida a
 *     la carpeta del dueño en `cursia-artifacts` (`<owner>/workshop/<sessionId>/original.mbz`, tope 300 MB).
 *  2. El navegador sube el .mbz DIRECTO a Storage (no pasa por la API ni por nginx).
 *  3. `POST …/:id/uploaded` verifica que el objeto exista y su tamaño, pasa a `identifying` y responde 202; la
 *     identificación corre EN ESTE PROCESO (sin await, hasta 2 a la vez): descarga, sha1/sha256 reales, lector seguro,
 *     moodle_backup.xml, catálogo del dueño / institución, `identifyPackage`, registro del artifact `workshop_original`
 *     (tipo solo del servidor) → `identified`; cualquier rechazo → `failed` con el motivo visible (nunca éxito parcial).
 *     Decisión (B1-report §worker): solo lee moodle_backup.xml + hash (≤ 2 s en el paquete real de 112 MB del corpus);
 *     no justifica un worker ni un job. Si el proceso se reinicia a mitad, una sesión `identifying` de más de
 *     IDENTIFY_STALE_MS se da por interrumpida al leerla y se puede reintentar con el mismo POST.
 *  4. `GET …/:id` devuelve la sesión (sondeo del navegador).
 *
 * Permisos (diseño §7): el dueño; SuperAdmin todo; con `CURSIA_RBAC_MODE=enforce`, un miembro de la institución de la
 * sesión con el permiso (`courses.view` para leer, `courses.edit` para cerrar la subida). Lo ajeno responde 404.
 * La identificación NUNCA cruza cuentas: el catálogo es el del dueño (y su institución solo en enforce).
 */

export const WORKSHOP_ERRORS = Object.freeze({
  NOT_MIGRATED: 'COURSE_WORKSHOP_NOT_MIGRATED',
  FILE_TOO_LARGE: 'WORKSHOP_FILE_TOO_LARGE',
  FILENAME_INVALID: 'WORKSHOP_FILENAME_INVALID',
  UPLOAD_NOT_FOUND: 'WORKSHOP_UPLOAD_NOT_FOUND',
  IDENTIFICATION_FAILED: 'WORKSHOP_IDENTIFICATION_FAILED',
  IDENTIFICATION_INTERRUPTED: 'WORKSHOP_IDENTIFICATION_INTERRUPTED',
  STORAGE_UNAVAILABLE: 'WORKSHOP_STORAGE_UNAVAILABLE',
});

export const WORKSHOP_BUCKET = 'cursia-artifacts';
export const WORKSHOP_MAX_UPLOAD_BYTES = MBZ_READER_LIMITS.maxPackageBytes; // 300 MB (diseño §11)
/** Una identificación `identifying` más vieja que esto se da por interrumpida (holgura amplia: 300 MB ≈ 1 min). */
export const IDENTIFY_STALE_MS = 15 * 60_000;
/** Identificaciones simultáneas en este proceso (cada una tiene el paquete entero en memoria). */
export const IDENTIFY_CONCURRENCY = 2;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const INSTITUTION_HEADER = 'x-cursia-institution';

export type WorkshopStatus = 'uploaded' | 'identifying' | 'identified' | 'failed';
export type WorkshopPhase = 'awaiting_upload' | 'identifying' | 'identified' | 'failed';

export interface WorkshopActor {
  id: string;
  email?: string | null;
}

export interface WorkshopSessionRecord {
  id: string;
  status: WorkshopStatus;
  /** `uploaded` = sesión creada, la subida todavía no se cerró (POST …/uploaded). */
  phase: WorkshopPhase;
  institutionId: string | null;
  filename: string | null;
  originalArtifactId: string | null;
  originalSha1: string | null;
  originalSize: number | null;
  container: 'zip' | 'tar.gz' | null;
  family: WorkshopFamily | null;
  identifiedCourseId: number | null;
  identification: {
    method: IdentificationResult['method'];
    confidence: IdentificationResult['confidence'];
    needsConfirmation: boolean;
    candidates: IdentificationResult['candidates'];
    builder: IdentificationResult['builder'];
    notes: string[];
    title: string | null;
    activities: number | null;
    sections: number | null;
  } | null;
  builderVersion: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionResult {
  session: WorkshopSessionRecord;
  upload: {
    method: 'backend' | 'frontend';
    url?: string;
    token?: string | null;
    bucket: string;
    storagePath: string;
    maxBytes: number;
  };
}

interface Row {
  id: string;
  owner_id: string;
  institution_id: string | null;
  status: WorkshopStatus;
  original_artifact_id: string | null;
  storage_path: string;
  original_sha1: string | null;
  original_size: string | number | null;
  container: 'zip' | 'tar.gz' | null;
  family: WorkshopFamily | null;
  identified_course_id: number | null;
  identification: any;
  builder_version: string | null;
  error: any;
  created_at: Date | string;
  updated_at: Date | string;
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const sha = (algo: 'sha1' | 'sha256', b: Buffer) => createHash(algo).update(b).digest('hex');

/** Nombre de archivo que se guarda (solo para mostrarlo y para la regla de re-exporte de Moodle); nunca forma una ruta. */
export function sanitizeUploadFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  if (!clean || !/\.mbz$/i.test(clean)) return null;
  return clean;
}

export function workshopStoragePath(ownerId: string, sessionId: string): string {
  return `${ownerId.toLowerCase()}/workshop/${sessionId.toLowerCase()}/original.mbz`;
}

@Injectable()
export class CourseWorkshopService {
  private readonly logger = new Logger(CourseWorkshopService.name);
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Identificaciones en curso de este proceso (las pruebas las esperan). */
  readonly inFlight = new Map<string, Promise<void>>();
  now: () => Date = () => new Date();

  constructor(
    private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactsService,
    @Optional() private readonly permissions?: PermissionService,
  ) {}

  // ── utilidades ──

  private async q<T = any>(m: Q, sql: string, params: unknown[] = []): Promise<T> {
    try {
      return await m.query(sql, params);
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') {
        throw new ServiceUnavailableException({ code: WORKSHOP_ERRORS.NOT_MIGRATED, message: 'El Taller de cursos todavía no está disponible en este entorno (falta la migración r107).' });
      }
      throw err;
    }
  }

  private superAdmin(actor: WorkshopActor): boolean {
    return isSuperAdminEmail(actor.email ?? null);
  }

  private toRecord(r: Row): WorkshopSessionRecord {
    const ident = r.identification && typeof r.identification === 'object' ? r.identification : {};
    const res = ident.result as IdentificationResult | undefined;
    const facts = ident.facts ?? {};
    const phase: WorkshopPhase = r.status === 'uploaded' ? 'awaiting_upload' : r.status;
    return {
      id: r.id,
      status: r.status,
      phase,
      institutionId: r.institution_id ?? null,
      filename: ident.upload?.filename ?? null,
      originalArtifactId: r.original_artifact_id ?? null,
      originalSha1: r.original_sha1 ?? null,
      originalSize: r.original_size === null || r.original_size === undefined ? null : Number(r.original_size),
      container: r.container ?? null,
      family: r.family ?? null,
      identifiedCourseId: r.identified_course_id ?? null,
      identification: res
        ? {
            method: res.method, confidence: res.confidence, needsConfirmation: res.needsConfirmation, candidates: res.candidates ?? [], builder: res.builder,
            notes: res.notes ?? [], title: facts.title ?? null, activities: facts.activities ?? null, sections: facts.sections ?? null,
          }
        : null,
      builderVersion: r.builder_version ?? null,
      error: r.error && typeof r.error === 'object' ? { code: String(r.error.code), message: String(r.error.message), retryable: r.error.retryable === true } : null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  /** Sesión visible para el actor, o 404 (nunca se distingue «no existe» de «es de otro»). */
  private async loadForActor(actor: WorkshopActor, id: string, permission: Permission): Promise<Row> {
    if (!isUuid(id)) throw new NotFoundException('Sesión del Taller no encontrada');
    const [row] = await this.q<Row[]>(this.dataSource, `select * from public.workshop_sessions where id = $1`, [id.toLowerCase()]);
    if (!row) throw new NotFoundException('Sesión del Taller no encontrada');
    if (this.superAdmin(actor)) return row;
    if (String(row.owner_id).toLowerCase() === String(actor.id).toLowerCase()) return row;
    if (row.institution_id && rbacMode() === 'enforce' && this.permissions) {
      const d = await this.permissions.can({ id: actor.id, email: actor.email ?? null }, permission, row.institution_id, { concreteResource: true });
      if (d.allowed) return row;
    }
    throw new NotFoundException('Sesión del Taller no encontrada');
  }

  /**
   * Institución de una sesión nueva: con RBAC en enforce, la activa (header verificado o la única membresía activa) y
   * con `courses.edit` en ella; en off/shadow, ninguna (comportamiento legacy: dueño único, nada que compartir).
   */
  private async institutionForNewSession(actor: WorkshopActor, header: string | null): Promise<string | null> {
    if (rbacMode() !== 'enforce' || !this.permissions) return null;
    let inst: string | null = null;
    if (header) {
      if (!isUuid(header)) throw new BadRequestException({ code: 'institution_required', message: 'Elige una institución.' });
      inst = header.trim().toLowerCase();
    } else {
      const active = (await this.permissions.membershipsOf(actor.id)).filter((m) => m.status === 'active');
      if (active.length === 1) inst = active[0].institutionId;
      else return null; // sin institución activa: la sesión es solo del dueño
    }
    const d = await this.permissions.can({ id: actor.id, email: actor.email ?? null }, 'courses.edit', inst, { concreteResource: false });
    if (d.allowed === false) throw new ForbiddenException({ code: d.code, message: 'No tienes permiso para usar el Taller en esta institución.' });
    return inst;
  }

  // ── API ──

  async createSession(actor: WorkshopActor, input: { filename: unknown; sizeBytes: unknown }, institutionHeader: string | null = null): Promise<CreateSessionResult> {
    const filename = sanitizeUploadFilename(input.filename);
    if (!filename) throw new BadRequestException({ code: WORKSHOP_ERRORS.FILENAME_INVALID, message: 'Sube un archivo .mbz (copia de seguridad de Moodle).' });
    const size = Number(input.sizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0) throw new BadRequestException({ code: WORKSHOP_ERRORS.FILE_TOO_LARGE, message: 'El archivo está vacío.' });
    if (size > WORKSHOP_MAX_UPLOAD_BYTES) {
      throw new BadRequestException({ code: WORKSHOP_ERRORS.FILE_TOO_LARGE, message: `El archivo pesa ${Math.round(size / 1048576)} MB; el máximo es ${Math.round(WORKSHOP_MAX_UPLOAD_BYTES / 1048576)} MB.` });
    }
    const institutionId = await this.institutionForNewSession(actor, institutionHeader);
    const [idRow] = await this.q<any[]>(this.dataSource, `select gen_random_uuid()::text as id`);
    const id = String(idRow.id);
    const storagePath = workshopStoragePath(actor.id, id);
    const identification = { upload: { filename, declaredBytes: size, createdBy: actor.id } };
    const [row] = await this.q<Row[]>(this.dataSource,
      `insert into public.workshop_sessions (id, owner_id, institution_id, status, storage_path, identification)
       values ($1, $2, $3, 'uploaded', $4, $5::jsonb) returning *`,
      [id, actor.id, institutionId, storagePath, JSON.stringify(identification)]);
    const signed = await this.artifacts.createSignedUploadUrl(actor.id, WORKSHOP_BUCKET, storagePath);
    return {
      session: this.toRecord(row),
      upload: signed.method === 'backend'
        ? { method: 'backend', url: signed.url, token: signed.token, bucket: WORKSHOP_BUCKET, storagePath, maxBytes: WORKSHOP_MAX_UPLOAD_BYTES }
        : { method: 'frontend', bucket: WORKSHOP_BUCKET, storagePath, maxBytes: WORKSHOP_MAX_UPLOAD_BYTES },
    };
  }

  async get(actor: WorkshopActor, id: string): Promise<WorkshopSessionRecord> {
    let row = await this.loadForActor(actor, id, 'courses.view');
    row = await this.expireIfStale(row);
    return this.toRecord(row);
  }

  /** Cierra la subida y dispara la identificación (202). Idempotente: identificada → la misma; en curso → la misma. */
  async markUploaded(actor: WorkshopActor, id: string): Promise<WorkshopSessionRecord> {
    let row = await this.loadForActor(actor, id, 'courses.edit');
    row = await this.expireIfStale(row);
    if (row.status === 'identified' || row.status === 'identifying') return this.toRecord(row);
    if (row.status === 'failed' && row.error && row.error.retryable !== true) return this.toRecord(row);
    const bytes = await this.artifacts.headStorageObjectBytes(WORKSHOP_BUCKET, row.storage_path);
    if (bytes === null) {
      throw new ConflictException({ code: WORKSHOP_ERRORS.UPLOAD_NOT_FOUND, message: 'Todavía no llegó el archivo: termina de subirlo y vuelve a intentar.' });
    }
    if (bytes > WORKSHOP_MAX_UPLOAD_BYTES) {
      const [r] = returningRows(await this.q(this.dataSource,
        `update public.workshop_sessions set status = 'failed', original_size = null, error = $2::jsonb, updated_at = now() where id = $1 returning *`,
        [row.id, JSON.stringify({ code: WORKSHOP_ERRORS.FILE_TOO_LARGE, message: `El archivo subido pesa ${Math.round(bytes / 1048576)} MB; el máximo es ${Math.round(WORKSHOP_MAX_UPLOAD_BYTES / 1048576)} MB.`, retryable: false })]));
      return this.toRecord(r);
    }
    const claimed = returningRows(await this.q(this.dataSource,
      `update public.workshop_sessions set status = 'identifying', error = null, updated_at = now()
        where id = $1 and (status = 'uploaded' or (status = 'failed' and coalesce((error->>'retryable')::boolean, false)))
        returning *`,
      [row.id]));
    if (!claimed.length) {
      const [cur] = await this.q<Row[]>(this.dataSource, `select * from public.workshop_sessions where id = $1`, [row.id]);
      return this.toRecord(cur);
    }
    // Sin await (202). Nunca una promesa rechazada sin dueño (tumbaría el proceso): si hasta el registro del fallo
    // falla (base caída), queda `identifying` y IDENTIFY_STALE_MS la libera al leerla.
    const p = this.withSlot(() => this.runIdentification(row.id))
      .catch((err) => this.logger.error(`workshop ${row.id}: la identificación terminó con error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, p);
    return this.toRecord(claimed[0]);
  }

  // ── identificación ──

  private async withSlot(fn: () => Promise<void>): Promise<void> {
    if (this.running >= IDENTIFY_CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      await fn();
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  private async expireIfStale(row: Row): Promise<Row> {
    if (row.status !== 'identifying' || this.inFlight.has(row.id)) return row;
    if (this.now().getTime() - new Date(row.updated_at).getTime() < IDENTIFY_STALE_MS) return row;
    const [r] = returningRows(await this.q(this.dataSource,
      `update public.workshop_sessions set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1 and status = 'identifying' returning *`,
      [row.id, JSON.stringify({ code: WORKSHOP_ERRORS.IDENTIFICATION_INTERRUPTED, message: 'La identificación se interrumpió; vuelve a intentarlo.', retryable: true })]));
    return r ?? row;
  }

  /** Corre la identificación de una sesión ya `identifying`. Nunca lanza: todo termina en `identified` o `failed`. */
  async runIdentification(id: string): Promise<void> {
    const [row] = await this.q<Row[]>(this.dataSource, `select * from public.workshop_sessions where id = $1`, [id]);
    if (!row || row.status !== 'identifying') return;
    const fail = async (code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}) => {
      await this.q(this.dataSource,
        `update public.workshop_sessions set status = 'failed', error = $2::jsonb, original_sha1 = coalesce($3, original_sha1),
                original_size = coalesce($4, original_size), container = coalesce($5, container), updated_at = now()
          where id = $1 and status = 'identifying'`,
        [id, JSON.stringify({ code, message, retryable }), extra.sha1 ?? null, extra.size ?? null, extra.container ?? null]);
    };
    let buf: Buffer;
    try {
      buf = await this.artifacts.downloadStorageObject(WORKSHOP_BUCKET, row.storage_path, DOWNLOAD_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(`workshop ${id}: no se pudo descargar el original (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
      await fail(isStorageUnavailableError(err) ? WORKSHOP_ERRORS.STORAGE_UNAVAILABLE : WORKSHOP_ERRORS.UPLOAD_NOT_FOUND,
        'No se pudo leer el archivo subido; vuelve a intentarlo en unos minutos.', true);
      return;
    }
    const sha1 = sha('sha1', buf);
    const sha256 = sha('sha256', buf);
    const size = buf.length;
    try {
      if (size > WORKSHOP_MAX_UPLOAD_BYTES) {
        await fail(WORKSHOP_ERRORS.FILE_TOO_LARGE, `El archivo subido pesa ${Math.round(size / 1048576)} MB; el máximo es ${Math.round(WORKSHOP_MAX_UPLOAD_BYTES / 1048576)} MB.`, false);
        return;
      }
      const pkg = await openMbz(buf);
      const facts = await readPackageFacts(pkg, row.identification?.upload?.filename ?? null);
      const scope: IdentifyScope = { ownerId: row.owner_id, institutionId: rbacMode() === 'enforce' ? row.institution_id : null };
      const catalog = await this.loadCatalog(scope);
      const result = identifyPackage({ facts, sha1, sha256, sizeBytes: size, scope, catalog });
      const artifactId = await this.registerOriginal(row, { sha1, sha256, size, container: pkg.container, family: result.family });
      const identification = {
        ...(row.identification ?? {}),
        sha256,
        facts: { title: facts.title, activities: facts.activities, sections: facts.sections, entryCount: facts.entryCount, moodleRelease: facts.moodleRelease, backupName: facts.backupName },
        result,
        identifiedAt: this.now().toISOString(),
      };
      await this.q(this.dataSource,
        `update public.workshop_sessions
            set status = 'identified', original_artifact_id = $2, original_sha1 = $3, original_size = $4, container = $5, family = $6,
                identified_course_id = $7, identification = $8::jsonb, builder_version = $9, error = null, updated_at = now()
          where id = $1 and status = 'identifying'`,
        [id, artifactId, sha1, size, pkg.container, result.family, result.courseId, JSON.stringify(identification), builderVersionColumn(result)]);
    } catch (err) {
      if (isMbzReaderError(err) || err instanceof PackageFactsError) {
        await fail(`WORKSHOP_${err.code.toUpperCase()}`, err.message, false, { sha1, size });
        return;
      }
      this.logger.error(`workshop ${id}: identificación falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      await fail(WORKSHOP_ERRORS.IDENTIFICATION_FAILED, 'No se pudo identificar el paquete; vuelve a intentarlo. Si se repite, avísanos.', true, { sha1, size });
    }
  }

  /** Catálogo del alcance: cursos del dueño (y de su institución solo en enforce) con sus paquetes .mbz registrados. */
  async loadCatalog(scope: IdentifyScope): Promise<CatalogCourse[]> {
    const courses = await this.q<any[]>(this.dataSource,
      `select c.id, c.title, c.owner_id::text as owner_id, c.institution_id::text as institution_id, c.metadata->>'courseId' as frontend_id
         from public.courses c
        where c.owner_id::text = $1 or ($2::text is not null and c.institution_id::text = $2::text)
        order by c.id desc limit 1000`,
      [scope.ownerId, scope.institutionId]);
    if (!courses.length) return [];
    const owners = [...new Set(courses.map((c) => String(c.owner_id ?? '')).filter(Boolean))];
    const arts = await this.q<any[]>(this.dataSource,
      `select a.id::text as id, a.type, a.owner_id::text as owner_id, a.course_id::text as course_ref, a.checksum_sha256, a.size_bytes,
              a.metadata->>'builderVersion' as builder_version, a.metadata->>'activityCount' as activity_count, a.metadata->>'validatedSha256' as validated_sha256
         from public.artifacts a
        where a.type in ('mbz_final', 'dynamic_mbz') and a.owner_id::text = any($1::text[])
        order by a.created_at desc limit 5000`,
      [owners]);
    const byKey = new Map<string, CatalogCourse>();
    const out: CatalogCourse[] = courses.map((c) => {
      const cc: CatalogCourse = { courseId: Number(c.id), title: String(c.title ?? ''), ownerId: c.owner_id ?? null, institutionId: c.institution_id ?? null, packages: [] };
      byKey.set(`${c.owner_id}|${c.id}`, cc);
      if (c.frontend_id) byKey.set(`${c.owner_id}|${String(c.frontend_id)}`, cc);
      return cc;
    });
    for (const a of arts) {
      // Mismo criterio que resolveArtifact: el curso del artifact es el de su referencia Y del mismo dueño.
      const cc = byKey.get(`${a.owner_id}|${String(a.course_ref ?? '')}`);
      if (!cc) continue;
      const sha256 = /^[0-9a-f]{64}$/.test(String(a.checksum_sha256 ?? '')) ? String(a.checksum_sha256) : /^[0-9a-f]{64}$/.test(String(a.validated_sha256 ?? '')) ? String(a.validated_sha256) : null;
      const ac = Number(a.activity_count);
      cc.packages.push({
        artifactId: a.id, type: a.type, sha256, sizeBytes: a.size_bytes === null || a.size_bytes === undefined ? null : Number(a.size_bytes),
        builderVersion: a.builder_version ?? null, activityCount: Number.isInteger(ac) && ac > 0 ? ac : null,
      });
    }
    return out;
  }

  /** Registra (una sola vez) el artifact `workshop_original` que apunta al objeto subido. */
  private async registerOriginal(row: Row, v: { sha1: string; sha256: string; size: number; container: string; family: string }): Promise<string> {
    const [existing] = await this.q<any[]>(this.dataSource,
      `select id::text as id from public.artifacts where type = 'workshop_original' and owner_id::text = $1 and storage_path = $2 limit 1`,
      [row.owner_id, row.storage_path]);
    if (existing) return existing.id;
    const a = await this.artifacts.create({
      type: 'workshop_original',
      storage_path: row.storage_path,
      storage_bucket: WORKSHOP_BUCKET,
      storage_provider: 'supabase',
      filename: row.identification?.upload?.filename ?? 'original.mbz',
      mime_type: 'application/vnd.moodle.backup',
      size_bytes: v.size,
      checksum_sha256: v.sha256,
      metadata: { workshopSessionId: row.id, sha1: v.sha1, container: v.container, family: v.family },
    } as any, row.owner_id);
    return a.id;
  }

  /** El header de institución activa tal como lo manda el frontend (r75). */
  static institutionHeaderOf(headers: Record<string, unknown> | undefined): string | null {
    const raw = headers?.[INSTITUTION_HEADER];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }
}
