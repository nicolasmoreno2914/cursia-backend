import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { ArtifactsService, STORAGE_DOWNLOAD_TIMEOUT, STORAGE_OBJECT_TOO_LARGE, StorageDownloadTimeoutError, StorageHttpError, assertWritableStoragePath } from '../artifacts/artifacts.service';
import { isStorageUnavailableError } from '../artifacts/storage-resilience';
import { rbacMode } from '../authz/authz-flags';
import { PermissionService } from '../authz/permission.service';
import type { Permission } from '../authz/permissions';
import { isUuid } from '../authz/schema-probe';
import { MBZ_READER_LIMITS, MbzPackage, isMbzReaderError, openMbz } from './mbz-reader';
import {
  BuilderLine, CatalogCourse, IdentificationResult, IdentifyScope, PackageFactsError, WorkshopFamily, builderVersionColumn, identifyPackage, readPackageFacts,
} from './identify';
import { WorkshopCourse, stableStringify } from './course-model';
import {
  INVENTORY_CODE_VERSION, INVENTORY_PERSIST_MAX_BYTES, InventoryMeta, SourceArtifactRow, SourceStructure, WORKSHOP_SOURCE_TYPES, attachSources, buildInventory, persistableInventory,
} from './inventory';

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
 *  5. r107 B2: al pasar a `identified` se arma el INVENTARIO (modelo único `WorkshopCourse`, adaptador por familia) con
 *     los mismos bytes recién verificados, se le engancha la fuente del generador si el curso se identificó, y se guarda
 *     en `workshop_sessions.inventory` (forma persistida: sin el texto HTML, ver inventory.ts). `GET …/:id/inventory` lo
 *     devuelve; si falta (sesión identificada antes de B2, o falló el armado) lo reconstruye en segundo plano desde el
 *     original, VERIFICANDO antes que el objeto de Storage siga teniendo el sha1/sha256 de la sesión: si cambió, la
 *     sesión pasa a `failed` con WORKSHOP_ORIGINAL_CHANGED (el original nunca se reemplaza).
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
  UPLOAD_CHANGED: 'WORKSHOP_UPLOAD_CHANGED',
  ORIGINAL_CHANGED: 'WORKSHOP_ORIGINAL_CHANGED',
  DOWNLOAD_TIMEOUT: 'WORKSHOP_DOWNLOAD_TIMEOUT',
  NOT_IDENTIFIED: 'WORKSHOP_NOT_IDENTIFIED',
  INVENTORY_FAILED: 'WORKSHOP_INVENTORY_FAILED',
  INVENTORY_TOO_LARGE: 'WORKSHOP_INVENTORY_TOO_LARGE',
  ORIGINAL_MISSING: 'WORKSHOP_ORIGINAL_MISSING',
});

/**
 * Fix round 2 (P1-3): la reconstrucción del inventario desde el original (sesiones sin inventario) se intenta a lo sumo
 * INVENTORY_REBUILD_MAX_ATTEMPTS veces por versión del original (sha1), y SOLO ante fallas transitorias de Storage, con
 * espera creciente entre intentos (1, 4, 16 min). Una falla del armado es determinista para los mismos bytes: no se reintenta.
 * Corre en su propio carril (1 por proceso): nunca ocupa los lugares de las identificaciones. Los intentos se cuentan por
 * (sha1 del original, INVENTORY_CODE_VERSION) y AL RECLAMAR (fix round 3, N1/N4).
 */
export const INVENTORY_REBUILD_MAX_ATTEMPTS = 3;
export const INVENTORY_REBUILD_BACKOFF_MS = 60_000;

/** Fix P2-7: límites SOLO de la lista para la heurística (las coincidencias exactas se consultan aparte). */
export const WORKSHOP_CATALOG_LIMITS = Object.freeze({ courses: 1000, artifacts: 5000 });

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
  /** B2: resumen del inventario (el inventario completo: GET …/:id/inventory). */
  inventory: { builtAt: string | null; chapters: number | null; activities: number | null; error: { code: string; message: string; retryable: boolean } | null } | null;
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
  inventory?: any;
  created_at: Date | string;
  updated_at: Date | string;
}

/** `GET …/sessions/:id/inventory`: listo, armándose (sondear) o fallido con el motivo. */
export interface WorkshopInventoryResponse {
  sessionId: string;
  status: 'ready' | 'building' | 'failed';
  inventory: (WorkshopCourse & { htmlOmitted: true }) | null;
  builtAt: string | null;
  /** Si hay un reintento programado (falla transitoria de Storage), cuándo. */
  retryAt: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Columnas de la sesión SIN el inventario (jsonb de hasta MB): las lecturas de sondeo no lo arrastran. */
const SESSION_COLS = `id, owner_id, institution_id, status, original_artifact_id, storage_path, original_sha1, original_size, container, family,
  identified_course_id, identification, builder_version, error, created_at, updated_at`;

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

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
  /** Armado del inventario (puro). Reemplazable SOLO en pruebas (simular un armado que falla). */
  inventoryBuilder: (pkg: MbzPackage, meta: InventoryMeta) => Promise<WorkshopCourse> = buildInventory;
  /** Carril propio de la reconstrucción del inventario (1 por proceso; no usa el semáforo de las identificaciones). */
  private rebuildLane: symbol | null = null;

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
      // 42P01 sin tabla (B1) / 42703 sin columna `inventory` (B2): falta la migración r107.
      if ((err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703') {
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
      inventory: ident.inventory && typeof ident.inventory === 'object'
        ? {
            builtAt: typeof ident.inventory.builtAt === 'string' ? ident.inventory.builtAt : null,
            chapters: typeof ident.inventory.chapters === 'number' ? ident.inventory.chapters : null,
            activities: typeof ident.inventory.activities === 'number' ? ident.inventory.activities : null,
            error: ident.inventory.error ? { code: String(ident.inventory.error.code), message: String(ident.inventory.error.message), retryable: ident.inventory.error.retryable === true } : null,
          }
        : null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  /** Sesión visible para el actor, o 404 (nunca se distingue «no existe» de «es de otro»). */
  private async loadForActor(actor: WorkshopActor, id: string, permission: Permission): Promise<Row> {
    if (!isUuid(id)) throw new NotFoundException('Sesión del Taller no encontrada');
    const [row] = await this.q<Row[]>(this.dataSource, `select ${SESSION_COLS} from public.workshop_sessions where id = $1`, [id.toLowerCase()]);
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
    // Fix P2-6: el reclamo es de la BASE (UPDATE condicional) y lleva un token: solo quien tiene el token vigente puede
    // escribir el resultado; un reintento tras la expiración cambia el token y la ejecución vieja (otro proceso, un
    // pm2 reload) ya no puede pisar nada ni registrar un segundo original.
    const claimId = randomUUID();
    const claimed = returningRows(await this.q(this.dataSource,
      `update public.workshop_sessions
          set status = 'identifying', error = null, updated_at = now(),
              identification = jsonb_set(coalesce(identification, '{}'::jsonb), '{claim}', jsonb_build_object('id', $2::text, 'at', now(), 'headBytes', $3::bigint))
        where id = $1 and (status = 'uploaded' or (status = 'failed' and coalesce((error->>'retryable')::boolean, false)))
        returning *`,
      [row.id, claimId, bytes]));
    if (!claimed.length) {
      const [cur] = await this.q<Row[]>(this.dataSource, `select ${SESSION_COLS} from public.workshop_sessions where id = $1`, [row.id]);
      return this.toRecord(cur);
    }
    // Sin await (202). Nunca una promesa rechazada sin dueño (tumbaría el proceso): si hasta el registro del fallo
    // falla (base caída), queda `identifying` y IDENTIFY_STALE_MS la libera al leerla.
    const p = this.withSlot(() => this.runIdentification(row.id, claimId))
      .catch((err) => this.logger.error(`workshop ${row.id}: la identificación terminó con error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, p);
    return this.toRecord(claimed[0]);
  }

  // ── identificación ──

  /** Identificaciones corriendo ahora en este proceso (las pruebas lo leen). */
  get runningCount(): number {
    return this.running;
  }

  /**
   * Fix P2-1: semáforo de IDENTIFY_CONCURRENCY. El que despierta VUELVE a mirar (`while`): entre el `running--` de quien
   * termina y la continuación del que esperaba puede colarse otra llamada; sin el re-chequeo corrían 3 a la vez.
   */
  async withSlot(fn: () => Promise<void>): Promise<void> {
    while (this.running >= IDENTIFY_CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
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
      `update public.workshop_sessions set status = 'failed', error = $2::jsonb, updated_at = now()
        where id = $1 and status = 'identifying' and updated_at < now() - ($3::int * interval '1 millisecond') returning *`,
      [row.id, JSON.stringify({ code: WORKSHOP_ERRORS.IDENTIFICATION_INTERRUPTED, message: 'La identificación se interrumpió; vuelve a intentarlo.', retryable: true }), IDENTIFY_STALE_MS]));
    return r ?? row;
  }

  /**
   * Corre la identificación de una sesión `identifying` cuyo reclamo vigente es `claimId`. Nunca lanza: termina en
   * `identified` o `failed`; si el reclamo ya no es suyo (expiró y otro lo tomó) no escribe nada.
   */
  async runIdentification(id: string, claimId: string): Promise<void> {
    const [row] = await this.q<Row[]>(this.dataSource, `select ${SESSION_COLS} from public.workshop_sessions where id = $1`, [id]);
    if (!row || row.status !== 'identifying' || row.identification?.claim?.id !== claimId) return;
    const CLAIMED = `id = $1 and status = 'identifying' and identification->'claim'->>'id' = $2`;
    const fail = async (code: string, message: string, retryable: boolean, extra: { sha1?: string; size?: number } = {}) => {
      await this.q(this.dataSource,
        `update public.workshop_sessions set status = 'failed', error = $3::jsonb, original_sha1 = coalesce($4, original_sha1),
                original_size = coalesce($5, original_size), updated_at = now()
          where ${CLAIMED}`,
        [id, claimId, JSON.stringify({ code, message, retryable }), extra.sha1 ?? null, extra.size ?? null]);
    };

    // 1. Descarga EN FLUJO con tope duro (fix P1-1) y hashes incrementales (fix P2-4): nada de 300 MB de una vez.
    const headBytes = Number(row.identification?.claim?.headBytes);
    const dl = await this.downloadOriginal(row, Number.isFinite(headBytes) ? headBytes : null);
    if ('fail' in dl) {
      await fail(dl.fail.code, dl.fail.message, dl.fail.retryable);
      return;
    }
    const { buf, sha1, sha256 } = dl;
    const size = buf.length;
    // Se verifica lo DESCARGADO, no el HEAD: si el objeto cambió entre el HEAD y la descarga, se pide reintentar (el
    // reintento vuelve a hacer HEAD y a hashear lo que llegue).
    if (Number.isFinite(headBytes) && headBytes !== size) {
      await fail(WORKSHOP_ERRORS.UPLOAD_CHANGED, 'El archivo cambió mientras lo verificábamos; vuelve a intentarlo cuando termine de subirse.', true);
      return;
    }

    // 2. Lector seguro + hechos del paquete. Todo rechazo acá es ENTRADA MALFORMADA → no reintentable (fix P2-3).
    let pkg: MbzPackage;
    let facts;
    try {
      pkg = await openMbz(buf);
      facts = await readPackageFacts(pkg, row.identification?.upload?.filename ?? null);
    } catch (err) {
      if (isMbzReaderError(err) || err instanceof PackageFactsError) {
        await fail(`WORKSHOP_${err.code.toUpperCase()}`, err.message, false, { sha1, size });
      } else {
        this.logger.warn(`workshop ${id}: paquete ilegible (${err instanceof Error ? err.name : typeof err})`);
        await fail('WORKSHOP_CORRUPT', 'El archivo está dañado o no tiene el formato de una copia de Moodle; vuelve a descargarlo y súbelo otra vez.', false, { sha1, size });
      }
      return;
    }

    // 3. Catálogo del alcance de la sesión + identificación + registro atómico. Fallas de base: reintentables.
    try {
      const scope: IdentifyScope = { ownerId: row.owner_id, institutionId: row.institution_id ?? null };
      const { catalog, truncated } = await this.loadCatalog(scope, {
        sha256, courseIds: [facts.cursiaMeta?.courseId ?? null, facts.v3NameCourseId].filter((x): x is number => typeof x === 'number'), title: facts.title,
      });
      const result = identifyPackage({ facts, sha1, sha256, sizeBytes: size, scope, catalog, catalogTruncated: truncated });
      // B2: inventario con los MISMOS bytes recién hasheados (son los que quedan como original: verificado por
      // construcción). Una falla del inventario no tumba la identificación, pero queda visible (identification.inventory).
      const inv = await this.composeInventory(pkg, { family: result.family, builderLine: result.builder.line, builderVersion: result.builder.version }, result.courseId, scope);
      const identification = {
        ...(row.identification ?? {}),
        sha256,
        facts: { title: facts.title, activities: facts.activities, sections: facts.sections, entryCount: facts.entryCount, moodleRelease: facts.moodleRelease, backupName: facts.backupName },
        catalog: { size: catalog.length, truncated },
        result,
        identifiedAt: this.now().toISOString(),
        // N1/N4: la falla (si hubo) queda atada a esta versión del original y del armado; no es un intento de reconstrucción.
        inventory: { ...inv.info, forSha1: sha1, codeVersion: INVENTORY_CODE_VERSION, attempts: 0 },
      };
      const container = pkg.container;
      await this.dataSource.transaction(async (m) => {
        // Una sola registración por objeto, aunque corran dos procesos: lock por ruta + verificación del reclamo.
        await m.query(`select pg_advisory_xact_lock(hashtext('workshop_original:' || $1))`, [row.storage_path]);
        const [still] = await this.q<any[]>(m, `select 1 as ok from public.workshop_sessions where ${CLAIMED} for update`, [id, claimId]);
        if (!still) return; // el reclamo ya no es nuestro: no se escribe nada
        const artifactId = await this.registerOriginal(m, row, { sha1, sha256, size, container, family: result.family });
        await this.q(m,
          `update public.workshop_sessions
              set status = 'identified', original_artifact_id = $3, original_sha1 = $4, original_size = $5, container = $6, family = $7,
                  identified_course_id = $8, identification = $9::jsonb, builder_version = $10, error = null, inventory = $11::jsonb, updated_at = now()
            where ${CLAIMED}`,
          [id, claimId, artifactId, sha1, size, container, result.family, result.courseId, JSON.stringify(identification), builderVersionColumn(result), inv.json]);
      });
    } catch (err) {
      if ((err as { code?: string })?.code === WORKSHOP_ERRORS.ORIGINAL_CHANGED) {
        await fail(WORKSHOP_ERRORS.ORIGINAL_CHANGED, 'El original ya registrado de esta sesión tiene otros bytes; crea una sesión nueva para subir otro archivo.', false, { sha1, size });
        return;
      }
      this.logger.error(`workshop ${id}: identificación falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      await fail(WORKSHOP_ERRORS.IDENTIFICATION_FAILED, 'No se pudo identificar el paquete; vuelve a intentarlo. Si se repite, avísanos.', true, { sha1, size });
    }
  }

  // ── original (descarga verificada) ──

  /**
   * Descarga el original de la sesión con tope (fix P1-1), memoria ~1× (N1) y plazo del cuerpo según el tamaño (N2),
   * calculando sha1 y sha256 por trozo. Nunca lanza: devuelve los bytes o la falla para la sesión. `missing` = Storage
   * respondió que el objeto no existe (400/404), distinto de «Storage no responde».
   */
  private async downloadOriginal(row: Row, sizeHint: number | null): Promise<{ buf: Buffer; sha1: string; sha256: string } | { fail: { code: string; message: string; retryable: boolean; missing?: boolean } }> {
    const h1 = createHash('sha1');
    const h256 = createHash('sha256');
    try {
      const buf = await this.artifacts.downloadStorageObjectCapped(WORKSHOP_BUCKET, row.storage_path, {
        maxBytes: WORKSHOP_MAX_UPLOAD_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        sizeHint,
        onChunk: (c) => { h1.update(c); h256.update(c); },
      });
      return { buf, sha1: h1.digest('hex'), sha256: h256.digest('hex') };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === STORAGE_OBJECT_TOO_LARGE) {
        return { fail: { code: WORKSHOP_ERRORS.FILE_TOO_LARGE, message: `El archivo subido pesa más de ${Math.round(WORKSHOP_MAX_UPLOAD_BYTES / 1048576)} MB (el máximo).`, retryable: false } };
      }
      if (code === STORAGE_DOWNLOAD_TIMEOUT) {
        const e = err as StorageDownloadTimeoutError;
        const mb = (b: number) => (b / 1048576).toFixed(1);
        return { fail: { code: WORKSHOP_ERRORS.DOWNLOAD_TIMEOUT, retryable: true,
          message: `La descarga del archivo desde el almacenamiento se cortó por tiempo: llegaron ${mb(e.receivedBytes)}${e.expectedBytes !== null ? ` de ${mb(e.expectedBytes)}` : ''} MB en ${Math.round(e.timeoutMs / 1000)} s. Vuelve a intentarlo; si se repite, avísanos (la conexión con el almacenamiento está lenta).` } };
      }
      this.logger.warn(`workshop ${row.id}: no se pudo descargar el original (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
      const unavailable = isStorageUnavailableError(err);
      // Fix round 3 (N2): «el objeto no existe» SOLO por el status estructurado de la respuesta (404, o 400 not_found de
      // Supabase); 401 / 403 / 5xx / red quedan transitorios. Nunca por el texto del mensaje (la ruta lleva dígitos).
      const missing = !unavailable && err instanceof StorageHttpError && err.notFound;
      return { fail: { code: unavailable ? WORKSHOP_ERRORS.STORAGE_UNAVAILABLE : WORKSHOP_ERRORS.UPLOAD_NOT_FOUND, message: 'No se pudo leer el archivo subido; vuelve a intentarlo en unos minutos.', retryable: true, missing } };
    }
  }

  /**
   * B2 (original alterable, B1-report riesgo 1): el original de una sesión YA identificada, verificado contra el sha1 /
   * sha256 / tamaño guardados. El dueño puede reemplazar o BORRAR el objeto con su SDK (políticas own-folder):
   *  - otros bytes (o > 300 MB) → la sesión pasa a `failed` con WORKSHOP_ORIGINAL_CHANGED, 409;
   *  - el objeto ya no existe (Storage 400/404) → `failed` con WORKSHOP_ORIGINAL_MISSING, 409 (fix round 2, P2-1);
   * los dos terminales (el original nunca se reemplaza). Storage caído / lento → 503, la sesión no cambia.
   * Todo uso posterior del original (inventario, diagnóstico, parches) pasa por acá.
   */
  async loadVerifiedOriginal(sessionId: string): Promise<{ buffer: Buffer; sha1: string; sha256: string }> {
    const [row] = await this.q<Row[]>(this.dataSource, `select ${SESSION_COLS} from public.workshop_sessions where id = $1`, [sessionId]);
    if (!row) throw new NotFoundException('Sesión del Taller no encontrada');
    return this.verifiedOriginalOf(row);
  }

  private async failOriginal(row: Row, code: string, message: string): Promise<never> {
    await this.q(this.dataSource,
      `update public.workshop_sessions set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1 and status = 'identified'`,
      [row.id, JSON.stringify({ code, message, retryable: false })]);
    this.logger.warn(`workshop ${row.id}: original no utilizable (${code})`);
    throw new ConflictException({ code, message });
  }

  private async verifiedOriginalOf(row: Row): Promise<{ buffer: Buffer; sha1: string; sha256: string }> {
    if (row.status !== 'identified' || !row.original_sha1) {
      throw new ConflictException({ code: WORKSHOP_ERRORS.NOT_IDENTIFIED, message: 'La sesión todavía no tiene un original verificado.' });
    }
    const size = row.original_size === null || row.original_size === undefined ? null : Number(row.original_size);
    const dl = await this.downloadOriginal(row, size);
    if ('fail' in dl) {
      if (dl.fail.missing) {
        return this.failOriginal(row, WORKSHOP_ERRORS.ORIGINAL_MISSING,
          'El archivo original de esta sesión ya no está en el almacenamiento (se borró después de verificarlo). Crea una sesión nueva subiendo el .mbz otra vez.');
      }
      // Un objeto que ahora pesa más de 300 MB tampoco es el original; lo demás es transitorio.
      if (dl.fail.code !== WORKSHOP_ERRORS.FILE_TOO_LARGE) throw new ServiceUnavailableException({ code: dl.fail.code, message: dl.fail.message });
    }
    const wantSha256 = typeof row.identification?.sha256 === 'string' ? row.identification.sha256 : null;
    const same = !('fail' in dl) && dl.sha1 === row.original_sha1 && (wantSha256 === null || dl.sha256 === wantSha256) && (size === null || dl.buf.length === size);
    if (!same) {
      return this.failOriginal(row, WORKSHOP_ERRORS.ORIGINAL_CHANGED,
        'El archivo original de esta sesión cambió en el almacenamiento después de verificarlo (ya no tiene la misma huella): por seguridad no se usa. Crea una sesión nueva subiendo el .mbz otra vez.');
    }
    return { buffer: (dl as { buf: Buffer }).buf, sha1: row.original_sha1, sha256: (dl as { sha256: string }).sha256 };
  }

  // ── inventario (B2) ──

  /**
   * Arma el inventario (pura) + la fuente del generador si el curso se identificó, y la forma persistida. Nunca lanza:
   * una falla queda en `info.error` (visible en la sesión y en GET …/inventory), jamás como inventario vacío «listo».
   * Fix round 2 (P1-3): una falla del ARMADO es determinista para los mismos bytes → no reintentable.
   */
  private async composeInventory(pkg: MbzPackage, meta: { family: WorkshopFamily; builderLine: BuilderLine | string; builderVersion: string | null }, courseId: number | null, scope: IdentifyScope) {
    const builtAt = this.now().toISOString();
    try {
      let course = await this.inventoryBuilder(pkg, meta);
      if (courseId !== null) course = attachSources(course, await this.loadSources(courseId, scope));
      const json = stableStringify(persistableInventory(course));
      const bytes = Buffer.byteLength(json);
      if (bytes > INVENTORY_PERSIST_MAX_BYTES) {
        return { json: null, info: { builtAt, bytes, error: { code: WORKSHOP_ERRORS.INVENTORY_TOO_LARGE, message: `El inventario de este paquete pesa ${(bytes / 1048576).toFixed(1)} MB (el máximo guardable es ${INVENTORY_PERSIST_MAX_BYTES / 1048576} MB); avísanos.`, retryable: false } } };
      }
      return {
        json,
        info: {
          builtAt, bytes, error: null, schema: course.schema, chapters: course.chapters.length, activities: course.activities.length,
          unknownChapterRoles: course.stats.unknownChapterRoles, unknownCourseKinds: course.stats.unknownCourseKinds, source: course.sourceLookup.status,
        },
      };
    } catch (err) {
      this.logger.error(`workshop: el inventario falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { json: null, info: { builtAt, error: { code: WORKSHOP_ERRORS.INVENTORY_FAILED, message: 'No se pudo armar el inventario de este paquete (falla con estos mismos bytes: no se reintenta sola). Avísanos para revisarlo.', retryable: false } } };
    }
  }

  /**
   * Fuente que el generador guardó para el curso identificado (B2 §3): artifacts de los tipos de `WORKSHOP_SOURCE_TYPES`
   * del curso (id numérico o uuid del frontend) y de SU dueño, más la estructura (course_modules / course_chapters) para
   * enganchar por posición. Solo referencias. Columnas o tablas que falten en un entorno viejo → se consulta sin ellas.
   * Fix round 2 (P2-7): el curso se vuelve a verificar contra el ALCANCE de la sesión en cada lectura (también al
   * reconstruir), cada referencia lleva el dueño de su fila, y la numeración por posición es la del builder: módulos por
   * su posición (aunque no tengan capítulos) y capítulos en ese orden, incluidos los de práctica.
   */
  async loadSources(courseId: number, scope: IdentifyScope): Promise<{ courseId: number; rows: SourceArtifactRow[]; structure: SourceStructure | null } | { courseId: number; error: string }> {
    try {
      const [c] = await this.dataSource.query(`select id, owner_id::text as owner_id, institution_id::text as institution_id, metadata->>'courseId' as fe from public.courses where id = $1`, [courseId]);
      if (!c) return { courseId, rows: [], structure: null };
      const inScope = scope.institutionId
        ? String(c.institution_id ?? '').toLowerCase() === scope.institutionId.toLowerCase()
        : String(c.owner_id ?? '').toLowerCase() === scope.ownerId.toLowerCase();
      if (!inScope) return { courseId, error: 'El curso identificado ya no está en el alcance de esta sesión: no se usa su fuente.' };
      const refs = [String(c.id), ...(c.fe ? [String(c.fe)] : [])];
      const sql = (full: boolean) => `select a.id::text as id, a.type, a.owner_id::text as owner_id,
          ${full ? 'a.chapter_id::text' : 'null::text'} as chapter_id, ${full ? 'a.module_id::text' : 'null::text'} as module_id,
          ${full ? 'a.manifest_item_key' : 'null::text'} as item_key, a.created_at
        from public.artifacts a
        where a.owner_id::text = $1 and a.course_id::text = any($2::text[]) and a.type = any($3::text[])
          ${full ? `and (a.status is null or a.status <> 'disabled')` : ''}
        order by a.created_at desc, a.id desc limit 5000`;
      let rows: any[];
      try {
        rows = await this.dataSource.query(sql(true), [c.owner_id, refs, [...WORKSHOP_SOURCE_TYPES]]);
      } catch (err) {
        if ((err as { code?: string })?.code !== '42703') throw err;
        rows = await this.dataSource.query(sql(false), [c.owner_id, refs, [...WORKSHOP_SOURCE_TYPES]]);
      }
      let structure: SourceStructure | null = null;
      try {
        const mods = await this.dataSource.query(`select id::text as id from public.course_modules where course_id = $1 order by position`, [courseId]);
        const st = await this.dataSource.query(
          `select ch.id::text as id, m.id::text as module_id from public.course_chapters ch join public.course_modules m on m.id = ch.module_id
            where ch.course_id = $1 order by m.position, ch.position`, [courseId]);
        const modules: SourceStructure['modules'] = mods.map((m: any, i: number) => ({ id: m.id, number: i + 1 }));
        structure = { chapters: st.map((r: any, i: number) => ({ id: r.id, number: i + 1, moduleId: r.module_id })), modules };
      } catch (err) {
        if (!['42P01', '42703'].includes(String((err as { code?: string })?.code))) throw err;
      }
      return {
        courseId,
        rows: rows.map((r) => ({ id: String(r.id), type: String(r.type), ownerId: r.owner_id ?? null, chapterId: r.chapter_id ?? null, moduleId: r.module_id ?? null, itemKey: r.item_key ?? null, createdAt: r.created_at ? iso(r.created_at) : null })),
        structure,
      };
    } catch (err) {
      this.logger.warn(`workshop: no se pudo leer la fuente del curso ${courseId} (${err instanceof Error ? err.message.slice(0, 160) : String(err)})`);
      return { courseId, error: 'No se pudo leer la fuente guardada del curso; el inventario se armó solo con el paquete.' };
    }
  }

  /**
   * GET …/sessions/:id/inventory — mismas compuertas que GET …/:id. Fix round 2 (P1-3): un sondeo NUNCA dispara una
   * descarga por sí solo: la reconstrucción se reclama en la base (una a la vez por sesión, entre procesos), se intenta a
   * lo sumo INVENTORY_REBUILD_MAX_ATTEMPTS veces por (versión del original, versión del armado) y respeta la espera.
   * Fix round 3 (N4): una falla determinista es terminal solo para la versión del armado que falló: tras un deploy con
   * otra INVENTORY_CODE_VERSION se permite (exactamente) una reconstrucción más por versión.
   */
  async getInventory(actor: WorkshopActor, id: string): Promise<WorkshopInventoryResponse> {
    let row = await this.loadForActor(actor, id, 'courses.view');
    row = await this.expireIfStale(row);
    const info = row.identification?.inventory ?? null;
    const base = { sessionId: row.id, builtAt: typeof info?.builtAt === 'string' ? info.builtAt : null, retryAt: null as string | null };
    if (row.status === 'failed' && (row.error?.code === WORKSHOP_ERRORS.ORIGINAL_CHANGED || row.error?.code === WORKSHOP_ERRORS.ORIGINAL_MISSING)) {
      return { ...base, status: 'failed', inventory: null, error: { code: String(row.error.code), message: String(row.error.message), retryable: false } };
    }
    if (row.status !== 'identified') {
      throw new ConflictException({ code: WORKSHOP_ERRORS.NOT_IDENTIFIED, message: 'El inventario está disponible cuando termina la identificación del paquete.', status: row.status });
    }
    const [r] = await this.q<any[]>(this.dataSource, `select inventory from public.workshop_sessions where id = $1`, [row.id]);
    if (r?.inventory) return { ...base, status: 'ready', inventory: r.inventory, error: null };
    const err = info?.error && typeof info.error === 'object' ? { code: String(info.error.code), message: String(info.error.message), retryable: info.error.retryable === true } : null;
    const sameVersion = info?.forSha1 === row.original_sha1 && info?.codeVersion === INVENTORY_CODE_VERSION;
    // Terminal para ESTA versión del original y del armado (fallas sin `codeVersion` son de antes de N4: se rehacen una vez).
    if (err && !err.retryable && sameVersion) return { ...base, status: 'failed', inventory: null, error: err };
    if (sameVersion && Number(info?.attempts) >= INVENTORY_REBUILD_MAX_ATTEMPTS) {
      return { ...base, status: 'failed', inventory: null, error: err ?? { code: WORKSHOP_ERRORS.INVENTORY_FAILED, message: `No se pudo armar el inventario después de ${INVENTORY_REBUILD_MAX_ATTEMPTS} intentos; avísanos.`, retryable: false } };
    }
    const retryAt = sameVersion && typeof info?.nextAttemptAt === 'string' ? info.nextAttemptAt : null;
    if (retryAt && new Date(retryAt).getTime() > this.now().getTime()) return { ...base, status: 'building', inventory: null, error: err, retryAt };
    await this.startInventoryRebuild(row);
    return { ...base, status: 'building', inventory: null, error: err, retryAt };
  }

  /**
   * Reconstrucción en segundo plano. Reclamo en la base (`identification.inventory.rebuildClaimAt`, condicional: otro
   * sondeo u otro proceso no lanza una segunda) + carril propio de 1 por proceso (no usa los lugares de identificación).
   * Fix round 3:
   *  - N1: el INTENTO se cuenta en el mismo UPDATE del reclamo (no al terminar): un proceso que muere a mitad (OOM,
   *    pm2 reload) igual gastó su intento, y el tope vale;
   *  - N3: el carril se toma de forma SÍNCRONA antes de cualquier await, y solo su dueño lo suelta.
   */
  private async startInventoryRebuild(row: Row): Promise<void> {
    const key = `inventory:${row.id}`;
    if (this.inFlight.has(key) || this.rebuildLane !== null) return;
    const lane = Symbol(key);
    this.rebuildLane = lane; // síncrono: ningún otro sondeo del proceso pasa de acá mientras tanto
    const release = () => { if (this.rebuildLane === lane) this.rebuildLane = null; };
    let claimed: any[];
    try {
      claimed = returningRows(await this.q(this.dataSource,
        `update public.workshop_sessions
            set identification = jsonb_set(coalesce(identification, '{}'::jsonb), '{inventory}',
                  coalesce(identification->'inventory', '{}'::jsonb) || jsonb_build_object(
                    'rebuildClaimAt', $2::text,
                    'forSha1', $4::text,
                    'codeVersion', $5::text,
                    'attempts', case when identification->'inventory'->>'forSha1' = $4::text and identification->'inventory'->>'codeVersion' = $5::text
                                     then coalesce((identification->'inventory'->>'attempts')::int, 0) + 1 else 1 end))
          where id = $1 and status = 'identified' and inventory is null
            and (identification->'inventory'->>'rebuildClaimAt' is null
                 or (identification->'inventory'->>'rebuildClaimAt')::timestamptz < $2::timestamptz - ($3::int * interval '1 millisecond'))
            and not (identification->'inventory'->>'forSha1' = $4::text and identification->'inventory'->>'codeVersion' = $5::text
                     and coalesce((identification->'inventory'->>'attempts')::int, 0) >= $6::int)
          returning id`,
        [row.id, this.now().toISOString(), IDENTIFY_STALE_MS, row.original_sha1, INVENTORY_CODE_VERSION, INVENTORY_REBUILD_MAX_ATTEMPTS]));
    } catch (e) {
      release();
      throw e;
    }
    if (!claimed.length) { release(); return; }
    const p = this.rebuildInventory(row.id)
      .catch((e) => this.logger.error(`workshop ${row.id}: la reconstrucción del inventario terminó con error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { release(); this.inFlight.delete(key); });
    this.inFlight.set(key, p);
  }

  /** Arma y guarda el inventario de una sesión identificada que no lo tiene, desde el original VERIFICADO. */
  async rebuildInventory(id: string): Promise<void> {
    const [row] = await this.q<Row[]>(this.dataSource, `select ${SESSION_COLS}, inventory is not null as has_inventory from public.workshop_sessions where id = $1`, [id]);
    if (!row || row.status !== 'identified' || (row as Row & { has_inventory?: boolean }).has_inventory) return;
    const prev = row.identification?.inventory ?? {};
    // N1: el intento YA se contó al reclamar (este es el número `attempts`); acá no se vuelve a sumar.
    const attempts = Number.isInteger(prev.attempts) ? Number(prev.attempts) : 1;
    const saveInfo = (info: Record<string, unknown>, json: string | null) => this.q(this.dataSource,
      `update public.workshop_sessions set inventory = $2::jsonb, identification = jsonb_set(coalesce(identification, '{}'::jsonb), '{inventory}', $3::jsonb), updated_at = now()
        where id = $1 and status = 'identified' and inventory is null`,
      [id, json, JSON.stringify({ ...info, forSha1: row.original_sha1, codeVersion: INVENTORY_CODE_VERSION, attempts })]);
    let original;
    try {
      original = await this.verifiedOriginalOf(row);
    } catch (err) {
      const body = (err as { getResponse?: () => any })?.getResponse?.();
      if (body?.code === WORKSHOP_ERRORS.ORIGINAL_CHANGED || body?.code === WORKSHOP_ERRORS.ORIGINAL_MISSING) return; // la sesión ya quedó failed
      // Transitorio (Storage caído / lento): reintento con espera creciente; agotados los intentos, terminal.
      const last = attempts >= INVENTORY_REBUILD_MAX_ATTEMPTS;
      const nextAttemptAt = last ? null : new Date(this.now().getTime() + INVENTORY_REBUILD_BACKOFF_MS * Math.pow(4, attempts - 1)).toISOString();
      await saveInfo({
        builtAt: this.now().toISOString(), nextAttemptAt,
        error: {
          code: body?.code ?? WORKSHOP_ERRORS.INVENTORY_FAILED, retryable: !last,
          message: last ? `No se pudo leer el original para armar el inventario después de ${INVENTORY_REBUILD_MAX_ATTEMPTS} intentos; avísanos.` : (body?.message ?? 'No se pudo leer el original para armar el inventario; se reintenta solo en unos minutos.'),
        },
      }, null);
      return;
    }
    let pkg: MbzPackage;
    try {
      pkg = await openMbz(original.buffer);
    } catch {
      await saveInfo({ builtAt: this.now().toISOString(), error: { code: WORKSHOP_ERRORS.INVENTORY_FAILED, message: 'El original verificado no se pudo abrir para armar el inventario; avísanos.', retryable: false } }, null);
      return;
    }
    const builderLine = String(row.identification?.result?.builder?.line ?? 'unknown');
    const builderVersion = typeof row.identification?.result?.builder?.version === 'string' ? row.identification.result.builder.version : null;
    const scope: IdentifyScope = { ownerId: row.owner_id, institutionId: row.institution_id ?? null };
    const inv = await this.composeInventory(pkg, { family: (row.family ?? 'prototype') as WorkshopFamily, builderLine, builderVersion }, row.identified_course_id ?? null, scope);
    await saveInfo(inv.info, inv.json);
  }

  /**
   * Catálogo del ALCANCE de la sesión (fix P1-2: institución → solo sus cursos; sin institución → solo los del dueño).
   * Fix P2-7: las coincidencias EXACTAS (huella sha256, ids que nombra el paquete, título igual) se buscan con consultas
   * directas y sin límite; solo la lista para la heurística se recorta, y si se recorta queda dicho (`truncated`).
   */
  async loadCatalog(scope: IdentifyScope, exact: { sha256?: string | null; courseIds?: number[]; title?: string | null } = {}): Promise<{ catalog: CatalogCourse[]; truncated: boolean }> {
    const inst = scope.institutionId ? scope.institutionId.toLowerCase() : null;
    const scopeSql = (alias: string, p: number) => (inst ? `${alias}.institution_id::text = $${p}` : `${alias}.owner_id::text = $${p}`);
    const scopeVal = inst ?? scope.ownerId;
    const COURSE_COLS = `c.id, c.title, c.owner_id::text as owner_id, c.institution_id::text as institution_id, c.metadata->>'courseId' as frontend_id`;
    const ART_COLS = `a.id::text as id, a.type, a.owner_id::text as owner_id, a.course_id::text as course_ref, a.checksum_sha256, a.size_bytes,
      a.metadata->>'builderVersion' as builder_version, a.metadata->>'activityCount' as activity_count, a.metadata->>'validatedSha256' as validated_sha256`;
    const ART_JOIN = `join public.courses c on c.owner_id::text = a.owner_id::text and (c.id::text = a.course_id::text or c.metadata->>'courseId' = a.course_id::text)`;

    // Exactas (sin límite de lista): artifacts con la huella; cursos con los ids que nombra el paquete o el mismo título.
    const sha = /^[0-9a-f]{64}$/.test(String(exact.sha256 ?? '')) ? String(exact.sha256) : null;
    const hashArts = sha
      ? await this.q<any[]>(this.dataSource,
        `select ${ART_COLS}, c.id as c_id, c.title as c_title, c.institution_id::text as c_institution_id, c.metadata->>'courseId' as c_frontend_id
           from public.artifacts a ${ART_JOIN}
          where a.type in ('mbz_final', 'dynamic_mbz') and (a.checksum_sha256 = $2 or a.metadata->>'validatedSha256' = $2) and ${scopeSql('c', 1)}`,
        [scopeVal, sha])
      : [];
    const ids = (exact.courseIds ?? []).filter((n) => Number.isSafeInteger(n) && n > 0);
    const exactCourses = ids.length || exact.title
      ? await this.q<any[]>(this.dataSource,
        `select ${COURSE_COLS} from public.courses c
          where ${scopeSql('c', 1)} and (c.id = any($2::int[]) or ($3::text is not null and lower(btrim(c.title)) = lower(btrim($3::text))))
          limit 200`,
        [scopeVal, ids, exact.title ?? null])
      : [];

    // Heurística: los más recientes del alcance, con límite declarado.
    const COURSE_LIMIT = WORKSHOP_CATALOG_LIMITS.courses;
    const recent = await this.q<any[]>(this.dataSource,
      `select ${COURSE_COLS} from public.courses c where ${scopeSql('c', 1)} order by c.id desc limit ${COURSE_LIMIT + 1}`, [scopeVal]);
    let truncated = recent.length > COURSE_LIMIT;
    const byId = new Map<number, CatalogCourse>();
    const byKey = new Map<string, CatalogCourse>();
    const addCourse = (c: any) => {
      const id = Number(c.id);
      if (byId.has(id)) return byId.get(id);
      const cc: CatalogCourse = { courseId: id, title: String(c.title ?? ''), ownerId: c.owner_id ?? null, institutionId: c.institution_id ?? null, packages: [] };
      byId.set(id, cc);
      byKey.set(`${c.owner_id}|${c.id}`, cc);
      if (c.frontend_id) byKey.set(`${c.owner_id}|${String(c.frontend_id)}`, cc);
      return cc;
    };
    for (const h of hashArts) addCourse({ id: h.c_id, title: h.c_title, owner_id: h.owner_id, institution_id: h.c_institution_id, frontend_id: h.c_frontend_id });
    for (const c of [...exactCourses, ...recent.slice(0, COURSE_LIMIT)]) addCourse(c);
    if (!byId.size) return { catalog: [], truncated };
    const owners = [...new Set([...byId.values()].map((c) => String(c.ownerId ?? '')).filter(Boolean))];
    const ART_LIMIT = WORKSHOP_CATALOG_LIMITS.artifacts;
    const arts = await this.q<any[]>(this.dataSource,
      `select ${ART_COLS} from public.artifacts a
        where a.type in ('mbz_final', 'dynamic_mbz') and a.owner_id::text = any($1::text[])
        order by a.created_at desc limit ${ART_LIMIT + 1}`,
      [owners]);
    if (arts.length > ART_LIMIT) truncated = true;
    const seen = new Set<string>();
    for (const a of [...hashArts, ...arts.slice(0, ART_LIMIT)]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      // Mismo criterio que resolveArtifact: el curso del artifact es el de su referencia Y del mismo dueño.
      const cc = byKey.get(`${a.owner_id}|${String(a.course_ref ?? '')}`);
      if (!cc) continue;
      const s256 = /^[0-9a-f]{64}$/.test(String(a.checksum_sha256 ?? '')) ? String(a.checksum_sha256) : /^[0-9a-f]{64}$/.test(String(a.validated_sha256 ?? '')) ? String(a.validated_sha256) : null;
      const ac = Number(a.activity_count);
      cc.packages.push({
        artifactId: a.id, type: a.type, sha256: s256, sizeBytes: a.size_bytes === null || a.size_bytes === undefined ? null : Number(a.size_bytes),
        builderVersion: a.builder_version ?? null, activityCount: Number.isInteger(ac) && ac > 0 ? ac : null,
      });
    }
    return { catalog: [...byId.values()], truncated };
  }

  /**
   * Registra (una sola vez, idempotente) el artifact `workshop_original`, DENTRO de la transacción con el lock por ruta.
   * Ya existe con los mismos bytes → se reutiliza; con otros bytes → ORIGINAL_CHANGED (el original nunca se reemplaza).
   */
  private async registerOriginal(m: Q, row: Row, v: { sha1: string; sha256: string; size: number; container: string; family: string }): Promise<string> {
    assertWritableStoragePath(row.owner_id, WORKSHOP_BUCKET, row.storage_path);
    const [existing] = await this.q<any[]>(m,
      `select id::text as id, checksum_sha256 from public.artifacts where type = 'workshop_original' and owner_id::text = $1 and storage_path = $2 order by created_at asc limit 1`,
      [row.owner_id, row.storage_path]);
    if (existing) {
      if (existing.checksum_sha256 && existing.checksum_sha256 !== v.sha256) {
        throw Object.assign(new Error('workshop_original con otros bytes'), { code: WORKSHOP_ERRORS.ORIGINAL_CHANGED });
      }
      return existing.id;
    }
    const [a] = await this.q<any[]>(m,
      `insert into public.artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, size_bytes, checksum_sha256, metadata)
       values ($1, null, 'workshop_original', 'supabase', $2, $3, $4, 'application/vnd.moodle.backup', $5, $6, $7::jsonb)
       returning id::text as id`,
      [row.owner_id, WORKSHOP_BUCKET, row.storage_path, row.identification?.upload?.filename ?? 'original.mbz', v.size, v.sha256,
        JSON.stringify({ workshopSessionId: row.id, sha1: v.sha1, container: v.container, family: v.family })]);
    return a.id;
  }

  /** El header de institución activa tal como lo manda el frontend (r75). */
  static institutionHeaderOf(headers: Record<string, unknown> | undefined): string | null {
    const raw = headers?.[INSTITUTION_HEADER];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }
}
