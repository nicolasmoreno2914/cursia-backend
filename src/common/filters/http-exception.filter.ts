import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // PayloadTooLargeError from body-parser — must be 413, not 500
    const isPayloadTooLarge =
      exception instanceof Error &&
      ((exception as any).type === 'entity.too.large' ||
        (exception as any).status === 413 ||
        exception.message?.includes('request entity too large'));

    const status = isPayloadTooLarge
      ? HttpStatus.PAYLOAD_TOO_LARGE
      : exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isPayloadTooLarge
      ? 'El payload es demasiado grande. Reduce el tamaño del contenido enviado.'
      : exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    const errorResponse: Record<string, unknown> = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === 'string' ? message : (message as any).message || message,
    };
    // R68 (piloto): datos estructurados del error que el cliente necesita para explicarlo (motivo del bloqueo de generación,
    // críticos de Verificación; Prebrief: qué falta para prepararlo, qué cambió y la huella vigente; r81 microcurrículo:
    // obligatorias que faltan, fecha de renovación del cupo y comprobaciones a corregir). Solo estas claves.
    if (message && typeof message === 'object') {
      for (const k of ['code', 'reason', 'criticals', 'pendingChanges', 'blockers', 'diff', 'modelSha256', 'missing', 'resetsAt', 'issues']) {
        if ((message as any)[k] !== undefined) errorResponse[k] = (message as any)[k];
      }
      // r75 (02 §B/§C/§E): campos del contrato de permisos y presupuestos. Solo valores PRIMITIVOS acotados (nunca
      // objetos: así no se cuela nada más del error): qué permiso faltó, a qué usuario se refiere, montos en USD
      // (string decimal o número), quién paga, si puede pedir autorización y el estimado persistido.
      const R75_KEYS: Record<string, 'string' | 'boolean' | 'amount'> = {
        permission: 'string', userId: 'string', requiredUsd: 'amount', availableUsd: 'amount',
        payerUserId: 'string', canRequest: 'boolean', estimateId: 'string',
      };
      for (const [k, kind] of Object.entries(R75_KEYS)) {
        const v = (message as any)[k];
        if (v === undefined || v === null) continue;
        if (kind === 'boolean' && typeof v === 'boolean') errorResponse[k] = v;
        else if (kind === 'string' && typeof v === 'string' && v.length <= 120) errorResponse[k] = v;
        else if (kind === 'amount' && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d{1,12}(\.\d{1,10})?$/.test(v)))) errorResponse[k] = v;
      }
    }

    // r107 B6 (fix round 2): detalles del Taller de cursos que el navegador necesita para explicar un 4xx (qué ítems
    // cambiaron, qué falta confirmar, qué bloquea, el estimado vigente…). SOLO para errores con código del Taller
    // (`WORKSHOP_*` / `COURSE_WORKSHOP_*`, que arma solo el Taller), SOLO 4xx y SOLO estas claves, cada una con su forma:
    // ids → lista de uuids; textos acotados; objetos/listas → JSON acotado (64 KB) y sin claves que parezcan secretas.
    if (message && typeof message === 'object' && status >= 400 && status < 500) {
      Object.assign(errorResponse, workshopErrorDetails(message as Record<string, unknown>));
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}

/** r107 B6: claves del cuerpo de los 4xx del Taller que pasan al navegador, con su forma. */
export const WORKSHOP_ERROR_DETAIL_KEYS: Readonly<Record<string, 'ids' | 'id' | 'text' | 'hash' | 'json'>> = Object.freeze({
  status: 'text', ledgerCode: 'text', model: 'text', approvalId: 'id', failedItemId: 'id', planHash: 'hash',
  changedItemIds: 'ids', missingItemIds: 'ids', extraItemIds: 'ids', unknownItemIds: 'ids',
  blocking: 'json', later: 'json', items: 'json', warnings: 'json', failure: 'json', estimate: 'json', version: 'json',
  // r107 B8: capítulos fuera del alcance revisable (400 WORKSHOP_QUALITY_CHAPTERS_INVALID).
  invalidChapters: 'json',
});
const WORKSHOP_CODE_RE = /^(COURSE_)?WORKSHOP_[A-Z0-9_]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY_RE = /pass(word)?|secret|token|api[-_]?key|authorization|service[-_]?role|credential|cookie|jwt|signed|url/i;
const WORKSHOP_DETAIL_MAX_BYTES = 64 * 1024;

function scrubDetail(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrubDetail(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEY_RE.test(k)) out[k] = scrubDetail(x, depth + 1);
    return out;
  }
  return null;
}

/** Puro: los detalles permitidos de un cuerpo de error del Taller ({} si el código no es del Taller). */
export function workshopErrorDetails(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.code !== 'string' || !WORKSHOP_CODE_RE.test(body.code)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(WORKSHOP_ERROR_DETAIL_KEYS)) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (kind === 'ids') { if (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && UUID_RE.test(x))) out[k] = v; }
    else if (kind === 'id') { if (typeof v === 'string' && UUID_RE.test(v)) out[k] = v; }
    else if (kind === 'hash') { if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[k] = v; }
    else if (kind === 'text') { if (typeof v === 'string' && v.length <= 120) out[k] = v; }
    else {
      const x = scrubDetail(v);
      if (x !== null && JSON.stringify(x).length <= WORKSHOP_DETAIL_MAX_BYTES) out[k] = x;
    }
  }
  return out;
}
