import { BadRequestException, Injectable, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AUTHZ_ERRORS } from './permissions';
import { isUuid, numericCourseId, QueryFn } from './schema-probe';

/**
 * r75 · Acceso a artifacts sin tocar `artifacts.service.ts` (lo modifica r74).
 *
 * B1 (H8b) — `POST /artifacts`: `course_id`, `job_id` y `metadata` del body no se validaban (F5):
 *   - `course_id` numérico de un curso que existe y es de OTRO dueño → 404 `course_not_found` (un artifact propio no
 *     puede «colgarse» del curso de otro: con RBAC los miembros de su institución lo verían). Un UUID del frontend no se
 *     rechaza: `resolveArtifact` solo liga un artifact a un curso del MISMO dueño (inerte para cursos ajenos).
 *   - `job_id`: tiene que ser un UUID (antes, un texto cualquiera daba 500 en la columna uuid) de un job/run del mismo
 *     dueño → si no, 400 `job_id_invalid` / 404 `job_not_found` (los lectores del servidor buscan artifacts por
 *     `job_id` + tipo: p. ej. el reporte de coherencia o el audio ya subido).
 *   - `metadata`: tope de tamaño (`ARTIFACT_METADATA_MAX_BYTES`, 256 KB) → 413 `artifact_metadata_too_large`.
 */
export const ARTIFACT_METADATA_MAX_BYTES = 256 * 1024;
export const ARTIFACT_JOB_ID_INVALID = 'job_id_invalid';
export const ARTIFACT_METADATA_TOO_LARGE = 'artifact_metadata_too_large';

export async function validateClientArtifactRefs(
  query: QueryFn,
  ownerId: string,
  dto: { course_id?: unknown; job_id?: unknown; metadata?: unknown },
): Promise<void> {
  const cid = numericCourseId(dto.course_id);
  if (cid !== null) {
    const [c] = await query(`select owner_id::text as owner_id from public.courses where id = $1`, [cid]);
    if (c && String(c.owner_id ?? '') !== String(ownerId)) {
      throw new NotFoundException({ code: AUTHZ_ERRORS.COURSE_NOT_FOUND, message: `Course #${cid} not found` });
    }
  }
  if (dto.job_id !== undefined && dto.job_id !== null && dto.job_id !== '') {
    if (!isUuid(dto.job_id)) {
      throw new BadRequestException({ code: ARTIFACT_JOB_ID_INVALID, message: `${ARTIFACT_JOB_ID_INVALID}: job_id debe ser un UUID.` });
    }
    const [j] = await query(
      `select 1 as x from public.production_jobs where id::text = $1 and owner_id::text = $2`,
      [String(dto.job_id).trim().toLowerCase(), ownerId],
    );
    if (!j) throw new NotFoundException({ code: AUTHZ_ERRORS.JOB_NOT_FOUND, message: `Job ${String(dto.job_id)} not found` });
  }
  if (dto.metadata !== undefined && dto.metadata !== null) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(dto.metadata), 'utf8');
    } catch {
      throw new BadRequestException({ code: ARTIFACT_METADATA_TOO_LARGE, message: `${ARTIFACT_METADATA_TOO_LARGE}: metadata no serializable.` });
    }
    if (size > ARTIFACT_METADATA_MAX_BYTES) {
      throw new PayloadTooLargeException({ code: ARTIFACT_METADATA_TOO_LARGE, message: `${ARTIFACT_METADATA_TOO_LARGE}: metadata de ${size} bytes (máx. ${ARTIFACT_METADATA_MAX_BYTES}).` });
    }
  }
}

@Injectable()
export class ArtifactAccessService {
  constructor(@Optional() private readonly dataSource?: DataSource) {}

  private get query(): QueryFn {
    const ds = this.dataSource;
    if (!ds) throw new Error('ArtifactAccessService sin DataSource');
    return (sql, params) => ds.query(sql, params as any[]);
  }

  /** B1 (H8b): valida las referencias del body de `POST /artifacts` ANTES de registrar nada. */
  async assertClientCreateRefs(dto: { course_id?: unknown; job_id?: unknown; metadata?: unknown }, ownerId: string): Promise<void> {
    await validateClientArtifactRefs(this.query, ownerId, dto);
  }
}
